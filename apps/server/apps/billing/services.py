"""Billing operations: the only entry point other applications call.

docs/domain/BILLING_MODEL.md. `place_order` authorises the caller against current state and
writes, in that one transaction, the order with its price snapshot, the pending subscription and
the issued invoice with its line, each audited. Core issues the invoice and allocates its number:
the payment provider, still to be chosen, only collects. The number is allocated last, after every
validation, under a lock on its series, and the issue time is read after that lock is held, so the
series is gapless and in the order of its dates. Nothing here talks to a payment provider.
"""

import calendar
import hashlib
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from functools import partial
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.identity.selectors import current_identity
from apps.legal.services import (
    Accepted as Accepted,
    DpaNotFoundError as DpaNotFoundError,
    LegalValidationError as LegalValidationError,
    LegalVersionError as LegalVersionError,
    Signatory,
    check_agreements,
    dpa_representation_by_id,
    record_agreements,
)
from apps.orgs.actor_selectors import organisation_slug
from apps.tenancy.services import (
    TenantSlugInvalidError as TenantSlugInvalidError,
    TenantSlugTakenError as TenantSlugTakenError,
    create_ordered_tenant,
    delete_ordered_tenant,
    tenant_representation,
)
from core.db.ids import new_uuid7
from services.identity.access_tokens import VerifiedAccessToken

from . import events
from .actors import Actor
from .callers import (
    BillingCallerUnknownError,
    BillingNotFoundError,
    require_role,
    tenant_caller,
)
from .configuration import Issuer
from .models import (
    MAX_QUANTITY,
    BillingProfile,
    CapacityTier,
    CreditNote,
    CreditNoteLine,
    Invoice,
    InvoiceLine,
    Order,
    Pack,
    Payment,
    PaymentLink,
    Price,
    Subscription,
)
from .money import line_amounts
from .states import (
    INVOICE_TRANSITIONS,
    ORDER_TRANSITIONS,
    SUBSCRIPTION_TRANSITIONS,
    TransitionRefusedError,
    require_transition,
)
from .switch import require_billing
from .vat import Regime, regime_for

PARIS = ZoneInfo("Europe/Paris")
IDEMPOTENCY_KEY = re.compile(r"[!-~]{16,255}\Z")
CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
EMAIL = re.compile(r"[^@\s]{1,64}@[^@\s]+\.[^@\s]+\Z")
ORDERING_ROLES = frozenset({"org_owner"})


class BillingValidationError(Exception):
    """The order names something that cannot be sold now: `422 validation-error`."""

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


class OrganisationNotOrderableError(Exception):
    """The organisation is not `active`: `409 invalid-state-transition`."""


class IdempotencyKeyReuseError(Exception):
    """The key already placed a different order: `409 idempotency-key-reuse`."""


class OrderInProgressError(Exception):
    """The organisation has an order placed and not yet paid: `409 order-in-progress`."""


class OrderInvoiceIssuedError(Exception):
    """The order's invoice cannot be credited in full: a payment for it is received, or a debit
    submitted and still settling: `409 invoice-issued`. Only a partial credit note with a refund
    corrects it, which Core does not issue yet, so the order is not cancelled."""


# A SEPA debit settles or fails within about fourteen business days: past this, a payment still
# `processing` no longer holds the invoice (reconciliation, BILLING_MODEL.md §7, lists it).
SETTLEMENT_WINDOW = timedelta(days=20)
CREDITABLE = ("issued", "overdue")


# The states of an order placed and not yet paid. An organisation holds one such order at most
# (the partial unique key below): a second tenant is ordered once the first order is paid, or
# after it is cancelled.
IN_FLIGHT = ("placed", "awaiting_payment")
ONE_IN_FLIGHT = "billing_order_one_in_flight_per_organisation"
# How long past its invoice's due date an unpaid order waits before `cancel_unpaid_orders`
# cancels it. The due date is the CGV's payment term (8.3, 30 days from issue): never before it.
UNPAID_ORDER_GRACE = timedelta(days=0)


def _has_order_in_flight(*, organisation_id: UUID) -> bool:
    return Order.objects.filter(organisation_id=organisation_id, state__in=IN_FLIGHT).exists()


class BillingNotConfiguredError(Exception):
    """No legal entity is configured to issue invoices; the order is refused, never half-written."""


@dataclass(frozen=True, slots=True)
class TenantRequest:
    """The tenant the order creates (contract `OrderRequest.tenant`)."""

    slug: str
    name: str
    locale: str = "fr"


@dataclass(frozen=True, slots=True)
class Agreements:
    """What the customer accepts with the order: the DPA generated for it, and each other document
    at the version shown (contract `dpa_acceptance` and `legal_acceptances`)."""

    dpa_id: UUID
    documents: tuple[Accepted, ...]
    accepted_by_name: str | None = None
    accepted_by_role: str | None = None


@dataclass(frozen=True, slots=True)
class OrderRequest:
    """What the Order screen sends (contract `OrderRequest`)."""

    pack_code: str
    capacity_tier_code: str
    billing_period: str
    tenant: TenantRequest
    agreements: Agreements
    plan_code: str | None = None
    quantity: int = 1
    purchase_order_ref: str | None = None
    billing_contact_email: str | None = None
    billing_contact_name: str | None = None
    notes: str | None = None

    def sha256(self) -> str:
        canonical = json.dumps(asdict(self), sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class PlacedOrder:
    order: Order
    subscription: Subscription
    invoice: Invoice
    replayed: bool

    @property
    def tenant_id(self) -> UUID:
        tenant_id = self.order.tenant_id
        if tenant_id is None:
            raise RuntimeError("an order placed without its tenant")
        return tenant_id

    @property
    def dpa_id(self) -> UUID:
        dpa_id = self.order.dpa_id
        if dpa_id is None:
            raise RuntimeError("an order placed without its DPA")
        return dpa_id


def _add_months(moment: datetime, months: int) -> datetime:
    month = moment.month - 1 + months
    year, month = moment.year + month // 12, month % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def period_end(*, start: datetime, billing_period: str) -> datetime:
    """The end of one billing period from `start`, counted on the Paris calendar, the day clamped
    to the month's last."""
    months = {"monthly": 1, "yearly": 12}.get(billing_period)
    if months is None:
        raise ValueError(f"{billing_period!r} is not a billing period")
    local = start.astimezone(PARIS)
    return (
        _add_months(local.replace(tzinfo=None), months)
        .replace(tzinfo=PARIS)
        .astimezone(start.tzinfo)
    )


def _validate(request: OrderRequest, idempotency_key: str) -> None:
    if not IDEMPOTENCY_KEY.match(idempotency_key):
        raise BillingValidationError("idempotency_key", "format")
    for field in ("pack_code", "capacity_tier_code"):
        if not CODE.match(getattr(request, field)):
            raise BillingValidationError(field, "format")
    if request.plan_code is not None and not CODE.match(request.plan_code):
        raise BillingValidationError("plan_code", "format")
    if request.billing_period not in ("monthly", "yearly"):
        raise BillingValidationError("billing_period", "unknown")
    if isinstance(request.quantity, bool) or not 1 <= request.quantity <= MAX_QUANTITY:
        raise BillingValidationError("quantity", "range")
    # The contract's bounds; one line each but the operator's notes, and no control character.
    for field, limit in (("purchase_order_ref", 100), ("billing_contact_name", 200)):
        value = getattr(request, field)
        if value is not None and (len(value) > limit or not value.isprintable()):
            raise BillingValidationError(field, "format")
    email = request.billing_contact_email
    if email is not None and (len(email) > 254 or not EMAIL.match(email)):
        raise BillingValidationError("billing_contact_email", "format")
    tenant = request.tenant
    if not 1 <= len(tenant.name) <= 200 or not tenant.name.isprintable():
        raise BillingValidationError("tenant.name", "format")
    if tenant.locale not in ("fr", "en"):
        raise BillingValidationError("tenant.locale", "unknown")
    for field, limit in (("accepted_by_name", 200), ("accepted_by_role", 100)):
        value = getattr(request.agreements, field)
        if value is not None and (len(value) > limit or not value.isprintable()):
            raise BillingValidationError(f"dpa_acceptance.{field}", "format")
    notes = request.notes
    if notes is not None and (len(notes) > 1000 or not notes.replace("\n", "").isprintable()):
        raise BillingValidationError("notes", "format")


def current_price(*, request: OrderRequest, now: datetime) -> Price:
    """The price an order for these codes is placed at now.

    The plan is the published one offering the pack and tier (the named one when `plan_code` is
    given, its highest published version); within it, the price with the latest `valid_from` that
    has started and not ended. A newer price therefore supersedes an older one from its start.
    """
    pack = Pack.objects.filter(code=request.pack_code).first()
    if pack is None or not pack.available:
        raise BillingValidationError("pack_code", "unavailable")
    tier = CapacityTier.objects.filter(code=request.capacity_tier_code).first()
    if tier is None or not tier.available:
        raise BillingValidationError("capacity_tier_code", "unavailable")
    offered = (
        Price.objects.select_related("plan", "pack", "capacity_tier")
        .filter(
            pack=pack,
            capacity_tier=tier,
            billing_period=request.billing_period,
            plan__state="published",
            valid_from__lte=now,
        )
        .filter(Q(valid_to__isnull=True) | Q(valid_to__gt=now))
    )
    if request.plan_code is not None:
        offered = offered.filter(plan__code=request.plan_code)
    codes = set(offered.values_list("plan__code", flat=True))
    if not codes:
        raise BillingValidationError(
            "plan_code" if request.plan_code else "pack_code", "not_offered"
        )
    if len(codes) > 1:
        raise BillingValidationError("plan_code", "ambiguous")
    price = offered.order_by("-plan__version", "-valid_from").first()
    if price is None:
        raise BillingValidationError("pack_code", "not_offered")
    return price


def _regime(profile: BillingProfile) -> Regime:
    validated = profile.vat_number is not None and profile.vat_number_validated_at is not None
    return regime_for(
        country=profile.country, vat_number_validated=validated, exempt=profile.vat_exempt
    )


def _issuer() -> Issuer:
    issuer: Issuer | None = settings.KODERA_BILLING_ISSUER
    if issuer is None:
        raise BillingNotConfiguredError()
    return issuer


def place_order(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    idempotency_key: str,
    request: OrderRequest,
    request_id: str | None = None,
    source_ip: str | None = None,
    user_agent: str | None = None,
) -> PlacedOrder:
    """The order transaction, for `org_owner` only: the tenant in status `ordered`, the order with
    its price snapshot, the acceptance of the agreements and of the DPA, the pending subscription
    and the issued invoice, each audited, or nothing.

    The same key with the same request returns the first result with `replayed=True`; the same key
    with another request is refused. The key is unique per organisation in the database, so two
    concurrent placements with one key write one order.
    """
    # No order is placed while billing is off (QUICK_WORKSPACE.md §2.2); the route refuses first.
    require_billing()
    _validate(request, idempotency_key)
    issuer = _issuer()
    request_sha256 = request.sha256()
    with transaction.atomic():
        caller = tenant_caller(verified=verified, organisation_id=organisation_id)
        require_role(caller, roles=ORDERING_ROLES, scope="order:create")
        actor = Actor("tenant", caller.identity_id, request_id)
        existing = _replay(organisation_id=organisation_id, idempotency_key=idempotency_key)
        if existing is not None:
            return _replayed(existing, request_sha256)
        if caller.organisation_state != "active":
            raise OrganisationNotOrderableError()
        # The common case refused early; the database's partial unique key settles a race.
        if _has_order_in_flight(organisation_id=organisation_id):
            raise OrderInProgressError()
        profile = BillingProfile.objects.filter(organisation_id=organisation_id).first()
        if profile is None:
            raise BillingValidationError("billing_profile", "missing")
        vat = _regime(profile)
        now = timezone.now()
        price = current_price(request=request, now=now)
        amounts = line_amounts(
            unit_amount_minor=price.amount_minor, quantity=request.quantity, vat_rate_bp=vat.rate_bp
        )
        snapshot = {
            "price": price,
            "plan_code": price.plan.code,
            "plan_version": price.plan.version,
            "pack_code": price.pack.code,
            "capacity_tier_code": price.capacity_tier.code,
            "apps": list(price.pack.apps),
            "billing_period": price.billing_period,
            "currency": price.currency,
            "unit_amount_minor": price.amount_minor,
            "quantity": request.quantity,
            "vat_regime": vat.code,
            "vat_rate_bp": vat.rate_bp,
            "total_excl_vat_minor": amounts.net_minor,
            "vat_amount_minor": amounts.vat_minor,
            "total_incl_vat_minor": amounts.gross_minor,
            "captured_at": now,
        }
        # Every refusal of the agreements before anything is written, the tenant slug included.
        try:
            checked = check_agreements(
                organisation_id=organisation_id,
                pack_code=price.pack.code,
                documents=list(request.agreements.documents),
                dpa_id=request.agreements.dpa_id,
            )
        except LegalValidationError as refused:
            # A placement that waited on the DPA's lock behind the one that won the race finds the
            # DPA accepted: under its own key it replays the winner; under another key (a second
            # tab sending the same DPA) the winner's order in flight refuses it.
            if refused.reason != "dpa_already_accepted":
                raise
            existing = _replay(organisation_id=organisation_id, idempotency_key=idempotency_key)
            if existing is not None:
                return _replayed(existing, request_sha256)
            if _has_order_in_flight(organisation_id=organisation_id):
                raise OrderInProgressError() from None
            raise
        resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
        if resolved is None:
            raise BillingCallerUnknownError()
        person, _ = resolved
        try:
            with transaction.atomic():
                # One savepoint: a placement that loses the race on its key loses its tenant too.
                tenant = create_ordered_tenant(
                    organisation_id=organisation_id,
                    slug=request.tenant.slug,
                    name=request.tenant.name,
                    locale=request.tenant.locale,
                    pack_code=price.pack.code,
                    capacity_tier_code=price.capacity_tier.code,
                    apps=list(price.pack.apps),
                    profile_ref=price.pack.profile_ref,
                    realm=organisation_slug(organisation_id=organisation_id),
                )
                order = Order.objects.create(
                    organisation_id=organisation_id,
                    idempotency_key=idempotency_key,
                    request_sha256=request_sha256,
                    placed_by=caller.identity_id,
                    dpa_id=request.agreements.dpa_id,
                    tenant_id=tenant.id,
                    purchase_order_ref=request.purchase_order_ref,
                    billing_contact_email=request.billing_contact_email,
                    billing_contact_name=request.billing_contact_name,
                    notes=request.notes,
                    **snapshot,
                )
        except (IntegrityError, TenantSlugTakenError) as refused:
            existing = _replay(organisation_id=organisation_id, idempotency_key=idempotency_key)
            if existing is not None:
                return _replayed(existing, request_sha256)
            cause = getattr(refused, "__cause__", None)
            constraint = getattr(getattr(cause, "diag", None), "constraint_name", None)
            # Another key's placement won the race for the organisation's one order in flight: on
            # the partial unique key, or first on the slug both asked for.
            if constraint == ONE_IN_FLIGHT or _has_order_in_flight(organisation_id=organisation_id):
                raise OrderInProgressError() from None
            raise
        record_agreements(
            checked,
            order_id=order.id,
            tenant_id=tenant.id,
            signatory=Signatory(
                identity_id=caller.identity_id,
                person_id=person.id,
                email=person.email,
                name=request.agreements.accepted_by_name or person.display_name or person.email,
                role=request.agreements.accepted_by_role,
                source_ip=source_ip,
                user_agent=user_agent,
            ),
            request_id=request_id,
        )
        events.record(
            "tenant.ordered",
            actor=actor,
            organisation_id=organisation_id,
            target=("tenant", tenant.id),
            metadata={"order_id": str(order.id), "slug": request.tenant.slug},
        )
        end = period_end(start=now, billing_period=price.billing_period)
        subscription = Subscription.objects.create(
            organisation_id=organisation_id,
            order=order,
            tenant_id=tenant.id,
            current_period_start=now,
            current_period_end=end,
            price_change_notice_days=price.plan.price_change_notice_days,
            **snapshot,
        )
        invoice = Invoice.objects.create(
            organisation_id=organisation_id,
            subscription=subscription,
            order=order,
            currency=price.currency,
            vat_regime=vat.code,
            vat_mention=vat.mention,
            issuer_legal_name=issuer.legal_name,
            issuer_address=issuer.address,
            issuer_siren=issuer.siren,
            issuer_vat_number=issuer.vat_number,
            customer_legal_name=profile.legal_name,
            customer_address_line1=profile.address_line1,
            customer_address_line2=profile.address_line2,
            customer_postal_code=profile.postal_code,
            customer_city=profile.city,
            customer_country=profile.country,
            customer_siren=profile.siren,
            customer_vat_number=profile.vat_number,
            total_excl_vat_minor=amounts.net_minor,
            vat_amount_minor=amounts.vat_minor,
            total_incl_vat_minor=amounts.gross_minor,
        )
        InvoiceLine.objects.create(
            invoice=invoice,
            position=1,
            description=(
                f"{price.plan.name} — {price.pack.name} — {price.capacity_tier.code} — "
                f"{now.astimezone(PARIS):%Y-%m-%d} → {end.astimezone(PARIS):%Y-%m-%d}"
            ),
            plan_code=price.plan.code,
            plan_version=price.plan.version,
            pack_code=price.pack.code,
            capacity_tier_code=price.capacity_tier.code,
            quantity=request.quantity,
            unit_amount_minor=price.amount_minor,
            total_excl_vat_minor=amounts.net_minor,
            vat_rate_bp=vat.rate_bp,
            vat_amount_minor=amounts.vat_minor,
            period_start=now,
            period_end=end,
        )
        events.record(
            "subscription.created",
            actor=actor,
            organisation_id=organisation_id,
            target=("subscription", subscription.id),
            metadata={"order_id": str(order.id), "price_id": str(price.id)},
        )
        # Core issues the invoice on the order's behalf: the row's actor is the system.
        issue_invoice(invoice, request_id=request_id)
        return PlacedOrder(order=order, subscription=subscription, invoice=invoice, replayed=False)


def _replay(*, organisation_id: UUID, idempotency_key: str) -> Order | None:
    return Order.objects.filter(
        organisation_id=organisation_id, idempotency_key=idempotency_key
    ).first()


def _replayed(order: Order, request_sha256: str) -> PlacedOrder:
    if order.request_sha256 != request_sha256:
        raise IdempotencyKeyReuseError()
    subscription = Subscription.objects.get(order=order)
    invoice = Invoice.objects.filter(order=order).order_by("created_at", "id").first()
    if invoice is None:
        raise RuntimeError("an order without its invoice")
    return PlacedOrder(order=order, subscription=subscription, invoice=invoice, replayed=True)


def cancel_order(
    *, verified: VerifiedAccessToken, order_id: UUID, request_id: str | None = None
) -> Order:
    """`cancelOrder`, for `org_owner` only: an order placed and not yet paid is cancelled with
    everything its transaction wrote that is still pending (`_cancel`). An order already cancelled
    is answered as it is; a paid one is refused (`TransitionRefusedError`)."""
    with transaction.atomic():
        organisation_id = (
            Order.objects.filter(id=order_id).values_list("organisation_id", flat=True).first()
        )
        if organisation_id is None:
            raise BillingNotFoundError()
        caller = tenant_caller(verified=verified, organisation_id=organisation_id)
        require_role(caller, roles=ORDERING_ROLES, scope="order:act")
        order, _ = _cancel(
            order_id, actor=Actor("tenant", caller.identity_id, request_id), reason="customer"
        )
        return order


def cancel_unpaid_orders() -> tuple[int, int]:
    """Cancel, as the `system`, every order in flight whose invoice is still unpaid
    `UNPAID_ORDER_GRACE` past its due date: the operator command `cancel_unpaid_orders`. Each
    order is its own transaction: its unpaid invoice is credited in full, then the order is
    cancelled. Returns how many were cancelled and how many were left: a payment for the invoice is
    received or settling (a person settles those), or it was paid since being listed."""
    due = list(
        Order.objects.filter(
            state__in=IN_FLIGHT,
            invoices__due_at__lt=timezone.now() - UNPAID_ORDER_GRACE,
        )
        .values_list("id", flat=True)
        .distinct()
    )
    cancelled = held = 0
    for order_id in due:
        try:
            with transaction.atomic():
                _, moved = _cancel(order_id, actor=Actor("system", None), reason="unpaid")
        except (OrderInvoiceIssuedError, TransitionRefusedError):
            # A payment holds its invoice, or it was paid since it was listed: the next run looks
            # again.
            held += 1
            continue
        cancelled += moved
    return cancelled, held


def _cancel(order_id: UUID, *, actor: Actor, reason: str) -> tuple[Order, bool]:
    """Order `cancelled`, its pending subscription `cancelled`, its invoice corrected and its
    tenant `ordered → deleted` (TENANT_STATE_MACHINE.md T21), in the caller's transaction. Returns
    the order and whether this call cancelled it.

    An issued (or overdue) invoice is never voided or deleted: a credit note credits it in full
    (`issue_credit_note`), and its active payment links are cancelled, withdrawn at the provider
    once the transaction commits where the payments package runs, and otherwise (the API image) by
    the operator command `withdraw_cancelled_links`, which also retries a refused withdrawal. An invoice with a payment received or a
    debit still settling cannot be credited in full, so the order is refused
    (`OrderInvoiceIssuedError`). A draft carries no number and was never sent: it and its lines
    are discarded. The rows are locked in reconciliation's order (invoice, links, subscription,
    order), so a payment event and a cancellation of one order queue rather than deadlock.
    """
    invoices = list(
        Invoice.objects.select_for_update().filter(order_id=order_id).order_by("created_at", "id")
    )
    links = list(
        PaymentLink.objects.select_for_update().filter(invoice__in=invoices, state="active")
    )
    subscription = Subscription.objects.select_for_update().filter(order_id=order_id).first()
    order = Order.objects.select_for_update().get(id=order_id)
    if order.state == "cancelled":
        return order, False
    require_transition(
        ORDER_TRANSITIONS, machine="order", current=order.state, requested="cancelled"
    )
    if any(invoice.state in CREDITABLE and _payment_held(invoice) for invoice in invoices):
        raise OrderInvoiceIssuedError()
    system = Actor("system", None, actor.request_id)
    order.state = "cancelled"
    order.save(update_fields=["state", "updated_at"])
    if subscription is not None and "cancelled" in SUBSCRIPTION_TRANSITIONS[subscription.state]:
        subscription.state = "cancelled"
        subscription.cancelled_at = timezone.now()
        subscription.save(update_fields=["state", "cancelled_at", "updated_at"])
        events.record(
            "subscription.cancelled",
            actor=actor,
            organisation_id=order.organisation_id,
            target=("subscription", subscription.id),
            metadata={"order_id": str(order.id), "reason": reason},
        )
    for invoice in invoices:
        if invoice.state == "draft":
            InvoiceLine.objects.filter(invoice=invoice).delete()
            invoice.delete()
        elif invoice.state in CREDITABLE:
            issue_credit_note(
                invoice,
                reason=CREDIT_REASONS[reason],
                request_id=actor.request_id,
                order_id=order.id,
            )
    for link in links:
        link.state = "cancelled"
        link.save(update_fields=["state", "updated_at"])
        transaction.on_commit(partial(_withdraw_at_provider, link.provider, link.provider_ref))
    if order.tenant_id is not None and delete_ordered_tenant(tenant_id=order.tenant_id):
        events.record(
            "tenant.deleted",
            actor=system,
            organisation_id=order.organisation_id,
            target=("tenant", order.tenant_id),
            metadata={"order_id": str(order.id), "reason": reason},
        )
    return order, True


def _withdraw_at_provider(provider_name: str, provider_ref: str) -> None:
    """After commit, withdraw the link at its provider. The payments package ships in the API image
    too (createPaymentLink), so a cancellation through the API withdraws at once when a provider is
    configured; a refusal, or no provider, is logged by the payments package, and the operator
    command `withdraw_cancelled_links` retries it. Never raised into a cancellation that already
    committed."""
    try:
        from .payments.services import _cancel_at_provider
    except ImportError:
        return
    _cancel_at_provider(provider_name, provider_ref)


def _payment_held(invoice: Invoice) -> bool:
    """A payment received for the invoice, or a debit submitted within the settlement window.
    The same rule as apps/billing/payments/services.py `_in_flight`, which a link is refused by,
    plus the money already received; they share SETTLEMENT_WINDOW and must stay alike."""
    return (
        invoice.amount_paid_minor > 0
        or Payment.objects.filter(
            invoice=invoice,
            state="processing",
            last_event_at__gt=timezone.now() - SETTLEMENT_WINDOW,
        ).exists()
    )


def credit_note_series() -> str:
    """The credit notes' own series: `AV-` and the invoices' series (BILLING_MODEL.md §4)."""
    return "AV-" + settings.KODERA_INVOICE_SERIES


# The credit note's reason for each cancellation's: two legal bases, two codes.
CREDIT_REASONS = {"customer": "customer_cancellation", "unpaid": "unpaid_lapse"}


def issue_credit_note(
    invoice: Invoice,
    *,
    reason: str,
    request_id: str | None = None,
    order_id: UUID | None = None,
) -> CreditNote:
    """Credit an unpaid issued invoice in full: the credit note, numbered from its own gapless
    series and dated as it is allocated, with the invoice's VAT treatment, both parties' snapshot
    and a copy of every line, then the invoice `credited`; audited as `credit_note.issued`.

    Internal: the caller holds the invoice row locked in its transaction and has authorised the
    act. The database refuses a second credit note for the invoice and any later change to one.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("a credit note is issued in its caller's transaction")
    require_transition(
        INVOICE_TRANSITIONS, machine="invoice", current=invoice.state, requested="credited"
    )
    if invoice.amount_paid_minor != 0:
        raise BillingValidationError("invoice", "paid_in_part")
    number, issued_at = _allocate(credit_note_series())
    note = CreditNote.objects.create(
        organisation_id=invoice.organisation_id,
        invoice=invoice,
        number=number,
        issued_at=issued_at,
        reason=reason,
        currency=invoice.currency,
        vat_regime=invoice.vat_regime,
        vat_mention=invoice.vat_mention,
        issuer_legal_name=invoice.issuer_legal_name,
        issuer_address=invoice.issuer_address,
        issuer_siren=invoice.issuer_siren,
        issuer_vat_number=invoice.issuer_vat_number,
        customer_legal_name=invoice.customer_legal_name,
        customer_address_line1=invoice.customer_address_line1,
        customer_address_line2=invoice.customer_address_line2,
        customer_postal_code=invoice.customer_postal_code,
        customer_city=invoice.customer_city,
        customer_country=invoice.customer_country,
        customer_siren=invoice.customer_siren,
        customer_vat_number=invoice.customer_vat_number,
        total_excl_vat_minor=invoice.total_excl_vat_minor,
        vat_amount_minor=invoice.vat_amount_minor,
        total_incl_vat_minor=invoice.total_incl_vat_minor,
    )
    CreditNoteLine.objects.bulk_create(
        CreditNoteLine(
            credit_note=note,
            invoice_line=line,
            position=line.position,
            description=line.description,
            quantity=line.quantity,
            unit_amount_minor=line.unit_amount_minor,
            total_excl_vat_minor=line.total_excl_vat_minor,
            vat_rate_bp=line.vat_rate_bp,
            vat_amount_minor=line.vat_amount_minor,
            period_start=line.period_start,
            period_end=line.period_end,
        )
        for line in InvoiceLine.objects.filter(invoice=invoice).order_by("position")
    )
    set_invoice_state(invoice, "credited", actor=Actor("system", None, request_id))
    events.record(
        "credit_note.issued",
        actor=Actor("system", None, request_id),
        organisation_id=invoice.organisation_id,
        target=("credit_note", note.id),
        metadata={
            "number": number,
            "invoice_id": str(invoice.id),
            "invoice_number": invoice.number,
            "order_id": None if order_id is None else str(order_id),
            "total_incl_vat_minor": note.total_incl_vat_minor,
            "reason": reason,
        },
    )
    return note


def series_year(issued_at: datetime) -> int:
    """The year a number belongs to: the issue date's year in Paris, where the invoice is dated."""
    return issued_at.astimezone(PARIS).year


def _allocate(series: str) -> tuple[str, datetime]:
    """The next number of `series` and the issue time, read once the series is locked: a later
    number never carries an earlier time. The lock is held until the transaction ends."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            ["billing-invoice-series:" + series],
        )
        cursor.execute("SELECT clock_timestamp()")
        (issued_at,) = cursor.fetchone()
        year = series_year(issued_at)
        cursor.execute(
            "INSERT INTO billing_invoicenumbercounter (id, series, year, last_number)"
            " VALUES (%s, %s, %s, 1)"
            " ON CONFLICT (series, year) DO UPDATE"
            " SET last_number = billing_invoicenumbercounter.last_number + 1"
            " RETURNING last_number",
            [new_uuid7(), series, year],
        )
        (number,) = cursor.fetchone()
    return f"{series}-{year}-{number:05d}", issued_at


def issue_invoice(invoice: Invoice, *, request_id: str | None = None) -> None:
    """Draft → issued: number, issue date and due date. The guard trigger then freezes it, and
    refuses the issue itself unless the totals are the sums of at least one line."""
    if not connection.in_atomic_block:
        raise RuntimeError("an invoice is issued in its caller's transaction")
    require_transition(
        INVOICE_TRANSITIONS, machine="invoice", current=invoice.state, requested="issued"
    )
    invoice.number, invoice.issued_at = _allocate(settings.KODERA_INVOICE_SERIES)
    invoice.state = "issued"
    invoice.due_at = invoice.issued_at + timedelta(days=settings.KODERA_INVOICE_PAYMENT_TERMS_DAYS)
    invoice.save(update_fields=["number", "state", "issued_at", "due_at", "updated_at"])
    events.record(
        "invoice.issued",
        actor=Actor("system", None, request_id),
        organisation_id=invoice.organisation_id,
        target=("invoice", invoice.id),
        metadata={"number": invoice.number, "total_incl_vat_minor": invoice.total_incl_vat_minor},
    )


def set_invoice_state(invoice: Invoice, requested: str, *, actor: Actor) -> None:
    """The narrow write an issued invoice allows: its state, and `paid_at` with `paid`.

    Internal: the caller has authorised `actor` and holds the invoice row locked
    (`select_for_update`) in its transaction, as reconciliation does. No route calls it directly.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("an invoice's state is set in its caller's transaction")
    require_transition(
        INVOICE_TRANSITIONS, machine="invoice", current=invoice.state, requested=requested
    )
    invoice.state = requested
    invoice.paid_at = timezone.now() if requested == "paid" else None
    invoice.save(update_fields=["state", "paid_at", "updated_at"])
    action = {"paid": "invoice.paid", "overdue": "invoice.overdue", "void": "invoice.voided"}.get(
        requested
    )
    if action is not None:
        events.record(
            action,
            actor=actor,
            organisation_id=invoice.organisation_id,
            target=("invoice", invoice.id),
            metadata={"number": invoice.number},
        )


def set_billing_profile(
    *,
    organisation_id: UUID,
    legal_name: str,
    address_line1: str,
    postal_code: str,
    city: str,
    country: str,
    address_line2: str | None = None,
    siren: str | None = None,
    vat_number: str | None = None,
    vat_number_validated_at: datetime | None = None,
    vat_exempt: bool = False,
) -> BillingProfile:
    """Create or replace the organisation's billing profile. An issued invoice keeps its copy.

    Internal: no route calls it yet. The one that does authorises the caller, and never takes
    `vat_number_validated_at` or `vat_exempt` from a customer's request: the first comes from the
    VAT-number check Core runs itself, the second from staff with the exemption certificate
    (docs/domain/BILLING_MODEL.md §3).
    """
    values = {
        "legal_name": legal_name,
        "address_line1": address_line1,
        "address_line2": address_line2,
        "postal_code": postal_code,
        "city": city,
        "country": country,
        "siren": siren,
        "vat_number": vat_number,
        "vat_number_validated_at": vat_number_validated_at,
        "vat_exempt": vat_exempt,
    }
    with transaction.atomic():
        profile, _ = BillingProfile.objects.update_or_create(
            organisation_id=organisation_id, defaults=values
        )
    return profile


def order_result(placed: PlacedOrder) -> dict[str, Any]:
    """The contract's `OrderResult`: the order and everything its transaction wrote.

    The payment link is created by its own operation, outside the order transaction, so it is
    `null` here and `billing_pending` says it is still to come.
    """
    from . import representations as shape

    invoice = Invoice.objects.get(id=placed.invoice.id)
    order = Order.objects.get(id=placed.order.id)
    return {
        "order": shape.order(order, subscription_id=placed.subscription.id, invoice_id=invoice.id),
        "subscription": shape.subscription(Subscription.objects.get(id=placed.subscription.id)),
        "tenant": tenant_representation(tenant_id=placed.tenant_id),
        "invoice": shape.invoice(invoice),
        "payment_link": None,
        "dpa": dpa_representation_by_id(dpa_id=placed.dpa_id),
        "billing_pending": True,
    }

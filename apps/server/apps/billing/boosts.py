"""Volet A — Samouraï Coop direct community workspace boosts and hosting credits.

Samouraï Coop is the sole merchant of record and sole legal `Factur-X` (`380` invoice / `381`
credit note) issuer for Volet A boosts. Stripe Checkout operates strictly in `mode=payment` with
`payment_method_types=["card"]`, `invoice_creation` absent/disabled, and zero Stripe Connect
destination split. Outbound provider calls execute strictly outside `transaction.atomic()`.

B2C immediate activation enforces `Art. L221-28 Code de la consommation`: checkout and activation
are refused unless explicit canonical 14-day withdrawal-right waiver acceptance, fresh timestamp,
and salted HMAC evidence digest are recorded prior to checkout.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from apps.workspaces.services import sync_subscription_quota

from . import events
from .actors import Actor
from .configuration import Issuer
from .documents import Line as DocumentLine, Party as DocumentParty, Snapshot
from .models import (
    BillingProfile,
    CapacityTier,
    CreditNote,
    Invoice,
    InvoiceLine,
    Payment,
    Subscription,
    WorkspaceBoostGrant,
    WorkspaceHostingCredit,
)
from .money import BASIS_POINTS, line_amounts, round_half_up, vat_for_net_minor
from .payments.port import LinkRequest, PaymentProvider, ProviderLink
from .payments.services import check_return_url
from .services import (
    IDEMPOTENCY_KEY,
    IdempotencyKeyReuseError,
    credit_note_series,
    set_invoice_state,
)
from .states import PAYMENT_TRANSITIONS
from .vat import EU_MEMBER_STATES, Regime, regime_for
from .vies import current_consultation

GIB = 1024**3
STATUTORY_WAIVER_CLAUSE = "FR-L221-28-IMMEDIATE-EXECUTION-WAIVER"
WAIVER_MAX_PAST_AGE = timedelta(hours=1)
WAIVER_MAX_FUTURE_SKEW = timedelta(seconds=30)
_WHITESPACE_RE = re.compile(r"\s+")


def _normalise_waiver_statement(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text.replace("\u2019", "'").strip())


CANONICAL_WAIVER_STATEMENTS: frozenset[str] = frozenset(
    _normalise_waiver_statement(s)
    for s in (
        (
            "Je demande l'exécution immédiate du Boost ou du Pass VIP et je renonce expressément "
            "à mon droit de rétractation de 14 jours (art. L221-28 du Code de la consommation)."
        ),
        (
            "I request immediate performance of the Boost or VIP Pass and expressly waive my "
            "14-day withdrawal right (French Consumer Code Art. L221-28)."
        ),
        (
            "Je demande l'exécution immédiate du service numérique et renonce expressément "
            "à mon droit de rétractation de 14 jours conformément à l'article L221-28 du Code de la consommation."
        ),
        (
            "I request immediate performance of the digital service and expressly waive my "
            "14-day withdrawal right under Article L221-28 of the French Consumer Code."
        ),
    )
)


class BoostValidationError(ValueError):
    """Invalid Volet A boost pack, amount, VIES profile, or refund parameter."""


class WithdrawalWaiverRequiredError(PermissionError):
    """Immediate B2C execution refused under `Art. L221-28 Code de la consommation`."""


@dataclass(frozen=True, slots=True)
class BoostPackSpec:
    code: str
    name: str
    net_amount_minor: int
    credit_amount_minor: int
    seats_delta: int
    storage_bytes_delta: int
    duration_days: int = 30
    currency: str = "EUR"


BOOST_PACKS: dict[str, BoostPackSpec] = {
    spec.code: spec
    for spec in (
        BoostPackSpec(
            code="boost-starter",
            name="Kodera Community Boost — Starter",
            net_amount_minor=990,
            credit_amount_minor=1000,
            seats_delta=10,
            storage_bytes_delta=10 * GIB,
            duration_days=30,
        ),
        BoostPackSpec(
            code="boost-community",
            name="Kodera Community Boost — Guild",
            net_amount_minor=2900,
            credit_amount_minor=3000,
            seats_delta=35,
            storage_bytes_delta=50 * GIB,
            duration_days=30,
        ),
        BoostPackSpec(
            code="boost-sovereign",
            name="Kodera Community Boost — Sovereign",
            net_amount_minor=7900,
            credit_amount_minor=8500,
            seats_delta=100,
            storage_bytes_delta=200 * GIB,
            duration_days=30,
        ),
    )
}


@dataclass(frozen=True, slots=True)
class BoostQuote:
    pack: BoostPackSpec
    quantity: int
    customer_kind: str
    customer_country: str
    vat_regime: Regime
    net_amount_minor: int
    vat_amount_minor: int
    gross_amount_minor: int
    credit_amount_minor: int
    seats_delta: int
    storage_bytes_delta: int


@dataclass(frozen=True, slots=True)
class EffectiveWorkspaceQuota:
    policy_ref: str
    seats: int | None
    storage_bytes: int | None
    active_boost_count: int


def verify_b2c_withdrawal_waiver(
    *,
    customer_kind: str,
    scope: str,
    offer_code: str,
    buyer_ref: str,
    withdrawal_waiver_accepted: bool,
    withdrawal_waiver_at: datetime | None,
    withdrawal_waiver_statement: str | None,
    now: datetime,
) -> tuple[bool, datetime | None, str | None]:
    """Enforce `Art. L221-28 Code de la consommation` prior to immediate B2C digital supply."""
    if customer_kind not in {"b2c", "b2b"}:
        raise BoostValidationError(f"unsupported customer_kind {customer_kind!r}")
    if customer_kind == "b2b" and not withdrawal_waiver_accepted:
        return False, None, None
    if not withdrawal_waiver_accepted:
        raise WithdrawalWaiverRequiredError(
            "explicit 14-day withdrawal waiver (Art. L221-28) required before B2C activation"
        )
    if withdrawal_waiver_at is None or withdrawal_waiver_at.tzinfo is None:
        raise WithdrawalWaiverRequiredError("withdrawal_waiver_at must carry a timezone offset")
    if withdrawal_waiver_at > now + WAIVER_MAX_FUTURE_SKEW:
        raise WithdrawalWaiverRequiredError("withdrawal_waiver_at must precede checkout")
    if withdrawal_waiver_at < now - WAIVER_MAX_PAST_AGE:
        raise WithdrawalWaiverRequiredError(
            "withdrawal_waiver_at is stale and must be re-confirmed"
        )
    statement = _normalise_waiver_statement(withdrawal_waiver_statement or "")
    if statement not in CANONICAL_WAIVER_STATEMENTS:
        raise WithdrawalWaiverRequiredError(
            "withdrawal_waiver_statement must match the canonical Art. L221-28 declaration"
        )

    salt_hex = secrets.token_hex(16)
    payload = (
        f"{STATUTORY_WAIVER_CLAUSE}|{scope}|{offer_code}|{buyer_ref}|"
        f"{withdrawal_waiver_at.astimezone(UTC).isoformat()}|{statement}"
    ).encode()
    digest = hmac.new(bytes.fromhex(salt_hex), payload, hashlib.sha256).hexdigest()
    return True, withdrawal_waiver_at, f"l221-28:v2:{salt_hex}:{digest}"


def quote_boost_pack(
    *,
    pack_code: str,
    customer_country: str,
    customer_kind: str = "b2c",
    quantity: int = 1,
    vat_number_validated: bool = False,
    vat_exempt: bool = False,
) -> BoostQuote:
    """Compute deterministic HT / VAT / TTC quote across 27-state EU OSS, FR, B2B, and non-EU."""
    if pack_code not in BOOST_PACKS:
        raise BoostValidationError(f"unknown boost pack {pack_code!r}")
    if customer_kind not in {"b2c", "b2b"}:
        raise BoostValidationError(f"invalid customer_kind {customer_kind!r}")
    if isinstance(quantity, bool) or not 1 <= quantity <= 1000:
        raise BoostValidationError("quantity must be between 1 and 1000")

    country = customer_country.strip().upper()
    pack = BOOST_PACKS[pack_code]
    vat = regime_for(
        country=country,
        vat_number_validated=vat_number_validated,
        exempt=vat_exempt,
        b2c=(customer_kind == "b2c"),
    )
    amounts = line_amounts(
        unit_amount_minor=pack.net_amount_minor,
        quantity=quantity,
        vat_rate_bp=vat.rate_bp,
    )
    return BoostQuote(
        pack=pack,
        quantity=quantity,
        customer_kind=customer_kind,
        customer_country=country,
        vat_regime=vat,
        net_amount_minor=amounts.net_minor,
        vat_amount_minor=amounts.vat_minor,
        gross_amount_minor=amounts.gross_minor,
        credit_amount_minor=pack.credit_amount_minor * quantity,
        seats_delta=pack.seats_delta * quantity,
        storage_bytes_delta=pack.storage_bytes_delta * quantity,
    )


def split_gross_refund(
    *,
    original_net_minor: int,
    original_vat_minor: int,
    original_gross_minor: int,
    previously_refunded_gross_minor: int,
    previously_refunded_net_minor: int,
    refund_gross_minor: int,
    vat_rate_bp: int | None = None,
) -> tuple[int, int]:
    """Decompose a gross refund into `(delta_net_minor, delta_vat_minor)` satisfying EN 16931
    `BR-S-09` (`delta_vat == vat_for_net_minor(delta_net, vat_rate_bp)`) and cumulative exactness."""
    if original_net_minor <= 0 or original_vat_minor < 0:
        raise BoostValidationError("invalid original document totals")
    if original_net_minor + original_vat_minor != original_gross_minor:
        raise BoostValidationError("original net + vat must equal gross")
    if refund_gross_minor <= 0:
        raise BoostValidationError("refund_gross_minor must be positive")
    if previously_refunded_gross_minor < 0 or previously_refunded_net_minor < 0:
        raise BoostValidationError("previous refund totals cannot be negative")
    previously_refunded_vat_minor = previously_refunded_gross_minor - previously_refunded_net_minor
    if previously_refunded_vat_minor < 0:
        raise BoostValidationError("previous refunded VAT cannot be negative")

    cum_gross = previously_refunded_gross_minor + refund_gross_minor
    if cum_gross > original_gross_minor:
        raise BoostValidationError("cumulative refund exceeds original gross total")

    if vat_rate_bp is None:
        vat_rate_bp = (
            0
            if original_vat_minor == 0
            else round_half_up(original_vat_minor * BASIS_POINTS, original_net_minor)
        )
    if not 0 <= vat_rate_bp <= BASIS_POINTS:
        raise BoostValidationError("invalid vat_rate_bp")

    if cum_gross == original_gross_minor:
        delta_net = original_net_minor - previously_refunded_net_minor
        if delta_net <= 0:
            raise BoostValidationError("refund slice cannot produce positive net")
        delta_vat = vat_for_net_minor(delta_net, vat_rate_bp)
        if (
            delta_net + delta_vat != refund_gross_minor
            or previously_refunded_vat_minor + delta_vat != original_vat_minor
        ):
            raise BoostValidationError(
                "refund slice violates EN 16931 BR-S-09 tax-rate coherence against invoice totals"
            )
        return delta_net, delta_vat

    approx_delta_net = round_half_up(refund_gross_minor * BASIS_POINTS, BASIS_POINTS + vat_rate_bp)
    for candidate_net in (approx_delta_net, approx_delta_net - 1, approx_delta_net + 1):
        if candidate_net <= 0:
            continue
        candidate_vat = vat_for_net_minor(candidate_net, vat_rate_bp)
        if candidate_net + candidate_vat != refund_gross_minor:
            continue
        rem_net = original_net_minor - (previously_refunded_net_minor + candidate_net)
        rem_vat = original_vat_minor - (previously_refunded_vat_minor + candidate_vat)
        rem_gross = original_gross_minor - cum_gross
        if rem_net <= 0 or rem_vat < 0:
            continue
        if rem_net + rem_vat == rem_gross and vat_for_net_minor(rem_net, vat_rate_bp) == rem_vat:
            return candidate_net, candidate_vat

    raise BoostValidationError(
        "partial refund amount is not line-coherent with VAT rate under EN 16931 BR-S-09"
    )


def build_boost_invoice_snapshot(
    *,
    number: str,
    issued_at: datetime,
    due_at: datetime,
    quote: BoostQuote,
    seller: DocumentParty,
    buyer: DocumentParty,
    period_start: datetime,
    period_end: datetime,
) -> Snapshot:
    """Build a frozen `Factur-X 380` invoice snapshot for a Volet A boost."""
    unit_vat = line_amounts(
        unit_amount_minor=quote.pack.net_amount_minor,
        quantity=quote.quantity,
        vat_rate_bp=quote.vat_regime.rate_bp,
    ).vat_minor
    return Snapshot(
        number=number,
        type_code="380",
        issued_at=issued_at,
        due_at=due_at,
        currency=quote.pack.currency,
        vat_regime=quote.vat_regime.code,
        vat_mention=quote.vat_regime.mention,
        seller=seller,
        buyer=buyer,
        lines=(
            DocumentLine(
                position=1,
                description=quote.pack.name,
                quantity=quote.quantity,
                unit_minor=quote.pack.net_amount_minor,
                net_minor=quote.net_amount_minor,
                vat_rate_bp=quote.vat_regime.rate_bp,
                vat_minor=unit_vat,
                period_start=period_start,
                period_end=period_end,
            ),
        ),
        net_minor=quote.net_amount_minor,
        vat_minor=quote.vat_amount_minor,
        gross_minor=quote.gross_amount_minor,
    )


def build_boost_refund_credit_note_snapshot(
    *,
    credit_note_number: str,
    issued_at: datetime,
    invoice_snapshot: Snapshot,
    delta_net_minor: int,
    delta_vat_minor: int,
) -> Snapshot:
    """Build a frozen `Factur-X 381` credit-note snapshot for a line-coherent boost refund."""
    base_line = invoice_snapshot.lines[0]
    expected_vat = vat_for_net_minor(delta_net_minor, base_line.vat_rate_bp)
    if delta_net_minor <= 0 or delta_vat_minor != expected_vat:
        raise BoostValidationError(
            "credit note line VAT does not match vat_for_net_minor (EN 16931 BR-S-09)"
        )
    return Snapshot(
        number=credit_note_number,
        type_code="381",
        issued_at=issued_at,
        due_at=None,
        currency=invoice_snapshot.currency,
        vat_regime=invoice_snapshot.vat_regime,
        vat_mention=invoice_snapshot.vat_mention,
        seller=invoice_snapshot.seller,
        buyer=invoice_snapshot.buyer,
        lines=(
            DocumentLine(
                position=1,
                description=f"Avoir remboursement — {base_line.description}",
                quantity=1,
                unit_minor=delta_net_minor,
                net_minor=delta_net_minor,
                vat_rate_bp=base_line.vat_rate_bp,
                vat_minor=delta_vat_minor,
                period_start=base_line.period_start,
                period_end=base_line.period_end,
            ),
        ),
        net_minor=delta_net_minor,
        vat_minor=delta_vat_minor,
        gross_minor=delta_net_minor + delta_vat_minor,
        original_invoice_number=invoice_snapshot.number,
    )


def apply_credit_refund_delta(
    *,
    granted_minor: int,
    consumed_minor: int,
    previously_refunded_minor: int,
    original_gross_minor: int,
    previously_refunded_gross_minor: int,
    refund_gross_minor: int,
) -> tuple[int, int, str]:
    """Compute `(new_refunded_minor, new_remaining_minor, new_state)` on `WorkspaceHostingCredit`."""
    cum_gross = previously_refunded_gross_minor + refund_gross_minor
    if cum_gross > original_gross_minor:
        raise BoostValidationError("refund exceeds boost gross total")
    if cum_gross == original_gross_minor:
        target_refunded = granted_minor - consumed_minor
    else:
        proportional = (cum_gross * granted_minor) // original_gross_minor
        target_refunded = min(
            granted_minor - consumed_minor, max(previously_refunded_minor, proportional)
        )
    new_remaining = granted_minor - consumed_minor - target_refunded
    if new_remaining < 0:
        raise BoostValidationError("cannot refund hosting credits already consumed")
    if cum_gross == original_gross_minor:
        state = "revoked"
    elif new_remaining == 0:
        state = "depleted"
    else:
        state = "active"
    return target_refunded, new_remaining, state


@dataclass(frozen=True, slots=True)
class BoostGrantSummary:
    state: str
    seats_delta: int
    storage_bytes_delta: int
    expires_at: datetime | None


def compute_effective_workspace_quota(
    *,
    base_policy_ref: str,
    base_seats: int | None,
    base_storage_bytes: int | None,
    grants: Sequence[BoostGrantSummary],
    now: datetime,
) -> EffectiveWorkspaceQuota:
    """Aggregate workspace seats & storage across base subscription and overlapping active boosts."""
    active_grants = [
        g for g in grants if g.state == "active" and (g.expires_at is None or g.expires_at > now)
    ]
    total_seats = (
        None
        if base_seats is None
        else max(0, base_seats) + sum(g.seats_delta for g in active_grants)
    )
    total_storage = (
        None
        if base_storage_bytes is None
        else max(0, base_storage_bytes) + sum(g.storage_bytes_delta for g in active_grants)
    )
    policy_ref = (
        f"{base_policy_ref}+boosts:{len(active_grants)}" if active_grants else base_policy_ref
    )
    return EffectiveWorkspaceQuota(
        policy_ref=policy_ref,
        seats=total_seats,
        storage_bytes=total_storage,
        active_boost_count=len(active_grants),
    )


# --- Transactional Django ORM Services -----------------------------------------------------------


def resolve_server_b2b_vat_status(
    *, organisation_id: UUID, now: datetime
) -> tuple[BillingProfile, bool]:
    """Derive B2B billing identity & VIES validation strictly from stored Core `BillingProfile`."""
    profile = BillingProfile.objects.filter(organisation_id=organisation_id).first()
    if profile is None:
        raise BoostValidationError("B2B checkout requires a stored organisation BillingProfile")
    validated = False
    if profile.country in EU_MEMBER_STATES - {"FR"} and profile.vat_number:
        consultation = current_consultation(profile)
        if (
            consultation is None
            or consultation.status == "unavailable"
            or consultation.next_check_at <= now
        ):
            raise BoostValidationError("fresh VIES consultation evidence required for EU B2B VAT")
        validated = consultation.status == "valid"
    return profile, validated


def _boost_request_sha256(
    *,
    workspace_id: UUID,
    purchaser_user_id: UUID,
    pack_code: str,
    quantity: int,
    customer_kind: str,
    customer_country: str,
    return_url: str,
    locale: str,
    withdrawal_waiver_accepted: bool,
) -> str:
    canonical = json.dumps(
        {
            "workspace_id": str(workspace_id),
            "purchaser_user_id": str(purchaser_user_id),
            "pack_code": pack_code,
            "quantity": quantity,
            "customer_kind": customer_kind,
            "customer_country": customer_country.upper(),
            "return_url": return_url,
            "locale": locale,
            "withdrawal_waiver_accepted": withdrawal_waiver_accepted,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _issue_boost_invoice_via_authority(
    *,
    grant_id: UUID,
    issuer: Issuer,
    vat_mention: str | None,
    customer_payload: dict[str, str | None],
    description: str,
    quantity: int,
    unit_amount_minor: int,
    period_start: datetime,
    period_end: datetime,
) -> UUID:
    series = str(getattr(settings, "KODERA_INVOICE_SERIES", "KODERA"))
    payment_terms_days = int(getattr(settings, "KODERA_PAYMENT_TERMS_DAYS", 30))
    issuer_json = json.dumps(
        {
            "legal_name": issuer.legal_name,
            "address": issuer.address,
            "country": issuer.country,
            "siren": issuer.siren,
            "vat_number": issuer.vat_number,
            "vat_mention": vat_mention,
        },
        separators=(",", ":"),
    )
    customer_json = json.dumps(customer_payload, separators=(",", ":"))
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.billing_issue_boost_invoice("
            "%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s"
            ")",
            [
                grant_id,
                series,
                payment_terms_days,
                issuer_json,
                customer_json,
                description,
                quantity,
                unit_amount_minor,
                period_start,
                period_end,
            ],
        )
        row = cursor.fetchone()
    if row is None or row[0] is None:
        raise RuntimeError("billing_issue_boost_invoice returned no invoice id")
    return row[0] if isinstance(row[0], UUID) else UUID(str(row[0]))


def _issue_boost_refund_credit_note_via_authority(
    *,
    grant_id: UUID,
    delta_net_minor: int,
    delta_vat_minor: int,
) -> UUID:
    series = credit_note_series()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT public.billing_issue_boost_refund_credit_note(%s, %s, %s, %s)",
            [grant_id, series, delta_net_minor, delta_vat_minor],
        )
        row = cursor.fetchone()
    if row is None or row[0] is None:
        raise RuntimeError("billing_issue_boost_refund_credit_note returned no credit note id")
    return row[0] if isinstance(row[0], UUID) else UUID(str(row[0]))


SOVEREIGN_TIER_SEATS: dict[str, int] = {
    "S": 25,
    "M": 100,
    "L": 250,
}


def _base_subscription_quota(organisation_id: UUID) -> tuple[str, int | None, int | None]:
    from apps.orgs.selectors import organisation_plan_tier_state
    from apps.workspaces.selectors import workspace_id_for, workspace_quota_policy

    org_state = organisation_plan_tier_state(organisation_id=organisation_id)
    ws_id = workspace_id_for(organisation_id=organisation_id)
    existing_policy = workspace_quota_policy(workspace_id=ws_id) if ws_id is not None else None
    existing_base_ref = (
        existing_policy[0].split("+boosts:", 1)[0] if existing_policy is not None else None
    )

    if org_state is not None and org_state[2]:
        return (
            existing_base_ref or "community-unlimited-v1",
            existing_policy[1] if existing_policy is not None else None,
            existing_policy[2] if existing_policy is not None else None,
        )

    preserve_unlimited_seats = bool(existing_policy is not None and existing_policy[1] is None)
    preserve_unlimited_storage = bool(existing_policy is not None and existing_policy[2] is None)

    sub = (
        Subscription.objects.filter(
            organisation_id=organisation_id, state__in=("active", "past_due")
        )
        .order_by("-created_at", "-id")
        .first()
    )
    if sub is None:
        if org_state is not None and org_state[1] == "freemium_pme":
            return (
                existing_base_ref
                if (preserve_unlimited_seats and existing_base_ref)
                else "freemium:pme",
                None if preserve_unlimited_seats else 5,
                None if preserve_unlimited_storage else 5 * GIB,
            )
        return (
            existing_base_ref
            if ((preserve_unlimited_seats or preserve_unlimited_storage) and existing_base_ref)
            else "community:free",
            None if preserve_unlimited_seats else 25,
            None if preserve_unlimited_storage else 5 * GIB,
        )
    tier = CapacityTier.objects.filter(code=sub.capacity_tier_code).first()
    if sub.plan_code == "sovereign" or sub.pack_code == "sovereign":
        sovereign_seats = SOVEREIGN_TIER_SEATS.get(sub.capacity_tier_code)
        seats = (
            sovereign_seats * sub.quantity
            if sovereign_seats is not None
            else ((tier.seats_included * sub.quantity) if tier is not None else sub.quantity)
        )
    else:
        seats = (tier.seats_included * sub.quantity) if tier is not None else sub.quantity
    storage = (tier.storage_included_bytes * sub.quantity) if tier is not None else 10 * GIB
    return (
        f"subscription:{sub.plan_code}:{sub.state}",
        int(seats),
        int(storage),
    )


def recompute_workspace_boost_quota(
    *, organisation_id: UUID, workspace_id: UUID, now: datetime | None = None
) -> EffectiveWorkspaceQuota:
    """Recompute and persist `WorkspaceQuota` atomically across all overlapping active boosts."""
    from apps.orgs.selectors import is_default_community_organisation

    moment = now or timezone.now()
    base_ref, base_seats, base_storage = _base_subscription_quota(organisation_id)
    rows = list(
        WorkspaceBoostGrant.objects.select_for_update().filter(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
        )
    )
    if is_default_community_organisation(organisation_id=organisation_id):
        active_count = sum(
            1
            for r in rows
            if r.state == "active" and (r.expires_at is None or r.expires_at > moment)
        )
        return EffectiveWorkspaceQuota(
            policy_ref=base_ref,
            seats=base_seats,
            storage_bytes=base_storage,
            active_boost_count=active_count,
        )
    summaries = [
        BoostGrantSummary(
            state=r.state,
            seats_delta=r.seats_delta,
            storage_bytes_delta=r.storage_bytes_delta,
            expires_at=r.expires_at,
        )
        for r in rows
    ]
    effective = compute_effective_workspace_quota(
        base_policy_ref=base_ref,
        base_seats=base_seats,
        base_storage_bytes=base_storage,
        grants=summaries,
        now=moment,
    )
    sync_subscription_quota(
        organisation_id=organisation_id,
        policy_ref=effective.policy_ref,
        seats=effective.seats,
        media_bytes=effective.storage_bytes,
        update_storage=True,
    )
    return effective


def _cancel_redundant_provider_link(provider: PaymentProvider, provider_ref: str) -> None:
    try:
        provider.cancel_link(provider_ref)
    except Exception:  # noqa: S110 - best-effort cleanup of duplicate unrecorded session
        pass


def create_boost_checkout(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    purchaser_user_id: UUID,
    pack_code: str,
    customer_kind: str,
    customer_country: str,
    customer_legal_name: str,
    customer_address_line1: str,
    customer_postal_code: str,
    customer_city: str,
    idempotency_key: str,
    return_url: str,
    provider: PaymentProvider,
    withdrawal_waiver_accepted: bool,
    withdrawal_waiver_at: datetime | None,
    withdrawal_waiver_statement: str | None,
    customer_vat_number: str | None = None,
    vat_number_validated: bool = False,
    quantity: int = 1,
    locale: str = "fr",
) -> tuple[WorkspaceBoostGrant, Invoice, ProviderLink]:
    """Create a pending `WorkspaceBoostGrant`, issue Core's `Factur-X 380` `Invoice` via the narrow
    SQL authority helper, and issue a card-only Checkout session outside `transaction.atomic()`."""
    del customer_vat_number, vat_number_validated  # Derived strictly from stored BillingProfile!
    if connection.in_atomic_block:
        raise RuntimeError(
            "create_boost_checkout must not be called inside an outer transaction.atomic()"
        )
    if not isinstance(idempotency_key, str) or IDEMPOTENCY_KEY.fullmatch(idempotency_key) is None:
        raise BoostValidationError("invalid idempotency_key")
    check_return_url(return_url)
    if locale not in {"fr", "en"}:
        raise BoostValidationError("unsupported locale")
    from apps.orgs.selectors import is_default_community_organisation

    if is_default_community_organisation(organisation_id=organisation_id):
        raise BoostValidationError(
            "Community workspace already includes unlimited seats and storage"
        )

    now = timezone.now()
    issuer: Issuer | None = getattr(settings, "KODERA_BILLING_ISSUER", None)
    if issuer is None:
        raise RuntimeError("KODERA_BILLING_ISSUER must be configured to issue boost invoices")

    waiver_ok, waiver_at, waiver_evidence = verify_b2c_withdrawal_waiver(
        customer_kind=customer_kind,
        scope=f"volet-a:{workspace_id}",
        offer_code=pack_code,
        buyer_ref=str(purchaser_user_id),
        withdrawal_waiver_accepted=withdrawal_waiver_accepted,
        withdrawal_waiver_at=withdrawal_waiver_at,
        withdrawal_waiver_statement=withdrawal_waiver_statement,
        now=now,
    )

    # Phase 1: DB checkpoint & Core Factur-X 380 invoice issuance inside short atomic block
    cached_result: tuple[WorkspaceBoostGrant, Invoice, ProviderLink] | None = None
    with transaction.atomic():
        if customer_kind == "b2b":
            profile, server_vies_valid = resolve_server_b2b_vat_status(
                organisation_id=organisation_id, now=now
            )
            eff_country = profile.country
            eff_exempt = profile.vat_exempt
            customer_payload: dict[str, str | None] = {
                "legal_name": profile.legal_name,
                "address_line1": profile.address_line1,
                "address_line2": profile.address_line2,
                "postal_code": profile.postal_code,
                "city": profile.city,
                "siren": profile.siren,
                "vat_number": profile.vat_number,
            }
        elif customer_kind == "b2c":
            eff_country = customer_country.strip().upper()
            server_vies_valid = False
            eff_exempt = False
            customer_payload = {
                "legal_name": customer_legal_name.strip(),
                "address_line1": customer_address_line1.strip(),
                "address_line2": None,
                "postal_code": customer_postal_code.strip(),
                "city": customer_city.strip(),
                "siren": None,
                "vat_number": None,
            }
            if (
                not customer_payload["legal_name"]
                or not customer_payload["address_line1"]
                or not customer_payload["postal_code"]
                or not customer_payload["city"]
            ):
                raise BoostValidationError("B2C invoice requires buyer name and postal address")
        else:
            raise BoostValidationError(f"unsupported customer_kind {customer_kind!r}")

        req_hash = _boost_request_sha256(
            workspace_id=workspace_id,
            purchaser_user_id=purchaser_user_id,
            pack_code=pack_code,
            quantity=quantity,
            customer_kind=customer_kind,
            customer_country=eff_country,
            return_url=return_url,
            locale=locale,
            withdrawal_waiver_accepted=waiver_ok,
        )

        from apps.billing.payments.services import (
            existing_stripe_customer_ref,
            expected_stripe_binding,
        )
        from apps.billing.vip_connect import ConnectPlatformMismatchError

        exp_acct, exp_live = (
            expected_stripe_binding() if provider.name == "stripe" else (None, None)
        )

        existing = (
            WorkspaceBoostGrant.objects.select_for_update()
            .filter(
                organisation_id=organisation_id,
                idempotency_key=idempotency_key,
            )
            .first()
        )
        if existing is not None:
            if existing.request_sha256 != req_hash:
                raise IdempotencyKeyReuseError()
            if (
                existing.state in {"pending_payment", "cancelled"}
                and provider.name == "stripe"
                and (exp_acct is not None or exp_live is not None)
                and (
                    (exp_acct is not None and existing.stripe_account_id != exp_acct)
                    or (exp_live is not None and existing.stripe_livemode is not exp_live)
                )
            ):
                raise ConnectPlatformMismatchError(
                    "Pending or revoked boost checkout belongs to another Stripe platform or mode"
                )
            if existing.invoice_id is None:
                raise RuntimeError("existing boost grant missing bound invoice")
            inv = Invoice.objects.get(id=existing.invoice_id)
            if existing.stripe_checkout_session_id and existing.stripe_checkout_url:
                cached_result = (
                    existing,
                    inv,
                    ProviderLink(
                        provider_ref=existing.stripe_checkout_session_id,
                        url=existing.stripe_checkout_url,
                    ),
                )
            elif existing.state != "pending_payment":
                raise IdempotencyKeyReuseError()
            else:
                grant = existing
                invoice = inv
        else:
            quote = quote_boost_pack(
                pack_code=pack_code,
                customer_country=eff_country,
                customer_kind=customer_kind,
                quantity=quantity,
                vat_number_validated=server_vies_valid,
                vat_exempt=eff_exempt,
            )
            period_end = now + timedelta(days=quote.pack.duration_days)
            grant = WorkspaceBoostGrant.objects.create(
                organisation_id=organisation_id,
                workspace_id=workspace_id,
                purchaser_user_id=purchaser_user_id,
                invoice=None,
                pack_code=quote.pack.code,
                customer_kind=customer_kind,
                customer_country=quote.customer_country,
                currency=quote.pack.currency,
                vat_regime=quote.vat_regime.code,
                vat_rate_bp=quote.vat_regime.rate_bp,
                net_amount_minor=quote.net_amount_minor,
                vat_amount_minor=quote.vat_amount_minor,
                gross_amount_minor=quote.gross_amount_minor,
                credit_amount_minor=quote.credit_amount_minor,
                seats_delta=quote.seats_delta,
                storage_bytes_delta=quote.storage_bytes_delta,
                state="pending_payment",
                withdrawal_waiver_accepted=waiver_ok,
                withdrawal_waiver_at=waiver_at,
                withdrawal_waiver_evidence=waiver_evidence,
                idempotency_key=idempotency_key,
                request_sha256=req_hash,
                stripe_account_id=exp_acct,
                stripe_livemode=exp_live,
            )
            inv_id = _issue_boost_invoice_via_authority(
                grant_id=grant.id,
                issuer=issuer,
                vat_mention=quote.vat_regime.mention,
                customer_payload=customer_payload,
                description=quote.pack.name,
                quantity=quote.quantity,
                unit_amount_minor=quote.pack.net_amount_minor,
                period_start=now,
                period_end=period_end,
            )
            grant.refresh_from_db()
            invoice = Invoice.objects.get(id=inv_id)

    if cached_result is not None:
        return cached_result

    # Phase 2: Outbound Stripe Checkout session creation OUTSIDE transaction.atomic()
    from apps.billing.payments.services import existing_stripe_customer_ref

    issued_link = provider.create_link(
        LinkRequest(
            invoice_id=invoice.id,
            invoice_number=invoice.number or "",
            amount_minor=invoice.total_incl_vat_minor,
            currency=invoice.currency,
            expires_at=now + timedelta(hours=23),
            return_url=return_url,
            locale=locale,
            payment_methods=("card",),
            reference_kind="invoice",
            metadata={"volet": "a_boost", "boost_grant_id": str(grant.id)},
            customer_ref=(
                existing_stripe_customer_ref(organisation_id=organisation_id)
                if provider.name == "stripe"
                else None
            ),
        )
    )

    # Phase 3: Persist session reference & URL atomically
    with transaction.atomic():
        locked = WorkspaceBoostGrant.objects.select_for_update().get(id=grant.id)
        if locked.stripe_checkout_session_id and locked.stripe_checkout_url:
            if locked.stripe_checkout_session_id != issued_link.provider_ref:
                transaction.on_commit(
                    partial(_cancel_redundant_provider_link, provider, issued_link.provider_ref)
                )
            return (
                locked,
                invoice,
                ProviderLink(
                    provider_ref=locked.stripe_checkout_session_id,
                    url=locked.stripe_checkout_url,
                ),
            )
        locked.stripe_checkout_session_id = issued_link.provider_ref
        locked.stripe_checkout_url = issued_link.url
        locked.save(
            update_fields=["stripe_checkout_session_id", "stripe_checkout_url", "updated_at"]
        )
        return locked, invoice, issued_link


def cancel_pending_boost_grant(*, grant_id: UUID) -> bool:
    """Cancel an expired or failed pending Volet A boost grant without touching settled grants."""
    with transaction.atomic():
        grant = WorkspaceBoostGrant.objects.select_for_update().get(id=grant_id)
        if grant.state != "pending_payment":
            return False
        grant.state = "cancelled"
        grant.stripe_checkout_url = None
        grant.save(update_fields=["state", "stripe_checkout_url", "updated_at"])
        return True


def activate_boost_grant(
    *,
    grant_id: UUID,
    payment_intent_id: str,
    settled_at: datetime | None = None,
) -> tuple[WorkspaceBoostGrant, WorkspaceHostingCredit, EffectiveWorkspaceQuota]:
    """Activate a paid `WorkspaceBoostGrant`, record Core `Payment`, mark `Invoice` paid, and sync quota."""
    moment = settled_at or timezone.now()
    with transaction.atomic():
        grant = WorkspaceBoostGrant.objects.select_for_update().get(id=grant_id)
        if grant.customer_kind == "b2c" and (
            not grant.withdrawal_waiver_accepted
            or grant.withdrawal_waiver_at is None
            or not grant.withdrawal_waiver_evidence
        ):
            raise WithdrawalWaiverRequiredError(
                "cannot activate B2C boost without recorded Art. L221-28 waiver"
            )
        if grant.state == "active":
            credit = WorkspaceHostingCredit.objects.get(boost_grant=grant)
            quota = recompute_workspace_boost_quota(
                organisation_id=grant.organisation_id,
                workspace_id=grant.workspace_id,
                now=moment,
            )
            return grant, credit, quota

        pack = BOOST_PACKS.get(grant.pack_code)
        duration = timedelta(days=pack.duration_days if pack is not None else 30)
        grant.state = "active"
        grant.activated_at = moment
        grant.expires_at = moment + duration
        grant.stripe_payment_intent_id = payment_intent_id
        grant.save(
            update_fields=[
                "state",
                "activated_at",
                "expires_at",
                "stripe_payment_intent_id",
                "updated_at",
            ]
        )

        if grant.invoice_id is not None:
            inv = Invoice.objects.select_for_update().get(id=grant.invoice_id)
            payment, created_pay = Payment.objects.select_for_update().get_or_create(
                provider="stripe",
                provider_ref=payment_intent_id,
                defaults={
                    "organisation_id": grant.organisation_id,
                    "invoice": inv,
                    "amount_minor": inv.total_incl_vat_minor,
                    "currency": inv.currency,
                    "state": "succeeded",
                    "allocated": True,
                    "last_event_at": moment,
                },
            )
            if not created_pay and payment.state != "succeeded":
                payment.state = "succeeded"
                payment.allocated = True
                payment.last_event_at = moment
                payment.save(update_fields=["state", "allocated", "last_event_at", "updated_at"])
            if inv.state != "paid":
                inv.amount_paid_minor = inv.total_incl_vat_minor
                inv.save(update_fields=["amount_paid_minor", "updated_at"])
                set_invoice_state(inv, "paid", actor=Actor("system", None))

        credit, _ = WorkspaceHostingCredit.objects.get_or_create(
            boost_grant=grant,
            defaults={
                "organisation_id": grant.organisation_id,
                "workspace_id": grant.workspace_id,
                "currency": grant.currency,
                "granted_minor": grant.credit_amount_minor,
                "consumed_minor": 0,
                "refunded_minor": 0,
                "remaining_minor": grant.credit_amount_minor,
                "state": "active",
                "expires_at": grant.expires_at,
            },
        )
        quota = recompute_workspace_boost_quota(
            organisation_id=grant.organisation_id,
            workspace_id=grant.workspace_id,
            now=moment,
        )
        events.record(
            "payment.received",
            actor=Actor("system", None),
            organisation_id=grant.organisation_id,
            target=("boost_grant", grant.id),
            metadata={
                "workspace_id": str(grant.workspace_id),
                "pack_code": grant.pack_code,
                "credit_amount_minor": grant.credit_amount_minor,
            },
        )
        return grant, credit, quota


def refund_boost_grant(
    *,
    grant_id: UUID,
    cumulative_refunded_gross_minor: int,
    refunded_at: datetime | None = None,
) -> tuple[WorkspaceBoostGrant, CreditNote | None, EffectiveWorkspaceQuota]:
    """Process a line-coherent Volet A boost refund: issue `Factur-X 381` `CreditNote` via narrow
    SQL authority, reconcile `Invoice.amount_paid_minor` & `Payment`, adjust credits, and sync quota."""
    moment = refunded_at or timezone.now()
    with transaction.atomic():
        grant = WorkspaceBoostGrant.objects.select_for_update().get(id=grant_id)
        if cumulative_refunded_gross_minor <= grant.refunded_gross_minor:
            quota = recompute_workspace_boost_quota(
                organisation_id=grant.organisation_id,
                workspace_id=grant.workspace_id,
                now=moment,
            )
            return grant, None, quota
        if cumulative_refunded_gross_minor > grant.gross_amount_minor:
            raise BoostValidationError("cumulative refund exceeds boost gross total")

        delta_gross = cumulative_refunded_gross_minor - grant.refunded_gross_minor
        credit = (
            WorkspaceHostingCredit.objects.select_for_update().filter(boost_grant=grant).first()
        )
        note: CreditNote | None = None

        if grant.invoice_id is not None:
            invoice = Invoice.objects.select_for_update().get(id=grant.invoice_id)
            inv_line = InvoiceLine.objects.filter(invoice=invoice).order_by("position").first()
            if inv_line is None:
                raise RuntimeError("boost invoice missing invoice line")
            prev_net = sum(
                int(v)
                for v in CreditNote.objects.filter(invoice=invoice, reason="refund").values_list(
                    "total_excl_vat_minor", flat=True
                )
            )
            delta_net, delta_vat = split_gross_refund(
                original_net_minor=invoice.total_excl_vat_minor,
                original_vat_minor=invoice.vat_amount_minor,
                original_gross_minor=invoice.total_incl_vat_minor,
                previously_refunded_gross_minor=grant.refunded_gross_minor,
                previously_refunded_net_minor=prev_net,
                refund_gross_minor=delta_gross,
                vat_rate_bp=inv_line.vat_rate_bp,
            )
            note_id = _issue_boost_refund_credit_note_via_authority(
                grant_id=grant.id,
                delta_net_minor=delta_net,
                delta_vat_minor=delta_vat,
            )
            note = CreditNote.objects.get(id=note_id)
            if grant.stripe_payment_intent_id:
                payment = (
                    Payment.objects.select_for_update()
                    .filter(provider="stripe", provider_ref=grant.stripe_payment_intent_id)
                    .first()
                )
                if payment is not None:
                    is_full = cumulative_refunded_gross_minor >= grant.gross_amount_minor
                    if is_full and "reversed" in PAYMENT_TRANSITIONS.get(
                        payment.state, frozenset()
                    ):
                        payment.state = "reversed"
                        payment.allocated = False
                        payment.last_event_at = moment
                        payment.save(
                            update_fields=["state", "allocated", "last_event_at", "updated_at"]
                        )
                    elif payment.last_event_at is None or moment > payment.last_event_at:
                        payment.last_event_at = moment
                        payment.save(update_fields=["last_event_at", "updated_at"])

        if credit is not None:
            new_refunded, new_remaining, credit_state = apply_credit_refund_delta(
                granted_minor=credit.granted_minor,
                consumed_minor=credit.consumed_minor,
                previously_refunded_minor=credit.refunded_minor,
                original_gross_minor=grant.gross_amount_minor,
                previously_refunded_gross_minor=grant.refunded_gross_minor,
                refund_gross_minor=delta_gross,
            )
            credit.refunded_minor = new_refunded
            credit.remaining_minor = new_remaining
            credit.state = credit_state
            credit.save(update_fields=["refunded_minor", "remaining_minor", "state", "updated_at"])

        grant.refunded_gross_minor = cumulative_refunded_gross_minor
        if cumulative_refunded_gross_minor >= grant.gross_amount_minor:
            grant.state = "refunded"
            grant.refunded_at = moment
            grant.save(update_fields=["refunded_gross_minor", "state", "refunded_at", "updated_at"])
        else:
            grant.save(update_fields=["refunded_gross_minor", "updated_at"])

        quota = recompute_workspace_boost_quota(
            organisation_id=grant.organisation_id,
            workspace_id=grant.workspace_id,
            now=moment,
        )
        return grant, note, quota


def dispute_boost_grant(
    *,
    grant_id: UUID,
    dispute_id: str,
    occurred_at: datetime | None = None,
) -> tuple[WorkspaceBoostGrant, CreditNote | None, EffectiveWorkspaceQuota]:
    """Immediately revoke a disputed Volet A boost grant, zero remaining credits, issue a `381`
    credit note for any unrefunded balance, mark `Payment` reversed, and recompute quota."""
    moment = occurred_at or timezone.now()
    with transaction.atomic():
        grant = WorkspaceBoostGrant.objects.select_for_update().get(id=grant_id)
        if grant.state == "disputed":
            quota = recompute_workspace_boost_quota(
                organisation_id=grant.organisation_id,
                workspace_id=grant.workspace_id,
                now=moment,
            )
            return grant, None, quota

        delta_gross = max(0, grant.gross_amount_minor - grant.refunded_gross_minor)
        note: CreditNote | None = None
        if delta_gross > 0 and grant.invoice_id is not None:
            invoice = Invoice.objects.select_for_update().get(id=grant.invoice_id)
            inv_line = InvoiceLine.objects.filter(invoice=invoice).order_by("position").first()
            if inv_line is not None and invoice.state == "paid":
                prev_net = sum(
                    int(v)
                    for v in CreditNote.objects.filter(
                        invoice=invoice, reason="refund"
                    ).values_list("total_excl_vat_minor", flat=True)
                )
                delta_net, delta_vat = split_gross_refund(
                    original_net_minor=invoice.total_excl_vat_minor,
                    original_vat_minor=invoice.vat_amount_minor,
                    original_gross_minor=invoice.total_incl_vat_minor,
                    previously_refunded_gross_minor=grant.refunded_gross_minor,
                    previously_refunded_net_minor=prev_net,
                    refund_gross_minor=delta_gross,
                    vat_rate_bp=inv_line.vat_rate_bp,
                )
                note_id = _issue_boost_refund_credit_note_via_authority(
                    grant_id=grant.id,
                    delta_net_minor=delta_net,
                    delta_vat_minor=delta_vat,
                )
                note = CreditNote.objects.get(id=note_id)

        if grant.stripe_payment_intent_id:
            payment = (
                Payment.objects.select_for_update()
                .filter(provider="stripe", provider_ref=grant.stripe_payment_intent_id)
                .first()
            )
            if payment is not None and "reversed" in PAYMENT_TRANSITIONS.get(
                payment.state, frozenset()
            ):
                payment.state = "reversed"
                payment.allocated = False
                payment.last_event_at = moment
                payment.save(update_fields=["state", "allocated", "last_event_at", "updated_at"])

        credit = (
            WorkspaceHostingCredit.objects.select_for_update().filter(boost_grant=grant).first()
        )
        if credit is not None:
            credit.refunded_minor = credit.granted_minor - credit.consumed_minor
            credit.remaining_minor = 0
            credit.state = "revoked"
            credit.save(update_fields=["refunded_minor", "remaining_minor", "state", "updated_at"])

        grant.refunded_gross_minor = grant.gross_amount_minor
        grant.state = "disputed"
        grant.refunded_at = moment
        grant.save(update_fields=["refunded_gross_minor", "state", "refunded_at", "updated_at"])

        quota = recompute_workspace_boost_quota(
            organisation_id=grant.organisation_id,
            workspace_id=grant.workspace_id,
            now=moment,
        )
        events.record(
            "payment.refunded",
            actor=Actor("system", None),
            organisation_id=grant.organisation_id,
            target=("boost_grant", grant.id),
            metadata={
                "workspace_id": str(grant.workspace_id),
                "dispute_id": dispute_id,
                "reason": "charge_dispute_created",
            },
        )
        return grant, note, quota

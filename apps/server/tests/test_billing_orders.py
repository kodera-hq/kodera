"""Catalogue, order placement, invoice numbering and immutability, against real PostgreSQL.

docs/domain/BILLING_MODEL.md §§1–4: an order is placed by the organisation's owner and writes its
order, pending subscription and issued invoice in one transaction; the same idempotency key
replays it; the VAT regime comes from the billing profile, never the caller; the invoice series is
gapless and in date order; an issued invoice and its lines are frozen by the database.
"""

import dataclasses
import itertools
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
import time_machine
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from test_customer_persistence_models import anchor, anchor_models, identity

from apps.audit.services import record_billing_event
from apps.billing import catalogue, services
from apps.billing.callers import (
    BillingCallerUnknownError,
    BillingForbiddenError,
    BillingNotFoundError,
)
from apps.billing.models import (
    CapacityTier,
    Invoice,
    InvoiceLine,
    Order,
    Pack,
    Plan,
    Price,
    Subscription,
)
from apps.billing.services import Accepted, Agreements, OrderRequest, TenantRequest
from apps.billing.states import INVOICE_STATES, INVOICE_TRANSITIONS, TransitionRefusedError
from apps.legal import services as legal
from apps.legal.models import LegalDocument
from apps.tenancy.models import Tenant
from services.identity.access_tokens import VerifiedAccessToken

pytestmark = pytest.mark.django_db(transaction=True)

KEY = "order-key-000000001"
_slugs = itertools.count()


def verified(issuer, subject):
    return VerifiedAccessToken(
        issuer=issuer,
        subject=subject,
        audience=("kodera-server",),
        issued_at=0,
        expires_at=2**31,
        not_before=None,
        amr=None,
        acr=None,
        auth_time=None,
    )


def world(*, state="active", profile=True, **profile_values):
    """An organisation, its owner's identity and token, and (by default) a French profile."""
    models = anchor_models()
    slug = f"billing{next(_slugs):04d}"
    organisation, _, owners = anchor(models, slug=slug, state=state)
    owner = identity(models, organisation, owners[0].user, subject=f"{slug}-owner")
    if profile:
        values = {
            "legal_name": "Synthetic Customer SAS",
            "address_line1": "1 rue Synthétique",
            "postal_code": "75000",
            "city": "Paris",
            "country": "FR",
            "siren": "000000001",
        }
        values.update(profile_values)
        services.set_billing_profile(organisation_id=organisation.id, **values)
    return SimpleNamespace(
        models=models,
        organisation=organisation,
        owner=owner,
        token=verified(organisation.issuer, f"{slug}-owner"),
    )


def member(w, role):
    user = w.models.User.objects.create(email=f"{role}-{uuid4().hex[:6]}@customer.test")
    w.models.Membership.objects.create(
        user=user,
        organisation=w.organisation,
        role=role,
        state="active",
        accepted_at=timezone.now(),
    )
    subject = f"{role}-{user.id}"
    identity(w.models, w.organisation, user, subject=subject)
    return verified(w.organisation.issuer, subject)


def offer(
    *,
    plan_state="published",
    available=True,
    tier_available=True,
    valid_from=None,
    valid_to=None,
    amount=448_800,
    plan=None,
    pack=None,
):
    plan = plan or Plan.objects.create(
        code=f"plan-{uuid4().hex[:8]}",
        version=1,
        name="Synthetic plan",
        state=plan_state,
        published_at=None if plan_state == "draft" else timezone.now(),
    )
    pack = pack or Pack.objects.create(
        code=f"pack-{uuid4().hex[:8]}",
        name="Synthetic pack",
        apps=["visio", "docs"],
        profile_ref="visio-docs/0.0",
        available=available,
    )
    tier, _ = CapacityTier.objects.get_or_create(
        code="M" if tier_available else "L",
        defaults={
            "name": "tier",
            "seats_included": 150,
            "concurrent_participants_included": 50,
            "storage_included_bytes": 0,
            "vm_shape": "synthetic",
            "available": tier_available,
        },
    )
    return Price.objects.create(
        plan=plan,
        pack=pack,
        capacity_tier=tier,
        billing_period="yearly",
        amount_minor=amount,
        valid_from=valid_from or timezone.now() - timedelta(days=1),
        valid_to=valid_to,
    )


def documents_published():
    if not LegalDocument.objects.exists():
        legal.load_documents(legal.read_documents(legal.PLACEHOLDER), allow_placeholder=True)


def agreements_for(w, price, key):
    """The DPA and the tenant slug of the order placed under `key`: generated once, so a replay
    of the key sends the same request."""
    orders = w.__dict__.setdefault("orders", {})
    if key not in orders:
        documents_published()
        if price.pack.available:
            dpa, _ = legal.generate_dpa(
                verified=w.token,
                organisation_id=w.organisation.id,
                pack_code=price.pack.code,
                locale="fr",
                tenant_id=None,
            )
            dpa_id = dpa.id
        else:
            dpa_id = uuid4()
        orders[key] = (dpa_id, f"t{uuid4().hex[:12]}")
    return orders[key]


CGV = Accepted(code="cgv", version="0.0", locale="fr")


def request_for(price, *, w=None, key=KEY, **changes):
    dpa_id, slug = agreements_for(w, price, key) if w is not None else (uuid4(), "tenant-slug")
    values = {
        "pack_code": price.pack.code,
        "capacity_tier_code": price.capacity_tier.code,
        "billing_period": price.billing_period,
        "tenant": TenantRequest(slug=slug, name="Synthetic tenant"),
        "agreements": Agreements(dpa_id=dpa_id, documents=(CGV,)),
    }
    return OrderRequest(**{**values, **changes})


def place(w, price, *, key=KEY, token=None, **changes):
    return services.place_order(
        verified=token or w.token,
        organisation_id=w.organisation.id,
        idempotency_key=key,
        request=request_for(price, w=w, key=key, **changes),
        request_id="request-0001",
    )


def audit_actions(organisation):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT action, actor_type FROM audit_auditevent WHERE organisation_id = %s"
            " ORDER BY occurred_at, id",
            [organisation.id],
        )
        return cursor.fetchall()


def raw(statement, parameters=()):
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute(statement, parameters)


class refused:  # noqa: N801 - a context manager read as a sentence
    def __init__(self, constraint):
        self.constraint = constraint

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        assert kind is IntegrityError, f"expected a refusal by {self.constraint}, got {kind}"
        assert error.__cause__.diag.constraint_name == self.constraint
        return True


def paris_year(moment):
    return moment.astimezone(services.PARIS).year


# --- placement --------------------------------------------------------------------------------


def test_an_order_writes_its_snapshot_its_pending_subscription_and_its_issued_invoice():
    w = world()
    price = offer()
    placed = place(w, price, purchase_order_ref="BC-1", notes="synthetic")
    order, subscription, invoice = placed.order, placed.subscription, placed.invoice
    assert placed.replayed is False
    assert (order.state, subscription.state) == ("placed", "pending")
    assert order.placed_by == w.owner.id and order.purchase_order_ref == "BC-1"
    for row in (order, subscription):
        assert (row.plan_code, row.pack_code, row.capacity_tier_code) == (
            price.plan.code,
            price.pack.code,
            "M",
        )
        assert row.apps == ["visio", "docs"] and row.price_id == price.id
        assert (row.total_excl_vat_minor, row.vat_amount_minor, row.total_incl_vat_minor) == (
            448_800,
            89_760,
            538_560,
        )
    invoice.refresh_from_db()
    assert invoice.state == "issued"
    assert invoice.number == f"TST-{paris_year(invoice.issued_at)}-00001"
    assert (invoice.issuer_legal_name, invoice.issuer_siren) == (
        "Issuer of Test Invoices SAS",
        "000000000",
    )
    assert (
        invoice.customer_legal_name,
        invoice.customer_address_line1,
        invoice.customer_city,
        invoice.customer_country,
        invoice.customer_siren,
    ) == ("Synthetic Customer SAS", "1 rue Synthétique", "Paris", "FR", "000000001")
    assert invoice.due_at - invoice.issued_at == timedelta(days=30)
    assert invoice.vat_regime == "fr_standard" and invoice.vat_mention is None
    (line,) = invoice.lines.all()
    assert (line.total_excl_vat_minor, line.vat_amount_minor) == (448_800, 89_760)
    assert audit_actions(w.organisation) == [
        ("dpa.accepted", "tenant"),
        ("tenant.ordered", "tenant"),
        ("subscription.created", "tenant"),
        ("invoice.issued", "system"),
    ]


def test_an_order_for_the_offers_workspace_gives_its_tenant_visio_and_espace():
    # The offer as loaded on an environment, and the one pack it sells: what kodera-team orders.
    catalogue.load(catalogue.read(catalogue.OFFER), allow_placeholder=False)
    price = Price.objects.get(
        plan__code="team", pack__code="workspace", capacity_tier__code="S", billing_period="yearly"
    )
    w = world()
    placed = place(w, price)
    tenant = Tenant.objects.get(id=placed.order.tenant_id)
    assert (tenant.status, tenant.pack_code, tenant.apps, tenant.profile_ref) == (
        "ordered",
        "workspace",
        ["visio", "messaging"],
        "workspace/1.0",
    )
    for row in (placed.order, placed.subscription):
        assert (row.pack_code, row.apps, row.unit_amount_minor) == (
            "workspace",
            ["visio", "messaging"],
            108_000,
        )


@pytest.mark.parametrize(
    ("profile", "regime", "vat"),
    [
        (
            {
                "country": "DE",
                "vat_number": "DE000000000",
                "vat_number_validated_at": datetime(2026, 1, 1, tzinfo=UTC),
                "siren": None,
            },
            "eu_reverse_charge",
            0,
        ),
        ({"country": "DE", "vat_number": "DE000000000", "siren": None}, "fr_standard", 89_760),
        ({"country": "CH", "siren": None}, "outside_eu", 0),
        ({"country": "BE", "vat_exempt": True, "siren": None}, "exempt", 0),
    ],
)
def test_the_regime_comes_from_the_billing_profile(profile, regime, vat):
    w = world(**profile)
    invoice = place(w, offer()).invoice
    assert (invoice.vat_regime, invoice.vat_amount_minor) == (regime, vat)
    assert (invoice.vat_mention is None) == (regime == "fr_standard")


def test_without_a_billing_profile_nothing_is_ordered():
    w = world(profile=False)
    with pytest.raises(services.BillingValidationError, match="billing_profile: missing"):
        place(w, offer())
    assert not Order.objects.filter(organisation_id=w.organisation.id).exists()


def test_the_same_key_replays_the_first_order():
    w = world()
    price = offer()
    first = place(w, price)
    again = place(w, price)
    assert again.replayed is True
    assert (again.order.id, again.subscription.id, again.invoice.id) == (
        first.order.id,
        first.subscription.id,
        first.invoice.id,
    )
    assert Order.objects.filter(organisation_id=w.organisation.id).count() == 1


@pytest.mark.parametrize(
    "change",
    [
        {"quantity": 2},
        {"plan_code": "other"},
        {"tenant": TenantRequest(slug="other-slug", name="Synthetic tenant")},
        {"agreements": Agreements(dpa_id=uuid4(), documents=(CGV,))},
        {"purchase_order_ref": "BC-2"},
        {"billing_contact_email": "billing@customer.test"},
        {"billing_contact_name": "Billing"},
        {"notes": "changed"},
        {"billing_period": "monthly"},
    ],
)
def test_the_same_key_with_any_other_request_is_refused(change):
    w = world()
    price = offer()
    place(w, price)
    with pytest.raises(services.IdempotencyKeyReuseError):
        place(w, price, **change)
    assert Order.objects.filter(organisation_id=w.organisation.id).count() == 1


def test_a_placement_that_loses_the_race_on_its_key_replays_the_winner(monkeypatch):
    w = world()
    price = offer()
    winner = place(w, price)
    real = services._replay
    calls = []

    def blind_first(**kwargs):
        calls.append(kwargs)
        return None if len(calls) == 1 else real(**kwargs)

    # The first lookup misses as a concurrent loser's would: the insert meets the unique key.
    monkeypatch.setattr(services, "_replay", blind_first)
    monkeypatch.setattr(services, "_has_order_in_flight", lambda **kwargs: False)
    loser = place(w, price)
    assert len(calls) == 2
    assert loser.replayed is True and loser.order.id == winner.order.id


def test_an_organisation_holds_one_order_in_flight():
    w = world()
    price = offer()
    first = place(w, price)
    with pytest.raises(services.OrderInProgressError):
        place(w, price, key=KEY + "b")
    # The database holds it too, whatever path writes the row.
    copy = Order.objects.get(id=first.order.id)
    copy.pk, copy.idempotency_key = uuid4(), KEY + "x"
    with refused(services.ONE_IN_FLIGHT), transaction.atomic():
        copy.save(force_insert=True)
    # A paid order holds nothing: the next tenant's order is written beside it.
    copy.state = "paid"
    with transaction.atomic():
        copy.save(force_insert=True)


def test_a_placement_that_loses_the_race_for_the_organisation_is_refused(monkeypatch):
    w = world()
    price = offer()
    place(w, price)
    # The loser's early check missed the winner's order, as a concurrent one would: the insert
    # meets the partial unique key, and the placement is refused, never replayed.
    monkeypatch.setattr(services, "_has_order_in_flight", lambda **kwargs: False)
    with pytest.raises(services.OrderInProgressError):
        place(w, price, key=KEY + "b")
    assert Order.objects.filter(organisation_id=w.organisation.id).count() == 1


def test_keys_are_per_organisation():
    first, second = world(), world()
    price = offer()
    assert place(first, price).order.id != place(second, price).order.id


@pytest.mark.parametrize("role", ["org_admin", "org_billing", "org_member"])
def test_only_the_owner_places_an_order(role):
    w = world()
    with pytest.raises(BillingForbiddenError) as refused_:
        place(w, offer(), token=member(w, role))
    assert refused_.value.scope == "order:create"
    assert not Order.objects.filter(organisation_id=w.organisation.id).exists()


def test_another_organisations_owner_and_an_unknown_identity_cannot_order():
    w, other = world(), world()
    price = offer()
    with pytest.raises(BillingNotFoundError):
        place(w, price, token=other.token)
    with pytest.raises(BillingCallerUnknownError):
        place(w, price, token=verified(w.organisation.issuer, "nobody"))


def test_a_suspended_organisation_cannot_order():
    w = world(state="suspended")
    with pytest.raises(services.OrganisationNotOrderableError):
        place(w, offer())


def test_without_a_configured_issuer_nothing_is_ordered(settings):
    w = world()
    price = offer()
    settings.KODERA_BILLING_ISSUER = None
    with pytest.raises(services.BillingNotConfiguredError):
        place(w, price)
    assert not Order.objects.filter(organisation_id=w.organisation.id).exists()


@pytest.mark.parametrize(
    ("offer_args", "field", "reason"),
    [
        ({"plan_state": "draft"}, "pack_code", "not_offered"),
        ({"available": False}, "pack_code", "unavailable"),
        ({"tier_available": False}, "capacity_tier_code", "unavailable"),
        ({"valid_from": timezone.now() + timedelta(days=1)}, "pack_code", "not_offered"),
    ],
)
def test_what_is_not_offered_now_is_refused_and_nothing_is_written(offer_args, field, reason):
    w = world()
    price = offer(**offer_args)
    with pytest.raises(services.BillingValidationError) as refusal:
        place(w, price)
    assert (refusal.value.field, refusal.value.reason) == (field, reason)
    assert not Invoice.objects.filter(organisation_id=w.organisation.id).exists()


def test_a_price_window_ending_now_is_over():
    w = world()
    now = timezone.now()
    price = offer(valid_from=now - timedelta(days=2), valid_to=now)
    with time_machine.travel(now, tick=False):
        with pytest.raises(services.BillingValidationError, match="not_offered"):
            place(w, price)


def test_a_newer_price_supersedes_the_older_from_its_start():
    w = world()
    old = offer(valid_from=timezone.now() - timedelta(days=10), amount=100)
    offer(valid_from=timezone.now() - timedelta(days=1), amount=200, plan=old.plan, pack=old.pack)
    assert place(w, old).order.unit_amount_minor == 200


def test_two_plans_offering_one_pack_need_the_plan_named():
    w = world()
    first = offer()
    second = offer(pack=first.pack, amount=1)
    with pytest.raises(services.BillingValidationError, match="plan_code: ambiguous"):
        place(w, first)
    assert place(w, first, plan_code=second.plan.code, key=KEY + "b").order.price_id == second.id


@pytest.mark.parametrize(
    ("key", "change", "field"),
    [
        ("short", {}, "idempotency_key"),
        (KEY + " space", {}, "idempotency_key"),
        (KEY, {"quantity": 0}, "quantity"),
        (KEY, {"quantity": 10_001}, "quantity"),
        (KEY, {"quantity": True}, "quantity"),
        (KEY, {"billing_period": "weekly"}, "billing_period"),
        (KEY, {"plan_code": "a b"}, "plan_code"),
        (KEY, {"purchase_order_ref": "x" * 101}, "purchase_order_ref"),
        (KEY, {"purchase_order_ref": "BC\r\nX"}, "purchase_order_ref"),
        (KEY, {"billing_contact_name": "a\tb"}, "billing_contact_name"),
        (KEY, {"billing_contact_email": "not-an-address"}, "billing_contact_email"),
        (KEY, {"notes": "x" * 1001}, "notes"),
        (KEY, {"notes": "bell\x07"}, "notes"),
    ],
)
def test_malformed_order_input_is_a_validation_error(key, change, field):
    w = world()
    with pytest.raises(services.BillingValidationError) as refusal:
        place(w, offer(), key=key, **change)
    assert refusal.value.field == field


def test_a_price_changed_afterwards_changes_no_order_subscription_or_invoice():
    w = world()
    price = offer()
    placed = place(w, price)
    raw("UPDATE billing_price SET amount_minor = 1 WHERE id = %s", [price.id])
    raw("UPDATE billing_plan SET name = 'Renamed' WHERE id = %s", [price.plan_id])
    services.set_billing_profile(
        organisation_id=w.organisation.id,
        legal_name="Renamed SAS",
        address_line1="2 rue Autre",
        postal_code="69000",
        city="Lyon",
        country="FR",
    )
    for model, row in ((Order, placed.order), (Subscription, placed.subscription)):
        assert model.objects.get(id=row.id).unit_amount_minor == 448_800
    invoice = Invoice.objects.get(id=placed.invoice.id)
    assert (invoice.total_incl_vat_minor, invoice.customer_legal_name) == (
        538_560,
        "Synthetic Customer SAS",
    )
    assert InvoiceLine.objects.get(invoice=invoice).description.startswith("Synthetic plan")


# --- numbering --------------------------------------------------------------------------------


def test_numbers_follow_each_other_and_a_rolled_back_issue_gives_its_number_back():
    w, rolled_back, later = world(), world(), world()
    price = offer()
    first = place(w, price, key=KEY + "a")

    class AbortError(Exception):
        pass

    with pytest.raises(AbortError):
        with transaction.atomic():
            place(rolled_back, price, key=KEY + "b")
            raise AbortError()
    second = place(later, price, key=KEY + "c")
    year = paris_year(first.invoice.issued_at)
    assert (first.invoice.number, second.invoice.number) == (
        f"TST-{year}-00001",
        f"TST-{year}-00002",
    )
    assert second.invoice.issued_at > first.invoice.issued_at


def test_each_series_counts_on_its_own(settings):
    w = world()
    price = offer()
    first = place(w, price, key=KEY + "a")
    settings.KODERA_INVOICE_SERIES = "OTHER"
    other = place(world(), price, key=KEY + "b")
    assert first.invoice.number.endswith("-00001")
    assert other.invoice.number == f"OTHER-{paris_year(other.invoice.issued_at)}-00001"


def test_a_later_number_never_carries_an_earlier_date():
    """The issue time is read once the series is held: an issue that waited for it is dated after
    the holder let go, so the numbers and the dates run the same way."""
    w = world()
    price = offer()
    params = connection.get_connection_params()
    holder = psycopg.connect(**params, autocommit=True)
    holder.execute("BEGIN")
    holder.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ["billing-invoice-series:TST"]
    )
    agreements_for(w, price, KEY)
    outcome = {}

    def issue():
        try:
            outcome["placed"] = place(w, price)
        finally:
            connection.close()

    waiter = threading.Thread(target=issue)
    waiter.start()
    try:
        # Wait, bounded, until the placement is blocked on the series lock.
        for _ in range(400):
            waiting = holder.execute(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
            ).fetchone()[0]
            if waiting:
                break
            threading.Event().wait(0.01)
        assert waiting, "the placement never waited for the series"
        released_at = holder.execute("SELECT clock_timestamp()").fetchone()[0]
        holder.execute("COMMIT")
        waiter.join(timeout=10)
    finally:
        holder.close()
    assert outcome["placed"].invoice.issued_at > released_at


# --- immutability -----------------------------------------------------------------------------

MUTABLE = {"state", "paid_at", "amount_paid_minor", "updated_at", "external_ref", "pdf_ref"}


def _changed_value(field, current):
    kind = field.get_internal_type()
    if kind in ("BigIntegerField", "IntegerField"):
        return current + 1
    if kind == "DateTimeField":
        return datetime(1999, 1, 1, tzinfo=UTC)
    if kind in ("UUIDField", "ForeignKey"):
        return uuid4()
    return "changed"


@pytest.mark.parametrize(
    "column",
    sorted(str(f.column) for f in Invoice._meta.concrete_fields if f.column not in MUTABLE),
)
def test_no_column_of_an_issued_invoice_changes_but_the_narrow_ones(column):
    w = world()
    invoice = place(w, offer()).invoice
    field = next(f for f in Invoice._meta.concrete_fields if f.column == column)
    with refused("billing_invoice_immutable"):
        raw(
            f"UPDATE billing_invoice SET {column} = %s WHERE id = %s",  # noqa: S608
            [_changed_value(field, getattr(invoice, field.attname) or 0), invoice.id],
        )


def test_an_invoice_is_created_as_a_draft_only():
    w = world()
    values = {
        "organisation_id": w.organisation.id,
        "vat_regime": "fr_standard",
        "issuer_legal_name": "x",
        "issuer_address": "x",
        "issuer_siren": "000000000",
        "issuer_vat_number": "FR00000000000",
        "customer_legal_name": "x",
        "customer_address_line1": "x",
        "customer_postal_code": "x",
        "customer_city": "x",
        "customer_country": "FR",
    }
    with refused("billing_invoice_transition"):
        with transaction.atomic():
            Invoice.objects.create(
                **values,
                state="paid",
                number="TST-2026-00002",
                issued_at=timezone.now(),
                due_at=timezone.now(),
                paid_at=timezone.now(),
            )
    Invoice.objects.create(**values)


def _draft(w, *, lines=1, total=None):
    draft = Invoice.objects.create(
        organisation_id=w.organisation.id,
        vat_regime="fr_standard",
        issuer_legal_name="x",
        issuer_address="x",
        issuer_siren="000000000",
        issuer_vat_number="FR00000000000",
        customer_legal_name="x",
        customer_address_line1="x",
        customer_postal_code="x",
        customer_city="x",
        customer_country="FR",
        total_excl_vat_minor=100 if total is None else total,
        vat_amount_minor=20,
        total_incl_vat_minor=(100 if total is None else total) + 20,
    )
    for position in range(1, lines + 1):
        InvoiceLine.objects.create(
            invoice=draft,
            position=position,
            description="line",
            plan_code="p",
            plan_version=1,
            pack_code="p",
            capacity_tier_code="M",
            quantity=1,
            unit_amount_minor=100 // lines,
            total_excl_vat_minor=100 // lines,
            vat_rate_bp=2000,
            vat_amount_minor=20 // lines,
        )
    return draft


@pytest.mark.parametrize(("lines", "total"), [(0, 100), (1, 99)])
def test_a_draft_is_issued_only_with_lines_that_add_up(lines, total):
    w = world()
    draft = _draft(w, lines=lines, total=total)
    with refused("billing_invoice_issue"):
        with transaction.atomic():
            services.issue_invoice(draft)


def test_a_draft_is_issued_only_with_a_series_number():
    w = world()
    draft = _draft(w)
    with refused("billing_invoice_issue"):
        raw(
            "UPDATE billing_invoice SET state = 'issued', number = 'anything', issued_at = now(),"
            " due_at = now() WHERE id = %s",
            [draft.id],
        )
    with transaction.atomic():
        services.issue_invoice(draft)
    assert Invoice.objects.get(id=draft.id).state == "issued"


def test_a_draft_is_editable_and_deletable():
    w = world()
    draft = _draft(w, lines=0, total=0)
    raw("UPDATE billing_invoice SET customer_legal_name = 'Edited' WHERE id = %s", [draft.id])
    with refused("billing_invoice_transition"):
        raw("UPDATE billing_invoice SET state = 'paid', paid_at = now() WHERE id = %s", [draft.id])
    raw("DELETE FROM billing_invoice WHERE id = %s", [draft.id])


def test_an_issued_invoice_is_never_deleted_and_its_lines_never_move():
    w = world()
    invoice = place(w, offer()).invoice
    draft = _draft(w, lines=0, total=0)
    with refused("billing_invoice_immutable"):
        raw("DELETE FROM billing_invoice WHERE id = %s", [invoice.id])
    with refused("billing_invoiceline_immutable"):
        raw("UPDATE billing_invoiceline SET quantity = 2 WHERE invoice_id = %s", [invoice.id])
    with refused("billing_invoiceline_immutable"):
        raw("DELETE FROM billing_invoiceline WHERE invoice_id = %s", [invoice.id])
    with refused("billing_invoiceline_immutable"):
        raw(
            "UPDATE billing_invoiceline SET invoice_id = %s WHERE invoice_id = %s",
            [draft.id, invoice.id],
        )
    with refused("billing_invoiceline_immutable"):
        InvoiceLine.objects.create(
            invoice=invoice,
            position=2,
            description="added",
            plan_code="p",
            plan_version=1,
            pack_code="p",
            capacity_tier_code="M",
            quantity=1,
            unit_amount_minor=0,
            total_excl_vat_minor=0,
            vat_rate_bp=0,
            vat_amount_minor=0,
        )


def test_references_are_set_once_and_the_narrow_columns_stay_writable():
    w = world()
    invoice = place(w, offer()).invoice
    raw(
        "UPDATE billing_invoice SET external_ref = 'ext-1', pdf_ref = 'pdf-1',"
        " amount_paid_minor = 10 WHERE id = %s",
        [invoice.id],
    )
    for column in ("external_ref", "pdf_ref"):
        with refused("billing_invoice_immutable"):
            raw(f"UPDATE billing_invoice SET {column} = 'other' WHERE id = %s", [invoice.id])  # noqa: S608


class _RollbackError(Exception):
    pass


def test_the_trigger_allows_exactly_the_invoice_transitions_of_the_state_table():
    """Every (from, to) pair from an issued state, set up past the trigger, then moved through it."""
    w = world()
    invoice = place(w, offer()).invoice
    accepted = {}
    for source, target in itertools.product(INVOICE_STATES, INVOICE_STATES):
        if source == "draft" or source == target:
            continue
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET LOCAL session_replication_role = replica")
                cursor.execute(
                    "UPDATE billing_invoice SET state = %s,"
                    " paid_at = CASE WHEN %s = 'paid' THEN now() END WHERE id = %s",
                    [source, source, invoice.id],
                )
                if target == "credited":
                    # Credited only by its credit note: one written first, past the guards.
                    cursor.execute(
                        "INSERT INTO billing_creditnote (id, created_at, updated_at,"
                        " organisation_id, invoice_id, number, issued_at, reason, currency,"
                        " vat_regime, issuer_legal_name, issuer_address, issuer_siren,"
                        " issuer_vat_number, customer_legal_name, customer_address_line1,"
                        " customer_postal_code, customer_city, customer_country,"
                        " total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor)"
                        " SELECT gen_random_uuid(), now(), now(), organisation_id, id,"
                        " 'AV-TST-2026-99999', now(), 'customer_cancellation', currency,"
                        " vat_regime, issuer_legal_name, issuer_address, issuer_siren,"
                        " issuer_vat_number, customer_legal_name, customer_address_line1,"
                        " customer_postal_code, customer_city, customer_country,"
                        " total_excl_vat_minor, vat_amount_minor, total_incl_vat_minor"
                        " FROM billing_invoice WHERE id = %s",
                        [invoice.id],
                    )
                cursor.execute("SET LOCAL session_replication_role = origin")
                cursor.execute(
                    "UPDATE billing_invoice SET state = %s,"
                    " paid_at = CASE WHEN %s = 'paid' THEN now() END WHERE id = %s",
                    [target, target, invoice.id],
                )
                accepted[(source, target)] = True
                raise _RollbackError()
        except _RollbackError:
            pass
        except IntegrityError as refusal:
            assert refusal.__cause__.diag.constraint_name == "billing_invoice_transition"
            accepted[(source, target)] = False
    assert accepted == {pair: pair[1] in INVOICE_TRANSITIONS[pair[0]] for pair in accepted}
    assert sum(accepted.values()) == 7


def test_an_issued_invoice_is_never_voided():
    """It leaves `issued` only by payment or by a credit note (BILLING_MODEL.md §4)."""
    w = world()
    invoice = place(w, offer()).invoice
    with pytest.raises(TransitionRefusedError):
        with transaction.atomic():
            locked = Invoice.objects.select_for_update().get(id=invoice.id)
            services.set_invoice_state(locked, "void", actor=services.Actor("staff", uuid4()))
    with refused("billing_invoice_transition"):
        raw("UPDATE billing_invoice SET state = 'void' WHERE id = %s", [invoice.id])
    # Nor credited without the credit note that credits it.
    with refused("billing_invoice_transition"):
        raw("UPDATE billing_invoice SET state = 'credited' WHERE id = %s", [invoice.id])


def test_paid_at_is_set_only_while_paid():
    w = world()
    invoice = place(w, offer()).invoice
    with refused("billing_invoice_paid_valid"):
        raw("UPDATE billing_invoice SET paid_at = now() WHERE id = %s", [invoice.id])


# --- the audit writer -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("action", "actor_type"),
    [("order.placed", "tenant"), ("invoice.issued", "tenant"), ("payment.received", "staff")],
)
def test_the_billing_audit_writer_refuses_rows_outside_the_taxonomy(action, actor_type):
    with pytest.raises(ValueError, match="not a billing audit row"):
        record_billing_event(
            action=action,
            actor_type=actor_type,
            actor_id=uuid4(),
            organisation_id=uuid4(),
            target_urn="urn:kodera:invoice:x",
            request_id=None,
            metadata={},
        )


def test_the_billing_audit_writer_refuses_a_system_row_naming_an_actor():
    with pytest.raises(ValueError, match="system row"):
        record_billing_event(
            action="invoice.issued",
            actor_type="system",
            actor_id=uuid4(),
            organisation_id=uuid4(),
            target_urn="urn:kodera:invoice:x",
            request_id=None,
            metadata={},
        )


# --- the catalogue file -----------------------------------------------------------------------


def test_the_placeholder_catalogue_loads_only_where_allowed_and_loads_once():
    document = catalogue.read(catalogue.PLACEHOLDER)
    with pytest.raises(catalogue.CatalogueError, match="placeholder"):
        catalogue.load(document, allow_placeholder=False)
    assert not Plan.objects.exists()
    first = catalogue.load(document, allow_placeholder=True)
    assert len(first.created) == 2 + 2 + 1 + 4 and not first.unchanged
    assert all("(placeholder)" in name for name in Plan.objects.values_list("name", flat=True))
    again = catalogue.load(document, allow_placeholder=True)
    assert not again.created and not again.changed and len(again.unchanged) == 9


def test_the_catalogue_refuses_to_edit_what_an_order_may_have_copied():
    document = catalogue.read(catalogue.PLACEHOLDER)
    catalogue.load(document, allow_placeholder=True)
    document["prices"][0]["amount_minor"] += 1
    with pytest.raises(catalogue.CatalogueError, match="amount_minor"):
        catalogue.load(document, allow_placeholder=True)
    assert not Price.objects.filter(amount_minor=10_001).exists()


def test_the_catalogue_closes_a_price_once_and_publishes_then_retires_a_plan():
    document = catalogue.read(catalogue.PLACEHOLDER)
    document["plans"][0].update(state="draft")
    del document["plans"][0]["published_at"]
    catalogue.load(document, allow_placeholder=True)
    document["plans"][0].update(state="published", published_at=datetime(2026, 1, 1, tzinfo=UTC))
    end = datetime(2027, 1, 1, tzinfo=UTC)
    document["prices"][0]["valid_to"] = end
    report = catalogue.load(document, allow_placeholder=True)
    assert len(report.changed) == 2
    assert Plan.objects.get().state == "published"
    assert Price.objects.filter(valid_to=end).count() == 1
    document["prices"][0]["valid_to"] = end + timedelta(days=1)
    with pytest.raises(catalogue.CatalogueError, match="valid_to"):
        catalogue.load(document, allow_placeholder=True)
    document["prices"][0]["valid_to"] = end
    document["plans"][0].update(state="retired", retired_at=end)
    catalogue.load(document, allow_placeholder=True)
    document["plans"][0].update(state="published")
    with pytest.raises(catalogue.CatalogueError, match="state"):
        catalogue.load(document, allow_placeholder=True)


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ({"offers": []}, "unknown sections"),
        ({"packs": [{"code": "x", "colour": "red"}]}, "unknown keys"),
        (
            {"packs": [{"code": "xx", "name": "X", "apps": ["mail"], "profile_ref": "x/1"}]},
            "applications",
        ),
        ({"placeholder": "yes"}, "true or false"),
        (
            {
                "plans": [
                    {
                        "code": "pp",
                        "version": 1,
                        "name": "P",
                        "state": "published",
                        "published_at": "2026-01-01",
                    }
                ]
            },
            "offset",
        ),
        ({"plans": [{"code": "pp", "version": 1, "name": "P", "state": "published"}]}, "rules"),
        ({"plans": [{"code": "pp", "version": 1, "name": "P", "state": "gone"}]}, "rules"),
    ],
)
def test_a_malformed_catalogue_is_refused(document, message):
    with pytest.raises(catalogue.CatalogueError, match=message):
        catalogue.load(document, allow_placeholder=True)


def test_a_price_for_another_period_than_monthly_or_yearly_is_refused():
    document = catalogue.read(catalogue.PLACEHOLDER)
    document["prices"][0]["billing_period"] = "weekly"
    with pytest.raises(catalogue.CatalogueError, match="rules"):
        catalogue.load(document, allow_placeholder=True)


def test_an_order_request_hash_covers_every_field():
    base = OrderRequest(
        pack_code="p",
        capacity_tier_code="M",
        billing_period="yearly",
        tenant=TenantRequest(slug="slug", name="name"),
        agreements=Agreements(dpa_id=uuid4(), documents=(CGV,)),
    )
    for field in dataclasses.fields(OrderRequest):
        changed = dataclasses.replace(base, **{field.name: _other(field.name)})
        assert changed.sha256() != base.sha256(), field.name


def _other(name):
    return {
        "quantity": 2,
        "tenant": TenantRequest(slug="other", name="other"),
        "agreements": Agreements(dpa_id=uuid4(), documents=()),
    }.get(name, "other")

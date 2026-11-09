"""Catalogue, order, subscription and invoice: docs/domain/BILLING_MODEL.md.

Amounts are integer minor units with a currency, never a float. A published plan and its prices
are never edited: a commercial change is a new plan version or a new price. An order and its
subscription copy the price they were placed at into their own columns, and an invoice line copies
it again, so an issued invoice renders with no join to the catalogue. An issued invoice and its
lines are frozen by the guard trigger of migrations/0002_invoice_guards.py.
"""

from django.db import models
from django.db.models import F, Q

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7
from core.db.models import StoredModel

from .states import INVOICE_STATES, ORDER_STATES, PAYMENT_STATES, SUBSCRIPTION_STATES

# The port's event kinds (apps/billing/payments/port.py), written out: models import no adapter.
EVENT_KINDS = (
    "payment.processing",
    "payment.succeeded",
    "payment.failed",
    "payment.reversed",
    "payment.reinstated",
)

CURRENCIES = ("EUR",)
BILLING_PERIODS = ("monthly", "yearly")
VAT_REGIMES = ("fr_standard", "eu_reverse_charge", "exempt", "outside_eu")
CAPACITY_TIER_CODES = ("S", "M", "L", "XL")
CODE = r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$"
MAX_QUANTITY = 10_000


def _in(field: str, values: tuple[str, ...]) -> Q:
    return Q(**{f"{field}__in": values})


class Plan(StoredModel):
    """The commercial envelope, keyed `(code, version)`."""

    class State(models.TextChoices):
        DRAFT = "draft"
        PUBLISHED = "published"
        RETIRED = "retired"

    code = models.TextField()
    version = models.IntegerField()
    name = models.TextField()
    description = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    state = models.TextField(choices=State.choices, default=State.DRAFT)
    support_tier = models.TextField(default="standard")
    price_change_notice_days = models.IntegerField(default=90)
    published_at = models.DateTimeField(null=True, blank=True)
    retired_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["code", "version"], name="billing_plan_version_unique"),
            models.CheckConstraint(name="billing_plan_code_valid", condition=Q(code__regex=CODE)),
            models.CheckConstraint(name="billing_plan_version_valid", condition=Q(version__gte=1)),
            models.CheckConstraint(
                name="billing_plan_state_valid",
                condition=_in("state", ("draft", "published", "retired")),
            ),
            models.CheckConstraint(
                name="billing_plan_support_tier_valid",
                condition=_in("support_tier", ("standard", "business", "critical")),
            ),
            models.CheckConstraint(
                name="billing_plan_notice_valid", condition=Q(price_change_notice_days__gte=0)
            ),
            models.CheckConstraint(
                name="billing_plan_published_at_valid",
                condition=Q(state="draft") | Q(published_at__isnull=False),
            ),
        ]


class Pack(StoredModel):
    """The applications provisioned on a tenant, and the tenant profile that renders them."""

    code = models.TextField(unique=True)
    name = models.TextField()
    description = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    apps = models.JSONField()
    profile_ref = models.TextField()
    available = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.CheckConstraint(name="billing_pack_code_valid", condition=Q(code__regex=CODE)),
        ]


class CapacityTier(StoredModel):
    """The VM shape and the included capacity."""

    code = models.TextField(unique=True)
    name = models.TextField()
    description = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    # A sizing guide ("designed for about N people"), never a cap: accounts are unlimited and the
    # concurrency the media server enforces is the ceiling. No code may refuse on it.
    seats_included = models.IntegerField()
    concurrent_participants_included = models.IntegerField()
    storage_included_bytes = models.BigIntegerField()
    vm_shape = models.TextField()
    media_ip_dedicated = models.BooleanField(default=True)
    available = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="billing_capacitytier_code_valid", condition=_in("code", CAPACITY_TIER_CODES)
            ),
            models.CheckConstraint(
                name="billing_capacitytier_included_valid",
                condition=Q(seats_included__gte=1)
                & Q(concurrent_participants_included__gte=1)
                & Q(storage_included_bytes__gte=0),
            ),
        ]


class Price(StoredModel):
    """What one `(plan version, pack, tier, period)` costs from `valid_from`."""

    plan = models.ForeignKey(Plan, on_delete=models.RESTRICT, related_name="prices")
    pack = models.ForeignKey(Pack, on_delete=models.RESTRICT, related_name="prices")
    capacity_tier = models.ForeignKey(
        CapacityTier, on_delete=models.RESTRICT, related_name="prices"
    )
    billing_period = models.TextField()
    amount_minor = models.BigIntegerField()
    setup_fee_minor = models.BigIntegerField(null=True, blank=True)
    currency = models.TextField(default="EUR")
    valid_from = models.DateTimeField()
    valid_to = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="billing_price_period_valid", condition=_in("billing_period", BILLING_PERIODS)
            ),
            models.CheckConstraint(
                name="billing_price_currency_valid", condition=_in("currency", CURRENCIES)
            ),
            models.CheckConstraint(
                name="billing_price_amounts_valid",
                condition=Q(amount_minor__gte=0)
                & (Q(setup_fee_minor__isnull=True) | Q(setup_fee_minor__gte=0)),
            ),
            models.CheckConstraint(
                name="billing_price_window_valid",
                condition=Q(valid_to__isnull=True) | Q(valid_to__gt=F("valid_from")),
            ),
            models.UniqueConstraint(
                fields=["plan", "pack", "capacity_tier", "billing_period", "valid_from"],
                name="billing_price_start_unique",
            ),
        ]


class PriceSnapshot(models.Model):
    """The price as it was at order time; written once, never recomputed from the catalogue."""

    price = models.ForeignKey(Price, on_delete=models.RESTRICT, related_name="+")
    plan_code = models.TextField()
    plan_version = models.IntegerField()
    pack_code = models.TextField()
    capacity_tier_code = models.TextField()
    apps = models.JSONField()
    billing_period = models.TextField()
    currency = models.TextField()
    unit_amount_minor = models.BigIntegerField()
    quantity = models.IntegerField(default=1)
    vat_regime = models.TextField()
    vat_rate_bp = models.IntegerField()
    total_excl_vat_minor = models.BigIntegerField()
    vat_amount_minor = models.BigIntegerField()
    total_incl_vat_minor = models.BigIntegerField()
    captured_at = models.DateTimeField()

    class Meta:
        abstract = True


def _snapshot_constraints(prefix: str) -> list[models.BaseConstraint]:
    return [
        models.CheckConstraint(
            name=f"{prefix}_period_valid", condition=_in("billing_period", BILLING_PERIODS)
        ),
        models.CheckConstraint(
            name=f"{prefix}_currency_valid", condition=_in("currency", CURRENCIES)
        ),
        models.CheckConstraint(
            name=f"{prefix}_vat_regime_valid", condition=_in("vat_regime", VAT_REGIMES)
        ),
        models.CheckConstraint(
            name=f"{prefix}_amounts_valid",
            condition=Q(quantity__range=(1, MAX_QUANTITY))
            & Q(unit_amount_minor__gte=0)
            & Q(vat_rate_bp__range=(0, 10_000))
            & Q(total_excl_vat_minor=F("unit_amount_minor") * F("quantity"))
            & Q(vat_amount_minor__gte=0)
            & Q(total_incl_vat_minor=F("total_excl_vat_minor") + F("vat_amount_minor")),
        ),
    ]


class BillingProfile(StoredModel):
    """The organisation as it is invoiced: legal identity, address and the VAT evidence.

    The VAT regime is derived from it at order time (apps/billing/vat.py) and copied onto the
    order, the subscription and the invoice; changing the profile changes no issued document.
    `vat_number_validated_at` is when the VAT number was checked as valid (VIES at launch); a
    reverse-charge order needs both the number and that date.
    """

    organisation = models.OneToOneField(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    legal_name = models.TextField()
    address_line1 = models.TextField()
    address_line2 = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    postal_code = models.TextField()
    city = models.TextField()
    country = models.TextField()
    siren = models.TextField(null=True, blank=True)  # noqa: DJ001 - French entities only
    vat_number = models.TextField(null=True, blank=True)  # noqa: DJ001 - not every customer has one
    vat_number_validated_at = models.DateTimeField(null=True, blank=True)
    vat_exempt = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="billing_profile_country_valid", condition=Q(country__regex=r"^[A-Z]{2}$")
            ),
            models.CheckConstraint(
                name="billing_profile_siren_valid",
                condition=Q(siren__isnull=True) | Q(siren__regex=r"^[0-9]{9}$"),
            ),
            models.CheckConstraint(
                name="billing_profile_validated_valid",
                condition=Q(vat_number_validated_at__isnull=True) | Q(vat_number__isnull=False),
            ),
            models.CheckConstraint(
                name="billing_profile_names_valid",
                condition=Q(legal_name__length__range=(1, 200))
                & Q(address_line1__length__range=(1, 200))
                & Q(postal_code__length__range=(1, 20))
                & Q(city__length__range=(1, 100)),
            ),
        ]

    def __str__(self) -> str:
        return f"billing profile of {self.organisation_id}"


class Order(StoredModel, PriceSnapshot):
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    idempotency_key = models.TextField()
    # SHA-256 of the order request as placed: the same key with another request is refused.
    request_sha256 = models.TextField()
    state = models.TextField(default="placed")
    placed_by = models.UUIDField()
    dpa = models.ForeignKey(
        "legal.Dpa", on_delete=models.RESTRICT, null=True, blank=True, related_name="+"
    )
    tenant = models.ForeignKey(
        "tenancy.Tenant", on_delete=models.RESTRICT, null=True, blank=True, related_name="+"
    )
    purchase_order_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    billing_contact_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional override
    billing_contact_name = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional override
    notes = models.TextField(null=True, blank=True)  # noqa: DJ001 - free text for the operator
    # The outbox delivery of the order confirmation (CGV 5.3), set once it is enqueued.
    confirmation_delivery_id = models.UUIDField(null=True, blank=True, unique=True)
    # The outbox delivery of the notice that a confirmed order was cancelled: its contract, formed
    # by the confirmation, is terminated (CGV). Set once it is enqueued.
    cancellation_notice_delivery_id = models.UUIDField(null=True, blank=True, unique=True)

    class Meta:
        constraints = [
            *_snapshot_constraints("billing_order"),
            models.CheckConstraint(
                name="billing_order_state_valid", condition=_in("state", ORDER_STATES)
            ),
            models.CheckConstraint(
                name="billing_order_idempotency_key_valid",
                condition=Q(idempotency_key__regex=r"^[!-~]{16,255}$"),
            ),
            models.CheckConstraint(
                name="billing_order_request_sha256_valid",
                condition=Q(request_sha256__regex=r"^[0-9a-f]{64}$"),
            ),
            models.UniqueConstraint(
                fields=["organisation", "idempotency_key"], name="billing_order_key_unique"
            ),
            # One order in flight (placed, not yet paid) per organisation: two placements at once
            # cannot both find none. A paid or cancelled order holds nothing.
            models.UniqueConstraint(
                fields=["organisation"],
                condition=Q(state__in=["placed", "awaiting_payment"]),
                name="billing_order_one_in_flight_per_organisation",
            ),
        ]
        indexes = [
            models.Index(
                fields=["organisation", "-created_at", "-id"], name="billing_order_org_idx"
            )
        ]

    def __str__(self) -> str:
        return f"order {self.id} {self.state}"


class Subscription(StoredModel, PriceSnapshot):
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    order = models.OneToOneField(Order, on_delete=models.RESTRICT, related_name="subscription")
    tenant = models.ForeignKey(
        "tenancy.Tenant", on_delete=models.RESTRICT, null=True, blank=True, related_name="+"
    )
    state = models.TextField(default="pending")
    current_period_start = models.DateTimeField()
    current_period_end = models.DateTimeField()
    cancel_at_period_end = models.BooleanField(default=False)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    price_change_notice_days = models.IntegerField()

    class Meta:
        constraints = [
            *_snapshot_constraints("billing_subscription"),
            models.CheckConstraint(
                name="billing_subscription_state_valid", condition=_in("state", SUBSCRIPTION_STATES)
            ),
            models.CheckConstraint(
                name="billing_subscription_period_window_valid",
                condition=Q(current_period_end__gt=F("current_period_start")),
            ),
            models.CheckConstraint(
                name="billing_subscription_cancelled_valid",
                condition=Q(state="cancelled", cancelled_at__isnull=False)
                | (~Q(state="cancelled") & Q(cancelled_at__isnull=True)),
            ),
        ]
        indexes = [
            models.Index(
                fields=["organisation", "-created_at", "-id"], name="billing_subscription_org_idx"
            )
        ]

    def __str__(self) -> str:
        return f"subscription {self.id} {self.state}"


class InvoiceNumberCounter(models.Model):
    """The last number allocated in one `(series, year)`. Incremented in the issuing transaction,
    under its row lock, so a rolled-back issue gives its number back: the series is gapless."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    series = models.TextField()
    year = models.IntegerField()
    last_number = models.IntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["series", "year"], name="billing_counter_unique"),
            models.CheckConstraint(name="billing_counter_valid", condition=Q(last_number__gte=1)),
        ]

    def __str__(self) -> str:
        return f"{self.series}-{self.year} at {self.last_number}"


class Invoice(StoredModel):
    """An invoice and the snapshot of both parties, taken at issue: docs/domain/BILLING_MODEL.md
    §§4, 8. Issued by Core, which allocates its number; the payment provider only collects."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    subscription = models.ForeignKey(
        Subscription, on_delete=models.RESTRICT, null=True, blank=True, related_name="invoices"
    )
    order = models.ForeignKey(
        Order, on_delete=models.RESTRICT, null=True, blank=True, related_name="invoices"
    )
    number = models.TextField(null=True, blank=True, unique=True)  # noqa: DJ001 - null while draft
    state = models.TextField(default="draft")
    currency = models.TextField(default="EUR")
    vat_regime = models.TextField()
    vat_mention = models.TextField(null=True, blank=True)  # noqa: DJ001 - no mention under fr_standard
    issuer_legal_name = models.TextField()
    issuer_address = models.TextField()
    issuer_siren = models.TextField()
    issuer_vat_number = models.TextField()
    customer_legal_name = models.TextField()
    customer_address_line1 = models.TextField()
    customer_address_line2 = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional line
    customer_postal_code = models.TextField()
    customer_city = models.TextField()
    customer_country = models.TextField()
    customer_siren = models.TextField(null=True, blank=True)  # noqa: DJ001 - French entities only
    customer_vat_number = models.TextField(null=True, blank=True)  # noqa: DJ001 - none for some
    total_excl_vat_minor = models.BigIntegerField(default=0)
    vat_amount_minor = models.BigIntegerField(default=0)
    total_incl_vat_minor = models.BigIntegerField(default=0)
    amount_paid_minor = models.BigIntegerField(default=0)
    issued_at = models.DateTimeField(null=True, blank=True)
    due_at = models.DateTimeField(null=True, blank=True)
    paid_at = models.DateTimeField(null=True, blank=True)
    external_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - set by a provider
    pdf_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - set once rendered

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="billing_invoice_state_valid", condition=_in("state", INVOICE_STATES)
            ),
            models.CheckConstraint(
                name="billing_invoice_currency_valid", condition=_in("currency", CURRENCIES)
            ),
            models.CheckConstraint(
                name="billing_invoice_vat_regime_valid", condition=_in("vat_regime", VAT_REGIMES)
            ),
            models.CheckConstraint(
                name="billing_invoice_numbered_valid",
                condition=Q(state="draft", number__isnull=True, issued_at__isnull=True)
                | (
                    ~Q(state="draft")
                    & Q(number__isnull=False, issued_at__isnull=False, due_at__isnull=False)
                ),
            ),
            models.CheckConstraint(
                name="billing_invoice_paid_valid",
                condition=Q(state="paid", paid_at__isnull=False)
                | (~Q(state="paid") & Q(paid_at__isnull=True)),
            ),
            models.CheckConstraint(
                name="billing_invoice_amounts_valid",
                condition=Q(total_excl_vat_minor__gte=0)
                & Q(vat_amount_minor__gte=0)
                & Q(total_incl_vat_minor=F("total_excl_vat_minor") + F("vat_amount_minor"))
                & Q(amount_paid_minor__gte=0),
            ),
            # `void` is for a document issued in error, before any money moved (§4).
            models.CheckConstraint(
                name="billing_invoice_void_unpaid",
                condition=~Q(state="void") | Q(amount_paid_minor=0),
            ),
            # A credit note credits an unpaid invoice in full: a credited invoice holds no money.
            models.CheckConstraint(
                name="billing_invoice_credited_unpaid",
                condition=~Q(state="credited") | Q(amount_paid_minor=0),
            ),
        ]
        indexes = [
            models.Index(
                fields=["organisation", "-issued_at", "-id"], name="billing_invoice_org_idx"
            )
        ]

    def __str__(self) -> str:
        return f"invoice {self.number or self.id} {self.state}"


class InvoiceLine(models.Model):
    """One billed line, with its own copy of the price snapshot and its own VAT."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    invoice = models.ForeignKey(Invoice, on_delete=models.RESTRICT, related_name="lines")
    position = models.IntegerField()
    description = models.TextField()
    plan_code = models.TextField()
    plan_version = models.IntegerField()
    pack_code = models.TextField()
    capacity_tier_code = models.TextField()
    quantity = models.IntegerField()
    unit_amount_minor = models.BigIntegerField()
    total_excl_vat_minor = models.BigIntegerField()
    vat_rate_bp = models.IntegerField()
    vat_amount_minor = models.BigIntegerField()
    period_start = models.DateTimeField(null=True, blank=True)
    period_end = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["invoice", "position"], name="billing_line_position_unique"
            ),
            models.CheckConstraint(
                name="billing_line_amounts_valid",
                condition=Q(quantity__range=(1, MAX_QUANTITY))
                & Q(unit_amount_minor__gte=0)
                & Q(total_excl_vat_minor=F("unit_amount_minor") * F("quantity"))
                & Q(vat_rate_bp__range=(0, 10_000))
                & Q(vat_amount_minor__gte=0),
            ),
        ]

    def __str__(self) -> str:
        return f"line {self.position} of invoice {self.invoice_id}"


# Why an invoice is credited: its order cancelled by the customer, lapsed unpaid past its due
# date (BILLING_MODEL.md §4.1), or settled as complimentary by a staff operator (§4.2). Three
# bases, so three codes.
CREDIT_NOTE_REASONS = ("customer_cancellation", "unpaid_lapse", "complimentary")
CREDIT_NOTE_NUMBER = r"^AV-[A-Z]{2,8}(-[A-Z]{2,8})?-[0-9]{4}-[0-9]{5}$"


class CreditNote(StoredModel):
    """The only correction of an issued invoice (docs/domain/BILLING_MODEL.md §4): numbered from a
    series of its own (`AV-<series>`), dated, with the invoice's VAT treatment and both parties'
    snapshot copied from it, and never changed or deleted. For now a credit note credits its
    invoice in full, once: the invoice is then `credited`."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    invoice = models.ForeignKey(Invoice, on_delete=models.RESTRICT, related_name="credit_notes")
    number = models.TextField(unique=True)
    issued_at = models.DateTimeField()
    reason = models.TextField()
    currency = models.TextField()
    vat_regime = models.TextField()
    vat_mention = models.TextField(null=True, blank=True)  # noqa: DJ001 - as on the invoice
    issuer_legal_name = models.TextField()
    issuer_address = models.TextField()
    issuer_siren = models.TextField()
    issuer_vat_number = models.TextField()
    customer_legal_name = models.TextField()
    customer_address_line1 = models.TextField()
    customer_address_line2 = models.TextField(null=True, blank=True)  # noqa: DJ001 - as on the invoice
    customer_postal_code = models.TextField()
    customer_city = models.TextField()
    customer_country = models.TextField()
    customer_siren = models.TextField(null=True, blank=True)  # noqa: DJ001 - as on the invoice
    customer_vat_number = models.TextField(null=True, blank=True)  # noqa: DJ001 - as on the invoice
    total_excl_vat_minor = models.BigIntegerField()
    vat_amount_minor = models.BigIntegerField()
    total_incl_vat_minor = models.BigIntegerField()
    # Set once, like an invoice's: the rendered document and the e-invoicing platform's identifier.
    pdf_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - set once rendered
    external_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - set by a platform
    # The outbox delivery of the notice that delivers it to the customer; enqueued again if it fails.
    notice_delivery_id = models.UUIDField(null=True, blank=True, unique=True)

    class Meta:
        constraints = [
            # A full credit, once: the sum of an invoice's credit notes never exceeds its total.
            models.UniqueConstraint(fields=["invoice"], name="billing_creditnote_one_per_invoice"),
            models.CheckConstraint(
                name="billing_creditnote_number_valid",
                condition=Q(number__regex=CREDIT_NOTE_NUMBER),
            ),
            models.CheckConstraint(
                name="billing_creditnote_reason_valid", condition=_in("reason", CREDIT_NOTE_REASONS)
            ),
            models.CheckConstraint(
                name="billing_creditnote_currency_valid", condition=_in("currency", CURRENCIES)
            ),
            models.CheckConstraint(
                name="billing_creditnote_vat_regime_valid",
                condition=_in("vat_regime", VAT_REGIMES),
            ),
            models.CheckConstraint(
                name="billing_creditnote_amounts_valid",
                condition=Q(total_excl_vat_minor__gte=0)
                & Q(vat_amount_minor__gte=0)
                & Q(total_incl_vat_minor=F("total_excl_vat_minor") + F("vat_amount_minor")),
            ),
        ]
        indexes = [
            models.Index(
                fields=["organisation", "-issued_at", "-id"], name="billing_creditnote_org_idx"
            )
        ]

    def __str__(self) -> str:
        return f"credit note {self.number} of invoice {self.invoice_id}"


class CreditNoteLine(models.Model):
    """One credited line: a copy of the invoice line it credits, with its own VAT."""

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    credit_note = models.ForeignKey(CreditNote, on_delete=models.RESTRICT, related_name="lines")
    invoice_line = models.ForeignKey(InvoiceLine, on_delete=models.RESTRICT, related_name="+")
    position = models.IntegerField()
    description = models.TextField()
    quantity = models.IntegerField()
    unit_amount_minor = models.BigIntegerField()
    total_excl_vat_minor = models.BigIntegerField()
    vat_rate_bp = models.IntegerField()
    vat_amount_minor = models.BigIntegerField()
    period_start = models.DateTimeField(null=True, blank=True)
    period_end = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["credit_note", "position"], name="billing_creditnoteline_position_unique"
            ),
            models.CheckConstraint(
                name="billing_creditnoteline_amounts_valid",
                condition=Q(quantity__range=(1, MAX_QUANTITY))
                & Q(unit_amount_minor__gte=0)
                & Q(total_excl_vat_minor=F("unit_amount_minor") * F("quantity"))
                & Q(vat_rate_bp__range=(0, 10_000))
                & Q(vat_amount_minor__gte=0),
            ),
        ]

    def __str__(self) -> str:
        return f"line {self.position} of credit note {self.credit_note_id}"


class PaymentLink(StoredModel):
    """A one-invoice payment link at the payment provider; Core stores the reference, never an
    instrument (docs/domain/BILLING_MODEL.md §8)."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    invoice = models.ForeignKey(Invoice, on_delete=models.RESTRICT, related_name="payment_links")
    provider = models.TextField()
    provider_ref = models.TextField()
    url = models.TextField()
    state = models.TextField(default="active")
    amount_minor = models.BigIntegerField()
    currency = models.TextField()
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "provider_ref"], name="billing_paymentlink_ref_unique"
            ),
            models.UniqueConstraint(
                fields=["invoice"],
                condition=Q(state="active"),
                name="billing_paymentlink_one_active",
            ),
            models.CheckConstraint(
                name="billing_paymentlink_state_valid",
                condition=_in("state", ("active", "used", "expired", "cancelled")),
            ),
            models.CheckConstraint(
                name="billing_paymentlink_amount_valid", condition=Q(amount_minor__gt=0)
            ),
        ]

    def __str__(self) -> str:
        return f"payment link {self.provider}:{self.provider_ref} {self.state}"


class Payment(StoredModel):
    """One payment at the provider, as reconciled from its events."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    invoice = models.ForeignKey(Invoice, on_delete=models.RESTRICT, related_name="payments")
    payment_link = models.ForeignKey(
        PaymentLink, on_delete=models.RESTRICT, null=True, blank=True, related_name="payments"
    )
    provider = models.TextField()
    provider_ref = models.TextField()
    state = models.TextField(default="pending")
    amount_minor = models.BigIntegerField()
    currency = models.TextField()
    last_event_at = models.DateTimeField(null=True, blank=True)
    # The provider's customer the payment came from, kept for recurring collection.
    provider_customer_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - not every event names one
    # Whether its amount counts in its invoice's `amount_paid_minor`. Money received for an
    # invoice that no longer owes (void) stays here, unallocated, for a person to allocate.
    allocated = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "provider_ref"], name="billing_payment_ref_unique"
            ),
            models.CheckConstraint(
                name="billing_payment_state_valid", condition=_in("state", PAYMENT_STATES)
            ),
            models.CheckConstraint(
                name="billing_payment_amount_valid", condition=Q(amount_minor__gt=0)
            ),
        ]

    def __str__(self) -> str:
        return f"payment {self.provider}:{self.provider_ref} {self.state}"


class ProviderEvent(models.Model):
    """Every event a provider delivered, once, with what reconciliation did with it.

    Only the parsed facts are kept, never the raw body: it may carry the payer's details.
    """

    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    provider = models.TextField()
    event_id = models.TextField()
    kind = models.TextField()
    payment_ref = models.TextField()
    link_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - not every event names a link
    customer_ref = models.TextField(null=True, blank=True)  # noqa: DJ001 - not every event names one
    amount_minor = models.BigIntegerField()
    currency = models.TextField()
    occurred_at = models.DateTimeField()
    received_at = models.DateTimeField(db_default=ClockTimestamp())
    outcome = models.TextField(default="received")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "event_id"], name="billing_providerevent_unique"
            ),
            models.CheckConstraint(
                name="billing_providerevent_kind_valid",
                condition=_in("kind", EVENT_KINDS),
            ),
            models.CheckConstraint(
                name="billing_providerevent_outcome_valid",
                condition=_in(
                    "outcome",
                    (
                        "received",
                        "applied",
                        "stale",
                        "deferred",
                        "unmatched",
                        "mismatch",
                        "ignored",
                    ),
                ),
            ),
        ]
        indexes = [
            models.Index(
                fields=["provider", "payment_ref", "occurred_at"],
                name="billing_providerevent_pay_idx",
            )
        ]

    def __str__(self) -> str:
        return f"{self.provider} event {self.event_id} {self.kind} {self.outcome}"

"""Volet B — Paid VIP servers and channels via Stripe Connect destination splits.

Strictly separated from Samouraï Coop B2B subscriptions and Volet A direct workspace boosts:
- Creators onboard Express Stripe Connect accounts under durable operation state (`intent_recorded`
  -> external create outside `transaction.atomic()` -> persist `acct_...` BEFORE generating
  resumable onboarding links, never retrying blindly on unknown outcomes or restricted capabilities).
- Tax residence and TIN are sealed at rest with AES-256-GCM (`core.sealing`) for annual DAC7
  reporting (`apps/billing/dac7.py`).
- Every sale, refund, and chargeback writes an append-only integer `CreatorSplitLedgerEntry`,
  enforces canonical lock ordering (`lock_workspace_for_vip` -> `CreatorConnectAccount` ->
  `VipMembershipEntitlement`), and atomically converges `WorkspaceMemberRole`, `authority_revision`,
  `member_set`, and `channel_set` via `apps.workspaces.vip_entitlements`.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from apps.workspaces.vip_entitlements import (
    VipConvergenceOutcome,
    VipConvergencePorts,
    configure_vip_channel_gate,
    lock_workspace_for_vip,
    reconcile_vip_role_with_ports,
    sync_vip_member_entitlement,
)
from core.sealing import SealError, seal, unseal

from . import events
from .actors import Actor
from .boosts import (
    WithdrawalWaiverRequiredError,
    resolve_server_b2b_vat_status,
    split_gross_refund,
    verify_b2c_withdrawal_waiver,
)
from .models import (
    CreatorConnectAccount,
    CreatorSplitLedgerEntry,
    VipMembershipEntitlement,
    VipTierOffer,
)
from .money import line_amounts
from .payments.port import (
    CONNECT_ACCOUNT_ID,
    ConnectAccountSnapshot,
    ConnectOnboardingLink,
    LinkRequest,
    ProviderLink,
    ProviderUnavailableError,
)
from .payments.services import check_return_url
from .services import IDEMPOTENCY_KEY, IdempotencyKeyReuseError, period_end
from .vat import Regime, regime_for

DEFAULT_STRIPE_DISPUTE_FEE_MINOR = 1500
DEFAULT_STRIPE_PLATFORM_ACCOUNT_ID = "acct_1QhZ8fRwfVmWKPLR"


class VipConnectValidationError(ValueError):
    """Invalid VIP tier, split fee, metadata binding, or Connect parameter."""


class ConnectOutcomeUnknownError(RuntimeError):
    """Prior Connect account creation had an unknown outcome; operator reconciliation required."""


class ConnectAccountNotReadyError(PermissionError):
    """Connect account is not `active` with `charges_enabled=True` (`restricted` / incomplete)."""


class ConnectProviderPort(Protocol):
    def create_connect_account(
        self,
        *,
        idempotency_key: str,
        country: str,
        seller_legal_name: str,
        workspace_id: str,
    ) -> ConnectAccountSnapshot: ...

    def retrieve_connect_account(self, account_id: str) -> ConnectAccountSnapshot: ...

    def create_connect_onboarding_link(
        self,
        *,
        account_id: str,
        refresh_url: str,
        return_url: str,
    ) -> ConnectOnboardingLink: ...

    def create_link(self, request: LinkRequest) -> ProviderLink: ...


def _platform_account_id() -> str:
    configured = getattr(
        settings, "KODERA_STRIPE_PLATFORM_ACCOUNT_ID", DEFAULT_STRIPE_PLATFORM_ACCOUNT_ID
    )
    if not isinstance(configured, str) or not CONNECT_ACCOUNT_ID.fullmatch(configured):
        return DEFAULT_STRIPE_PLATFORM_ACCOUNT_ID
    return configured


def _tin_aad(organisation_id: UUID, workspace_id: UUID, country: str) -> bytes:
    return (
        f"kodera.billing.dac7.tin.v1:{organisation_id}:{workspace_id}:{country.upper()}"
    ).encode()


def seal_tax_tin(
    *,
    raw_tin: str,
    organisation_id: UUID,
    workspace_id: UUID,
    country: str,
    seal_key: bytes | None = None,
) -> bytes:
    cleaned = raw_tin.strip()
    if not 4 <= len(cleaned) <= 64:
        raise VipConnectValidationError("tax TIN must be between 4 and 64 characters")
    key = seal_key if seal_key is not None else settings.KODERA_CONTACT_SEAL_KEY
    if key is None:
        raise SealError("tax TIN sealing key is not configured")
    return seal(key, _tin_aad(organisation_id, workspace_id, country), cleaned.encode("utf-8"))


def unseal_tax_tin(
    *,
    sealed_tin: bytes,
    organisation_id: UUID,
    workspace_id: UUID,
    country: str,
    seal_key: bytes | None = None,
) -> str:
    key = seal_key if seal_key is not None else settings.KODERA_CONTACT_SEAL_KEY
    if key is None:
        raise SealError("tax TIN sealing key is not configured")
    return unseal(key, _tin_aad(organisation_id, workspace_id, country), bytes(sealed_tin)).decode(
        "utf-8"
    )


@dataclass(frozen=True, slots=True)
class VipCheckoutQuote:
    tier_code: str
    billing_period: str
    customer_kind: str
    buyer_country: str
    vat_regime: Regime
    gross_excl_vat_minor: int
    vat_amount_minor: int
    total_incl_vat_minor: int
    platform_fee_bps: int
    application_fee_amount_minor: int
    stripe_application_fee_minor: int
    creator_net_minor: int


def quote_vip_pass(
    *,
    tier_code: str,
    billing_period: str,
    price_excl_vat_minor: int,
    platform_fee_bps: int,
    buyer_country: str,
    customer_kind: str = "b2c",
    vat_number_validated: bool = False,
    vat_exempt: bool = False,
) -> VipCheckoutQuote:
    """Quote a VIP pass with 27-state EU OSS VAT and strict integer Connect split."""
    if price_excl_vat_minor <= 0:
        raise VipConnectValidationError("price_excl_vat_minor must be positive")
    if isinstance(platform_fee_bps, bool) or not 0 <= platform_fee_bps < 10_000:
        raise VipConnectValidationError("platform_fee_bps must satisfy 0 <= bps < 10000")
    if billing_period not in {"monthly", "yearly", "one_time"}:
        raise VipConnectValidationError(f"unsupported billing_period {billing_period!r}")
    if customer_kind not in {"b2c", "b2b"}:
        raise VipConnectValidationError(f"unsupported customer_kind {customer_kind!r}")

    country = buyer_country.strip().upper()
    vat = regime_for(
        country=country,
        vat_number_validated=vat_number_validated,
        exempt=vat_exempt,
        b2c=(customer_kind == "b2c"),
    )
    amounts = line_amounts(
        unit_amount_minor=price_excl_vat_minor,
        quantity=1,
        vat_rate_bp=vat.rate_bp,
    )
    app_fee = (amounts.net_minor * platform_fee_bps) // 10_000
    stripe_fee = app_fee + amounts.vat_minor
    if not 0 <= stripe_fee < amounts.gross_minor:
        raise VipConnectValidationError("computed Stripe Connect fee violates 0 <= fee < total")
    creator_net = amounts.net_minor - app_fee
    return VipCheckoutQuote(
        tier_code=tier_code,
        billing_period=billing_period,
        customer_kind=customer_kind,
        buyer_country=country,
        vat_regime=vat,
        gross_excl_vat_minor=amounts.net_minor,
        vat_amount_minor=amounts.vat_minor,
        total_incl_vat_minor=amounts.gross_minor,
        platform_fee_bps=platform_fee_bps,
        application_fee_amount_minor=app_fee,
        stripe_application_fee_minor=stripe_fee,
        creator_net_minor=creator_net,
    )


def compute_recoverable_negative_balance_minor(
    *,
    quote: VipCheckoutQuote,
    unreserved_negative_balance_minor: int,
) -> int:
    """Bound source-withheld negative-balance recovery so Stripe's `application_fee_amount` stays
    strictly `< total_incl_vat_minor` and never exceeds `quote.creator_net_minor`."""
    if unreserved_negative_balance_minor <= 0:
        return 0
    max_stripe_extra = max(0, quote.total_incl_vat_minor - 1 - quote.stripe_application_fee_minor)
    return min(
        unreserved_negative_balance_minor,
        max(0, quote.creator_net_minor),
        max_stripe_extra,
    )


@dataclass(frozen=True, slots=True)
class SplitComputation:
    entry_kind: str
    gross_excl_vat_minor: int
    vat_amount_minor: int
    total_incl_vat_minor: int
    application_fee_amount_minor: int
    dispute_fee_minor: int
    creator_net_minor: int
    negative_balance_delta_minor: int
    new_negative_balance_minor: int


def compute_sale_ledger_entry(
    *,
    quote: VipCheckoutQuote,
    current_negative_balance_minor: int = 0,
) -> SplitComputation:
    """Compute append-only ledger entry for a settled VIP sale and recover bounded negative balance."""
    if current_negative_balance_minor < 0:
        raise VipConnectValidationError("negative_balance_minor must be >= 0")
    recovered = compute_recoverable_negative_balance_minor(
        quote=quote,
        unreserved_negative_balance_minor=current_negative_balance_minor,
    )
    neg_delta = -recovered
    return SplitComputation(
        entry_kind="sale",
        gross_excl_vat_minor=quote.gross_excl_vat_minor,
        vat_amount_minor=quote.vat_amount_minor,
        total_incl_vat_minor=quote.total_incl_vat_minor,
        application_fee_amount_minor=quote.application_fee_amount_minor,
        dispute_fee_minor=0,
        creator_net_minor=quote.creator_net_minor,
        negative_balance_delta_minor=neg_delta,
        new_negative_balance_minor=current_negative_balance_minor + neg_delta,
    )


def compute_refund_ledger_entry(
    *,
    original_excl_vat_minor: int,
    original_vat_minor: int,
    original_total_incl_vat_minor: int,
    original_application_fee_minor: int,
    previously_refunded_incl_vat_minor: int,
    previously_refunded_excl_vat_minor: int,
    previously_refunded_fee_minor: int,
    refund_incl_vat_minor: int,
    available_creator_balance_minor: int = 0,
    current_negative_balance_minor: int = 0,
    vat_rate_bp: int | None = None,
) -> SplitComputation:
    """Compute signed negative ledger entry for a partial or full VIP refund."""
    delta_excl, delta_vat = split_gross_refund(
        original_net_minor=original_excl_vat_minor,
        original_vat_minor=original_vat_minor,
        original_gross_minor=original_total_incl_vat_minor,
        previously_refunded_gross_minor=previously_refunded_incl_vat_minor,
        previously_refunded_net_minor=previously_refunded_excl_vat_minor,
        refund_gross_minor=refund_incl_vat_minor,
        vat_rate_bp=vat_rate_bp,
    )
    cum_incl = previously_refunded_incl_vat_minor + refund_incl_vat_minor
    if cum_incl == original_total_incl_vat_minor:
        cum_fee = original_application_fee_minor
    else:
        cum_fee = (
            cum_incl * original_application_fee_minor + original_total_incl_vat_minor // 2
        ) // original_total_incl_vat_minor
        cum_fee = min(original_application_fee_minor, max(previously_refunded_fee_minor, cum_fee))
    delta_fee = cum_fee - previously_refunded_fee_minor

    gross_excl_signed = -delta_excl
    vat_signed = -delta_vat
    total_signed = gross_excl_signed + vat_signed
    fee_signed = -delta_fee
    creator_net_signed = gross_excl_signed - fee_signed

    creator_debit = abs(creator_net_signed)
    covered = min(max(0, available_creator_balance_minor), creator_debit)
    shortfall = creator_debit - covered
    return SplitComputation(
        entry_kind="refund",
        gross_excl_vat_minor=gross_excl_signed,
        vat_amount_minor=vat_signed,
        total_incl_vat_minor=total_signed,
        application_fee_amount_minor=fee_signed,
        dispute_fee_minor=0,
        creator_net_minor=creator_net_signed,
        negative_balance_delta_minor=shortfall,
        new_negative_balance_minor=current_negative_balance_minor + shortfall,
    )


def compute_chargeback_ledger_entry(
    *,
    remaining_excl_vat_minor: int,
    remaining_vat_minor: int,
    remaining_application_fee_minor: int,
    dispute_fee_minor: int = DEFAULT_STRIPE_DISPUTE_FEE_MINOR,
    available_creator_balance_minor: int = 0,
    current_negative_balance_minor: int = 0,
) -> SplitComputation:
    """Compute signed negative ledger entry and creator negative-balance impact on a chargeback.

    Supports `remaining_excl_vat_minor == 0` when an already-refunded pass incurs a dispute fee,
    without fabricating 1 cent of phantom consideration.
    """
    if (
        remaining_excl_vat_minor < 0
        or remaining_vat_minor < 0
        or remaining_application_fee_minor < 0
        or dispute_fee_minor < 0
    ):
        raise VipConnectValidationError("invalid remaining entitlement amounts for chargeback")
    if remaining_excl_vat_minor == 0 and remaining_vat_minor == 0 and dispute_fee_minor == 0:
        raise VipConnectValidationError("zero-impact chargeback entry is invalid")
    gross_excl_signed = -remaining_excl_vat_minor
    vat_signed = -remaining_vat_minor
    total_signed = gross_excl_signed + vat_signed
    fee_signed = -remaining_application_fee_minor
    creator_net_signed = gross_excl_signed - fee_signed - dispute_fee_minor

    creator_debit = abs(creator_net_signed)
    covered = min(max(0, available_creator_balance_minor), creator_debit)
    shortfall = creator_debit - covered
    return SplitComputation(
        entry_kind="chargeback",
        gross_excl_vat_minor=gross_excl_signed,
        vat_amount_minor=vat_signed,
        total_incl_vat_minor=total_signed,
        application_fee_amount_minor=fee_signed,
        dispute_fee_minor=dispute_fee_minor,
        creator_net_minor=creator_net_signed,
        negative_balance_delta_minor=shortfall,
        new_negative_balance_minor=current_negative_balance_minor + shortfall,
    )


def derive_connect_onboarding_state(snapshot: ConnectAccountSnapshot) -> str:
    """Map Stripe Connect account capabilities to Core's durable onboarding state."""
    if snapshot.restricted_reason and snapshot.restricted_reason.startswith("rejected."):
        return "disabled"
    if (
        snapshot.charges_enabled
        and snapshot.payouts_enabled
        and snapshot.details_submitted
        and not snapshot.restricted_reason
    ):
        return "active"
    if not snapshot.details_submitted and snapshot.restricted_reason in (
        None,
        "requirements.past_due",
    ):
        return "account_created"
    if snapshot.restricted_reason or not snapshot.charges_enabled or not snapshot.payouts_enabled:
        return "restricted"
    return "account_created"


@dataclass(slots=True)
class DurableConnectOnboardingRecord:
    """In-memory / port-driven mirror of `CreatorConnectAccount` for pure state-machine tests."""

    organisation_id: UUID
    workspace_id: UUID
    operation_idempotency_key: str
    seller_legal_name: str
    tax_residence_country: str
    onboarding_state: str = "intent_recorded"
    stripe_connect_account_id: str | None = None
    charges_enabled: bool = False
    payouts_enabled: bool = False
    details_submitted: bool = False
    last_operation_error: str | None = None
    persisted_checkpoints: list[tuple[str, str | None]] | None = None

    def checkpoint(self) -> None:
        if self.persisted_checkpoints is None:
            self.persisted_checkpoints = []
        self.persisted_checkpoints.append((self.onboarding_state, self.stripe_connect_account_id))


def step_connect_onboarding(
    record: DurableConnectOnboardingRecord,
    *,
    provider: ConnectProviderPort,
    refresh_url: str,
    return_url: str,
) -> ConnectOnboardingLink:
    """Execute durable Connect onboarding (`POLICY.md` Rule 6)."""
    if record.onboarding_state == "outcome_unknown":
        raise ConnectOutcomeUnknownError(
            "Connect account creation outcome is unknown; reconcile before retrying"
        )
    if record.onboarding_state == "disabled":
        raise ConnectAccountNotReadyError("Connect account is disabled")

    if record.stripe_connect_account_id is None:
        record.checkpoint()
        try:
            created = provider.create_connect_account(
                idempotency_key=record.operation_idempotency_key,
                country=record.tax_residence_country,
                seller_legal_name=record.seller_legal_name,
                workspace_id=str(record.workspace_id),
            )
        except ProviderUnavailableError as exc:
            record.onboarding_state = "outcome_unknown"
            record.last_operation_error = "create_account_outcome_unknown"
            record.checkpoint()
            raise ConnectOutcomeUnknownError(
                "Connect account creation failed with unknown outcome"
            ) from exc

        record.stripe_connect_account_id = created.account_id
        record.charges_enabled = created.charges_enabled
        record.payouts_enabled = created.payouts_enabled
        record.details_submitted = created.details_submitted
        record.onboarding_state = derive_connect_onboarding_state(created)
        record.last_operation_error = (
            created.restricted_reason if record.onboarding_state == "restricted" else None
        )
        # Mandatory durable checkpoint BEFORE issuing resumable onboarding link!
        record.checkpoint()

    link = provider.create_connect_onboarding_link(
        account_id=record.stripe_connect_account_id,
        refresh_url=refresh_url,
        return_url=return_url,
    )
    if record.onboarding_state in {"intent_recorded", "account_created"}:
        record.onboarding_state = "onboarding_link_issued"
        record.checkpoint()
    return link


@dataclass(frozen=True, slots=True)
class VipEntitlementGrantWindow:
    entitlement_id: UUID
    membership_id: UUID
    role_id: UUID
    state: str
    expires_at: datetime | None


def should_member_hold_vip_role(
    entitlements: Sequence[VipEntitlementGrantWindow],
    *,
    membership_id: UUID,
    role_id: UUID,
    now: datetime,
) -> bool:
    """Return True if at least one non-expired `active` VIP entitlement grants `role_id`."""
    return any(
        e.membership_id == membership_id
        and e.role_id == role_id
        and e.state == "active"
        and (e.expires_at is None or e.expires_at > now)
        for e in entitlements
    )


def converge_vip_entitlement_windows(
    entitlements: Sequence[VipEntitlementGrantWindow],
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_id: UUID,
    role_id: UUID,
    reason: str,
    now: datetime,
    ports: VipConvergencePorts,
) -> VipConvergenceOutcome:
    """Reconcile overlapping VIP passes and atomically converge Matrix + LiveKit access."""
    should_hold = should_member_hold_vip_role(
        entitlements,
        membership_id=membership_id,
        role_id=role_id,
        now=now,
    )
    return reconcile_vip_role_with_ports(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        membership_id=membership_id,
        role_id=role_id,
        should_hold_role=should_hold,
        reason=reason,
        ports=ports,
    )


# --- Transactional Django ORM Services -----------------------------------------------------------


def _vip_request_sha256(
    *,
    workspace_id: UUID,
    tier_id: UUID,
    membership_id: UUID,
    buyer_user_id: UUID,
    customer_kind: str,
    buyer_country: str,
    return_url: str,
    locale: str,
    withdrawal_waiver_accepted: bool,
) -> str:
    canonical = json.dumps(
        {
            "workspace_id": str(workspace_id),
            "tier_id": str(tier_id),
            "membership_id": str(membership_id),
            "buyer_user_id": str(buyer_user_id),
            "customer_kind": customer_kind,
            "buyer_country": buyer_country.upper(),
            "return_url": return_url,
            "locale": locale,
            "withdrawal_waiver_accepted": withdrawal_waiver_accepted,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def initiate_or_resume_connect_onboarding(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    owner_user_id: UUID,
    seller_legal_name: str,
    tax_residence_country: str,
    raw_tax_tin: str | None,
    operation_idempotency_key: str,
    refresh_url: str,
    return_url: str,
    provider: ConnectProviderPort,
    platform_fee_bps: int = 1000,
) -> tuple[CreatorConnectAccount, ConnectOnboardingLink]:
    """Persist Connect onboarding intent, create/checkpoint `acct_...` outside `transaction.atomic()`
    before issuing a resumable onboarding link, and seal DAC7 tax TIN at rest."""
    if connection.in_atomic_block:
        raise RuntimeError(
            "initiate_or_resume_connect_onboarding must execute outside transaction.atomic()"
        )
    if (
        not isinstance(operation_idempotency_key, str)
        or IDEMPOTENCY_KEY.fullmatch(operation_idempotency_key) is None
    ):
        raise VipConnectValidationError("invalid operation_idempotency_key")
    check_return_url(refresh_url)
    check_return_url(return_url)

    country = tax_residence_country.strip().upper()
    legal_name = seller_legal_name.strip()
    if not legal_name:
        raise VipConnectValidationError("seller_legal_name is required")
    sealed_tin = (
        seal_tax_tin(
            raw_tin=raw_tax_tin,
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            country=country,
        )
        if raw_tax_tin
        else None
    )

    with transaction.atomic():
        locked_ws = lock_workspace_for_vip(organisation_id)
        if locked_ws is None or locked_ws != workspace_id:
            raise VipConnectValidationError("workspace does not belong to organisation")
        account, created = CreatorConnectAccount.objects.select_for_update().get_or_create(
            workspace_id=workspace_id,
            defaults={
                "organisation_id": organisation_id,
                "owner_user_id": owner_user_id,
                "stripe_platform_account_id": _platform_account_id(),
                "onboarding_state": "intent_recorded",
                "operation_idempotency_key": operation_idempotency_key,
                "platform_fee_bps": platform_fee_bps,
                "seller_legal_name": legal_name,
                "tax_residence_country": country,
                "sealed_tax_tin": sealed_tin,
            },
        )
        if not created and sealed_tin is not None:
            account.sealed_tax_tin = sealed_tin
            account.save(update_fields=["sealed_tax_tin", "updated_at"])

        if account.onboarding_state == "outcome_unknown":
            raise ConnectOutcomeUnknownError(
                "Connect account creation outcome is unknown; reconcile before retrying"
            )
        if account.onboarding_state == "disabled":
            raise ConnectAccountNotReadyError("Connect account is disabled")

    if account.stripe_connect_account_id is None:
        try:
            snap = provider.create_connect_account(
                idempotency_key=account.operation_idempotency_key,
                country=account.tax_residence_country,
                seller_legal_name=account.seller_legal_name,
                workspace_id=str(workspace_id),
            )
        except ProviderUnavailableError as exc:
            with transaction.atomic():
                lock_workspace_for_vip(organisation_id)
                locked = CreatorConnectAccount.objects.select_for_update().get(id=account.id)
                locked.onboarding_state = "outcome_unknown"
                locked.last_operation_error = "create_account_outcome_unknown"
                locked.save(
                    update_fields=["onboarding_state", "last_operation_error", "updated_at"]
                )
            raise ConnectOutcomeUnknownError(
                "Connect account creation timed out with unknown outcome"
            ) from exc

        derived_state = derive_connect_onboarding_state(snap)
        # Persist `stripe_connect_account_id` in its own committed transaction BEFORE link creation!
        with transaction.atomic():
            lock_workspace_for_vip(organisation_id)
            account = CreatorConnectAccount.objects.select_for_update().get(id=account.id)
            account.stripe_connect_account_id = snap.account_id
            account.charges_enabled = snap.charges_enabled
            account.payouts_enabled = snap.payouts_enabled
            account.details_submitted = snap.details_submitted
            account.onboarding_state = derived_state
            account.last_operation_error = (
                snap.restricted_reason if derived_state in {"restricted", "disabled"} else None
            )
            if derived_state == "active" and account.onboarding_completed_at is None:
                account.onboarding_completed_at = timezone.now()
            account.save(
                update_fields=[
                    "stripe_connect_account_id",
                    "charges_enabled",
                    "payouts_enabled",
                    "details_submitted",
                    "onboarding_state",
                    "last_operation_error",
                    "onboarding_completed_at",
                    "updated_at",
                ]
            )
        if derived_state == "disabled":
            raise ConnectAccountNotReadyError("Connect account was rejected by provider")

    link = provider.create_connect_onboarding_link(
        account_id=str(account.stripe_connect_account_id),
        refresh_url=refresh_url,
        return_url=return_url,
    )
    with transaction.atomic():
        lock_workspace_for_vip(organisation_id)
        account = CreatorConnectAccount.objects.select_for_update().get(id=account.id)
        if account.onboarding_state in {"intent_recorded", "account_created"}:
            account.onboarding_state = "onboarding_link_issued"
            account.save(update_fields=["onboarding_state", "updated_at"])
    return account, link


def reconcile_connect_account_status(
    *,
    workspace_id: UUID,
    provider: ConnectProviderPort,
    known_account_id: str | None = None,
) -> CreatorConnectAccount:
    """Reconcile a Connect account (including `outcome_unknown` recovery) outside DB locks."""
    if connection.in_atomic_block:
        raise RuntimeError(
            "reconcile_connect_account_status must execute outside transaction.atomic()"
        )
    with transaction.atomic():
        account = CreatorConnectAccount.objects.select_for_update().get(workspace_id=workspace_id)
        org_id = account.organisation_id
        acct_id = account.stripe_connect_account_id or known_account_id
        if acct_id is None or not CONNECT_ACCOUNT_ID.fullmatch(acct_id):
            raise VipConnectValidationError("valid acct_ identifier required for reconciliation")

    snap = provider.retrieve_connect_account(acct_id)
    claimed_ws = snap.metadata.get("kodera_workspace_id")
    if claimed_ws != str(workspace_id):
        raise VipConnectValidationError(
            "Connect account metadata kodera_workspace_id does not match workspace"
        )

    next_state = derive_connect_onboarding_state(snap)
    now = timezone.now()
    with transaction.atomic():
        lock_workspace_for_vip(org_id)
        account = CreatorConnectAccount.objects.select_for_update().get(workspace_id=workspace_id)
        if (
            account.stripe_connect_account_id is not None
            and account.stripe_connect_account_id != snap.account_id
        ):
            raise VipConnectValidationError("persisted stripe_connect_account_id mismatch")
        account.stripe_connect_account_id = snap.account_id
        account.charges_enabled = snap.charges_enabled
        account.payouts_enabled = snap.payouts_enabled
        account.details_submitted = snap.details_submitted
        account.onboarding_state = next_state
        account.last_operation_error = snap.restricted_reason
        if next_state == "active" and account.onboarding_completed_at is None:
            account.onboarding_completed_at = now
        account.save(
            update_fields=[
                "stripe_connect_account_id",
                "charges_enabled",
                "payouts_enabled",
                "details_submitted",
                "onboarding_state",
                "last_operation_error",
                "onboarding_completed_at",
                "updated_at",
            ]
        )
        return account


def create_vip_tier_offer(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    code: str,
    name: str,
    billing_period: str,
    price_excl_vat_minor: int,
    granted_workspace_role_id: UUID,
    granted_channel_ids: Sequence[UUID],
    description: str | None = None,
) -> VipTierOffer:
    """Create a `VipTierOffer` and gate its Matrix/LiveKit channels preserving owners/admins."""
    with transaction.atomic():
        locked_ws = lock_workspace_for_vip(organisation_id)
        if locked_ws is None or locked_ws != workspace_id:
            raise VipConnectValidationError("workspace does not belong to organisation")
        connect_account = CreatorConnectAccount.objects.select_for_update().get(
            workspace_id=workspace_id,
            organisation_id=organisation_id,
        )
        if (
            connect_account.onboarding_state != "active"
            or not connect_account.charges_enabled
            or not connect_account.payouts_enabled
        ):
            raise ConnectAccountNotReadyError(
                "Connect account must be active with charges and payouts enabled to publish VIP tiers"
            )
        gated = configure_vip_channel_gate(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            role_id=granted_workspace_role_id,
            channel_ids=granted_channel_ids,
        )
        return VipTierOffer.objects.create(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            connect_account=connect_account,
            code=code.strip(),
            name=name.strip(),
            description=description,
            billing_period=billing_period,
            currency="EUR",
            price_excl_vat_minor=price_excl_vat_minor,
            granted_workspace_role_id=granted_workspace_role_id,
            granted_channel_ids=[str(cid) for cid in gated],
            active=True,
        )


def create_vip_pass_checkout(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    tier_id: UUID,
    membership_id: UUID,
    buyer_user_id: UUID,
    customer_kind: str,
    buyer_country: str,
    idempotency_key: str,
    return_url: str,
    provider: ConnectProviderPort,
    withdrawal_waiver_accepted: bool,
    withdrawal_waiver_at: datetime | None,
    withdrawal_waiver_statement: str | None,
    vat_number_validated: bool = False,
    locale: str = "fr",
) -> tuple[VipMembershipEntitlement, ProviderLink, VipCheckoutQuote]:
    """Create a pending `VipMembershipEntitlement` (reserving any negative-balance recovery into
    Stripe's `application_fee_amount` under row lock) and issue a card-only Connect Checkout session
    outside `transaction.atomic()`."""
    del vat_number_validated  # Derived strictly from stored BillingProfile!
    if connection.in_atomic_block:
        raise RuntimeError("create_vip_pass_checkout must execute outside transaction.atomic()")
    if not isinstance(idempotency_key, str) or IDEMPOTENCY_KEY.fullmatch(idempotency_key) is None:
        raise VipConnectValidationError("invalid idempotency_key")
    check_return_url(return_url)
    if locale not in {"fr", "en"}:
        raise VipConnectValidationError("unsupported locale")

    now = timezone.now()
    cached_result: tuple[VipMembershipEntitlement, ProviderLink, VipCheckoutQuote] | None = None

    with transaction.atomic():
        locked_ws = lock_workspace_for_vip(organisation_id)
        if locked_ws is None or locked_ws != workspace_id:
            raise VipConnectValidationError("workspace does not belong to organisation")
        tier = VipTierOffer.objects.select_related("connect_account").get(
            id=tier_id,
            workspace_id=workspace_id,
            organisation_id=organisation_id,
            active=True,
        )
        connect_account = CreatorConnectAccount.objects.select_for_update().get(
            id=tier.connect_account_id
        )
        if (
            connect_account.onboarding_state != "active"
            or not connect_account.charges_enabled
            or not connect_account.payouts_enabled
            or not connect_account.stripe_connect_account_id
        ):
            raise ConnectAccountNotReadyError("creator Connect account cannot accept charges")

        if customer_kind == "b2b":
            profile, server_vies_valid = resolve_server_b2b_vat_status(
                organisation_id=organisation_id, now=now
            )
            eff_country = profile.country
            eff_exempt = profile.vat_exempt
        elif customer_kind == "b2c":
            eff_country = buyer_country.strip().upper()
            server_vies_valid = False
            eff_exempt = False
        else:
            raise VipConnectValidationError(f"unsupported customer_kind {customer_kind!r}")

        waiver_ok, waiver_at, waiver_evidence = verify_b2c_withdrawal_waiver(
            customer_kind=customer_kind,
            scope=f"volet-b:{workspace_id}",
            offer_code=tier.code,
            buyer_ref=str(buyer_user_id),
            withdrawal_waiver_accepted=withdrawal_waiver_accepted,
            withdrawal_waiver_at=withdrawal_waiver_at,
            withdrawal_waiver_statement=withdrawal_waiver_statement,
            now=now,
        )
        req_hash = _vip_request_sha256(
            workspace_id=workspace_id,
            tier_id=tier.id,
            membership_id=membership_id,
            buyer_user_id=buyer_user_id,
            customer_kind=customer_kind,
            buyer_country=eff_country,
            return_url=return_url,
            locale=locale,
            withdrawal_waiver_accepted=waiver_ok,
        )
        quote = quote_vip_pass(
            tier_code=tier.code,
            billing_period=tier.billing_period,
            price_excl_vat_minor=tier.price_excl_vat_minor,
            platform_fee_bps=connect_account.platform_fee_bps,
            buyer_country=eff_country,
            customer_kind=customer_kind,
            vat_number_validated=server_vies_valid,
            vat_exempt=eff_exempt,
        )

        existing = (
            VipMembershipEntitlement.objects.select_for_update()
            .filter(
                workspace_id=workspace_id,
                idempotency_key=idempotency_key,
            )
            .first()
        )
        if existing is not None:
            if existing.request_sha256 != req_hash:
                raise IdempotencyKeyReuseError()
            if existing.stripe_checkout_session_id and existing.stripe_checkout_url:
                cached_result = (
                    existing,
                    ProviderLink(
                        provider_ref=existing.stripe_checkout_session_id,
                        url=existing.stripe_checkout_url,
                    ),
                    quote,
                )
            else:
                entitlement = existing
        else:
            unreserved_debt = max(
                0, connect_account.negative_balance_minor - connect_account.reserved_recovery_minor
            )
            reserved_recovery = compute_recoverable_negative_balance_minor(
                quote=quote,
                unreserved_negative_balance_minor=unreserved_debt,
            )
            if reserved_recovery > 0:
                connect_account.reserved_recovery_minor += reserved_recovery
                connect_account.save(update_fields=["reserved_recovery_minor", "updated_at"])

            entitlement = VipMembershipEntitlement.objects.create(
                organisation_id=organisation_id,
                workspace_id=workspace_id,
                tier=tier,
                membership_id=membership_id,
                buyer_user_id=buyer_user_id,
                customer_kind=customer_kind,
                buyer_country=quote.buyer_country,
                currency=tier.currency,
                vat_regime=quote.vat_regime.code,
                vat_rate_bp=quote.vat_regime.rate_bp,
                gross_excl_vat_minor=quote.gross_excl_vat_minor,
                vat_amount_minor=quote.vat_amount_minor,
                total_incl_vat_minor=quote.total_incl_vat_minor,
                application_fee_amount_minor=quote.application_fee_amount_minor,
                reserved_recovery_minor=reserved_recovery,
                state="pending_payment",
                withdrawal_waiver_accepted=waiver_ok,
                withdrawal_waiver_at=waiver_at,
                withdrawal_waiver_evidence=waiver_evidence,
                idempotency_key=idempotency_key,
                request_sha256=req_hash,
            )
        destination_acct = str(connect_account.stripe_connect_account_id)
        tier_code = tier.code
        tier_name = tier.name

    if cached_result is not None:
        return cached_result

    stripe_fee_with_recovery = (
        quote.stripe_application_fee_minor + entitlement.reserved_recovery_minor
    )
    checkout_label = f"Pass VIP — {tier_name}" if locale == "fr" else f"VIP Pass — {tier_name}"

    try:
        issued_link = provider.create_link(
            LinkRequest(
                invoice_id=entitlement.id,
                invoice_number=tier_code.upper(),
                amount_minor=entitlement.total_incl_vat_minor,
                currency=entitlement.currency,
                expires_at=now + timedelta(hours=23),
                return_url=return_url,
                locale=locale,
                connect_destination_account=destination_acct,
                application_fee_amount_minor=stripe_fee_with_recovery,
                payment_methods=("card",),
                reference_kind="vip_pass",
                checkout_label=checkout_label,
                metadata={
                    "volet": "b_vip",
                    "vip_entitlement_id": str(entitlement.id),
                    "workspace_id": str(workspace_id),
                },
            )
        )
    except Exception:
        cancel_pending_vip_entitlement(entitlement_id=entitlement.id)
        raise

    with transaction.atomic():
        lock_workspace_for_vip(organisation_id)
        locked = VipMembershipEntitlement.objects.select_for_update().get(id=entitlement.id)
        if locked.stripe_checkout_session_id and locked.stripe_checkout_url:
            return (
                locked,
                ProviderLink(
                    provider_ref=locked.stripe_checkout_session_id,
                    url=locked.stripe_checkout_url,
                ),
                quote,
            )
        locked.stripe_checkout_session_id = issued_link.provider_ref
        locked.stripe_checkout_url = issued_link.url
        locked.save(
            update_fields=["stripe_checkout_session_id", "stripe_checkout_url", "updated_at"]
        )
        return locked, issued_link, quote


def cancel_pending_vip_entitlement(*, entitlement_id: UUID) -> bool:
    """Cancel an expired or failed pending VIP pass and release any reserved debt recovery."""
    meta = (
        VipMembershipEntitlement.objects.select_related("tier")
        .values_list("organisation_id", "tier__connect_account_id")
        .filter(id=entitlement_id)
        .first()
    )
    if meta is None:
        return False
    org_id, connect_id = meta
    with transaction.atomic():
        lock_workspace_for_vip(org_id)
        connect_account = CreatorConnectAccount.objects.select_for_update().get(id=connect_id)
        entitlement = VipMembershipEntitlement.objects.select_for_update().get(id=entitlement_id)
        if entitlement.state != "pending_payment":
            return False
        if entitlement.reserved_recovery_minor > 0:
            connect_account.reserved_recovery_minor = max(
                0, connect_account.reserved_recovery_minor - entitlement.reserved_recovery_minor
            )
            connect_account.save(update_fields=["reserved_recovery_minor", "updated_at"])
        entitlement.state = "cancelled"
        entitlement.save(update_fields=["state", "updated_at"])
        return True


def _sync_member_vip_role_from_db(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_id: UUID,
    role_id: UUID,
    reason: str,
    now: datetime,
) -> VipConvergenceOutcome:
    rows = list(
        VipMembershipEntitlement.objects.select_for_update(of=("self",))
        .select_related("tier")
        .filter(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            membership_id=membership_id,
            tier__granted_workspace_role_id=role_id,
        )
    )
    windows = [
        VipEntitlementGrantWindow(
            entitlement_id=r.id,
            membership_id=r.membership_id,
            role_id=r.tier.granted_workspace_role_id,
            state=r.state,
            expires_at=r.expires_at,
        )
        for r in rows
    ]
    should_hold = should_member_hold_vip_role(
        windows,
        membership_id=membership_id,
        role_id=role_id,
        now=now,
    )
    return sync_vip_member_entitlement(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        membership_id=membership_id,
        role_id=role_id,
        should_hold_role=should_hold,
        reason=reason,
    )


def _lock_vip_settlement_order(
    entitlement_id: UUID,
) -> tuple[CreatorConnectAccount, VipMembershipEntitlement]:
    """Acquire locks in canonical order: `workspaces_workspace` -> `CreatorConnectAccount` -> `VipMembershipEntitlement`."""
    org_id, connect_id = (
        VipMembershipEntitlement.objects.select_related("tier")
        .values_list("organisation_id", "tier__connect_account_id")
        .get(id=entitlement_id)
    )
    lock_workspace_for_vip(org_id)
    connect_account = CreatorConnectAccount.objects.select_for_update().get(id=connect_id)
    entitlement = (
        VipMembershipEntitlement.objects.select_for_update(of=("self",))
        .select_related("tier")
        .get(id=entitlement_id)
    )
    return connect_account, entitlement


def activate_vip_entitlement(
    *,
    entitlement_id: UUID,
    stripe_event_id: str,
    payment_intent_id: str,
    settled_at: datetime | None = None,
) -> tuple[VipMembershipEntitlement, CreatorSplitLedgerEntry, VipConvergenceOutcome]:
    """Settle a VIP pass, enforce B2C `Art. L221-28`, apply withheld negative-balance recovery,
    append a `"sale"` `CreatorSplitLedgerEntry`, and converge Matrix/LiveKit."""
    moment = settled_at or timezone.now()
    with transaction.atomic():
        connect_account, entitlement = _lock_vip_settlement_order(entitlement_id)
        if entitlement.customer_kind == "b2c" and (
            not entitlement.withdrawal_waiver_accepted
            or entitlement.withdrawal_waiver_at is None
            or not entitlement.withdrawal_waiver_evidence
        ):
            raise WithdrawalWaiverRequiredError(
                "cannot activate B2C VIP pass without recorded Art. L221-28 waiver"
            )

        existing_entry = CreatorSplitLedgerEntry.objects.filter(
            stripe_event_id=stripe_event_id,
            entry_kind="sale",
        ).first()
        if existing_entry is None and entitlement.state != "pending_payment":
            existing_entry = CreatorSplitLedgerEntry.objects.filter(
                entitlement=entitlement,
                entry_kind="sale",
            ).first()
        if existing_entry is not None:
            convergence = _sync_member_vip_role_from_db(
                organisation_id=entitlement.organisation_id,
                workspace_id=entitlement.workspace_id,
                membership_id=entitlement.membership_id,
                role_id=entitlement.tier.granted_workspace_role_id,
                reason="vip_entitlement_activated",
                now=moment,
            )
            return entitlement, existing_entry, convergence

        expires_at = (
            None
            if entitlement.tier.billing_period == "one_time"
            else period_end(start=moment, billing_period=entitlement.tier.billing_period)
        )
        entitlement.state = "active"
        entitlement.activated_at = moment
        entitlement.expires_at = expires_at
        entitlement.stripe_payment_intent_id = payment_intent_id
        entitlement.save(
            update_fields=[
                "state",
                "activated_at",
                "expires_at",
                "stripe_payment_intent_id",
                "updated_at",
            ]
        )

        creator_net = entitlement.gross_excl_vat_minor - entitlement.application_fee_amount_minor
        recovered = min(
            connect_account.negative_balance_minor,
            max(0, entitlement.reserved_recovery_minor),
        )
        neg_delta = -recovered
        new_reserved = max(
            0, connect_account.reserved_recovery_minor - entitlement.reserved_recovery_minor
        )
        new_neg = max(0, connect_account.negative_balance_minor + neg_delta)
        if (
            new_neg != connect_account.negative_balance_minor
            or new_reserved != connect_account.reserved_recovery_minor
        ):
            connect_account.negative_balance_minor = new_neg
            connect_account.reserved_recovery_minor = new_reserved
            connect_account.save(
                update_fields=[
                    "negative_balance_minor",
                    "reserved_recovery_minor",
                    "updated_at",
                ]
            )

        entry = CreatorSplitLedgerEntry.objects.create(
            organisation_id=entitlement.organisation_id,
            workspace_id=entitlement.workspace_id,
            connect_account=connect_account,
            entitlement=entitlement,
            entry_kind="sale",
            stripe_event_id=stripe_event_id,
            stripe_object_ref=payment_intent_id,
            currency=entitlement.currency,
            gross_excl_vat_minor=entitlement.gross_excl_vat_minor,
            vat_amount_minor=entitlement.vat_amount_minor,
            total_incl_vat_minor=entitlement.total_incl_vat_minor,
            application_fee_amount_minor=entitlement.application_fee_amount_minor,
            dispute_fee_minor=0,
            creator_net_minor=creator_net,
            negative_balance_delta_minor=neg_delta,
            occurred_at=moment,
        )
        convergence = _sync_member_vip_role_from_db(
            organisation_id=entitlement.organisation_id,
            workspace_id=entitlement.workspace_id,
            membership_id=entitlement.membership_id,
            role_id=entitlement.tier.granted_workspace_role_id,
            reason="vip.entitlement.activated",
            now=moment,
        )
        events.record(
            "payment.received",
            actor=Actor("system", None),
            organisation_id=entitlement.organisation_id,
            target=("vip_entitlement", entitlement.id),
            metadata={
                "workspace_id": str(entitlement.workspace_id),
                "membership_id": str(entitlement.membership_id),
                "creator_net_minor": creator_net,
                "recovered_negative_balance_minor": recovered,
            },
        )
        return entitlement, entry, convergence


def refund_vip_entitlement(
    *,
    entitlement_id: UUID,
    stripe_event_id: str,
    charge_id: str,
    cumulative_refunded_incl_vat_minor: int,
    occurred_at: datetime | None = None,
) -> tuple[VipMembershipEntitlement, CreatorSplitLedgerEntry | None, VipConvergenceOutcome]:
    """Apply a partial or full refund to a VIP pass, accrue creator negative balance, and converge access."""
    moment = occurred_at or timezone.now()
    with transaction.atomic():
        connect_account, entitlement = _lock_vip_settlement_order(entitlement_id)
        if cumulative_refunded_incl_vat_minor <= entitlement.refunded_incl_vat_minor:
            convergence = _sync_member_vip_role_from_db(
                organisation_id=entitlement.organisation_id,
                workspace_id=entitlement.workspace_id,
                membership_id=entitlement.membership_id,
                role_id=entitlement.tier.granted_workspace_role_id,
                reason="vip.entitlement.refund_noop",
                now=moment,
            )
            return entitlement, None, convergence

        delta_incl = cumulative_refunded_incl_vat_minor - entitlement.refunded_incl_vat_minor
        prior_refunds = list(
            CreatorSplitLedgerEntry.objects.filter(
                entitlement=entitlement,
                entry_kind="refund",
            )
        )
        prev_excl = sum(abs(r.gross_excl_vat_minor) for r in prior_refunds)
        prev_fee = sum(abs(r.application_fee_amount_minor) for r in prior_refunds)

        # Express destination charges transfer net funds at settlement; platform never treats
        # historical lifetime creator_net_minor as unwithdrawn escrow (`available_creator_balance_minor=0`).
        split = compute_refund_ledger_entry(
            original_excl_vat_minor=entitlement.gross_excl_vat_minor,
            original_vat_minor=entitlement.vat_amount_minor,
            original_total_incl_vat_minor=entitlement.total_incl_vat_minor,
            original_application_fee_minor=entitlement.application_fee_amount_minor,
            previously_refunded_incl_vat_minor=entitlement.refunded_incl_vat_minor,
            previously_refunded_excl_vat_minor=prev_excl,
            previously_refunded_fee_minor=prev_fee,
            refund_incl_vat_minor=delta_incl,
            available_creator_balance_minor=0,
            current_negative_balance_minor=connect_account.negative_balance_minor,
            vat_rate_bp=entitlement.vat_rate_bp,
        )
        entry = CreatorSplitLedgerEntry.objects.create(
            organisation_id=entitlement.organisation_id,
            workspace_id=entitlement.workspace_id,
            connect_account=connect_account,
            entitlement=entitlement,
            entry_kind="refund",
            stripe_event_id=stripe_event_id,
            stripe_object_ref=charge_id,
            currency=entitlement.currency,
            gross_excl_vat_minor=split.gross_excl_vat_minor,
            vat_amount_minor=split.vat_amount_minor,
            total_incl_vat_minor=split.total_incl_vat_minor,
            application_fee_amount_minor=split.application_fee_amount_minor,
            dispute_fee_minor=0,
            creator_net_minor=split.creator_net_minor,
            negative_balance_delta_minor=split.negative_balance_delta_minor,
            occurred_at=moment,
        )
        if split.new_negative_balance_minor != connect_account.negative_balance_minor:
            connect_account.negative_balance_minor = split.new_negative_balance_minor
            connect_account.save(update_fields=["negative_balance_minor", "updated_at"])

        entitlement.refunded_incl_vat_minor = cumulative_refunded_incl_vat_minor
        if cumulative_refunded_incl_vat_minor >= entitlement.total_incl_vat_minor:
            entitlement.state = "refunded"
            entitlement.revoked_at = moment
            entitlement.revocation_reason = "refunded"
            entitlement.save(
                update_fields=[
                    "refunded_incl_vat_minor",
                    "state",
                    "revoked_at",
                    "revocation_reason",
                    "updated_at",
                ]
            )
        else:
            entitlement.save(update_fields=["refunded_incl_vat_minor", "updated_at"])

        convergence = _sync_member_vip_role_from_db(
            organisation_id=entitlement.organisation_id,
            workspace_id=entitlement.workspace_id,
            membership_id=entitlement.membership_id,
            role_id=entitlement.tier.granted_workspace_role_id,
            reason="vip.entitlement.refunded",
            now=moment,
        )
        return entitlement, entry, convergence


def record_vip_dispute_created(
    *,
    entitlement_id: UUID,
    stripe_event_id: str,
    dispute_id: str,
    dispute_fee_minor: int = DEFAULT_STRIPE_DISPUTE_FEE_MINOR,
    occurred_at: datetime | None = None,
) -> tuple[VipMembershipEntitlement, CreatorSplitLedgerEntry, VipConvergenceOutcome]:
    """Revoke disputed VIP pass immediately, record chargeback + dispute fee, and converge access."""
    moment = occurred_at or timezone.now()
    with transaction.atomic():
        connect_account, entitlement = _lock_vip_settlement_order(entitlement_id)
        existing_entry = CreatorSplitLedgerEntry.objects.filter(
            stripe_event_id=stripe_event_id,
            entry_kind="chargeback",
        ).first()
        if existing_entry is None and entitlement.state == "disputed":
            existing_entry = CreatorSplitLedgerEntry.objects.filter(
                entitlement=entitlement,
                entry_kind="chargeback",
            ).first()
        if existing_entry is not None:
            convergence = _sync_member_vip_role_from_db(
                organisation_id=entitlement.organisation_id,
                workspace_id=entitlement.workspace_id,
                membership_id=entitlement.membership_id,
                role_id=entitlement.tier.granted_workspace_role_id,
                reason="vip.entitlement.disputed",
                now=moment,
            )
            return entitlement, existing_entry, convergence

        prior_refunds = list(
            CreatorSplitLedgerEntry.objects.filter(
                entitlement=entitlement,
                entry_kind="refund",
            )
        )
        refunded_excl = sum(abs(r.gross_excl_vat_minor) for r in prior_refunds)
        refunded_vat = sum(abs(r.vat_amount_minor) for r in prior_refunds)
        refunded_fee = sum(abs(r.application_fee_amount_minor) for r in prior_refunds)
        rem_excl = max(0, entitlement.gross_excl_vat_minor - refunded_excl)
        rem_vat = max(0, entitlement.vat_amount_minor - refunded_vat)
        rem_fee = max(0, entitlement.application_fee_amount_minor - refunded_fee)

        split = compute_chargeback_ledger_entry(
            remaining_excl_vat_minor=rem_excl,
            remaining_vat_minor=rem_vat,
            remaining_application_fee_minor=rem_fee,
            dispute_fee_minor=dispute_fee_minor,
            available_creator_balance_minor=0,
            current_negative_balance_minor=connect_account.negative_balance_minor,
        )
        entry = CreatorSplitLedgerEntry.objects.create(
            organisation_id=entitlement.organisation_id,
            workspace_id=entitlement.workspace_id,
            connect_account=connect_account,
            entitlement=entitlement,
            entry_kind="chargeback",
            stripe_event_id=stripe_event_id,
            stripe_object_ref=dispute_id,
            currency=entitlement.currency,
            gross_excl_vat_minor=split.gross_excl_vat_minor,
            vat_amount_minor=split.vat_amount_minor,
            total_incl_vat_minor=split.total_incl_vat_minor,
            application_fee_amount_minor=split.application_fee_amount_minor,
            dispute_fee_minor=split.dispute_fee_minor,
            creator_net_minor=split.creator_net_minor,
            negative_balance_delta_minor=split.negative_balance_delta_minor,
            occurred_at=moment,
        )
        connect_account.negative_balance_minor = split.new_negative_balance_minor
        connect_account.save(update_fields=["negative_balance_minor", "updated_at"])

        entitlement.state = "disputed"
        entitlement.revoked_at = moment
        entitlement.revocation_reason = "charge_dispute_created"
        entitlement.save(update_fields=["state", "revoked_at", "revocation_reason", "updated_at"])

        convergence = _sync_member_vip_role_from_db(
            organisation_id=entitlement.organisation_id,
            workspace_id=entitlement.workspace_id,
            membership_id=entitlement.membership_id,
            role_id=entitlement.tier.granted_workspace_role_id,
            reason="vip.entitlement.disputed",
            now=moment,
        )
        return entitlement, entry, convergence

"""Application orchestration for H3.1 community workspace monetization HTTP endpoints.

Bridges `apps.billing.api.monetization` (which holds zero model or foreign-app imports) to
`apps.billing.{boosts,vip_connect,dac7}` and workspace/identity selectors while keeping all
outbound Stripe port calls strictly outside `transaction.atomic()`.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import connection, transaction
from django.utils import timezone

from apps.identity.selectors import current_identity_for_organisation
from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.selectors import workspace_id_for
from services.identity.access_tokens import VerifiedAccessToken

from . import boosts, dac7, payments as payments_pkg, vip_connect
from .access import READERS
from .callers import BillingNotFoundError, require_role, tenant_caller
from .models import (
    CreatorConnectAccount,
    VipTierOffer,
    WorkspaceHostingCredit,
)
from .payments.port import CONNECT_ACCOUNT_ID, LinkRequest
from .payments.services import check_return_url

ADMIN_CONNECT_ROLES = frozenset({"org_owner", "org_admin"})
DAC7_EXPORT_ROLES = frozenset({"org_owner", "org_billing"})


def _resolve_workspace_or_not_found(organisation_id: UUID) -> UUID:
    ws_id = workspace_id_for(organisation_id=organisation_id)
    if ws_id is None:
        raise BillingNotFoundError()
    return ws_id


def _resolve_caller_and_user(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    scope: str,
    roles: frozenset[str] | None = None,
) -> tuple[TenantCaller, UUID, UUID]:
    with transaction.atomic():
        caller = tenant_caller(verified=verified, organisation_id=organisation_id)
        require_role(caller, roles=roles or READERS[scope], scope=scope)
        resolved = current_identity_for_organisation(
            organisation_id=organisation_id, issuer=verified.issuer, subject=verified.subject
        )
        if resolved is None:
            raise BillingNotFoundError()
        person, _ = resolved
        ws_id = _resolve_workspace_or_not_found(organisation_id)
        return caller, person.id, ws_id


def read_workspace_monetization_overview(*, caller: TenantCaller) -> dict[str, Any]:
    """Read Volet A boost packs, active hosting credits, VIP offers, and (for admins/billing)
    creator Connect & DAC7 compliance overview in the caller's read-only snapshot."""
    from apps.orgs.selectors import is_default_community_organisation

    ws_id = _resolve_workspace_or_not_found(caller.organisation_id)
    packs = (
        []
        if is_default_community_organisation(organisation_id=caller.organisation_id)
        else [
            {
                "code": spec.code,
                "name": spec.name,
                "net_amount_minor": spec.net_amount_minor,
                "credit_amount_minor": spec.credit_amount_minor,
                "seats_delta": spec.seats_delta,
                "storage_bytes_delta": spec.storage_bytes_delta,
                "duration_days": spec.duration_days,
                "currency": spec.currency,
            }
            for spec in boosts.BOOST_PACKS.values()
        ]
    )
    credits = [
        {
            "id": str(c.id),
            "boost_grant_id": str(c.boost_grant_id),
            "pack_code": c.boost_grant.pack_code,
            "granted_minor": c.granted_minor,
            "consumed_minor": c.consumed_minor,
            "refunded_minor": c.refunded_minor,
            "remaining_minor": c.remaining_minor,
            "state": c.state,
            "expires_at": None if c.expires_at is None else c.expires_at.isoformat(),
        }
        for c in WorkspaceHostingCredit.objects.select_related("boost_grant")
        .filter(organisation_id=caller.organisation_id, workspace_id=ws_id)
        .order_by("-created_at", "-id")[:50]
    ]
    tiers = [
        {
            "id": str(t.id),
            "code": t.code,
            "name": t.name,
            "description": t.description,
            "billing_period": t.billing_period,
            "currency": t.currency,
            "price_excl_vat_minor": t.price_excl_vat_minor,
            "granted_workspace_role_id": str(t.granted_workspace_role_id),
            "granted_channel_ids": list(t.granted_channel_ids),
            "active": t.active,
        }
        for t in VipTierOffer.objects.filter(
            organisation_id=caller.organisation_id, workspace_id=ws_id, active=True
        ).order_by("price_excl_vat_minor", "id")
    ]

    connect_payload: dict[str, Any] | None = None
    dac7_payload: dict[str, Any] | None = None
    if caller.role in {"org_owner", "org_admin", "org_billing"}:
        acct = CreatorConnectAccount.objects.filter(
            organisation_id=caller.organisation_id, workspace_id=ws_id
        ).first()
        if acct is not None:
            connect_payload = {
                "id": str(acct.id),
                "onboarding_state": acct.onboarding_state,
                "stripe_connect_account_id": acct.stripe_connect_account_id,
                "charges_enabled": acct.charges_enabled,
                "payouts_enabled": acct.payouts_enabled,
                "details_submitted": acct.details_submitted,
                "platform_fee_bps": acct.platform_fee_bps,
                "negative_balance_minor": acct.negative_balance_minor,
                "reserved_recovery_minor": acct.reserved_recovery_minor,
                "tax_residence_country": acct.tax_residence_country,
                "tin_sealed": bool(acct.sealed_tax_tin),
                "last_operation_error": acct.last_operation_error,
            }
            year = timezone.now().year
            report = dac7.build_dac7_annual_report_from_db(
                reporting_year=year,
                include_unsealed_tin=False,
                organisation_id=caller.organisation_id,
                include_statutory_erased=False,
            )
            seller_summary = next(
                (s for s in report.sellers if s.connect_account_id == str(acct.id)),
                None,
            )
            if seller_summary is not None:
                dac7_payload = {
                    "reporting_year": year,
                    "transaction_count": seller_summary.transaction_count,
                    "net_consideration_minor": seller_summary.net_consideration_minor,
                    "platform_fees_minor": seller_summary.platform_fees_minor,
                    "taxes_withheld_minor": seller_summary.taxes_withheld_minor,
                    "reportable": seller_summary.reportable,
                    "tin_present": seller_summary.tin_present,
                }

    return {
        "workspace_id": str(ws_id),
        "boost_packs": packs,
        "hosting_credits": credits,
        "vip_tiers": tiers,
        "connect_account": connect_payload,
        "dac7_summary": dac7_payload,
    }


def _parse_iso_datetime(raw: Any) -> datetime | None:
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise boosts.BoostValidationError("invalid ISO-8601 timestamp")
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise boosts.BoostValidationError("timestamp must include timezone offset")
    return parsed


def start_boost_checkout_for_caller(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    idempotency_key: str,
    payload: dict[str, Any],
    provider: Any | None = None,
) -> dict[str, Any]:
    _, user_id, ws_id = _resolve_caller_and_user(
        verified=verified,
        organisation_id=organisation_id,
        scope="workspace_monetization:act",
    )
    active_provider = provider if provider is not None else payments_pkg.configured_provider()
    grant, invoice, link = boosts.create_boost_checkout(
        organisation_id=organisation_id,
        workspace_id=ws_id,
        purchaser_user_id=user_id,
        pack_code=str(payload.get("pack_code", "")),
        customer_kind=str(payload.get("customer_kind", "b2c")),
        customer_country=str(payload.get("customer_country", "")),
        customer_legal_name=str(payload.get("customer_legal_name", "Membre Kodera")),
        customer_address_line1=str(payload.get("customer_address_line1", "Adresse déclarée")),
        customer_postal_code=str(payload.get("customer_postal_code", "00000")),
        customer_city=str(payload.get("customer_city", "Ville")),
        idempotency_key=idempotency_key,
        return_url=str(payload.get("return_url", "")),
        provider=active_provider,
        withdrawal_waiver_accepted=bool(payload.get("withdrawal_waiver_accepted", False)),
        withdrawal_waiver_at=_parse_iso_datetime(payload.get("withdrawal_waiver_at")),
        withdrawal_waiver_statement=(
            str(payload["withdrawal_waiver_statement"])
            if payload.get("withdrawal_waiver_statement") is not None
            else None
        ),
        quantity=int(payload.get("quantity", 1)),
        locale=str(payload.get("locale", "fr")),
    )
    return {
        "boost_grant_id": str(grant.id),
        "invoice_id": str(invoice.id),
        "invoice_number": invoice.number,
        "vat_regime": grant.vat_regime,
        "vat_rate_bp": grant.vat_rate_bp,
        "net_amount_minor": grant.net_amount_minor,
        "vat_amount_minor": grant.vat_amount_minor,
        "gross_amount_minor": grant.gross_amount_minor,
        "checkout_session_id": link.provider_ref,
        "checkout_url": link.url,
    }


def start_connect_onboarding_for_caller(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    idempotency_key: str,
    payload: dict[str, Any],
    provider: Any | None = None,
) -> dict[str, Any]:
    _, user_id, ws_id = _resolve_caller_and_user(
        verified=verified,
        organisation_id=organisation_id,
        scope="workspace_monetization:create",
        roles=ADMIN_CONNECT_ROLES,
    )
    active_provider = provider if provider is not None else payments_pkg.configured_provider()
    raw_tin = payload.get("tax_tin")
    account, link = vip_connect.initiate_or_resume_connect_onboarding(
        organisation_id=organisation_id,
        workspace_id=ws_id,
        owner_user_id=user_id,
        seller_legal_name=str(payload.get("seller_legal_name", "")),
        tax_residence_country=str(payload.get("tax_residence_country", "")),
        raw_tax_tin=str(raw_tin) if isinstance(raw_tin, str) and raw_tin.strip() else None,
        operation_idempotency_key=idempotency_key,
        refresh_url=str(payload.get("refresh_url", "")),
        return_url=str(payload.get("return_url", "")),
        provider=active_provider,
    )
    return {
        "connect_account_id": str(account.id),
        "stripe_connect_account_id": account.stripe_connect_account_id,
        "onboarding_state": account.onboarding_state,
        "onboarding_url": link.url,
        "expires_at": link.expires_at.isoformat(),
    }


def create_vip_tier_for_caller(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    payload: dict[str, Any],
) -> dict[str, Any]:
    _, _, ws_id = _resolve_caller_and_user(
        verified=verified,
        organisation_id=organisation_id,
        scope="workspace_monetization:create",
        roles=ADMIN_CONNECT_ROLES,
    )
    raw_channels = payload.get("granted_channel_ids")
    if not isinstance(raw_channels, list) or not raw_channels:
        raise vip_connect.VipConnectValidationError("granted_channel_ids must be a non-empty list")
    channel_ids = [UUID(str(cid)) for cid in raw_channels]
    role_id = UUID(str(payload.get("granted_workspace_role_id", "")))
    tier = vip_connect.create_vip_tier_offer(
        organisation_id=organisation_id,
        workspace_id=ws_id,
        code=str(payload.get("code", "")),
        name=str(payload.get("name", "")),
        billing_period=str(payload.get("billing_period", "monthly")),
        price_excl_vat_minor=int(payload.get("price_excl_vat_minor", 0)),
        granted_workspace_role_id=role_id,
        granted_channel_ids=channel_ids,
        description=(
            str(payload["description"]) if payload.get("description") is not None else None
        ),
    )
    return {
        "id": str(tier.id),
        "code": tier.code,
        "name": tier.name,
        "billing_period": tier.billing_period,
        "currency": tier.currency,
        "price_excl_vat_minor": tier.price_excl_vat_minor,
        "granted_workspace_role_id": str(tier.granted_workspace_role_id),
        "granted_channel_ids": list(tier.granted_channel_ids),
        "active": tier.active,
    }


def start_vip_pass_checkout_for_caller(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    idempotency_key: str,
    payload: dict[str, Any],
    provider: Any | None = None,
) -> dict[str, Any]:
    caller, user_id, ws_id = _resolve_caller_and_user(
        verified=verified,
        organisation_id=organisation_id,
        scope="workspace_monetization:act",
    )
    active_provider = provider if provider is not None else payments_pkg.configured_provider()
    tier_id = UUID(str(payload.get("tier_id", "")))
    entitlement, link, quote = vip_connect.create_vip_pass_checkout(
        organisation_id=organisation_id,
        workspace_id=ws_id,
        tier_id=tier_id,
        membership_id=caller.membership_id,
        buyer_user_id=user_id,
        customer_kind=str(payload.get("customer_kind", "b2c")),
        buyer_country=str(payload.get("buyer_country", "")),
        idempotency_key=idempotency_key,
        return_url=str(payload.get("return_url", "")),
        provider=active_provider,
        withdrawal_waiver_accepted=bool(payload.get("withdrawal_waiver_accepted", False)),
        withdrawal_waiver_at=_parse_iso_datetime(payload.get("withdrawal_waiver_at")),
        withdrawal_waiver_statement=(
            str(payload["withdrawal_waiver_statement"])
            if payload.get("withdrawal_waiver_statement") is not None
            else None
        ),
        locale=str(payload.get("locale", "fr")),
    )
    return {
        "vip_entitlement_id": str(entitlement.id),
        "tier_id": str(entitlement.tier_id),
        "vat_regime": entitlement.vat_regime,
        "vat_rate_bp": entitlement.vat_rate_bp,
        "gross_excl_vat_minor": entitlement.gross_excl_vat_minor,
        "vat_amount_minor": entitlement.vat_amount_minor,
        "total_incl_vat_minor": entitlement.total_incl_vat_minor,
        "application_fee_amount_minor": entitlement.application_fee_amount_minor,
        "reserved_recovery_minor": entitlement.reserved_recovery_minor,
        "creator_net_minor": quote.creator_net_minor,
        "checkout_session_id": link.provider_ref,
        "checkout_url": link.url,
    }


def export_workspace_dac7_for_caller(
    *,
    caller: TenantCaller,
    reporting_year: int,
    export_format: str,
) -> tuple[bytes, str]:
    """Export the workspace creator's annual DAC7 report as JSON or OECD DPI XML."""
    require_role(caller, roles=DAC7_EXPORT_ROLES, scope="workspace_monetization:read")
    ws_id = _resolve_workspace_or_not_found(caller.organisation_id)
    full_report = dac7.build_dac7_annual_report_from_db(
        reporting_year=reporting_year,
        include_unsealed_tin=True,
        organisation_id=caller.organisation_id,
        include_statutory_erased=False,
    )
    scoped_sellers = tuple(s for s in full_report.sellers if s.workspace_id == str(ws_id))
    scoped_report = dac7.Dac7AnnualReport(
        directive=full_report.directive,
        reporting_year=full_report.reporting_year,
        platform_operator_name=full_report.platform_operator_name,
        platform_operator_country=full_report.platform_operator_country,
        platform_operator_siren=full_report.platform_operator_siren,
        total_sellers_evaluated=len(scoped_sellers),
        reportable_seller_count=sum(1 for s in scoped_sellers if s.reportable),
        sellers=scoped_sellers,
        has_prior_year_corrections=any(bool(s.prior_year_corrections) for s in scoped_sellers),
    )
    if export_format == "xml":
        return dac7.render_dac7_xml(scoped_report), "application/xml"
    if export_format == "json":
        return (
            dac7.render_dac7_json(scoped_report),
            "application/json",
        )
    raise ValueError(f"unsupported DAC7 export format {export_format!r}")


def serialize_dac7_summary_dict(summary: dac7.Dac7SellerSummary) -> dict[str, Any]:
    return asdict(summary)


@dataclass(frozen=True, slots=True)
class SellerConnectReadiness:
    stripe_connect_account_id: str | None
    platform_fee_bps: int
    onboarding_state: str
    charges_enabled: bool
    payouts_enabled: bool


def resolve_workspace_seller_connect_account(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
) -> SellerConnectReadiness | None:
    """Read the workspace's `CreatorConnectAccount` without exposing `apps.billing.models`."""
    acct = CreatorConnectAccount.objects.filter(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
    ).first()
    if acct is None:
        return None
    return SellerConnectReadiness(
        stripe_connect_account_id=acct.stripe_connect_account_id,
        platform_fee_bps=acct.platform_fee_bps,
        onboarding_state=acct.onboarding_state,
        charges_enabled=acct.charges_enabled,
        payouts_enabled=acct.payouts_enabled,
    )


def issue_marketplace_connect_checkout_link(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    entitlement_id: UUID,
    listing_slug: str,
    listing_title: str,
    pricing_mode: str,
    price_excl_vat_minor: int,
    seller_connect_account_id: str,
    platform_fee_bps: int = 1000,
    buyer_user_id: UUID,
    customer_kind: str = "b2c",
    buyer_country: str = "FR",
    return_url: str,
    locale: str = "fr",
    withdrawal_waiver_accepted: bool = False,
    withdrawal_waiver_at: str | None = None,
    withdrawal_waiver_statement: str | None = None,
    provider_idempotency_key: str | None = None,
    checkout_expires_at: datetime | None = None,
    provider: Any | None = None,
) -> dict[str, Any]:
    """Quote EU OSS / B2B VAT and issue a web-only Stripe Connect Checkout link outside `transaction.atomic()`."""
    if connection.in_atomic_block:
        raise RuntimeError(
            "issue_marketplace_connect_checkout_link must execute outside transaction.atomic()"
        )
    if pricing_mode != "one_time":
        raise vip_connect.VipConnectValidationError(f"unsupported pricing_mode {pricing_mode!r}")
    if not CONNECT_ACCOUNT_ID.fullmatch(seller_connect_account_id):
        raise vip_connect.VipConnectValidationError("invalid seller_connect_account_id")
    if locale not in {"fr", "en"}:
        raise vip_connect.VipConnectValidationError("unsupported locale")
    check_return_url(return_url)

    now = timezone.now()
    if customer_kind == "b2b":
        profile, server_vies_valid = boosts.resolve_server_b2b_vat_status(
            organisation_id=organisation_id,
            now=now,
        )
        eff_country = profile.country
        eff_exempt = profile.vat_exempt
    elif customer_kind == "b2c":
        eff_country = buyer_country.strip().upper()
        server_vies_valid = False
        eff_exempt = False
    else:
        raise vip_connect.VipConnectValidationError(f"unsupported customer_kind {customer_kind!r}")

    boosts.verify_b2c_withdrawal_waiver(
        customer_kind=customer_kind,
        scope=f"extension-marketplace:{workspace_id}",
        offer_code=listing_slug,
        buyer_ref=str(buyer_user_id),
        withdrawal_waiver_accepted=withdrawal_waiver_accepted,
        withdrawal_waiver_at=_parse_iso_datetime(withdrawal_waiver_at),
        withdrawal_waiver_statement=withdrawal_waiver_statement,
        now=now,
    )

    quote = vip_connect.quote_vip_pass(
        tier_code=listing_slug,
        billing_period="one_time",
        price_excl_vat_minor=price_excl_vat_minor,
        platform_fee_bps=platform_fee_bps,
        buyer_country=eff_country,
        customer_kind=customer_kind,
        vat_number_validated=server_vies_valid,
        vat_exempt=eff_exempt,
    )
    active_provider = provider if provider is not None else payments_pkg.configured_provider()
    checkout_label = (
        f"Extension Kodera — {listing_title}"
        if locale == "fr"
        else f"Kodera Extension — {listing_title}"
    )
    det_idem_key = provider_idempotency_key or f"mkt-checkout-{entitlement_id}-0"
    effective_expires_at = (
        checkout_expires_at if checkout_expires_at is not None else (now + timedelta(hours=23))
    )
    issued = active_provider.create_link(
        LinkRequest(
            invoice_id=entitlement_id,
            invoice_number=listing_slug.upper(),
            amount_minor=quote.total_incl_vat_minor,
            currency="EUR",
            expires_at=effective_expires_at,
            return_url=return_url,
            locale=locale,
            connect_destination_account=seller_connect_account_id,
            application_fee_amount_minor=quote.stripe_application_fee_minor,
            payment_methods=("card",),
            reference_kind="extension_marketplace",
            checkout_label=checkout_label,
            idempotency_key=det_idem_key,
            customer_ref=(
                payments_pkg.services.existing_stripe_customer_ref(organisation_id=organisation_id)
                if getattr(active_provider, "name", "") == "stripe"
                else None
            ),
            metadata={
                "volet": "h4_extension_marketplace",
                "kodera_checkout_kind": "extension_marketplace",
                "kodera_marketplace_entitlement_id": str(entitlement_id),
                "marketplace_entitlement_id": str(entitlement_id),
                "workspace_id": str(workspace_id),
            },
        )
    )
    return {
        "checkout_session_id": issued.provider_ref,
        "checkout_url": issued.url,
        "vat_regime": quote.vat_regime.code,
        "vat_rate_bp": quote.vat_regime.rate_bp,
        "gross_excl_vat_minor": quote.gross_excl_vat_minor,
        "vat_amount_minor": quote.vat_amount_minor,
        "total_incl_vat_minor": quote.total_incl_vat_minor,
        "application_fee_amount_minor": quote.application_fee_amount_minor,
        "creator_net_minor": quote.creator_net_minor,
    }

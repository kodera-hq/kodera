"""Web-only Extension Marketplace catalogue, Stripe Connect checkout, and installation."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import secrets
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.billing import boosts, monetization_services
from apps.billing.payments.port import (
    ProviderRefusedError,
    ProviderUnavailableError,
    ReturnUrlRequiredError,
)
from apps.billing.payments.services import ReturnUrlRefusedError
from apps.billing.switch import billing_enabled
from apps.media import outbound
from apps.orgs.selectors import membership_user_id
from core import sealing
from core.db.ids import new_uuid7

from . import services, widgets
from .models import ExtensionMarketplaceListing, Installation, MarketplaceEntitlement
from .wire import EVENTS, ExtensionRefusedError, canonical

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\Z")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\Z")
COMMAND_NAME_RE = re.compile(r"^/[a-z][a-z0-9-]{1,31}\Z")
IDEMPOTENCY_KEY_RE = re.compile(r"^[\x21-\x7e]{1,128}\Z")

ALLOWED_MANIFEST_SCOPES = frozenset(
    {
        "messages:read",
        "messages:write",
        "ephemeral:write",
        "channels:read",
        "commands:register",
        "webhooks:incoming",
        "incidents:write",
        "threads:write",
        "docs:read",
        "docs:write",
        "widgets:write",
    }
)
ALLOWED_PRICING_MODES = frozenset({"free", "one_time"})
MAX_MANIFEST_BYTES = 32 * 1024
MAX_PRICE_EXCL_VAT_MINOR = 10_000_000
MIN_PAID_PRICE_EXCL_VAT_MINOR = 100


def _check_printable(value: Any, *, field: str, min_len: int = 1, max_len: int = 280) -> str:
    if not isinstance(value, str):
        raise ExtensionRefusedError(f"marketplace_{field}_invalid", 422)
    trimmed = value.strip()
    if not (min_len <= len(trimmed) <= max_len) or any(
        ord(ch) < 32 or ord(ch) == 127 for ch in trimmed
    ):
        raise ExtensionRefusedError(f"marketplace_{field}_invalid", 422)
    return trimmed


def _validate_public_https_endpoint(raw_url: Any) -> str:
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise ExtensionRefusedError("marketplace_endpoint_invalid", 422)
    try:
        parsed = outbound.target(raw_url.strip(), https_only=True)
    except outbound.BlockedTargetError:
        raise ExtensionRefusedError("marketplace_endpoint_blocked", 422) from None
    host = parsed.host
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ExtensionRefusedError("marketplace_endpoint_blocked", 422)
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        try:
            outbound.public_address(host)
        except outbound.BlockedTargetError:
            raise ExtensionRefusedError("marketplace_endpoint_blocked", 422) from None
    return parsed.url


def validate_extension_manifest(
    raw_manifest: Any, *, expected_slug: str | None = None
) -> dict[str, Any]:
    """Validate an extension manifest including optional declarative `kodera.widget.v1` templates."""
    if not isinstance(raw_manifest, dict):
        raise ExtensionRefusedError("marketplace_manifest_invalid", 422)
    allowed_keys = {
        "schemaVersion",
        "schema",
        "id",
        "slug",
        "name",
        "version",
        "description",
        "scopes",
        "events",
        "commands",
        "widgets",
        "webhookUrl",
        "endpoint",
    }
    if set(raw_manifest) - allowed_keys:
        raise ExtensionRefusedError("marketplace_manifest_invalid", 422)

    slug = raw_manifest.get("slug") if "slug" in raw_manifest else raw_manifest.get("id")
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ExtensionRefusedError("marketplace_slug_invalid", 422)
    if expected_slug is not None and slug != expected_slug:
        raise ExtensionRefusedError("marketplace_slug_mismatch", 422)

    name = _check_printable(raw_manifest.get("name"), field="name", max_len=80)
    version = raw_manifest.get("version")
    if not isinstance(version, str) or not SEMVER_RE.fullmatch(version):
        raise ExtensionRefusedError("marketplace_version_invalid", 422)
    description = _check_printable(
        raw_manifest.get("description"), field="description", max_len=280
    )

    scopes = raw_manifest.get("scopes")
    if (
        not isinstance(scopes, list)
        or not (1 <= len(scopes) <= len(ALLOWED_MANIFEST_SCOPES))
        or len(set(scopes)) != len(scopes)
        or any(not isinstance(sc, str) or sc not in ALLOWED_MANIFEST_SCOPES for sc in scopes)
    ):
        raise ExtensionRefusedError("marketplace_scopes_invalid", 422)

    events = raw_manifest.get("events")
    if (
        not isinstance(events, list)
        or not (1 <= len(events) <= len(EVENTS))
        or len(set(events)) != len(events)
        or any(not isinstance(ev, str) or ev not in EVENTS for ev in events)
    ):
        raise ExtensionRefusedError("marketplace_events_invalid", 422)
    if "widget.action" in events and "widgets:write" not in scopes:
        raise ExtensionRefusedError("marketplace_widget_scope_required", 422)

    raw_endpoint = (
        raw_manifest.get("endpoint")
        if raw_manifest.get("endpoint") is not None
        else raw_manifest.get("webhookUrl")
    )
    endpoint = _validate_public_https_endpoint(raw_endpoint)

    normalized_commands: list[dict[str, str]] = []
    raw_commands = raw_manifest.get("commands")
    if raw_commands is not None:
        if not isinstance(raw_commands, list) or len(raw_commands) > 16:
            raise ExtensionRefusedError("marketplace_commands_invalid", 422)
        if raw_commands and "commands:register" not in scopes:
            raise ExtensionRefusedError("marketplace_commands_scope_required", 422)
        seen_cmds: set[str] = set()
        for cmd in raw_commands:
            if not isinstance(cmd, dict) or set(cmd) - {"name", "description", "usage"}:
                raise ExtensionRefusedError("marketplace_commands_invalid", 422)
            cmd_name = cmd.get("name")
            if (
                not isinstance(cmd_name, str)
                or not COMMAND_NAME_RE.fullmatch(cmd_name)
                or cmd_name in seen_cmds
            ):
                raise ExtensionRefusedError("marketplace_commands_invalid", 422)
            seen_cmds.add(cmd_name)
            normalized_commands.append(
                {
                    "name": cmd_name,
                    "description": _check_printable(
                        cmd.get("description"), field="command_description", max_len=140
                    ),
                }
            )

    normalized_widgets: list[dict[str, Any]] = []
    raw_widgets = raw_manifest.get("widgets")
    if raw_widgets is not None:
        if not isinstance(raw_widgets, list) or len(raw_widgets) > 8:
            raise ExtensionRefusedError("marketplace_widgets_invalid", 422)
        if raw_widgets and "widgets:write" not in scopes:
            raise ExtensionRefusedError("marketplace_widget_scope_required", 422)
        seen_widgets: set[str] = set()
        for entry in raw_widgets:
            if not isinstance(entry, dict) or set(entry) - {
                "id",
                "title",
                "description",
                "defaultCard",
                "default_card",
            }:
                raise ExtensionRefusedError("marketplace_widgets_invalid", 422)
            wid = entry.get("id")
            if not isinstance(wid, str) or not SLUG_RE.fullmatch(wid) or wid in seen_widgets:
                raise ExtensionRefusedError("marketplace_widgets_invalid", 422)
            seen_widgets.add(wid)
            w_out: dict[str, Any] = {
                "id": wid,
                "title": _check_printable(entry.get("title"), field="widget_title", max_len=80),
            }
            if entry.get("description") is not None:
                w_out["description"] = _check_printable(
                    entry.get("description"), field="widget_description", max_len=200
                )
            raw_default_card = (
                entry["defaultCard"]
                if entry.get("defaultCard") is not None
                else entry.get("default_card")
            )
            if raw_default_card is not None:
                validated_card = widgets.validate_widget_card(raw_default_card)
                if validated_card["widgetId"] != wid:
                    raise ExtensionRefusedError("marketplace_widget_card_mismatch", 422)
                w_out["defaultCard"] = validated_card
            normalized_widgets.append(w_out)

    normalized: dict[str, Any] = {
        "schemaVersion": "kodera.extension.v1",
        "slug": slug,
        "name": name,
        "version": version,
        "description": description,
        "scopes": sorted(scopes),
        "events": sorted(events),
        "commands": normalized_commands,
        "widgets": normalized_widgets,
        "endpoint": endpoint,
    }
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise ExtensionRefusedError("marketplace_manifest_too_large", 413)
    return normalized


def serialize_listing(
    listing: ExtensionMarketplaceListing,
    entitlement: MarketplaceEntitlement | None = None,
) -> dict[str, Any]:
    return {
        "id": str(listing.id),
        "workspaceId": str(listing.workspace_id),
        "slug": listing.slug,
        "title": listing.title,
        "summary": listing.summary,
        "pricingMode": listing.pricing_mode,
        "priceExclVatMinor": listing.price_excl_vat_minor,
        "currency": listing.currency,
        "manifest": listing.manifest,
        "publishedAt": (
            listing.published_at.isoformat() if listing.published_at is not None else None
        ),
        "entitlementState": entitlement.state if entitlement is not None else None,
        "entitlementId": str(entitlement.id) if entitlement is not None else None,
        "installed": bool(entitlement is not None and entitlement.installation_id is not None),
        "installationId": (
            str(entitlement.installation_id)
            if entitlement is not None and entitlement.installation_id is not None
            else None
        ),
    }


@transaction.atomic
def list_marketplace_listings(*, verified: Any, organisation_id: UUID) -> dict[str, Any]:
    workspace_id, _ = services.read_member(verified, organisation_id)
    listings = list(
        ExtensionMarketplaceListing.objects.filter(
            workspace_id=workspace_id,
            published_at__isnull=False,
            revoked_at__isnull=True,
        ).order_by("created_at", "id")[:100]
    )
    entitlements = list(
        MarketplaceEntitlement.objects.filter(
            workspace_id=workspace_id,
            listing_id__in=[row.id for row in listings],
            revoked_at__isnull=True,
            state__in=("pending", "active"),
        ).order_by("-created_at")
    )
    by_listing: dict[UUID, MarketplaceEntitlement] = {}
    for ent in entitlements:
        prev = by_listing.get(ent.listing_id)
        if prev is None or (prev.state != "active" and ent.state == "active"):
            by_listing[ent.listing_id] = ent

    return {
        "billingEnabled": billing_enabled(),
        "listings": [serialize_listing(row, by_listing.get(row.id)) for row in listings],
    }


@transaction.atomic
def publish_marketplace_listing(
    *,
    verified: Any,
    organisation_id: UUID,
    slug: str,
    title: str,
    summary: str,
    manifest: dict[str, Any],
    pricing_mode: str = "free",
    price_excl_vat_minor: int = 0,
) -> dict[str, Any]:
    workspace_id, principal = services.admin(verified, organisation_id)
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ExtensionRefusedError("marketplace_slug_invalid", 422)
    clean_title = _check_printable(title, field="title", max_len=80)
    clean_summary = _check_printable(summary, field="summary", max_len=280)
    if not isinstance(pricing_mode, str) or pricing_mode not in ALLOWED_PRICING_MODES:
        raise ExtensionRefusedError("marketplace_pricing_mode_invalid", 422)
    if type(price_excl_vat_minor) is not int:
        raise ExtensionRefusedError("marketplace_price_invalid", 422)

    validated_manifest = validate_extension_manifest(manifest, expected_slug=slug)

    seller_connect_account_id: str | None = None
    if pricing_mode == "free":
        if price_excl_vat_minor != 0:
            raise ExtensionRefusedError("marketplace_free_price_nonzero", 422)
    else:
        if not billing_enabled():
            raise ExtensionRefusedError("billing-disabled", 409)
        if not (MIN_PAID_PRICE_EXCL_VAT_MINOR <= price_excl_vat_minor <= MAX_PRICE_EXCL_VAT_MINOR):
            raise ExtensionRefusedError("marketplace_price_invalid", 422)
        from apps.billing import vip_connect

        try:
            seller = monetization_services.resolve_workspace_seller_connect_account(
                organisation_id=organisation_id,
                workspace_id=workspace_id,
            )
        except vip_connect.ConnectPlatformConfigurationError as exc:
            raise ExtensionRefusedError("payment_platform_unavailable", 503) from exc
        if (
            seller is None
            or not seller.stripe_connect_account_id
            or not seller.platform_matches
            or seller.onboarding_state != "active"
            or not seller.charges_enabled
            or not seller.payouts_enabled
        ):
            raise ExtensionRefusedError("marketplace_connect_account_not_ready", 409)
        seller_connect_account_id = seller.stripe_connect_account_id

    now = timezone.now()
    try:
        listing = ExtensionMarketplaceListing.objects.create(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            creator_id=principal.membership_id,
            slug=slug,
            title=clean_title,
            summary=clean_summary,
            manifest=validated_manifest,
            pricing_mode=pricing_mode,
            price_excl_vat_minor=price_excl_vat_minor,
            currency="EUR",
            seller_connect_account_id=seller_connect_account_id,
            published_at=now,
        )
    except IntegrityError:
        raise ExtensionRefusedError("marketplace_slug_conflict", 409) from None

    services.audit(
        "marketplace_listing_published",
        principal,
        organisation_id,
        listing.id,
        {
            "slug": listing.slug,
            "pricing_mode": listing.pricing_mode,
            "price_excl_vat_minor": listing.price_excl_vat_minor,
        },
    )
    return serialize_listing(listing)


def _serialize_checkout(
    entitlement: MarketplaceEntitlement,
    *,
    pricing_mode: str,
    replayed: bool,
) -> dict[str, Any]:
    return {
        "entitlementId": str(entitlement.id),
        "listingId": str(entitlement.listing_id),
        "pricingMode": pricing_mode,
        "state": entitlement.state,
        "checkoutRequired": entitlement.state == "pending",
        "checkoutSessionId": entitlement.checkout_ref,
        "checkoutUrl": entitlement.checkout_url,
        "grossExclVatMinor": entitlement.gross_excl_vat_minor,
        "vatAmountMinor": entitlement.vat_amount_minor,
        "totalInclVatMinor": entitlement.total_incl_vat_minor,
        "applicationFeeAmountMinor": entitlement.application_fee_amount_minor,
        "currency": "EUR",
        "replayed": replayed,
    }


def _try_acquire_checkout_key_lock(*, workspace_id: UUID, idempotency_key: str) -> tuple[bool, int]:
    digest = hashlib.sha256(f"mkt-checkout:{workspace_id}:{idempotency_key}".encode()).digest()
    lock_key = int.from_bytes(digest[:8], "big", signed=True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [lock_key])
        acquired = bool(cursor.fetchone()[0])
    return acquired, lock_key


def _release_checkout_key_lock(lock_key: int) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_unlock(%s)", [lock_key])


def checkout_marketplace_listing(
    *,
    verified: Any,
    organisation_id: UUID,
    listing_id: UUID,
    idempotency_key: str,
    customer_kind: str = "b2c",
    buyer_country: str = "FR",
    return_url: str | None = None,
    locale: str = "fr",
    withdrawal_waiver_accepted: bool = False,
    withdrawal_waiver_at: str | None = None,
    withdrawal_waiver_statement: str | None = None,
    provider: Any | None = None,
) -> dict[str, Any]:
    """Grant a free marketplace entitlement or issue a web-only Stripe Connect Checkout link outside `transaction.atomic()`."""
    if connection.in_atomic_block:
        raise RuntimeError("checkout_marketplace_listing must execute outside transaction.atomic()")
    if (
        not isinstance(idempotency_key, str)
        or not IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key)
        or idempotency_key.startswith("auto-free-install:")
    ):
        raise ExtensionRefusedError("idempotency_key_invalid", 400)

    request_digest = hashlib.sha256(
        canonical(
            {
                "listing_id": str(listing_id),
                "customer_kind": customer_kind,
                "buyer_country": buyer_country,
                "return_url": return_url,
                "locale": locale,
                "withdrawal_waiver_accepted": withdrawal_waiver_accepted,
            }
        )
    ).hexdigest()

    from apps.billing import vip_connect

    lock_key: int | None = None
    try:
        with transaction.atomic():
            workspace_id, principal = services.member(verified, organisation_id)
            listing = (
                ExtensionMarketplaceListing.objects.select_for_update()
                .filter(
                    id=listing_id,
                    workspace_id=workspace_id,
                    published_at__isnull=False,
                    revoked_at__isnull=True,
                )
                .first()
            )
            if listing is None:
                raise ExtensionRefusedError("marketplace_listing_absent", 404)

            acquired, candidate_lock = _try_acquire_checkout_key_lock(
                workspace_id=workspace_id, idempotency_key=idempotency_key
            )
            if not acquired:
                raise ExtensionRefusedError("idempotency_key_in_flight", 409)
            lock_key = candidate_lock

            prior_idem = (
                MarketplaceEntitlement.objects.select_for_update()
                .filter(workspace_id=workspace_id, idempotency_key=idempotency_key)
                .first()
            )
            if prior_idem is not None:
                if (
                    prior_idem.request_sha256 != request_digest
                    or prior_idem.listing_id != listing.id
                ):
                    raise ExtensionRefusedError("idempotency_key_reused", 409)
                if prior_idem.state == "active":
                    return _serialize_checkout(
                        prior_idem, pricing_mode=listing.pricing_mode, replayed=True
                    )
                if prior_idem.state in ("revoked", "refunded"):
                    raise ExtensionRefusedError("idempotency_key_reused", 409)
                # `state == 'pending'` is verified against active seller platform/mode readiness
                # before replaying a cached checkout URL or retrying session creation below.

            if listing.pricing_mode not in ("free", "one_time"):
                raise ExtensionRefusedError("marketplace_pricing_mode_invalid", 422)
            if listing.pricing_mode == "one_time" and not billing_enabled():
                raise ExtensionRefusedError("billing-disabled", 409)

            existing_for_listing = (
                MarketplaceEntitlement.objects.select_for_update()
                .filter(
                    workspace_id=workspace_id,
                    listing=listing,
                    state__in=("active", "pending"),
                    revoked_at__isnull=True,
                )
                .order_by("-created_at")
                .first()
            )
            if existing_for_listing is not None:
                if existing_for_listing.state == "active":
                    raise ExtensionRefusedError("marketplace_already_entitled", 409)
                if (
                    existing_for_listing.state == "pending"
                    and existing_for_listing.checkout_ref is not None
                    and (prior_idem is None or prior_idem.id != existing_for_listing.id)
                ):
                    raise ExtensionRefusedError("checkout_already_pending", 409)

            if listing.pricing_mode == "free":
                reusable_free = prior_idem or existing_for_listing
                if reusable_free is not None:
                    reusable_free.buyer_membership_id = principal.membership_id
                    reusable_free.idempotency_key = idempotency_key
                    reusable_free.request_sha256 = request_digest
                    reusable_free.state = "active"
                    reusable_free.save(
                        update_fields=[
                            "buyer_membership_id",
                            "idempotency_key",
                            "request_sha256",
                            "state",
                            "updated_at",
                        ]
                    )
                    entitlement = reusable_free
                else:
                    entitlement = MarketplaceEntitlement.objects.create(
                        organisation_id=organisation_id,
                        workspace_id=workspace_id,
                        buyer_membership_id=principal.membership_id,
                        listing=listing,
                        state="active",
                        idempotency_key=idempotency_key,
                        request_sha256=request_digest,
                    )
                services.audit(
                    "marketplace_checkout_started",
                    principal,
                    organisation_id,
                    listing.id,
                    {
                        "listing_id": str(listing.id),
                        "pricing_mode": listing.pricing_mode,
                        "state": "active",
                    },
                )
                return _serialize_checkout(
                    entitlement, pricing_mode=listing.pricing_mode, replayed=False
                )

            if listing.pricing_mode != "one_time":
                raise ExtensionRefusedError("marketplace_pricing_mode_invalid", 422)

            if not billing_enabled():
                raise ExtensionRefusedError("billing-disabled", 409)
            if not isinstance(return_url, str) or not return_url.strip():
                raise ExtensionRefusedError("marketplace_return_url_required", 422)

            try:
                seller = monetization_services.resolve_workspace_seller_connect_account(
                    organisation_id=organisation_id,
                    workspace_id=workspace_id,
                    for_update=True,
                )
            except vip_connect.ConnectPlatformConfigurationError as exc:
                raise ExtensionRefusedError("payment_platform_unavailable", 503) from exc
            if (
                seller is None
                or not seller.platform_matches
                or not seller.stripe_connect_account_id
                or seller.onboarding_state != "active"
                or not seller.charges_enabled
                or not seller.payouts_enabled
                or listing.seller_connect_account_id != seller.stripe_connect_account_id
            ):
                raise ExtensionRefusedError("marketplace_connect_account_not_ready", 409)
            if prior_idem is not None and prior_idem.state == "pending":
                if (
                    prior_idem.stripe_account_id,
                    prior_idem.stripe_livemode,
                ) != (
                    seller.stripe_platform_account_id,
                    seller.stripe_livemode,
                ):
                    raise ExtensionRefusedError("marketplace_connect_account_not_ready", 409)
                if prior_idem.checkout_ref is not None and prior_idem.checkout_url is not None:
                    return _serialize_checkout(
                        prior_idem, pricing_mode=listing.pricing_mode, replayed=True
                    )
            if (
                prior_idem is None
                and existing_for_listing is not None
                and existing_for_listing.state == "pending"
                and (
                    existing_for_listing.stripe_account_id,
                    existing_for_listing.stripe_livemode,
                )
                != (
                    seller.stripe_platform_account_id,
                    seller.stripe_livemode,
                )
            ):
                if (
                    existing_for_listing.checkout_ref is not None
                    or existing_for_listing.payment_intent_id is not None
                ):
                    raise ExtensionRefusedError("checkout_already_pending", 409)
                existing_for_listing.state = "revoked"
                existing_for_listing.revoked_at = timezone.now()
                existing_for_listing.checkout_url = None
                existing_for_listing.save(
                    update_fields=["state", "revoked_at", "checkout_url", "updated_at"]
                )
                existing_for_listing = None

            buyer_user_id = membership_user_id(membership_id=principal.membership_id)
            reusable_pending = prior_idem or existing_for_listing
            if reusable_pending is not None:
                if (
                    reusable_pending.buyer_membership_id != principal.membership_id
                    or reusable_pending.idempotency_key != idempotency_key
                    or reusable_pending.request_sha256 != request_digest
                ):
                    reusable_pending.buyer_membership_id = principal.membership_id
                    reusable_pending.idempotency_key = idempotency_key
                    reusable_pending.request_sha256 = request_digest
                    reusable_pending.save(
                        update_fields=[
                            "buyer_membership_id",
                            "idempotency_key",
                            "request_sha256",
                            "updated_at",
                        ]
                    )
                entitlement = reusable_pending
            else:
                entitlement = MarketplaceEntitlement.objects.create(
                    organisation_id=organisation_id,
                    workspace_id=workspace_id,
                    buyer_membership_id=principal.membership_id,
                    listing=listing,
                    state="pending",
                    stripe_account_id=seller.stripe_platform_account_id,
                    stripe_livemode=seller.stripe_livemode,
                    idempotency_key=idempotency_key,
                    request_sha256=request_digest,
                )
            entitlement_id = entitlement.id
            attempt_epoch = (
                MarketplaceEntitlement.objects.filter(workspace_id=workspace_id, listing=listing)
                .exclude(id=entitlement_id)
                .count()
            )
            now_epoch = int(timezone.now().timestamp())
            created_epoch = int(entitlement.created_at.timestamp())
            elapsed_s = max(0, now_epoch - created_epoch)
            time_bucket = elapsed_s // (22 * 3600)
            anchor_expires_epoch = created_epoch + time_bucket * (22 * 3600) + 23 * 3600
            checkout_expires_at = datetime.fromtimestamp(anchor_expires_epoch, UTC)
            epoch_suffix = (
                f"{attempt_epoch}-{time_bucket}" if time_bucket > 0 else f"{attempt_epoch}"
            )
            provider_idem_key = f"mkt-checkout-{entitlement_id}-{epoch_suffix}"
            listing_slug = listing.slug
            listing_title = listing.title
            listing_pricing_mode = listing.pricing_mode
            listing_price_minor = listing.price_excl_vat_minor
            seller_account_id = seller.stripe_connect_account_id
            platform_fee_bps = seller.platform_fee_bps

        try:
            issued = monetization_services.issue_marketplace_connect_checkout_link(
                organisation_id=organisation_id,
                workspace_id=workspace_id,
                entitlement_id=entitlement_id,
                listing_slug=listing_slug,
                listing_title=listing_title,
                pricing_mode=listing_pricing_mode,
                price_excl_vat_minor=listing_price_minor,
                seller_connect_account_id=seller_account_id,
                platform_fee_bps=platform_fee_bps,
                buyer_user_id=buyer_user_id,
                customer_kind=customer_kind,
                buyer_country=buyer_country,
                return_url=return_url,
                locale=locale,
                withdrawal_waiver_accepted=withdrawal_waiver_accepted,
                withdrawal_waiver_at=withdrawal_waiver_at,
                withdrawal_waiver_statement=withdrawal_waiver_statement,
                provider_idempotency_key=provider_idem_key,
                checkout_expires_at=checkout_expires_at,
                provider=provider,
            )
        except (
            vip_connect.VipConnectValidationError,
            boosts.BoostValidationError,
            boosts.WithdrawalWaiverRequiredError,
            ReturnUrlRequiredError,
            ReturnUrlRefusedError,
            ProviderRefusedError,
            ValueError,
        ) as exc:
            with transaction.atomic():
                MarketplaceEntitlement.objects.filter(id=entitlement_id, state="pending").update(
                    state="revoked",
                    revoked_at=timezone.now(),
                    updated_at=timezone.now(),
                )
            raise ExtensionRefusedError("marketplace_checkout_invalid", 422) from exc
        except ProviderUnavailableError as exc:
            # Leave `state == 'pending'` with `checkout_ref=None` so retrying with the same
            # `Idempotency-Key` (CONVENTIONS §8 `5xx` retry) or a fresh key recovers cleanly!
            raise ExtensionRefusedError("marketplace_payment_provider_unavailable", 503) from exc

        stale_session_to_cancel: tuple[list[str], str | None, bool | None] | None = None
        with transaction.atomic():
            listing_after = ExtensionMarketplaceListing.objects.select_for_update().get(
                id=listing.id
            )
            try:
                seller_after = monetization_services.resolve_workspace_seller_connect_account(
                    organisation_id=organisation_id,
                    workspace_id=workspace_id,
                    for_update=True,
                )
            except vip_connect.ConnectPlatformConfigurationError:
                seller_after = None
            entitlement = MarketplaceEntitlement.objects.select_for_update().get(id=entitlement_id)
            seller_still_valid = (
                entitlement.state == "pending"
                and listing_after.published_at is not None
                and listing_after.revoked_at is None
                and seller_after is not None
                and seller_after.platform_matches
                and seller_after.stripe_connect_account_id == seller_account_id
                and listing_after.seller_connect_account_id == seller_account_id
                and seller_after.onboarding_state == "active"
                and seller_after.charges_enabled
                and seller_after.payouts_enabled
                and (entitlement.stripe_account_id, entitlement.stripe_livemode)
                == (seller_after.stripe_platform_account_id, seller_after.stripe_livemode)
            )
            stale_refs: list[str] = []
            if not seller_still_valid:
                stale_refs.append(str(issued["checkout_session_id"]))
                if entitlement.checkout_ref and entitlement.checkout_ref != stale_refs[0]:
                    stale_refs.append(str(entitlement.checkout_ref))
                if entitlement.state == "pending":
                    entitlement.state = "revoked"
                    entitlement.revoked_at = timezone.now()
                    entitlement.checkout_url = None
                    entitlement.save(
                        update_fields=["state", "revoked_at", "checkout_url", "updated_at"]
                    )
                stale_session_to_cancel = (
                    stale_refs,
                    entitlement.stripe_account_id,
                    entitlement.stripe_livemode,
                )
            elif entitlement.checkout_ref is not None and entitlement.checkout_url is not None:
                return _serialize_checkout(
                    entitlement, pricing_mode=listing_pricing_mode, replayed=True
                )
            else:
                entitlement.checkout_ref = str(issued["checkout_session_id"])
                entitlement.checkout_url = str(issued["checkout_url"])
                entitlement.gross_excl_vat_minor = int(issued["gross_excl_vat_minor"])
                entitlement.vat_amount_minor = int(issued["vat_amount_minor"])
                entitlement.total_incl_vat_minor = int(issued["total_incl_vat_minor"])
                entitlement.application_fee_amount_minor = int(
                    issued["application_fee_amount_minor"]
                )
                entitlement.save(
                    update_fields=[
                        "checkout_ref",
                        "checkout_url",
                        "gross_excl_vat_minor",
                        "vat_amount_minor",
                        "total_incl_vat_minor",
                        "application_fee_amount_minor",
                        "updated_at",
                    ]
                )
                services.audit(
                    "marketplace_checkout_started",
                    principal,
                    organisation_id,
                    listing_id,
                    {
                        "listing_id": str(listing_id),
                        "pricing_mode": listing_pricing_mode,
                        "state": "pending",
                    },
                )
                return _serialize_checkout(
                    entitlement, pricing_mode=listing_pricing_mode, replayed=False
                )

        if stale_session_to_cancel is None:
            raise RuntimeError("unreachable: marketplace checkout neither saved nor revoked")
        session_refs, bound_acct, bound_mode = stale_session_to_cancel
        import contextlib

        from apps.billing.payments.services import connect_checkout_binding_matches_runtime

        if connect_checkout_binding_matches_runtime(
            stripe_account_id=bound_acct, stripe_livemode=bound_mode
        ):
            active_provider = (
                provider
                if provider is not None
                else monetization_services.payments_pkg.configured_provider()
            )
            for session_ref in session_refs:
                with contextlib.suppress(Exception):
                    active_provider.cancel_link(session_ref)
        raise ExtensionRefusedError("marketplace_connect_account_not_ready", 409)
    finally:
        if lock_key is not None:
            _release_checkout_key_lock(lock_key)


@transaction.atomic
def settle_marketplace_checkout(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    entitlement_id: UUID,
    checkout_ref: str,
    payment_intent_id: str | None = None,
) -> MarketplaceEntitlement:
    """Activate a pending paid marketplace entitlement once provider settlement is verified."""
    entitlement = (
        MarketplaceEntitlement.objects.select_for_update()
        .filter(
            id=entitlement_id,
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            revoked_at__isnull=True,
        )
        .first()
    )
    if entitlement is None or entitlement.checkout_ref != checkout_ref:
        raise ExtensionRefusedError("marketplace_entitlement_absent", 404)
    if entitlement.state == "active":
        if payment_intent_id and entitlement.payment_intent_id is None:
            entitlement.payment_intent_id = payment_intent_id
            entitlement.save(update_fields=["payment_intent_id", "updated_at"])
        return entitlement
    if entitlement.state != "pending":
        raise ExtensionRefusedError("marketplace_entitlement_state_invalid", 409)
    entitlement.state = "active"
    entitlement.checkout_url = None
    update_fields = ["state", "checkout_url", "updated_at"]
    if payment_intent_id and entitlement.payment_intent_id is None:
        entitlement.payment_intent_id = payment_intent_id
        update_fields.append("payment_intent_id")
    entitlement.save(update_fields=update_fields)
    return entitlement


def _marketplace_entitlement_matches_runtime_stripe(
    entitlement: MarketplaceEntitlement,
) -> bool:
    from apps.billing.payments.services import connect_checkout_binding_matches_runtime

    return connect_checkout_binding_matches_runtime(
        entitlement.stripe_account_id,
        entitlement.stripe_livemode,
    )


@transaction.atomic
def try_settle_stripe_checkout_session(
    *,
    session_id: str,
    event_type: str,
    payment_status: Any,
    payment_intent_id: str | None,
    amount_minor: int | None,
    currency: str | None,
    meta_entitlement_id: UUID | None = None,
    has_meta_entitlement: bool = False,
) -> tuple[str, UUID | None, UUID | None] | None:
    """Settle a pending `MarketplaceEntitlement` from a verified Stripe Checkout webhook."""
    entitlement = (
        MarketplaceEntitlement.objects.select_for_update().filter(checkout_ref=session_id).first()
    )
    if entitlement is None and meta_entitlement_id is not None:
        candidate = (
            MarketplaceEntitlement.objects.select_for_update()
            .filter(id=meta_entitlement_id)
            .first()
        )
        if candidate is not None and candidate.checkout_ref in (None, session_id):
            entitlement = candidate
    if entitlement is None:
        return None
    org_id = entitlement.organisation_id
    if not _marketplace_entitlement_matches_runtime_stripe(entitlement):
        return "mismatch", org_id, entitlement.id
    if has_meta_entitlement and meta_entitlement_id != entitlement.id:
        return "mismatch", org_id, entitlement.id
    if event_type == "checkout.session.completed":
        if payment_status in ("unpaid", "processing"):
            return "ignored", org_id, entitlement.id
        if payment_status != "paid":
            return "mismatch", org_id, entitlement.id
    if (
        payment_intent_id is None
        or not payment_intent_id.strip()
        or amount_minor is None
        or currency is None
        or (amount_minor, currency.upper()) != (entitlement.total_incl_vat_minor, "EUR")
    ):
        return "mismatch", org_id, entitlement.id
    pi_id = payment_intent_id.strip()
    if entitlement.payment_intent_id is not None and entitlement.payment_intent_id != pi_id:
        return "mismatch", org_id, entitlement.id
    if entitlement.state == "active":
        if entitlement.payment_intent_id is None:
            entitlement.payment_intent_id = pi_id
            entitlement.save(update_fields=["payment_intent_id", "updated_at"])
        return "ignored", org_id, entitlement.id
    if entitlement.state != "pending" or entitlement.revoked_at is not None:
        return "ignored", org_id, entitlement.id
    if (
        MarketplaceEntitlement.objects.filter(
            workspace_id=entitlement.workspace_id,
            listing_id=entitlement.listing_id,
            state="active",
            revoked_at__isnull=True,
        )
        .exclude(id=entitlement.id)
        .exists()
    ):
        return "mismatch", org_id, entitlement.id
    entitlement.state = "active"
    if entitlement.checkout_ref is None:
        entitlement.checkout_ref = session_id
    entitlement.payment_intent_id = pi_id
    entitlement.checkout_url = None
    entitlement.save(
        update_fields=["state", "checkout_ref", "payment_intent_id", "checkout_url", "updated_at"]
    )
    return "applied", org_id, entitlement.id


@transaction.atomic
def try_settle_stripe_payment_intent(
    *,
    payment_intent_id: str,
    amount_minor: int,
    currency: str,
    meta_entitlement_id: UUID | None,
    meta_workspace_id: UUID | None,
    has_meta_entitlement: bool = False,
    has_meta_workspace: bool = False,
) -> tuple[str, UUID | None, UUID | None, str | None] | None:
    """Settle a pending `MarketplaceEntitlement` from a verified `payment_intent.succeeded` event."""
    entitlement = (
        MarketplaceEntitlement.objects.select_for_update()
        .filter(payment_intent_id=payment_intent_id)
        .first()
    )
    if entitlement is None and meta_entitlement_id is not None:
        entitlement = (
            MarketplaceEntitlement.objects.select_for_update()
            .filter(id=meta_entitlement_id)
            .first()
        )
    if entitlement is None:
        return None
    org_id = entitlement.organisation_id
    if not _marketplace_entitlement_matches_runtime_stripe(entitlement):
        return "mismatch", org_id, entitlement.id, entitlement.checkout_ref
    if has_meta_entitlement and meta_entitlement_id != entitlement.id:
        return "mismatch", org_id, entitlement.id, entitlement.checkout_ref
    if has_meta_workspace and meta_workspace_id != entitlement.workspace_id:
        return "mismatch", org_id, entitlement.id, entitlement.checkout_ref
    if (amount_minor, currency.upper()) != (entitlement.total_incl_vat_minor, "EUR"):
        return "mismatch", org_id, entitlement.id, entitlement.checkout_ref
    if (
        entitlement.payment_intent_id is not None
        and entitlement.payment_intent_id != payment_intent_id
    ):
        return "mismatch", org_id, entitlement.id, entitlement.checkout_ref
    if entitlement.state != "pending" or entitlement.revoked_at is not None:
        return "ignored", org_id, entitlement.id, entitlement.checkout_ref
    if (
        MarketplaceEntitlement.objects.filter(
            workspace_id=entitlement.workspace_id,
            listing_id=entitlement.listing_id,
            state="active",
            revoked_at__isnull=True,
        )
        .exclude(id=entitlement.id)
        .exists()
    ):
        return "mismatch", org_id, entitlement.id, entitlement.checkout_ref
    entitlement.state = "active"
    entitlement.payment_intent_id = payment_intent_id
    entitlement.checkout_url = None
    entitlement.save(update_fields=["state", "payment_intent_id", "checkout_url", "updated_at"])
    return "applied", org_id, entitlement.id, entitlement.checkout_ref


@transaction.atomic
def try_cancel_stripe_checkout_session(
    *, session_id: str, occurred_at: datetime | None = None
) -> tuple[str, UUID | None] | None:
    """Revoke an unpaid pending `MarketplaceEntitlement` on session expiry or async failure."""
    entitlement = (
        MarketplaceEntitlement.objects.select_for_update().filter(checkout_ref=session_id).first()
    )
    if entitlement is None:
        return None
    if not (
        entitlement.stripe_account_id is None and entitlement.stripe_livemode is None
    ) and not _marketplace_entitlement_matches_runtime_stripe(entitlement):
        return "mismatch", entitlement.organisation_id
    if entitlement.state != "pending" or entitlement.revoked_at is not None:
        return "ignored", entitlement.organisation_id
    ts = occurred_at or timezone.now()
    entitlement.state = "revoked"
    entitlement.revoked_at = ts
    entitlement.checkout_url = None
    entitlement.sealed_signing_secret = b""
    entitlement.save(
        update_fields=["state", "revoked_at", "checkout_url", "sealed_signing_secret", "updated_at"]
    )
    return "applied", entitlement.organisation_id


@transaction.atomic
def try_revoke_stripe_marketplace_entitlement(
    *,
    payment_intent_id: str,
    amount_minor: int,
    currency: str,
    occurred_at: datetime,
    terminal_state: str = "refunded",
    meta_entitlement_id: UUID | None = None,
    has_meta_entitlement: bool = False,
) -> tuple[str, UUID | None, UUID | None] | None:
    """Revoke an active/pending `MarketplaceEntitlement` and its bound `Installation` on refund or dispute."""
    if terminal_state not in ("refunded", "revoked"):
        raise ValueError("invalid terminal_state")
    entitlement = (
        MarketplaceEntitlement.objects.select_for_update()
        .filter(payment_intent_id=payment_intent_id)
        .first()
    )
    if entitlement is None and meta_entitlement_id is not None:
        candidate = (
            MarketplaceEntitlement.objects.select_for_update()
            .filter(id=meta_entitlement_id)
            .first()
        )
        if candidate is not None and candidate.payment_intent_id in (None, payment_intent_id):
            entitlement = candidate
    if entitlement is None:
        return None
    org_id = entitlement.organisation_id
    if not _marketplace_entitlement_matches_runtime_stripe(entitlement):
        return "mismatch", org_id, entitlement.id
    if has_meta_entitlement and meta_entitlement_id != entitlement.id:
        return "mismatch", org_id, entitlement.id
    if (
        currency.upper() != "EUR"
        or amount_minor <= 0
        or amount_minor > entitlement.total_incl_vat_minor
    ):
        return "mismatch", org_id, entitlement.id
    if entitlement.state in ("refunded", "revoked") and entitlement.revoked_at is not None:
        return "ignored", org_id, entitlement.id

    if entitlement.installation_id is not None:
        inst = (
            Installation.objects.select_for_update().filter(id=entitlement.installation_id).first()
        )
        if inst is not None and inst.revoked_at is None:
            inst.revoked_at = occurred_at
            inst.version = new_uuid7()
            inst.save(update_fields=["revoked_at", "version", "updated_at"])

    entitlement.state = terminal_state
    if entitlement.payment_intent_id is None:
        entitlement.payment_intent_id = payment_intent_id
    entitlement.revoked_at = entitlement.revoked_at or occurred_at
    entitlement.sealed_signing_secret = b""
    entitlement.checkout_url = None
    entitlement.save(
        update_fields=[
            "state",
            "payment_intent_id",
            "revoked_at",
            "sealed_signing_secret",
            "checkout_url",
            "updated_at",
        ]
    )
    return "applied", org_id, entitlement.id


@transaction.atomic
def install_marketplace_listing(
    *,
    verified: Any,
    organisation_id: UUID,
    listing_id: UUID,
    signing_secret: str,
    endpoint: str | None = None,
) -> dict[str, Any]:
    """Bind an active marketplace entitlement (or auto-grant free listing) to a workspace `Installation`."""
    workspace_id, principal = services.admin(verified, organisation_id)
    if (
        not isinstance(signing_secret, str)
        or not (32 <= len(signing_secret.encode("utf-8")) <= 512)
        or not signing_secret.isascii()
        or not signing_secret.isprintable()
    ):
        raise ExtensionRefusedError("extension_signing_secret_invalid", 422)

    listing = ExtensionMarketplaceListing.objects.filter(
        id=listing_id,
        workspace_id=workspace_id,
        published_at__isnull=False,
        revoked_at__isnull=True,
    ).first()
    if listing is None:
        raise ExtensionRefusedError("marketplace_listing_absent", 404)

    entitlement = (
        MarketplaceEntitlement.objects.select_for_update()
        .filter(
            workspace_id=workspace_id,
            listing=listing,
            state="active",
            revoked_at__isnull=True,
        )
        .first()
    )
    if entitlement is None:
        if listing.pricing_mode == "free":
            base_auto_key = f"auto-free-install:{listing.id}"
            auto_key = (
                f"{base_auto_key}:{secrets.token_hex(6)}"
                if MarketplaceEntitlement.objects.filter(
                    workspace_id=workspace_id, idempotency_key=base_auto_key
                ).exists()
                else base_auto_key
            )
            auto_hash = hashlib.sha256(auto_key.encode("ascii")).hexdigest()
            entitlement = MarketplaceEntitlement.objects.create(
                organisation_id=organisation_id,
                workspace_id=workspace_id,
                buyer_membership_id=principal.membership_id,
                listing=listing,
                state="active",
                idempotency_key=auto_key,
                request_sha256=auto_hash,
            )
        else:
            if not billing_enabled():
                raise ExtensionRefusedError("billing-disabled", 409)
            raise ExtensionRefusedError("marketplace_entitlement_required", 403)

    if entitlement.installation_id is not None:
        existing_inst = Installation.objects.get(id=entitlement.installation_id)
        return {
            "installationId": str(existing_inst.id),
            "entitlementId": str(entitlement.id),
            "listingId": str(listing.id),
            "slug": listing.slug,
            "endpoint": existing_inst.endpoint,
            "events": list(existing_inst.events),
            "keyGeneration": str(existing_inst.generation),
            "replayed": True,
        }

    manifest_endpoint = listing.manifest.get("endpoint")
    chosen_endpoint = _validate_public_https_endpoint(
        endpoint if endpoint is not None else manifest_endpoint
    )
    raw_events = listing.manifest.get("events")
    granted_events = sorted(
        [ev for ev in raw_events if isinstance(ev, str) and ev in EVENTS]
        if isinstance(raw_events, list) and raw_events
        else ["command.invoked"]
    )

    installation = Installation.objects.create(
        workspace_id=workspace_id,
        creator_id=principal.membership_id,
        name=listing.title,
        endpoint=chosen_endpoint,
        events=granted_events,
    )
    sealed_secret = sealing.seal(
        widgets.marketplace_seal_key(),
        widgets.marketplace_install_aad(organisation_id, installation.id),
        signing_secret.encode("ascii"),
    )
    entitlement.installation = installation
    entitlement.sealed_signing_secret = sealed_secret
    entitlement.save(update_fields=["installation", "sealed_signing_secret", "updated_at"])

    services.audit(
        "installed",
        principal,
        organisation_id,
        installation.id,
        {"generation": str(installation.generation)},
    )
    services.audit(
        "marketplace_installed",
        principal,
        organisation_id,
        listing.id,
        {
            "listing_id": str(listing.id),
            "installation_id": str(installation.id),
        },
    )
    return {
        "installationId": str(installation.id),
        "entitlementId": str(entitlement.id),
        "listingId": str(listing.id),
        "slug": listing.slug,
        "endpoint": installation.endpoint,
        "events": list(installation.events),
        "keyGeneration": str(installation.generation),
        "replayed": False,
    }


def find_marketplace_entitlement_organisation(
    *, session_id: str, meta_entitlement_id: UUID | None
) -> UUID | None:
    """Return `organisation_id` if a marketplace entitlement matches `session_id` or `meta_entitlement_id`."""
    entitlement = MarketplaceEntitlement.objects.filter(checkout_ref=session_id).first()
    if entitlement is None and meta_entitlement_id is not None:
        candidate = MarketplaceEntitlement.objects.filter(id=meta_entitlement_id).first()
        if candidate is not None and candidate.checkout_ref in (None, session_id):
            entitlement = candidate
    return None if entitlement is None else entitlement.organisation_id

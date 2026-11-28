"""Reconcile fenced CreatorConnectAccount rows across a Stripe platform or mode cutover."""

from __future__ import annotations

import json

from django.apps import apps as django_apps
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models import Q

from apps.billing.configuration import (
    LEGACY_STRIPE_PLATFORM_ACCOUNT_ID,
    LIVE_STRIPE_PLATFORM_ACCOUNT_ID,
    SANDBOX_STRIPE_PLATFORM_ACCOUNT_ID,
    STRIPE_PLATFORM_ACCOUNT_ID,
)
from apps.billing.models import (
    CreatorConnectAccount,
    CreatorSplitLedgerEntry,
    PaymentLink,
    VipMembershipEntitlement,
    VipTierOffer,
    WorkspaceBoostGrant,
)
from apps.billing.payments import configured_provider
from apps.billing.payments.port import ProviderRefusedError
from apps.billing.vip_connect import derive_connect_onboarding_state
from apps.orgs.models import Organisation, PrivacyErasure
from core.db.ids import new_uuid7

CUTOVER_ERROR_REASON = "platform_account_cutover_reconciliation_required"


def _strip_cutover_reason(existing: str | None) -> str | None:
    if not existing:
        return None
    kept = [part for part in existing.split(";") if part and part != CUTOVER_ERROR_REASON]
    return ";".join(kept) if kept else None


def _append_cutover_reason(existing: str | None) -> str:
    if not existing:
        return CUTOVER_ERROR_REASON
    parts = [part for part in existing.split(";") if part]
    if CUTOVER_ERROR_REASON in parts:
        return existing
    return f"{existing};{CUTOVER_ERROR_REASON}"


def _validate_target_binding(
    raw_platform: str | None, raw_livemode: str | None
) -> tuple[str, bool]:
    if not raw_platform or STRIPE_PLATFORM_ACCOUNT_ID.fullmatch(raw_platform) is None:
        raise CommandError("--target-platform-account-id requires a valid acct_ identifier")
    if raw_platform == LEGACY_STRIPE_PLATFORM_ACCOUNT_ID:
        raise CommandError("--target-platform-account-id refuses the retired company account")
    if raw_livemode not in {"true", "false"}:
        raise CommandError("--target-livemode requires lowercase true or false")
    target_livemode = raw_livemode == "true"
    if target_livemode and raw_platform == SANDBOX_STRIPE_PLATFORM_ACCOUNT_ID:
        raise CommandError(
            "--target-platform-account-id names sandbox account with --target-livemode true"
        )
    if not target_livemode and raw_platform == LIVE_STRIPE_PLATFORM_ACCOUNT_ID:
        raise CommandError(
            "--target-platform-account-id names live account with --target-livemode false"
        )
    return raw_platform, target_livemode


class Command(BaseCommand):
    help = (
        "Inspect or reconcile CreatorConnectAccount rows whose persisted Stripe platform or "
        "livemode differs from an explicit target binding (dry-run by default)."
    )

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--target-platform-account-id",
            required=True,
            help="Explicit target Stripe platform account ID (acct_...).",
        )
        parser.add_argument(
            "--target-livemode",
            required=True,
            choices=("true", "false"),
            help="Explicit target Stripe livemode (true or false).",
        )
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Persist reconciliation changes (defaults to read-only dry-run).",
        )
        mode_group = parser.add_mutually_exclusive_group()
        mode_group.add_argument(
            "--reset-unsettled-connected",
            action="store_true",
            help=(
                "Reset non-disabled mismatched connected accounts with zero ledger entries and "
                "zero settled VIP entitlements back to intent_recorded on the target platform."
            ),
        )
        mode_group.add_argument(
            "--rebind-connected",
            action="store_true",
            help=(
                "Verify each mismatched connected account via retrieve_connect_account against "
                "the active Stripe provider and rebind matching workspace accounts in place."
            ),
        )

        checkout_group = parser.add_mutually_exclusive_group()
        checkout_group.add_argument(
            "--backfill-unbound-checkouts",
            action="store_true",
            help=(
                "Stamp pre-0030 NULL/NULL Stripe bindings on PaymentLink, WorkspaceBoostGrant, "
                "VipMembershipEntitlement, and paid MarketplaceEntitlement rows when upgrading "
                "an unchanged Stripe platform account in place."
            ),
        )
        checkout_group.add_argument(
            "--revoke-unbound-pending-checkouts",
            action="store_true",
            help=(
                "Cancel or revoke unpaid pre-0030 NULL/NULL pending PaymentLink, "
                "WorkspaceBoostGrant, VipMembershipEntitlement, and MarketplaceEntitlement rows "
                "during a platform account cutover without stamping the new account."
            ),
        )

    def handle(self, *args, **options) -> None:
        target_platform, target_livemode = _validate_target_binding(
            options.get("target_platform_account_id"),
            options.get("target_livemode"),
        )
        apply = bool(options["apply"])
        reset_unsettled = bool(options["reset_unsettled_connected"])
        rebind_connected = bool(options["rebind_connected"])
        backfill_checkouts = bool(options["backfill_unbound_checkouts"])
        revoke_unbound_pending = bool(options["revoke_unbound_pending_checkouts"])
        if backfill_checkouts and reset_unsettled:
            raise CommandError(
                "--backfill-unbound-checkouts cannot be combined with --reset-unsettled-connected"
            )

        erased_org_ids = PrivacyErasure.objects.values("organisation_reference")
        closed_org_ids = Organisation.objects.filter(
            Q(state="closed") | Q(deleted_at__isnull=False)
        ).values("id")

        mismatched_qs = CreatorConnectAccount.objects.exclude(
            stripe_platform_account_id=target_platform,
            stripe_livemode=target_livemode,
        )
        if backfill_checkouts:
            runtime_platform = getattr(settings, "KODERA_STRIPE_PLATFORM_ACCOUNT_ID", None)
            runtime_livemode = getattr(settings, "KODERA_STRIPE_EXPECTED_LIVEMODE", None)
            if runtime_platform != target_platform or runtime_livemode is not target_livemode:
                raise CommandError(
                    "--backfill-unbound-checkouts requires KODERA_STRIPE_PLATFORM_ACCOUNT_ID and "
                    "KODERA_STRIPE_EXPECTED_LIVEMODE to match the target binding"
                )
            if CreatorConnectAccount.objects.filter(
                stripe_platform_account_id=LEGACY_STRIPE_PLATFORM_ACCOUNT_ID
            ).exists():
                raise CommandError(
                    "--backfill-unbound-checkouts refuses to run while retired company account "
                    "CreatorConnectAccount rows exist; use --revoke-unbound-pending-checkouts"
                )
            if mismatched_qs.exists():
                raise CommandError(
                    "--backfill-unbound-checkouts refuses to run while mismatched "
                    "CreatorConnectAccount rows exist"
                )
        privacy_skipped = mismatched_qs.filter(
            Q(organisation_id__in=erased_org_ids) | Q(organisation_id__in=closed_org_ids)
        ).count()

        rebound_uncreated = 0
        rebound_connected = 0
        rebind_unverified = 0
        reset_connected = 0
        fenced_connected = 0
        unpublished_tiers = 0
        backfilled_checkouts = 0
        revoked_unbound_pending = 0

        verified_snapshots = {}
        if rebind_connected:
            runtime_platform = getattr(settings, "KODERA_STRIPE_PLATFORM_ACCOUNT_ID", None)
            runtime_livemode = getattr(settings, "KODERA_STRIPE_EXPECTED_LIVEMODE", None)
            if runtime_platform != target_platform or runtime_livemode is not target_livemode:
                raise CommandError(
                    "--rebind-connected requires KODERA_STRIPE_PLATFORM_ACCOUNT_ID and "
                    "KODERA_STRIPE_EXPECTED_LIVEMODE to match the target binding"
                )
            provider = configured_provider()
            if getattr(provider, "name", None) != "stripe":
                raise CommandError("--rebind-connected requires an active Stripe provider")
            connected_candidates = list(
                mismatched_qs.exclude(organisation_id__in=erased_org_ids)
                .exclude(organisation_id__in=closed_org_ids)
                .exclude(stripe_connect_account_id__isnull=True)
                .only("id", "workspace_id", "stripe_connect_account_id")
                .order_by("id")
            )
            for candidate in connected_candidates:
                try:
                    snap = provider.retrieve_connect_account(
                        str(candidate.stripe_connect_account_id)
                    )
                except ProviderRefusedError:
                    rebind_unverified += 1
                    continue
                if snap.account_id == str(
                    candidate.stripe_connect_account_id
                ) and snap.metadata.get("kodera_workspace_id") == str(candidate.workspace_id):
                    verified_snapshots[candidate.id] = snap
                else:
                    rebind_unverified += 1

        with transaction.atomic():
            if revoke_unbound_pending:
                from django.utils import timezone

                from apps.billing.vip_connect import cancel_pending_vip_entitlement

                now_ts = timezone.now()
                pl_qs = (
                    PaymentLink.objects.filter(
                        provider="stripe",
                        state="active",
                        stripe_account_id__isnull=True,
                        stripe_livemode__isnull=True,
                    )
                    .exclude(organisation_id__in=erased_org_ids)
                    .exclude(organisation_id__in=closed_org_ids)
                )
                pl_count = pl_qs.count()
                revoked_unbound_pending += pl_count
                if apply and pl_count:
                    pl_qs.update(state="cancelled")

                bg_qs = (
                    WorkspaceBoostGrant.objects.filter(
                        state="pending_payment",
                        stripe_payment_intent_id__isnull=True,
                        stripe_account_id__isnull=True,
                        stripe_livemode__isnull=True,
                    )
                    .exclude(organisation_id__in=erased_org_ids)
                    .exclude(organisation_id__in=closed_org_ids)
                )
                bg_count = bg_qs.count()
                revoked_unbound_pending += bg_count
                if apply and bg_count:
                    bg_qs.update(state="cancelled", stripe_checkout_url=None, updated_at=now_ts)

                vip_ids = list(
                    VipMembershipEntitlement.objects.filter(
                        state="pending_payment",
                        stripe_payment_intent_id__isnull=True,
                        stripe_account_id__isnull=True,
                        stripe_livemode__isnull=True,
                    )
                    .exclude(organisation_id__in=erased_org_ids)
                    .exclude(organisation_id__in=closed_org_ids)
                    .values_list("id", flat=True)
                )
                revoked_unbound_pending += len(vip_ids)
                if apply:
                    for vip_id in vip_ids:
                        cancel_pending_vip_entitlement(entitlement_id=vip_id)

                if django_apps.is_installed("apps.extensions"):
                    from apps.extensions.models import MarketplaceEntitlement

                    mkt_pending_qs = (
                        MarketplaceEntitlement.objects.filter(
                            state="pending",
                            payment_intent_id__isnull=True,
                            stripe_account_id__isnull=True,
                            stripe_livemode__isnull=True,
                        )
                        .exclude(organisation_id__in=erased_org_ids)
                        .exclude(organisation_id__in=closed_org_ids)
                    )
                    mkt_pending_count = mkt_pending_qs.count()
                    revoked_unbound_pending += mkt_pending_count
                    if apply and mkt_pending_count:
                        mkt_pending_qs.update(
                            state="revoked",
                            revoked_at=now_ts,
                            checkout_url=None,
                            updated_at=now_ts,
                        )

            candidates = list(
                mismatched_qs.exclude(organisation_id__in=erased_org_ids)
                .exclude(organisation_id__in=closed_org_ids)
                .select_for_update()
                .order_by("id")
            )
            if apply and reset_unsettled:
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL kodera.connect_platform_cutover = 'on'")
            if apply and rebind_connected:
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL kodera.connect_platform_rebind = 'on'")
            if apply and backfill_checkouts:
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL kodera.checkout_binding_backfill = 'on'")

            if backfill_checkouts:
                for qs in (
                    PaymentLink.objects.filter(
                        provider="stripe",
                        stripe_account_id__isnull=True,
                        stripe_livemode__isnull=True,
                    )
                    .exclude(organisation_id__in=erased_org_ids)
                    .exclude(organisation_id__in=closed_org_ids),
                    WorkspaceBoostGrant.objects.filter(
                        stripe_account_id__isnull=True,
                        stripe_livemode__isnull=True,
                    )
                    .exclude(organisation_id__in=erased_org_ids)
                    .exclude(organisation_id__in=closed_org_ids),
                    VipMembershipEntitlement.objects.filter(
                        stripe_account_id__isnull=True,
                        stripe_livemode__isnull=True,
                    )
                    .exclude(organisation_id__in=erased_org_ids)
                    .exclude(organisation_id__in=closed_org_ids),
                ):
                    count = qs.count()
                    backfilled_checkouts += count
                    if apply and count:
                        qs.update(
                            stripe_account_id=target_platform,
                            stripe_livemode=target_livemode,
                        )
                if django_apps.is_installed("apps.extensions"):
                    from apps.extensions.models import MarketplaceEntitlement

                    mkt_qs = (
                        MarketplaceEntitlement.objects.filter(
                            listing__pricing_mode="one_time",
                            stripe_account_id__isnull=True,
                            stripe_livemode__isnull=True,
                        )
                        .exclude(organisation_id__in=erased_org_ids)
                        .exclude(organisation_id__in=closed_org_ids)
                    )
                    mkt_count = mkt_qs.count()
                    backfilled_checkouts += mkt_count
                    if apply and mkt_count:
                        mkt_qs.update(
                            stripe_account_id=target_platform,
                            stripe_livemode=target_livemode,
                        )

            for acct in candidates:
                snap = verified_snapshots.get(acct.id) if rebind_connected else None
                if (
                    snap is not None
                    and acct.stripe_connect_account_id is not None
                    and snap.account_id == str(acct.stripe_connect_account_id)
                    and snap.metadata.get("kodera_workspace_id") == str(acct.workspace_id)
                ):
                    rebound_connected += 1
                    if apply:
                        derived = (
                            "disabled"
                            if acct.onboarding_state == "disabled"
                            else derive_connect_onboarding_state(snap)
                        )
                        acct.stripe_platform_account_id = target_platform
                        acct.stripe_livemode = target_livemode
                        acct.charges_enabled = snap.charges_enabled and derived != "disabled"
                        acct.payouts_enabled = snap.payouts_enabled and derived != "disabled"
                        acct.details_submitted = snap.details_submitted
                        acct.onboarding_state = derived
                        acct.last_operation_error = (
                            _strip_cutover_reason(acct.last_operation_error)
                            if derived == "disabled"
                            else snap.restricted_reason
                        )
                        acct.save(
                            update_fields=[
                                "stripe_platform_account_id",
                                "stripe_livemode",
                                "charges_enabled",
                                "payouts_enabled",
                                "details_submitted",
                                "onboarding_state",
                                "last_operation_error",
                                "updated_at",
                            ]
                        )
                    continue

                active_tiers_qs = VipTierOffer.objects.filter(connect_account=acct, active=True)
                tier_count = active_tiers_qs.count()
                if tier_count:
                    unpublished_tiers += tier_count
                    if apply:
                        active_tiers_qs.update(active=False)

                if (
                    acct.stripe_connect_account_id is None
                    and acct.onboarding_state == "intent_recorded"
                ):
                    rebound_uncreated += 1
                    if apply:
                        acct.stripe_platform_account_id = target_platform
                        acct.stripe_livemode = target_livemode
                        acct.operation_idempotency_key = f"cutover-{new_uuid7()}"
                        acct.last_operation_error = _strip_cutover_reason(acct.last_operation_error)
                        acct.save(
                            update_fields=[
                                "stripe_platform_account_id",
                                "stripe_livemode",
                                "operation_idempotency_key",
                                "last_operation_error",
                                "updated_at",
                            ]
                        )
                    continue

                has_marketplace_activity = False
                if acct.stripe_connect_account_id is not None and django_apps.is_installed(
                    "apps.extensions"
                ):
                    from apps.extensions.models import MarketplaceEntitlement

                    has_marketplace_activity = (
                        MarketplaceEntitlement.objects.filter(
                            listing__workspace_id=acct.workspace_id,
                            listing__seller_connect_account_id=acct.stripe_connect_account_id,
                        )
                        .exclude(state="revoked", payment_intent_id__isnull=True)
                        .exists()
                    )

                has_accounting = (
                    CreatorSplitLedgerEntry.objects.filter(connect_account=acct).exists()
                    or VipMembershipEntitlement.objects.filter(
                        tier__connect_account=acct,
                    )
                    .exclude(state="cancelled", stripe_payment_intent_id__isnull=True)
                    .exists()
                    or has_marketplace_activity
                )
                if (
                    reset_unsettled
                    and not has_accounting
                    and acct.stripe_connect_account_id is not None
                    and acct.onboarding_state != "disabled"
                ):
                    reset_connected += 1
                    if apply:
                        acct.stripe_platform_account_id = target_platform
                        acct.stripe_livemode = target_livemode
                        acct.stripe_connect_account_id = None
                        acct.onboarding_state = "intent_recorded"
                        acct.charges_enabled = False
                        acct.payouts_enabled = False
                        acct.details_submitted = False
                        acct.onboarding_completed_at = None
                        acct.operation_idempotency_key = f"cutover-{new_uuid7()}"
                        acct.last_operation_error = None
                        acct.save(
                            update_fields=[
                                "stripe_platform_account_id",
                                "stripe_livemode",
                                "stripe_connect_account_id",
                                "onboarding_state",
                                "charges_enabled",
                                "payouts_enabled",
                                "details_submitted",
                                "onboarding_completed_at",
                                "operation_idempotency_key",
                                "last_operation_error",
                                "updated_at",
                            ]
                        )
                else:
                    fenced_connected += 1
                    if apply:
                        acct.charges_enabled = False
                        acct.payouts_enabled = False
                        acct.last_operation_error = _append_cutover_reason(
                            acct.last_operation_error
                        )
                        fields = [
                            "charges_enabled",
                            "payouts_enabled",
                            "last_operation_error",
                            "updated_at",
                        ]
                        if (
                            acct.stripe_connect_account_id is not None
                            and acct.onboarding_state != "disabled"
                        ):
                            acct.onboarding_state = "restricted"
                            fields.append("onboarding_state")
                        acct.save(update_fields=fields)

        self.stdout.write(
            json.dumps(
                {
                    "applied": apply,
                    "backfilled_checkouts": backfilled_checkouts,
                    "fenced_connected": fenced_connected,
                    "privacy_skipped": privacy_skipped,
                    "rebind_unverified": rebind_unverified,
                    "rebound_connected": rebound_connected,
                    "rebound_uncreated": rebound_uncreated,
                    "reset_connected": reset_connected,
                    "revoked_unbound_pending": revoked_unbound_pending,
                    "target_livemode": target_livemode,
                    "target_platform_account_id": target_platform,
                    "unpublished_tiers": unpublished_tiers,
                },
                sort_keys=True,
            )
        )

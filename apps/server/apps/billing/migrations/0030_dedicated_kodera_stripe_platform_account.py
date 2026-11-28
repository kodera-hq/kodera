"""Bind Stripe account and livemode on PaymentLink, WorkspaceBoostGrant, and CreatorConnectAccount."""

from django.db import migrations, models
from django.db.models import Q

import apps.billing.configuration

RETIRED_PLATFORM_ACCOUNT_ID = "acct_1QhZ8fRwfVmWKPLR"
CUTOVER_ERROR_REASON = "platform_account_cutover_reconciliation_required"

REVERSE_GUARD_SQL = """
CREATE OR REPLACE FUNCTION public.billing_h31_resource_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  in_erasure boolean := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'billing_creatorsplitledgerentry' THEN
    RAISE EXCEPTION 'creator split ledger entry immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'billing_dac7sellerstatutorysnapshot' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.purge_after < clock_timestamp()
         AND public.retention_context('purge', TG_TABLE_NAME, OLD.id) IS NOT NULL THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'dac7 statutory snapshot immutable or not due' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
    END IF;

    in_erasure := public.privacy_erasure_context(NEW.organisation_id)
      OR EXISTS (
        SELECT 1 FROM public.retention_worker_context rwc
        WHERE rwc.backend = pg_backend_pid()
          AND rwc.transaction = txid_current()
          AND rwc.purpose = 'account'
          AND rwc.source_table = 'identity_user'
      );

    IF TG_TABLE_NAME = 'billing_workspaceboostgrant' THEN
      IF (
        NEW.pack_code, NEW.customer_kind, NEW.customer_country, NEW.currency,
        NEW.vat_regime, NEW.vat_rate_bp, NEW.net_amount_minor, NEW.vat_amount_minor,
        NEW.gross_amount_minor, NEW.credit_amount_minor, NEW.seats_delta,
        NEW.storage_bytes_delta, NEW.idempotency_key, NEW.request_sha256,
        NEW.withdrawal_waiver_accepted, NEW.withdrawal_waiver_at
      ) IS DISTINCT FROM (
        OLD.pack_code, OLD.customer_kind, OLD.customer_country, OLD.currency,
        OLD.vat_regime, OLD.vat_rate_bp, OLD.net_amount_minor, OLD.vat_amount_minor,
        OLD.gross_amount_minor, OLD.credit_amount_minor, OLD.seats_delta,
        OLD.storage_bytes_delta, OLD.idempotency_key, OLD.request_sha256,
        OLD.withdrawal_waiver_accepted, OLD.withdrawal_waiver_at
      ) THEN
        RAISE EXCEPTION 'boost commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.purchaser_user_id IS DISTINCT FROM OLD.purchaser_user_id
        OR NEW.withdrawal_waiver_evidence IS DISTINCT FROM OLD.withdrawal_waiver_evidence
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'boost identity and waiver evidence immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
        IF OLD.invoice_id IS NOT NULL
           OR public.retention_context('h31_invoice_bind', 'billing_workspaceboostgrant', NEW.id) IS NULL THEN
          RAISE EXCEPTION 'boost invoice binding immutable' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'boost payment intent immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_workspacehostingcredit' THEN
      IF NEW.boost_grant_id IS DISTINCT FROM OLD.boost_grant_id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.granted_minor IS DISTINCT FROM OLD.granted_minor THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_viptieroffer' THEN
      IF NEW.connect_account_id IS DISTINCT FROM OLD.connect_account_id
         OR NEW.code IS DISTINCT FROM OLD.code
         OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.price_excl_vat_minor IS DISTINCT FROM OLD.price_excl_vat_minor
         OR NEW.granted_workspace_role_id IS DISTINCT FROM OLD.granted_workspace_role_id THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_vipmembershipentitlement' THEN
      IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
         OR NEW.tier_id IS DISTINCT FROM OLD.tier_id THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.customer_kind, NEW.buyer_country, NEW.currency, NEW.vat_regime,
        NEW.vat_rate_bp, NEW.gross_excl_vat_minor, NEW.vat_amount_minor,
        NEW.total_incl_vat_minor, NEW.application_fee_amount_minor,
        NEW.reserved_recovery_minor, NEW.idempotency_key, NEW.request_sha256,
        NEW.withdrawal_waiver_accepted, NEW.withdrawal_waiver_at
      ) IS DISTINCT FROM (
        OLD.customer_kind, OLD.buyer_country, OLD.currency, OLD.vat_regime,
        OLD.vat_rate_bp, OLD.gross_excl_vat_minor, OLD.vat_amount_minor,
        OLD.total_incl_vat_minor, OLD.application_fee_amount_minor,
        OLD.reserved_recovery_minor, OLD.idempotency_key, OLD.request_sha256,
        OLD.withdrawal_waiver_accepted, OLD.withdrawal_waiver_at
      ) THEN
        RAISE EXCEPTION 'vip entitlement commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id
        OR NEW.withdrawal_waiver_evidence IS DISTINCT FROM OLD.withdrawal_waiver_evidence
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'vip entitlement identity and waiver evidence immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'vip entitlement payment intent immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_creatorconnectaccount' THEN
      IF NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps THEN
        RAISE EXCEPTION 'connect platform fee bps immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.stripe_connect_account_id IS NOT NULL
         AND NEW.stripe_connect_account_id IS DISTINCT FROM OLD.stripe_connect_account_id THEN
        RAISE EXCEPTION 'persisted stripe_connect_account_id immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'connect account owner binding immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_h31_resource_binding_guard() FROM PUBLIC;
"""

FORWARD_GUARD_SQL = """
CREATE OR REPLACE FUNCTION public.billing_h31_resource_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  in_erasure boolean := FALSE;
  in_cutover boolean := FALSE;
  in_rebind boolean := FALSE;
  in_backfill boolean := FALSE;
  has_mkt_activity boolean := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'billing_creatorsplitledgerentry' THEN
    RAISE EXCEPTION 'creator split ledger entry immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'billing_dac7sellerstatutorysnapshot' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.purge_after < clock_timestamp()
         AND public.retention_context('purge', TG_TABLE_NAME, OLD.id) IS NOT NULL THEN
        RETURN OLD;
      END IF;
    END IF;
    RAISE EXCEPTION 'dac7 statutory snapshot immutable or not due' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
    END IF;

    in_erasure := public.privacy_erasure_context(NEW.organisation_id)
      OR EXISTS (
        SELECT 1 FROM public.retention_worker_context rwc
        WHERE rwc.backend = pg_backend_pid()
          AND rwc.transaction = txid_current()
          AND rwc.purpose = 'account'
          AND rwc.source_table = 'identity_user'
      );

    in_backfill := COALESCE(current_setting('kodera.checkout_binding_backfill', true), '') = 'on';

    IF TG_TABLE_NAME = 'billing_workspaceboostgrant' THEN
      IF (
        NEW.pack_code, NEW.customer_kind, NEW.customer_country, NEW.currency,
        NEW.vat_regime, NEW.vat_rate_bp, NEW.net_amount_minor, NEW.vat_amount_minor,
        NEW.gross_amount_minor, NEW.credit_amount_minor, NEW.seats_delta,
        NEW.storage_bytes_delta, NEW.idempotency_key, NEW.request_sha256,
        NEW.withdrawal_waiver_accepted, NEW.withdrawal_waiver_at
      ) IS DISTINCT FROM (
        OLD.pack_code, OLD.customer_kind, OLD.customer_country, OLD.currency,
        OLD.vat_regime, OLD.vat_rate_bp, OLD.net_amount_minor, OLD.vat_amount_minor,
        OLD.gross_amount_minor, OLD.credit_amount_minor, OLD.seats_delta,
        OLD.storage_bytes_delta, OLD.idempotency_key, OLD.request_sha256,
        OLD.withdrawal_waiver_accepted, OLD.withdrawal_waiver_at
      ) THEN
        RAISE EXCEPTION 'boost commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.stripe_account_id IS DISTINCT FROM OLD.stripe_account_id
        OR NEW.stripe_livemode IS DISTINCT FROM OLD.stripe_livemode
      ) AND NOT (
        in_backfill
        AND OLD.stripe_account_id IS NULL
        AND OLD.stripe_livemode IS NULL
        AND NEW.stripe_account_id IS NOT NULL
        AND NEW.stripe_livemode IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'boost commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.purchaser_user_id IS DISTINCT FROM OLD.purchaser_user_id
        OR NEW.withdrawal_waiver_evidence IS DISTINCT FROM OLD.withdrawal_waiver_evidence
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'boost identity and waiver evidence immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
        IF OLD.invoice_id IS NOT NULL
           OR public.retention_context('h31_invoice_bind', 'billing_workspaceboostgrant', NEW.id) IS NULL THEN
          RAISE EXCEPTION 'boost invoice binding immutable' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'boost payment intent immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_workspacehostingcredit' THEN
      IF NEW.boost_grant_id IS DISTINCT FROM OLD.boost_grant_id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.granted_minor IS DISTINCT FROM OLD.granted_minor THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_viptieroffer' THEN
      IF NEW.connect_account_id IS DISTINCT FROM OLD.connect_account_id
         OR NEW.code IS DISTINCT FROM OLD.code
         OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.price_excl_vat_minor IS DISTINCT FROM OLD.price_excl_vat_minor
         OR NEW.granted_workspace_role_id IS DISTINCT FROM OLD.granted_workspace_role_id THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_vipmembershipentitlement' THEN
      IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
         OR NEW.tier_id IS DISTINCT FROM OLD.tier_id THEN
        RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.customer_kind, NEW.buyer_country, NEW.currency, NEW.vat_regime,
        NEW.vat_rate_bp, NEW.gross_excl_vat_minor, NEW.vat_amount_minor,
        NEW.total_incl_vat_minor, NEW.application_fee_amount_minor,
        NEW.reserved_recovery_minor, NEW.idempotency_key, NEW.request_sha256,
        NEW.withdrawal_waiver_accepted, NEW.withdrawal_waiver_at
      ) IS DISTINCT FROM (
        OLD.customer_kind, OLD.buyer_country, OLD.currency, OLD.vat_regime,
        OLD.vat_rate_bp, OLD.gross_excl_vat_minor, OLD.vat_amount_minor,
        OLD.total_incl_vat_minor, OLD.application_fee_amount_minor,
        OLD.reserved_recovery_minor, OLD.idempotency_key, OLD.request_sha256,
        OLD.withdrawal_waiver_accepted, OLD.withdrawal_waiver_at
      ) THEN
        RAISE EXCEPTION 'vip entitlement commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.stripe_account_id IS DISTINCT FROM OLD.stripe_account_id
        OR NEW.stripe_livemode IS DISTINCT FROM OLD.stripe_livemode
      ) AND NOT (
        in_backfill
        AND OLD.stripe_account_id IS NULL
        AND OLD.stripe_livemode IS NULL
        AND NEW.stripe_account_id IS NOT NULL
        AND NEW.stripe_livemode IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'vip entitlement commercial snapshot immutable' USING ERRCODE = '23514';
      END IF;
      IF NOT in_erasure AND (
        NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id
        OR NEW.withdrawal_waiver_evidence IS DISTINCT FROM OLD.withdrawal_waiver_evidence
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'vip entitlement identity and waiver evidence immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.stripe_payment_intent_id IS NOT NULL
         AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'vip entitlement payment intent immutable' USING ERRCODE = '23514';
      END IF;

    ELSIF TG_TABLE_NAME = 'billing_creatorconnectaccount' THEN
      IF NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps THEN
        RAISE EXCEPTION 'connect platform fee bps immutable' USING ERRCODE = '23514';
      END IF;
      in_cutover := COALESCE(current_setting('kodera.connect_platform_cutover', true), '') = 'on';
      in_rebind := COALESCE(current_setting('kodera.connect_platform_rebind', true), '') = 'on';
      IF OLD.stripe_connect_account_id IS NOT NULL
         AND (
           NEW.stripe_platform_account_id IS DISTINCT FROM OLD.stripe_platform_account_id
           OR NEW.stripe_livemode IS DISTINCT FROM OLD.stripe_livemode
         )
         AND NOT (in_cutover OR in_rebind) THEN
        RAISE EXCEPTION 'connect platform binding immutable on connected account' USING ERRCODE = '23514';
      END IF;
      IF OLD.stripe_connect_account_id IS NOT NULL
         AND NEW.stripe_connect_account_id IS DISTINCT FROM OLD.stripe_connect_account_id THEN
        IF to_regclass('public.extensions_marketplaceentitlement') IS NOT NULL
           AND to_regclass('public.extensions_extensionmarketplacelisting') IS NOT NULL THEN
          EXECUTE
            'SELECT EXISTS (
               SELECT 1
               FROM public.extensions_marketplaceentitlement me
               JOIN public.extensions_extensionmarketplacelisting ml ON ml.id = me.listing_id
               WHERE ml.workspace_id = $1
                 AND ml.seller_connect_account_id = $2
                 AND NOT (me.state = ''revoked'' AND me.payment_intent_id IS NULL)
             )'
            INTO has_mkt_activity
            USING OLD.workspace_id, OLD.stripe_connect_account_id;
        END IF;
        IF NOT (
          in_cutover
          AND OLD.onboarding_state <> 'disabled'
          AND NEW.stripe_connect_account_id IS NULL
          AND NEW.onboarding_state = 'intent_recorded'
          AND (
            NEW.stripe_platform_account_id IS DISTINCT FROM OLD.stripe_platform_account_id
            OR NEW.stripe_livemode IS DISTINCT FROM OLD.stripe_livemode
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_creatorsplitledgerentry le
            WHERE le.connect_account_id = OLD.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_vipmembershipentitlement ve
            WHERE ve.tier_id IN (
              SELECT vt.id FROM public.billing_viptieroffer vt WHERE vt.connect_account_id = OLD.id
            )
            AND NOT (ve.state = 'cancelled' AND ve.stripe_payment_intent_id IS NULL)
          )
          AND NOT has_mkt_activity
        ) THEN
          RAISE EXCEPTION 'persisted stripe_connect_account_id immutable' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NOT in_erasure AND (
        NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
        OR NEW.pii_scrubbed_at IS DISTINCT FROM OLD.pii_scrubbed_at
      ) THEN
        RAISE EXCEPTION 'connect account owner binding immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.billing_h31_resource_binding_guard() FROM PUBLIC;
"""

if FORWARD_GUARD_SQL == REVERSE_GUARD_SQL:
    raise RuntimeError("0030 FORWARD_GUARD_SQL and REVERSE_GUARD_SQL must differ")


def _append_cutover_reason(existing: str | None) -> str:
    if not existing:
        return CUTOVER_ERROR_REASON
    parts = [part for part in existing.split(";") if part]
    if CUTOVER_ERROR_REASON in parts:
        return existing
    return f"{existing};{CUTOVER_ERROR_REASON}"


def _fence_retired_platform_connect_accounts(apps_registry, schema_editor):
    db = schema_editor.connection.alias
    CreatorConnectAccount = apps_registry.get_model("billing", "CreatorConnectAccount")
    VipTierOffer = apps_registry.get_model("billing", "VipTierOffer")
    Organisation = apps_registry.get_model("orgs", "Organisation")
    PrivacyErasure = apps_registry.get_model("orgs", "PrivacyErasure")

    erased_org_ids = PrivacyErasure.objects.using(db).values("organisation_reference")
    closed_org_ids = (
        Organisation.objects.using(db)
        .filter(Q(state="closed") | Q(deleted_at__isnull=False))
        .values("id")
    )
    mutable_legacy_rows = list(
        CreatorConnectAccount.objects.using(db)
        .filter(stripe_platform_account_id=RETIRED_PLATFORM_ACCOUNT_ID)
        .exclude(organisation_id__in=erased_org_ids)
        .exclude(organisation_id__in=closed_org_ids)
    )
    for row in mutable_legacy_rows:
        VipTierOffer.objects.using(db).filter(connect_account_id=row.id, active=True).update(
            active=False
        )
        next_error = _append_cutover_reason(row.last_operation_error)
        update_fields = ["charges_enabled", "payouts_enabled", "last_operation_error"]
        row.charges_enabled = False
        row.payouts_enabled = False
        row.last_operation_error = next_error
        if row.stripe_connect_account_id is not None and row.onboarding_state != "disabled":
            row.onboarding_state = "restricted"
            update_fields.append("onboarding_state")
        row.save(using=db, update_fields=update_fields)


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0029_kod_series_and_refund_credit_notes"),
        ("orgs", "0037_organisation_oidc_audience"),
    ]

    operations = [
        migrations.AddField(
            model_name="paymentlink",
            name="stripe_account_id",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="paymentlink",
            name="stripe_livemode",
            field=models.BooleanField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="paymentlink",
            constraint=models.CheckConstraint(
                condition=Q(stripe_account_id__isnull=True)
                | Q(stripe_account_id__regex=r"^acct_[A-Za-z0-9_]+$"),
                name="billing_paymentlink_stripe_acct_valid",
            ),
        ),
        migrations.AddField(
            model_name="workspaceboostgrant",
            name="stripe_account_id",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workspaceboostgrant",
            name="stripe_livemode",
            field=models.BooleanField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="workspaceboostgrant",
            constraint=models.CheckConstraint(
                condition=Q(stripe_account_id__isnull=True)
                | Q(stripe_account_id__regex=r"^acct_[A-Za-z0-9_]+$"),
                name="billing_boost_stripe_acct_valid",
            ),
        ),
        migrations.AddField(
            model_name="vipmembershipentitlement",
            name="stripe_account_id",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="vipmembershipentitlement",
            name="stripe_livemode",
            field=models.BooleanField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="vipmembershipentitlement",
            constraint=models.CheckConstraint(
                condition=Q(stripe_account_id__isnull=True)
                | Q(stripe_account_id__regex=r"^acct_[A-Za-z0-9_]+$"),
                name="billing_vipentitlement_stripe_acct_valid",
            ),
        ),
        migrations.AddField(
            model_name="creatorconnectaccount",
            name="stripe_livemode",
            field=models.BooleanField(
                blank=True,
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name="creatorconnectaccount",
            name="stripe_livemode",
            field=models.BooleanField(
                blank=True,
                default=apps.billing.configuration.default_stripe_livemode,
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name="creatorconnectaccount",
            name="stripe_platform_account_id",
            field=models.TextField(
                default=apps.billing.configuration.default_stripe_platform_account_id
            ),
        ),
        migrations.RunSQL(sql=FORWARD_GUARD_SQL, reverse_sql=REVERSE_GUARD_SQL),
        migrations.RunPython(
            _fence_retired_platform_connect_accounts,
            migrations.RunPython.noop,
        ),
    ]

"""Provision durable Enterprise billing tables with bounded DDL timeouts, zero sequences, and privacy guards."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE ee_billing_sequences (
    name VARCHAR(64) PRIMARY KEY,
    last_value BIGINT NOT NULL
);
REVOKE ALL ON TABLE ee_billing_sequences FROM PUBLIC;

CREATE TABLE ee_billing_warm_pool_slots (
    slot_id VARCHAR(160) PRIMARY KEY,
    sequence BIGINT NOT NULL,
    region VARCHAR(128) NOT NULL,
    profile_ref VARCHAR(128) NOT NULL,
    state VARCHAR(32) NOT NULL,
    claimed_by_organisation_id VARCHAR(128),
    checkout_id VARCHAR(128),
    idempotency_key VARCHAR(255) UNIQUE,
    unhealthy_reason VARCHAR(200)
);
CREATE INDEX ee_billing_wp_region_profile_state_idx
    ON ee_billing_warm_pool_slots (region, profile_ref, state, sequence);
REVOKE ALL ON TABLE ee_billing_warm_pool_slots FROM PUBLIC;

CREATE TABLE ee_billing_purchase_orders (
    po_id VARCHAR(64) PRIMARY KEY,
    po_number VARCHAR(32) NOT NULL UNIQUE,
    organisation_id VARCHAR(64) NOT NULL,
    customer_po_reference VARCHAR(64) NOT NULL,
    plan_code VARCHAR(32) NOT NULL,
    billing_months INTEGER NOT NULL,
    committed_seats INTEGER NOT NULL,
    committed_storage_gb INTEGER NOT NULL,
    subtotal_excl_vat_minor BIGINT NOT NULL,
    vat_rate_bps INTEGER NOT NULL,
    vat_amount_minor BIGINT NOT NULL,
    total_incl_vat_minor BIGINT NOT NULL,
    estimated_cogs_minor BIGINT NOT NULL,
    gross_margin_bps INTEGER NOT NULL,
    currency VARCHAR(8) NOT NULL,
    state VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    issued_at TIMESTAMPTZ,
    countersigned_at TIMESTAMPTZ,
    countersigned_by VARCHAR(120),
    countersigned_by_user_id UUID,
    invoice_ref VARCHAR(64) UNIQUE,
    invoiced_at TIMESTAMPTZ,
    payment_ref VARCHAR(128),
    paid_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    pii_scrubbed_at TIMESTAMPTZ
);
CREATE INDEX ee_billing_po_org_idx
    ON ee_billing_purchase_orders (organisation_id, po_id);
CREATE INDEX ee_billing_po_signatory_user_idx
    ON ee_billing_purchase_orders (countersigned_by_user_id)
    WHERE countersigned_by_user_id IS NOT NULL;
REVOKE ALL ON TABLE ee_billing_purchase_orders FROM PUBLIC;

CREATE FUNCTION public.ee_billing_try_uuid(p_val text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_val IS NOT NULL
       AND p_val ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN p_val::uuid;
    END IF;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.ee_billing_try_uuid(text) FROM PUBLIC;

CREATE FUNCTION public.ee_billing_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    org_uuid uuid;
BEGIN
    IF TG_TABLE_NAME = 'ee_billing_purchase_orders' THEN
        IF TG_OP = 'DELETE' THEN
            IF OLD.state IN ('countersigned', 'invoiced', 'paid')
               OR OLD.invoice_ref IS NOT NULL
               OR OLD.payment_ref IS NOT NULL THEN
                RAISE EXCEPTION 'accounting purchase order retained'
                    USING ERRCODE = '23514';
            END IF;

            org_uuid := public.ee_billing_try_uuid(OLD.organisation_id);
            IF org_uuid IS NOT NULL AND public.privacy_erasure_context(org_uuid) THEN
                RETURN OLD;
            END IF;

            RAISE EXCEPTION 'purchase order deletion requires privacy erasure context'
                USING ERRCODE = '23514';
        END IF;

        org_uuid := public.ee_billing_try_uuid(NEW.organisation_id);
        IF org_uuid IS NOT NULL AND public.privacy_erasure_context(org_uuid) THEN
            RETURN NEW;
        END IF;

        IF TG_OP = 'UPDATE'
           AND EXISTS (
               SELECT 1 FROM public.retention_worker_context rwc
               WHERE rwc.backend = pg_backend_pid()
                 AND rwc.transaction = txid_current()
                 AND rwc.purpose = 'account'
                 AND rwc.source_table = 'identity_user'
           )
           AND NEW.po_id = OLD.po_id
           AND NEW.po_number = OLD.po_number
           AND NEW.organisation_id = OLD.organisation_id
           AND NEW.customer_po_reference = OLD.customer_po_reference
           AND NEW.state = OLD.state
           AND NEW.total_incl_vat_minor = OLD.total_incl_vat_minor
           AND NEW.invoice_ref IS NOT DISTINCT FROM OLD.invoice_ref
           AND NEW.payment_ref IS NOT DISTINCT FROM OLD.payment_ref THEN
            RETURN NEW;
        END IF;

        IF NEW.countersigned_by_user_id IS NOT NULL
           AND (
               TG_OP = 'INSERT'
               OR NEW.countersigned_by_user_id IS DISTINCT FROM OLD.countersigned_by_user_id
               OR NEW.countersigned_by IS DISTINCT FROM OLD.countersigned_by
           )
           AND NOT public.privacy_account_context(NEW.countersigned_by_user_id) THEN
            PERFORM pg_advisory_xact_lock_shared(
                hashtextextended('privacy_account_cutoff:' || NEW.countersigned_by_user_id::text, 0)
            );
            IF NOT EXISTS (
                SELECT 1 FROM public.identity_user u
                WHERE u.id = NEW.countersigned_by_user_id AND u.enabled AND u.deleted_at IS NULL
            ) OR EXISTS (
                SELECT 1 FROM public.orgs_accounterasure ae
                WHERE ae.user_reference = NEW.countersigned_by_user_id
            ) THEN
                RAISE EXCEPTION 'enterprise purchase order signatory account cutoff active'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        IF org_uuid IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock_shared(
                hashtextextended('privacy_erasure_cutoff:' || org_uuid::text, 0)
            );

            IF EXISTS (
                SELECT 1 FROM public.orgs_privacyerasure pe
                WHERE pe.organisation_reference = org_uuid
            ) OR EXISTS (
                SELECT 1 FROM public.orgs_organisation o
                WHERE o.id = org_uuid AND (o.state = 'closed' OR o.deleted_at IS NOT NULL)
            ) THEN
                RAISE EXCEPTION 'enterprise purchase order organisation cutoff active'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        RETURN NEW;

    ELSIF TG_TABLE_NAME = 'ee_billing_warm_pool_slots' THEN
        IF NEW.claimed_by_organisation_id IS NOT NULL THEN
            org_uuid := public.ee_billing_try_uuid(NEW.claimed_by_organisation_id);
            IF org_uuid IS NOT NULL AND NOT public.privacy_erasure_context(org_uuid) THEN
                PERFORM pg_advisory_xact_lock_shared(
                    hashtextextended('privacy_erasure_cutoff:' || org_uuid::text, 0)
                );
                IF EXISTS (
                    SELECT 1 FROM public.orgs_privacyerasure pe
                    WHERE pe.organisation_reference = org_uuid
                ) OR EXISTS (
                    SELECT 1 FROM public.orgs_organisation o
                    WHERE o.id = org_uuid AND (o.state = 'closed' OR o.deleted_at IS NOT NULL)
                ) THEN
                    RAISE EXCEPTION 'enterprise warm pool claim organisation cutoff active'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_billing_privacy_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.ee_billing_erasure_journal_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    org uuid;
    person uuid;
    retained_po_ids jsonb := '[]'::jsonb;
    ephemeral_count bigint := 0;
    wp_released bigint := 0;
    po_deleted bigint := 0;
    po_scrubbed bigint := 0;
    target_org_ids text[] := ARRAY[]::text[];
    signatory_sha256s jsonb := '[]'::jsonb;
    scrub_po_ids jsonb := '[]'::jsonb;
    po_sig_scrubbed bigint := 0;
BEGIN
    IF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
        org := NEW.organisation_reference;

        IF TG_OP = 'INSERT' THEN
            UPDATE public.ee_billing_warm_pool_slots
            SET state = 'evicted',
                claimed_by_organisation_id = NULL,
                checkout_id = NULL,
                idempotency_key = NULL,
                unhealthy_reason = 'organisation_erasure'
            WHERE claimed_by_organisation_id = org::text;
            GET DIAGNOSTICS wp_released = ROW_COUNT;

            SELECT COALESCE(jsonb_agg(po.po_id ORDER BY po.po_id), '[]'::jsonb)
            INTO retained_po_ids
            FROM public.ee_billing_purchase_orders po
            WHERE po.organisation_id = org::text
              AND (
                  po.state IN ('countersigned', 'invoiced', 'paid')
                  OR po.invoice_ref IS NOT NULL
                  OR po.payment_ref IS NOT NULL
              );

            SELECT COUNT(*)
            INTO ephemeral_count
            FROM public.ee_billing_purchase_orders po
            WHERE po.organisation_id = org::text
              AND po.state IN ('draft', 'issued', 'expired')
              AND po.invoice_ref IS NULL
              AND po.payment_ref IS NULL;

            NEW.inventory := NEW.inventory || jsonb_build_object(
                'ee_billing_policy', 'retained_accounting_po_signatory_scrubbed',
                'ee_billing_retained_po_ids', retained_po_ids,
                'ee_billing_ephemeral_po_count', ephemeral_count,
                'ee_billing_warm_pool_released_at_cutoff', wp_released
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
                UPDATE public.ee_billing_warm_pool_slots
                SET state = 'evicted',
                    claimed_by_organisation_id = NULL,
                    checkout_id = NULL,
                    idempotency_key = NULL,
                    unhealthy_reason = 'organisation_erasure'
                WHERE claimed_by_organisation_id = org::text;
                GET DIAGNOSTICS wp_released = ROW_COUNT;

                DELETE FROM public.ee_billing_purchase_orders
                WHERE organisation_id = org::text
                  AND state IN ('draft', 'issued', 'expired')
                  AND invoice_ref IS NULL
                  AND payment_ref IS NULL;
                GET DIAGNOSTICS po_deleted = ROW_COUNT;

                UPDATE public.ee_billing_purchase_orders
                SET countersigned_by = CASE
                        WHEN countersigned_by IS NULL THEN NULL
                        ELSE 'erased'
                    END,
                    countersigned_by_user_id = NULL,
                    customer_po_reference = 'REDACTED-' || po_number,
                    pii_scrubbed_at = COALESCE(pii_scrubbed_at, clock_timestamp())
                WHERE organisation_id = org::text
                  AND (
                      state IN ('countersigned', 'invoiced', 'paid')
                      OR invoice_ref IS NOT NULL
                      OR payment_ref IS NOT NULL
                  );
                GET DIAGNOSTICS po_scrubbed = ROW_COUNT;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'ee_billing_warm_pool_released', wp_released,
                    'ee_billing_ephemeral_pos_deleted', po_deleted,
                    'ee_billing_retained_pos_scrubbed', po_scrubbed
                );
            END IF;

            IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
                IF EXISTS (
                    SELECT 1 FROM public.ee_billing_warm_pool_slots
                    WHERE claimed_by_organisation_id = org::text
                ) OR EXISTS (
                    SELECT 1 FROM public.ee_billing_purchase_orders
                    WHERE organisation_id = org::text
                      AND state IN ('draft', 'issued', 'expired')
                      AND invoice_ref IS NULL
                      AND payment_ref IS NULL
                ) OR EXISTS (
                    SELECT 1 FROM public.ee_billing_purchase_orders
                    WHERE organisation_id = org::text
                      AND (
                          state IN ('countersigned', 'invoiced', 'paid')
                          OR invoice_ref IS NOT NULL
                          OR payment_ref IS NOT NULL
                      )
                      AND (
                          pii_scrubbed_at IS NULL
                          OR countersigned_by_user_id IS NOT NULL
                          OR (
                              countersigned_by IS NOT NULL
                              AND countersigned_by <> 'erased'
                              AND countersigned_by NOT LIKE 'erased:%'
                          )
                          OR customer_po_reference <> ('REDACTED-' || po_number)
                      )
                ) THEN
                    RAISE EXCEPTION 'enterprise billing operational personal data still present'
                        USING ERRCODE = '23514';
                END IF;
            END IF;

            RETURN NEW;
        END IF;

    ELSIF TG_TABLE_NAME = 'orgs_accounterasure' THEN
        person := NEW.user_reference;

        IF TG_OP = 'INSERT' THEN
            SELECT COALESCE(array_agg(org_txt ORDER BY org_txt), ARRAY[]::text[])
            INTO target_org_ids
            FROM (
                SELECT DISTINCT m.organisation_id::text AS org_txt
                FROM public.orgs_membership m
                WHERE m.user_id = person
                UNION
                SELECT DISTINCT i.organisation_id::text AS org_txt
                FROM public.identity_identity i
                WHERE i.user_id = person AND i.organisation_id IS NOT NULL
            ) orgs;

            SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
            INTO signatory_sha256s
            FROM (
                SELECT DISTINCT encode(sha256(convert_to(tok, 'UTF8')), 'hex') AS sha
                FROM (
                    SELECT lower(btrim(u.email)) AS tok
                    FROM public.identity_user u WHERE u.id = person
                    UNION
                    SELECT lower(btrim(i.email)) AS tok
                    FROM public.identity_identity i WHERE i.user_id = person
                    UNION
                    SELECT lower(person::text) AS tok
                    UNION
                    SELECT lower(i.id::text) AS tok
                    FROM public.identity_identity i WHERE i.user_id = person
                    UNION
                    SELECT lower(btrim(i.subject)) AS tok
                    FROM public.identity_identity i WHERE i.user_id = person
                ) tokens
                WHERE tok IS NOT NULL AND tok <> '' AND tok NOT LIKE 'erased:%'
            ) digests;

            SELECT COALESCE(jsonb_agg(po.po_id ORDER BY po.po_id), '[]'::jsonb)
            INTO scrub_po_ids
            FROM public.ee_billing_purchase_orders po
            WHERE po.countersigned_by_user_id = person
               OR (
                   po.countersigned_by_user_id IS NULL
                   AND po.organisation_id = ANY(target_org_ids)
                   AND po.countersigned_by IS NOT NULL
                   AND (
                       encode(sha256(convert_to(lower(btrim(po.countersigned_by)), 'UTF8')), 'hex') IN (
                           SELECT jsonb_array_elements_text(signatory_sha256s)
                       )
                       OR EXISTS (
                           SELECT 1
                           FROM (
                               SELECT lower(btrim(u.email)) AS em
                               FROM public.identity_user u WHERE u.id = person
                               UNION
                               SELECT lower(btrim(i.email)) AS em
                               FROM public.identity_identity i WHERE i.user_id = person
                           ) addr
                           WHERE addr.em IS NOT NULL
                             AND addr.em <> ''
                             AND addr.em NOT LIKE 'erased:%'
                             AND strpos(lower(po.countersigned_by), addr.em) > 0
                       )
                   )
               );

            NEW.inventory := NEW.inventory || jsonb_build_object(
                'ee_billing_policy', 'retained_accounting_po_signatory_scrubbed',
                'ee_billing_target_org_ids', to_jsonb(target_org_ids),
                'ee_billing_signatory_sha256s', signatory_sha256s,
                'ee_billing_scrub_po_ids', scrub_po_ids
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            scrub_po_ids := COALESCE(NEW.inventory->'ee_billing_scrub_po_ids', '[]'::jsonb);
            signatory_sha256s := COALESCE(
                NEW.inventory->'ee_billing_signatory_sha256s',
                '[]'::jsonb
            );

            IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
                UPDATE public.ee_billing_purchase_orders po
                SET countersigned_by = CASE
                        WHEN po.countersigned_by IS NULL THEN NULL
                        ELSE 'erased:' || person::text
                    END,
                    countersigned_by_user_id = NULL,
                    pii_scrubbed_at = COALESCE(po.pii_scrubbed_at, clock_timestamp())
                WHERE (
                    po.countersigned_by_user_id = person
                    OR po.po_id IN (SELECT jsonb_array_elements_text(scrub_po_ids))
                    OR (
                        po.countersigned_by_user_id IS NULL
                        AND po.organisation_id IN (
                            SELECT jsonb_array_elements_text(
                                COALESCE(NEW.inventory->'ee_billing_target_org_ids', '[]'::jsonb)
                            )
                        )
                        AND po.countersigned_by IS NOT NULL
                        AND encode(
                            sha256(convert_to(lower(btrim(po.countersigned_by)), 'UTF8')),
                            'hex'
                        ) IN (SELECT jsonb_array_elements_text(signatory_sha256s))
                    )
                )
                AND (
                    po.countersigned_by_user_id IS NOT NULL
                    OR (
                        po.countersigned_by IS DISTINCT FROM ('erased:' || person::text)
                        AND po.countersigned_by IS DISTINCT FROM 'erased'
                    )
                );
                GET DIAGNOSTICS po_sig_scrubbed = ROW_COUNT;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'ee_billing_signatories_scrubbed', po_sig_scrubbed
                );
            END IF;

            IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
                IF EXISTS (
                    SELECT 1 FROM public.ee_billing_purchase_orders po
                    WHERE po.countersigned_by_user_id = person
                       OR (
                           po.po_id IN (SELECT jsonb_array_elements_text(scrub_po_ids))
                           AND (
                               po.countersigned_by_user_id IS NOT NULL
                               OR (
                                   po.countersigned_by IS NOT NULL
                                   AND po.countersigned_by <> ('erased:' || person::text)
                                   AND po.countersigned_by <> 'erased'
                               )
                           )
                       )
                       OR (
                           po.countersigned_by_user_id IS NULL
                           AND po.organisation_id IN (
                               SELECT jsonb_array_elements_text(
                                   COALESCE(NEW.inventory->'ee_billing_target_org_ids', '[]'::jsonb)
                               )
                           )
                           AND po.countersigned_by IS NOT NULL
                           AND po.countersigned_by <> ('erased:' || person::text)
                           AND po.countersigned_by <> 'erased'
                           AND encode(
                               sha256(convert_to(lower(btrim(po.countersigned_by)), 'UTF8')),
                               'hex'
                           ) IN (SELECT jsonb_array_elements_text(signatory_sha256s))
                       )
                ) THEN
                    RAISE EXCEPTION 'enterprise billing signatory personal data still present'
                        USING ERRCODE = '23514';
                END IF;
            END IF;

            RETURN NEW;
        END IF;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_billing_erasure_journal_hook() FROM PUBLIC;

CREATE TRIGGER aa_ee_billing_privacy_cutoff
    BEFORE INSERT OR UPDATE OR DELETE ON public.ee_billing_purchase_orders
    FOR EACH ROW EXECUTE FUNCTION public.ee_billing_privacy_cutoff_guard();

CREATE TRIGGER aa_ee_billing_privacy_cutoff
    BEFORE INSERT OR UPDATE ON public.ee_billing_warm_pool_slots
    FOR EACH ROW EXECUTE FUNCTION public.ee_billing_privacy_cutoff_guard();

CREATE TRIGGER aa_02_ee_billing_erasure
    BEFORE INSERT OR UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.ee_billing_erasure_journal_hook();

CREATE TRIGGER aa_02_ee_billing_erasure
    BEFORE INSERT OR UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.ee_billing_erasure_journal_hook();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.orgs_privacyerasure
        WHERE status <> 'complete' AND inventory ? 'ee_billing_policy'
    ) OR EXISTS (
        SELECT 1 FROM public.orgs_accounterasure
        WHERE status <> 'complete' AND inventory ? 'ee_billing_policy'
    ) OR EXISTS (
        SELECT 1 FROM public.ee_billing_purchase_orders
        WHERE state IN ('countersigned', 'invoiced', 'paid')
           OR invoice_ref IS NOT NULL
           OR payment_ref IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'cannot reverse enterprise billing schema while retained obligations exist'
            USING ERRCODE = '23514';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS aa_02_ee_billing_erasure ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_02_ee_billing_erasure ON public.orgs_privacyerasure;
DROP TRIGGER IF EXISTS aa_ee_billing_privacy_cutoff ON public.ee_billing_warm_pool_slots;
DROP TRIGGER IF EXISTS aa_ee_billing_privacy_cutoff ON public.ee_billing_purchase_orders;
DROP FUNCTION IF EXISTS public.ee_billing_erasure_journal_hook();
DROP FUNCTION IF EXISTS public.ee_billing_privacy_cutoff_guard();
DROP FUNCTION IF EXISTS public.ee_billing_try_uuid(text);

DROP INDEX IF EXISTS ee_billing_po_signatory_user_idx;
DROP INDEX IF EXISTS ee_billing_po_org_idx;
DROP TABLE IF EXISTS ee_billing_purchase_orders;
DROP INDEX IF EXISTS ee_billing_wp_region_profile_state_idx;
DROP TABLE IF EXISTS ee_billing_warm_pool_slots;
DROP TABLE IF EXISTS ee_billing_sequences;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0023_stripe_webhook_deliveries"),
        ("orgs", "0031_account_erasure_completion"),
    ]
    operations = [
        migrations.RunSQL(sql=FORWARD, reverse_sql=REVERSE),
    ]

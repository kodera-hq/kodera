"""Attach GDPR Art. 17 account and organisation cutoff trigger to `idempotency_record`."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.idempotency_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    org uuid;
    webhook_org uuid := NULL;
    uid uuid;
    principal_sha text;
BEGIN
    principal_sha := encode(
        sha256(
            convert_to(NEW.issuer, 'UTF8')
            || decode('00', 'hex')
            || convert_to(NEW.subject, 'UTF8')
        ),
        'hex'
    );

    IF NEW.issuer LIKE 'urn:kodera:webhook:%'
       AND NEW.subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        webhook_org := NEW.subject::uuid;
    END IF;

    FOR org IN
        SELECT DISTINCT q.org_id FROM (
            SELECT o.id AS org_id
            FROM public.orgs_organisation o
            WHERE o.issuer = NEW.issuer
            UNION
            SELECT i.organisation_id AS org_id
            FROM public.identity_identity i
            WHERE i.issuer = NEW.issuer
              AND i.subject = NEW.subject
              AND i.organisation_id IS NOT NULL
            UNION
            SELECT webhook_org AS org_id
            WHERE webhook_org IS NOT NULL
        ) q
        WHERE q.org_id IS NOT NULL
        ORDER BY q.org_id
    LOOP
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_erasure_cutoff:' || org::text, 0)
        );
        IF EXISTS (
            SELECT 1 FROM public.orgs_privacyerasure
            WHERE organisation_reference = org
        ) AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'idempotency record organisation cutoff active'
                USING ERRCODE = '23514', CONSTRAINT = 'idempotency_privacy_cutoff';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM public.orgs_privacyerasure pe
        WHERE COALESCE(pe.inventory->'org_principal_sha256s', '[]'::jsonb) ? principal_sha
    ) THEN
        RAISE EXCEPTION 'idempotency record organisation cutoff active'
            USING ERRCODE = '23514', CONSTRAINT = 'idempotency_privacy_cutoff';
    END IF;

    FOR uid IN
        SELECT DISTINCT i.user_id
        FROM public.identity_identity i
        WHERE i.issuer = NEW.issuer AND i.subject = NEW.subject
        ORDER BY i.user_id
    LOOP
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || uid::text, 0)
        );
        IF EXISTS (
            SELECT 1 FROM public.orgs_accounterasure
            WHERE user_reference = uid
        ) AND NOT public.privacy_account_context(uid) THEN
            RAISE EXCEPTION 'idempotency record account cutoff active'
                USING ERRCODE = '23514', CONSTRAINT = 'idempotency_privacy_cutoff';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM public.orgs_accounterasure ae
        WHERE COALESCE(ae.inventory->'identity_principal_sha256s', '[]'::jsonb) ? principal_sha
    ) THEN
        RAISE EXCEPTION 'idempotency record account cutoff active'
            USING ERRCODE = '23514', CONSTRAINT = 'idempotency_privacy_cutoff';
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.idempotency_privacy_cutoff_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS aa_idempotency_privacy_cutoff ON public.idempotency_record;
CREATE TRIGGER aa_idempotency_privacy_cutoff
    BEFORE INSERT OR UPDATE ON public.idempotency_record
    FOR EACH ROW EXECUTE FUNCTION public.idempotency_privacy_cutoff_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.idempotency_record) AND (
        EXISTS (
            SELECT 1 FROM public.orgs_accounterasure WHERE status <> 'complete'
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_privacyerasure WHERE status <> 'complete'
        )
    ) THEN
        RAISE EXCEPTION 'cannot reverse idempotency privacy cutoff guard while incomplete erasure exists'
            USING ERRCODE = '23514';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS aa_idempotency_privacy_cutoff ON public.idempotency_record;
DROP FUNCTION IF EXISTS public.idempotency_privacy_cutoff_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("idempotency", "0001_initial"),
        ("orgs", "0033_proximity_erasure_inventory"),
    ]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

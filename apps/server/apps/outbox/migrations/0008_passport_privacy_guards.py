"""Person-ownership and privacy cutoff guard for sealed `passport_magic_link` outbox messages."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.passport_outbox_message_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    b_user uuid;
    b_org uuid;
BEGIN
    IF NEW.template_id <> 'passport_magic_link' OR NEW.sealed IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT user_id, organisation_id
    INTO b_user, b_org
    FROM public.identity_passportoutboxbinding
    WHERE delivery_id = NEW.delivery_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'passport outbox message requires recipient binding'
            USING ERRCODE = '23514';
    END IF;

    IF public.privacy_account_context(b_user) OR public.privacy_erasure_context(b_org) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_account_cutoff:' || b_user::text, 0)
    );

    IF NOT EXISTS (
        SELECT 1 FROM public.identity_user u
        WHERE u.id = b_user AND u.enabled AND u.deleted_at IS NULL
    ) OR EXISTS (
        SELECT 1 FROM public.orgs_accounterasure ae
        WHERE ae.user_reference = b_user
    ) THEN
        RAISE EXCEPTION 'passport outbox message account cutoff active'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.passport_outbox_message_guard() FROM PUBLIC;

CREATE TRIGGER ab_passport_account_cutoff
    BEFORE INSERT OR UPDATE ON public.outbox_message
    FOR EACH ROW EXECUTE FUNCTION public.passport_outbox_message_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.orgs_accounterasure
        WHERE status <> 'complete'
          AND jsonb_array_length(COALESCE(inventory->'passport_delivery_ids', '[]'::jsonb)) > 0
    ) THEN
        RAISE EXCEPTION 'cannot reverse passport outbox privacy guard while incomplete account erasure exists'
            USING ERRCODE = '23514';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS ab_passport_account_cutoff ON public.outbox_message;
DROP FUNCTION IF EXISTS public.passport_outbox_message_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("outbox", "0007_privacy_cutoff_guards"),
        ("identity", "0007_passport_magic_link"),
        ("orgs", "0031_account_erasure_completion"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

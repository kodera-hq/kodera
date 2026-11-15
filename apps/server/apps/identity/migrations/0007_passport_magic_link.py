"""Kodera Passport single-use magic-link tokens, rate-limit events, outbox bindings, and privacy guards."""

from django.db import migrations, models

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7

PASSPORT_PRIVACY_FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.passport_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    email_sha text;
BEGIN
    IF TG_TABLE_NAME = 'identity_passportworkspacecontext' THEN
        IF public.privacy_account_context(NEW.user_id)
           OR public.privacy_erasure_context(NEW.active_organisation_id) THEN
            RETURN NEW;
        END IF;

        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || NEW.user_id::text, 0)
        );
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_erasure_cutoff:' || NEW.active_organisation_id::text, 0)
        );

        IF NOT EXISTS (
            SELECT 1 FROM public.identity_user u
            WHERE u.id = NEW.user_id AND u.enabled AND u.deleted_at IS NULL
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_accounterasure ae
            WHERE ae.user_reference = NEW.user_id
        ) THEN
            RAISE EXCEPTION 'passport workspace context account cutoff active'
                USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.orgs_organisation o
            WHERE o.id = NEW.active_organisation_id
              AND o.state = 'active'
              AND o.deleted_at IS NULL
              AND o.realm <> 'kodera-staff'
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_privacyerasure pe
            WHERE pe.organisation_reference = NEW.active_organisation_id
        ) THEN
            RAISE EXCEPTION 'passport workspace context organisation cutoff active'
                USING ERRCODE = '23514';
        END IF;

        IF NEW.active_workspace_id IS NOT NULL
           AND to_regclass('public.workspaces_workspace') IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.workspaces_workspace w
                WHERE w.id = NEW.active_workspace_id
                  AND w.organisation_id = NEW.active_organisation_id
            ) THEN
                RAISE EXCEPTION 'passport workspace context workspace mismatch'
                    USING ERRCODE = '23514';
            END IF;
        END IF;

        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'identity_passportoutboxbinding' THEN
        IF TG_OP = 'UPDATE' THEN
            RAISE EXCEPTION 'passport outbox binding immutable'
                USING ERRCODE = '23514';
        END IF;

        IF public.privacy_account_context(NEW.user_id)
           OR public.privacy_erasure_context(NEW.organisation_id) THEN
            RETURN NEW;
        END IF;

        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || NEW.user_id::text, 0)
        );
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_erasure_cutoff:' || NEW.organisation_id::text, 0)
        );

        IF NOT EXISTS (
            SELECT 1 FROM public.identity_user u
            WHERE u.id = NEW.user_id AND u.enabled AND u.deleted_at IS NULL
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_accounterasure ae
            WHERE ae.user_reference = NEW.user_id
        ) THEN
            RAISE EXCEPTION 'passport outbox binding account cutoff active'
                USING ERRCODE = '23514';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.orgs_organisation o
            WHERE o.id = NEW.organisation_id
              AND o.state = 'active'
              AND o.deleted_at IS NULL
              AND o.realm <> 'kodera-staff'
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_privacyerasure pe
            WHERE pe.organisation_reference = NEW.organisation_id
        ) THEN
            RAISE EXCEPTION 'passport outbox binding organisation cutoff active'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'identity_passportmagiclinktoken' THEN
        IF TG_OP = 'UPDATE'
           AND OLD.consumed_at IS NULL
           AND NEW.consumed_at IS NOT NULL
           AND NEW.token_sha256 = OLD.token_sha256
           AND NEW.email_normalized = OLD.email_normalized
           AND NEW.domain_normalized = OLD.domain_normalized
           AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
           AND NEW.delivery_id IS NOT DISTINCT FROM OLD.delivery_id THEN
            RETURN NEW;
        END IF;

        IF NEW.user_id IS NOT NULL THEN
            IF public.privacy_account_context(NEW.user_id) THEN
                RETURN NEW;
            END IF;
            PERFORM pg_advisory_xact_lock_shared(
                hashtextextended('privacy_account_cutoff:' || NEW.user_id::text, 0)
            );
            IF NOT EXISTS (
                SELECT 1 FROM public.identity_user u
                WHERE u.id = NEW.user_id AND u.enabled AND u.deleted_at IS NULL
            ) OR EXISTS (
                SELECT 1 FROM public.orgs_accounterasure ae
                WHERE ae.user_reference = NEW.user_id
            ) OR EXISTS (
                SELECT 1 FROM public.orgs_privacyerasure pe
                WHERE pe.status IN ('cutoff', 'core_purged')
                  AND COALESCE(pe.inventory->'passport_unshared_user_ids', '[]'::jsonb)
                      ? NEW.user_id::text
            ) THEN
                RAISE EXCEPTION 'passport magic-link token account cutoff active'
                    USING ERRCODE = '23514';
            END IF;

            IF NEW.delivery_id IS NOT NULL THEN
                IF NOT EXISTS (
                    SELECT 1
                    FROM public.identity_passportoutboxbinding b
                    WHERE b.delivery_id = NEW.delivery_id
                      AND b.user_id = NEW.user_id
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = b.organisation_id
                      )
                ) THEN
                    RAISE EXCEPTION 'passport magic-link token delivery cutoff active'
                        USING ERRCODE = '23514';
                END IF;
            END IF;

            RETURN NEW;
        END IF;

        email_sha := encode(
            sha256(convert_to(lower(btrim(NEW.email_normalized)), 'UTF8')),
            'hex'
        );

        IF EXISTS (
            SELECT 1 FROM public.identity_user u
            JOIN public.orgs_accounterasure ae ON ae.user_reference = u.id
            WHERE lower(btrim(u.email)) = lower(btrim(NEW.email_normalized))
              AND ae.status IN ('cutoff', 'core_purged')
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_accounterasure ae
            WHERE ae.status IN ('cutoff', 'core_purged')
              AND COALESCE(ae.inventory->'passport_email_sha256s', '[]'::jsonb) ? email_sha
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_privacyerasure pe
            WHERE pe.status IN ('cutoff', 'core_purged')
              AND COALESCE(pe.inventory->'passport_unshared_email_sha256s', '[]'::jsonb) ? email_sha
        ) THEN
            RAISE EXCEPTION 'passport magic-link token privacy erasure in progress'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.passport_privacy_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.passport_erasure_journal_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    person uuid;
    org uuid;
    email_sha256s jsonb := '[]'::jsonb;
    delivery_ids jsonb := '[]'::jsonb;
    unshared_user_ids uuid[] := ARRAY[]::uuid[];
    unshared_user_ids_json jsonb := '[]'::jsonb;
    unshared_email_sha256s jsonb := '[]'::jsonb;
    c_ctx bigint := 0;
    c_tok bigint := 0;
BEGIN
    IF TG_TABLE_NAME = 'orgs_accounterasure' THEN
        person := NEW.user_reference;

        IF TG_OP = 'INSERT' THEN
            IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM public.identity_passportoutboxbinding b
                    JOIN public.outbox_outboxdelivery d ON d.id = b.delivery_id
                    WHERE b.user_id = person AND d.status = 'in_flight'
                ) THEN
                    RAISE EXCEPTION 'account erasure passport delivery drain required'
                        USING ERRCODE = '23514';
                END IF;
            END IF;

            SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
            INTO email_sha256s
            FROM (
                SELECT DISTINCT encode(sha256(convert_to(em, 'UTF8')), 'hex') AS sha
                FROM (
                    SELECT lower(btrim(u.email)) AS em
                    FROM public.identity_user u WHERE u.id = person
                    UNION
                    SELECT lower(btrim(i.email)) AS em
                    FROM public.identity_identity i WHERE i.user_id = person
                ) raw_emails
                WHERE em IS NOT NULL AND em <> '' AND em NOT LIKE 'erased:%'
            ) digests;

            SELECT COALESCE(jsonb_agg(b.delivery_id::text ORDER BY b.delivery_id), '[]'::jsonb)
            INTO delivery_ids
            FROM public.identity_passportoutboxbinding b
            WHERE b.user_id = person;

            DELETE FROM public.identity_passportworkspacecontext WHERE user_id = person;

            DELETE FROM public.identity_passportmagiclinktoken t
            WHERE t.user_id = person
               OR (
                   t.user_id IS NULL
                   AND encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') IN (
                       SELECT jsonb_array_elements_text(email_sha256s)
                   )
               );

            DELETE FROM public.identity_passportratelimitevent
            WHERE occurred_at <= clock_timestamp() - interval '10 minutes';

            IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
               AND to_regclass('public.outbox_message') IS NOT NULL THEN
                UPDATE public.outbox_message m
                SET sealed = NULL
                FROM public.identity_passportoutboxbinding b, public.outbox_outboxdelivery d
                WHERE b.user_id = person
                  AND d.id = b.delivery_id
                  AND m.delivery_id = d.id
                  AND m.sealed IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM public.orgs_privacyerasure pe
                      WHERE pe.organisation_reference = d.organisation_id
                  );

                UPDATE public.outbox_outboxdelivery d
                SET status = 'failed',
                    finished_at = COALESCE(d.finished_at, clock_timestamp()),
                    updated_at = clock_timestamp()
                FROM public.identity_passportoutboxbinding b
                WHERE b.user_id = person
                  AND d.id = b.delivery_id
                  AND d.status = 'pending'
                  AND NOT EXISTS (
                      SELECT 1 FROM public.orgs_privacyerasure pe
                      WHERE pe.organisation_reference = d.organisation_id
                  );
            END IF;

            NEW.inventory := NEW.inventory || jsonb_build_object(
                'passport_inventory_version', 1,
                'passport_email_sha256s', email_sha256s,
                'passport_delivery_ids', delivery_ids
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            email_sha256s := COALESCE(NEW.inventory->'passport_email_sha256s', '[]'::jsonb);

            IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
                DELETE FROM public.identity_passportworkspacecontext WHERE user_id = person;
                GET DIAGNOSTICS c_ctx = ROW_COUNT;

                DELETE FROM public.identity_passportmagiclinktoken t
                WHERE t.user_id = person
                   OR (
                       t.user_id IS NULL
                       AND encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') IN (
                           SELECT jsonb_array_elements_text(email_sha256s)
                       )
                   );
                GET DIAGNOSTICS c_tok = ROW_COUNT;

                DELETE FROM public.identity_passportratelimitevent
                WHERE occurred_at <= clock_timestamp() - interval '10 minutes';

                IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
                   AND to_regclass('public.outbox_message') IS NOT NULL THEN
                    UPDATE public.outbox_message m
                    SET sealed = NULL
                    FROM public.identity_passportoutboxbinding b, public.outbox_outboxdelivery d
                    WHERE b.user_id = person
                      AND d.id = b.delivery_id
                      AND m.delivery_id = d.id
                      AND m.sealed IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = d.organisation_id
                      );

                    UPDATE public.outbox_outboxdelivery d
                    SET status = 'failed',
                        finished_at = COALESCE(d.finished_at, clock_timestamp()),
                        updated_at = clock_timestamp()
                    FROM public.identity_passportoutboxbinding b
                    WHERE b.user_id = person
                      AND d.id = b.delivery_id
                      AND d.status = 'pending'
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = d.organisation_id
                      );
                END IF;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'passport_contexts', c_ctx,
                    'passport_tokens', c_tok
                );
            END IF;

            IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
                IF EXISTS (
                    SELECT 1 FROM public.identity_passportworkspacecontext
                    WHERE user_id = person
                ) OR EXISTS (
                    SELECT 1 FROM public.identity_passportmagiclinktoken t
                    WHERE t.user_id = person
                       OR (
                           t.user_id IS NULL
                           AND encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') IN (
                               SELECT jsonb_array_elements_text(email_sha256s)
                           )
                       )
                ) THEN
                    RAISE EXCEPTION 'passport operational personal data still present'
                        USING ERRCODE = '23514';
                END IF;

                IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
                   AND to_regclass('public.outbox_message') IS NOT NULL THEN
                    IF EXISTS (
                        SELECT 1 FROM public.identity_passportoutboxbinding b
                        JOIN public.outbox_outboxdelivery d ON d.id = b.delivery_id
                        LEFT JOIN public.outbox_message m ON m.delivery_id = d.id
                        WHERE b.user_id = person
                          AND (
                              d.status = 'in_flight'
                              OR m.sealed IS NOT NULL
                              OR (
                                  d.status = 'pending'
                                  AND NOT EXISTS (
                                      SELECT 1 FROM public.orgs_privacyerasure pe
                                      WHERE pe.organisation_reference = d.organisation_id
                                  )
                              )
                          )
                    ) THEN
                        RAISE EXCEPTION 'passport outbox personal data still present'
                            USING ERRCODE = '23514';
                    END IF;
                END IF;

                DELETE FROM public.identity_passportoutboxbinding WHERE user_id = person;
            END IF;

            RETURN NEW;
        END IF;

    ELSIF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
        org := NEW.organisation_reference;

        IF TG_OP = 'INSERT' THEN
            SELECT COALESCE(array_agg(u.id ORDER BY u.id), ARRAY[]::uuid[])
            INTO unshared_user_ids
            FROM public.identity_user u
            WHERE (
                EXISTS (
                    SELECT 1 FROM public.identity_identity i
                    WHERE i.user_id = u.id AND i.organisation_id = org
                )
                OR EXISTS (
                    SELECT 1 FROM public.orgs_membership m
                    WHERE m.user_id = u.id AND m.organisation_id = org
                )
            )
            AND NOT EXISTS (
                SELECT 1 FROM public.identity_identity i
                WHERE i.user_id = u.id
                  AND (i.organisation_id IS DISTINCT FROM org)
                  AND i.enabled
                  AND i.deleted_at IS NULL
            )
            AND NOT EXISTS (
                SELECT 1 FROM public.orgs_membership m
                WHERE m.user_id = u.id
                  AND m.organisation_id <> org
                  AND m.state = 'active'
                  AND m.accepted_at IS NOT NULL
                  AND m.deleted_at IS NULL
            );

            SELECT COALESCE(jsonb_agg(uid::text ORDER BY uid::text), '[]'::jsonb)
            INTO unshared_user_ids_json
            FROM unnest(unshared_user_ids) AS uid;

            SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
            INTO unshared_email_sha256s
            FROM (
                SELECT DISTINCT encode(sha256(convert_to(em, 'UTF8')), 'hex') AS sha
                FROM (
                    SELECT lower(btrim(u.email)) AS em
                    FROM public.identity_user u
                    WHERE u.id = ANY(unshared_user_ids)
                    UNION
                    SELECT lower(btrim(i.email)) AS em
                    FROM public.identity_identity i
                    WHERE i.organisation_id = org AND i.user_id = ANY(unshared_user_ids)
                ) raw_emails
                WHERE em IS NOT NULL AND em <> '' AND em NOT LIKE 'erased:%'
            ) digests;

            DELETE FROM public.identity_passportworkspacecontext
            WHERE active_organisation_id = org;

            DELETE FROM public.identity_passportmagiclinktoken t
            WHERE t.delivery_id IN (
                      SELECT b.delivery_id
                      FROM public.identity_passportoutboxbinding b
                      WHERE b.organisation_id = org
                  )
               OR t.user_id = ANY(unshared_user_ids)
               OR (
                   t.user_id IS NULL
                   AND encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') IN (
                       SELECT jsonb_array_elements_text(unshared_email_sha256s)
                   )
               );

            DELETE FROM public.identity_passportratelimitevent
            WHERE occurred_at <= clock_timestamp() - interval '10 minutes';

            IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
               AND to_regclass('public.outbox_message') IS NOT NULL THEN
                UPDATE public.outbox_message m
                SET sealed = NULL
                FROM public.outbox_outboxdelivery d
                WHERE d.organisation_id = org
                  AND m.delivery_id = d.id
                  AND m.template_id = 'passport_magic_link'
                  AND m.sealed IS NOT NULL;

                UPDATE public.outbox_outboxdelivery d
                SET status = 'failed',
                    finished_at = COALESCE(d.finished_at, clock_timestamp()),
                    updated_at = clock_timestamp()
                FROM public.outbox_message m
                WHERE d.organisation_id = org
                  AND m.delivery_id = d.id
                  AND m.template_id = 'passport_magic_link'
                  AND d.status = 'pending';
            END IF;

            NEW.inventory := NEW.inventory || jsonb_build_object(
                'passport_inventory_version', 1,
                'passport_unshared_user_ids', unshared_user_ids_json,
                'passport_unshared_email_sha256s', unshared_email_sha256s
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            unshared_user_ids_json := COALESCE(
                NEW.inventory->'passport_unshared_user_ids',
                '[]'::jsonb
            );
            unshared_email_sha256s := COALESCE(
                NEW.inventory->'passport_unshared_email_sha256s',
                '[]'::jsonb
            );

            IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
                DELETE FROM public.identity_passportworkspacecontext
                WHERE active_organisation_id = org;
                GET DIAGNOSTICS c_ctx = ROW_COUNT;

                DELETE FROM public.identity_passportmagiclinktoken t
                WHERE t.delivery_id IN (
                          SELECT b.delivery_id
                          FROM public.identity_passportoutboxbinding b
                          WHERE b.organisation_id = org
                      )
                   OR (
                       t.user_id IS NOT NULL
                       AND unshared_user_ids_json ? t.user_id::text
                   )
                   OR (
                       t.user_id IS NULL
                       AND encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') IN (
                           SELECT jsonb_array_elements_text(unshared_email_sha256s)
                       )
                   );
                GET DIAGNOSTICS c_tok = ROW_COUNT;

                DELETE FROM public.identity_passportratelimitevent
                WHERE occurred_at <= clock_timestamp() - interval '10 minutes';

                IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
                   AND to_regclass('public.outbox_message') IS NOT NULL THEN
                    UPDATE public.outbox_message m
                    SET sealed = NULL
                    FROM public.outbox_outboxdelivery d
                    WHERE d.organisation_id = org
                      AND m.delivery_id = d.id
                      AND m.template_id = 'passport_magic_link'
                      AND m.sealed IS NOT NULL;

                    UPDATE public.outbox_outboxdelivery d
                    SET status = 'failed',
                        finished_at = COALESCE(d.finished_at, clock_timestamp()),
                        updated_at = clock_timestamp()
                    FROM public.outbox_message m
                    WHERE d.organisation_id = org
                      AND m.delivery_id = d.id
                      AND m.template_id = 'passport_magic_link'
                      AND d.status = 'pending';
                END IF;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'passport_contexts', c_ctx,
                    'passport_tokens', c_tok
                );
            END IF;

            IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
                IF EXISTS (
                    SELECT 1 FROM public.identity_passportworkspacecontext
                    WHERE active_organisation_id = org
                ) OR EXISTS (
                    SELECT 1 FROM public.identity_passportmagiclinktoken t
                    WHERE t.delivery_id IN (
                              SELECT b.delivery_id
                              FROM public.identity_passportoutboxbinding b
                              WHERE b.organisation_id = org
                          )
                       OR (
                           t.user_id IS NOT NULL
                           AND unshared_user_ids_json ? t.user_id::text
                       )
                       OR (
                           t.user_id IS NULL
                           AND encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') IN (
                               SELECT jsonb_array_elements_text(unshared_email_sha256s)
                           )
                       )
                ) THEN
                    RAISE EXCEPTION 'passport organisation operational data still present'
                        USING ERRCODE = '23514';
                END IF;

                IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
                   AND to_regclass('public.outbox_message') IS NOT NULL THEN
                    IF EXISTS (
                        SELECT 1 FROM public.outbox_outboxdelivery d
                        JOIN public.outbox_message m ON m.delivery_id = d.id
                        WHERE d.organisation_id = org
                          AND m.template_id = 'passport_magic_link'
                          AND (d.status IN ('pending', 'in_flight') OR m.sealed IS NOT NULL)
                    ) THEN
                        RAISE EXCEPTION 'passport organisation outbox data still present'
                            USING ERRCODE = '23514';
                    END IF;
                END IF;

                DELETE FROM public.identity_passportoutboxbinding WHERE organisation_id = org;
            END IF;

            RETURN NEW;
        END IF;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.passport_erasure_journal_hook() FROM PUBLIC;

CREATE TRIGGER aa_passport_privacy_cutoff
    BEFORE INSERT OR UPDATE ON public.identity_passportworkspacecontext
    FOR EACH ROW EXECUTE FUNCTION public.passport_privacy_cutoff_guard();

CREATE TRIGGER aa_passport_privacy_cutoff
    BEFORE INSERT OR UPDATE ON public.identity_passportmagiclinktoken
    FOR EACH ROW EXECUTE FUNCTION public.passport_privacy_cutoff_guard();

CREATE TRIGGER aa_passport_privacy_cutoff
    BEFORE INSERT OR UPDATE ON public.identity_passportoutboxbinding
    FOR EACH ROW EXECUTE FUNCTION public.passport_privacy_cutoff_guard();

CREATE TRIGGER aa_01_passport_erasure
    BEFORE INSERT OR UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.passport_erasure_journal_hook();

CREATE TRIGGER aa_01_passport_erasure
    BEFORE INSERT OR UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.passport_erasure_journal_hook();
"""

PASSPORT_PRIVACY_REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.orgs_privacyerasure
        WHERE status <> 'complete' AND inventory ? 'passport_inventory_version'
    ) OR EXISTS (
        SELECT 1 FROM public.orgs_accounterasure
        WHERE status <> 'complete' AND inventory ? 'passport_inventory_version'
    ) THEN
        RAISE EXCEPTION 'cannot reverse passport privacy guards while incomplete erasure journal exists'
            USING ERRCODE = '23514';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS aa_01_passport_erasure ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_01_passport_erasure ON public.orgs_privacyerasure;
DROP TRIGGER IF EXISTS aa_passport_privacy_cutoff ON public.identity_passportoutboxbinding;
DROP TRIGGER IF EXISTS aa_passport_privacy_cutoff ON public.identity_passportmagiclinktoken;
DROP TRIGGER IF EXISTS aa_passport_privacy_cutoff ON public.identity_passportworkspacecontext;
DROP FUNCTION IF EXISTS public.passport_erasure_journal_hook();
DROP FUNCTION IF EXISTS public.passport_privacy_cutoff_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("identity", "0006_discovery_quotas"),
        ("orgs", "0031_account_erasure_completion"),
    ]

    operations = [
        migrations.RunSQL(
            sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name="PassportRateLimitEvent",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("scope", models.TextField()),
                ("digest", models.TextField()),
                ("occurred_at", models.DateTimeField(db_default=ClockTimestamp())),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["scope", "digest", "occurred_at"],
                        name="passport_rl_scope_digest_idx",
                    ),
                    models.Index(fields=["occurred_at"], name="passport_rl_time_idx"),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(scope__in=("ip", "email")),
                        name="passport_rl_scope_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(digest__regex=r"^[0-9a-f]{64}$"),
                        name="passport_rl_digest_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="PassportMagicLinkToken",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("token_sha256", models.TextField(unique=True)),
                ("email_normalized", models.TextField()),
                ("domain_normalized", models.TextField()),
                ("code_challenge", models.TextField()),
                ("code_challenge_method", models.TextField(default="S256")),
                ("device_challenge_sha256", models.TextField(blank=True, null=True)),
                ("user_id", models.UUIDField(blank=True, null=True)),
                ("delivery_id", models.UUIDField(blank=True, null=True, unique=True)),
                ("expires_at", models.DateTimeField()),
                ("consumed_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["email_normalized", "-created_at"],
                        name="passport_token_email_idx",
                    ),
                    models.Index(fields=["expires_at"], name="passport_token_exp_idx"),
                ],
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(token_sha256__regex=r"^[0-9a-f]{64}$"),
                        name="passport_token_sha256_valid",
                    ),
                    models.CheckConstraint(
                        condition=~models.Q(email_normalized="") & ~models.Q(domain_normalized=""),
                        name="passport_token_email_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(code_challenge_method="S256"),
                        name="passport_token_method_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(code_challenge__regex=r"^[A-Za-z0-9_-]{43}$"),
                        name="passport_token_challenge_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(device_challenge_sha256__isnull=True)
                        | models.Q(device_challenge_sha256__regex=r"^[0-9a-f]{64}$"),
                        name="passport_token_device_valid",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="PassportWorkspaceContext",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user_id", models.UUIDField(unique=True)),
                ("active_organisation_id", models.UUIDField()),
                ("active_workspace_id", models.UUIDField(blank=True, null=True)),
            ],
            options={"abstract": False},
        ),
        migrations.CreateModel(
            name="PassportOutboxBinding",
            fields=[
                (
                    "delivery_id",
                    models.UUIDField(
                        default=new_uuid7, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("user_id", models.UUIDField()),
                ("organisation_id", models.UUIDField()),
                ("created_at", models.DateTimeField(db_default=ClockTimestamp())),
            ],
            options={
                "db_table": "identity_passportoutboxbinding",
                "indexes": [
                    models.Index(
                        fields=["user_id", "delivery_id"],
                        name="passport_outbox_user_idx",
                    ),
                    models.Index(
                        fields=["organisation_id", "delivery_id"],
                        name="passport_outbox_org_idx",
                    ),
                ],
            },
        ),
        migrations.RunSQL(
            sql=PASSPORT_PRIVACY_FORWARD,
            reverse_sql=PASSPORT_PRIVACY_REVERSE,
        ),
    ]

"""Shared-realm PME self-serve columns and dedicated-issuer uniqueness boundary."""

from django.db import migrations, models

FORWARD_ACCOUNT_ERASURE = r"""
CREATE OR REPLACE FUNCTION public.privacy_admit_account_erasure(
    p_id uuid,
    p_identity uuid,
    p_instruction text,
    p_digest text,
    p_not_before timestamptz,
    p_actor uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '3s' SET statement_timeout = '15s' AS $$
DECLARE
    person uuid;
    locked_org_id uuid;
    initial_orgs uuid[] := ARRAY[]::uuid[];
    post_lock_orgs uuid[] := ARRAY[]::uuid[];
BEGIN
    IF p_id IS NULL OR p_identity IS NULL
       OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
       OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
       OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor) THEN
        RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE = '23514';
    END IF;
    SELECT user_id INTO person
    FROM public.identity_identity
    WHERE id = p_identity AND organisation_id IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE = '23514';
    END IF;

    WITH direct_orgs AS (
        SELECT m.organisation_id AS direct_org_id
        FROM public.orgs_membership m
        WHERE m.user_id = person
        UNION
        SELECT i.organisation_id AS direct_org_id
        FROM public.identity_identity i
        WHERE i.user_id = person AND i.organisation_id IS NOT NULL
    )
    SELECT coalesce(array_agg(q.resolved_org_id ORDER BY q.resolved_org_id), ARRAY[]::uuid[])
    INTO initial_orgs
    FROM (
        SELECT d.direct_org_id AS resolved_org_id
        FROM direct_orgs d
        WHERE d.direct_org_id IS NOT NULL
        UNION
        SELECT host.id AS resolved_org_id
        FROM direct_orgs d
        JOIN public.orgs_organisation o ON o.id = d.direct_org_id
        JOIN public.orgs_organisation host
          ON host.is_default_community
         AND host.deleted_at IS NULL
         AND host.realm = o.realm
        WHERE o.shared_realm
    ) q;

    -- 1. Advisory fences strictly before row locks: sorted org cutoffs -> exclusive account cutoff.
    FOREACH locked_org_id IN ARRAY initial_orgs LOOP
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_erasure_cutoff:' || locked_org_id::text, 0)
        );
    END LOOP;
    PERFORM pg_advisory_xact_lock(
        hashtextextended('privacy_account_cutoff:' || person::text, 0)
    );

    -- 2. Row locks in canonical `identity_user -> orgs_organisation (ORDER BY id)` order.
    PERFORM 1 FROM public.identity_user
    WHERE id = person AND enabled AND deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'account erasure person unavailable' USING ERRCODE = '23514';
    END IF;

    PERFORM 1 FROM public.orgs_organisation
    WHERE id = ANY(initial_orgs)
    ORDER BY id
    FOR UPDATE;

    -- 3. Verify `person`'s organisation + shared-host set did not change before row locks were acquired.
    WITH direct_orgs AS (
        SELECT m.organisation_id AS direct_org_id
        FROM public.orgs_membership m
        WHERE m.user_id = person
        UNION
        SELECT i.organisation_id AS direct_org_id
        FROM public.identity_identity i
        WHERE i.user_id = person AND i.organisation_id IS NOT NULL
    )
    SELECT coalesce(array_agg(q.resolved_org_id ORDER BY q.resolved_org_id), ARRAY[]::uuid[])
    INTO post_lock_orgs
    FROM (
        SELECT d.direct_org_id AS resolved_org_id
        FROM direct_orgs d
        WHERE d.direct_org_id IS NOT NULL
        UNION
        SELECT host.id AS resolved_org_id
        FROM direct_orgs d
        JOIN public.orgs_organisation o ON o.id = d.direct_org_id
        JOIN public.orgs_organisation host
          ON host.is_default_community
         AND host.deleted_at IS NULL
         AND host.realm = o.realm
        WHERE o.shared_realm
    ) q;
    IF post_lock_orgs IS DISTINCT FROM initial_orgs THEN
        RAISE EXCEPTION 'account erasure concurrent organisation set changed'
            USING ERRCODE = '40001';
    END IF;

    RETURN public.privacy_begin_account_erasure(
        p_id, p_identity, p_instruction, p_digest, p_not_before, p_actor
    );
END $$;
REVOKE ALL ON FUNCTION public.privacy_admit_account_erasure(uuid, uuid, text, text, timestamptz, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shared_realm_account_erasure_hook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '3s' SET statement_timeout = '10s' AS $$
DECLARE
    extra_member_revs jsonb := '{}'::jsonb;
BEGIN
    IF TG_OP = 'INSERT' AND to_regclass('public.engine_intents_head') IS NOT NULL THEN
        SELECT coalesce(jsonb_object_agg(host.id::text, coalesce(h.revision, 0)), '{}'::jsonb)
        INTO extra_member_revs
        FROM public.orgs_organisation host
        LEFT JOIN public.engine_intents_head h ON h.organisation_id = host.id
        WHERE host.is_default_community
          AND host.deleted_at IS NULL
          AND NOT (coalesce(NEW.inventory->'engine_member_revisions', '{}'::jsonb) ? (host.id::text))
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(coalesce(NEW.inventory->'organisations', '[]'::jsonb)) elem(val)
              JOIN public.orgs_organisation o ON o.id = elem.val::uuid
              WHERE o.shared_realm
                AND o.realm = host.realm
          );
        IF extra_member_revs <> '{}'::jsonb THEN
            NEW.inventory := jsonb_set(
                NEW.inventory,
                '{engine_member_revisions}',
                coalesce(NEW.inventory->'engine_member_revisions', '{}'::jsonb) || extra_member_revs
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shared_realm_account_erasure_hook() FROM PUBLIC;

DROP TRIGGER IF EXISTS aa_04_shared_realm_account_erasure ON public.orgs_accounterasure;
CREATE TRIGGER aa_04_shared_realm_account_erasure
    BEFORE INSERT ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.shared_realm_account_erasure_hook();

CREATE OR REPLACE FUNCTION public.privacy_account_protocol_recorded(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE;
BEGIN
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.orgs_membership WHERE user_id=request.user_reference AND state<>'removed' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'account membership erasure protocol incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.identity_identity i JOIN public.orgs_organisation o ON o.id=i.organisation_id
 WHERE i.user_id=request.user_reference AND (o.state<>'closed' OR (o.shared_realm AND i.subject NOT LIKE 'erased:%' AND NOT EXISTS(SELECT 1 FROM public.orgs_privacyerasure pe WHERE pe.organisation_reference=o.id))) AND NOT EXISTS(
 SELECT 1 FROM public.engine_intents_known_subject k WHERE k.organisation_id=i.organisation_id AND k.user_id=i.user_id
 AND k.subject=i.subject AND k.erased_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.orgs_organisation o ON o.id=m.organisation_id
 WHERE m.user_id=request.user_reference AND o.state<>'closed' AND (
  (NOT o.shared_realm AND NOT EXISTS(
   SELECT 1 FROM public.engine_intents_member_set s WHERE s.organisation_id=m.organisation_id AND s.revision>coalesce((request.inventory->'engine_member_revisions'->>m.organisation_id::text)::bigint,0)
   AND s.authority_revision=o.authority_revision
   AND NOT EXISTS(SELECT 1 FROM public.engine_intents_known_subject k WHERE k.organisation_id=m.organisation_id AND k.user_id=request.user_reference
   AND k.erased_at IS NOT NULL AND NOT coalesce(s.erased_subjects,'[]'::jsonb) ? k.subject)))
  OR (o.shared_realm
   AND EXISTS(SELECT 1 FROM public.orgs_organisation host WHERE host.is_default_community AND host.deleted_at IS NULL AND host.realm=o.realm AND host.state<>'closed')
   AND NOT EXISTS(
    SELECT 1 FROM public.orgs_organisation host
    JOIN public.engine_intents_member_set s ON s.organisation_id=host.id
    WHERE host.is_default_community AND host.deleted_at IS NULL AND host.realm=o.realm AND host.state<>'closed'
      AND s.revision>coalesce((request.inventory->'engine_member_revisions'->>host.id::text)::bigint,0)
      AND s.authority_revision=host.authority_revision
      AND NOT EXISTS(SELECT 1 FROM public.engine_intents_known_subject k WHERE k.organisation_id=m.organisation_id AND k.user_id=request.user_reference
      AND k.erased_at IS NOT NULL AND NOT coalesce(s.erased_subjects,'[]'::jsonb) ? k.subject)))
  OR (o.shared_realm AND NOT EXISTS(SELECT 1 FROM public.orgs_organisation host WHERE host.is_default_community AND host.deleted_at IS NULL AND host.realm=o.realm))
 ))
 OR EXISTS(SELECT 1 FROM public.workspaces_workspace w JOIN public.orgs_membership m ON m.organisation_id=w.organisation_id
 JOIN public.orgs_organisation o ON o.id=w.organisation_id WHERE m.user_id=request.user_reference AND o.state<>'closed'
 AND NOT EXISTS(SELECT 1 FROM public.engine_intents_channel_set s WHERE s.organisation_id=w.organisation_id AND s.revision>coalesce((request.inventory->'engine_channel_revisions'->>w.organisation_id::text)::bigint,0)))
 THEN RAISE EXCEPTION 'account concrete engine erasure sets absent' USING ERRCODE='23514'; END IF;
 IF request.protocol_emitted_at IS NOT NULL THEN RETURN; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',request.user_reference,'{}');
 UPDATE public.orgs_accounterasure SET protocol_emitted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id;
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=request.user_reference;
END $$;
REVOKE ALL ON FUNCTION public.privacy_account_protocol_recorded(uuid) FROM PUBLIC;
"""

REVERSE_ACCOUNT_ERASURE = r"""
DROP TRIGGER IF EXISTS aa_04_shared_realm_account_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.shared_realm_account_erasure_hook();

CREATE OR REPLACE FUNCTION public.privacy_admit_account_erasure(
    p_id uuid,
    p_identity uuid,
    p_instruction text,
    p_digest text,
    p_not_before timestamptz,
    p_actor uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '3s' SET statement_timeout = '15s' AS $$
DECLARE
    person uuid;
    org_id uuid;
    initial_orgs uuid[] := ARRAY[]::uuid[];
    post_lock_orgs uuid[] := ARRAY[]::uuid[];
BEGIN
    IF p_id IS NULL OR p_identity IS NULL
       OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
       OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
       OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor) THEN
        RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE = '23514';
    END IF;
    SELECT user_id INTO person
    FROM public.identity_identity
    WHERE id = p_identity AND organisation_id IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE = '23514';
    END IF;

    SELECT coalesce(array_agg(q.org_id ORDER BY q.org_id), ARRAY[]::uuid[])
    INTO initial_orgs
    FROM (
        SELECT organisation_id AS org_id FROM public.orgs_membership WHERE user_id = person
        UNION
        SELECT organisation_id AS org_id FROM public.identity_identity
        WHERE user_id = person AND organisation_id IS NOT NULL
    ) q
    WHERE q.org_id IS NOT NULL;

    -- 1. Advisory fences strictly before row locks: sorted org cutoffs -> exclusive account cutoff.
    FOREACH org_id IN ARRAY initial_orgs LOOP
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_erasure_cutoff:' || org_id::text, 0)
        );
    END LOOP;
    PERFORM pg_advisory_xact_lock(
        hashtextextended('privacy_account_cutoff:' || person::text, 0)
    );

    -- 2. Row locks in canonical `identity_user -> orgs_organisation (ORDER BY id)` order.
    PERFORM 1 FROM public.identity_user
    WHERE id = person AND enabled AND deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'account erasure person unavailable' USING ERRCODE = '23514';
    END IF;

    PERFORM 1 FROM public.orgs_organisation
    WHERE id = ANY(initial_orgs)
    ORDER BY id
    FOR UPDATE;

    -- 3. Verify `person`'s organisation set did not change before row locks were acquired.
    SELECT coalesce(array_agg(q.org_id ORDER BY q.org_id), ARRAY[]::uuid[])
    INTO post_lock_orgs
    FROM (
        SELECT organisation_id AS org_id FROM public.orgs_membership WHERE user_id = person
        UNION
        SELECT organisation_id AS org_id FROM public.identity_identity
        WHERE user_id = person AND organisation_id IS NOT NULL
    ) q
    WHERE q.org_id IS NOT NULL;
    IF post_lock_orgs IS DISTINCT FROM initial_orgs THEN
        RAISE EXCEPTION 'account erasure concurrent organisation set changed'
            USING ERRCODE = '40001';
    END IF;

    RETURN public.privacy_begin_account_erasure(
        p_id, p_identity, p_instruction, p_digest, p_not_before, p_actor
    );
END $$;
REVOKE ALL ON FUNCTION public.privacy_admit_account_erasure(uuid, uuid, text, text, timestamptz, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.privacy_account_protocol_recorded(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE;
BEGIN
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.orgs_membership WHERE user_id=request.user_reference AND state<>'removed' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'account membership erasure protocol incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.identity_identity i JOIN public.orgs_organisation o ON o.id=i.organisation_id
 WHERE i.user_id=request.user_reference AND o.state<>'closed' AND NOT EXISTS(
 SELECT 1 FROM public.engine_intents_known_subject k WHERE k.organisation_id=i.organisation_id AND k.user_id=i.user_id
 AND k.subject=i.subject AND k.erased_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.orgs_organisation o ON o.id=m.organisation_id
 WHERE m.user_id=request.user_reference AND o.state<>'closed' AND NOT EXISTS(
 SELECT 1 FROM public.engine_intents_member_set s WHERE s.organisation_id=m.organisation_id AND s.revision>coalesce((request.inventory->'engine_member_revisions'->>m.organisation_id::text)::bigint,0)
 AND s.authority_revision=o.authority_revision
 AND NOT EXISTS(SELECT 1 FROM public.engine_intents_known_subject k WHERE k.organisation_id=m.organisation_id AND k.user_id=request.user_reference
 AND k.erased_at IS NOT NULL AND NOT coalesce(s.erased_subjects,'[]'::jsonb) ? k.subject)))
 OR EXISTS(SELECT 1 FROM public.workspaces_workspace w JOIN public.orgs_membership m ON m.organisation_id=w.organisation_id
 JOIN public.orgs_organisation o ON o.id=w.organisation_id WHERE m.user_id=request.user_reference AND o.state<>'closed'
 AND NOT EXISTS(SELECT 1 FROM public.engine_intents_channel_set s WHERE s.organisation_id=w.organisation_id AND s.revision>coalesce((request.inventory->'engine_channel_revisions'->>w.organisation_id::text)::bigint,0)))
 THEN RAISE EXCEPTION 'account concrete engine erasure sets absent' USING ERRCODE='23514'; END IF;
 IF request.protocol_emitted_at IS NOT NULL THEN RETURN; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',request.user_reference,'{}');
 UPDATE public.orgs_accounterasure SET protocol_emitted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id;
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=request.user_reference;
END $$;
REVOKE ALL ON FUNCTION public.privacy_account_protocol_recorded(uuid) FROM PUBLIC;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0035_ee_audit_ledger_erasure"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="organisation",
            name="shared_realm",
            field=models.BooleanField(db_default=False, default=False),
        ),
        migrations.AddField(
            model_name="organisation",
            name="plan_tier",
            field=models.TextField(
                choices=[
                    ("community", "Community"),
                    ("freemium_pme", "Freemium Pme"),
                    ("cloud_collaborative", "Cloud Collaborative"),
                    ("sovereign", "Sovereign"),
                    ("enterprise", "Enterprise"),
                ],
                db_default="sovereign",
                default="sovereign",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="organisation",
            name="organisation_realm_valid",
        ),
        migrations.RemoveConstraint(
            model_name="organisation",
            name="organisation_issuer_unique",
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("realm", models.F("slug")), ("shared_realm", True), _connector="OR"
                ),
                name="organisation_realm_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    (
                        "plan_tier__in",
                        [
                            "community",
                            "freemium_pme",
                            "cloud_collaborative",
                            "sovereign",
                            "enterprise",
                        ],
                    )
                ),
                name="organisation_plan_tier_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="organisation",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_default_community", False), ("shared_realm", False)),
                fields=("issuer",),
                name="organisation_dedicated_issuer_unique",
            ),
        ),
        migrations.RunSQL(
            "UPDATE public.orgs_organisation SET plan_tier = 'community' WHERE is_default_community = true;",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(
            FORWARD_ACCOUNT_ERASURE,
            reverse_sql=REVERSE_ACCOUNT_ERASURE,
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

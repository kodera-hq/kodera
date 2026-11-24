"""Confidential document classification, downgrade/plaintext guards, and epoch-bound collab fence."""

from django.db import migrations, models

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION docs_scope_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE expected uuid; actual uuid;
BEGIN
  IF TG_TABLE_NAME='docs_document' THEN
    SELECT organisation_id INTO expected FROM workspaces_workspace WHERE id=NEW.workspace_id;
    SELECT organisation_id INTO actual FROM orgs_membership WHERE id=NEW.creator_id;
    IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document creator scope refused' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.creator_id) IS DISTINCT FROM (NEW.workspace_id,NEW.creator_id)
    THEN RAISE EXCEPTION 'document ownership is immutable' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND OLD.is_confidential AND NOT NEW.is_confidential
    THEN RAISE EXCEPTION 'confidential document cannot be downgraded to plaintext' USING ERRCODE='23514'; END IF;
    IF NEW.channel_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM workspaces_channel WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id)
    THEN RAISE EXCEPTION 'document channel scope refused' USING ERRCODE='23514'; END IF;
    IF (NEW.is_confidential OR (NEW.channel_id IS NOT NULL AND EXISTS
       (SELECT 1 FROM workspaces_channel c WHERE c.id=NEW.channel_id AND c.is_confidential)))
       AND NEW.markdown <> ''
    THEN RAISE EXCEPTION 'confidential document markdown must remain empty' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='docs_documentgrant' THEN
    SELECT w.organisation_id INTO expected FROM docs_document d JOIN workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=NEW.document_id;
    SELECT organisation_id INTO actual FROM orgs_membership WHERE id=NEW.membership_id;
    IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document grant scope refused' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='docs_documentlink' THEN
    IF EXISTS (
      SELECT 1 FROM docs_document s
      LEFT JOIN workspaces_channel c ON c.id=s.channel_id
      WHERE s.id=NEW.source_id AND (s.is_confidential OR coalesce(c.is_confidential, false))
    ) THEN RAISE EXCEPTION 'confidential document cannot emit plaintext links' USING ERRCODE='23514'; END IF;
    IF NEW.target_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM docs_document s JOIN docs_document t ON t.workspace_id=s.workspace_id WHERE s.id=NEW.source_id AND t.id=NEW.target_id)
    THEN RAISE EXCEPTION 'document link scope refused' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION docs_scope_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION docs_collab_fence(
  p_document uuid,
  p_organisation uuid,
  p_member uuid,
  p_identity uuid,
  p_issuer text,
  p_subject text,
  p_role text,
  p_confidential boolean,
  p_epoch bigint
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE
  principal_user uuid;
  scope_workspace uuid;
  doc_confidential boolean;
  doc_channel uuid;
  doc_epoch bigint;
  chan_confidential boolean := false;
  room_id_val uuid := NULL;
  room_epoch_val bigint := NULL;
  room_rekey boolean := false;
  has_room boolean := false;
  actual_confidential boolean;
  expected_epoch bigint := NULL;
BEGIN
  IF p_confidential IS NULL THEN RETURN NULL; END IF;
  IF NOT p_confidential AND p_epoch IS NOT NULL THEN RETURN NULL; END IF;
  IF p_confidential AND (p_epoch IS NULL OR p_epoch < 0) THEN RETURN NULL; END IF;

  SELECT m.user_id INTO principal_user FROM public.orgs_membership m
    WHERE m.id=p_member AND m.organisation_id=p_organisation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(
      hashtextextended('privacy_erasure_cutoff:' || p_organisation::text, 0)
  ) OR NOT pg_try_advisory_xact_lock_shared(
      hashtextextended('privacy_account_cutoff:' || principal_user::text, 0)
  ) THEN
    RAISE EXCEPTION 'collaboration erasure fence busy' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public.orgs_membership m
    WHERE m.id=p_member AND m.user_id=principal_user AND m.organisation_id=p_organisation
    FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.identity_identity i
    WHERE i.id=p_identity AND i.user_id=principal_user AND i.organisation_id=p_organisation
    FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.identity_user u WHERE u.id=principal_user FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.orgs_organisation o WHERE o.id=p_organisation FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT w.id, d.is_confidential, d.channel_id, d.encryption_epoch
    INTO scope_workspace, doc_confidential, doc_channel, doc_epoch
    FROM public.workspaces_workspace w
    JOIN public.docs_document d ON d.workspace_id=w.id
    WHERE d.id=p_document AND w.organisation_id=p_organisation AND d.deleted_at IS NULL
    FOR SHARE OF w;
  IF NOT FOUND OR p_role IS NULL OR p_role NOT IN ('editor','viewer')
     OR public.docs_document_role(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject)
        IS DISTINCT FROM p_role THEN RETURN NULL; END IF;

  IF doc_channel IS NOT NULL THEN
    SELECT c.is_confidential INTO chan_confidential
      FROM public.workspaces_channel c
      WHERE c.id=doc_channel AND c.workspace_id=scope_workspace
      FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF to_regclass('public.e2ee_room') IS NOT NULL THEN
      SELECT r.id, r.epoch, r.rekey_required
        INTO room_id_val, room_epoch_val, room_rekey
        FROM public.e2ee_room r
        WHERE r.channel_id=doc_channel AND r.organisation_id=p_organisation
        FOR SHARE;
      IF FOUND THEN has_room := true; END IF;
    END IF;
  END IF;

  actual_confidential := coalesce(doc_confidential, false) OR coalesce(chan_confidential, false) OR has_room;
  IF p_confidential IS DISTINCT FROM actual_confidential THEN
    RETURN NULL;
  END IF;

  IF actual_confidential THEN
    IF has_room THEN
      IF room_rekey THEN RETURN NULL; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.e2ee_participant p
        JOIN public.e2ee_device dev ON dev.id=p.device_id
        WHERE p.room_id=room_id_val
          AND p.organisation_id=p_organisation
          AND p.left_epoch IS NULL
          AND p.joined_epoch <= room_epoch_val
          AND dev.organisation_id=p_organisation
          AND dev.membership_id=p_member
          AND dev.identity_id=p_identity
          AND dev.revoked_at IS NULL
      ) THEN
        RETURN NULL;
      END IF;
      expected_epoch := room_epoch_val;
    ELSIF doc_channel IS NOT NULL THEN
      RETURN NULL;
    ELSE
      IF doc_epoch IS NULL OR doc_epoch < 1 THEN RETURN NULL; END IF;
      expected_epoch := doc_epoch;
    END IF;
    IF p_epoch IS DISTINCT FROM expected_epoch THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN scope_workspace;
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION docs_collab_fence(p_document uuid,p_organisation uuid,p_member uuid,
                                             p_identity uuid,p_issuer text,p_subject text,p_role text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
BEGIN
  RETURN public.docs_collab_fence(
    p_document,
    p_organisation,
    p_member,
    p_identity,
    p_issuer,
    p_subject,
    p_role,
    false,
    NULL::bigint
  );
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.docs_document WHERE is_confidential OR encryption_epoch IS NOT NULL)
  THEN RAISE EXCEPTION 'confidential document rollback refuses retained confidential documents'; END IF;
END $$;

CREATE OR REPLACE FUNCTION docs_collab_fence(p_document uuid,p_organisation uuid,p_member uuid,
                                             p_identity uuid,p_issuer text,p_subject text,p_role text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE principal_user uuid; scope_workspace uuid;
BEGIN
  SELECT m.user_id INTO principal_user FROM public.orgs_membership m
    WHERE m.id=p_member AND m.organisation_id=p_organisation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(
      hashtextextended('privacy_erasure_cutoff:' || p_organisation::text, 0)
  ) OR NOT pg_try_advisory_xact_lock_shared(
      hashtextextended('privacy_account_cutoff:' || principal_user::text, 0)
  ) THEN
    RAISE EXCEPTION 'collaboration erasure fence busy' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public.orgs_membership m
    WHERE m.id=p_member AND m.user_id=principal_user AND m.organisation_id=p_organisation
    FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.identity_identity i
    WHERE i.id=p_identity AND i.user_id=principal_user AND i.organisation_id=p_organisation
    FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.identity_user u WHERE u.id=principal_user FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.orgs_organisation o WHERE o.id=p_organisation FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT w.id INTO scope_workspace FROM public.workspaces_workspace w
    JOIN public.docs_document d ON d.workspace_id=w.id
    WHERE d.id=p_document AND w.organisation_id=p_organisation FOR SHARE OF w;
  IF NOT FOUND OR p_role IS NULL OR p_role NOT IN ('editor','viewer')
     OR public.docs_document_role(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject)
        IS DISTINCT FROM p_role THEN RETURN NULL; END IF;
  RETURN scope_workspace;
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;

DROP FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint);

CREATE OR REPLACE FUNCTION docs_scope_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE expected uuid; actual uuid;
BEGIN
  IF TG_TABLE_NAME='docs_document' THEN
    SELECT organisation_id INTO expected FROM workspaces_workspace WHERE id=NEW.workspace_id;
    SELECT organisation_id INTO actual FROM orgs_membership WHERE id=NEW.creator_id;
    IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document creator scope refused' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.creator_id) IS DISTINCT FROM (NEW.workspace_id,NEW.creator_id)
    THEN RAISE EXCEPTION 'document ownership is immutable' USING ERRCODE='23514'; END IF;
    IF NEW.channel_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM workspaces_channel WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id)
    THEN RAISE EXCEPTION 'document channel scope refused' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='docs_documentgrant' THEN
    SELECT w.organisation_id INTO expected FROM docs_document d JOIN workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=NEW.document_id;
    SELECT organisation_id INTO actual FROM orgs_membership WHERE id=NEW.membership_id;
    IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document grant scope refused' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='docs_documentlink' THEN
    IF NEW.target_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM docs_document s JOIN docs_document t ON t.workspace_id=s.workspace_id WHERE s.id=NEW.source_id AND t.id=NEW.target_id)
    THEN RAISE EXCEPTION 'document link scope refused' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION docs_scope_guard() FROM PUBLIC;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("docs", "0011_collab_lock_order_and_iam_policy"),
        ("workspaces", "0015_confidential_channel_designation"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.AddField(
            model_name="document",
            name="is_confidential",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="document",
            name="encryption_epoch",
            field=models.BigIntegerField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="document",
            constraint=models.CheckConstraint(
                condition=models.Q(("is_confidential", False), ("markdown", ""), _connector="OR"),
                name="docs_confidential_markdown_empty",
            ),
        ),
        migrations.AddConstraint(
            model_name="document",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("encryption_epoch__isnull", True),
                    ("encryption_epoch__gte", 0),
                    _connector="OR",
                ),
                name="docs_encryption_epoch_nonnegative",
            ),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

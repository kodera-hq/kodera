"""Subteam document grants with bounded DDL and one Core/realtime role decision.

Only the new empty table receives indexes and validated foreign keys. Referenced
production tables receive short, lock-timeout-bounded metadata locks, with no
backfill, table rewrite, or index build on an existing table. SQL cascades also
cover the erasure worker's direct deletes; Django cascades cover role administration.
"""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = r"""
ALTER TABLE public.docs_documentrolegrant
  ADD CONSTRAINT docs_role_grant_document_fk FOREIGN KEY(document_id)
    REFERENCES public.docs_document(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT docs_role_grant_subteam_fk FOREIGN KEY(workspace_role_id)
    REFERENCES public.workspaces_workspacerole(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION docs_role_grant_scope_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE expected uuid; actual uuid; role_kind text;
BEGIN
  IF TG_TABLE_NAME='workspaces_workspacerole' THEN
    IF NEW.kind<>'subteam' AND EXISTS (
      SELECT 1 FROM public.docs_documentrolegrant WHERE workspace_role_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'referenced document subteam kind is immutable'
        USING ERRCODE='23514',CONSTRAINT='docs_role_grant_subteam_kind';
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND (NEW.document_id,NEW.workspace_role_id)
       IS DISTINCT FROM (OLD.document_id,OLD.workspace_role_id) THEN
      RAISE EXCEPTION 'document role grant binding is immutable'
        USING ERRCODE='23514',CONSTRAINT='docs_role_grant_binding';
    END IF;
    SELECT workspace_id INTO expected FROM public.docs_document WHERE id=NEW.document_id;
    -- A row version change also serializes concurrent kind updates at snapshot isolation.
    -- A lock alone would leave a repeatable-read kind guard with a stale grant snapshot.
    IF TG_OP='INSERT' THEN
      UPDATE public.workspaces_workspacerole SET kind=kind
        WHERE id=NEW.workspace_role_id AND kind='subteam'
        RETURNING workspace_id,kind INTO actual,role_kind;
    ELSE
      SELECT workspace_id,kind INTO actual,role_kind
        FROM public.workspaces_workspacerole WHERE id=NEW.workspace_role_id;
    END IF;
    IF expected IS NULL OR expected IS DISTINCT FROM actual OR role_kind IS DISTINCT FROM 'subteam' THEN
      RAISE EXCEPTION 'document role grant subteam scope refused'
        USING ERRCODE='23514',CONSTRAINT='docs_role_grant_subteam_scope';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION docs_role_grant_scope_guard() FROM PUBLIC;
CREATE TRIGGER docs_role_grant_scope BEFORE INSERT OR UPDATE ON public.docs_documentrolegrant
  FOR EACH ROW EXECUTE FUNCTION docs_role_grant_scope_guard();
CREATE TRIGGER docs_role_grant_subteam_kind BEFORE UPDATE OF kind ON public.workspaces_workspacerole
  FOR EACH ROW EXECUTE FUNCTION docs_role_grant_scope_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.docs_documentrolegrant
  FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();

CREATE OR REPLACE FUNCTION docs_document_role(p_document uuid, p_organisation uuid, p_member uuid,
                                              p_identity uuid, p_issuer text, p_subject text, p_device uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor_role text; current_id uuid := p_document; node record; policy record;
        grant_role text; result_role text := 'editor'; depth integer := 0;
        visited uuid[] := ARRAY[]::uuid[]; scope_workspace uuid;
BEGIN
  SELECT m.role INTO actor_role
  FROM public.orgs_membership m
  JOIN public.identity_user u ON u.id=m.user_id
  JOIN public.identity_identity i ON i.user_id=u.id
  JOIN public.orgs_organisation o ON o.id=m.organisation_id
  WHERE m.id=p_member AND m.organisation_id=p_organisation
    AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL
    AND u.enabled AND u.deleted_at IS NULL
    AND i.id=p_identity AND i.organisation_id=o.id AND i.issuer=p_issuer
    AND i.subject=p_subject AND i.issuer=o.issuer AND i.realm=o.realm
    AND i.enabled AND i.deleted_at IS NULL AND o.state='active' AND o.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces_workspacememberrestriction r
             JOIN public.workspaces_workspace w ON w.id=r.workspace_id
             WHERE w.organisation_id=p_organisation AND r.membership_id=p_member
               AND (r.banned OR r.kicked)) THEN RETURN NULL; END IF;
  WHILE current_id IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 16 OR current_id=ANY(visited) THEN RETURN NULL; END IF;
    visited := array_append(visited,current_id);
    SELECT d.*, w.organisation_id INTO node FROM public.docs_document d
    JOIN public.workspaces_workspace w ON w.id=d.workspace_id
    WHERE d.id=current_id AND w.organisation_id=p_organisation AND d.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF scope_workspace IS NULL THEN scope_workspace := node.workspace_id;
    ELSIF scope_workspace<>node.workspace_id THEN RETURN NULL; END IF;
    IF node.channel_id IS NOT NULL THEN
      IF (node.is_confidential
          OR EXISTS (SELECT 1 FROM public.workspaces_channel c
                     WHERE c.id=node.channel_id AND c.is_confidential)
          OR EXISTS (SELECT 1 FROM public.e2ee_room r WHERE r.channel_id=node.channel_id))
        AND NOT EXISTS (
          SELECT 1 FROM public.e2ee_room r
          JOIN public.e2ee_participant p ON p.room_id=r.id AND p.organisation_id=r.organisation_id
          JOIN public.e2ee_device dev ON dev.id=p.device_id AND dev.organisation_id=r.organisation_id
          WHERE r.channel_id=node.channel_id AND r.organisation_id=p_organisation
            AND p.left_epoch IS NULL AND p.joined_epoch<=r.epoch
            AND dev.id=p_device
            AND dev.membership_id=p_member AND dev.identity_id=p_identity
            AND dev.revoked_at IS NULL
        ) THEN RETURN NULL; END IF;
      SELECT p.id,p.visibility,p.revision INTO policy
      FROM public.workspaces_channel c
      JOIN public.workspaces_workspace w ON w.id=c.workspace_id
      LEFT JOIN public.workspaces_category g ON g.id=c.category_id AND g.workspace_id=w.id
      JOIN public.workspaces_resourcepolicy p ON p.workspace_id=w.id AND p.id=
        CASE WHEN c.policy_mode='explicit' THEN c.explicit_policy_id
             WHEN c.policy_mode='inherit' AND c.explicit_policy_id IS NULL
             THEN coalesce(g.default_policy_id,w.default_policy_id) END
      WHERE c.id=node.channel_id AND c.workspace_id=node.workspace_id
        AND c.kind IN ('text','audio') AND c.lifecycle IN ('active','archived')
        AND p.revision > 0 AND p.visibility IN ('organisation','restricted')
        AND (c.category_id IS NULL OR g.id IS NOT NULL);
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                 AND r.kind='deny_member' AND r.membership_id=p_member)
        OR EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                   JOIN public.workspaces_workspacememberrole mr
                     ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                   WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                     AND mr.membership_id=p_member AND o.deny ? 'channel.view')
        OR (EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                    AND r.kind='deny_capability' AND r.capability='channel.view')
            AND NOT EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                            JOIN public.workspaces_workspacememberrole mr
                              ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                            WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                              AND mr.membership_id=p_member AND o.allow ? 'channel.view'))
        OR (policy.visibility='restricted'
            AND NOT EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r
                            WHERE r.policy_id=policy.id AND r.kind='allow_member'
                              AND r.membership_id=p_member)
            AND NOT EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                            JOIN public.workspaces_workspacememberrole mr
                              ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                            WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                              AND mr.membership_id=p_member AND o.allow ? 'channel.view'))
      THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                 JOIN public.workspaces_workspacememberrole mr
                   ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                 WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                   AND mr.membership_id=p_member
                   AND (o.deny ? 'message.post' OR o.deny ? 'file.upload'))
        OR EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                   AND r.kind='deny_capability' AND r.capability IN ('message.post','file.upload')
                   AND NOT EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                                   JOIN public.workspaces_workspacememberrole mr
                                     ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                                   WHERE o.channel_id=node.channel_id
                                     AND o.workspace_id=node.workspace_id
                                     AND mr.membership_id=p_member
                                     AND (o.allow ? r.capability OR o.allow ? 'message.post')))
      THEN result_role := 'viewer'; END IF;
    END IF;
    -- Resolve explicit member and assigned subteam grants together at each ancestor.
    -- Channel policy and ancestor restrictions still cap this node's authority.
    SELECT CASE WHEN bool_or(g.role='editor') THEN 'editor'
                WHEN bool_or(g.role='viewer') THEN 'viewer' END INTO grant_role
    FROM (
      SELECT role FROM public.docs_documentgrant
        WHERE document_id=node.id AND membership_id=p_member
      UNION ALL
      SELECT g.role FROM public.docs_documentrolegrant g
        JOIN public.workspaces_workspacerole r ON r.id=g.workspace_role_id
        JOIN public.workspaces_workspacememberrole mr ON mr.role_id=r.id
          AND mr.workspace_id=r.workspace_id
        WHERE g.document_id=node.id AND r.workspace_id=node.workspace_id
          AND r.kind='subteam' AND mr.membership_id=p_member
    ) g;
    IF actor_role IN ('org_owner','org_admin') OR node.creator_id=p_member THEN
      NULL;
    ELSIF grant_role='viewer' THEN result_role := 'viewer';
    ELSIF grant_role='editor' THEN NULL;
    ELSIF node.visibility<>'workspace' THEN RETURN NULL;
    END IF;
    current_id := node.parent_id;
  END LOOP;
  RETURN result_role;
END $$;
REVOKE ALL ON FUNCTION docs_document_role(uuid,uuid,uuid,uuid,text,text,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION docs_document_role(p_document uuid,p_organisation uuid,p_member uuid,
                                             p_identity uuid,p_issuer text,p_subject text)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT public.docs_document_role(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject,NULL::uuid)
$$;
REVOKE ALL ON FUNCTION docs_document_role(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION docs_collab_fence(
  p_document uuid,
  p_organisation uuid,
  p_member uuid,
  p_identity uuid,
  p_issuer text,
  p_subject text,
  p_role text,
  p_confidential boolean,
  p_epoch bigint,
  p_device uuid
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
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
  IF p_confidential AND (p_epoch IS NULL OR p_epoch < 0 OR p_epoch > 4294967295) THEN RETURN NULL; END IF;

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
     OR public.docs_document_role(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject,p_device)
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
          AND dev.id=p_device
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
    IF expected_epoch IS NULL OR expected_epoch < 0 OR expected_epoch > 4294967295 OR p_epoch IS DISTINCT FROM expected_epoch THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN scope_workspace;
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint,uuid) FROM PUBLIC;


CREATE OR REPLACE FUNCTION docs_collab_fence(p_document uuid,p_organisation uuid,p_member uuid,
    p_identity uuid,p_issuer text,p_subject text,p_role text,p_confidential boolean,p_epoch bigint)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
  SELECT public.docs_collab_fence(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject,
                                p_role,p_confidential,p_epoch,NULL::uuid)
$$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint) FROM PUBLIC;

"""

REVERSE = r"""
LOCK TABLE public.docs_documentrolegrant IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.docs_documentrolegrant) THEN
    RAISE EXCEPTION 'document role grant rollback refuses retained grants; remove grants explicitly before rollback'
      USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION docs_document_role(p_document uuid, p_organisation uuid, p_member uuid,
                                              p_identity uuid, p_issuer text, p_subject text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor_role text; current_id uuid := p_document; node record; policy record;
        grant_role text; result_role text := 'editor'; depth integer := 0;
        visited uuid[] := ARRAY[]::uuid[]; scope_workspace uuid;
BEGIN
  SELECT m.role INTO actor_role
  FROM public.orgs_membership m
  JOIN public.identity_user u ON u.id=m.user_id
  JOIN public.identity_identity i ON i.user_id=u.id
  JOIN public.orgs_organisation o ON o.id=m.organisation_id
  WHERE m.id=p_member AND m.organisation_id=p_organisation
    AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL
    AND u.enabled AND u.deleted_at IS NULL
    AND i.id=p_identity AND i.organisation_id=o.id AND i.issuer=p_issuer
    AND i.subject=p_subject AND i.issuer=o.issuer AND i.realm=o.realm
    AND i.enabled AND i.deleted_at IS NULL AND o.state='active' AND o.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces_workspacememberrestriction r
             JOIN public.workspaces_workspace w ON w.id=r.workspace_id
             WHERE w.organisation_id=p_organisation AND r.membership_id=p_member
               AND (r.banned OR r.kicked)) THEN RETURN NULL; END IF;
  WHILE current_id IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > 16 OR current_id=ANY(visited) THEN RETURN NULL; END IF;
    visited := array_append(visited,current_id);
    SELECT d.*, w.organisation_id INTO node FROM public.docs_document d
    JOIN public.workspaces_workspace w ON w.id=d.workspace_id
    WHERE d.id=current_id AND w.organisation_id=p_organisation AND d.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF scope_workspace IS NULL THEN scope_workspace := node.workspace_id;
    ELSIF scope_workspace<>node.workspace_id THEN RETURN NULL; END IF;
    IF node.channel_id IS NOT NULL THEN
      SELECT p.id,p.visibility,p.revision INTO policy
      FROM public.workspaces_channel c
      JOIN public.workspaces_workspace w ON w.id=c.workspace_id
      LEFT JOIN public.workspaces_category g ON g.id=c.category_id AND g.workspace_id=w.id
      JOIN public.workspaces_resourcepolicy p ON p.workspace_id=w.id AND p.id=
        CASE WHEN c.policy_mode='explicit' THEN c.explicit_policy_id
             WHEN c.policy_mode='inherit' AND c.explicit_policy_id IS NULL
             THEN coalesce(g.default_policy_id,w.default_policy_id) END
      WHERE c.id=node.channel_id AND c.workspace_id=node.workspace_id
        AND c.kind IN ('text','audio') AND c.lifecycle IN ('active','archived')
        AND p.revision > 0 AND p.visibility IN ('organisation','restricted')
        AND (c.category_id IS NULL OR g.id IS NOT NULL);
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                 AND r.kind='deny_member' AND r.membership_id=p_member)
        OR EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                   JOIN public.workspaces_workspacememberrole mr
                     ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                   WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                     AND mr.membership_id=p_member AND o.deny ? 'channel.view')
        OR (EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                    AND r.kind='deny_capability' AND r.capability='channel.view')
            AND NOT EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                            JOIN public.workspaces_workspacememberrole mr
                              ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                            WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                              AND mr.membership_id=p_member AND o.allow ? 'channel.view'))
        OR (policy.visibility='restricted'
            AND NOT EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r
                            WHERE r.policy_id=policy.id AND r.kind='allow_member'
                              AND r.membership_id=p_member)
            AND NOT EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                            JOIN public.workspaces_workspacememberrole mr
                              ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                            WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                              AND mr.membership_id=p_member AND o.allow ? 'channel.view'))
      THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                 JOIN public.workspaces_workspacememberrole mr
                   ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                 WHERE o.channel_id=node.channel_id AND o.workspace_id=node.workspace_id
                   AND mr.membership_id=p_member
                   AND (o.deny ? 'message.post' OR o.deny ? 'file.upload'))
        OR EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                   AND r.kind='deny_capability' AND r.capability IN ('message.post','file.upload')
                   AND NOT EXISTS (SELECT 1 FROM public.workspaces_workspacechannelroleoverride o
                                   JOIN public.workspaces_workspacememberrole mr
                                     ON mr.role_id=o.role_id AND mr.workspace_id=o.workspace_id
                                   WHERE o.channel_id=node.channel_id
                                     AND o.workspace_id=node.workspace_id
                                     AND mr.membership_id=p_member
                                     AND (o.allow ? r.capability OR o.allow ? 'message.post')))
      THEN result_role := 'viewer'; END IF;
    END IF;
    SELECT role INTO grant_role FROM public.docs_documentgrant
      WHERE document_id=node.id AND membership_id=p_member;
    IF actor_role IN ('org_owner','org_admin') OR node.creator_id=p_member THEN
      NULL;
    ELSIF grant_role='viewer' THEN result_role := 'viewer';
    ELSIF grant_role='editor' THEN NULL;
    ELSIF node.visibility<>'workspace' THEN RETURN NULL;
    END IF;
    current_id := node.parent_id;
  END LOOP;
  RETURN result_role;
END $$;
REVOKE ALL ON FUNCTION docs_document_role(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;

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
  IF p_confidential AND (p_epoch IS NULL OR p_epoch < 0 OR p_epoch > 4294967295) THEN RETURN NULL; END IF;

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
    IF expected_epoch IS NULL OR expected_epoch < 0 OR expected_epoch > 4294967295 OR p_epoch IS DISTINCT FROM expected_epoch THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN scope_workspace;
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint) FROM PUBLIC;


DROP FUNCTION public.docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text,boolean,bigint,uuid);
DROP FUNCTION public.docs_document_role(uuid,uuid,uuid,uuid,text,text,uuid);

DROP TRIGGER aa_privacy_cutoff ON public.docs_documentrolegrant;
DROP TRIGGER docs_role_grant_subteam_kind ON public.workspaces_workspacerole;
DROP TRIGGER docs_role_grant_scope ON public.docs_documentrolegrant;
DROP FUNCTION docs_role_grant_scope_guard();
ALTER TABLE public.docs_documentrolegrant DROP CONSTRAINT docs_role_grant_document_fk,
  DROP CONSTRAINT docs_role_grant_subteam_fk;

"""


class Migration(migrations.Migration):
    atomic = True
    dependencies = [
        ("docs", "0012_confidential_collab_admission"),
        ("workspaces", "0015_confidential_channel_designation"),
        ("e2ee", "0002_scope_and_privacy"),
    ]
    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=migrations.RunSQL.noop),
        migrations.CreateModel(
            name="DocumentRoleGrant",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("role", models.TextField()),
                (
                    "document",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        to="docs.document",
                    ),
                ),
                (
                    "workspace_role",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        to="workspaces.workspacerole",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(
                        fields=("document", "workspace_role"), name="docs_role_grant_unique"
                    ),
                    models.CheckConstraint(
                        condition=models.Q(role__in=["editor", "viewer"]),
                        name="docs_role_grant_role_valid",
                    ),
                ]
            },
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(TIMEOUTS + FORWARD, TIMEOUTS + REVERSE)],
            state_operations=[
                migrations.AlterField(
                    model_name="documentrolegrant",
                    name="document",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to="docs.document"
                    ),
                ),
                migrations.AlterField(
                    model_name="documentrolegrant",
                    name="workspace_role",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, to="workspaces.workspacerole"
                    ),
                ),
            ],
        ),
        migrations.RunSQL(migrations.RunSQL.noop, reverse_sql=TIMEOUTS),
    ]

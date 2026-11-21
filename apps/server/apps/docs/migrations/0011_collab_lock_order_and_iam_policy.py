"""Align collaboration lock order with workspace moderation and fold role overrides into document access."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

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

CREATE OR REPLACE FUNCTION docs_collab_fence(p_document uuid,p_organisation uuid,p_member uuid,
                                             p_identity uuid,p_issuer text,p_subject text,p_role text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE principal_user uuid; scope_workspace uuid;
BEGIN
  SELECT m.user_id INTO principal_user FROM public.orgs_membership m
    WHERE m.id=p_member AND m.organisation_id=p_organisation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.identity_user u WHERE u.id=principal_user FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.orgs_organisation o WHERE o.id=p_organisation FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.identity_identity i
    WHERE i.id=p_identity AND i.user_id=principal_user AND i.organisation_id=p_organisation
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.orgs_membership m
    WHERE m.id=p_member AND m.user_id=principal_user AND m.organisation_id=p_organisation
    FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT w.id INTO scope_workspace FROM public.workspaces_workspace w
    JOIN public.docs_document d ON d.workspace_id=w.id
    WHERE d.id=p_document AND w.organisation_id=p_organisation FOR SHARE OF w NOWAIT;
  IF NOT FOUND OR p_role IS NULL OR p_role NOT IN ('editor','viewer')
     OR public.docs_document_role(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject)
        IS DISTINCT FROM p_role THEN RETURN NULL; END IF;
  RETURN scope_workspace;
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION docs_collab_fence(p_document uuid,p_organisation uuid,p_member uuid,
                                             p_identity uuid,p_issuer text,p_subject text,p_role text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
DECLARE scope_workspace uuid;
BEGIN
  SELECT w.id INTO scope_workspace FROM public.workspaces_workspace w
    JOIN public.docs_document d ON d.workspace_id=w.id
    WHERE d.id=p_document AND w.organisation_id=p_organisation FOR UPDATE OF w;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM m.id FROM public.orgs_membership m
    JOIN public.identity_user u ON u.id=m.user_id
    JOIN public.identity_identity i ON i.user_id=u.id
    JOIN public.orgs_organisation o ON o.id=m.organisation_id
    WHERE m.id=p_member AND i.id=p_identity AND m.organisation_id=p_organisation
    FOR SHARE OF m,u,i,o;
  IF NOT FOUND OR p_role IS NULL OR p_role NOT IN ('editor','viewer')
     OR public.docs_document_role(p_document,p_organisation,p_member,p_identity,p_issuer,p_subject)
        IS DISTINCT FROM p_role THEN RETURN NULL; END IF;
  RETURN scope_workspace;
END $$;
REVOKE ALL ON FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION docs_document_role(p_document uuid, p_organisation uuid, p_member uuid,
                                              p_identity uuid, p_issuer text, p_subject text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
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
                 AND ((r.kind='deny_member' AND r.membership_id=p_member)
                   OR (r.kind='deny_capability' AND r.capability='channel.view')))
        OR (policy.visibility='restricted' AND NOT EXISTS
            (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
             AND r.kind='allow_member' AND r.membership_id=p_member)) THEN RETURN NULL; END IF;
      IF EXISTS (SELECT 1 FROM public.workspaces_resourcepolicyrule r WHERE r.policy_id=policy.id
                 AND r.kind='deny_capability' AND r.capability IN ('message.post','file.upload'))
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
"""


class Migration(migrations.Migration):
    dependencies = [
        ("docs", "0010_locale_free_title_keys"),
        ("workspaces", "0014_iam_scope_guards"),
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

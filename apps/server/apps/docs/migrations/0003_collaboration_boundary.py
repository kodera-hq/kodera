"""Expose bounded authority and audit ports without granting foreign-table access."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION docs_collab_fence(p_document uuid,p_organisation uuid,p_member uuid,
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

CREATE FUNCTION docs_collab_audit(p_id uuid,p_action text,p_organisation uuid,
                                p_document uuid,p_actor uuid,p_request text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='3s' SET statement_timeout='5s' AS $$
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('workspace.document.collab_updated','workspace.document.collab_refused')
     OR NOT EXISTS(SELECT 1 FROM public.docs_document d JOIN public.workspaces_workspace w
                   ON w.id=d.workspace_id WHERE d.id=p_document AND w.organisation_id=p_organisation)
  THEN RAISE EXCEPTION 'collaboration audit scope refused' USING ERRCODE='23514'; END IF;
  PERFORM public.audit_workspace_resource_event(p_id,p_action,p_organisation,p_document,p_actor,p_request);
END $$;
REVOKE ALL ON FUNCTION docs_collab_audit(uuid,text,uuid,uuid,uuid,text) FROM PUBLIC;

-- These trigger-only guards read scope tables with the migration owner's rights.
-- Runtime document grants never imply direct access to identity or workspace tables.
ALTER FUNCTION docs_scope_guard() SECURITY DEFINER;
-- The existing trigger bodies use unqualified relations: put pg_temp last so
-- a temporary lookalike cannot shadow a protected public table.
ALTER FUNCTION docs_scope_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION docs_scope_guard() SET lock_timeout='3s';
ALTER FUNCTION docs_scope_guard() SET statement_timeout='5s';
REVOKE ALL ON FUNCTION docs_scope_guard() FROM PUBLIC;
ALTER FUNCTION docs_journal_guard() SECURITY DEFINER;
ALTER FUNCTION docs_journal_guard() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION docs_journal_guard() SET lock_timeout='3s';
ALTER FUNCTION docs_journal_guard() SET statement_timeout='5s';
REVOKE ALL ON FUNCTION docs_journal_guard() FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER FUNCTION docs_scope_guard() SECURITY INVOKER;
ALTER FUNCTION docs_scope_guard() RESET ALL;
GRANT EXECUTE ON FUNCTION docs_scope_guard() TO PUBLIC;
ALTER FUNCTION docs_journal_guard() SECURITY INVOKER;
ALTER FUNCTION docs_journal_guard() RESET ALL;
GRANT EXECUTE ON FUNCTION docs_journal_guard() TO PUBLIC;
DROP FUNCTION docs_collab_audit(uuid,text,uuid,uuid,uuid,text);
DROP FUNCTION docs_collab_fence(uuid,uuid,uuid,uuid,text,text,text);
"""


class Migration(migrations.Migration):
    dependencies = [('docs', '0002_policy_and_scope'), ('audit', '0003_workspace_resource_writer')]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

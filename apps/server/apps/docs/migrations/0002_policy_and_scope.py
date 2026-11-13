"""One current document-role decision, shared by Core and the realtime process."""

from django.db import migrations

FORWARD = r'''
CREATE INDEX docs_fulltext ON docs_document USING gin(to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(markdown,'')));

CREATE FUNCTION docs_document_role(p_document uuid, p_organisation uuid, p_member uuid,
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

ALTER TABLE docs_document ADD CONSTRAINT docs_parent_workspace_fk
  FOREIGN KEY(parent_id,workspace_id) REFERENCES docs_document(id,workspace_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE docs_documentsnapshot ADD CONSTRAINT docs_snapshot_bytes_bound
  CHECK(octet_length(state)<=2097152);
ALTER TABLE docs_documentupdate ADD CONSTRAINT docs_update_bytes_bound
  CHECK(octet_length(state) BETWEEN 1 AND 2097152);

CREATE FUNCTION docs_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER docs_document_scope BEFORE INSERT OR UPDATE ON docs_document FOR EACH ROW EXECUTE FUNCTION docs_scope_guard();
CREATE TRIGGER docs_grant_scope BEFORE INSERT OR UPDATE ON docs_documentgrant FOR EACH ROW EXECUTE FUNCTION docs_scope_guard();
CREATE TRIGGER docs_link_scope BEFORE INSERT OR UPDATE ON docs_documentlink FOR EACH ROW EXECUTE FUNCTION docs_scope_guard();

CREATE FUNCTION docs_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE covered bigint; head bigint; expected uuid; actual uuid;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'document journal is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT sequence INTO covered FROM docs_documentsnapshot WHERE document_id=OLD.document_id;
    IF covered IS NULL OR covered<OLD.sequence THEN RAISE EXCEPTION 'document update is not covered by a snapshot' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  SELECT head_sequence INTO head FROM docs_documentsnapshot WHERE document_id=NEW.document_id FOR UPDATE;
  IF head IS NULL OR NEW.sequence<>head+1 THEN RAISE EXCEPTION 'document journal sequence refused' USING ERRCODE='23514'; END IF;
  SELECT w.organisation_id INTO expected FROM docs_document d JOIN workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=NEW.document_id;
  SELECT organisation_id INTO actual FROM identity_identity WHERE id=NEW.actor_id;
  IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'document journal actor scope refused' USING ERRCODE='23514'; END IF;
  UPDATE docs_documentsnapshot SET head_sequence=NEW.sequence,updated_at=clock_timestamp() WHERE document_id=NEW.document_id;
  RETURN NEW;
END $$;
CREATE TRIGGER docs_journal_append BEFORE INSERT OR UPDATE OR DELETE ON docs_documentupdate FOR EACH ROW EXECUTE FUNCTION docs_journal_guard();
'''

REVERSE = '''
DROP INDEX docs_fulltext;
DROP TRIGGER docs_journal_append ON docs_documentupdate;
DROP FUNCTION docs_journal_guard();
DROP TRIGGER docs_link_scope ON docs_documentlink;
DROP TRIGGER docs_grant_scope ON docs_documentgrant;
DROP TRIGGER docs_document_scope ON docs_document;
DROP FUNCTION docs_scope_guard();
ALTER TABLE docs_documentupdate DROP CONSTRAINT docs_update_bytes_bound;
ALTER TABLE docs_documentsnapshot DROP CONSTRAINT docs_snapshot_bytes_bound;
ALTER TABLE docs_document DROP CONSTRAINT docs_parent_workspace_fk;
DROP FUNCTION docs_document_role(uuid,uuid,uuid,uuid,text,text);
'''


class Migration(migrations.Migration):
    dependencies = [('docs', '0001_initial'), ('workspaces', '0010_moderation_scope_guards')]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

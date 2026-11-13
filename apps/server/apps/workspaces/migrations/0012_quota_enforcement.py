"""Serialize reservations in PostgreSQL, including native collaboration writes."""

from django.db import migrations

FORWARD = r'''
SET LOCAL lock_timeout='5s';
CREATE FUNCTION workspace_quota_usage(p_workspace uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
SELECT jsonb_build_object(
 'seats', (SELECT count(*) FROM public.orgs_membership m WHERE m.organisation_id=w.organisation_id
           AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL)
          +(SELECT count(*) FROM public.orgs_invitation i WHERE i.organisation_id=w.organisation_id
            AND i.state='pending' AND i.expires_at>statement_timestamp()
            AND NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_user u ON u.id=m.user_id
                           WHERE m.organisation_id=i.organisation_id AND m.state='active'
                           AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL AND lower(u.email)=i.email)),
 'mediaBytes', (SELECT coalesce(sum(a.size_bytes),0) FROM public.media_attachment a WHERE a.organisation_id=w.organisation_id),
 'pages', (SELECT count(*) FROM public.docs_document d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL))
FROM public.workspaces_workspace w WHERE w.id=p_workspace;
$$;
REVOKE ALL ON FUNCTION workspace_quota_usage(uuid) FROM PUBLIC;

CREATE FUNCTION workspace_quota_refuse(p_key text,p_limit bigint,p_used bigint,p_requested bigint)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_limit IS NOT NULL AND p_used+p_requested>p_limit THEN
    RAISE EXCEPTION 'workspace quota exceeded' USING ERRCODE='23514',CONSTRAINT='workspace_quota_exceeded',
      DETAIL=jsonb_build_object('quota_key',p_key,'limit',p_limit,'used',p_used,
       'requested',p_requested,'remaining',greatest(0,p_limit-p_used),
       'status',CASE WHEN p_key IN ('mediaBytes','snapshotBytes') THEN 413 ELSE 402 END)::text;
  END IF;
END $$;
REVOKE ALL ON FUNCTION workspace_quota_refuse(text,bigint,bigint,bigint) FROM PUBLIC;

CREATE FUNCTION workspace_seed_quota() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  -- The Community policy explicitly preserves unlimited seats/media/pages; it is never a fallback
  -- for a missing configured snapshot. Commercial provisioning must replace this policy explicitly.
  INSERT INTO public.workspaces_workspacequota(id,created_at,updated_at,workspace_id,policy_ref,
      seats,media_bytes,pages,snapshot_bytes)
    VALUES(gen_random_uuid(),statement_timestamp(),statement_timestamp(),NEW.id,
      'community-unlimited-v1',NULL,NULL,NULL,2097152);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workspace_seed_quota() FROM PUBLIC;
INSERT INTO workspaces_workspacequota(id,created_at,updated_at,workspace_id,policy_ref,seats,media_bytes,pages,snapshot_bytes)
 SELECT gen_random_uuid(),statement_timestamp(),statement_timestamp(),id,'community-unlimited-v1',NULL,NULL,NULL,2097152
 FROM workspaces_workspace;
CREATE TRIGGER workspace_seed_quota AFTER INSERT ON workspaces_workspace
 FOR EACH ROW EXECUTE FUNCTION workspace_seed_quota();

CREATE FUNCTION workspace_resource_quota_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE quota_workspace_id uuid; policy record; counters jsonb; used bigint; requested bigint; key text; ceiling bigint;
BEGIN
  IF TG_TABLE_NAME='docs_document' THEN
    IF NEW.deleted_at IS NOT NULL OR (TG_OP='UPDATE' AND OLD.deleted_at IS NULL) THEN RETURN NEW; END IF;
    quota_workspace_id := NEW.workspace_id; key := 'pages'; requested := 1;
  ELSE
    SELECT id INTO quota_workspace_id FROM public.workspaces_workspace WHERE organisation_id=NEW.organisation_id;
    key := 'mediaBytes'; requested := NEW.size_bytes;
  END IF;
  IF quota_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace quota configuration missing'
    USING ERRCODE='23514',CONSTRAINT='workspace_quota_missing'; END IF;
  PERFORM 1 FROM public.workspaces_workspace WHERE id=quota_workspace_id FOR UPDATE;
  SELECT * INTO policy FROM public.workspaces_workspacequota q WHERE q.workspace_id=quota_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace quota configuration missing'
    USING ERRCODE='23514',CONSTRAINT='workspace_quota_missing'; END IF;
  counters := public.workspace_quota_usage(quota_workspace_id);
  used := (counters->>key)::bigint;
  ceiling := CASE WHEN key='pages' THEN policy.pages ELSE policy.media_bytes END;
  PERFORM public.workspace_quota_refuse(key,ceiling,used,requested);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workspace_resource_quota_guard() FROM PUBLIC;
CREATE TRIGGER docs_page_quota BEFORE INSERT OR UPDATE OF deleted_at ON docs_document
 FOR EACH ROW EXECUTE FUNCTION workspace_resource_quota_guard();
CREATE TRIGGER media_reservation_quota BEFORE INSERT ON media_attachment
 FOR EACH ROW EXECUTE FUNCTION workspace_resource_quota_guard();

CREATE FUNCTION workspace_seat_quota_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE quota_workspace_id uuid; policy record; counters jsonb;
BEGIN
  IF TG_TABLE_NAME='orgs_membership' THEN
    IF NOT EXISTS(SELECT 1 FROM public.orgs_membership WHERE id=NEW.id AND state='active' AND accepted_at IS NOT NULL AND deleted_at IS NULL) THEN RETURN NULL; END IF;
    IF NEW.state<>'active' OR NEW.accepted_at IS NULL OR NEW.deleted_at IS NOT NULL OR (TG_OP='UPDATE' AND OLD.state='active' AND OLD.accepted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN RETURN NULL; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.orgs_invitation WHERE id=NEW.id AND state='pending' AND expires_at>statement_timestamp()) THEN RETURN NULL; END IF;
    IF NEW.state<>'pending' OR NEW.expires_at<=statement_timestamp()
       OR (TG_OP='UPDATE' AND OLD.state='pending' AND OLD.expires_at>statement_timestamp()) THEN RETURN NULL; END IF;
  END IF;
  SELECT id INTO quota_workspace_id FROM public.workspaces_workspace WHERE organisation_id=NEW.organisation_id FOR UPDATE;
  IF quota_workspace_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO policy FROM public.workspaces_workspacequota q WHERE q.workspace_id=quota_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace quota configuration missing'
    USING ERRCODE='23514',CONSTRAINT='workspace_quota_missing'; END IF;
  counters := public.workspace_quota_usage(quota_workspace_id);
  PERFORM public.workspace_quota_refuse('seats',policy.seats,greatest(0,(counters->>'seats')::bigint-1),1);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION workspace_seat_quota_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER membership_seat_quota AFTER INSERT OR UPDATE ON orgs_membership
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workspace_seat_quota_guard();
CREATE CONSTRAINT TRIGGER invitation_seat_quota AFTER INSERT OR UPDATE ON orgs_invitation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workspace_seat_quota_guard();

CREATE FUNCTION workspace_snapshot_quota_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE ceiling bigint;
BEGIN
  SELECT q.snapshot_bytes INTO ceiling FROM public.workspaces_workspacequota q
    JOIN public.docs_document d ON d.workspace_id=q.workspace_id WHERE d.id=NEW.document_id;
  IF ceiling IS NULL THEN RAISE EXCEPTION 'workspace quota configuration missing'
    USING ERRCODE='23514',CONSTRAINT='workspace_quota_missing'; END IF;
  PERFORM public.workspace_quota_refuse('snapshotBytes',ceiling,0,octet_length(NEW.state));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workspace_snapshot_quota_guard() FROM PUBLIC;
CREATE TRIGGER docs_snapshot_quota BEFORE INSERT OR UPDATE OF state ON docs_documentsnapshot
 FOR EACH ROW EXECUTE FUNCTION workspace_snapshot_quota_guard();
CREATE TRIGGER docs_update_quota BEFORE INSERT ON docs_documentupdate
 FOR EACH ROW EXECUTE FUNCTION workspace_snapshot_quota_guard();
'''

REVERSE = r'''
DROP TRIGGER docs_update_quota ON docs_documentupdate;
DROP TRIGGER docs_snapshot_quota ON docs_documentsnapshot;
DROP FUNCTION workspace_snapshot_quota_guard();
DROP TRIGGER invitation_seat_quota ON orgs_invitation;
DROP TRIGGER membership_seat_quota ON orgs_membership;
DROP FUNCTION workspace_seat_quota_guard();
DROP TRIGGER media_reservation_quota ON media_attachment;
DROP TRIGGER docs_page_quota ON docs_document;
DROP FUNCTION workspace_resource_quota_guard();
DROP TRIGGER workspace_seed_quota ON workspaces_workspace;
DROP FUNCTION workspace_seed_quota();
DROP FUNCTION workspace_quota_refuse(text,bigint,bigint,bigint);
DROP FUNCTION workspace_quota_usage(uuid);
'''


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0011_workspacequota"), ("docs", "0006_collection_scope"),
                    ("media", "0002_attachment_scope"), ("orgs", "0021_remove_organisation_organisation_slug_not_reserved_and_more")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

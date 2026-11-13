"""Bound each fully merged native document before persistence or disclosure."""

from django.db import migrations

FORWARD = r'''
CREATE FUNCTION docs_collab_snapshot_admit(p_document uuid,p_bytes bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ceiling bigint;
BEGIN
  IF p_bytes IS NULL OR p_bytes<0 OR p_bytes>2097152 THEN
    RAISE EXCEPTION 'invalid materialized snapshot size' USING ERRCODE='23514'; END IF;
  SELECT q.snapshot_bytes INTO ceiling FROM public.workspaces_workspacequota q
    JOIN public.docs_document d ON d.workspace_id=q.workspace_id
    WHERE d.id=p_document AND d.deleted_at IS NULL;
  IF ceiling IS NULL THEN RAISE EXCEPTION 'workspace quota configuration missing'
    USING ERRCODE='23514',CONSTRAINT='workspace_quota_missing'; END IF;
  PERFORM public.workspace_quota_refuse('snapshotBytes',ceiling,0,p_bytes);
END $$;
REVOKE ALL ON FUNCTION docs_collab_snapshot_admit(uuid,bigint) FROM PUBLIC;
'''


class Migration(migrations.Migration):
    dependencies = [("docs", "0006_collection_scope"), ("workspaces", "0012_quota_enforcement")]
    operations = [migrations.RunSQL(FORWARD, "DROP FUNCTION docs_collab_snapshot_admit(uuid,bigint);")]

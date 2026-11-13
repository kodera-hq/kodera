"""Reject cross-workspace bindings and preserve immutable source/delivery evidence."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION extension_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid; workspace uuid; old_json jsonb; new_json jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Extension evidence is retained' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='extensions_installation' THEN
  SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=NEW.workspace_id;
  IF NOT EXISTS(SELECT 1 FROM public.orgs_membership WHERE id=NEW.creator_id AND organisation_id=org) THEN
   RAISE EXCEPTION 'Extension creator workspace binding invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(NEW.events)<>'array' OR jsonb_array_length(NEW.events)>8 OR jsonb_array_length(NEW.events)=0
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.events) AS e(value)
      WHERE value IS NULL OR value NOT IN ('command.invoked','message.created','message.deleted','release.published','ci.workflow_failed','incident.opened','incident.acknowledged','incident.resolved')) THEN
   RAISE EXCEPTION 'Extension event grant invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.workspace_id<>OLD.workspace_id OR NEW.creator_id<>OLD.creator_id OR NEW.endpoint<>OLD.endpoint OR NEW.events<>OLD.events
    OR (OLD.revoked_at IS NOT NULL AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Extension installation binding immutable' USING ERRCODE='23514'; END IF;
   IF NEW.generation<>OLD.generation AND (NEW.previous_generation IS DISTINCT FROM OLD.generation OR NEW.grace_expires_at<=statement_timestamp()
      OR NEW.grace_expires_at>statement_timestamp()+interval '1 day' OR OLD.grace_expires_at>statement_timestamp()) THEN
    RAISE EXCEPTION 'Extension rotation grace invalid' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='extensions_delivery' THEN
  IF octet_length(NEW.event)>131072 OR encode(sha256(NEW.event),'hex')<>NEW.event_sha256 THEN
   RAISE EXCEPTION 'Extension event digest invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.installation_id<>OLD.installation_id OR NEW.installation_version<>OLD.installation_version
    OR NEW.event_key<>OLD.event_key OR NEW.event<>OLD.event OR NEW.event_sha256<>OLD.event_sha256
    OR (OLD.state IN ('delivered','dead_letter','obsolete') AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW))) THEN
   RAISE EXCEPTION 'Extension event evidence immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='extensions_deliveryattempt' THEN
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['outcome','response_status','updated_at']) IS DISTINCT FROM
     (to_jsonb(NEW)-ARRAY['outcome','response_status','updated_at']) OR OLD.outcome<>'started') THEN
   RAISE EXCEPTION 'Extension attempt evidence immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='extensions_importbatch' THEN
  SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=NEW.workspace_id;
  IF NEW.archive_sha256 !~ '^[a-f0-9]{64}$' OR octet_length(NEW.report::text)>1000000
    OR NOT EXISTS(SELECT 1 FROM public.orgs_membership WHERE id=NEW.creator_id AND organisation_id=org) THEN
   RAISE EXCEPTION 'Extension import batch binding invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['report','state','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['report','state','updated_at']) THEN
   RAISE EXCEPTION 'Extension import source immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='extensions_importedobject' THEN
  IF NEW.source_sha256 !~ '^[a-f0-9]{64}$' OR NOT EXISTS(SELECT 1 FROM public.docs_document WHERE id=NEW.document_id AND workspace_id=NEW.workspace_id)
   OR NOT EXISTS(SELECT 1 FROM public.extensions_importbatch WHERE id=NEW.batch_id AND workspace_id=NEW.workspace_id AND source=NEW.source)
   OR (NEW.collection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.docs_collection WHERE id=NEW.collection_id AND workspace_id=NEW.workspace_id)) THEN
   RAISE EXCEPTION 'Extension imported object workspace binding invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Extension imported source evidence immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='extensions_digestconsent' THEN
  IF NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_identity i
    ON i.user_id=m.user_id AND i.organisation_id=m.organisation_id WHERE m.id=NEW.membership_id AND i.id=NEW.identity_id) THEN
   RAISE EXCEPTION 'Digest identity membership binding invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW.membership_id<>OLD.membership_id THEN
   RAISE EXCEPTION 'Digest membership immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='extensions_digestjob' THEN
  SELECT w.id,m.organisation_id INTO workspace,org FROM public.extensions_digestconsent c
   JOIN public.orgs_membership m ON m.id=c.membership_id JOIN public.workspaces_workspace w ON w.organisation_id=m.organisation_id
   WHERE c.id=NEW.consent_id;
  IF jsonb_typeof(NEW.document_ids)<>'array' OR jsonb_typeof(NEW.collection_ids)<>'array'
   OR jsonb_array_length(NEW.document_ids)>1000 OR jsonb_array_length(NEW.collection_ids)>1000
   OR (SELECT count(*) FROM public.docs_document d WHERE d.workspace_id=workspace AND d.id IN (SELECT value::uuid FROM jsonb_array_elements_text(NEW.document_ids)))<>jsonb_array_length(NEW.document_ids)
   OR (SELECT count(*) FROM public.docs_collection c WHERE c.workspace_id=workspace AND c.id IN (SELECT value::uuid FROM jsonb_array_elements_text(NEW.collection_ids)))<>jsonb_array_length(NEW.collection_ids)
   OR (NEW.delivery_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.outbox_outboxdelivery d JOIN public.outbox_message m ON m.delivery_id=d.id WHERE d.id=NEW.delivery_id AND d.organisation_id=org AND m.template_id='workspace_digest')) THEN
   RAISE EXCEPTION 'Digest resources or delivery scope invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['state','delivery_id','updated_at']) IS DISTINCT FROM
      (to_jsonb(NEW)-ARRAY['state','delivery_id','updated_at']) OR OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id) THEN
   RAISE EXCEPTION 'Digest queued evidence immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION extension_scope_guard() FROM PUBLIC;
"""
TABLES = (
    "installation",
    "delivery",
    "deliveryattempt",
    "importbatch",
    "importedobject",
    "digestconsent",
    "digestjob",
)


class Migration(migrations.Migration):
    dependencies = [
        ("extensions", "0001_extension_delivery_import_digest"),
        ("outbox", "0003_messages"),
    ]
    operations = [
        migrations.RunSQL(
            FORWARD
            + "\n".join(
                f"CREATE TRIGGER extension_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON extensions_{table} FOR EACH ROW EXECUTE FUNCTION extension_scope_guard();"
                for table in TABLES
            ),
            "\n".join(
                f"DROP TRIGGER extension_scope_guard ON extensions_{table};" for table in TABLES
            )
            + "\nDROP FUNCTION extension_scope_guard();",
        )
    ]

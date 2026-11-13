"""Durable cutoff, actual Core payload erasure and separate external-store holds."""

from django.db import migrations

FORWARD = r'''

SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION privacy_erasure_context(p_org uuid) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.retention_context('erase','orgs_organisation',p_org) IS NOT NULL $$;
REVOKE ALL ON FUNCTION privacy_erasure_context(uuid) FROM PUBLIC;

CREATE FUNCTION privacy_erasure_journal_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'erasure journal retained' USING ERRCODE='23514'; END IF;
 IF NOT public.privacy_erasure_context(NEW.organisation_reference) THEN
  RAISE EXCEPTION 'erasure journal requires worker authority' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(NEW.inventory)
  OR NEW.status<>'cutoff' OR NEW.core_purged_at IS NOT NULL OR NEW.completed_at IS NOT NULL
  OR NEW.purge_not_before<NEW.cutoff_at THEN RAISE EXCEPTION 'erasure initial state refused' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','core_purged_at','completed_at','counts','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','core_purged_at','completed_at','counts','updated_at'])
  OR (OLD.core_purged_at IS NOT NULL AND NEW.core_purged_at IS DISTINCT FROM OLD.core_purged_at)
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
  OR (OLD.status<>NEW.status AND (OLD.status||'>'||NEW.status) NOT IN ('cutoff>core_purged','core_purged>complete'))
  THEN RAISE EXCEPTION 'erasure journal binding immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF (NEW.status='cutoff') IS DISTINCT FROM (NEW.core_purged_at IS NULL)
 OR (NEW.status='complete') IS DISTINCT FROM (NEW.completed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'erasure journal progression refused' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erasure_journal_immutable BEFORE INSERT OR UPDATE OR DELETE ON orgs_privacyerasure
 FOR EACH ROW EXECUTE FUNCTION privacy_erasure_journal_guard();

CREATE FUNCTION privacy_receipt_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE request public.orgs_privacyerasure%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'erasure receipt immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO request FROM public.orgs_privacyerasure WHERE id=NEW.erasure_id;
 IF NOT FOUND OR NOT (request.inventory->'required_domains') ? NEW.domain OR NEW.cutoff_at IS DISTINCT FROM request.cutoff_at
 OR NEW.verified_at<request.cutoff_at OR NEW.verified_at>clock_timestamp()
 OR NOT public.privacy_erasure_context(request.organisation_reference)
 OR NEW.adapter_revision !~ '^[A-Za-z0-9._-]{1,80}$'
 THEN RAISE EXCEPTION 'erasure receipt scope or authority refused' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erasure_receipt_immutable BEFORE INSERT OR UPDATE OR DELETE ON orgs_erasurereceipt
 FOR EACH ROW EXECUTE FUNCTION privacy_receipt_guard();

CREATE FUNCTION privacy_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb:=to_jsonb(NEW); org uuid; parent uuid;
BEGIN
 IF item ? 'organisation_id' THEN org:=(item->>'organisation_id')::uuid;
 ELSIF TG_TABLE_NAME='orgs_organisation' THEN org:=NEW.id;
 ELSIF item ? 'workspace_id' THEN
  SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=(item->>'workspace_id')::uuid;
 ELSIF item ? 'document_id' THEN
  SELECT w.organisation_id INTO org FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=(item->>'document_id')::uuid;
 ELSIF TG_TABLE_NAME='docs_documentlink' THEN
  SELECT w.organisation_id INTO org FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE d.id=NEW.source_id;
 ELSIF TG_TABLE_NAME='docs_collectionrow' THEN
  SELECT w.organisation_id INTO org FROM public.docs_collection c JOIN public.workspaces_workspace w ON w.id=c.workspace_id WHERE c.id=NEW.collection_id;
 ELSIF item ? 'delivery_id' THEN
  SELECT organisation_id INTO org FROM public.outbox_outboxdelivery WHERE id=(item->>'delivery_id')::uuid;
 ELSIF TG_TABLE_NAME='notifications_pushoutbox' THEN
  SELECT organisation_id INTO org FROM public.notifications_pushsubscription WHERE id=NEW.subscription_id;
 END IF;
 IF TG_TABLE_NAME='orgs_organisation' AND TG_OP='UPDATE'
 AND (to_jsonb(NEW)-ARRAY['authority_revision','owner_guard_revision'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['authority_revision','owner_guard_revision']) THEN RETURN NEW; END IF;
 IF org IS NOT NULL THEN
  -- Same lock as cutoff: a pre-cutoff writer commits before the inventory, or sees the fence.
  PERFORM 1 FROM public.orgs_organisation WHERE id=org FOR SHARE;
  IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org)
   AND NOT public.privacy_erasure_context(org) THEN
   RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON orgs_organisation FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON orgs_membership FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON identity_identity FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_document FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentgrant FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentlink FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentsnapshot FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_documentupdate FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_collection FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON docs_collectionrow FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON media_attachment FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON notifications_notification FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON notifications_pushsubscription FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON notifications_pushoutbox FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON orgs_invitation FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_workspace FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_channel FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_category FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_workspacemoderator FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_workspacememberrestriction FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_workspaceinvitelink FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON workspaces_workspaceabusereport FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_outboxdelivery FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON orgs_privacyexport FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON billing_billingprofile FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON support_supportticket FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_message FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_realmaccount FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_realmaccess FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();

DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('docs_journal_guard()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id
 WHERE d.id=OLD.document_id AND public.privacy_erasure_context(w.organisation_id)) THEN RETURN OLD; END IF;
$body$); EXECUTE definition; END $patch$;
DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('organisation_intake_change()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_OP='UPDATE' AND public.privacy_erasure_context(OLD.organisation_id)
 AND NEW.sealed_contact=decode('','hex') AND NEW.intended_owner_email_masked='erased'
 AND (to_jsonb(NEW)-ARRAY['sealed_contact','intended_owner_email_masked'])
 IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['sealed_contact','intended_owner_email_masked']) THEN RETURN NEW; END IF;
$body$); EXECUTE definition; END $patch$;
ALTER FUNCTION organisation_intake_change() SECURITY DEFINER; ALTER FUNCTION organisation_intake_change() SET search_path=pg_catalog,public,pg_temp;


CREATE FUNCTION privacy_export_expiry_inventory(p_ids jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item public.orgs_privacyexport%ROWTYPE; result jsonb:='{}'; deadline bigint; created bigint; found_count integer:=0;
BEGIN
 IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'original export expiry inventory invalid' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT * FROM public.orgs_privacyexport WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_ids)) ORDER BY id FOR SHARE LOOP
  IF jsonb_typeof(item.request_snapshot->'expires_at') IS DISTINCT FROM 'number'
  OR jsonb_typeof(item.request_snapshot->'created_at') IS DISTINCT FROM 'number'
  OR (item.request_snapshot->>'expires_at') !~ '^[0-9]{1,12}$'
  OR (item.request_snapshot->>'created_at') !~ '^[0-9]{1,12}$'
  OR item.request_snapshot->>'id' IS DISTINCT FROM item.id::text
  OR item.request_snapshot->>'user_id' IS DISTINCT FROM item.user_id::text
  OR item.request_snapshot->>'identity_id' IS DISTINCT FROM item.identity_id::text
  OR item.request_snapshot->>'scope' IS DISTINCT FROM item.scope
  OR item.request_snapshot->>'organisation_id' IS DISTINCT FROM item.organisation_id::text
  THEN RAISE EXCEPTION 'original export expiry snapshot binding invalid' USING ERRCODE='23514'; END IF;
  deadline:=(item.request_snapshot->>'expires_at')::bigint;
  created:=(item.request_snapshot->>'created_at')::bigint;
  IF created>floor(extract(epoch FROM clock_timestamp()))::bigint OR deadline<=created OR deadline-created>86400 THEN RAISE EXCEPTION 'original export expiry window invalid' USING ERRCODE='23514'; END IF;
  result:=result||jsonb_build_object(item.id::text,deadline); found_count:=found_count+1;
 END LOOP;
 IF found_count<>jsonb_array_length(p_ids) THEN RAISE EXCEPTION 'original export expiry inventory incomplete' USING ERRCODE='23514'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION privacy_export_expiry_inventory(jsonb) FROM PUBLIC;

CREATE FUNCTION privacy_begin_erasure(p_id uuid,p_org uuid,p_instruction text,p_digest text,p_not_before timestamptz,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE org public.orgs_organisation%ROWTYPE; cutoff timestamptz; inventory jsonb; receivers jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL
 OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'validated erasure instruction authority refused' USING ERRCODE='23514'; END IF;
 SELECT * INTO org FROM public.orgs_organisation WHERE id=p_org FOR UPDATE;
 IF NOT FOUND OR org.is_default_community OR EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=p_org)
 THEN RAISE EXCEPTION 'erasure scope unavailable or already fenced' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.notifications_pushoutbox q JOIN public.notifications_pushsubscription s ON s.id=q.subscription_id
 WHERE s.organisation_id=p_org AND q.state='in_flight') OR EXISTS(SELECT 1 FROM public.outbox_outboxdelivery
 WHERE organisation_id=p_org AND status='in_flight') THEN RAISE EXCEPTION 'erasure requires delivery drain' USING ERRCODE='23514'; END IF;
 cutoff:=clock_timestamp();
 inventory:=jsonb_build_object(
 'attachments',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM public.media_attachment WHERE organisation_id=p_org),'[]'),
 'private_exports',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM public.orgs_privacyexport WHERE organisation_id=p_org
 OR (scope='account' AND user_id IN (SELECT user_id FROM public.orgs_membership WHERE organisation_id=p_org))),'[]'));
 inventory:=inventory||jsonb_build_object('required_domains',jsonb_build_array('matrix','objects','identity_provider','private_exports'));
 inventory:=inventory||jsonb_build_object('private_export_expiries',public.privacy_export_expiry_inventory(inventory->'private_exports'));
 IF to_regclass('public.extensions_installation') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(''urn:kodera:extension-installation:''||i.id||'':endpoint-sha256:''||encode(sha256(convert_to(i.endpoint,''UTF8'')),''hex'') ORDER BY i.id),''[]''::jsonb) FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=$1' INTO receivers USING p_org;
  inventory:=inventory||jsonb_build_object('extension_receivers',receivers,
   'required_domains',(inventory->'required_domains')||jsonb_build_array('external_extension_receivers'));
 END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'erase','orgs_organisation',p_org,'{}');
 INSERT INTO public.orgs_privacyerasure(id,created_at,updated_at,organisation_reference,instruction_ref,instruction_sha256,
 cutoff_at,purge_not_before,inventory,inventory_sha256,status,counts) VALUES(p_id,cutoff,cutoff,p_org,p_instruction,p_digest,
 cutoff,greatest(p_not_before,cutoff),inventory,public.retention_inventory_digest(inventory),'cutoff','{}');
 UPDATE public.orgs_organisation SET state='closed',deleted_at=cutoff,
 purge_after=greatest(p_not_before,cutoff+interval '1 microsecond'),updated_at=cutoff WHERE id=p_org;
 UPDATE public.identity_identity SET enabled=false,updated_at=cutoff WHERE organisation_id=p_org;
 UPDATE public.engine_intents_credential SET state='revoked',revoked_at=COALESCE(revoked_at,cutoff) WHERE organisation_id=p_org;
 UPDATE public.orgs_privacyexport SET status='expired',checkpoint='{}',revision=revision+1,updated_at=cutoff
 WHERE id IN (SELECT jsonb_array_elements_text(inventory->'private_exports')::uuid);
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),cutoff,'staff',p_actor,'urn:kodera:identity:'||p_actor,p_org,'privacy.erasure_cutoff',
 'urn:kodera:organisation:'||p_org,'standard',jsonb_build_object('request_id',p_id,'instruction_ref',p_instruction,'instruction_sha256',p_digest));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='erase' AND source_table='orgs_organisation' AND source_id=p_org;
 RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_purge_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET lock_timeout='3s' SET statement_timeout='30s' AS $$
DECLARE request public.orgs_privacyerasure%ROWTYPE; org uuid; purged_counts jsonb:='{}'; n bigint; remaining bigint;
BEGIN
 SELECT * INTO request FROM public.orgs_privacyerasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.purge_not_before>clock_timestamp() THEN RAISE EXCEPTION 'erasure cutoff not due' USING ERRCODE='23514'; END IF;
 IF request.core_purged_at IS NOT NULL THEN RETURN request.counts; END IF;
 org:=request.organisation_reference;
 PERFORM 1 FROM public.orgs_organisation WHERE id=org AND state='closed' AND deleted_at=request.cutoff_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure durable cutoff binding missing' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'erase','orgs_organisation',org,'{}');
 DELETE FROM public.docs_collectionrow WHERE collection_id IN (SELECT c.id FROM public.docs_collection c JOIN public.workspaces_workspace w ON w.id=c.workspace_id WHERE w.organisation_id=org);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('collection_rows',n);
 DELETE FROM public.docs_collection WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('collections',n);
 DELETE FROM public.docs_documentlink WHERE source_id IN (SELECT d.id FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE w.organisation_id=org);
 DELETE FROM public.docs_documentgrant WHERE document_id IN (SELECT d.id FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE w.organisation_id=org);
 DELETE FROM public.docs_documentupdate WHERE document_id IN (SELECT d.id FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE w.organisation_id=org);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('yjs_updates',n);
 DELETE FROM public.docs_documentsnapshot WHERE document_id IN (SELECT d.id FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE w.organisation_id=org);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('yjs_snapshots',n);
 -- Child-first leaves preserve the real self-FK; no disabling/defer-all shortcut.
 LOOP
  DELETE FROM public.docs_document d WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org)
  AND NOT EXISTS(SELECT 1 FROM public.docs_document child WHERE child.parent_id=d.id);
  GET DIAGNOSTICS n=ROW_COUNT;
  EXIT WHEN n=0;
  purged_counts:=jsonb_set(purged_counts,'{documents}',to_jsonb(COALESCE((purged_counts->>'documents')::bigint,0)+n));
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.docs_document d JOIN public.workspaces_workspace w ON w.id=d.workspace_id WHERE w.organisation_id=org)
 THEN RAISE EXCEPTION 'document erasure tree did not converge' USING ERRCODE='23514'; END IF;
 DELETE FROM public.notifications_pushoutbox WHERE subscription_id IN (SELECT id FROM public.notifications_pushsubscription WHERE organisation_id=org);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('push_outbox',n);
 DELETE FROM public.notifications_pushsubscription WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('push_subscriptions',n);
 DELETE FROM public.notifications_notification WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('notifications',n);
 DELETE FROM public.media_attachment WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('attachment_metadata',n);
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
 -- A person still using another organisation keeps their own legitimate global account.
 UPDATE public.identity_user u SET email='erased:'||u.id,display_name=NULL,enabled=false,updated_at=clock_timestamp()
 WHERE EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.user_id=u.id AND i.organisation_id=org)
 AND NOT EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.user_id=u.id AND (i.organisation_id IS DISTINCT FROM org)
 AND i.enabled AND i.deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.orgs_membership m WHERE m.user_id=u.id AND m.organisation_id<>org
 AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('unshared_person_contacts',n);
 UPDATE public.orgs_organisation SET name='Erased organisation',security_contact_email=NULL,privacy_contact_email=NULL,
 subprocessor_notice_email=NULL,updated_at=clock_timestamp() WHERE id=org;
 UPDATE public.orgs_organisationintake SET sealed_contact=decode('','hex'),intended_owner_email_masked='erased' WHERE organisation_id=org;
 UPDATE public.orgs_invitation SET email='erased+'||id||'@invalid.test',display_name=NULL,token_digest=decode('','hex'),token_sealed=decode('','hex') WHERE organisation_id=org;
 UPDATE public.support_supportticket SET subject='',body='',reply_to_email=NULL,contact_email=NULL,
 content_erased_at=COALESCE(content_erased_at,clock_timestamp()) WHERE organisation_id=org;
 DELETE FROM public.billing_billingprofile WHERE organisation_id=org;
 DELETE FROM public.workspaces_workspaceabusereport WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
 UPDATE public.outbox_message SET sealed=NULL WHERE delivery_id IN (SELECT id FROM public.outbox_outboxdelivery WHERE organisation_id=org);
 UPDATE public.workspaces_channel SET name='erased-'||id,topic='',version=version+1 WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
 UPDATE public.workspaces_category SET name='erased-'||id,version=version+1 WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
 UPDATE public.orgs_privacyerasure SET status='core_purged',core_purged_at=clock_timestamp(),counts=purged_counts,updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,org,'privacy.core_erased',
 'urn:kodera:organisation:'||org,'standard',jsonb_build_object('request_id',p_id,'counts',purged_counts));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='erase' AND source_table='orgs_organisation' AND source_id=org;
 RETURN purged_counts;
END $$;
REVOKE ALL ON FUNCTION privacy_purge_core(uuid) FROM PUBLIC;

CREATE FUNCTION privacy_record_absence(p_id uuid,p_domain text,p_cutoff timestamptz,p_digest text,p_revision text,p_verified timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE request public.orgs_privacyerasure%ROWTYPE;
BEGIN
 SELECT * INTO request FROM public.orgs_privacyerasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure request absent' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'erase','orgs_organisation',request.organisation_reference,'{}');
 INSERT INTO public.orgs_erasurereceipt(id,created_at,updated_at,erasure_id,domain,cutoff_at,evidence_sha256,adapter_revision,verified_at)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),clock_timestamp(),p_id,p_domain,p_cutoff,p_digest,p_revision,p_verified);
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='erase' AND source_table='orgs_organisation' AND source_id=request.organisation_reference;
END $$;
REVOKE ALL ON FUNCTION privacy_record_absence(uuid,text,timestamptz,text,text,timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION privacy_erasure_journal_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy_receipt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy_cutoff_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION organisation_intake_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION docs_journal_guard() FROM PUBLIC;

'''

class Migration(migrations.Migration):
    dependencies = [("orgs", "0024_privacyerasure_erasurereceipt"), ("billing", "0019_statutory_worker_operations"), ("docs", "0006_collection_scope"), ("notifications", "0002_recipient_scope"), ("outbox", "0006_invitations"), ("support", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD)]

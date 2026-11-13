"""Customer account cutoff and own personal-data erasure without workspace-content deletion."""

from django.db import migrations

FORWARD = r"""

SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION privacy_account_context(p_user uuid) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.retention_context('account','identity_user',p_user) IS NOT NULL $$;
REVOKE ALL ON FUNCTION privacy_account_context(uuid) FROM PUBLIC;

CREATE FUNCTION privacy_account_journal_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'account erasure journal retained' USING ERRCODE='23514'; END IF;
 IF NOT public.privacy_account_context(NEW.user_reference) THEN RAISE EXCEPTION 'account erasure admission required' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'cutoff' OR NEW.core_purged_at IS NOT NULL OR NEW.protocol_emitted_at IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NEW.purge_not_before<NEW.cutoff_at OR NEW.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(NEW.inventory)
  THEN RAISE EXCEPTION 'account erasure initial binding refused' USING ERRCODE='23514'; END IF;
 ELSIF (to_jsonb(NEW)-ARRAY['status','core_purged_at','protocol_emitted_at','completed_at','counts','updated_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','core_purged_at','protocol_emitted_at','completed_at','counts','updated_at'])
 OR (OLD.protocol_emitted_at IS NOT NULL AND NEW.protocol_emitted_at IS DISTINCT FROM OLD.protocol_emitted_at)
 OR (OLD.core_purged_at IS NOT NULL AND NEW.core_purged_at IS DISTINCT FROM OLD.core_purged_at)
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 OR (OLD.status='complete' AND NEW.status<>'complete')
 OR (OLD.status='core_purged' AND NEW.status NOT IN ('core_purged','complete'))
 THEN RAISE EXCEPTION 'account erasure journal immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.status IN ('core_purged','complete')) IS DISTINCT FROM (NEW.core_purged_at IS NOT NULL)
 OR (NEW.status='complete') IS DISTINCT FROM (NEW.completed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'account erasure progression refused' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION privacy_account_journal_guard() FROM PUBLIC;
CREATE TRIGGER account_erasure_immutable BEFORE INSERT OR UPDATE OR DELETE ON orgs_accounterasure
FOR EACH ROW EXECUTE FUNCTION privacy_account_journal_guard();

CREATE FUNCTION privacy_account_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE person uuid; item jsonb:=to_jsonb(NEW);
BEGIN
 IF TG_TABLE_NAME='identity_user' THEN person:=NEW.id;
 ELSIF item ? 'user_id' THEN person:=(item->>'user_id')::uuid;
 ELSIF item ? 'membership_id' THEN SELECT user_id INTO person FROM public.orgs_membership WHERE id=(item->>'membership_id')::uuid;
 ELSIF TG_TABLE_NAME='notifications_pushoutbox' THEN
  SELECT m.user_id INTO person FROM public.notifications_pushsubscription s JOIN public.orgs_membership m ON m.id=s.membership_id WHERE s.id=NEW.subscription_id;
 ELSIF TG_TABLE_NAME='docs_documentupdate' THEN
  SELECT user_id INTO person FROM public.identity_identity WHERE id=NEW.actor_id;
 END IF;
 IF person IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.identity_user WHERE id=person FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=person) OR public.privacy_account_context(person) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='identity_user' THEN
   IF NOT NEW.enabled AND NEW.email='erased:'||OLD.id AND NEW.display_name IS NULL
   AND (to_jsonb(NEW)-ARRAY['email','display_name','enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','display_name','enabled','updated_at'])
   AND EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.user_id=OLD.id AND public.privacy_erasure_context(i.organisation_id))
   THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='identity_identity' THEN
   IF public.privacy_erasure_context(OLD.organisation_id) AND NOT NEW.enabled
   AND ((NEW.email='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['email','enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','enabled','updated_at']))
   OR (NEW.subject='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['subject','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','updated_at'])))
   THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='orgs_privacyexport' THEN
   IF NEW.status='expired' AND NEW.checkpoint='{}'::jsonb AND NEW.revision=OLD.revision+1
   AND (to_jsonb(NEW)-ARRAY['status','checkpoint','revision','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','checkpoint','revision','updated_at'])
   THEN RETURN NEW; END IF;
  END IF;
 END IF;

 IF TG_TABLE_NAME='orgs_membership' AND TG_OP='UPDATE' THEN
  IF NEW.state='removed' AND (to_jsonb(NEW)-ARRAY['state','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='identity_identity' AND TG_OP='UPDATE' THEN
  IF NOT NEW.enabled AND (to_jsonb(NEW)-ARRAY['enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['enabled','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='outbox_realmaccess' THEN
  IF NEW.operation='access_off' THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION privacy_account_cutoff_guard() FROM PUBLIC;
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON identity_user FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON identity_identity FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON orgs_membership FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON orgs_privacyexport FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON notifications_pushsubscription FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON notifications_notification FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON notifications_pushoutbox FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON outbox_realmaccess FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON docs_documentupdate FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
DO $patch$ DECLARE definition text; BEGIN SELECT pg_get_functiondef('privacy_cutoff_guard()'::regprocedure) INTO definition; definition:=regexp_replace(definition,'BEGIN',$body$BEGIN
 IF TG_TABLE_NAME='identity_identity' AND TG_OP='UPDATE' THEN
  IF public.privacy_account_context(OLD.user_id) AND NOT NEW.enabled
  AND ((NEW.email='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['email','enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','enabled','updated_at']))
   OR (NEW.subject='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['subject','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','updated_at']))) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_membership' AND TG_OP='UPDATE' THEN
  IF NEW.state='removed' AND EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=NEW.user_id)
  AND (to_jsonb(NEW)-ARRAY['state','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at']) THEN RETURN NEW; END IF;
 END IF;
$body$); EXECUTE definition; END $patch$;

CREATE FUNCTION privacy_begin_account_erasure(p_id uuid,p_identity uuid,p_instruction text,p_digest text,p_not_before timestamptz,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE person uuid; cutoff timestamptz; inventory jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE='23514'; END IF;
 SELECT user_id INTO person FROM public.identity_identity WHERE id=p_identity AND organisation_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.identity_user WHERE id=person AND enabled AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure person unavailable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.orgs_organisation WHERE id IN (
  SELECT organisation_id FROM public.orgs_membership WHERE user_id=person
  UNION SELECT organisation_id FROM public.identity_identity WHERE user_id=person AND organisation_id IS NOT NULL
 ) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.identity_identity WHERE id=p_identity AND user_id=person AND enabled AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=person)
 THEN RAISE EXCEPTION 'account erasure current identity unavailable' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.identity_identity WHERE user_id=person AND organisation_id IS NULL)
 THEN RAISE EXCEPTION 'staff managed person requires separate erasure policy' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.orgs_organisation o ON o.id=m.organisation_id
 WHERE m.user_id=person AND m.role='org_owner' AND m.state='active' AND m.accepted_at IS NOT NULL AND m.deleted_at IS NULL
 AND o.state<>'closed' AND NOT EXISTS(SELECT 1 FROM public.orgs_membership other WHERE other.organisation_id=m.organisation_id
 AND other.user_id<>person AND other.role='org_owner' AND other.state='active' AND other.accepted_at IS NOT NULL AND other.deleted_at IS NULL))
 THEN RAISE EXCEPTION 'account erasure last-owner transfer required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.notifications_pushoutbox q JOIN public.notifications_pushsubscription s ON s.id=q.subscription_id
 JOIN public.orgs_membership m ON m.id=s.membership_id WHERE m.user_id=person AND q.state='in_flight')
 THEN RAISE EXCEPTION 'account erasure push delivery drain required' USING ERRCODE='23514'; END IF;
 cutoff:=clock_timestamp();
 inventory:=jsonb_build_object(
 'organisations',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.orgs_organisation WHERE id IN (
 SELECT organisation_id FROM public.orgs_membership WHERE user_id=person UNION SELECT organisation_id FROM public.identity_identity WHERE user_id=person AND organisation_id IS NOT NULL)),'[]'),
 'identities',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.identity_identity WHERE user_id=person),'[]'),
 'private_exports',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.orgs_privacyexport WHERE user_id=person),'[]'),
 'required_domains',jsonb_build_array('matrix_accounts','identity_provider_accounts','private_exports','account_message_outbox'));
 inventory:=inventory||jsonb_build_object('private_export_expiries',public.privacy_export_expiry_inventory(inventory->'private_exports'));
 inventory:=inventory||jsonb_build_object(
 'engine_member_revisions',coalesce((SELECT jsonb_object_agg(o.id::text,coalesce(h.revision,0)) FROM public.orgs_organisation o
 LEFT JOIN public.engine_intents_head h ON h.organisation_id=o.id WHERE o.id IN (SELECT value::uuid FROM jsonb_array_elements_text(inventory->'organisations'))),'{}'),
 'engine_channel_revisions',coalesce((SELECT jsonb_object_agg(o.id::text,coalesce(h.revision,0)) FROM public.orgs_organisation o
 LEFT JOIN public.engine_intents_channel_head h ON h.organisation_id=o.id WHERE o.id IN (SELECT value::uuid FROM jsonb_array_elements_text(inventory->'organisations'))),'{}'));

 IF to_regclass('public.extensions_installation') IS NOT NULL THEN
  inventory:=inventory||jsonb_build_object('required_domains',(inventory->'required_domains')||jsonb_build_array('account_extension_subjects'));
 END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',person,'{}');
 INSERT INTO public.orgs_accounterasure(id,created_at,updated_at,user_reference,requester_identity_reference,instruction_ref,
 instruction_sha256,cutoff_at,purge_not_before,inventory,inventory_sha256,status,counts)
 VALUES(p_id,cutoff,cutoff,person,p_identity,p_instruction,p_digest,cutoff,greatest(cutoff,p_not_before),inventory,
 public.retention_inventory_digest(inventory),'cutoff','{}');
 UPDATE public.identity_user SET enabled=false,updated_at=cutoff WHERE id=person;
 UPDATE public.identity_identity SET enabled=false,updated_at=cutoff WHERE user_id=person AND enabled;
 UPDATE public.orgs_privacyexport SET status='expired',checkpoint='{}',revision=revision+1,updated_at=cutoff WHERE user_id=person;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),cutoff,'staff',p_actor,'urn:kodera:identity:'||p_actor,NULL,'privacy.account_cutoff',
 'urn:kodera:person:'||person,'standard',jsonb_build_object('request_id',p_id,'instruction_ref',p_instruction,'instruction_sha256',p_digest));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=person;
 RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION privacy_begin_account_erasure(uuid,uuid,text,text,timestamptz,uuid) FROM PUBLIC;

CREATE FUNCTION privacy_account_protocol_recorded(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
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
REVOKE ALL ON FUNCTION privacy_account_protocol_recorded(uuid) FROM PUBLIC;

CREATE FUNCTION privacy_purge_account_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='20s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE; person uuid; purged_counts jsonb:='{}'; n bigint;
BEGIN
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.purge_not_before>clock_timestamp() THEN RAISE EXCEPTION 'account erasure cutoff not due' USING ERRCODE='23514'; END IF;
 IF request.core_purged_at IS NOT NULL THEN RETURN request.counts; END IF;
 IF request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory)
 THEN RAISE EXCEPTION 'account erasure inventory digest mismatch' USING ERRCODE='23514'; END IF;
 person:=request.user_reference;
 PERFORM 1 FROM public.identity_user WHERE id=person AND NOT enabled FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure authority cutoff missing' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',person,'{}');
 DELETE FROM public.notifications_pushoutbox WHERE subscription_id IN (SELECT s.id FROM public.notifications_pushsubscription s JOIN public.orgs_membership m ON m.id=s.membership_id WHERE m.user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('push_outbox',n);
 DELETE FROM public.notifications_pushsubscription WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('push_subscriptions',n);
 DELETE FROM public.notifications_notification WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('notifications',n);
 UPDATE public.support_supportticket SET subject='',body='',reply_to_email=NULL,contact_email=NULL,
 content_erased_at=coalesce(content_erased_at,clock_timestamp()) WHERE created_by_id IN (SELECT id FROM public.identity_identity WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('own_support_contacts',n);
 UPDATE public.orgs_invitation SET email='erased+'||id||'@invalid.test',display_name=NULL,token_digest=decode('','hex'),token_sealed=decode('','hex')
 WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE user_id=person;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
 UPDATE public.identity_user SET email='erased:'||id,display_name=NULL,enabled=false,updated_at=clock_timestamp() WHERE id=person;
 UPDATE public.orgs_accounterasure SET status='core_purged',core_purged_at=clock_timestamp(),counts=purged_counts,updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,NULL,'privacy.account_core_erased',
 'urn:kodera:person:'||person,'standard',jsonb_build_object('request_id',p_id,'counts',purged_counts));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=person;
 RETURN purged_counts;
END $$;
REVOKE ALL ON FUNCTION privacy_purge_account_core(uuid) FROM PUBLIC;

"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0028_accounterasure")]
    operations = [migrations.RunSQL(FORWARD)]

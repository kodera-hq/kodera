"""Install closed confidential privacy SQL and refuse predecessor-function body drift.

The four predecessor bodies are copied from the latest FORWARD definitions in orgs
0025/0029/0032 at the immutable integration basis. Only the existing four relay hook
statements differ. Static prosrc checks precede every replacement; reverse begins with
the existing retained-resource/journal guard and restores predecessor bodies in reverse
order. No migration SQL or replacement body is assembled or executed through Python.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.e2ee_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_org uuid; parent_epoch bigint;
BEGIN
 IF TG_TABLE_NAME='e2ee_device' THEN
  IF NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_identity i ON i.user_id=m.user_id
    JOIN public.orgs_organisation o ON o.id=m.organisation_id
    WHERE m.id=NEW.membership_id AND i.id=NEW.identity_id AND m.organisation_id=NEW.organisation_id
    AND i.organisation_id=o.id AND i.issuer=o.issuer AND i.realm=o.realm)
  THEN RAISE EXCEPTION 'e2ee device authority scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
  THEN RAISE EXCEPTION 'e2ee device revocation is permanent' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='e2ee_room' THEN
  IF NOT EXISTS(SELECT 1 FROM public.workspaces_channel c JOIN public.workspaces_workspace w ON w.id=c.workspace_id
    WHERE c.id=NEW.channel_id AND w.organisation_id=NEW.organisation_id AND c.kind='text')
  THEN RAISE EXCEPTION 'e2ee room channel scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (NEW.epoch<>0 OR NEW.head_sequence<>0 OR NEW.rekey_required)
   OR TG_OP='UPDATE' AND (NEW.epoch<OLD.epoch OR NEW.epoch-OLD.epoch>1 OR NEW.head_sequence<OLD.head_sequence
       OR (OLD.rekey_required AND NOT NEW.rekey_required AND NEW.epoch=OLD.epoch))
  THEN RAISE EXCEPTION 'e2ee room transition refused' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='e2ee_keypackage' THEN
  SELECT organisation_id INTO parent_org FROM public.e2ee_device WHERE id=NEW.device_id;
  IF parent_org IS DISTINCT FROM NEW.organisation_id
   OR NEW.package IS NOT NULL AND NEW.reference IS DISTINCT FROM sha256(NEW.package)
   OR TG_OP='INSERT' AND NEW.package IS NULL
  THEN RAISE EXCEPTION 'e2ee package scope or reference refused' USING ERRCODE='23514'; END IF;
  IF NEW.claimed_for_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.e2ee_room r JOIN public.e2ee_device d ON d.organisation_id=r.organisation_id
    WHERE r.id=NEW.claimed_for_id AND d.id=NEW.claimed_by_id AND r.organisation_id=NEW.organisation_id)
  THEN RAISE EXCEPTION 'e2ee package claim scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.claimed_at IS NOT NULL AND (NEW.claimed_at,NEW.claimed_for_id,NEW.claimed_by_id,NEW.claimed_epoch)
       IS DISTINCT FROM (OLD.claimed_at,OLD.claimed_for_id,OLD.claimed_by_id,OLD.claimed_epoch)
    OR (OLD.package IS NULL AND NEW.package IS NOT NULL)
    OR (OLD.package IS NOT NULL AND NEW.package IS NOT NULL AND NEW.package IS DISTINCT FROM OLD.package)
    OR (OLD.discarded_at IS NOT NULL AND NEW.discarded_at IS DISTINCT FROM OLD.discarded_at)
   THEN RAISE EXCEPTION 'e2ee package claim and payload are single use' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  SELECT organisation_id,epoch INTO parent_org,parent_epoch FROM public.e2ee_room WHERE id=NEW.room_id;
  IF parent_org IS DISTINCT FROM NEW.organisation_id THEN RAISE EXCEPTION 'e2ee room scope refused' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='e2ee_participant' THEN
   IF NOT EXISTS(SELECT 1 FROM public.e2ee_device WHERE id=NEW.device_id AND organisation_id=NEW.organisation_id)
    OR NEW.joined_epoch>parent_epoch+1 OR NEW.left_epoch>parent_epoch+1
   THEN RAISE EXCEPTION 'e2ee participant scope refused' USING ERRCODE='23514'; END IF;
  ELSE
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'e2ee envelope is append only' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.e2ee_device WHERE id=NEW.sender_id AND organisation_id=NEW.organisation_id)
    OR NEW.recipient_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.e2ee_device WHERE id=NEW.recipient_id AND organisation_id=NEW.organisation_id)
    OR NEW.kind='application' AND NEW.epoch<>parent_epoch
    OR NEW.kind IN ('commit','welcome') AND NEW.epoch<>parent_epoch+1
   THEN RAISE EXCEPTION 'e2ee envelope scope or epoch refused' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_scope_guard() FROM PUBLIC;

CREATE FUNCTION public.e2ee_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid; room public.e2ee_room%ROWTYPE; last_sequence bigint;
BEGIN
 IF TG_TABLE_NAME='e2ee_room' THEN target:=NEW.id; ELSE target:=NEW.room_id; END IF;
 SELECT * INTO room FROM public.e2ee_room WHERE id=target;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT coalesce(max(sequence),0) INTO last_sequence FROM public.e2ee_envelope WHERE room_id=target;
 IF room.head_sequence<>last_sequence OR EXISTS(SELECT 1 FROM public.e2ee_envelope WHERE room_id=target AND epoch>room.epoch)
  OR EXISTS(SELECT 1 FROM public.e2ee_participant WHERE room_id=target AND joined_epoch>room.epoch)
  OR room.epoch>0 AND NOT EXISTS(SELECT 1 FROM public.e2ee_envelope WHERE room_id=target AND kind='commit' AND epoch=room.epoch)
 THEN RAISE EXCEPTION 'e2ee committed counters require matching envelopes' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_counter_guard() FROM PUBLIC;

CREATE FUNCTION public.e2ee_cutoff_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE people uuid[]; person uuid;
BEGIN
 -- A leave-only transition cannot restore authority or disclose new content. It
 -- must remain available to retire an erased account's stale cryptographic leaf.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='e2ee_participant' THEN
  IF OLD.left_epoch IS NULL AND NEW.left_epoch IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['left_epoch','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['left_epoch','updated_at'])
  THEN RETURN NEW; END IF;
 END IF;
 -- Approved account cleanup changes only its own revocation/payload fields. Do
 -- not acquire another claimant's account fence: two account purges may share
 -- claims, and taking their fences in opposite ownership order would deadlock.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='e2ee_device' THEN
  SELECT user_id INTO person FROM public.orgs_membership WHERE id=NEW.membership_id;
  IF public.privacy_account_context(person) AND NEW.revoked_at IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['revoked_at','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','updated_at'])
  THEN RETURN NEW; END IF;
 ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='e2ee_keypackage' THEN
  -- Removing bytes cannot restore authority. Keep immutable claim metadata and
  -- never wait on a foreign claimant's account fence after a workspace lock.
  IF OLD.package IS NOT NULL AND NEW.package IS NULL AND NEW.discarded_at IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['package','discarded_at','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['package','discarded_at','updated_at'])
  THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='e2ee_device' THEN
  SELECT ARRAY[m.user_id] INTO people FROM public.orgs_membership m WHERE m.id=NEW.membership_id;
 ELSIF TG_TABLE_NAME IN ('e2ee_participant','e2ee_keypackage') THEN
  SELECT array_agg(DISTINCT m.user_id ORDER BY m.user_id) INTO people FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id
    WHERE d.id=NEW.device_id OR (TG_TABLE_NAME='e2ee_keypackage' AND d.id=(to_jsonb(NEW)->>'claimed_by_id')::uuid);
 ELSIF TG_TABLE_NAME='e2ee_envelope' THEN
  SELECT array_agg(DISTINCT m.user_id ORDER BY m.user_id) INTO people FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE d.id IN (NEW.sender_id,NEW.recipient_id);
 END IF;
 FOREACH person IN ARRAY coalesce(people,ARRAY[]::uuid[]) LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:'||person::text,0));
  IF EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=person) AND NOT public.privacy_account_context(person)
  THEN RAISE EXCEPTION 'durable account cutoff refuses e2ee write' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:'||NEW.organisation_id::text,0));
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=NEW.organisation_id)
  AND NOT public.privacy_erasure_context(NEW.organisation_id)
 THEN RAISE EXCEPTION 'durable organisation cutoff refuses e2ee write' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.e2ee_organisation_inventory(scope uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'devices',(SELECT count(*) FROM public.e2ee_device WHERE organisation_id=scope),
 'rooms',(SELECT count(*) FROM public.e2ee_room WHERE organisation_id=scope),
 'packages',(SELECT count(*) FROM public.e2ee_keypackage WHERE organisation_id=scope),
 'participants',(SELECT count(*) FROM public.e2ee_participant WHERE organisation_id=scope),
 'envelopes',(SELECT count(*) FROM public.e2ee_envelope WHERE organisation_id=scope))) $$;
REVOKE ALL ON FUNCTION public.e2ee_organisation_inventory(uuid) FROM PUBLIC;
CREATE FUNCTION public.e2ee_account_inventory(person uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'device_ids',coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),'[]'),
 'directory_packages',(SELECT count(*) FROM public.e2ee_keypackage p JOIN public.e2ee_device d ON d.id=p.device_id JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),
 'retained_policy','controller-owned encrypted history and public signature-verification metadata')) $$;
REVOKE ALL ON FUNCTION public.e2ee_account_inventory(uuid) FROM PUBLIC;

CREATE FUNCTION public.e2ee_purge_organisation(scope uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='{}'; n bigint;
BEGIN
 IF NOT public.privacy_erasure_context(scope) THEN RAISE EXCEPTION 'e2ee organisation purge requires worker context' USING ERRCODE='23514'; END IF;
 DELETE FROM public.e2ee_envelope WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_envelopes',n);
 DELETE FROM public.e2ee_keypackage WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_packages',n);
 DELETE FROM public.e2ee_participant WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_participants',n);
 DELETE FROM public.e2ee_room WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_rooms',n);
 DELETE FROM public.e2ee_device WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_devices',n);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_purge_organisation(uuid) FROM PUBLIC;
CREATE FUNCTION public.e2ee_purge_account(person uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='{}'; n bigint;
BEGIN
 IF NOT public.privacy_account_context(person) THEN RAISE EXCEPTION 'e2ee account purge requires worker context' USING ERRCODE='23514'; END IF;
 UPDATE public.e2ee_device SET revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE revoked_at IS NULL AND membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_devices_revoked',n);
 UPDATE public.e2ee_keypackage SET package=NULL,discarded_at=clock_timestamp(),updated_at=clock_timestamp() WHERE package IS NOT NULL AND device_id IN (SELECT d.id FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_directory_packages_discarded',n);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_purge_account(uuid) FROM PUBLIC;

CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_device FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','membership_id','identity_id','signing_key');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_room FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','channel_id','algorithm');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_participant FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','room_id','device_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_keypackage FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','device_id','reference','expires_at');

CREATE TRIGGER b_e2ee_scope BEFORE INSERT OR UPDATE ON public.e2ee_device FOR EACH ROW EXECUTE FUNCTION public.e2ee_scope_guard();
CREATE TRIGGER c_e2ee_cutoff BEFORE INSERT OR UPDATE ON public.e2ee_device FOR EACH ROW EXECUTE FUNCTION public.e2ee_cutoff_guard();

CREATE TRIGGER b_e2ee_scope BEFORE INSERT OR UPDATE ON public.e2ee_room FOR EACH ROW EXECUTE FUNCTION public.e2ee_scope_guard();
CREATE TRIGGER c_e2ee_cutoff BEFORE INSERT OR UPDATE ON public.e2ee_room FOR EACH ROW EXECUTE FUNCTION public.e2ee_cutoff_guard();

CREATE TRIGGER b_e2ee_scope BEFORE INSERT OR UPDATE ON public.e2ee_participant FOR EACH ROW EXECUTE FUNCTION public.e2ee_scope_guard();
CREATE TRIGGER c_e2ee_cutoff BEFORE INSERT OR UPDATE ON public.e2ee_participant FOR EACH ROW EXECUTE FUNCTION public.e2ee_cutoff_guard();

CREATE TRIGGER b_e2ee_scope BEFORE INSERT OR UPDATE ON public.e2ee_keypackage FOR EACH ROW EXECUTE FUNCTION public.e2ee_scope_guard();
CREATE TRIGGER c_e2ee_cutoff BEFORE INSERT OR UPDATE ON public.e2ee_keypackage FOR EACH ROW EXECUTE FUNCTION public.e2ee_cutoff_guard();

CREATE TRIGGER b_e2ee_scope BEFORE INSERT OR UPDATE ON public.e2ee_envelope FOR EACH ROW EXECUTE FUNCTION public.e2ee_scope_guard();
CREATE TRIGGER c_e2ee_cutoff BEFORE INSERT OR UPDATE ON public.e2ee_envelope FOR EACH ROW EXECUTE FUNCTION public.e2ee_cutoff_guard();

CREATE CONSTRAINT TRIGGER e2ee_committed_counters AFTER INSERT OR UPDATE ON public.e2ee_room
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.e2ee_counter_guard();

CREATE CONSTRAINT TRIGGER e2ee_committed_counters AFTER INSERT OR UPDATE ON public.e2ee_participant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.e2ee_counter_guard();

CREATE CONSTRAINT TRIGGER e2ee_committed_counters AFTER INSERT OR UPDATE ON public.e2ee_envelope
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.e2ee_counter_guard();

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)'::regprocedure
     AND p.proname='privacy_begin_erasure' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_0$
DECLARE org public.orgs_organisation%ROWTYPE; cutoff timestamptz; inventory jsonb; receivers jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL
 OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'validated erasure instruction authority refused' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write to this
 -- organisation has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_erasure_cutoff:'||p_org::text,0));
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
  SELECT coalesce(jsonb_agg('urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') ORDER BY i.id),'[]'::jsonb) INTO receivers FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org;
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
END $e2ee_expected_body_0$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=6 AND p.pronargdefaults=0
     AND p.prorettype='uuid'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid,'uuid'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'timestamptz'::regtype::oid,'uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id','p_org','p_instruction','p_digest','p_not_before','p_actor']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=3s','statement_timeout=15s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration anchor changed' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_begin_erasure(p_id uuid,p_org uuid,p_instruction text,p_digest text,p_not_before timestamptz,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE org public.orgs_organisation%ROWTYPE; cutoff timestamptz; inventory jsonb; receivers jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL
 OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'validated erasure instruction authority refused' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write to this
 -- organisation has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_erasure_cutoff:'||p_org::text,0));
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
 inventory:=inventory||public.e2ee_organisation_inventory(p_org);
 IF to_regclass('public.extensions_installation') IS NOT NULL THEN
  SELECT coalesce(jsonb_agg('urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') ORDER BY i.id),'[]'::jsonb) INTO receivers FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org;
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

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_begin_account_erasure(uuid,uuid,text,text,timestamptz,uuid)'::regprocedure
     AND p.proname='privacy_begin_account_erasure' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_1$
DECLARE person uuid; cutoff timestamptz; inventory jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE='23514'; END IF;
 SELECT user_id INTO person FROM public.identity_identity WHERE id=p_identity AND organisation_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write for this person
 -- has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:'||person::text,0));
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
END $e2ee_expected_body_1$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=6 AND p.pronargdefaults=0
     AND p.prorettype='uuid'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid,'uuid'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'timestamptz'::regtype::oid,'uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id','p_identity','p_instruction','p_digest','p_not_before','p_actor']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=3s','statement_timeout=15s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration anchor changed' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_begin_account_erasure(p_id uuid,p_identity uuid,p_instruction text,p_digest text,p_not_before timestamptz,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE person uuid; cutoff timestamptz; inventory jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE='23514'; END IF;
 SELECT user_id INTO person FROM public.identity_identity WHERE id=p_identity AND organisation_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write for this person
 -- has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:'||person::text,0));
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
 inventory:=inventory||public.e2ee_account_inventory(person);
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

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_purge_core(uuid)'::regprocedure
     AND p.proname='privacy_purge_core' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_2$
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group_member WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group WHERE organisation_id=org;
  DELETE FROM public.ee_scim_deprovision WHERE organisation_id=org;
  DELETE FROM public.ee_scim_user WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_scim_token WHERE organisation_id=org;
  DELETE FROM public.ee_saml_pending_request WHERE organisation_id=org;
  DELETE FROM public.ee_saml_replay_assertion WHERE organisation_id=org;
  DELETE FROM public.ee_saml_principal WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  DELETE FROM public.ee_saml_idp WHERE organisation_id=org;
  DELETE FROM public.ee_audit_signing_key WHERE organisation_id=org;
  UPDATE public.ee_audit_ledger SET actor_label='erased',source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp()) WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
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
END $e2ee_expected_body_2$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=1 AND p.pronargdefaults=0
     AND p.prorettype='jsonb'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public','lock_timeout=3s','statement_timeout=30s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration anchor changed' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_purge_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group_member WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group WHERE organisation_id=org;
  DELETE FROM public.ee_scim_deprovision WHERE organisation_id=org;
  DELETE FROM public.ee_scim_user WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_scim_token WHERE organisation_id=org;
  DELETE FROM public.ee_saml_pending_request WHERE organisation_id=org;
  DELETE FROM public.ee_saml_replay_assertion WHERE organisation_id=org;
  DELETE FROM public.ee_saml_principal WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  DELETE FROM public.ee_saml_idp WHERE organisation_id=org;
  DELETE FROM public.ee_audit_signing_key WHERE organisation_id=org;
  UPDATE public.ee_audit_ledger SET actor_label='erased',source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp()) WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
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
 purged_counts:=purged_counts||public.e2ee_purge_organisation(org);
 UPDATE public.orgs_privacyerasure SET status='core_purged',core_purged_at=clock_timestamp(),counts=purged_counts,updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,org,'privacy.core_erased',
 'urn:kodera:organisation:'||org,'standard',jsonb_build_object('request_id',p_id,'counts',purged_counts));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='erase' AND source_table='orgs_organisation' AND source_id=org;
 RETURN purged_counts;
END $$;

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_purge_account_core(uuid)'::regprocedure
     AND p.proname='privacy_purge_account_core' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_3$
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE user_id=person
   OR scim_user_id IN (
    SELECT su.id FROM public.ee_scim_user su
    WHERE su.user_id=person OR EXISTS(
     SELECT 1 FROM public.identity_identity i
     WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
    )
   );
  DELETE FROM public.ee_scim_group_member WHERE scim_user_id IN (
   SELECT su.id FROM public.ee_scim_user su
   WHERE su.user_id=person OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   )
  );
  DELETE FROM public.ee_scim_deprovision WHERE user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=ee_scim_deprovision.organisation_id AND lower(i.email)=lower(ee_scim_deprovision.user_name)
   );
  DELETE FROM public.ee_scim_user su WHERE su.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_saml_principal sp WHERE sp.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=sp.organisation_id AND lower(i.email)=sp.email_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  UPDATE public.ee_audit_ledger SET actor_label='erased:'||person::text,source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp())
  WHERE user_id=person AND pii_scrubbed_at IS NULL;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
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
END $e2ee_expected_body_3$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=1 AND p.pronargdefaults=0
     AND p.prorettype='jsonb'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=3s','statement_timeout=20s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration anchor changed' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_purge_account_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE user_id=person
   OR scim_user_id IN (
    SELECT su.id FROM public.ee_scim_user su
    WHERE su.user_id=person OR EXISTS(
     SELECT 1 FROM public.identity_identity i
     WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
    )
   );
  DELETE FROM public.ee_scim_group_member WHERE scim_user_id IN (
   SELECT su.id FROM public.ee_scim_user su
   WHERE su.user_id=person OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   )
  );
  DELETE FROM public.ee_scim_deprovision WHERE user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=ee_scim_deprovision.organisation_id AND lower(i.email)=lower(ee_scim_deprovision.user_name)
   );
  DELETE FROM public.ee_scim_user su WHERE su.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_saml_principal sp WHERE sp.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=sp.organisation_id AND lower(i.email)=sp.email_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  UPDATE public.ee_audit_ledger SET actor_label='erased:'||person::text,source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp())
  WHERE user_id=person AND pii_scrubbed_at IS NULL;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
 UPDATE public.support_supportticket SET subject='',body='',reply_to_email=NULL,contact_email=NULL,
 content_erased_at=coalesce(content_erased_at,clock_timestamp()) WHERE created_by_id IN (SELECT id FROM public.identity_identity WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('own_support_contacts',n);
 UPDATE public.orgs_invitation SET email='erased+'||id||'@invalid.test',display_name=NULL,token_digest=decode('','hex'),token_sealed=decode('','hex')
 WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE user_id=person;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
 UPDATE public.identity_user SET email='erased:'||id,display_name=NULL,enabled=false,updated_at=clock_timestamp() WHERE id=person;
 purged_counts:=purged_counts||public.e2ee_purge_account(person);
 UPDATE public.orgs_accounterasure SET status='core_purged',core_purged_at=clock_timestamp(),counts=purged_counts,updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,NULL,'privacy.account_core_erased',
 'urn:kodera:person:'||person,'standard',jsonb_build_object('request_id',p_id,'counts',purged_counts));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=person;
 RETURN purged_counts;
END $$;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$
BEGIN
 LOCK TABLE public.orgs_privacyerasure, public.orgs_accounterasure,
  public.orgs_erasurereceipt, public.orgs_accounterasurereceipt,
  public.e2ee_device, public.e2ee_room, public.e2ee_participant,
  public.e2ee_keypackage, public.e2ee_envelope IN SHARE MODE;
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE inventory ? 'e2ee'
  OR counts ?| ARRAY['e2ee_devices','e2ee_rooms','e2ee_packages','e2ee_participants','e2ee_envelopes'])
 OR EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE inventory ? 'e2ee'
  OR counts ?| ARRAY['e2ee_devices_revoked','e2ee_directory_packages_discarded'])
 OR EXISTS(SELECT 1 FROM public.e2ee_device)
 OR EXISTS(SELECT 1 FROM public.e2ee_room)
 OR EXISTS(SELECT 1 FROM public.e2ee_participant)
 OR EXISTS(SELECT 1 FROM public.e2ee_keypackage)
 OR EXISTS(SELECT 1 FROM public.e2ee_envelope)
 THEN RAISE EXCEPTION 'cannot downgrade confidential relay privacy with retained resources or admitted erasure obligations' USING ERRCODE='23514'; END IF;
END $$;

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_purge_account_core(uuid)'::regprocedure
     AND p.proname='privacy_purge_account_core' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_3$
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE user_id=person
   OR scim_user_id IN (
    SELECT su.id FROM public.ee_scim_user su
    WHERE su.user_id=person OR EXISTS(
     SELECT 1 FROM public.identity_identity i
     WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
    )
   );
  DELETE FROM public.ee_scim_group_member WHERE scim_user_id IN (
   SELECT su.id FROM public.ee_scim_user su
   WHERE su.user_id=person OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   )
  );
  DELETE FROM public.ee_scim_deprovision WHERE user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=ee_scim_deprovision.organisation_id AND lower(i.email)=lower(ee_scim_deprovision.user_name)
   );
  DELETE FROM public.ee_scim_user su WHERE su.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_saml_principal sp WHERE sp.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=sp.organisation_id AND lower(i.email)=sp.email_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  UPDATE public.ee_audit_ledger SET actor_label='erased:'||person::text,source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp())
  WHERE user_id=person AND pii_scrubbed_at IS NULL;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
 UPDATE public.support_supportticket SET subject='',body='',reply_to_email=NULL,contact_email=NULL,
 content_erased_at=coalesce(content_erased_at,clock_timestamp()) WHERE created_by_id IN (SELECT id FROM public.identity_identity WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('own_support_contacts',n);
 UPDATE public.orgs_invitation SET email='erased+'||id||'@invalid.test',display_name=NULL,token_digest=decode('','hex'),token_sealed=decode('','hex')
 WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE user_id=person;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
 UPDATE public.identity_user SET email='erased:'||id,display_name=NULL,enabled=false,updated_at=clock_timestamp() WHERE id=person;
 purged_counts:=purged_counts||public.e2ee_purge_account(person);
 UPDATE public.orgs_accounterasure SET status='core_purged',core_purged_at=clock_timestamp(),counts=purged_counts,updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,NULL,'privacy.account_core_erased',
 'urn:kodera:person:'||person,'standard',jsonb_build_object('request_id',p_id,'counts',purged_counts));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=person;
 RETURN purged_counts;
END $e2ee_expected_body_3$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=1 AND p.pronargdefaults=0
     AND p.prorettype='jsonb'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=3s','statement_timeout=20s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration cannot be restored' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_purge_account_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE user_id=person
   OR scim_user_id IN (
    SELECT su.id FROM public.ee_scim_user su
    WHERE su.user_id=person OR EXISTS(
     SELECT 1 FROM public.identity_identity i
     WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
    )
   );
  DELETE FROM public.ee_scim_group_member WHERE scim_user_id IN (
   SELECT su.id FROM public.ee_scim_user su
   WHERE su.user_id=person OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   )
  );
  DELETE FROM public.ee_scim_deprovision WHERE user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=ee_scim_deprovision.organisation_id AND lower(i.email)=lower(ee_scim_deprovision.user_name)
   );
  DELETE FROM public.ee_scim_user su WHERE su.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=su.organisation_id AND lower(i.email)=su.user_name_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_saml_principal sp WHERE sp.user_id=person
   OR EXISTS(
    SELECT 1 FROM public.identity_identity i
    WHERE i.user_id=person AND i.organisation_id=sp.organisation_id AND lower(i.email)=sp.email_lower
   );
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  UPDATE public.ee_audit_ledger SET actor_label='erased:'||person::text,source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp())
  WHERE user_id=person AND pii_scrubbed_at IS NULL;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
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

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_purge_core(uuid)'::regprocedure
     AND p.proname='privacy_purge_core' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_2$
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group_member WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group WHERE organisation_id=org;
  DELETE FROM public.ee_scim_deprovision WHERE organisation_id=org;
  DELETE FROM public.ee_scim_user WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_scim_token WHERE organisation_id=org;
  DELETE FROM public.ee_saml_pending_request WHERE organisation_id=org;
  DELETE FROM public.ee_saml_replay_assertion WHERE organisation_id=org;
  DELETE FROM public.ee_saml_principal WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  DELETE FROM public.ee_saml_idp WHERE organisation_id=org;
  DELETE FROM public.ee_audit_signing_key WHERE organisation_id=org;
  UPDATE public.ee_audit_ledger SET actor_label='erased',source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp()) WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
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
 purged_counts:=purged_counts||public.e2ee_purge_organisation(org);
 UPDATE public.orgs_privacyerasure SET status='core_purged',core_purged_at=clock_timestamp(),counts=purged_counts,updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,org,'privacy.core_erased',
 'urn:kodera:organisation:'||org,'standard',jsonb_build_object('request_id',p_id,'counts',purged_counts));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='erase' AND source_table='orgs_organisation' AND source_id=org;
 RETURN purged_counts;
END $e2ee_expected_body_2$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=1 AND p.pronargdefaults=0
     AND p.prorettype='jsonb'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public','lock_timeout=3s','statement_timeout=30s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration cannot be restored' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_purge_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  DELETE FROM public.ee_scim_session WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group_member WHERE organisation_id=org;
  DELETE FROM public.ee_scim_group WHERE organisation_id=org;
  DELETE FROM public.ee_scim_deprovision WHERE organisation_id=org;
  DELETE FROM public.ee_scim_user WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_scim_users',n);
  DELETE FROM public.ee_scim_token WHERE organisation_id=org;
  DELETE FROM public.ee_saml_pending_request WHERE organisation_id=org;
  DELETE FROM public.ee_saml_replay_assertion WHERE organisation_id=org;
  DELETE FROM public.ee_saml_principal WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_saml_principals',n);
  DELETE FROM public.ee_saml_idp WHERE organisation_id=org;
  DELETE FROM public.ee_audit_signing_key WHERE organisation_id=org;
  UPDATE public.ee_audit_ledger SET actor_label='erased',source_ip='',metadata_json='{}',
  pii_scrubbed_at=COALESCE(pii_scrubbed_at,clock_timestamp()) WHERE organisation_id=org;
  GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('ee_audit_scrubbed',n);
 END IF;
 UPDATE public.identity_identity SET email='erased:'||id,enabled=false,updated_at=clock_timestamp() WHERE organisation_id=org;
 GET DIAGNOSTICS n=ROW_COUNT; purged_counts:=purged_counts||jsonb_build_object('identity_contacts',n);
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

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_begin_account_erasure(uuid,uuid,text,text,timestamptz,uuid)'::regprocedure
     AND p.proname='privacy_begin_account_erasure' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_1$
DECLARE person uuid; cutoff timestamptz; inventory jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE='23514'; END IF;
 SELECT user_id INTO person FROM public.identity_identity WHERE id=p_identity AND organisation_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write for this person
 -- has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:'||person::text,0));
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
 inventory:=inventory||public.e2ee_account_inventory(person);
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
END $e2ee_expected_body_1$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=6 AND p.pronargdefaults=0
     AND p.prorettype='uuid'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid,'uuid'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'timestamptz'::regtype::oid,'uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id','p_identity','p_instruction','p_digest','p_not_before','p_actor']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=3s','statement_timeout=15s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration cannot be restored' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_begin_account_erasure(p_id uuid,p_identity uuid,p_instruction text,p_digest text,p_not_before timestamptz,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE person uuid; cutoff timestamptz; inventory jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'account erasure admission refused' USING ERRCODE='23514'; END IF;
 SELECT user_id INTO person FROM public.identity_identity WHERE id=p_identity AND organisation_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'account erasure identity absent' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write for this person
 -- has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:'||person::text,0));
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

DO $e2ee_body_guard$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
   WHERE p.oid='public.privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)'::regprocedure
     AND p.proname='privacy_begin_erasure' AND p.pronamespace='public'::regnamespace
     AND p.prosrc IS NOT DISTINCT FROM $e2ee_expected_body_0$
DECLARE org public.orgs_organisation%ROWTYPE; cutoff timestamptz; inventory jsonb; receivers jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL
 OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'validated erasure instruction authority refused' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write to this
 -- organisation has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_erasure_cutoff:'||p_org::text,0));
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
 inventory:=inventory||public.e2ee_organisation_inventory(p_org);
 IF to_regclass('public.extensions_installation') IS NOT NULL THEN
  SELECT coalesce(jsonb_agg('urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') ORDER BY i.id),'[]'::jsonb) INTO receivers FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org;
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
END $e2ee_expected_body_0$
     AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.prosupport::oid=0
     AND p.prokind='f' AND p.prosecdef IS TRUE AND p.proleakproof IS FALSE
     AND p.proisstrict IS FALSE AND p.proretset IS FALSE
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.pronargs=6 AND p.pronargdefaults=0
     AND p.prorettype='uuid'::regtype
     AND p.proargtypes::text=pg_catalog.array_to_string(ARRAY['uuid'::regtype::oid,'uuid'::regtype::oid,'text'::regtype::oid,'text'::regtype::oid,'timestamptz'::regtype::oid,'uuid'::regtype::oid],' ')
     AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
     AND p.proargnames IS NOT DISTINCT FROM ARRAY['p_id','p_org','p_instruction','p_digest','p_not_before','p_actor']::text[]
     AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
     AND p.probin IS NULL AND p.prosqlbody IS NULL
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=3s','statement_timeout=15s']::text[]
 ) THEN RAISE EXCEPTION 'privacy protocol integration cannot be restored' USING ERRCODE='23514'; END IF;
END $e2ee_body_guard$;

CREATE OR REPLACE FUNCTION public.privacy_begin_erasure(p_id uuid,p_org uuid,p_instruction text,p_digest text,p_not_before timestamptz,p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE org public.orgs_organisation%ROWTYPE; cutoff timestamptz; inventory jsonb; receivers jsonb;
BEGIN
 IF p_id IS NULL OR p_instruction IS NULL OR p_instruction !~ '^[A-Z]{2,8}-[0-9]{1,8}$'
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_not_before IS NULL
 OR NOT public.retention_current_operator(p_actor)
 THEN RAISE EXCEPTION 'validated erasure instruction authority refused' USING ERRCODE='23514'; END IF;
 -- The exclusive side of the writers' fence: every in-flight pre-cutoff write to this
 -- organisation has committed before the inventory below is taken.
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy_erasure_cutoff:'||p_org::text,0));
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
  SELECT coalesce(jsonb_agg('urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') ORDER BY i.id),'[]'::jsonb) INTO receivers FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org;
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
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DROP TRIGGER e2ee_committed_counters ON public.e2ee_room;
DROP TRIGGER e2ee_committed_counters ON public.e2ee_participant;
DROP TRIGGER e2ee_committed_counters ON public.e2ee_envelope;
DROP TRIGGER c_e2ee_cutoff ON public.e2ee_device; DROP TRIGGER b_e2ee_scope ON public.e2ee_device;
DROP TRIGGER a_resource_binding ON public.e2ee_device;
DROP TRIGGER c_e2ee_cutoff ON public.e2ee_room; DROP TRIGGER b_e2ee_scope ON public.e2ee_room;
DROP TRIGGER a_resource_binding ON public.e2ee_room;
DROP TRIGGER c_e2ee_cutoff ON public.e2ee_participant; DROP TRIGGER b_e2ee_scope ON public.e2ee_participant;
DROP TRIGGER a_resource_binding ON public.e2ee_participant;
DROP TRIGGER c_e2ee_cutoff ON public.e2ee_keypackage; DROP TRIGGER b_e2ee_scope ON public.e2ee_keypackage;
DROP TRIGGER a_resource_binding ON public.e2ee_keypackage;
DROP TRIGGER c_e2ee_cutoff ON public.e2ee_envelope; DROP TRIGGER b_e2ee_scope ON public.e2ee_envelope;

DROP FUNCTION public.e2ee_purge_account(uuid);
DROP FUNCTION public.e2ee_purge_organisation(uuid);
DROP FUNCTION public.e2ee_account_inventory(uuid);
DROP FUNCTION public.e2ee_organisation_inventory(uuid);
DROP FUNCTION public.e2ee_cutoff_guard();
DROP FUNCTION public.e2ee_counter_guard();
DROP FUNCTION public.e2ee_scope_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("e2ee", "0001_initial"),
        ("orgs", "0033_proximity_erasure_inventory"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

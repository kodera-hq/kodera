"""Complete only with all scoped external-store proofs, then erase resumable subject history."""

from django.db import migrations

FORWARD = r'''

SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
-- A frozen organisation can no longer queue a post-cutoff engine convergence command.
CREATE FUNCTION privacy_engine_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE org uuid; extension_pending boolean;
BEGIN
 IF TG_TABLE_NAME='engine_intents_command' THEN
  SELECT organisation_id INTO org FROM public.engine_intents_credential WHERE id=NEW.credential_id;
 ELSE org:=(to_jsonb(NEW)->>'organisation_id')::uuid; END IF;
 PERFORM 1 FROM public.orgs_organisation WHERE id=org FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org)
 AND NOT public.privacy_erasure_context(org) THEN RAISE EXCEPTION 'durable erasure cutoff refuses engine write' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_engine_erasure_cutoff BEFORE INSERT OR UPDATE ON engine_intents_command FOR EACH ROW EXECUTE FUNCTION privacy_engine_cutoff_guard();
CREATE TRIGGER aa_engine_erasure_cutoff BEFORE INSERT OR UPDATE ON engine_intents_credential FOR EACH ROW EXECUTE FUNCTION privacy_engine_cutoff_guard();
CREATE TRIGGER aa_engine_erasure_cutoff BEFORE INSERT OR UPDATE ON engine_intents_member_set FOR EACH ROW EXECUTE FUNCTION privacy_engine_cutoff_guard();
CREATE TRIGGER aa_engine_erasure_cutoff BEFORE INSERT OR UPDATE ON engine_intents_channel_set FOR EACH ROW EXECUTE FUNCTION privacy_engine_cutoff_guard();
CREATE TRIGGER aa_engine_erasure_cutoff BEFORE INSERT OR UPDATE ON engine_intents_known_subject FOR EACH ROW EXECUTE FUNCTION privacy_engine_cutoff_guard();
CREATE OR REPLACE FUNCTION public.customer_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_ARGV[0]='identity' AND TG_OP='UPDATE' THEN
 IF public.privacy_erasure_context(OLD.organisation_id)
 AND NEW.subject='erased:'||OLD.id AND NOT NEW.enabled
 AND (to_jsonb(NEW)-ARRAY['subject','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','updated_at'])
 THEN RETURN NEW; END IF;
 END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT=TG_ARGV[0] || '_id_immutable', MESSAGE='Stored identifier is immutable';
  END IF;
  IF TG_ARGV[0]='identity' THEN
    IF (NEW.user_id,NEW.organisation_id,NEW.issuer,NEW.realm,NEW.subject) IS DISTINCT FROM (OLD.user_id,OLD.organisation_id,OLD.issuer,OLD.realm,OLD.subject) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='identity_immutable_binding', MESSAGE='Principal binding is immutable';
    END IF;
  ELSIF TG_ARGV[0]='membership' THEN
    IF (NEW.user_id,NEW.organisation_id) IS DISTINCT FROM (OLD.user_id,OLD.organisation_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='membership_immutable_binding', MESSAGE='Membership binding is immutable';
    END IF;
  ELSIF TG_ARGV[0]='organisation' THEN
    IF NEW.issuer IS DISTINCT FROM OLD.issuer THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='organisation_immutable_binding', MESSAGE='Organisation issuer is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION customer_immutable() SECURITY DEFINER; ALTER FUNCTION customer_immutable() SET search_path=pg_catalog,public,pg_temp;

CREATE FUNCTION privacy_complete_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET lock_timeout='3s' SET statement_timeout='30s' AS $$
DECLARE request public.orgs_privacyerasure%ROWTYPE; org uuid; extension_pending boolean;
BEGIN
 SELECT * INTO request FROM public.orgs_privacyerasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.core_purged_at IS NULL THEN RAISE EXCEPTION 'Core erasure incomplete' USING ERRCODE='23514'; END IF;
 IF request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory)
 THEN RAISE EXCEPTION 'erasure inventory digest mismatch' USING ERRCODE='23514'; END IF;
 IF request.status='complete' THEN RETURN true; END IF;
 IF jsonb_typeof(request.inventory->'required_domains') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'erasure required domains malformed' USING ERRCODE='23514'; END IF;
 IF NOT (request.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports"]'::jsonb
 OR jsonb_array_length(request.inventory->'required_domains') NOT IN (4,5)
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(request.inventory->'required_domains'))
 <>jsonb_array_length(request.inventory->'required_domains')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') d
 WHERE d.value NOT IN ('matrix','objects','identity_provider','private_exports','external_extension_receivers'))
 OR (to_regclass('public.extensions_installation') IS NOT NULL AND NOT (request.inventory->'required_domains') @> '["external_extension_receivers"]'::jsonb)
 THEN RAISE EXCEPTION 'erasure required domains incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') domain
 WHERE NOT EXISTS(SELECT 1 FROM public.orgs_erasurereceipt receipt WHERE receipt.erasure_id=p_id
 AND receipt.domain=domain.value AND receipt.cutoff_at=request.cutoff_at AND receipt.verified_at>=request.cutoff_at))
 THEN RETURN false; END IF;
 IF to_regclass('public.extensions_installation') IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=request.organisation_reference) OR EXISTS(SELECT 1 FROM public.extensions_importbatch b JOIN public.workspaces_workspace w ON w.id=b.workspace_id WHERE w.organisation_id=request.organisation_reference) OR EXISTS(SELECT 1 FROM public.extensions_digestconsent c JOIN public.orgs_membership m ON m.id=c.membership_id WHERE m.organisation_id=request.organisation_reference) INTO extension_pending;
  IF extension_pending THEN RETURN false; END IF;
 END IF;
 org:=request.organisation_reference;
 PERFORM 1 FROM public.orgs_organisation WHERE id=org AND state='closed' AND deleted_at=request.cutoff_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure durable cutoff binding missing' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'erase','orgs_organisation',org,'{}');
 -- Remote accounts/rooms and every object/export have authenticated absence proofs now;
 -- source identifiers are no longer needed to resume erasure. Keep only aggregate audits.
 DELETE FROM public.engine_intents_command WHERE credential_id IN (SELECT id FROM public.engine_intents_credential WHERE organisation_id=org);
 DELETE FROM public.engine_intents_channel_set WHERE organisation_id=org;
 DELETE FROM public.engine_intents_member_set WHERE organisation_id=org;
 DELETE FROM public.engine_intents_known_subject WHERE organisation_id=org;
 DELETE FROM public.engine_intents_credential WHERE organisation_id=org;
 UPDATE public.outbox_realmaccount SET realm_user_id=NULL WHERE delivery_id IN (SELECT id FROM public.outbox_outboxdelivery WHERE organisation_id=org);
 UPDATE public.identity_identity SET subject='erased:'||id,updated_at=clock_timestamp() WHERE organisation_id=org;
 UPDATE public.orgs_privacyerasure SET status='complete',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,org,'privacy.erasure_completed',
 'urn:kodera:organisation:'||org,'standard',jsonb_build_object('request_id',p_id,'domains',jsonb_array_length(request.inventory->'required_domains')));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='erase' AND source_table='orgs_organisation' AND source_id=org;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION privacy_complete_erasure(uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION privacy_engine_cutoff_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_immutable() FROM PUBLIC;

'''

class Migration(migrations.Migration):
    dependencies = [("orgs", "0025_durable_core_erasure"), ("engine_intents", "0012_workspace_moderation")]
    operations = [migrations.RunSQL(FORWARD)]

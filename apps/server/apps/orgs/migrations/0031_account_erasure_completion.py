"""Scoped account absence receipts gate final subject pseudonymization; no adapters are implied."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.privacy_account_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'account erasure receipt immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=NEW.erasure_id;
 IF NOT FOUND OR NOT public.privacy_account_context(request.user_reference)
 OR NEW.user_reference IS DISTINCT FROM request.user_reference OR NEW.cutoff_at IS DISTINCT FROM request.cutoff_at
 OR NEW.inventory_sha256 IS DISTINCT FROM request.inventory_sha256
 OR NOT (request.inventory->'required_domains') ? NEW.domain
 OR NEW.verified_at<greatest(request.cutoff_at,request.purge_not_before) OR NEW.verified_at>clock_timestamp()
 OR NEW.evidence_sha256 !~ '^[0-9a-f]{64}$' OR NEW.adapter_revision !~ '^[A-Za-z0-9._-]{1,80}$'
 THEN RAISE EXCEPTION 'account erasure receipt scope or authority refused' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.privacy_account_receipt_guard() FROM PUBLIC;
CREATE TRIGGER account_receipt_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.orgs_accounterasurereceipt
 FOR EACH ROW EXECUTE FUNCTION public.privacy_account_receipt_guard();

CREATE FUNCTION public.privacy_record_account_absence(p_id uuid,p_user uuid,p_cutoff timestamptz,p_inventory text,
 p_domain text,p_evidence text,p_revision text,p_verified timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='10s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE;
BEGIN
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.user_reference IS DISTINCT FROM p_user OR request.cutoff_at IS DISTINCT FROM p_cutoff
 OR request.inventory_sha256 IS DISTINCT FROM p_inventory
 OR request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory)
 THEN RAISE EXCEPTION 'account erasure receipt request binding refused' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',p_user,'{}');
 INSERT INTO public.orgs_accounterasurereceipt(id,created_at,updated_at,erasure_id,user_reference,cutoff_at,inventory_sha256,
 domain,evidence_sha256,adapter_revision,verified_at)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),clock_timestamp(),p_id,p_user,p_cutoff,p_inventory,p_domain,p_evidence,p_revision,p_verified);
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=p_user;
END $$;
REVOKE ALL ON FUNCTION public.privacy_record_account_absence(uuid,uuid,timestamptz,text,text,text,text,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.customer_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_ARGV[0]='identity' AND TG_OP='UPDATE' THEN
 IF public.privacy_account_context(OLD.user_id)
 AND NEW.subject='erased:'||OLD.id AND NOT NEW.enabled
 AND (to_jsonb(NEW)-ARRAY['subject','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','updated_at'])
 THEN RETURN NEW; END IF;
 END IF;

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

CREATE FUNCTION public.privacy_erased_subject_rebind_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Cutoff and admissions take the conflicting ordered organisation lock before marking erasure.
 PERFORM 1 FROM public.orgs_organisation WHERE id=NEW.organisation_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.engine_intents_known_subject WHERE organisation_id=NEW.organisation_id
 AND subject=NEW.subject AND erased_at IS NOT NULL)
 THEN RAISE EXCEPTION 'erased realm subject cannot be rebound' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.privacy_erased_subject_rebind_guard() FROM PUBLIC;
CREATE TRIGGER ac_erased_subject_rebind BEFORE INSERT ON public.identity_identity
 FOR EACH ROW EXECUTE FUNCTION public.privacy_erased_subject_rebind_guard();

CREATE FUNCTION public.privacy_complete_account_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE;
BEGIN
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.core_purged_at IS NULL OR request.protocol_emitted_at IS NULL
 OR request.purge_not_before>clock_timestamp() THEN RAISE EXCEPTION 'account Core erasure protocol incomplete or not due' USING ERRCODE='23514'; END IF;
 IF request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory)
 THEN RAISE EXCEPTION 'account erasure inventory digest mismatch' USING ERRCODE='23514'; END IF;
 IF request.status='complete' THEN RETURN true; END IF;
 IF jsonb_typeof(request.inventory->'required_domains') IS DISTINCT FROM 'array'
 OR NOT (request.inventory->'required_domains') @> '["matrix_accounts","identity_provider_accounts","private_exports","account_message_outbox"]'::jsonb
 OR jsonb_array_length(request.inventory->'required_domains') NOT IN (4,5)
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(request.inventory->'required_domains'))<>jsonb_array_length(request.inventory->'required_domains')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') d WHERE d.value NOT IN
 ('matrix_accounts','identity_provider_accounts','private_exports','account_message_outbox','account_extension_subjects'))
 OR (to_regclass('public.extensions_installation') IS NOT NULL AND NOT (request.inventory->'required_domains') ? 'account_extension_subjects')
 THEN RAISE EXCEPTION 'account required domains malformed or incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') d WHERE NOT EXISTS(
 SELECT 1 FROM public.orgs_accounterasurereceipt r WHERE r.erasure_id=p_id AND r.domain=d.value
 AND r.user_reference=request.user_reference AND r.inventory_sha256=request.inventory_sha256 AND r.cutoff_at=request.cutoff_at
 AND r.verified_at>=greatest(request.cutoff_at,request.purge_not_before))) THEN RETURN false; END IF;
 PERFORM 1 FROM public.identity_user WHERE id=request.user_reference AND NOT enabled AND email='erased:'||id FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.identity_identity WHERE user_id=request.user_reference AND (enabled OR email<>'erased:'||id))
 OR EXISTS(SELECT 1 FROM public.orgs_membership WHERE user_id=request.user_reference AND state<>'removed' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'account cutoff or personal contacts still present' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',request.user_reference,'{}');
 -- ADR-0016 keeps only the realm denylist and controller-owned history while the organisation lives.
 -- Actual external receipts permit replacing login subjects here; no unrelated realm history is removed.
 UPDATE public.identity_identity SET subject='erased:'||id,updated_at=clock_timestamp() WHERE user_id=request.user_reference;
 UPDATE public.orgs_accounterasure SET status='complete',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_auditevent(id,occurred_at,actor_type,actor_id,actor_label,organisation_id,action,target_urn,retention_class,metadata)
 VALUES(public.retention_new_uuid7(),clock_timestamp(),'system',p_id,'urn:kodera:erasure:'||p_id,NULL,'privacy.account_erasure_completed',
 'urn:kodera:person:'||request.user_reference,'standard',jsonb_build_object('request_id',p_id,'domains',jsonb_array_length(request.inventory->'required_domains')));
 DELETE FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current()
 AND purpose='account' AND source_table='identity_user' AND source_id=request.user_reference;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.privacy_complete_account_erasure(uuid) FROM PUBLIC;
"""


REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DROP FUNCTION public.privacy_complete_account_erasure(uuid);
DROP TRIGGER ac_erased_subject_rebind ON public.identity_identity;
DROP FUNCTION public.privacy_erased_subject_rebind_guard();

-- Back to the organisation-erasure-only exemption of orgs 0026, with that migration's
-- SECURITY DEFINER and search_path.
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
REVOKE ALL ON FUNCTION public.customer_immutable() FROM PUBLIC;

DROP FUNCTION public.privacy_record_account_absence(uuid,uuid,timestamptz,text,text,text,text,timestamptz);
DROP TRIGGER account_receipt_immutable ON public.orgs_accounterasurereceipt;
DROP FUNCTION public.privacy_account_receipt_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0030_erasure_resource_binding")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

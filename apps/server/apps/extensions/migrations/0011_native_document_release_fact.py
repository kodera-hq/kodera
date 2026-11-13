"""Keep independent remote holds from blocking native erasure without actual import FKs."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION extension_erasure_step(p_erasure uuid,p_org uuid,p_cutoff timestamptz,p_inventory_sha256 text,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
SET lock_timeout='2s' SET statement_timeout='5s' AS $$
DECLARE journal record; admission record; marked timestamptz; target_workspace uuid; current_receivers jsonb;
 computed_digest text; operation_now timestamptz:=statement_timestamp(); item record; n integer;
 payload_count integer:=0; metadata_count integer:=0; budget integer; receipts_complete boolean;
 payloads_complete boolean; metadata_complete boolean; native_documents_released boolean; step_counts jsonb:='{}'; table_name text;
BEGIN
 IF p_erasure IS NULL OR p_org IS NULL OR p_cutoff IS NULL OR p_inventory_sha256 IS NULL
 OR p_inventory_sha256 !~ '^[a-f0-9]{64}$' OR p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
  RAISE EXCEPTION 'extension erasure arguments refused' USING ERRCODE='23514'; END IF;
 -- Late-bound Core integration: installing the extension app alone never manufactures an
 -- erasure intent, substitutes a caller inventory or grants a broad worker credential.
 IF to_regclass('public.orgs_privacyerasure') IS NULL OR to_regclass('public.orgs_erasurereceipt') IS NULL
 OR to_regprocedure('public.retention_inventory_digest(jsonb)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.orgs_privacyerasure')
   AND attname='inventory_sha256' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'extension erasure authoritative Core intent unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO journal FROM public.orgs_privacyerasure WHERE id=p_erasure FOR UPDATE;
 IF journal.id IS NULL OR journal.organisation_reference IS DISTINCT FROM p_org
 OR journal.cutoff_at IS DISTINCT FROM p_cutoff OR journal.inventory_sha256 IS DISTINCT FROM p_inventory_sha256
 OR journal.status NOT IN ('cutoff','core_purged','complete') OR journal.purge_not_before IS NULL
 OR journal.purge_not_before<journal.cutoff_at OR journal.cutoff_at>operation_now THEN
  RAISE EXCEPTION 'extension erasure Core scope binding refused' USING ERRCODE='23514'; END IF;
 SELECT public.retention_inventory_digest(journal.inventory) INTO computed_digest;
 IF computed_digest IS DISTINCT FROM p_inventory_sha256
 OR jsonb_typeof(journal.inventory->'required_domains') IS DISTINCT FROM 'array'
 OR jsonb_typeof(journal.inventory->'extension_receivers') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'extension erasure Core inventory digest or shape refused' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(journal.inventory->'required_domains')<>5
 OR NOT (journal.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports","external_extension_receivers"]'::jsonb
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(journal.inventory->'required_domains'))<>5
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(journal.inventory->'extension_receivers'))
   <>jsonb_array_length(journal.inventory->'extension_receivers') THEN
  RAISE EXCEPTION 'extension erasure required provider inventory refused' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.orgs_organisation WHERE id=p_org AND state='closed' AND deleted_at=p_cutoff FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'extension erasure durable Core cutoff missing' USING ERRCODE='23514'; END IF;
 SELECT id INTO target_workspace FROM public.workspaces_workspace WHERE organisation_id=p_org FOR UPDATE;
 SELECT coalesce(jsonb_agg('urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||
    encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') ORDER BY i.id),'[]'::jsonb)
 INTO current_receivers FROM public.extensions_installation i WHERE i.workspace_id=target_workspace;
 SELECT * INTO admission FROM public.extensions_erasureadmission WHERE organisation_id=p_org FOR UPDATE;
 IF admission.erasure_id IS NULL THEN
  IF current_receivers IS DISTINCT FROM journal.inventory->'extension_receivers' THEN
   RAISE EXCEPTION 'extension erasure initial receiver inventory mismatch' USING ERRCODE='23514'; END IF;
  INSERT INTO public.extensions_erasureadmission(erasure_id,organisation_id,cutoff_at,inventory_sha256)
   VALUES(p_erasure,p_org,p_cutoff,p_inventory_sha256);
 ELSE
  IF admission.erasure_id IS DISTINCT FROM p_erasure OR admission.cutoff_at IS DISTINCT FROM p_cutoff
   OR admission.inventory_sha256 IS DISTINCT FROM p_inventory_sha256
   OR NOT current_receivers <@ (journal.inventory->'extension_receivers') THEN
   RAISE EXCEPTION 'extension erasure admitted progress binding refused' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT cutoff_at INTO marked FROM public.extensions_workspacecutoff WHERE organisation_id=p_org;
 IF marked IS NULL THEN INSERT INTO public.extensions_workspacecutoff(organisation_id,cutoff_at) VALUES(p_org,p_cutoff);
 ELSIF marked IS DISTINCT FROM p_cutoff THEN
  RAISE EXCEPTION 'extension erasure local cutoff replay refused' USING ERRCODE='23514'; END IF;
 UPDATE public.extensions_installation SET revoked_at=p_cutoff,version=gen_random_uuid(),updated_at=clock_timestamp()
 WHERE workspace_id=target_workspace AND revoked_at IS NULL;
 UPDATE public.extensions_digestconsent c SET enabled=false,revoked_at=p_cutoff,version=gen_random_uuid(),updated_at=clock_timestamp()
 FROM public.orgs_membership m WHERE c.membership_id=m.id AND m.organisation_id=p_org AND c.enabled;
 UPDATE public.extensions_digestjob j SET state='obsolete',updated_at=clock_timestamp()
 FROM public.extensions_digestconsent c,public.orgs_membership m WHERE j.consent_id=c.id AND c.membership_id=m.id
 AND m.organisation_id=p_org AND j.state<>'obsolete';
 -- A validated recovery window is authoritative. Earlier ordinary TTLs remain earlier;
 -- erasure never renews a TTL or shortens it to the cutoff ahead of that recovery deadline.
 UPDATE public.extensions_delivery d SET expires_at=journal.purge_not_before,updated_at=clock_timestamp()
 FROM public.extensions_installation i WHERE d.installation_id=i.id AND i.workspace_id=target_workspace
 AND d.purged_at IS NULL AND d.expires_at>journal.purge_not_before;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace) INTO native_documents_released;
 IF journal.purge_not_before>operation_now THEN
  RETURN jsonb_build_object('held',true,'payloads_purged',0,'metadata_purged',0,
   'payloads_complete',false,'metadata_complete',false,'native_documents_released',native_documents_released,'external_receipts_complete',false);
 END IF;
 FOR item IN SELECT d.id FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id
  WHERE i.workspace_id=target_workspace AND d.purged_at IS NULL AND d.expires_at<=operation_now
  ORDER BY d.expires_at,d.id LIMIT p_limit FOR UPDATE OF d SKIP LOCKED LOOP
  UPDATE public.extensions_deliveryattempt SET outcome='uncertain',updated_at=clock_timestamp()
   WHERE delivery_id=item.id AND outcome='started';
  UPDATE public.extensions_delivery SET event=''::bytea,purged_at=clock_timestamp(),
   state=CASE WHEN state IN ('delivered','dead_letter','obsolete') THEN state ELSE 'obsolete' END,
   lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=item.id;
  payload_count:=payload_count+1;
 END LOOP;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id
  WHERE i.workspace_id=target_workspace AND (d.purged_at IS NULL OR octet_length(d.event)<>0)) INTO payloads_complete;
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(journal.inventory->'required_domains') domain
  WHERE NOT EXISTS(SELECT 1 FROM public.orgs_erasurereceipt r
   WHERE r.erasure_id=p_erasure AND r.domain=domain.value AND r.cutoff_at=p_cutoff
   AND r.verified_at>=p_cutoff AND r.verified_at<=operation_now)) INTO receipts_complete;
 IF NOT payloads_complete OR NOT receipts_complete THEN
  RETURN jsonb_build_object('held',false,'payloads_purged',payload_count,'metadata_purged',0,
   'payloads_complete',payloads_complete,'metadata_complete',false,'native_documents_released',native_documents_released,'external_receipts_complete',receipts_complete);
 END IF;
 budget:=p_limit-payload_count;
 -- Every branch names its relation and original workspace join literally, and all
 -- branches consume the same global row budget in dependency order.
 FOREACH table_name IN ARRAY ARRAY['extensions_deliverydecision','extensions_deliveryattempt','extensions_delivery','extensions_importedobject','extensions_importbatch','extensions_digestjob','extensions_digestconsent','extensions_installation'] LOOP
  IF budget>0 THEN
   CASE table_name
   WHEN 'extensions_deliverydecision' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_deliverydecision x JOIN public.extensions_delivery d ON d.id=x.delivery_id JOIN public.extensions_installation i ON i.id=d.installation_id WHERE i.workspace_id=target_workspace
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_deliverydecision t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_deliveryattempt' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_deliveryattempt x JOIN public.extensions_delivery d ON d.id=x.delivery_id JOIN public.extensions_installation i ON i.id=d.installation_id WHERE i.workspace_id=target_workspace AND NOT EXISTS(SELECT 1 FROM public.extensions_deliverydecision c WHERE c.attempt_id=x.id)
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_deliveryattempt t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_delivery' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_delivery x JOIN public.extensions_installation i ON i.id=x.installation_id WHERE i.workspace_id=target_workspace AND NOT EXISTS(SELECT 1 FROM public.extensions_deliveryattempt a WHERE a.delivery_id=x.id)
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_delivery t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_importedobject' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_importedobject x WHERE x.workspace_id=target_workspace
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_importedobject t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_importbatch' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_importbatch x WHERE x.workspace_id=target_workspace AND NOT EXISTS(SELECT 1 FROM public.extensions_importedobject o WHERE o.batch_id=x.id)
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_importbatch t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_digestjob' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_digestjob x JOIN public.extensions_digestconsent c ON c.id=x.consent_id JOIN public.orgs_membership m ON m.id=c.membership_id JOIN public.workspaces_workspace w ON w.organisation_id=m.organisation_id WHERE w.id=target_workspace
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_digestjob t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_digestconsent' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_digestconsent x JOIN public.orgs_membership m ON m.id=x.membership_id JOIN public.workspaces_workspace w ON w.organisation_id=m.organisation_id WHERE w.id=target_workspace AND NOT EXISTS(SELECT 1 FROM public.extensions_digestjob j WHERE j.consent_id=x.id)
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_digestconsent t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_installation' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_installation x WHERE x.workspace_id=target_workspace AND NOT EXISTS(SELECT 1 FROM public.extensions_delivery d WHERE d.installation_id=x.id)
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_installation t USING doomed WHERE t.id=doomed.id;
   ELSE RAISE EXCEPTION 'extension erasure metadata relation refused' USING ERRCODE='23514';
   END CASE;
   GET DIAGNOSTICS n=ROW_COUNT;
   budget:=budget-n; metadata_count:=metadata_count+n;
   step_counts:=step_counts||jsonb_build_object(table_name,n);
  END IF;
 END LOOP;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_installation WHERE workspace_id=target_workspace)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_importbatch WHERE workspace_id=target_workspace)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_digestconsent c JOIN public.orgs_membership m ON m.id=c.membership_id
   JOIN public.workspaces_workspace w ON w.organisation_id=m.organisation_id WHERE w.id=target_workspace)
 INTO metadata_complete;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace) INTO native_documents_released;
 RETURN jsonb_build_object('held',false,'payloads_purged',payload_count,'metadata_purged',metadata_count,
  'payloads_complete',payloads_complete,'metadata_complete',metadata_complete,'native_documents_released',native_documents_released,
  'external_receipts_complete',receipts_complete,'counts',step_counts);
END $$;
REVOKE ALL ON FUNCTION extension_erasure_step(uuid,uuid,timestamptz,text,integer) FROM PUBLIC;
"""


class Migration(migrations.Migration):
    dependencies = [("extensions", "0010_restricted_erasure_step")]
    operations = [migrations.RunSQL(FORWARD)]

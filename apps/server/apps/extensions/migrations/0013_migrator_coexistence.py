"""Extend ImportedObject for Matrix channel replay and add sealed live coexistence bridges."""

import django.db.models.deletion
from django.db import migrations, models

import apps.extensions.expiry
import core.db.ids

FORWARD_SQL = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.extensions_coexistence_erasure_inventory() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE receivers jsonb;
BEGIN
 IF TG_TABLE_NAME<>'orgs_privacyerasure' OR NOT public.privacy_erasure_context(NEW.organisation_reference) THEN
  RAISE EXCEPTION 'coexistence receiver inventory requires workspace erasure authority' USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(NEW.inventory->'required_domains') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'coexistence erasure required domains malformed' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(jsonb_agg(urn ORDER BY urn),'[]'::jsonb) INTO receivers
 FROM (
  SELECT 'urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') AS urn
  FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=NEW.organisation_reference
  UNION ALL
  SELECT 'urn:kodera:coexistence-bridge:'||b.id||':endpoint-sha256:'||encode(sha256(convert_to(b.outbound_endpoint,'UTF8')),'hex') AS urn
  FROM public.extensions_coexistencebridge b JOIN public.workspaces_workspace w ON w.id=b.workspace_id WHERE w.organisation_id=NEW.organisation_reference
 ) r;
 IF NOT (NEW.inventory->'required_domains') ? 'external_extension_receivers' THEN
  NEW.inventory:=jsonb_set(NEW.inventory,'{required_domains}',
   (NEW.inventory->'required_domains')||jsonb_build_array('external_extension_receivers'));
 END IF;
 NEW.inventory:=jsonb_set(NEW.inventory,'{extension_receivers}',receivers);
 NEW.inventory_sha256:=public.retention_inventory_digest(NEW.inventory);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.extensions_coexistence_erasure_inventory() FROM PUBLIC;

DO $$
BEGIN
 IF to_regclass('public.orgs_privacyerasure') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS ab_extensions_coexistence_inventory ON public.orgs_privacyerasure;
  CREATE TRIGGER ab_extensions_coexistence_inventory BEFORE INSERT ON public.orgs_privacyerasure
   FOR EACH ROW EXECUTE FUNCTION public.extensions_coexistence_erasure_inventory();
 END IF;
END $$;

CREATE OR REPLACE FUNCTION extension_erasure_allowed(p_org uuid) RETURNS boolean LANGUAGE sql SET search_path=pg_catalog,public AS $$
 SELECT p_org IS NOT NULL AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.extensions_installation'::regclass))
 AND EXISTS(SELECT 1 FROM public.extensions_workspacecutoff WHERE organisation_id=p_org)
 AND NOT EXISTS(SELECT 1 FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org AND i.revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org AND (d.purged_at IS NULL OR octet_length(d.event)<>0))
 AND NOT EXISTS(SELECT 1 FROM public.extensions_coexistencebridge b JOIN public.workspaces_workspace w ON w.id=b.workspace_id WHERE w.organisation_id=p_org AND (b.revoked_at IS NULL OR octet_length(b.sealed_signing_secret)<>0))
 AND NOT EXISTS(SELECT 1 FROM public.extensions_coexistencereplayguard g JOIN public.extensions_coexistencebridge b ON b.id=g.bridge_id JOIN public.workspaces_workspace w ON w.id=b.workspace_id WHERE w.organisation_id=p_org AND g.sanitized_payload IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.extensions_importedobject o JOIN public.workspaces_workspace w ON w.id=o.workspace_id WHERE w.organisation_id=p_org AND o.replay_payload IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION extension_erasure_allowed(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION extension_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid; workspace uuid; old_json jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  old_json:=to_jsonb(OLD);
  IF TG_TABLE_NAME IN ('extensions_installation','extensions_importbatch','extensions_importedobject','extensions_coexistencebridge') THEN
   SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=(old_json->>'workspace_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_coexistencereplayguard' THEN
   IF (old_json->>'expires_at')::timestamptz<=statement_timestamp() THEN
    RETURN OLD;
   END IF;
   SELECT w.organisation_id INTO org FROM public.extensions_coexistencebridge b JOIN public.workspaces_workspace w ON w.id=b.workspace_id WHERE b.id=(old_json->>'bridge_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_delivery' THEN
   SELECT w.organisation_id INTO org FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE i.id=(old_json->>'installation_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_deliveryattempt' THEN
   SELECT w.organisation_id INTO org FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE d.id=(old_json->>'delivery_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_digestconsent' THEN
   SELECT organisation_id INTO org FROM public.orgs_membership WHERE id=(old_json->>'membership_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_digestjob' THEN
   SELECT m.organisation_id INTO org FROM public.extensions_digestconsent c JOIN public.orgs_membership m ON m.id=c.membership_id WHERE c.id=(old_json->>'consent_id')::uuid;
  END IF;
  IF NOT public.extension_erasure_allowed(org) THEN
   RAISE EXCEPTION 'Extension evidence is retained before authorized cutoff and payload purge' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;

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
  IF NEW.event_key !~ '^[a-f0-9]{64}$' OR NEW.expires_at>NEW.created_at+interval '7 days' THEN
   RAISE EXCEPTION 'Extension payload expiry or key digest invalid' USING ERRCODE='23514'; END IF;
  IF NEW.purged_at IS NULL THEN
   IF octet_length(NEW.event)=0 OR octet_length(NEW.event)>131072 OR encode(sha256(NEW.event),'hex')<>NEW.event_sha256 THEN
    RAISE EXCEPTION 'Extension event digest invalid' USING ERRCODE='23514'; END IF;
  ELSE
   IF octet_length(NEW.event)<>0 OR NEW.purged_at<NEW.expires_at OR NEW.expires_at>statement_timestamp()
    OR NEW.state NOT IN ('delivered','dead_letter','obsolete') OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'Extension payload purge fence invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.installation_id<>OLD.installation_id OR NEW.installation_version<>OLD.installation_version
    OR NEW.event_key<>OLD.event_key OR NEW.event_sha256<>OLD.event_sha256 OR NEW.created_at<>OLD.created_at OR NEW.expires_at>OLD.expires_at
    OR (OLD.purged_at IS NOT NULL AND (to_jsonb(OLD)-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'updated_at'))
    OR (NEW.event<>OLD.event AND NOT (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND octet_length(NEW.event)=0 AND OLD.expires_at<=statement_timestamp()))
    OR (OLD.state IN ('delivered','dead_letter','obsolete') AND
       (to_jsonb(OLD)-ARRAY['expires_at','event','purged_at','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['expires_at','event','purged_at','updated_at']))) THEN
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
  IF NEW.source_sha256 !~ '^[a-f0-9]{64}$'
   OR (NEW.document_id IS NULL AND NEW.channel_id IS NULL)
   OR (NEW.document_id IS NOT NULL AND NEW.channel_id IS NOT NULL)
   OR (NEW.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.docs_document WHERE id=NEW.document_id AND workspace_id=NEW.workspace_id))
   OR (NEW.channel_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workspaces_channel WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id AND NOT is_confidential))
   OR (NEW.matrix_txn_id IS NOT NULL AND NEW.matrix_txn_id !~ '^kodera-imp-[0-9a-f]{32}$')
   OR (NEW.replay_payload IS NOT NULL AND octet_length(NEW.replay_payload::text)>262144)
   OR NOT EXISTS(SELECT 1 FROM public.extensions_importbatch WHERE id=NEW.batch_id AND workspace_id=NEW.workspace_id AND source=NEW.source)
   OR (NEW.collection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.docs_collection WHERE id=NEW.collection_id AND workspace_id=NEW.workspace_id)) THEN
   RAISE EXCEPTION 'Extension imported object workspace binding invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF (to_jsonb(OLD)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'updated_at') THEN
    RETURN NEW;
   END IF;
   IF OLD.document_id IS NOT NULL
    OR OLD.replay_state<>'queued_matrix'
    OR NEW.replay_state NOT IN ('replayed','obsolete')
    OR (to_jsonb(OLD)-ARRAY['replay_state','matrix_event_id','replay_payload','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['replay_state','matrix_event_id','replay_payload','updated_at']) THEN
    RAISE EXCEPTION 'Extension imported source evidence immutable' USING ERRCODE='23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='extensions_coexistencebridge' THEN
  SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=NEW.workspace_id;
  IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM public.extensions_workspacecutoff WHERE organisation_id=org)
   OR (to_regclass('public.orgs_privacyerasure') IS NOT NULL AND EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org))) THEN
   RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.orgs_membership WHERE id=NEW.creator_id AND organisation_id=org)
   OR NOT EXISTS(SELECT 1 FROM public.workspaces_channel WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id AND NOT is_confidential)
   OR (NEW.revoked_at IS NULL AND octet_length(NEW.sealed_signing_secret)<29)
   OR (NEW.revoked_at IS NOT NULL AND octet_length(NEW.sealed_signing_secret)<>0) THEN
   RAISE EXCEPTION 'Extension coexistence bridge binding invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.workspace_id<>OLD.workspace_id OR NEW.channel_id<>OLD.channel_id OR NEW.creator_id<>OLD.creator_id
    OR NEW.source<>OLD.source OR NEW.external_workspace_id<>OLD.external_workspace_id
    OR NEW.external_channel_id<>OLD.external_channel_id OR NEW.outbound_endpoint<>OLD.outbound_endpoint THEN
    RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE='23514'; END IF;
   IF (OLD.revoked_at IS NOT NULL AND (to_jsonb(OLD)-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'updated_at'))
    OR (NEW.revoked_at IS NULL AND NEW.sealed_signing_secret<>OLD.sealed_signing_secret) THEN
    RAISE EXCEPTION 'Extension coexistence bridge binding immutable' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='extensions_coexistencereplayguard' THEN
  SELECT w.organisation_id INTO org FROM public.extensions_coexistencebridge b JOIN public.workspaces_workspace w ON w.id=b.workspace_id WHERE b.id=NEW.bridge_id;
  IF org IS NULL THEN
   RAISE EXCEPTION 'Extension coexistence replay scope invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (EXISTS(SELECT 1 FROM public.extensions_workspacecutoff WHERE organisation_id=org)
   OR (to_regclass('public.orgs_privacyerasure') IS NOT NULL AND EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org))) THEN
   RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514'; END IF;
  IF NEW.expires_at>NEW.created_at+interval '7 days'
   OR (NEW.sanitized_payload IS NOT NULL AND octet_length(NEW.sanitized_payload::text)>262144) THEN
   RAISE EXCEPTION 'Extension coexistence replay TTL invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.bridge_id<>OLD.bridge_id OR NEW.external_event_id<>OLD.external_event_id
   OR NEW.event_sha256<>OLD.event_sha256 OR NEW.direction<>OLD.direction OR NEW.created_at<>OLD.created_at
   OR NEW.expires_at>OLD.expires_at
   OR (OLD.state IN ('delivered','obsolete') AND
       (to_jsonb(OLD)-ARRAY['expires_at','sanitized_payload','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['expires_at','sanitized_payload','updated_at']))) THEN
   RAISE EXCEPTION 'resource authority binding immutable' USING ERRCODE='23514'; END IF;
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

CREATE TRIGGER extension_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON extensions_coexistencebridge FOR EACH ROW EXECUTE FUNCTION extension_scope_guard();
CREATE TRIGGER extension_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON extensions_coexistencereplayguard FOR EACH ROW EXECUTE FUNCTION extension_scope_guard();

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
 IF (
  (NOT (journal.inventory ? 'proximity_inventory_version')
   AND jsonb_array_length(journal.inventory->'required_domains')=5
   AND (journal.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports","external_extension_receivers"]'::jsonb)
  OR (journal.inventory->'proximity_inventory_version'='1'::jsonb
   AND jsonb_array_length(journal.inventory->'required_domains')=6
   AND (journal.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports","external_extension_receivers","proximity_ephemeral"]'::jsonb)
 ) IS NOT TRUE
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(journal.inventory->'required_domains'))
   <>jsonb_array_length(journal.inventory->'required_domains')
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(journal.inventory->'extension_receivers'))
   <>jsonb_array_length(journal.inventory->'extension_receivers') THEN
  RAISE EXCEPTION 'extension erasure required provider inventory refused' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.orgs_organisation WHERE id=p_org AND state='closed' AND deleted_at=p_cutoff FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'extension erasure durable Core cutoff missing' USING ERRCODE='23514'; END IF;
 SELECT id INTO target_workspace FROM public.workspaces_workspace WHERE organisation_id=p_org FOR UPDATE;
 SELECT coalesce(jsonb_agg(urn ORDER BY urn),'[]'::jsonb)
 INTO current_receivers
 FROM (
  SELECT 'urn:kodera:extension-installation:'||i.id||':endpoint-sha256:'||
    encode(sha256(convert_to(i.endpoint,'UTF8')),'hex') AS urn
  FROM public.extensions_installation i WHERE i.workspace_id=target_workspace
  UNION ALL
  SELECT 'urn:kodera:coexistence-bridge:'||b.id||':endpoint-sha256:'||
    encode(sha256(convert_to(b.outbound_endpoint,'UTF8')),'hex') AS urn
  FROM public.extensions_coexistencebridge b WHERE b.workspace_id=target_workspace
 ) r;
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
 UPDATE public.extensions_coexistencebridge SET revoked_at=p_cutoff,sealed_signing_secret=''::bytea,updated_at=clock_timestamp()
 WHERE workspace_id=target_workspace AND revoked_at IS NULL;
 UPDATE public.extensions_coexistencereplayguard g
 SET expires_at=LEAST(g.expires_at,journal.purge_not_before),
     state=CASE WHEN g.state='delivered' THEN 'delivered' ELSE 'obsolete' END,
     lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
 FROM public.extensions_coexistencebridge b
 WHERE g.bridge_id=b.id AND b.workspace_id=target_workspace
   AND (g.expires_at>journal.purge_not_before OR g.state NOT IN ('delivered','obsolete') OR g.lease_id IS NOT NULL);
 UPDATE public.extensions_digestconsent c SET enabled=false,revoked_at=p_cutoff,version=gen_random_uuid(),updated_at=clock_timestamp()
 FROM public.orgs_membership m WHERE c.membership_id=m.id AND m.organisation_id=p_org AND c.enabled;
 UPDATE public.extensions_digestjob j SET state='obsolete',updated_at=clock_timestamp()
 FROM public.extensions_digestconsent c,public.orgs_membership m WHERE j.consent_id=c.id AND c.membership_id=m.id
 AND m.organisation_id=p_org AND j.state<>'obsolete';
 UPDATE public.extensions_delivery d SET expires_at=journal.purge_not_before,updated_at=clock_timestamp()
 FROM public.extensions_installation i WHERE d.installation_id=i.id AND i.workspace_id=target_workspace
 AND d.purged_at IS NULL AND d.expires_at>journal.purge_not_before;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace AND document_id IS NOT NULL) INTO native_documents_released;
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
 IF payload_count<p_limit THEN
  FOR item IN SELECT g.id FROM public.extensions_coexistencereplayguard g JOIN public.extensions_coexistencebridge b ON b.id=g.bridge_id
   WHERE b.workspace_id=target_workspace AND g.sanitized_payload IS NOT NULL
   ORDER BY g.expires_at,g.id LIMIT (p_limit-payload_count) FOR UPDATE OF g SKIP LOCKED LOOP
   UPDATE public.extensions_coexistencereplayguard SET sanitized_payload=NULL,
    state=CASE WHEN state='delivered' THEN 'delivered' ELSE 'obsolete' END,
    lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=item.id;
   payload_count:=payload_count+1;
  END LOOP;
 END IF;
 IF payload_count<p_limit THEN
  FOR item IN SELECT o.id FROM public.extensions_importedobject o
   WHERE o.workspace_id=target_workspace AND o.replay_payload IS NOT NULL
   ORDER BY o.created_at,o.id LIMIT (p_limit-payload_count) FOR UPDATE OF o SKIP LOCKED LOOP
   UPDATE public.extensions_importedobject SET replay_payload=NULL,
    replay_state=CASE WHEN replay_state='queued_matrix' THEN 'obsolete' ELSE replay_state END,
    updated_at=clock_timestamp() WHERE id=item.id;
   payload_count:=payload_count+1;
  END LOOP;
 END IF;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id
  WHERE i.workspace_id=target_workspace AND (d.purged_at IS NULL OR octet_length(d.event)<>0))
  AND NOT EXISTS(SELECT 1 FROM public.extensions_coexistencebridge WHERE workspace_id=target_workspace AND octet_length(sealed_signing_secret)<>0)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_coexistencereplayguard g JOIN public.extensions_coexistencebridge b ON b.id=g.bridge_id
   WHERE b.workspace_id=target_workspace AND g.sanitized_payload IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace AND replay_payload IS NOT NULL)
 INTO payloads_complete;
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(journal.inventory->'required_domains') domain
  WHERE NOT EXISTS(SELECT 1 FROM public.orgs_erasurereceipt r
   WHERE r.erasure_id=p_erasure AND r.domain=domain.value AND r.cutoff_at=p_cutoff
   AND r.verified_at>=p_cutoff AND r.verified_at<=operation_now)) INTO receipts_complete;
 IF NOT payloads_complete OR NOT receipts_complete THEN
  RETURN jsonb_build_object('held',false,'payloads_purged',payload_count,'metadata_purged',0,
   'payloads_complete',payloads_complete,'metadata_complete',false,'native_documents_released',native_documents_released,'external_receipts_complete',receipts_complete);
 END IF;
 budget:=p_limit-payload_count;
 FOREACH table_name IN ARRAY ARRAY['extensions_deliverydecision','extensions_deliveryattempt','extensions_delivery','extensions_coexistencereplayguard','extensions_coexistencebridge','extensions_importedobject','extensions_importbatch','extensions_digestjob','extensions_digestconsent','extensions_installation'] LOOP
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
   WHEN 'extensions_coexistencereplayguard' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_coexistencereplayguard x JOIN public.extensions_coexistencebridge b ON b.id=x.bridge_id WHERE b.workspace_id=target_workspace
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_coexistencereplayguard t USING doomed WHERE t.id=doomed.id;
   WHEN 'extensions_coexistencebridge' THEN
    WITH doomed AS (SELECT x.id FROM public.extensions_coexistencebridge x WHERE x.workspace_id=target_workspace AND NOT EXISTS(SELECT 1 FROM public.extensions_coexistencereplayguard g WHERE g.bridge_id=x.id)
     ORDER BY x.id LIMIT budget FOR UPDATE OF x SKIP LOCKED)
    DELETE FROM public.extensions_coexistencebridge t USING doomed WHERE t.id=doomed.id;
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
  AND NOT EXISTS(SELECT 1 FROM public.extensions_coexistencebridge WHERE workspace_id=target_workspace)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_importbatch WHERE workspace_id=target_workspace)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace)
  AND NOT EXISTS(SELECT 1 FROM public.extensions_digestconsent c JOIN public.orgs_membership m ON m.id=c.membership_id
   JOIN public.workspaces_workspace w ON w.organisation_id=m.organisation_id WHERE w.id=target_workspace)
 INTO metadata_complete;
 SELECT NOT EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE workspace_id=target_workspace AND document_id IS NOT NULL) INTO native_documents_released;
 RETURN jsonb_build_object('held',false,'payloads_purged',payload_count,'metadata_purged',metadata_count,
  'payloads_complete',payloads_complete,'metadata_complete',metadata_complete,'native_documents_released',native_documents_released,
  'external_receipts_complete',receipts_complete,'counts',step_counts);
END $$;
REVOKE ALL ON FUNCTION extension_erasure_step(uuid,uuid,timestamptz,text,integer) FROM PUBLIC;
"""

REVERSE_SQL = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

DO $$
BEGIN
 LOCK TABLE public.extensions_coexistencebridge, public.extensions_coexistencereplayguard, public.extensions_importedobject IN SHARE MODE;
 IF EXISTS(SELECT 1 FROM public.extensions_coexistencebridge)
 OR EXISTS(SELECT 1 FROM public.extensions_coexistencereplayguard)
 OR EXISTS(SELECT 1 FROM public.extensions_importedobject WHERE document_id IS NULL OR channel_id IS NOT NULL OR matrix_txn_id IS NOT NULL OR matrix_event_id IS NOT NULL OR replay_state<>'complete' OR thread_parent_key IS NOT NULL OR replay_payload IS NOT NULL)
 OR (to_regclass('public.orgs_privacyerasure') IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.orgs_privacyerasure p, jsonb_array_elements_text(coalesce(p.inventory->'extension_receivers','[]'::jsonb)) e(val)
  WHERE e.val LIKE 'urn:kodera:coexistence-bridge:%'))
 THEN RAISE EXCEPTION 'cannot downgrade coexistence or channel replay migration with persisted records' USING ERRCODE='23514'; END IF;
END $$;

DO $$
BEGIN
 IF to_regclass('public.orgs_privacyerasure') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS ab_extensions_coexistence_inventory ON public.orgs_privacyerasure;
 END IF;
END $$;
DROP FUNCTION IF EXISTS public.extensions_coexistence_erasure_inventory();

DROP TRIGGER IF EXISTS extension_scope_guard ON extensions_coexistencereplayguard;
DROP TRIGGER IF EXISTS extension_scope_guard ON extensions_coexistencebridge;

CREATE OR REPLACE FUNCTION extension_erasure_allowed(p_org uuid) RETURNS boolean LANGUAGE sql SET search_path=pg_catalog,public AS $$
 SELECT p_org IS NOT NULL AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.extensions_installation'::regclass))
 AND EXISTS(SELECT 1 FROM public.extensions_workspacecutoff WHERE organisation_id=p_org)
 AND NOT EXISTS(SELECT 1 FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org AND i.revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE w.organisation_id=p_org AND (d.purged_at IS NULL OR octet_length(d.event)<>0));
$$;
REVOKE ALL ON FUNCTION extension_erasure_allowed(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION extension_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE org uuid; workspace uuid; old_json jsonb; new_json jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  old_json:=to_jsonb(OLD);
  IF TG_TABLE_NAME IN ('extensions_installation','extensions_importbatch','extensions_importedobject') THEN
   SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=(old_json->>'workspace_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_delivery' THEN
   SELECT w.organisation_id INTO org FROM public.extensions_installation i JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE i.id=(old_json->>'installation_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_deliveryattempt' THEN
   SELECT w.organisation_id INTO org FROM public.extensions_delivery d JOIN public.extensions_installation i ON i.id=d.installation_id JOIN public.workspaces_workspace w ON w.id=i.workspace_id WHERE d.id=(old_json->>'delivery_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_digestconsent' THEN
   SELECT organisation_id INTO org FROM public.orgs_membership WHERE id=(old_json->>'membership_id')::uuid;
  ELSIF TG_TABLE_NAME='extensions_digestjob' THEN
   SELECT m.organisation_id INTO org FROM public.extensions_digestconsent c JOIN public.orgs_membership m ON m.id=c.membership_id WHERE c.id=(old_json->>'consent_id')::uuid;
  END IF;
  IF NOT public.extension_erasure_allowed(org) THEN
   RAISE EXCEPTION 'Extension evidence is retained before authorized cutoff and payload purge' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;

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
  IF NEW.event_key !~ '^[a-f0-9]{64}$' OR NEW.expires_at>NEW.created_at+interval '7 days' THEN
   RAISE EXCEPTION 'Extension payload expiry or key digest invalid' USING ERRCODE='23514'; END IF;
  IF NEW.purged_at IS NULL THEN
   IF octet_length(NEW.event)=0 OR octet_length(NEW.event)>131072 OR encode(sha256(NEW.event),'hex')<>NEW.event_sha256 THEN
    RAISE EXCEPTION 'Extension event digest invalid' USING ERRCODE='23514'; END IF;
  ELSE
   IF octet_length(NEW.event)<>0 OR NEW.purged_at<NEW.expires_at OR NEW.expires_at>statement_timestamp()
    OR NEW.state NOT IN ('delivered','dead_letter','obsolete') OR NEW.lease_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'Extension payload purge fence invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.installation_id<>OLD.installation_id OR NEW.installation_version<>OLD.installation_version
    OR NEW.event_key<>OLD.event_key OR NEW.event_sha256<>OLD.event_sha256 OR NEW.created_at<>OLD.created_at OR NEW.expires_at>OLD.expires_at
    OR (OLD.purged_at IS NOT NULL AND (to_jsonb(OLD)-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'updated_at'))
    OR (NEW.event<>OLD.event AND NOT (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND octet_length(NEW.event)=0 AND OLD.expires_at<=statement_timestamp()))
    OR (OLD.state IN ('delivered','dead_letter','obsolete') AND
       (to_jsonb(OLD)-ARRAY['expires_at','event','purged_at','updated_at']) IS DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['expires_at','event','purged_at','updated_at']))) THEN
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
 IF (
  (NOT (journal.inventory ? 'proximity_inventory_version')
   AND jsonb_array_length(journal.inventory->'required_domains')=5
   AND (journal.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports","external_extension_receivers"]'::jsonb)
  OR (journal.inventory->'proximity_inventory_version'='1'::jsonb
   AND jsonb_array_length(journal.inventory->'required_domains')=6
   AND (journal.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports","external_extension_receivers","proximity_ephemeral"]'::jsonb)
 ) IS NOT TRUE
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(journal.inventory->'required_domains'))
   <>jsonb_array_length(journal.inventory->'required_domains')
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
    dependencies = [
        ("extensions", "0012_proximity_erasure_domains"),
        ("workspaces", "0015_confidential_channel_designation"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name="CoexistenceBridge",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("source", models.TextField()),
                ("external_workspace_id", models.TextField()),
                ("external_channel_id", models.TextField()),
                ("outbound_endpoint", models.TextField()),
                ("sealed_signing_secret", models.BinaryField()),
                ("revoked_at", models.DateTimeField(null=True)),
            ],
        ),
        migrations.CreateModel(
            name="CoexistenceReplayGuard",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=core.db.ids.new_uuid7,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("external_event_id", models.TextField()),
                ("event_sha256", models.TextField()),
                ("direction", models.TextField()),
                ("state", models.TextField(default="queued")),
                ("lease_id", models.UUIDField(null=True)),
                ("lease_expires_at", models.DateTimeField(null=True)),
                ("attempts", models.IntegerField(default=0)),
                ("matrix_txn_id", models.TextField(null=True)),
                ("matrix_event_id", models.TextField(null=True)),
                ("sanitized_payload", models.JSONField(null=True)),
                (
                    "expires_at",
                    models.DateTimeField(default=apps.extensions.expiry.delivery_expiry),
                ),
            ],
        ),
        migrations.AddField(
            model_name="importedobject",
            name="channel",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.RESTRICT, to="workspaces.channel"
            ),
        ),
        migrations.AddField(
            model_name="importedobject",
            name="matrix_event_id",
            field=models.TextField(null=True),
        ),
        migrations.AddField(
            model_name="importedobject",
            name="matrix_txn_id",
            field=models.TextField(null=True),
        ),
        migrations.AddField(
            model_name="importedobject",
            name="replay_payload",
            field=models.JSONField(null=True),
        ),
        migrations.AddField(
            model_name="importedobject",
            name="replay_state",
            field=models.TextField(default="complete"),
        ),
        migrations.AddField(
            model_name="importedobject",
            name="thread_parent_key",
            field=models.TextField(null=True),
        ),
        migrations.AlterField(
            model_name="importedobject",
            name="document",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.RESTRICT, to="docs.document"
            ),
        ),
        migrations.AddIndex(
            model_name="importedobject",
            index=models.Index(
                fields=["replay_state", "created_at"], name="extension_import_replay_idx"
            ),
        ),
        migrations.AddConstraint(
            model_name="importedobject",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(("channel__isnull", True), ("document__isnull", False)),
                    models.Q(("channel__isnull", False), ("document__isnull", True)),
                    _connector="OR",
                ),
                name="extension_import_object_target",
            ),
        ),
        migrations.AddConstraint(
            model_name="importedobject",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        ("channel__isnull", True),
                        ("document__isnull", False),
                        ("replay_payload__isnull", True),
                        ("replay_state", "complete"),
                    ),
                    models.Q(
                        ("channel__isnull", False),
                        ("document__isnull", True),
                        ("matrix_event_id__isnull", True),
                        ("matrix_txn_id__isnull", False),
                        ("replay_payload__isnull", False),
                        ("replay_state", "queued_matrix"),
                    ),
                    models.Q(
                        ("channel__isnull", False),
                        ("document__isnull", True),
                        ("matrix_event_id__isnull", False),
                        ("matrix_txn_id__isnull", False),
                        ("replay_payload__isnull", True),
                        ("replay_state", "replayed"),
                    ),
                    models.Q(
                        ("channel__isnull", False),
                        ("document__isnull", True),
                        ("replay_payload__isnull", True),
                        ("replay_state", "obsolete"),
                    ),
                    _connector="OR",
                ),
                name="extension_import_object_replay_state",
            ),
        ),
        migrations.AddField(
            model_name="coexistencebridge",
            name="channel",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT, to="workspaces.channel"
            ),
        ),
        migrations.AddField(
            model_name="coexistencebridge",
            name="creator",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT, to="orgs.membership"
            ),
        ),
        migrations.AddField(
            model_name="coexistencebridge",
            name="workspace",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT, to="workspaces.workspace"
            ),
        ),
        migrations.AddField(
            model_name="coexistencereplayguard",
            name="bridge",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.RESTRICT, to="extensions.coexistencebridge"
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencebridge",
            constraint=models.UniqueConstraint(
                condition=models.Q(("revoked_at__isnull", True)),
                fields=("workspace", "source", "external_workspace_id", "external_channel_id"),
                name="extension_coexistence_ext_pair_active_once",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencebridge",
            constraint=models.UniqueConstraint(
                condition=models.Q(("revoked_at__isnull", True)),
                fields=("workspace", "channel", "source"),
                name="extension_coexistence_channel_active_once",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencebridge",
            constraint=models.CheckConstraint(
                condition=models.Q(("source__in", ("slack", "discord"))),
                name="extension_coexistence_source",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencebridge",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("external_workspace_id__regex", "^[A-Za-z0-9_.-]{1,128}$"),
                    ("external_channel_id__regex", "^[A-Za-z0-9_.-]{1,128}$"),
                ),
                name="extension_coexistence_ext_ids",
            ),
        ),
        migrations.AddIndex(
            model_name="coexistencereplayguard",
            index=models.Index(fields=["expires_at"], name="extension_coexist_exp_idx"),
        ),
        migrations.AddIndex(
            model_name="coexistencereplayguard",
            index=models.Index(
                fields=["bridge", "direction", "event_sha256"], name="extension_coexist_hash_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="coexistencereplayguard",
            index=models.Index(
                fields=["direction", "state", "created_at"], name="extension_coexist_due_idx"
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencereplayguard",
            constraint=models.UniqueConstraint(
                fields=("bridge", "external_event_id"), name="extension_coexistence_event_once"
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencereplayguard",
            constraint=models.CheckConstraint(
                condition=models.Q(("direction__in", ("inbound", "outbound"))),
                name="extension_coexistence_direction",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencereplayguard",
            constraint=models.CheckConstraint(
                condition=models.Q(("event_sha256__regex", "^[a-f0-9]{64}$")),
                name="extension_coexistence_digest",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencereplayguard",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("state__in", ("queued", "in_flight", "delivered", "retryable_failed", "obsolete"))
                ),
                name="extension_coexistence_state",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencereplayguard",
            constraint=models.CheckConstraint(
                condition=models.Q(("attempts__gte", 0), ("attempts__lte", 8)),
                name="extension_coexistence_attempts",
            ),
        ),
        migrations.AddConstraint(
            model_name="coexistencereplayguard",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        ("lease_expires_at__isnull", False),
                        ("lease_id__isnull", False),
                        ("state", "in_flight"),
                    ),
                    models.Q(
                        models.Q(("state", "in_flight"), _negated=True),
                        ("lease_expires_at__isnull", True),
                        ("lease_id__isnull", True),
                    ),
                    _connector="OR",
                ),
                name="extension_coexistence_lease",
            ),
        ),
        migrations.RunSQL(FORWARD_SQL, reverse_sql=REVERSE_SQL),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

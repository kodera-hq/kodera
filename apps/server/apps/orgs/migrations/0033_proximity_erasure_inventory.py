"""Include the private ephemeral broker in every newly admitted erasure inventory.

Existing immutable journals are not rewritten or retroactively certified. New inventory
version1 always requires the broker domain; absence remains held without a configured
qualified adapter. Only resource UUIDs, domain names and aggregate evidence persist.
"""

from django.db import migrations, models

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.proximity_erasure_inventory() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='orgs_privacyerasure' THEN
  IF NOT public.privacy_erasure_context(NEW.organisation_reference) THEN
   RAISE EXCEPTION 'proximity inventory requires workspace erasure authority' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='orgs_accounterasure' THEN
  IF NOT public.privacy_account_context(NEW.user_reference) THEN
   RAISE EXCEPTION 'proximity inventory requires account erasure authority' USING ERRCODE='23514';
  END IF;
 ELSE RAISE EXCEPTION 'unknown proximity erasure scope' USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(NEW.inventory->'required_domains') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'proximity erasure required domains malformed' USING ERRCODE='23514';
 END IF;
 IF NOT (NEW.inventory->'required_domains') ? 'proximity_ephemeral' THEN
  NEW.inventory:=jsonb_set(NEW.inventory,'{required_domains}',
   (NEW.inventory->'required_domains')||jsonb_build_array('proximity_ephemeral'));
 END IF;
 NEW.inventory:=NEW.inventory||jsonb_build_object('proximity_inventory_version',1);
 IF TG_TABLE_NAME='orgs_privacyerasure' THEN
  NEW.inventory:=NEW.inventory||jsonb_build_object('proximity_workspaces',
   coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.workspaces_workspace
    WHERE organisation_id=NEW.organisation_reference),'[]'::jsonb));
 END IF;
 NEW.inventory_sha256:=public.retention_inventory_digest(NEW.inventory);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.proximity_erasure_inventory() FROM PUBLIC;
-- Alphabetical order runs before the existing immutable journal guards; those still
-- verify worker authority, digest, initial state and every later immutable field.
CREATE TRIGGER aa_proximity_inventory BEFORE INSERT ON public.orgs_privacyerasure
 FOR EACH ROW EXECUTE FUNCTION public.proximity_erasure_inventory();
CREATE TRIGGER aa_proximity_inventory BEFORE INSERT ON public.orgs_accounterasure
 FOR EACH ROW EXECUTE FUNCTION public.proximity_erasure_inventory();

CREATE OR REPLACE FUNCTION privacy_complete_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET lock_timeout='3s' SET statement_timeout='30s' AS $$
DECLARE request public.orgs_privacyerasure%ROWTYPE; org uuid; extension_pending boolean; ee_pending boolean;
BEGIN
 SELECT * INTO request FROM public.orgs_privacyerasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.core_purged_at IS NULL THEN RAISE EXCEPTION 'Core erasure incomplete' USING ERRCODE='23514'; END IF;
 IF request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory)
 THEN RAISE EXCEPTION 'erasure inventory digest mismatch' USING ERRCODE='23514'; END IF;
 IF request.status='complete' THEN RETURN true; END IF;
 IF jsonb_typeof(request.inventory->'required_domains') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'erasure required domains malformed' USING ERRCODE='23514'; END IF;
 IF NOT (request.inventory->'required_domains') @> '["matrix","objects","identity_provider","private_exports"]'::jsonb
 OR (
  (NOT (request.inventory ? 'proximity_inventory_version')
   AND jsonb_array_length(request.inventory->'required_domains') IN (4,5)
   AND NOT ((request.inventory->'required_domains') ? 'proximity_ephemeral'))
  OR (request.inventory->'proximity_inventory_version'='1'::jsonb
   AND jsonb_array_length(request.inventory->'required_domains')=6
   AND (request.inventory->'required_domains') ? 'proximity_ephemeral')
 ) IS NOT TRUE
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(request.inventory->'required_domains'))
 <>jsonb_array_length(request.inventory->'required_domains')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') d
 WHERE d.value NOT IN ('matrix','objects','identity_provider','private_exports','external_extension_receivers','proximity_ephemeral'))
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.ee_saml_pending_request WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_saml_replay_assertion WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_saml_principal WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_saml_idp WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_session WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_group_member WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_group WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_deprovision WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_user WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_token WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_audit_signing_key WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_audit_ledger WHERE organisation_id=request.organisation_reference AND pii_scrubbed_at IS NULL)
   INTO ee_pending;
  IF ee_pending THEN RETURN false; END IF;
 END IF;
 org:=request.organisation_reference;
 PERFORM 1 FROM public.orgs_organisation WHERE id=org AND state='closed' AND deleted_at=request.cutoff_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure durable cutoff binding missing' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'erase','orgs_organisation',org,'{}');
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

CREATE OR REPLACE FUNCTION public.privacy_complete_account_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE; ee_pending boolean;
BEGIN
 SELECT * INTO request FROM public.orgs_accounterasure WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR request.core_purged_at IS NULL OR request.protocol_emitted_at IS NULL
 OR request.purge_not_before>clock_timestamp() THEN RAISE EXCEPTION 'account Core erasure protocol incomplete or not due' USING ERRCODE='23514'; END IF;
 IF request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory)
 THEN RAISE EXCEPTION 'account erasure inventory digest mismatch' USING ERRCODE='23514'; END IF;
 IF request.status='complete' THEN RETURN true; END IF;
 IF jsonb_typeof(request.inventory->'required_domains') IS DISTINCT FROM 'array'
 OR NOT (request.inventory->'required_domains') @> '["matrix_accounts","identity_provider_accounts","private_exports","account_message_outbox"]'::jsonb
 OR (
  (NOT (request.inventory ? 'proximity_inventory_version')
   AND jsonb_array_length(request.inventory->'required_domains') IN (4,5)
   AND NOT ((request.inventory->'required_domains') ? 'proximity_ephemeral'))
  OR (request.inventory->'proximity_inventory_version'='1'::jsonb
   AND jsonb_array_length(request.inventory->'required_domains')=6
   AND (request.inventory->'required_domains') ? 'proximity_ephemeral')
 ) IS NOT TRUE
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(request.inventory->'required_domains'))<>jsonb_array_length(request.inventory->'required_domains')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') d WHERE d.value NOT IN
 ('matrix_accounts','identity_provider_accounts','private_exports','account_message_outbox','account_extension_subjects','proximity_ephemeral'))
 OR (to_regclass('public.extensions_installation') IS NOT NULL AND NOT (request.inventory->'required_domains') ? 'account_extension_subjects')
 THEN RAISE EXCEPTION 'account required domains malformed or incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(request.inventory->'required_domains') d WHERE NOT EXISTS(
 SELECT 1 FROM public.orgs_accounterasurereceipt r WHERE r.erasure_id=p_id AND r.domain=d.value
 AND r.user_reference=request.user_reference AND r.inventory_sha256=request.inventory_sha256 AND r.cutoff_at=request.cutoff_at
 AND r.verified_at>=greatest(request.cutoff_at,request.purge_not_before))) THEN RETURN false; END IF;
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.ee_saml_principal WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_session WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_deprovision WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_user WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_audit_ledger WHERE user_id=request.user_reference AND pii_scrubbed_at IS NULL)
   INTO ee_pending;
  IF ee_pending THEN RETURN false; END IF;
 END IF;
 PERFORM 1 FROM public.identity_user WHERE id=request.user_reference AND NOT enabled AND email='erased:'||id FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.identity_identity WHERE user_id=request.user_reference AND (enabled OR email<>'erased:'||id))
 OR EXISTS(SELECT 1 FROM public.orgs_membership WHERE user_id=request.user_reference AND state<>'removed' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'account cutoff or personal contacts still present' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',request.user_reference,'{}');
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

DO $$
BEGIN
 LOCK TABLE public.orgs_privacyerasure, public.orgs_accounterasure, public.orgs_erasurereceipt, public.orgs_accounterasurereceipt IN SHARE MODE;
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE (inventory->'required_domains') ? 'proximity_ephemeral' OR inventory ? 'proximity_inventory_version' OR inventory ? 'proximity_workspaces' OR counts ? 'proximity_ephemeral')
 OR EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE (inventory->'required_domains') ? 'proximity_ephemeral' OR inventory ? 'proximity_inventory_version' OR counts ? 'proximity_ephemeral')
 OR EXISTS(SELECT 1 FROM public.orgs_erasurereceipt WHERE domain='proximity_ephemeral')
 OR EXISTS(SELECT 1 FROM public.orgs_accounterasurereceipt WHERE domain='proximity_ephemeral')
 THEN RAISE EXCEPTION 'cannot downgrade proximity erasure migration with admitted proximity obligations or receipts' USING ERRCODE='23514'; END IF;
END $$;

DROP TRIGGER aa_proximity_inventory ON public.orgs_accounterasure;
DROP TRIGGER aa_proximity_inventory ON public.orgs_privacyerasure;
DROP FUNCTION public.proximity_erasure_inventory();

CREATE OR REPLACE FUNCTION privacy_complete_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET lock_timeout='3s' SET statement_timeout='30s' AS $$
DECLARE request public.orgs_privacyerasure%ROWTYPE; org uuid; extension_pending boolean; ee_pending boolean;
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.ee_saml_pending_request WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_saml_replay_assertion WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_saml_principal WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_saml_idp WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_session WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_group_member WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_group WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_deprovision WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_user WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_token WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_audit_signing_key WHERE organisation_id=request.organisation_reference)
   OR EXISTS(SELECT 1 FROM public.ee_audit_ledger WHERE organisation_id=request.organisation_reference AND pii_scrubbed_at IS NULL)
   INTO ee_pending;
  IF ee_pending THEN RETURN false; END IF;
 END IF;
 org:=request.organisation_reference;
 PERFORM 1 FROM public.orgs_organisation WHERE id=org AND state='closed' AND deleted_at=request.cutoff_at FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure durable cutoff binding missing' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'erase','orgs_organisation',org,'{}');
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

CREATE OR REPLACE FUNCTION public.privacy_complete_account_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE request public.orgs_accounterasure%ROWTYPE; ee_pending boolean;
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
 IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.ee_saml_principal WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_session WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_deprovision WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_scim_user WHERE user_id=request.user_reference)
   OR EXISTS(SELECT 1 FROM public.ee_audit_ledger WHERE user_id=request.user_reference AND pii_scrubbed_at IS NULL)
   INTO ee_pending;
  IF ee_pending THEN RETURN false; END IF;
 END IF;
 PERFORM 1 FROM public.identity_user WHERE id=request.user_reference AND NOT enabled AND email='erased:'||id FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.identity_identity WHERE user_id=request.user_reference AND (enabled OR email<>'erased:'||id))
 OR EXISTS(SELECT 1 FROM public.orgs_membership WHERE user_id=request.user_reference AND state<>'removed' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'account cutoff or personal contacts still present' USING ERRCODE='23514'; END IF;
 INSERT INTO public.retention_worker_context VALUES(pg_backend_pid(),txid_current(),'account','identity_user',request.user_reference,'{}');
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


class Migration(migrations.Migration):
    dependencies = [("orgs", "0032_ee_enterprise_store")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RemoveConstraint(model_name="erasurereceipt", name="erasure_domain"),
        migrations.AddConstraint(
            model_name="erasurereceipt",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    domain__in=[
                        "matrix",
                        "objects",
                        "identity_provider",
                        "private_exports",
                        "external_extension_receivers",
                        "proximity_ephemeral",
                    ]
                ),
                name="erasure_domain",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="accounterasurereceipt", name="account_erasure_receipt_domain"
        ),
        migrations.AddConstraint(
            model_name="accounterasurereceipt",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    domain__in=[
                        "matrix_accounts",
                        "identity_provider_accounts",
                        "private_exports",
                        "account_message_outbox",
                        "account_extension_subjects",
                        "proximity_ephemeral",
                    ]
                ),
                name="account_erasure_receipt_domain",
            ),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

"""Provision Enterprise Edition (`ee_*`) schema, cutoff triggers, and erasure hooks without sequences."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE TABLE public.ee_saml_idp (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    idp_id text NOT NULL,
    idp_entity_id text NOT NULL,
    idp_sso_url text NOT NULL,
    public_key_pem text NOT NULL,
    verified_domains_json text NOT NULL,
    group_role_mapping_json text NOT NULL,
    default_role text NOT NULL,
    want_assertions_signed boolean NOT NULL,
    clock_skew_seconds integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organisation_id, idp_id),
    UNIQUE (tenant_slug, idp_id)
);

CREATE TABLE public.ee_saml_pending_request (
    relay_state text PRIMARY KEY,
    organisation_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    idp_id text NOT NULL,
    request_id text NOT NULL,
    return_path text NOT NULL,
    sp_base_url text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX ee_saml_pending_request_org_idx ON public.ee_saml_pending_request (organisation_id);

CREATE TABLE public.ee_saml_replay_assertion (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    idp_entity_id text NOT NULL,
    assertion_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    UNIQUE (organisation_id, idp_entity_id, assertion_id),
    UNIQUE (tenant_slug, idp_entity_id, assertion_id)
);

CREATE TABLE public.ee_saml_principal (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    user_id uuid NULL,
    principal_ref text NOT NULL,
    tenant_slug text NOT NULL,
    email_lower text NOT NULL,
    idp_id text NOT NULL,
    idp_entity_id text NOT NULL,
    assertion_id text NOT NULL,
    subject_name_id text NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    groups_json text NOT NULL,
    role text NOT NULL,
    return_path text NOT NULL,
    authenticated_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organisation_id, email_lower),
    UNIQUE (tenant_slug, email_lower)
);
CREATE INDEX ee_saml_principal_user_idx ON public.ee_saml_principal (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE public.ee_scim_token (
    token_id text PRIMARY KEY,
    organisation_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    secret_sha256 bytea NOT NULL,
    scopes_json text NOT NULL,
    description text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NULL,
    revoked_at timestamptz NULL
);
CREATE INDEX ee_scim_token_org_idx ON public.ee_scim_token (organisation_id);

CREATE TABLE public.ee_scim_user (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    user_id uuid NULL,
    tenant_slug text NOT NULL,
    user_name text NOT NULL,
    user_name_lower text NOT NULL,
    external_id text NULL,
    display_name text NOT NULL,
    given_name text NOT NULL,
    family_name text NOT NULL,
    emails_json text NOT NULL,
    active boolean NOT NULL,
    roles_json text NOT NULL,
    department text NULL,
    member_state text NOT NULL,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deprovisioned_at timestamptz NULL,
    UNIQUE (organisation_id, user_name_lower),
    UNIQUE (tenant_slug, user_name_lower)
);
CREATE INDEX ee_scim_user_person_idx ON public.ee_scim_user (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE public.ee_scim_group (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    display_name text NOT NULL,
    display_name_lower text NOT NULL,
    external_id text NULL,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organisation_id, display_name_lower),
    UNIQUE (tenant_slug, display_name_lower)
);

CREATE TABLE public.ee_scim_group_member (
    organisation_id uuid NOT NULL,
    group_id uuid NOT NULL REFERENCES public.ee_scim_group(id) ON DELETE RESTRICT,
    scim_user_id uuid NOT NULL REFERENCES public.ee_scim_user(id) ON DELETE RESTRICT,
    member_order integer NOT NULL,
    PRIMARY KEY (group_id, scim_user_id)
);
CREATE INDEX ee_scim_group_member_org_idx ON public.ee_scim_group_member (organisation_id);
CREATE INDEX ee_scim_group_member_user_idx ON public.ee_scim_group_member (scim_user_id);

CREATE TABLE public.ee_scim_session (
    organisation_id uuid NOT NULL,
    scim_user_id uuid NOT NULL REFERENCES public.ee_scim_user(id) ON DELETE RESTRICT,
    user_id uuid NULL,
    tenant_slug text NOT NULL,
    session_id text NOT NULL,
    PRIMARY KEY (organisation_id, scim_user_id, session_id)
);
CREATE INDEX ee_scim_session_person_idx ON public.ee_scim_session (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE public.ee_scim_deprovision (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    scim_user_id uuid NOT NULL,
    user_id uuid NULL,
    tenant_slug text NOT NULL,
    user_name text NOT NULL,
    reason text NOT NULL,
    revoked_sessions_json text NOT NULL,
    occurred_at timestamptz NOT NULL
);
CREATE INDEX ee_scim_deprovision_org_idx ON public.ee_scim_deprovision (organisation_id);
CREATE INDEX ee_scim_deprovision_person_idx ON public.ee_scim_deprovision (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE public.ee_audit_ledger (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    user_id uuid NULL,
    tenant_slug text NOT NULL,
    seq bigint NOT NULL,
    event_id text NOT NULL,
    occurred_at text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    actor_label text NOT NULL,
    action text NOT NULL,
    target_urn text NOT NULL,
    source_ip text NOT NULL,
    metadata_json text NOT NULL,
    prev_hash text NOT NULL,
    entry_hash text NOT NULL,
    pii_scrubbed_at timestamptz NULL,
    UNIQUE (organisation_id, seq),
    UNIQUE (tenant_slug, seq),
    UNIQUE (organisation_id, event_id),
    UNIQUE (tenant_slug, event_id)
);
CREATE INDEX ee_audit_ledger_person_idx ON public.ee_audit_ledger (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE public.ee_audit_signing_key (
    id uuid PRIMARY KEY,
    organisation_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    algorithm text NOT NULL,
    key_id text NOT NULL,
    public_key_b64 text NOT NULL,
    public_key_pem text NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (organisation_id, key_id),
    UNIQUE (tenant_slug, key_id)
);

CREATE FUNCTION public.ee_resource_binding_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE binding text; old_val jsonb; new_val jsonb;
BEGIN
 FOREACH binding IN ARRAY TG_ARGV LOOP
  old_val := to_jsonb(OLD)->binding;
  new_val := to_jsonb(NEW)->binding;
  IF binding = 'user_id' AND (old_val IS NULL OR old_val = 'null'::jsonb) THEN
   CONTINUE;
  END IF;
  IF old_val IS DISTINCT FROM new_val THEN
   RAISE EXCEPTION 'erasure resource authority binding immutable' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_resource_binding_guard() FROM PUBLIC;

CREATE FUNCTION public.ee_privacy_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb := to_jsonb(NEW); org uuid; person uuid;
BEGIN
 org := NEW.organisation_id;
 IF NOT EXISTS(SELECT 1 FROM public.orgs_organisation WHERE id = org) THEN
  RAISE EXCEPTION 'ee organisation reference missing' USING ERRCODE='23503';
 END IF;
 IF TG_TABLE_NAME = 'ee_audit_ledger' AND TG_OP = 'UPDATE' THEN
  IF OLD.user_id IS NOT NULL AND public.privacy_account_context(OLD.user_id)
  AND NEW.actor_label = 'erased:' || OLD.user_id::text
  AND NEW.source_ip = '' AND NEW.metadata_json = '{}' AND NEW.pii_scrubbed_at IS NOT NULL
  AND (to_jsonb(NEW) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
   IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
  THEN RETURN NEW; END IF;
 END IF;

 PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || org::text, 0));
 IF (EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
  OR EXISTS(SELECT 1 FROM public.orgs_organisation WHERE id = org AND (state = 'closed' OR deleted_at IS NOT NULL)))
  AND NOT public.privacy_erasure_context(org) THEN
  RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
 END IF;

 IF (item ? 'user_id') AND (item->>'user_id') IS NOT NULL THEN
  person := (item->>'user_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.identity_user WHERE id = person) THEN
   RAISE EXCEPTION 'ee user reference missing' USING ERRCODE='23503';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || person::text, 0));
  IF EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
   AND NOT public.privacy_account_context(person)
   AND NOT public.privacy_erasure_context(org) THEN
   RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_privacy_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.ee_audit_ledger_immutable_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'ee audit ledger is append-only' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF (public.privacy_erasure_context(OLD.organisation_id)
   OR (OLD.user_id IS NOT NULL AND public.privacy_account_context(OLD.user_id)))
   AND NEW.source_ip = '' AND NEW.metadata_json = '{}' AND NEW.pii_scrubbed_at IS NOT NULL
   AND (NEW.actor_label = 'erased' OR (OLD.user_id IS NOT NULL AND NEW.actor_label = 'erased:' || OLD.user_id::text))
   AND (to_jsonb(NEW) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label','source_ip','metadata_json','pii_scrubbed_at'])
  THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ee audit ledger is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ee_audit_ledger_immutable_guard() FROM PUBLIC;

CREATE FUNCTION public.ee_audit_signing_key_immutable_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'ee audit signing key is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'DELETE' AND NOT public.privacy_erasure_context(OLD.organisation_id) THEN
  RAISE EXCEPTION 'ee audit signing key is append-only' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.ee_audit_signing_key_immutable_guard() FROM PUBLIC;

CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_saml_idp FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('id','organisation_id','tenant_slug','idp_id','created_at');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_saml_pending_request FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('relay_state','organisation_id','tenant_slug','idp_id','request_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_saml_replay_assertion FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('id','organisation_id','tenant_slug','idp_entity_id','assertion_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_saml_principal FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('id','organisation_id','user_id','tenant_slug','email_lower');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_token FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('token_id','organisation_id','tenant_slug','secret_sha256','created_at');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_user FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('id','organisation_id','user_id','tenant_slug','created_at');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_group FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('id','organisation_id','tenant_slug','created_at');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_group_member FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('organisation_id','group_id','scim_user_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_session FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('organisation_id','scim_user_id','user_id','tenant_slug','session_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_deprovision FOR EACH ROW
 EXECUTE FUNCTION public.ee_resource_binding_guard('id','organisation_id','scim_user_id','user_id','tenant_slug','occurred_at');

CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_saml_idp FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_saml_pending_request FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_saml_replay_assertion FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_saml_principal FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_scim_token FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_scim_user FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_scim_group FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_scim_group_member FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_scim_session FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_scim_deprovision FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_audit_ledger FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON public.ee_audit_signing_key FOR EACH ROW EXECUTE FUNCTION public.ee_privacy_cutoff_guard();

CREATE TRIGGER zz_ee_audit_ledger_immutable BEFORE UPDATE OR DELETE ON public.ee_audit_ledger FOR EACH ROW
 EXECUTE FUNCTION public.ee_audit_ledger_immutable_guard();
CREATE TRIGGER zz_ee_audit_signing_key_immutable BEFORE UPDATE OR DELETE ON public.ee_audit_signing_key FOR EACH ROW
 EXECUTE FUNCTION public.ee_audit_signing_key_immutable_guard();

CREATE OR REPLACE FUNCTION privacy_purge_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
REVOKE ALL ON FUNCTION privacy_purge_core(uuid) FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION privacy_purge_account_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
REVOKE ALL ON FUNCTION privacy_purge_account_core(uuid) FROM PUBLIC;

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


REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.privacy_complete_account_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION privacy_purge_account_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION privacy_complete_erasure(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION privacy_purge_core(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
REVOKE ALL ON FUNCTION privacy_purge_core(uuid) FROM PUBLIC;

DROP TABLE public.ee_audit_signing_key;
DROP TABLE public.ee_audit_ledger;
DROP TABLE public.ee_scim_deprovision;
DROP TABLE public.ee_scim_session;
DROP TABLE public.ee_scim_group_member;
DROP TABLE public.ee_scim_group;
DROP TABLE public.ee_scim_user;
DROP TABLE public.ee_scim_token;
DROP TABLE public.ee_saml_principal;
DROP TABLE public.ee_saml_replay_assertion;
DROP TABLE public.ee_saml_pending_request;
DROP TABLE public.ee_saml_idp;

DROP FUNCTION public.ee_audit_signing_key_immutable_guard();
DROP FUNCTION public.ee_audit_ledger_immutable_guard();
DROP FUNCTION public.ee_privacy_cutoff_guard();
DROP FUNCTION public.ee_resource_binding_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0031_account_erasure_completion")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

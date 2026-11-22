"""Statutory personal-data scrubbing for enterprise audit ledger and SCIM contact sync.

Extends account and organisation erasure inventory discovery, HKDF-keyed HMAC-SHA256
target_urn pseudonymisation, tamper-evident erasure_commitment seals, append-only ledger
immutability exceptions, and narrow SECURITY DEFINER SCIM member contact synchronisation
enforcing protected-role and SCIM-provenance guards without importing ee/ in Community builds.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.ee_audit_ledger
    ADD COLUMN erasure_commitment text,
    ADD CONSTRAINT ee_audit_ledger_erasure_commitment_chk CHECK (
        erasure_commitment IS NULL
        OR (
            pii_scrubbed_at IS NOT NULL
            AND erasure_commitment ~ '^(account|org|ingest):[0-9a-f-]{36}:[0-9a-f]{64}:[0-9a-f]{64}$'
        )
    );

ALTER TABLE public.ee_scim_user
    ADD COLUMN provisioned_by_scim boolean NOT NULL DEFAULT FALSE;

ALTER TABLE public.ee_scim_deprovision
    ADD COLUMN provisioned_by_scim boolean NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF to_regclass('public.audit_auditevent') IS NOT NULL THEN
        UPDATE public.ee_scim_user su
        SET provisioned_by_scim = TRUE
        WHERE su.user_id IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM public.orgs_organisation o
              WHERE o.id = su.organisation_id
                AND o.state <> 'closed'
                AND o.deleted_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = su.organisation_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.orgs_accounterasure ae_cut
              WHERE ae_cut.user_reference = su.user_id
          )
          AND EXISTS (
              SELECT 1
              FROM public.orgs_membership m
              JOIN public.audit_auditevent ae
                ON ae.organisation_id = m.organisation_id
               AND ae.action = 'membership.created'
               AND ae.target_urn = ('urn:kodera:membership:' || m.id::text)
               AND ae.metadata->>'source' = 'scim'
              WHERE m.organisation_id = su.organisation_id
                AND m.user_id = su.user_id
                AND m.deleted_at IS NULL
          );

        UPDATE public.ee_scim_deprovision sd
        SET provisioned_by_scim = TRUE
        WHERE sd.user_id IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM public.orgs_organisation o
              WHERE o.id = sd.organisation_id
                AND o.state <> 'closed'
                AND o.deleted_at IS NULL
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = sd.organisation_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.orgs_accounterasure ae_cut
              WHERE ae_cut.user_reference = sd.user_id
          )
          AND EXISTS (
              SELECT 1
              FROM public.orgs_membership m
              JOIN public.audit_auditevent ae
                ON ae.organisation_id = m.organisation_id
               AND ae.action = 'membership.created'
               AND ae.target_urn = ('urn:kodera:membership:' || m.id::text)
               AND ae.metadata->>'source' = 'scim'
              WHERE m.organisation_id = sd.organisation_id
                AND m.user_id = sd.user_id
                AND m.deleted_at IS NULL
          );
    END IF;
END
$$;

DROP TRIGGER IF EXISTS a_resource_binding ON public.ee_scim_user;
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_user FOR EACH ROW
    EXECUTE FUNCTION public.ee_resource_binding_guard(
        'id', 'organisation_id', 'user_id', 'tenant_slug', 'created_at', 'provisioned_by_scim'
    );

DROP TRIGGER IF EXISTS a_resource_binding ON public.ee_scim_deprovision;
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_deprovision FOR EACH ROW
    EXECUTE FUNCTION public.ee_resource_binding_guard(
        'id', 'organisation_id', 'scim_user_id', 'user_id', 'tenant_slug', 'occurred_at', 'provisioned_by_scim'
    );

CREATE FUNCTION public.ee_audit_hmac_sha256_hex(p_key bytea, p_msg bytea)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
DECLARE
    key_block bytea;
    ipad bytea := decode(repeat('36', 64), 'hex');
    opad bytea := decode(repeat('5c', 64), 'hex');
    idx integer;
    kb integer;
BEGIN
    IF octet_length(p_key) > 64 THEN
        key_block := sha256(p_key);
    ELSE
        key_block := p_key;
    END IF;
    IF octet_length(key_block) < 64 THEN
        key_block := key_block || decode(repeat('00', 64 - octet_length(key_block)), 'hex');
    END IF;
    FOR idx IN 0..63 LOOP
        kb := get_byte(key_block, idx);
        ipad := set_byte(ipad, idx, kb # 54);
        opad := set_byte(opad, idx, kb # 92);
    END LOOP;
    RETURN encode(sha256(opad || sha256(ipad || p_msg)), 'hex');
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_hmac_sha256_hex(bytea, bytea) FROM PUBLIC;

CREATE FUNCTION public.ee_audit_resolve_erasure_master_key()
RETURNS bytea
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    raw_hex text := nullif(btrim(current_setting('kodera.ee_audit_erasure_key_hex', true)), '');
BEGIN
    IF raw_hex IS NULL OR raw_hex !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'enterprise audit erasure requires configured server secret key'
            USING ERRCODE = '23514';
    END IF;
    RETURN decode(raw_hex, 'hex');
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_resolve_erasure_master_key() FROM PUBLIC;

CREATE FUNCTION public.ee_audit_build_erasure_seal(
    p_master_key bytea,
    p_scope text,
    p_req_id uuid,
    p_instruction_sha256 text,
    p_inventory_sha256 text,
    p_org_id uuid,
    p_seq bigint,
    p_event_id text,
    p_occurred_at text,
    p_tenant_slug text,
    p_actor_type text,
    p_actor_id text,
    p_actor_label text,
    p_action text,
    p_target_urn text,
    p_prev_hash text,
    p_entry_hash text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
    row_mac_key bytea;
    row_mac_hex text;
    journal_seal_key bytea;
    journal_hmac_hex text;
BEGIN
    row_mac_key := decode(
        public.ee_audit_hmac_sha256_hex(
            p_master_key,
            convert_to(
                'kodera-ee-audit-row-mac-v2:' || p_scope || ':' || p_req_id::text,
                'UTF8'
            )
        ),
        'hex'
    );
    row_mac_hex := public.ee_audit_hmac_sha256_hex(
        row_mac_key,
        convert_to(
            'kodera-ee-audit-erased-v2|'
            || octet_length(convert_to(p_scope, 'UTF8'))::text || ':' || p_scope || '|'
            || octet_length(convert_to(p_req_id::text, 'UTF8'))::text || ':' || p_req_id::text || '|'
            || octet_length(convert_to(p_org_id::text, 'UTF8'))::text || ':' || p_org_id::text || '|'
            || octet_length(convert_to(p_seq::text, 'UTF8'))::text || ':' || p_seq::text || '|'
            || octet_length(convert_to(p_event_id, 'UTF8'))::text || ':' || p_event_id || '|'
            || octet_length(convert_to(p_occurred_at, 'UTF8'))::text || ':' || p_occurred_at || '|'
            || octet_length(convert_to(p_tenant_slug, 'UTF8'))::text || ':' || p_tenant_slug || '|'
            || octet_length(convert_to(p_actor_type, 'UTF8'))::text || ':' || p_actor_type || '|'
            || octet_length(convert_to(p_actor_id, 'UTF8'))::text || ':' || p_actor_id || '|'
            || octet_length(convert_to(p_actor_label, 'UTF8'))::text || ':' || p_actor_label || '|'
            || octet_length(convert_to(p_action, 'UTF8'))::text || ':' || p_action || '|'
            || octet_length(convert_to(p_target_urn, 'UTF8'))::text || ':' || p_target_urn || '|2:{}|'
            || octet_length(convert_to(p_prev_hash, 'UTF8'))::text || ':' || p_prev_hash || '|'
            || octet_length(convert_to(p_entry_hash, 'UTF8'))::text || ':' || p_entry_hash,
            'UTF8'
        )
    );
    journal_seal_key := decode(
        public.ee_audit_hmac_sha256_hex(
            p_master_key,
            convert_to(
                'kodera-ee-audit-journal-seal-v2:'
                || p_scope || ':'
                || p_req_id::text || ':'
                || p_instruction_sha256 || ':'
                || p_inventory_sha256,
                'UTF8'
            )
        ),
        'hex'
    );
    journal_hmac_hex := public.ee_audit_hmac_sha256_hex(
        journal_seal_key,
        convert_to(row_mac_hex, 'UTF8')
    );
    RETURN p_scope || ':' || p_req_id::text || ':' || row_mac_hex || ':' || journal_hmac_hex;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_build_erasure_seal(
    bytea, text, uuid, text, text, uuid, bigint, text, text, text, text, text, text, text, text, text, text
) FROM PUBLIC;

CREATE FUNCTION public.ee_audit_scrub_target_urn(p_target_urn text, p_hmac_key bytea)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
    res_type text := 'redacted';
    candidate_type text;
    digest_hex text;
BEGIN
    IF p_target_urn LIKE 'urn:kodera:%' THEN
        candidate_type := split_part(p_target_urn, ':', 3);
        IF candidate_type ~ '^[A-Za-z0-9._-]{1,64}$' AND candidate_type <> 'erased' THEN
            res_type := candidate_type;
        END IF;
    END IF;
    digest_hex := substr(
        public.ee_audit_hmac_sha256_hex(
            p_hmac_key,
            convert_to('target_urn:' || lower(btrim(p_target_urn)), 'UTF8')
        ),
        1,
        24
    );
    RETURN 'urn:kodera:' || res_type || ':erased:' || digest_hex;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_scrub_target_urn(text, bytea) FROM PUBLIC;

CREATE FUNCTION public.ee_audit_target_urn_matches_digests(p_target_urn text, p_digests jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    norm_urn text;
    tail_val text;
    seg text;
BEGIN
    IF p_target_urn IS NULL OR btrim(p_target_urn) = '' THEN
        RETURN false;
    END IF;
    IF p_target_urn ~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$' THEN
        RETURN false;
    END IF;
    IF p_digests IS NULL OR jsonb_typeof(p_digests) IS DISTINCT FROM 'array' OR jsonb_array_length(p_digests) = 0 THEN
        RETURN false;
    END IF;
    norm_urn := lower(btrim(p_target_urn));
    IF p_digests ? encode(sha256(convert_to(norm_urn, 'UTF8')), 'hex') THEN
        RETURN true;
    END IF;
    IF norm_urn LIKE 'urn:kodera:%:%' THEN
        tail_val := regexp_replace(norm_urn, '^urn:kodera:[^:]+:', '');
        IF tail_val <> '' AND p_digests ? encode(sha256(convert_to(tail_val, 'UTF8')), 'hex') THEN
            RETURN true;
        END IF;
    END IF;
    FOR seg IN SELECT unnest(string_to_array(norm_urn, ':')) LOOP
        IF seg <> '' AND seg NOT IN ('urn', 'kodera', 'erased')
           AND p_digests ? encode(sha256(convert_to(seg, 'UTF8')), 'hex') THEN
            RETURN true;
        END IF;
    END LOOP;
    RETURN false;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_target_urn_matches_digests(text, jsonb) FROM PUBLIC;

CREATE FUNCTION public.ee_audit_row_requires_target_scrub(
    p_row_id uuid,
    p_row_user uuid,
    p_target_urn text,
    p_person uuid,
    p_inventory jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
    inv jsonb := COALESCE(p_inventory, '{}'::jsonb);
BEGIN
    IF p_target_urn IS NULL OR p_target_urn ~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$' THEN
        RETURN false;
    END IF;
    IF COALESCE(inv->'ee_audit_target_scrub_ids', '[]'::jsonb) ? (p_row_id::text) THEN
        RETURN true;
    END IF;
    IF public.ee_audit_target_urn_matches_digests(
        p_target_urn,
        COALESCE(inv->'ee_audit_subject_sha256s', '[]'::jsonb)
    ) THEN
        RETURN true;
    END IF;
    IF (
        p_row_user = p_person
        OR COALESCE(inv->'ee_audit_scrub_ids', '[]'::jsonb) ? (p_row_id::text)
    ) AND (
        strpos(p_target_urn, '@') > 0
        OR p_target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$'
    ) THEN
        RETURN true;
    END IF;
    RETURN false;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_row_requires_target_scrub(uuid, uuid, text, uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION public.ee_audit_row_matches_erasure(
    p_org uuid,
    p_row_id uuid,
    p_row_user uuid,
    p_actor_id text,
    p_actor_label text,
    p_target_urn text,
    p_metadata_json text,
    p_person uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    ae_inv jsonb;
    digests jsonb;
    meta_doc jsonb;
BEGIN
    IF p_person IS NULL THEN
        RETURN false;
    END IF;
    IF p_row_user IS NOT NULL AND p_row_user = p_person THEN
        RETURN true;
    END IF;

    SELECT ae.inventory
    INTO ae_inv
    FROM public.orgs_accounterasure ae
    WHERE ae.user_reference = p_person
    LIMIT 1;

    IF NOT FOUND OR ae_inv IS NULL THEN
        RETURN false;
    END IF;

    IF COALESCE(ae_inv->'ee_audit_scrub_ids', '[]'::jsonb) ? (p_row_id::text) THEN
        RETURN true;
    END IF;

    IF NOT (COALESCE(ae_inv->'ee_audit_target_org_ids', '[]'::jsonb) ? (p_org::text)) THEN
        RETURN false;
    END IF;

    digests := COALESCE(ae_inv->'ee_audit_subject_sha256s', '[]'::jsonb);
    IF jsonb_typeof(digests) IS DISTINCT FROM 'array' OR jsonb_array_length(digests) = 0 THEN
        RETURN false;
    END IF;

    IF p_actor_id IS NOT NULL AND p_actor_id <> ''
       AND digests ? encode(sha256(convert_to(lower(btrim(p_actor_id)), 'UTF8')), 'hex') THEN
        RETURN true;
    END IF;

    IF p_actor_label IS NOT NULL AND p_actor_label <> ''
       AND digests ? encode(sha256(convert_to(lower(btrim(p_actor_label)), 'UTF8')), 'hex') THEN
        RETURN true;
    END IF;

    IF public.ee_audit_target_urn_matches_digests(p_target_urn, digests) THEN
        RETURN true;
    END IF;

    IF p_metadata_json IS NOT NULL AND p_metadata_json <> '' AND p_metadata_json <> '{}' THEN
        BEGIN
            meta_doc := p_metadata_json::jsonb;
        EXCEPTION WHEN others THEN
            meta_doc := NULL;
        END;

        IF meta_doc IS NOT NULL THEN
            IF EXISTS (
                WITH RECURSIVE nodes(val) AS (
                    SELECT meta_doc
                    UNION ALL
                    SELECT CASE
                        WHEN jsonb_typeof(n.val) = 'object' THEN e.value
                        WHEN jsonb_typeof(n.val) = 'array' THEN a.value
                    END
                    FROM nodes n
                    LEFT JOIN LATERAL jsonb_each(
                        CASE WHEN jsonb_typeof(n.val) = 'object' THEN n.val ELSE '{}'::jsonb END
                    ) e ON jsonb_typeof(n.val) = 'object'
                    LEFT JOIN LATERAL jsonb_array_elements(
                        CASE WHEN jsonb_typeof(n.val) = 'array' THEN n.val ELSE '[]'::jsonb END
                    ) a ON jsonb_typeof(n.val) = 'array'
                    WHERE jsonb_typeof(n.val) IN ('object', 'array')
                )
                SELECT 1
                FROM nodes
                WHERE jsonb_typeof(val) = 'string'
                  AND digests ? encode(
                      sha256(convert_to(lower(btrim(val #>> '{}')), 'UTF8')),
                      'hex'
                  )
            ) THEN
                RETURN true;
            END IF;
        END IF;
    END IF;

    RETURN false;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_row_matches_erasure(uuid, uuid, uuid, text, text, text, text, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ee_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    item jsonb := to_jsonb(NEW);
    org uuid;
    person uuid;
BEGIN
    org := NEW.organisation_id;
    IF NOT EXISTS (SELECT 1 FROM public.orgs_organisation WHERE id = org) THEN
        RAISE EXCEPTION 'ee organisation reference missing' USING ERRCODE = '23503';
    END IF;

    IF TG_TABLE_NAME = 'ee_audit_ledger' AND TG_OP = 'UPDATE' THEN
        IF NEW.source_ip = ''
           AND NEW.metadata_json = '{}'
           AND NEW.pii_scrubbed_at IS NOT NULL
           AND (
               NEW.target_urn = OLD.target_urn
               OR NEW.target_urn ~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$'
           )
           AND (to_jsonb(NEW) - ARRAY['actor_label', 'target_urn', 'source_ip', 'metadata_json', 'pii_scrubbed_at', 'erasure_commitment'])
               IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label', 'target_urn', 'source_ip', 'metadata_json', 'pii_scrubbed_at', 'erasure_commitment'])
           AND (
               (public.privacy_erasure_context(OLD.organisation_id) AND NEW.actor_label = 'erased')
               OR (
                   OLD.user_id IS NOT NULL
                   AND public.privacy_account_context(OLD.user_id)
                   AND NEW.actor_label = 'erased:' || OLD.user_id::text
               )
               OR EXISTS (
                   SELECT 1
                   FROM public.retention_worker_context rwc
                   WHERE rwc.backend = pg_backend_pid()
                     AND rwc.transaction = txid_current()
                     AND rwc.purpose = 'account'
                     AND rwc.source_table = 'identity_user'
                     AND public.ee_audit_row_matches_erasure(
                         OLD.organisation_id,
                         OLD.id,
                         OLD.user_id,
                         OLD.actor_id,
                         OLD.actor_label,
                         OLD.target_urn,
                         OLD.metadata_json,
                         rwc.source_id
                     )
                     AND (
                         (OLD.user_id = rwc.source_id AND NEW.actor_label = 'erased:' || rwc.source_id::text)
                         OR (
                             OLD.user_id IS DISTINCT FROM rwc.source_id
                             AND NEW.actor_label IN (OLD.actor_label, 'erased:' || rwc.source_id::text)
                         )
                     )
               )
           )
        THEN
            RETURN NEW;
        END IF;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || org::text, 0));
    IF (
        EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = org)
        OR EXISTS (
            SELECT 1 FROM public.orgs_organisation
            WHERE id = org AND (state = 'closed' OR deleted_at IS NOT NULL)
        )
    ) AND NOT public.privacy_erasure_context(org) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE = '23514';
    END IF;

    IF (item ? 'user_id') AND (item->>'user_id') IS NOT NULL THEN
        person := (item->>'user_id')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.identity_user WHERE id = person) THEN
            RAISE EXCEPTION 'ee user reference missing' USING ERRCODE = '23503';
        END IF;
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || person::text, 0));
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = person)
           AND NOT public.privacy_account_context(person)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_privacy_cutoff_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ee_audit_ledger_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ee audit ledger is append-only' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.source_ip = ''
           AND NEW.metadata_json = '{}'
           AND NEW.pii_scrubbed_at IS NOT NULL
           AND (
               NEW.target_urn = OLD.target_urn
               OR NEW.target_urn ~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$'
           )
           AND (to_jsonb(NEW) - ARRAY['actor_label', 'target_urn', 'source_ip', 'metadata_json', 'pii_scrubbed_at', 'erasure_commitment'])
               IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['actor_label', 'target_urn', 'source_ip', 'metadata_json', 'pii_scrubbed_at', 'erasure_commitment'])
           AND (
               (public.privacy_erasure_context(OLD.organisation_id) AND NEW.actor_label = 'erased')
               OR (
                   OLD.user_id IS NOT NULL
                   AND public.privacy_account_context(OLD.user_id)
                   AND NEW.actor_label = 'erased:' || OLD.user_id::text
               )
               OR EXISTS (
                   SELECT 1
                   FROM public.retention_worker_context rwc
                   WHERE rwc.backend = pg_backend_pid()
                     AND rwc.transaction = txid_current()
                     AND rwc.purpose = 'account'
                     AND rwc.source_table = 'identity_user'
                     AND public.ee_audit_row_matches_erasure(
                         OLD.organisation_id,
                         OLD.id,
                         OLD.user_id,
                         OLD.actor_id,
                         OLD.actor_label,
                         OLD.target_urn,
                         OLD.metadata_json,
                         rwc.source_id
                     )
                     AND (
                         (OLD.user_id = rwc.source_id AND NEW.actor_label = 'erased:' || rwc.source_id::text)
                         OR (
                             OLD.user_id IS DISTINCT FROM rwc.source_id
                             AND NEW.actor_label IN (OLD.actor_label, 'erased:' || rwc.source_id::text)
                         )
                     )
               )
           )
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'ee audit ledger is immutable' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_ledger_immutable_guard() FROM PUBLIC;

CREATE FUNCTION public.ee_audit_erasure_journal_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    person uuid;
    org_ref uuid;
    master_key bytea;
    hmac_key bytea;
    target_orgs uuid[] := ARRAY[]::uuid[];
    target_org_texts text[] := ARRAY[]::text[];
    subject_sha256s jsonb := '[]'::jsonb;
    scrub_ids jsonb := '[]'::jsonb;
    target_scrub_ids jsonb := '[]'::jsonb;
    actor_scrub_ids jsonb := '[]'::jsonb;
    scrubbed_count bigint := 0;
BEGIN
    IF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
        IF TG_OP = 'UPDATE' AND OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
            org_ref := NEW.organisation_reference;
            IF to_regclass('public.ee_audit_ledger') IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.ee_audit_ledger WHERE organisation_id = org_ref)
            THEN
                master_key := public.ee_audit_resolve_erasure_master_key();
                hmac_key := decode(
                    public.ee_audit_hmac_sha256_hex(
                        master_key,
                        convert_to(
                            'kodera-ee-audit-target-urn-v2:org:'
                            || NEW.id::text || ':' || NEW.instruction_sha256,
                            'UTF8'
                        )
                    ),
                    'hex'
                );
                UPDATE public.ee_audit_ledger l
                SET actor_label = 'erased',
                    target_urn = sub.next_target_urn,
                    source_ip = '',
                    metadata_json = '{}',
                    pii_scrubbed_at = COALESCE(l.pii_scrubbed_at, clock_timestamp()),
                    erasure_commitment = public.ee_audit_build_erasure_seal(
                        master_key,
                        'org',
                        NEW.id,
                        NEW.instruction_sha256,
                        NEW.inventory_sha256,
                        l.organisation_id,
                        l.seq,
                        l.event_id,
                        l.occurred_at,
                        l.tenant_slug,
                        l.actor_type,
                        l.actor_id,
                        'erased',
                        l.action,
                        sub.next_target_urn,
                        l.prev_hash,
                        l.entry_hash
                    )
                FROM (
                    SELECT s.id,
                           CASE
                               WHEN s.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$'
                                    AND (
                                        strpos(s.target_urn, '@') > 0
                                        OR s.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$'
                                    )
                               THEN public.ee_audit_scrub_target_urn(s.target_urn, hmac_key)
                               ELSE s.target_urn
                           END AS next_target_urn
                    FROM public.ee_audit_ledger s
                    WHERE s.organisation_id = org_ref
                ) sub
                WHERE l.id = sub.id AND l.organisation_id = org_ref;
            END IF;
        ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'complete' AND NEW.status = 'complete' THEN
            org_ref := NEW.organisation_reference;
            IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1
                    FROM public.ee_audit_ledger l
                    WHERE l.organisation_id = org_ref
                      AND (
                          l.pii_scrubbed_at IS NULL
                          OR l.erasure_commitment IS NULL
                          OR l.actor_label <> 'erased'
                          OR l.source_ip <> ''
                          OR l.metadata_json <> '{}'
                          OR (
                              l.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$'
                              AND (
                                  strpos(l.target_urn, '@') > 0
                                  OR l.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$'
                              )
                          )
                      )
                ) THEN
                    RAISE EXCEPTION 'enterprise audit ledger target_urn PII still present'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME <> 'orgs_accounterasure' THEN
        RETURN NEW;
    END IF;

    person := NEW.user_reference;

    IF TG_OP = 'INSERT' THEN
        SELECT COALESCE(array_agg(org_id ORDER BY org_id), ARRAY[]::uuid[]),
               COALESCE(array_agg(org_id::text ORDER BY org_id::text), ARRAY[]::text[])
        INTO target_orgs, target_org_texts
        FROM (
            SELECT DISTINCT m.organisation_id AS org_id
            FROM public.orgs_membership m
            WHERE m.user_id = person
            UNION
            SELECT DISTINCT i.organisation_id AS org_id
            FROM public.identity_identity i
            WHERE i.user_id = person AND i.organisation_id IS NOT NULL
        ) orgs;

        SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
        INTO subject_sha256s
        FROM (
            SELECT DISTINCT encode(sha256(convert_to(tok, 'UTF8')), 'hex') AS sha
            FROM (
                SELECT lower(btrim(u.email)) AS tok
                FROM public.identity_user u WHERE u.id = person
                UNION
                SELECT lower(btrim(u.display_name)) AS tok
                FROM public.identity_user u WHERE u.id = person AND u.display_name IS NOT NULL
                UNION
                SELECT lower(btrim(i.email)) AS tok
                FROM public.identity_identity i WHERE i.user_id = person
                UNION
                SELECT lower(person::text) AS tok
                UNION
                SELECT lower(i.id::text) AS tok
                FROM public.identity_identity i WHERE i.user_id = person
                UNION
                SELECT lower(btrim(i.subject)) AS tok
                FROM public.identity_identity i WHERE i.user_id = person
            ) tokens
            WHERE tok IS NOT NULL AND tok <> '' AND tok NOT LIKE 'erased:%'
        ) digests;

        IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
            SELECT COALESCE(jsonb_agg(l.id::text ORDER BY l.id::text), '[]'::jsonb)
            INTO scrub_ids
            FROM public.ee_audit_ledger l
            WHERE l.user_id = person
               OR (
                   l.organisation_id = ANY(target_orgs)
                   AND (
                       subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                       OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                       OR public.ee_audit_target_urn_matches_digests(l.target_urn, subject_sha256s)
                       OR EXISTS (
                           SELECT 1
                           FROM (
                               SELECT lower(btrim(u.email)) AS needle
                               FROM public.identity_user u WHERE u.id = person
                               UNION
                               SELECT lower(btrim(u.display_name)) AS needle
                               FROM public.identity_user u
                               WHERE u.id = person
                                 AND u.display_name IS NOT NULL
                                 AND char_length(btrim(u.display_name)) >= 3
                               UNION
                               SELECT lower(btrim(i.email)) AS needle
                               FROM public.identity_identity i WHERE i.user_id = person
                               UNION
                               SELECT lower(person::text) AS needle
                               UNION
                               SELECT lower(i.id::text) AS needle
                               FROM public.identity_identity i WHERE i.user_id = person
                               UNION
                               SELECT lower(btrim(i.subject)) AS needle
                               FROM public.identity_identity i WHERE i.user_id = person
                           ) needles
                           WHERE needles.needle IS NOT NULL
                             AND needles.needle <> ''
                             AND needles.needle NOT LIKE 'erased:%'
                             AND (
                                 strpos(lower(l.metadata_json), needles.needle) > 0
                                 OR strpos(lower(l.actor_label), needles.needle) > 0
                                 OR strpos(lower(l.actor_id), needles.needle) > 0
                                 OR strpos(lower(l.target_urn), needles.needle) > 0
                             )
                       )
                   )
               );

            SELECT COALESCE(jsonb_agg(l.id::text ORDER BY l.id::text), '[]'::jsonb)
            INTO target_scrub_ids
            FROM public.ee_audit_ledger l
            WHERE l.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$'
              AND (
                  (
                      l.user_id = person
                      AND (
                          strpos(l.target_urn, '@') > 0
                          OR l.target_urn !~ '^urn:kodera:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)+$'
                      )
                  )
                  OR (
                      (l.user_id = person OR l.organisation_id = ANY(target_orgs))
                      AND (
                          public.ee_audit_target_urn_matches_digests(l.target_urn, subject_sha256s)
                          OR EXISTS (
                              SELECT 1
                              FROM (
                                  SELECT lower(btrim(u.email)) AS needle
                                  FROM public.identity_user u WHERE u.id = person
                                  UNION
                                  SELECT lower(btrim(u.display_name)) AS needle
                                  FROM public.identity_user u
                                  WHERE u.id = person
                                    AND u.display_name IS NOT NULL
                                    AND char_length(btrim(u.display_name)) >= 3
                                  UNION
                                  SELECT lower(btrim(i.email)) AS needle
                                  FROM public.identity_identity i WHERE i.user_id = person
                                  UNION
                                  SELECT lower(person::text) AS needle
                                  UNION
                                  SELECT lower(i.id::text) AS needle
                                  FROM public.identity_identity i WHERE i.user_id = person
                                  UNION
                                  SELECT lower(btrim(i.subject)) AS needle
                                  FROM public.identity_identity i WHERE i.user_id = person
                              ) needles
                              WHERE needles.needle IS NOT NULL
                                AND needles.needle <> ''
                                AND needles.needle NOT LIKE 'erased:%'
                                AND strpos(lower(l.target_urn), needles.needle) > 0
                          )
                      )
                  )
              );

            SELECT COALESCE(jsonb_agg(l.id::text ORDER BY l.id::text), '[]'::jsonb)
            INTO actor_scrub_ids
            FROM public.ee_audit_ledger l
            WHERE l.actor_label <> ''
              AND l.actor_label NOT LIKE 'erased:%'
              AND l.actor_label <> 'erased'
              AND (
                  l.user_id = person
                  OR (
                      l.organisation_id = ANY(target_orgs)
                      AND (
                          subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                          OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                          OR EXISTS (
                              SELECT 1
                              FROM (
                                  SELECT lower(btrim(u.email)) AS needle
                                  FROM public.identity_user u WHERE u.id = person
                                  UNION
                                  SELECT lower(btrim(u.display_name)) AS needle
                                  FROM public.identity_user u
                                  WHERE u.id = person
                                    AND u.display_name IS NOT NULL
                                    AND char_length(btrim(u.display_name)) >= 3
                                  UNION
                                  SELECT lower(btrim(i.email)) AS needle
                                  FROM public.identity_identity i WHERE i.user_id = person
                                  UNION
                                  SELECT lower(person::text) AS needle
                                  UNION
                                  SELECT lower(i.id::text) AS needle
                                  FROM public.identity_identity i WHERE i.user_id = person
                                  UNION
                                  SELECT lower(btrim(i.subject)) AS needle
                                  FROM public.identity_identity i WHERE i.user_id = person
                              ) needles
                              WHERE needles.needle IS NOT NULL
                                AND needles.needle <> ''
                                AND needles.needle NOT LIKE 'erased:%'
                                AND (
                                    strpos(lower(l.actor_label), needles.needle) > 0
                                    OR strpos(lower(l.actor_id), needles.needle) > 0
                                )
                          )
                      )
                  )
              );
        END IF;

        NEW.inventory := NEW.inventory || jsonb_build_object(
            'ee_audit_target_org_ids', to_jsonb(target_org_texts),
            'ee_audit_subject_sha256s', subject_sha256s,
            'ee_audit_scrub_ids', scrub_ids,
            'ee_audit_target_scrub_ids', target_scrub_ids,
            'ee_audit_actor_scrub_ids', actor_scrub_ids
        );
        NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        subject_sha256s := COALESCE(NEW.inventory->'ee_audit_subject_sha256s', '[]'::jsonb);

        IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
            IF to_regclass('public.ee_audit_ledger') IS NOT NULL
               AND EXISTS (
                   SELECT 1
                   FROM public.ee_audit_ledger s
                   WHERE public.ee_audit_row_matches_erasure(
                       s.organisation_id,
                       s.id,
                       s.user_id,
                       s.actor_id,
                       s.actor_label,
                       s.target_urn,
                       s.metadata_json,
                       person
                   )
               )
            THEN
                master_key := public.ee_audit_resolve_erasure_master_key();
                hmac_key := decode(
                    public.ee_audit_hmac_sha256_hex(
                        master_key,
                        convert_to(
                            'kodera-ee-audit-target-urn-v2:account:'
                            || NEW.id::text || ':' || NEW.instruction_sha256,
                            'UTF8'
                        )
                    ),
                    'hex'
                );
                UPDATE public.ee_audit_ledger l
                SET actor_label = sub.next_actor_label,
                    target_urn = sub.next_target_urn,
                    source_ip = '',
                    metadata_json = '{}',
                    pii_scrubbed_at = COALESCE(l.pii_scrubbed_at, clock_timestamp()),
                    erasure_commitment = public.ee_audit_build_erasure_seal(
                        master_key,
                        'account',
                        NEW.id,
                        NEW.instruction_sha256,
                        NEW.inventory_sha256,
                        l.organisation_id,
                        l.seq,
                        l.event_id,
                        l.occurred_at,
                        l.tenant_slug,
                        l.actor_type,
                        l.actor_id,
                        sub.next_actor_label,
                        l.action,
                        sub.next_target_urn,
                        l.prev_hash,
                        l.entry_hash
                    )
                FROM (
                    SELECT s.id,
                           CASE
                               WHEN s.user_id = person
                                    OR COALESCE(NEW.inventory->'ee_audit_actor_scrub_ids', '[]'::jsonb) ? (s.id::text)
                                    OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(s.actor_id)), 'UTF8')), 'hex')
                                    OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(s.actor_label)), 'UTF8')), 'hex')
                               THEN 'erased:' || person::text
                               ELSE s.actor_label
                           END AS next_actor_label,
                           CASE
                               WHEN public.ee_audit_row_requires_target_scrub(
                                   s.id, s.user_id, s.target_urn, person, NEW.inventory
                               )
                               THEN public.ee_audit_scrub_target_urn(s.target_urn, hmac_key)
                               ELSE s.target_urn
                           END AS next_target_urn
                    FROM public.ee_audit_ledger s
                    WHERE public.ee_audit_row_matches_erasure(
                        s.organisation_id,
                        s.id,
                        s.user_id,
                        s.actor_id,
                        s.actor_label,
                        s.target_urn,
                        s.metadata_json,
                        person
                    )
                    AND (
                        s.pii_scrubbed_at IS NULL
                        OR s.erasure_commitment IS NULL
                        OR s.metadata_json <> '{}'
                        OR s.source_ip <> ''
                        OR public.ee_audit_row_requires_target_scrub(
                            s.id, s.user_id, s.target_urn, person, NEW.inventory
                        )
                        OR (
                            (
                                s.user_id = person
                                OR COALESCE(NEW.inventory->'ee_audit_actor_scrub_ids', '[]'::jsonb) ? (s.id::text)
                                OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(s.actor_id)), 'UTF8')), 'hex')
                                OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(s.actor_label)), 'UTF8')), 'hex')
                            )
                            AND s.actor_label IS DISTINCT FROM ('erased:' || person::text)
                        )
                    )
                ) sub
                WHERE l.id = sub.id;
                GET DIAGNOSTICS scrubbed_count = ROW_COUNT;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'ee_audit_subject_scrubbed', scrubbed_count
                );
            END IF;
        END IF;

        IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
            IF to_regclass('public.ee_audit_ledger') IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1
                    FROM public.ee_audit_ledger l
                    WHERE public.ee_audit_row_matches_erasure(
                        l.organisation_id,
                        l.id,
                        l.user_id,
                        l.actor_id,
                        l.actor_label,
                        l.target_urn,
                        l.metadata_json,
                        person
                    )
                    AND (
                        l.pii_scrubbed_at IS NULL
                        OR l.erasure_commitment IS NULL
                        OR l.metadata_json <> '{}'
                        OR l.source_ip <> ''
                        OR public.ee_audit_row_requires_target_scrub(
                            l.id, l.user_id, l.target_urn, person, NEW.inventory
                        )
                        OR (
                            (
                                l.user_id = person
                                OR COALESCE(NEW.inventory->'ee_audit_actor_scrub_ids', '[]'::jsonb) ? (l.id::text)
                                OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_id)), 'UTF8')), 'hex')
                                OR subject_sha256s ? encode(sha256(convert_to(lower(btrim(l.actor_label)), 'UTF8')), 'hex')
                            )
                            AND l.actor_label IS DISTINCT FROM ('erased:' || person::text)
                            AND l.actor_label IS DISTINCT FROM 'erased'
                        )
                    )
                ) THEN
                    RAISE EXCEPTION 'enterprise audit ledger subject personal data still present'
                        USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.ee_audit_erasure_journal_hook() FROM PUBLIC;

CREATE TRIGGER aa_03_ee_audit_erasure
    BEFORE INSERT OR UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.ee_audit_erasure_journal_hook();

CREATE TRIGGER aa_03_ee_audit_org_erasure
    BEFORE UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.ee_audit_erasure_journal_hook();

CREATE FUNCTION public.ee_scim_sync_member_contact(
    p_org uuid,
    p_user uuid,
    p_email text,
    p_display_name text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    clean_email text;
    clean_display text;
    shared_person boolean;
BEGIN
    IF p_org IS NULL OR p_user IS NULL THEN
        RAISE EXCEPTION 'scim contact sync requires organisation and user' USING ERRCODE = '23514';
    END IF;

    PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || p_org::text, 0));
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || p_user::text, 0)) THEN
        RAISE EXCEPTION 'account cutoff lock busy' USING ERRCODE = '55P03';
    END IF;
    IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = p_org)
       OR NOT EXISTS (
           SELECT 1 FROM public.orgs_organisation
           WHERE id = p_org AND state <> 'closed' AND deleted_at IS NULL
       ) THEN
        RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = p_user)
       OR NOT EXISTS (
           SELECT 1 FROM public.identity_user
           WHERE id = p_user AND enabled = TRUE AND deleted_at IS NULL AND email NOT LIKE 'erased:%'
       ) THEN
        RAISE EXCEPTION 'durable account cutoff refuses write' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.identity_identity i
        JOIN public.orgs_membership m
          ON m.organisation_id = i.organisation_id AND m.user_id = i.user_id
        WHERE i.organisation_id = p_org
          AND i.user_id = p_user
          AND i.deleted_at IS NULL
          AND m.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'scim contact sync target membership missing' USING ERRCODE = '23503';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.orgs_membership m
        WHERE m.organisation_id = p_org
          AND m.user_id = p_user
          AND m.deleted_at IS NULL
          AND m.role IN ('org_owner', 'org_billing')
    ) THEN
        RAISE EXCEPTION 'scim contact sync forbidden for protected role' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.ee_scim_user su
        WHERE su.organisation_id = p_org
          AND su.user_id = p_user
          AND su.provisioned_by_scim = TRUE
    ) THEN
        RAISE EXCEPTION 'scim contact sync requires scim-provisioned identity'
            USING ERRCODE = '42501';
    END IF;

    clean_email := CASE WHEN p_email IS NULL THEN NULL ELSE btrim(p_email) END;
    clean_display := CASE WHEN p_display_name IS NULL THEN NULL ELSE left(btrim(p_display_name), 200) END;

    IF clean_email IS NOT NULL AND clean_email <> '' THEN
        UPDATE public.identity_identity
        SET email = clean_email,
            updated_at = clock_timestamp()
        WHERE organisation_id = p_org
          AND user_id = p_user
          AND deleted_at IS NULL
          AND email IS DISTINCT FROM clean_email;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.identity_identity other
        WHERE other.user_id = p_user
          AND other.organisation_id IS DISTINCT FROM p_org
          AND other.deleted_at IS NULL
    ) INTO shared_person;

    IF NOT shared_person THEN
        IF clean_email IS NOT NULL AND clean_email <> '' AND clean_display IS NOT NULL THEN
            UPDATE public.identity_user
            SET email = clean_email,
                display_name = clean_display,
                updated_at = clock_timestamp()
            WHERE id = p_user
              AND (email IS DISTINCT FROM clean_email OR display_name IS DISTINCT FROM clean_display);
        ELSIF clean_email IS NOT NULL AND clean_email <> '' THEN
            UPDATE public.identity_user
            SET email = clean_email,
                updated_at = clock_timestamp()
            WHERE id = p_user
              AND email IS DISTINCT FROM clean_email;
        ELSIF clean_display IS NOT NULL THEN
            UPDATE public.identity_user
            SET display_name = clean_display,
                updated_at = clock_timestamp()
            WHERE id = p_user
              AND display_name IS DISTINCT FROM clean_display;
        END IF;
    END IF;
END
$$;
REVOKE ALL ON FUNCTION public.ee_scim_sync_member_contact(uuid, uuid, text, text) FROM PUBLIC;
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$
BEGIN
    LOCK TABLE public.orgs_privacyerasure, public.orgs_accounterasure IN SHARE MODE;
    IF EXISTS (
        SELECT 1 FROM public.orgs_accounterasure
        WHERE jsonb_array_length(COALESCE(inventory->'ee_audit_scrub_ids', '[]'::jsonb)) > 0
           OR jsonb_array_length(COALESCE(inventory->'ee_audit_target_scrub_ids', '[]'::jsonb)) > 0
           OR jsonb_array_length(COALESCE(inventory->'ee_audit_actor_scrub_ids', '[]'::jsonb)) > 0
           OR COALESCE((counts->>'ee_audit_subject_scrubbed')::bigint, 0) > 0
    )
    OR (
        to_regclass('public.ee_audit_ledger') IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM public.ee_audit_ledger
            WHERE erasure_commitment IS NOT NULL
               OR (
                   pii_scrubbed_at IS NOT NULL
                   AND target_urn ~ '^urn:kodera:[A-Za-z0-9._-]+:erased:[0-9a-f]{24}$'
               )
        )
    ) THEN
        RAISE EXCEPTION 'cannot downgrade enterprise audit erasure migration while admitted obligations exist'
            USING ERRCODE = '23514';
    END IF;
END
$$;

DROP TRIGGER IF EXISTS aa_03_ee_audit_org_erasure ON public.orgs_privacyerasure;
DROP TRIGGER IF EXISTS aa_03_ee_audit_erasure ON public.orgs_accounterasure;
DROP FUNCTION IF EXISTS public.ee_audit_erasure_journal_hook();
DROP FUNCTION IF EXISTS public.ee_scim_sync_member_contact(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.ee_privacy_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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

CREATE OR REPLACE FUNCTION public.ee_audit_ledger_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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

DROP FUNCTION IF EXISTS public.ee_audit_row_matches_erasure(uuid, uuid, uuid, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.ee_audit_row_requires_target_scrub(uuid, uuid, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.ee_audit_target_urn_matches_digests(text, jsonb);
DROP FUNCTION IF EXISTS public.ee_audit_scrub_target_urn(text, bytea);
DROP FUNCTION IF EXISTS public.ee_audit_build_erasure_seal(
    bytea, text, uuid, text, text, uuid, bigint, text, text, text, text, text, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.ee_audit_resolve_erasure_master_key();
DROP FUNCTION IF EXISTS public.ee_audit_hmac_sha256_hex(bytea, bytea);

DROP TRIGGER IF EXISTS a_resource_binding ON public.ee_scim_user;
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_user FOR EACH ROW
    EXECUTE FUNCTION public.ee_resource_binding_guard(
        'id', 'organisation_id', 'user_id', 'tenant_slug', 'created_at'
    );

DROP TRIGGER IF EXISTS a_resource_binding ON public.ee_scim_deprovision;
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.ee_scim_deprovision FOR EACH ROW
    EXECUTE FUNCTION public.ee_resource_binding_guard(
        'id', 'organisation_id', 'scim_user_id', 'user_id', 'tenant_slug', 'occurred_at'
    );

ALTER TABLE public.ee_scim_deprovision
    DROP COLUMN IF EXISTS provisioned_by_scim;

ALTER TABLE public.ee_scim_user
    DROP COLUMN IF EXISTS provisioned_by_scim;

ALTER TABLE public.ee_audit_ledger
    DROP CONSTRAINT IF EXISTS ee_audit_ledger_erasure_commitment_chk,
    DROP COLUMN IF EXISTS erasure_commitment;
"""


class Migration(migrations.Migration):
    dependencies = [("orgs", "0034_erasure_completeness_and_invitation_outbox")]
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

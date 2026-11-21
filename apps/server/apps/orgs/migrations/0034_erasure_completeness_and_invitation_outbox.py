"""Close GDPR Art. 17 erasure gaps across invitations, invitation outbox mail, idempotency records, and personal attachments."""

import hashlib
from uuid import UUID

from django.db import DatabaseError, migrations, transaction

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';

CREATE TABLE public.orgs_invitationoutboxbinding (
    delivery_id uuid PRIMARY KEY,
    invitation_id uuid NOT NULL,
    organisation_id uuid NOT NULL,
    recipient_email_sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT invitation_outbox_sha256_valid CHECK (recipient_email_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX invitation_outbox_inv_idx ON public.orgs_invitationoutboxbinding (invitation_id);
CREATE INDEX invitation_outbox_org_idx ON public.orgs_invitationoutboxbinding (organisation_id);
CREATE INDEX invitation_outbox_email_idx ON public.orgs_invitationoutboxbinding (recipient_email_sha256);

CREATE TABLE public.orgs_accountattachmenterasure (
    erasure_id uuid PRIMARY KEY,
    evidence_sha256 text NOT NULL,
    verified_at timestamptz NOT NULL,
    CONSTRAINT account_attachment_evidence_valid CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$')
);

DO $$
BEGIN
    IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
       AND to_regclass('public.outbox_message') IS NOT NULL THEN
        UPDATE public.outbox_message m
        SET sealed = NULL
        FROM public.outbox_outboxdelivery d
        WHERE m.delivery_id = d.id
          AND m.template_id IN ('invitation', 'invitation_account_ready')
          AND m.sealed IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = d.organisation_id
          );

        UPDATE public.outbox_outboxdelivery d
        SET status = 'failed',
            finished_at = COALESCE(d.finished_at, clock_timestamp()),
            updated_at = clock_timestamp()
        FROM public.outbox_message m
        WHERE m.delivery_id = d.id
          AND m.template_id IN ('invitation', 'invitation_account_ready')
          AND d.status = 'pending'
          AND EXISTS (
              SELECT 1 FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = d.organisation_id
          );

        INSERT INTO public.orgs_invitationoutboxbinding (
            delivery_id,
            invitation_id,
            organisation_id,
            recipient_email_sha256,
            created_at
        )
        SELECT
            d.id,
            inv.id,
            d.organisation_id,
            encode(sha256(convert_to(lower(btrim(inv.email)), 'UTF8')), 'hex'),
            d.created_at
        FROM public.outbox_outboxdelivery d
        JOIN public.outbox_message m ON m.delivery_id = d.id
        JOIN public.orgs_invitation inv ON inv.organisation_id = d.organisation_id
        WHERE m.template_id IN ('invitation', 'invitation_account_ready')
          AND inv.mail_enqueued_count > 0
          AND inv.email NOT LIKE 'erased+%@invalid.test'
          AND NOT EXISTS (
              SELECT 1 FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = d.organisation_id
          )
          AND (
              SELECT count(*) FROM public.orgs_invitation i2
              WHERE i2.organisation_id = d.organisation_id AND i2.mail_enqueued_count > 0
          ) = 1
          AND (
              SELECT count(*) FROM public.outbox_outboxdelivery d2
              JOIN public.outbox_message m2 ON m2.delivery_id = d2.id
              WHERE d2.organisation_id = d.organisation_id
                AND m2.template_id IN ('invitation', 'invitation_account_ready')
          ) = 1
        ON CONFLICT (delivery_id) DO NOTHING;

        UPDATE public.outbox_message m
        SET sealed = NULL
        FROM public.orgs_invitationoutboxbinding ib
        JOIN public.outbox_outboxdelivery d ON d.id = ib.delivery_id
        WHERE m.delivery_id = d.id
          AND m.sealed IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM public.orgs_accounterasure ae
              LEFT JOIN public.identity_user u ON u.id = ae.user_reference
              WHERE encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = ib.recipient_email_sha256
                 OR COALESCE(ae.inventory->'person_email_sha256s', '[]'::jsonb) ? ib.recipient_email_sha256
                 OR COALESCE(ae.inventory->'passport_email_sha256s', '[]'::jsonb) ? ib.recipient_email_sha256
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = d.organisation_id
          );

        UPDATE public.outbox_outboxdelivery d
        SET status = 'failed',
            finished_at = COALESCE(d.finished_at, clock_timestamp()),
            updated_at = clock_timestamp()
        FROM public.orgs_invitationoutboxbinding ib
        WHERE d.id = ib.delivery_id
          AND d.status = 'pending'
          AND EXISTS (
              SELECT 1 FROM public.orgs_accounterasure ae
              LEFT JOIN public.identity_user u ON u.id = ae.user_reference
              WHERE encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = ib.recipient_email_sha256
                 OR COALESCE(ae.inventory->'person_email_sha256s', '[]'::jsonb) ? ib.recipient_email_sha256
                 OR COALESCE(ae.inventory->'passport_email_sha256s', '[]'::jsonb) ? ib.recipient_email_sha256
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.orgs_privacyerasure pe
              WHERE pe.organisation_reference = d.organisation_id
          );
    END IF;
END $$;

CREATE FUNCTION public.invitation_outbox_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    uid uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'invitation outbox binding immutable' USING ERRCODE = '23514';
    END IF;

    IF public.privacy_erasure_context(NEW.organisation_id)
       OR EXISTS (
           SELECT 1 FROM public.retention_worker_context
           WHERE backend = pg_backend_pid() AND transaction = txid_current() AND purpose = 'account'
       ) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock_shared(
        hashtextextended('privacy_erasure_cutoff:' || NEW.organisation_id::text, 0)
    );
    FOR uid IN
        SELECT DISTINCT p.user_id FROM (
            SELECT u.id AS user_id FROM public.identity_user u
            WHERE encode(sha256(convert_to(lower(btrim(u.email)), 'UTF8')), 'hex') = NEW.recipient_email_sha256
            UNION
            SELECT i.user_id AS user_id FROM public.identity_identity i
            WHERE encode(sha256(convert_to(lower(btrim(i.email)), 'UTF8')), 'hex') = NEW.recipient_email_sha256
        ) p ORDER BY p.user_id
    LOOP
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('privacy_account_cutoff:' || uid::text, 0)
        );
        IF EXISTS (SELECT 1 FROM public.orgs_accounterasure WHERE user_reference = uid) THEN
            RAISE EXCEPTION 'invitation outbox binding account cutoff active' USING ERRCODE = '23514';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM public.orgs_accounterasure ae
        WHERE ae.status IN ('cutoff', 'core_purged')
          AND (
              COALESCE(ae.inventory->'person_email_sha256s', '[]'::jsonb) ? NEW.recipient_email_sha256
              OR COALESCE(ae.inventory->'passport_email_sha256s', '[]'::jsonb) ? NEW.recipient_email_sha256
          )
    ) THEN
        RAISE EXCEPTION 'invitation outbox binding account cutoff active' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.orgs_organisation o
        WHERE o.id = NEW.organisation_id AND o.state = 'active' AND o.deleted_at IS NULL
    ) OR EXISTS (
        SELECT 1 FROM public.orgs_privacyerasure pe
        WHERE pe.organisation_reference = NEW.organisation_id
    ) THEN
        RAISE EXCEPTION 'invitation outbox binding organisation cutoff active' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invitation_outbox_cutoff_guard() FROM PUBLIC;

CREATE TRIGGER aa_invitation_outbox_cutoff
    BEFORE INSERT OR UPDATE ON public.orgs_invitationoutboxbinding
    FOR EACH ROW EXECUTE FUNCTION public.invitation_outbox_cutoff_guard();

CREATE OR REPLACE FUNCTION public.privacy_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb:=to_jsonb(NEW); org uuid; parent uuid; uploader_person uuid; email_sha text;
BEGIN
 IF TG_TABLE_NAME='identity_identity' AND TG_OP='UPDATE' THEN
  IF public.privacy_account_context(OLD.user_id) AND NOT NEW.enabled
  AND ((to_jsonb(NEW)-ARRAY['enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['enabled','updated_at'])
   OR (NEW.email='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['email','enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','enabled','updated_at']))
   OR (NEW.subject='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['subject','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','updated_at']))) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_membership' AND TG_OP='UPDATE' THEN
  IF NEW.state='removed' AND EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=NEW.user_id)
  AND (to_jsonb(NEW)-ARRAY['state','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_privacyexport' AND TG_OP='UPDATE' THEN
  IF public.privacy_account_context(OLD.user_id) AND NEW.status='expired' AND NEW.checkpoint='{}'::jsonb AND NEW.revision=OLD.revision+1
  AND (to_jsonb(NEW)-ARRAY['status','checkpoint','revision','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','checkpoint','revision','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='support_supportticket' AND TG_OP='UPDATE' THEN
  IF OLD.created_by_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.id=OLD.created_by_id AND public.privacy_account_context(i.user_id))
  AND NEW.subject='' AND NEW.body='' AND NEW.reply_to_email IS NULL AND NEW.contact_email IS NULL AND NEW.content_erased_at IS NOT NULL
  AND (OLD.content_erased_at IS NULL OR NEW.content_erased_at IS NOT DISTINCT FROM OLD.content_erased_at)
  AND (to_jsonb(NEW)-ARRAY['subject','body','reply_to_email','contact_email','content_erased_at','updated_at'])
   IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','body','reply_to_email','contact_email','content_erased_at','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_invitation' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.membership_id IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.orgs_membership m WHERE m.id=OLD.membership_id AND public.privacy_account_context(m.user_id))
   AND NEW.email='erased+'||OLD.id||'@invalid.test' AND NEW.display_name IS NULL
   AND NEW.token_digest=decode('','hex') AND NEW.token_sealed=decode('','hex')
   AND (to_jsonb(NEW)-ARRAY['email','display_name','token_digest','token_sealed','updated_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','display_name','token_digest','token_sealed','updated_at']) THEN RETURN NEW; END IF;
   IF OLD.membership_id IS NULL
   AND EXISTS(SELECT 1 FROM public.retention_worker_context WHERE backend=pg_backend_pid() AND transaction=txid_current() AND purpose='account')
   AND (
    (NEW.state='revoked' AND NEW.revoked_at IS NOT NULL
     AND (to_jsonb(NEW)-ARRAY['state','revoked_at','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revoked_at','updated_at']))
    OR (NEW.email='erased+'||OLD.id||'@invalid.test' AND NEW.display_name IS NULL
     AND NEW.token_digest=decode('','hex') AND NEW.token_sealed=decode('','hex')
     AND NEW.state IN ('revoked','expired')
     AND (to_jsonb(NEW)-ARRAY['email','display_name','token_digest','token_sealed','state','revoked_at','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','display_name','token_digest','token_sealed','state','revoked_at','updated_at']))
   ) THEN RETURN NEW; END IF;
  END IF;
  IF (TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.email IS DISTINCT FROM OLD.email))
     AND NEW.email NOT LIKE 'erased+%@invalid.test'
     AND NOT public.privacy_erasure_context(NEW.organisation_id) THEN
   email_sha := encode(sha256(convert_to(lower(btrim(NEW.email)), 'UTF8')), 'hex');
   IF EXISTS(
    SELECT 1 FROM public.orgs_accounterasure ae
    WHERE ae.status IN ('cutoff','core_purged')
      AND (COALESCE(ae.inventory->'person_email_sha256s','[]'::jsonb) ? email_sha
        OR COALESCE(ae.inventory->'passport_email_sha256s','[]'::jsonb) ? email_sha)
   ) THEN
    RAISE EXCEPTION 'durable account cutoff refuses invitation write' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='media_attachment' THEN
  SELECT user_id INTO uploader_person FROM public.orgs_membership WHERE id=NEW.uploader_id;
  IF uploader_person IS NOT NULL THEN
   IF TG_OP='UPDATE' AND public.privacy_account_context(uploader_person)
      AND NEW.filename='erased-'||OLD.id||'.bin'
      AND (to_jsonb(NEW)-ARRAY['filename','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['filename','updated_at']) THEN
    RETURN NEW;
   END IF;
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:'||uploader_person::text,0));
   IF EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=uploader_person)
      AND NOT public.privacy_account_context(uploader_person)
      AND NOT public.privacy_erasure_context(NEW.organisation_id) THEN
    RAISE EXCEPTION 'durable account cutoff refuses media write' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;

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
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:'||org::text,0));
  IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org)
   AND NOT public.privacy_erasure_context(org) THEN
   RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.privacy_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.core_erasure_completeness_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    person uuid;
    org uuid;
    email_sha256s jsonb := '[]'::jsonb;
    principal_sha256s jsonb := '[]'::jsonb;
    non_accepted_inv_ids jsonb := '[]'::jsonb;
    inv_delivery_ids jsonb := '[]'::jsonb;
    personal_attachments jsonb := '[]'::jsonb;
    b2b_attachments jsonb := '[]'::jsonb;
    max_upload_exp timestamptz := NULL;
    c_idem bigint := 0;
    c_inv bigint := 0;
    c_b2b_att bigint := 0;
BEGIN
    IF TG_TABLE_NAME = 'orgs_accounterasure' THEN
        person := NEW.user_reference;

        IF TG_OP = 'INSERT' THEN
            SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
            INTO email_sha256s
            FROM (
                SELECT DISTINCT encode(sha256(convert_to(em, 'UTF8')), 'hex') AS sha
                FROM (
                    SELECT lower(btrim(u.email)) AS em FROM public.identity_user u WHERE u.id = person
                    UNION
                    SELECT lower(btrim(i.email)) AS em FROM public.identity_identity i WHERE i.user_id = person
                ) raw
                WHERE em IS NOT NULL AND em <> '' AND em NOT LIKE 'erased:%'
            ) d;

            SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
            INTO principal_sha256s
            FROM (
                SELECT DISTINCT encode(sha256(convert_to(i.issuer, 'UTF8') || decode('00', 'hex') || convert_to(i.subject, 'UTF8')), 'hex') AS sha
                FROM public.identity_identity i
                WHERE i.user_id = person AND i.subject NOT LIKE 'erased:%'
            ) p;

            SELECT COALESCE(jsonb_agg(inv.id::text ORDER BY inv.id), '[]'::jsonb)
            INTO non_accepted_inv_ids
            FROM public.orgs_invitation inv
            WHERE inv.state <> 'accepted'
              AND inv.email NOT LIKE 'erased+%@invalid.test'
              AND encode(sha256(convert_to(lower(btrim(inv.email)), 'UTF8')), 'hex') IN (
                  SELECT jsonb_array_elements_text(email_sha256s)
              );

            SELECT COALESCE(jsonb_agg(DISTINCT ib.delivery_id::text ORDER BY ib.delivery_id::text), '[]'::jsonb)
            INTO inv_delivery_ids
            FROM public.orgs_invitationoutboxbinding ib
            LEFT JOIN public.orgs_invitation inv ON inv.id = ib.invitation_id
            LEFT JOIN public.orgs_membership m ON m.id = inv.membership_id
            WHERE m.user_id = person
               OR ib.recipient_email_sha256 IN (SELECT jsonb_array_elements_text(email_sha256s))
               OR ib.invitation_id::text IN (SELECT jsonb_array_elements_text(non_accepted_inv_ids));

            IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL THEN
                IF EXISTS (
                    SELECT 1 FROM public.outbox_outboxdelivery d
                    WHERE d.id::text IN (SELECT jsonb_array_elements_text(inv_delivery_ids))
                      AND d.status = 'in_flight'
                ) THEN
                    RAISE EXCEPTION 'account erasure invitation delivery drain required'
                        USING ERRCODE = '23514';
                END IF;

                IF to_regclass('public.outbox_message') IS NOT NULL THEN
                    UPDATE public.outbox_message m
                    SET sealed = NULL
                    FROM public.outbox_outboxdelivery d
                    WHERE d.id::text IN (SELECT jsonb_array_elements_text(inv_delivery_ids))
                      AND m.delivery_id = d.id
                      AND m.sealed IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = d.organisation_id
                      );

                    UPDATE public.outbox_outboxdelivery d
                    SET status = 'failed',
                        finished_at = COALESCE(d.finished_at, clock_timestamp()),
                        updated_at = clock_timestamp()
                    WHERE d.id::text IN (SELECT jsonb_array_elements_text(inv_delivery_ids))
                      AND d.status = 'pending'
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = d.organisation_id
                      );
                END IF;
            END IF;

            UPDATE public.orgs_invitation
            SET state = 'revoked',
                revoked_at = COALESCE(revoked_at, clock_timestamp()),
                updated_at = clock_timestamp()
            WHERE id::text IN (SELECT jsonb_array_elements_text(non_accepted_inv_ids))
              AND state = 'pending';

            IF to_regclass('public.media_attachment') IS NOT NULL THEN
                SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'id', a.id::text,
                            'organisation_id', a.organisation_id::text,
                            'upload_expires_at', a.upload_expires_at
                        )
                        ORDER BY a.id
                    ),
                    '[]'::jsonb
                )
                INTO personal_attachments
                FROM public.media_attachment a
                JOIN public.orgs_membership m ON m.id = a.uploader_id
                JOIN public.orgs_organisation o ON o.id = a.organisation_id
                WHERE m.user_id = person
                  AND o.is_default_community;

                SELECT COALESCE(jsonb_agg(a.id::text ORDER BY a.id), '[]'::jsonb)
                INTO b2b_attachments
                FROM public.media_attachment a
                JOIN public.orgs_membership m ON m.id = a.uploader_id
                JOIN public.orgs_organisation o ON o.id = a.organisation_id
                WHERE m.user_id = person
                  AND NOT o.is_default_community;
            END IF;

            NEW.inventory := NEW.inventory || jsonb_build_object(
                'person_email_sha256s', email_sha256s,
                'identity_principal_sha256s', principal_sha256s,
                'non_accepted_invitation_ids', non_accepted_inv_ids,
                'invitation_delivery_ids', inv_delivery_ids,
                'account_personal_attachments', personal_attachments,
                'account_b2b_attachments', b2b_attachments
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            email_sha256s := COALESCE(
                NEW.inventory->'person_email_sha256s',
                NEW.inventory->'passport_email_sha256s',
                '[]'::jsonb
            );
            principal_sha256s := COALESCE(NEW.inventory->'identity_principal_sha256s', '[]'::jsonb);
            non_accepted_inv_ids := COALESCE(NEW.inventory->'non_accepted_invitation_ids', '[]'::jsonb);
            inv_delivery_ids := COALESCE(NEW.inventory->'invitation_delivery_ids', '[]'::jsonb);
            b2b_attachments := COALESCE(NEW.inventory->'account_b2b_attachments', '[]'::jsonb);

            IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
                IF to_regclass('public.idempotency_record') IS NOT NULL THEN
                    DELETE FROM public.idempotency_record r
                    WHERE EXISTS (
                        SELECT 1 FROM public.identity_identity i
                        WHERE i.user_id = person AND r.issuer = i.issuer AND r.subject = i.subject
                    ) OR encode(sha256(convert_to(r.issuer, 'UTF8') || decode('00', 'hex') || convert_to(r.subject, 'UTF8')), 'hex') IN (
                        SELECT jsonb_array_elements_text(principal_sha256s)
                    );
                    GET DIAGNOSTICS c_idem = ROW_COUNT;
                END IF;

                UPDATE public.orgs_invitation
                SET email = 'erased+' || id || '@invalid.test',
                    display_name = NULL,
                    token_digest = decode('', 'hex'),
                    token_sealed = decode('', 'hex'),
                    state = CASE WHEN state = 'pending' THEN 'revoked' ELSE state END,
                    revoked_at = CASE
                        WHEN state = 'pending' THEN COALESCE(revoked_at, clock_timestamp())
                        ELSE revoked_at
                    END,
                    updated_at = clock_timestamp()
                WHERE state <> 'accepted'
                  AND email NOT LIKE 'erased+%@invalid.test'
                  AND (
                      id::text IN (SELECT jsonb_array_elements_text(non_accepted_inv_ids))
                      OR encode(sha256(convert_to(lower(btrim(email)), 'UTF8')), 'hex') IN (
                          SELECT jsonb_array_elements_text(email_sha256s)
                      )
                  );
                GET DIAGNOSTICS c_inv = ROW_COUNT;

                IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
                   AND to_regclass('public.outbox_message') IS NOT NULL THEN
                    UPDATE public.outbox_message m
                    SET sealed = NULL
                    FROM public.outbox_outboxdelivery d
                    WHERE m.delivery_id = d.id
                      AND m.sealed IS NOT NULL
                      AND (
                          d.id::text IN (SELECT jsonb_array_elements_text(inv_delivery_ids))
                          OR EXISTS (
                              SELECT 1 FROM public.orgs_invitationoutboxbinding ib
                              WHERE ib.delivery_id = d.id
                                AND ib.recipient_email_sha256 IN (
                                    SELECT jsonb_array_elements_text(email_sha256s)
                                )
                          )
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = d.organisation_id
                      );

                    UPDATE public.outbox_outboxdelivery d
                    SET status = 'failed',
                        finished_at = COALESCE(d.finished_at, clock_timestamp()),
                        updated_at = clock_timestamp()
                    WHERE d.status = 'pending'
                      AND (
                          d.id::text IN (SELECT jsonb_array_elements_text(inv_delivery_ids))
                          OR EXISTS (
                              SELECT 1 FROM public.orgs_invitationoutboxbinding ib
                              WHERE ib.delivery_id = d.id
                                AND ib.recipient_email_sha256 IN (
                                    SELECT jsonb_array_elements_text(email_sha256s)
                                )
                          )
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM public.orgs_privacyerasure pe
                          WHERE pe.organisation_reference = d.organisation_id
                      );
                END IF;

                IF to_regclass('public.media_attachment') IS NOT NULL THEN
                    UPDATE public.media_attachment a
                    SET filename = 'erased-' || a.id || '.bin',
                        updated_at = clock_timestamp()
                    FROM public.orgs_membership m, public.orgs_organisation o
                    WHERE m.id = a.uploader_id
                      AND o.id = a.organisation_id
                      AND m.user_id = person
                      AND NOT o.is_default_community
                      AND a.filename <> 'erased-' || a.id || '.bin';
                    GET DIAGNOSTICS c_b2b_att = ROW_COUNT;
                END IF;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'idempotency_records', c_idem,
                    'invitation_contacts', c_inv,
                    'b2b_attachments_scrubbed', c_b2b_att
                );
            END IF;

            IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
                DELETE FROM public.orgs_invitationoutboxbinding
                WHERE delivery_id::text IN (SELECT jsonb_array_elements_text(inv_delivery_ids))
                   OR recipient_email_sha256 IN (SELECT jsonb_array_elements_text(email_sha256s));
            END IF;

            RETURN NEW;
        END IF;

    ELSIF TG_TABLE_NAME = 'orgs_privacyerasure' THEN
        org := NEW.organisation_reference;

        IF TG_OP = 'INSERT' THEN
            SELECT COALESCE(jsonb_agg(sha ORDER BY sha), '[]'::jsonb)
            INTO principal_sha256s
            FROM (
                SELECT DISTINCT encode(sha256(convert_to(i.issuer, 'UTF8') || decode('00', 'hex') || convert_to(i.subject, 'UTF8')), 'hex') AS sha
                FROM public.identity_identity i
                WHERE i.organisation_id = org AND i.subject NOT LIKE 'erased:%'
            ) p;

            IF to_regclass('public.media_attachment') IS NOT NULL THEN
                SELECT max(a.upload_expires_at)
                INTO max_upload_exp
                FROM public.media_attachment a
                WHERE a.organisation_id = org;
            END IF;

            IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL
               AND to_regclass('public.outbox_message') IS NOT NULL THEN
                UPDATE public.outbox_message m
                SET sealed = NULL
                FROM public.outbox_outboxdelivery d
                WHERE d.organisation_id = org
                  AND m.delivery_id = d.id
                  AND m.template_id IN ('invitation', 'invitation_account_ready')
                  AND m.sealed IS NOT NULL;

                UPDATE public.outbox_outboxdelivery d
                SET status = 'failed',
                    finished_at = COALESCE(d.finished_at, clock_timestamp()),
                    updated_at = clock_timestamp()
                FROM public.outbox_message m
                WHERE d.organisation_id = org
                  AND m.delivery_id = d.id
                  AND m.template_id IN ('invitation', 'invitation_account_ready')
                  AND d.status = 'pending';
            END IF;

            NEW.inventory := NEW.inventory || jsonb_build_object(
                'org_principal_sha256s', principal_sha256s,
                'org_attachment_max_upload_expires_at', to_jsonb(max_upload_exp)
            );
            NEW.inventory_sha256 := public.retention_inventory_digest(NEW.inventory);
            RETURN NEW;

        ELSIF TG_OP = 'UPDATE' THEN
            principal_sha256s := COALESCE(NEW.inventory->'org_principal_sha256s', '[]'::jsonb);

            IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
                IF to_regclass('public.idempotency_record') IS NOT NULL THEN
                    DELETE FROM public.idempotency_record r
                    WHERE r.issuer = (SELECT o.issuer FROM public.orgs_organisation o WHERE o.id = org)
                       OR (r.issuer LIKE 'urn:kodera:webhook:%' AND r.subject = org::text)
                       OR EXISTS (
                           SELECT 1 FROM public.identity_identity i
                           WHERE i.organisation_id = org AND r.issuer = i.issuer AND r.subject = i.subject
                       )
                       OR encode(sha256(convert_to(r.issuer, 'UTF8') || decode('00', 'hex') || convert_to(r.subject, 'UTF8')), 'hex') IN (
                           SELECT jsonb_array_elements_text(principal_sha256s)
                       );
                    GET DIAGNOSTICS c_idem = ROW_COUNT;
                END IF;

                IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL THEN
                    UPDATE public.outbox_outboxdelivery
                    SET status = 'failed',
                        finished_at = COALESCE(finished_at, clock_timestamp()),
                        updated_at = clock_timestamp()
                    WHERE organisation_id = org AND status = 'pending';
                END IF;

                NEW.counts := COALESCE(NEW.counts, '{}'::jsonb) || jsonb_build_object(
                    'idempotency_records', c_idem
                );
            END IF;

            IF OLD.status <> 'complete' AND NEW.status = 'complete' THEN
                DELETE FROM public.orgs_invitationoutboxbinding WHERE organisation_id = org;
            END IF;

            RETURN NEW;
        END IF;
    END IF;

    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.core_erasure_completeness_hook() FROM PUBLIC;

CREATE TRIGGER aa_02_core_erasure_v2
    BEFORE INSERT OR UPDATE ON public.orgs_privacyerasure
    FOR EACH ROW EXECUTE FUNCTION public.core_erasure_completeness_hook();

CREATE TRIGGER aa_02_core_erasure_v2
    BEFORE INSERT OR UPDATE ON public.orgs_accounterasure
    FOR EACH ROW EXECUTE FUNCTION public.core_erasure_completeness_hook();

CREATE FUNCTION public.privacy_confirm_account_attachments_erased(p_id uuid, p_evidence text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '3s' SET statement_timeout = '15s' AS $$
DECLARE
    request public.orgs_accounterasure%ROWTYPE;
    deleted_count bigint := 0;
BEGIN
    IF p_id IS NULL OR p_evidence IS NULL OR p_evidence !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'account attachment erasure evidence refused' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO request FROM public.orgs_accounterasure WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR request.core_purged_at IS NULL OR request.purge_not_before > clock_timestamp() THEN
        RAISE EXCEPTION 'account Core erasure protocol incomplete or not due' USING ERRCODE = '23514';
    END IF;
    IF request.inventory_sha256 IS DISTINCT FROM public.retention_inventory_digest(request.inventory) THEN
        RAISE EXCEPTION 'account erasure inventory digest mismatch' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(request.inventory->'account_personal_attachments', '[]'::jsonb)) elem
        WHERE elem->>'upload_expires_at' IS NOT NULL
          AND (elem->>'upload_expires_at')::timestamptz > clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'account attachment upload window still open' USING ERRCODE = '23514';
    END IF;
    IF to_regclass('public.media_attachment') IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.media_attachment a
            WHERE (
                a.id IN (
                    SELECT (elem->>'id')::uuid
                    FROM jsonb_array_elements(COALESCE(request.inventory->'account_personal_attachments', '[]'::jsonb)) elem
                ) OR EXISTS (
                    SELECT 1 FROM public.orgs_membership m
                    JOIN public.orgs_organisation o ON o.id = a.organisation_id
                    WHERE m.id = a.uploader_id
                      AND m.user_id = request.user_reference
                      AND o.is_default_community
                )
            ) AND a.upload_expires_at IS NOT NULL
              AND a.upload_expires_at > clock_timestamp()
        ) THEN
            RAISE EXCEPTION 'account attachment upload window still open' USING ERRCODE = '23514';
        END IF;
    END IF;

    INSERT INTO public.retention_worker_context
    VALUES (pg_backend_pid(), txid_current(), 'account', 'identity_user', request.user_reference, '{}');

    IF to_regclass('public.media_attachment') IS NOT NULL THEN
        DELETE FROM public.media_attachment a
        WHERE a.id IN (
            SELECT (elem->>'id')::uuid
            FROM jsonb_array_elements(COALESCE(request.inventory->'account_personal_attachments', '[]'::jsonb)) elem
        ) OR EXISTS (
            SELECT 1 FROM public.orgs_membership m
            JOIN public.orgs_organisation o ON o.id = a.organisation_id
            WHERE m.id = a.uploader_id
              AND m.user_id = request.user_reference
              AND o.is_default_community
        );
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
    END IF;

    INSERT INTO public.orgs_accountattachmenterasure (erasure_id, evidence_sha256, verified_at)
    VALUES (p_id, p_evidence, clock_timestamp())
    ON CONFLICT (erasure_id) DO UPDATE
    SET evidence_sha256 = EXCLUDED.evidence_sha256,
        verified_at = EXCLUDED.verified_at;

    UPDATE public.orgs_accounterasure
    SET counts = COALESCE(counts, '{}'::jsonb) || jsonb_build_object(
            'personal_attachments_deleted',
            COALESCE((counts->>'personal_attachments_deleted')::bigint, 0) + deleted_count
        ),
        updated_at = clock_timestamp()
    WHERE id = p_id;

    DELETE FROM public.retention_worker_context
    WHERE backend = pg_backend_pid()
      AND transaction = txid_current()
      AND purpose = 'account'
      AND source_table = 'identity_user'
      AND source_id = request.user_reference;

    RETURN deleted_count;
END $$;
REVOKE ALL ON FUNCTION public.privacy_confirm_account_attachments_erased(uuid, text) FROM PUBLIC;

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
 IF to_regclass('public.idempotency_record') IS NOT NULL THEN
  IF EXISTS(
   SELECT 1 FROM public.idempotency_record r
   WHERE r.issuer=(SELECT o.issuer FROM public.orgs_organisation o WHERE o.id=org)
      OR (r.issuer LIKE 'urn:kodera:webhook:%' AND r.subject=org::text)
      OR EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.organisation_id=org AND r.issuer=i.issuer AND r.subject=i.subject)
      OR encode(sha256(convert_to(r.issuer, 'UTF8') || decode('00', 'hex') || convert_to(r.subject, 'UTF8')), 'hex') IN (
       SELECT jsonb_array_elements_text(COALESCE(request.inventory->'org_principal_sha256s', '[]'::jsonb))
      )
  ) THEN
   RAISE EXCEPTION 'organisation idempotency records still present' USING ERRCODE='23514';
  END IF;
 END IF;
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
DECLARE request public.orgs_accounterasure%ROWTYPE; ee_pending boolean; email_shas jsonb; max_upload_exp timestamptz := NULL;
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
 SELECT max((elem->>'upload_expires_at')::timestamptz)
 INTO max_upload_exp
 FROM jsonb_array_elements(COALESCE(request.inventory->'account_personal_attachments', '[]'::jsonb)) elem
 WHERE elem->>'upload_expires_at' IS NOT NULL;
 IF jsonb_array_length(COALESCE(request.inventory->'account_personal_attachments', '[]'::jsonb)) > 0
 AND NOT EXISTS(
  SELECT 1 FROM public.orgs_accountattachmenterasure
  WHERE erasure_id=p_id
    AND verified_at>=greatest(request.cutoff_at, request.purge_not_before, COALESCE(max_upload_exp, request.cutoff_at))
 )
 THEN RETURN false; END IF;
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
 email_shas := COALESCE(request.inventory->'person_email_sha256s', request.inventory->'passport_email_sha256s', '[]'::jsonb);
 IF EXISTS(
  SELECT 1 FROM public.orgs_invitation inv
  WHERE inv.state <> 'accepted'
    AND (
     inv.id::text IN (SELECT jsonb_array_elements_text(COALESCE(request.inventory->'non_accepted_invitation_ids', '[]'::jsonb)))
     OR encode(sha256(convert_to(lower(btrim(inv.email)), 'UTF8')), 'hex') IN (SELECT jsonb_array_elements_text(email_shas))
    )
    AND (
     inv.email <> 'erased+' || inv.id || '@invalid.test'
     OR inv.display_name IS NOT NULL
     OR octet_length(inv.token_digest) <> 0
     OR octet_length(inv.token_sealed) <> 0
     OR inv.state = 'pending'
    )
 ) THEN RAISE EXCEPTION 'account non-accepted invitation contacts still present' USING ERRCODE='23514'; END IF;
 IF to_regclass('public.idempotency_record') IS NOT NULL THEN
  IF EXISTS(
   SELECT 1 FROM public.idempotency_record r
   WHERE EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.user_id=request.user_reference AND r.issuer=i.issuer AND r.subject=i.subject)
      OR encode(sha256(convert_to(r.issuer, 'UTF8') || decode('00', 'hex') || convert_to(r.subject, 'UTF8')), 'hex') IN (
       SELECT jsonb_array_elements_text(COALESCE(request.inventory->'identity_principal_sha256s', '[]'::jsonb))
      )
  ) THEN RAISE EXCEPTION 'account idempotency records still present' USING ERRCODE='23514'; END IF;
 END IF;
 IF to_regclass('public.media_attachment') IS NOT NULL THEN
  IF EXISTS(
   SELECT 1 FROM public.media_attachment a
   JOIN public.orgs_membership m ON m.id=a.uploader_id
   JOIN public.orgs_organisation o ON o.id=a.organisation_id
   WHERE m.user_id=request.user_reference
     AND (
      o.is_default_community
      OR a.filename <> 'erased-' || a.id || '.bin'
     )
  ) THEN RAISE EXCEPTION 'account attachment personal data still present' USING ERRCODE='23514'; END IF;
 END IF;
 IF to_regclass('public.outbox_outboxdelivery') IS NOT NULL AND to_regclass('public.outbox_message') IS NOT NULL THEN
  IF EXISTS(
   SELECT 1 FROM public.orgs_invitationoutboxbinding ib
   JOIN public.outbox_outboxdelivery d ON d.id=ib.delivery_id
   LEFT JOIN public.outbox_message m ON m.delivery_id=d.id
   WHERE (
    ib.delivery_id::text IN (SELECT jsonb_array_elements_text(COALESCE(request.inventory->'invitation_delivery_ids', '[]'::jsonb)))
    OR ib.recipient_email_sha256 IN (SELECT jsonb_array_elements_text(email_shas))
   ) AND (
    d.status='in_flight'
    OR m.sealed IS NOT NULL
    OR (d.status='pending' AND NOT EXISTS(SELECT 1 FROM public.orgs_privacyerasure pe WHERE pe.organisation_reference=d.organisation_id))
   )
  ) THEN RAISE EXCEPTION 'account invitation outbox personal data still present' USING ERRCODE='23514'; END IF;
 END IF;
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
    IF EXISTS (
        SELECT 1 FROM public.orgs_accounterasure
        WHERE status <> 'complete'
          AND (
              jsonb_array_length(COALESCE(inventory->'invitation_delivery_ids', '[]'::jsonb)) > 0
              OR jsonb_array_length(COALESCE(inventory->'account_personal_attachments', '[]'::jsonb)) > 0
          )
    ) THEN
        RAISE EXCEPTION 'cannot reverse erasure completeness guards while incomplete invitation or attachment erasure exists'
            USING ERRCODE = '23514';
    END IF;
END $$;

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

CREATE OR REPLACE FUNCTION public.privacy_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb:=to_jsonb(NEW); org uuid; parent uuid;
BEGIN
 IF TG_TABLE_NAME='identity_identity' AND TG_OP='UPDATE' THEN
  IF public.privacy_account_context(OLD.user_id) AND NOT NEW.enabled
  AND ((to_jsonb(NEW)-ARRAY['enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['enabled','updated_at'])
   OR (NEW.email='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['email','enabled','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','enabled','updated_at']))
   OR (NEW.subject='erased:'||OLD.id AND (to_jsonb(NEW)-ARRAY['subject','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','updated_at']))) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_membership' AND TG_OP='UPDATE' THEN
  IF NEW.state='removed' AND EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=NEW.user_id)
  AND (to_jsonb(NEW)-ARRAY['state','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_privacyexport' AND TG_OP='UPDATE' THEN
  IF public.privacy_account_context(OLD.user_id) AND NEW.status='expired' AND NEW.checkpoint='{}'::jsonb AND NEW.revision=OLD.revision+1
  AND (to_jsonb(NEW)-ARRAY['status','checkpoint','revision','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','checkpoint','revision','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='support_supportticket' AND TG_OP='UPDATE' THEN
  IF OLD.created_by_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.identity_identity i WHERE i.id=OLD.created_by_id AND public.privacy_account_context(i.user_id))
  AND NEW.subject='' AND NEW.body='' AND NEW.reply_to_email IS NULL AND NEW.contact_email IS NULL AND NEW.content_erased_at IS NOT NULL
  AND (OLD.content_erased_at IS NULL OR NEW.content_erased_at IS NOT DISTINCT FROM OLD.content_erased_at)
  AND (to_jsonb(NEW)-ARRAY['subject','body','reply_to_email','contact_email','content_erased_at','updated_at'])
   IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','body','reply_to_email','contact_email','content_erased_at','updated_at']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='orgs_invitation' AND TG_OP='UPDATE' THEN
  IF OLD.membership_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.orgs_membership m WHERE m.id=OLD.membership_id AND public.privacy_account_context(m.user_id))
  AND NEW.email='erased+'||OLD.id||'@invalid.test' AND NEW.display_name IS NULL
  AND NEW.token_digest=decode('','hex') AND NEW.token_sealed=decode('','hex')
  AND (to_jsonb(NEW)-ARRAY['email','display_name','token_digest','token_sealed','updated_at'])
   IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['email','display_name','token_digest','token_sealed','updated_at']) THEN RETURN NEW; END IF;
 END IF;

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
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:'||org::text,0));
  IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org)
   AND NOT public.privacy_erasure_context(org) THEN
   RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.privacy_cutoff_guard() FROM PUBLIC;

DROP FUNCTION IF EXISTS public.privacy_confirm_account_attachments_erased(uuid, text);
DROP TRIGGER IF EXISTS aa_02_core_erasure_v2 ON public.orgs_accounterasure;
DROP TRIGGER IF EXISTS aa_02_core_erasure_v2 ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS public.core_erasure_completeness_hook();
DROP TRIGGER IF EXISTS aa_invitation_outbox_cutoff ON public.orgs_invitationoutboxbinding;
DROP FUNCTION IF EXISTS public.invitation_outbox_cutoff_guard();
DROP TABLE IF EXISTS public.orgs_accountattachmenterasure;
DROP TABLE IF EXISTS public.orgs_invitationoutboxbinding;
"""


def _backfill_sealed_invitation_bindings(apps_registry, schema_editor) -> None:
    conn = schema_editor.connection
    with conn.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout='5s'")
        cursor.execute("SET LOCAL statement_timeout='30s'")
        cursor.execute(
            "SELECT to_regclass('public.outbox_outboxdelivery') IS NOT NULL "
            "AND to_regclass('public.outbox_message') IS NOT NULL "
            "AND to_regclass('public.orgs_invitationoutboxbinding') IS NOT NULL"
        )
        row = cursor.fetchone()
        if not row or not row[0]:
            return
        cursor.execute(
            "SELECT d.id, d.organisation_id, m.sealed "
            "FROM public.outbox_outboxdelivery d "
            "JOIN public.outbox_message m ON m.delivery_id = d.id "
            "WHERE m.template_id IN ('invitation', 'invitation_account_ready') "
            "  AND m.sealed IS NOT NULL "
            "  AND NOT EXISTS ("
            "      SELECT 1 FROM public.orgs_invitationoutboxbinding ib WHERE ib.delivery_id = d.id"
            "  ) "
            "ORDER BY d.id"
        )
        unbound = cursor.fetchall()
        if not unbound:
            return
        from apps.outbox.mail import seal
        from apps.outbox.sender import seal_key

        key = seal_key()
        if key is None:
            return

        for delivery_id, org_id, raw_sealed in unbound:
            try:
                opened = seal.unseal(key, delivery_id, bytes(raw_sealed))
            except seal.SealError:
                continue
            normalized_email = opened.recipient.strip().lower()
            recipient_sha = hashlib.sha256(normalized_email.encode("utf-8")).hexdigest()
            inv_id: UUID | None = None
            if (
                opened.secret.startswith(("inv1_", "kinv_"))
                and len(opened.secret) >= 42
                and opened.secret[41] == "_"
            ):
                try:
                    candidate_id = UUID(opened.secret[5:41])
                except ValueError:
                    candidate_id = None
                if candidate_id is not None:
                    cursor.execute(
                        "SELECT id FROM public.orgs_invitation WHERE id = %s AND organisation_id = %s",
                        [candidate_id, org_id],
                    )
                    found = cursor.fetchone()
                    if found is not None:
                        inv_id = found[0]
            if inv_id is None:
                cursor.execute(
                    "SELECT id FROM public.orgs_invitation "
                    "WHERE organisation_id = %s AND lower(btrim(email)) = %s "
                    "ORDER BY (state = 'pending') DESC, created_at DESC, id DESC LIMIT 1",
                    [org_id, normalized_email],
                )
                found = cursor.fetchone()
                if found is not None:
                    inv_id = found[0]
            if inv_id is None:
                continue
            try:
                with transaction.atomic(using=conn.alias):
                    cursor.execute(
                        "INSERT INTO public.orgs_invitationoutboxbinding "
                        "(delivery_id, invitation_id, organisation_id, recipient_email_sha256, created_at) "
                        "VALUES (%s, %s, %s, %s, clock_timestamp()) "
                        "ON CONFLICT (delivery_id) DO NOTHING",
                        [delivery_id, inv_id, org_id, recipient_sha],
                    )
            except DatabaseError:
                cursor.execute(
                    "UPDATE public.outbox_message SET sealed = NULL "
                    "WHERE delivery_id = %s AND NOT EXISTS ("
                    "    SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = %s"
                    ")",
                    [delivery_id, org_id],
                )
                cursor.execute(
                    "UPDATE public.outbox_outboxdelivery "
                    "SET status = 'failed', "
                    "    finished_at = COALESCE(finished_at, clock_timestamp()), "
                    "    updated_at = clock_timestamp() "
                    "WHERE id = %s AND status = 'pending' AND NOT EXISTS ("
                    "    SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference = %s"
                    ")",
                    [delivery_id, org_id],
                )


class Migration(migrations.Migration):
    dependencies = [("orgs", "0033_proximity_erasure_inventory")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunPython(_backfill_sealed_invitation_bindings, migrations.RunPython.noop),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

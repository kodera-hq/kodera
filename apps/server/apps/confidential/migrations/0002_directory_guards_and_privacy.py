"""Serialize directory evidence and extend the existing worker-owned erasure hooks."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_organisation_inventory(uuid)'::regprocedure)<>'b5c84807ce5c933c026f97258f7cd0c2318c76d921b4f524670df510fca426a1' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_organisation_inventory'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_account_inventory(uuid)'::regprocedure)<>'7a267638bafe662fb3202e94d33a47466b8e587be0111e086324563f823101d6' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_account_inventory'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_purge_organisation(uuid)'::regprocedure)<>'66a7da1db1988c66c8f2531bcb4e737ecea49d6ed8d3af237cda581f60aa0f69' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_purge_organisation'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_purge_account(uuid)'::regprocedure)<>'049fa4c8841e104d9137be07b38ba7f78edb2828ec3d1a0208239ff1b6fa2bfe' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_purge_account'; END IF;
END $$;

INSERT INTO public.confidential_mlsroomepoch (id,created_at,updated_at,room_id,epoch,commit_sequence,commit_digest,device_ids)
 SELECT gen_random_uuid(),r.created_at,r.created_at,r.id,0,0,encode(sha256(''::bytea),'hex'),'[]'::jsonb
 FROM public.e2ee_room r WHERE r.algorithm='io.kodera.mls.v1';
INSERT INTO public.confidential_mlsroomepoch (id,created_at,updated_at,room_id,epoch,commit_sequence,commit_digest,device_ids)
 SELECT gen_random_uuid(),e.created_at,e.created_at,e.room_id,e.epoch,e.sequence,encode(sha256(e.ciphertext),'hex'),
 coalesce((SELECT jsonb_agg(p.device_id::text ORDER BY p.device_id) FROM public.e2ee_participant p WHERE p.room_id=e.room_id AND p.joined_epoch<=e.epoch AND (p.left_epoch IS NULL OR p.left_epoch>e.epoch)),'[]'::jsonb)
 FROM public.e2ee_envelope e JOIN public.e2ee_room r ON r.id=e.room_id WHERE r.algorithm='io.kodera.mls.v1' AND e.kind='commit';
CREATE FUNCTION public.mls_directory_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_epoch bigint; expected_epoch bigint; org uuid;
BEGIN
 IF TG_TABLE_NAME='confidential_mlsroomepoch' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'MLS acceptance evidence is append only' USING ERRCODE='23514'; END IF;
  SELECT r.epoch,r.organisation_id INTO current_epoch,org FROM public.e2ee_room r WHERE r.id=NEW.room_id AND r.algorithm='io.kodera.mls.v1' FOR UPDATE;
  SELECT coalesce(max(epoch)+1,0) INTO expected_epoch FROM public.confidential_mlsroomepoch WHERE room_id=NEW.room_id;
  IF current_epoch IS DISTINCT FROM NEW.epoch OR NEW.epoch<>expected_epoch
   OR NEW.epoch>0 AND NOT EXISTS(SELECT 1 FROM public.e2ee_envelope e WHERE e.room_id=NEW.room_id AND e.epoch=NEW.epoch AND e.sequence=NEW.commit_sequence AND e.kind='commit' AND encode(sha256(e.ciphertext),'hex')=NEW.commit_digest)
  THEN RAISE EXCEPTION 'MLS epoch must match the next accepted commit' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT organisation_id INTO org FROM public.e2ee_device WHERE id=NEW.device_id AND revoked_at IS NULL FOR UPDATE;
  IF org IS NULL OR (TG_OP='INSERT' AND NEW.revision<>1) OR (TG_OP='UPDATE' AND (NEW.device_id<>OLD.device_id OR NEW.revision<>OLD.revision+1))
  THEN RAISE EXCEPTION 'verification bundle revision or device refused' USING ERRCODE='23514'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org)
 THEN RAISE EXCEPTION 'directory publication after erasure cutoff refused' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mls_directory_scope BEFORE INSERT OR UPDATE ON public.confidential_mlsroomepoch FOR EACH ROW EXECUTE FUNCTION public.mls_directory_guard();
CREATE TRIGGER mls_directory_scope BEFORE INSERT OR UPDATE ON public.confidential_deviceverificationbundle FOR EACH ROW EXECUTE FUNCTION public.mls_directory_guard();
CREATE OR REPLACE FUNCTION public.e2ee_purge_organisation(scope uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='{}'; n bigint;
BEGIN
 IF NOT public.privacy_erasure_context(scope) THEN RAISE EXCEPTION 'e2ee organisation purge requires worker context' USING ERRCODE='23514'; END IF;
 DELETE FROM public.confidential_deviceverificationbundle WHERE device_id IN (SELECT id FROM public.e2ee_device WHERE organisation_id=scope); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('verification_bundles',n);
 DELETE FROM public.confidential_mlsroomepoch WHERE room_id IN (SELECT id FROM public.e2ee_room WHERE organisation_id=scope); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('mls_epochs',n);
 DELETE FROM public.workspaces_sessioneviction WHERE organisation_id=scope OR agreement_id IN (SELECT id FROM public.workspaces_partnerchannelagreement WHERE organisation_id=scope OR partner_organisation_id=scope) OR guest_grant_id IN (SELECT g.id FROM public.workspaces_singlechannelguestgrant g JOIN public.identity_identity i ON i.id=g.guest_identity_id WHERE i.organisation_id=scope); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('session_evictions',n);
 DELETE FROM public.workspaces_partnerchannelagreementrevision WHERE agreement_id IN (SELECT id FROM public.workspaces_partnerchannelagreement WHERE organisation_id=scope OR partner_organisation_id=scope); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('partner_revisions',n);
 DELETE FROM public.workspaces_partnerchannelagreement WHERE organisation_id=scope OR partner_organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('partner_agreements',n);
 DELETE FROM public.workspaces_singlechannelguestgrant WHERE organisation_id=scope OR guest_identity_id IN (SELECT id FROM public.identity_identity WHERE organisation_id=scope); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('guest_grants',n);
 DELETE FROM public.e2ee_envelope WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_envelopes',n);
 DELETE FROM public.e2ee_keypackage WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_packages',n);
 DELETE FROM public.e2ee_participant WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_participants',n);
 DELETE FROM public.e2ee_room WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_rooms',n);
 DELETE FROM public.e2ee_device WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_devices',n);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_purge_organisation(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.e2ee_purge_account(person uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='{}'; n bigint;
BEGIN
 IF NOT public.privacy_account_context(person) THEN RAISE EXCEPTION 'e2ee account purge requires worker context' USING ERRCODE='23514'; END IF;
 UPDATE public.workspaces_singlechannelguestgrant SET revoked_at=coalesce(revoked_at,clock_timestamp()),updated_at=clock_timestamp() WHERE revoked_at IS NULL AND guest_identity_id IN (SELECT id FROM public.identity_identity WHERE user_id=person); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('guest_grants_revoked',n);
 DELETE FROM public.confidential_deviceverificationbundle WHERE device_id IN (SELECT d.id FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('verification_bundles',n);
 UPDATE public.e2ee_device SET revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE revoked_at IS NULL AND membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_devices_revoked',n);
 UPDATE public.e2ee_keypackage SET package=NULL,discarded_at=clock_timestamp(),updated_at=clock_timestamp() WHERE package IS NOT NULL AND device_id IN (SELECT d.id FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person);
 GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('e2ee_directory_packages_discarded',n);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_purge_account(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.e2ee_organisation_inventory(scope uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'mls_epochs',(SELECT count(*) FROM public.confidential_mlsroomepoch e JOIN public.e2ee_room r ON r.id=e.room_id WHERE r.organisation_id=scope),
 'verification_bundles',(SELECT count(*) FROM public.confidential_deviceverificationbundle b JOIN public.e2ee_device d ON d.id=b.device_id WHERE d.organisation_id=scope),
 'partner_agreements',(SELECT count(*) FROM public.workspaces_partnerchannelagreement WHERE organisation_id=scope OR partner_organisation_id=scope),
 'guest_grants',(SELECT count(*) FROM public.workspaces_singlechannelguestgrant g JOIN public.identity_identity i ON i.id=g.guest_identity_id WHERE g.organisation_id=scope OR i.organisation_id=scope),
 'devices',(SELECT count(*) FROM public.e2ee_device WHERE organisation_id=scope),
 'rooms',(SELECT count(*) FROM public.e2ee_room WHERE organisation_id=scope),
 'packages',(SELECT count(*) FROM public.e2ee_keypackage WHERE organisation_id=scope),
 'participants',(SELECT count(*) FROM public.e2ee_participant WHERE organisation_id=scope),
 'envelopes',(SELECT count(*) FROM public.e2ee_envelope WHERE organisation_id=scope))) $$;
REVOKE ALL ON FUNCTION public.e2ee_organisation_inventory(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.e2ee_account_inventory(person uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'guest_grants',(SELECT count(*) FROM public.workspaces_singlechannelguestgrant g JOIN public.identity_identity i ON i.id=g.guest_identity_id WHERE i.user_id=person),
 'verification_bundles',(SELECT count(*) FROM public.confidential_deviceverificationbundle b JOIN public.e2ee_device d ON d.id=b.device_id JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),
 'device_ids',coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),'[]'),
 'directory_packages',(SELECT count(*) FROM public.e2ee_keypackage p JOIN public.e2ee_device d ON d.id=p.device_id JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),
 'retained_policy','controller-owned encrypted history and public signature-verification metadata')) $$;
REVOKE ALL ON FUNCTION public.e2ee_account_inventory(uuid) FROM PUBLIC;

"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.confidential_mlsroomepoch) OR EXISTS(SELECT 1 FROM public.confidential_deviceverificationbundle)
 THEN RAISE EXCEPTION 'directory rollback refuses retained evidence'; END IF;
END $$;
DROP TRIGGER mls_directory_scope ON public.confidential_mlsroomepoch;
DROP TRIGGER mls_directory_scope ON public.confidential_deviceverificationbundle;
DROP FUNCTION public.mls_directory_guard();
CREATE OR REPLACE FUNCTION public.e2ee_purge_organisation(scope uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
CREATE OR REPLACE FUNCTION public.e2ee_purge_account(person uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
CREATE OR REPLACE FUNCTION public.e2ee_organisation_inventory(scope uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'devices',(SELECT count(*) FROM public.e2ee_device WHERE organisation_id=scope),
 'rooms',(SELECT count(*) FROM public.e2ee_room WHERE organisation_id=scope),
 'packages',(SELECT count(*) FROM public.e2ee_keypackage WHERE organisation_id=scope),
 'participants',(SELECT count(*) FROM public.e2ee_participant WHERE organisation_id=scope),
 'envelopes',(SELECT count(*) FROM public.e2ee_envelope WHERE organisation_id=scope))) $$;
REVOKE ALL ON FUNCTION public.e2ee_organisation_inventory(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.e2ee_account_inventory(person uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'device_ids',coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),'[]'),
 'directory_packages',(SELECT count(*) FROM public.e2ee_keypackage p JOIN public.e2ee_device d ON d.id=p.device_id JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),
 'retained_policy','controller-owned encrypted history and public signature-verification metadata')) $$;
REVOKE ALL ON FUNCTION public.e2ee_account_inventory(uuid) FROM PUBLIC;


"""


class Migration(migrations.Migration):
    dependencies = [("confidential", "0001_initial"), ("workspaces", "0020_governance_guards")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

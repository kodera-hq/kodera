"""Opaque zero-knowledge KVKB1 key-backup archive, monotonic epoch guards, and privacy erasure."""

import django.db.models.deletion
from django.db import migrations, models

import core.db.ids

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_organisation_inventory(uuid)'::regprocedure)<>'953036e5eed3b347102d81ba161ce82a2445354c55641e1ed1b0a4489370de9d' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_organisation_inventory'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_account_inventory(uuid)'::regprocedure)<>'0d120df3433abe92e4e4dcb56ac2b91ea48df3e797fe3f8852ed11598360cfc0' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_account_inventory'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_purge_organisation(uuid)'::regprocedure)<>'30c82f91e353ec00d7655192d960cb8c90d49fc2a3b103b37808938ef840307d' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_purge_organisation'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.e2ee_purge_account(uuid)'::regprocedure)<>'fc0cfb300867e4c8bb9ac9d7d3ac3aeaf79da7e903fcca35f56714f648d90919' THEN RAISE EXCEPTION 'privacy helper predecessor drift refused: e2ee_purge_account'; END IF;
END $$;

ALTER TABLE public.confidential_keybackuparchive ADD CONSTRAINT key_backup_capsule_bounds CHECK (capsule IS NULL OR octet_length(capsule) BETWEEN 42 AND 262144);

CREATE FUNCTION public.confidential_keybackup_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE member_user uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT public.privacy_erasure_context(OLD.organisation_id)
   AND NOT EXISTS(SELECT 1 FROM public.orgs_membership m WHERE m.id=OLD.membership_id AND public.privacy_account_context(m.user_id))
  THEN RAISE EXCEPTION 'key backup deletion requires privacy erasure worker context' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 SELECT m.user_id INTO member_user FROM public.orgs_membership m WHERE m.id=NEW.membership_id AND m.organisation_id=NEW.organisation_id;
 IF member_user IS NULL THEN RAISE EXCEPTION 'key backup membership scope mismatch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=NEW.organisation_id)
  OR EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=member_user)
 THEN RAISE EXCEPTION 'key backup mutation after erasure cutoff refused' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.organisation_id<>OLD.organisation_id OR NEW.membership_id<>OLD.membership_id)
 THEN RAISE EXCEPTION 'key backup scope is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.capsule IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.e2ee_device d WHERE d.id=NEW.source_device_id AND d.organisation_id=NEW.organisation_id AND d.membership_id=NEW.membership_id AND d.revoked_at IS NULL FOR SHARE)
  THEN RAISE EXCEPTION 'key backup source device refused' USING ERRCODE='23514'; END IF;
  IF NEW.discarded_at IS NOT NULL OR substring(NEW.capsule FROM 1 FOR 5)<>'KVKB1'::bytea OR encode(sha256(NEW.capsule),'hex')<>NEW.capsule_sha256
  THEN RAISE EXCEPTION 'key backup capsule integrity refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.backup_epoch<>1 THEN RAISE EXCEPTION 'initial key backup epoch must be 1' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW.backup_epoch<>OLD.backup_epoch+1 THEN RAISE EXCEPTION 'key backup epoch must advance monotonically' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'initial key backup cannot be discarded' USING ERRCODE='23514'; END IF;
  IF NEW.discarded_at IS NULL OR NEW.backup_epoch<>OLD.backup_epoch OR NEW.source_device_id<>OLD.source_device_id OR NEW.kdf_kind<>OLD.kdf_kind OR NEW.iterations<>OLD.iterations OR NEW.capsule_sha256<>OLD.capsule_sha256
  THEN RAISE EXCEPTION 'key backup discard must preserve epoch metadata' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER confidential_keybackup_scope BEFORE INSERT OR UPDATE OR DELETE ON public.confidential_keybackuparchive FOR EACH ROW EXECUTE FUNCTION public.confidential_keybackup_guard();

CREATE OR REPLACE FUNCTION public.e2ee_purge_organisation(scope uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:='{}'; n bigint;
BEGIN
 IF NOT public.privacy_erasure_context(scope) THEN RAISE EXCEPTION 'e2ee organisation purge requires worker context' USING ERRCODE='23514'; END IF;
 DELETE FROM public.confidential_keybackuparchive WHERE organisation_id=scope; GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('key_backups',n);
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
 DELETE FROM public.confidential_keybackuparchive WHERE membership_id IN (SELECT id FROM public.orgs_membership WHERE user_id=person); GET DIAGNOSTICS n=ROW_COUNT; result:=result||jsonb_build_object('key_backups',n);
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
 'key_backups',(SELECT count(*) FROM public.confidential_keybackuparchive WHERE organisation_id=scope),
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
 'key_backups',(SELECT count(*) FROM public.confidential_keybackuparchive b JOIN public.orgs_membership m ON m.id=b.membership_id WHERE m.user_id=person),
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
 IF EXISTS(SELECT 1 FROM public.confidential_keybackuparchive)
 THEN RAISE EXCEPTION 'key backup rollback refuses retained archive'; END IF;
END $$;
DROP TRIGGER confidential_keybackup_scope ON public.confidential_keybackuparchive;
DROP FUNCTION public.confidential_keybackup_guard();
ALTER TABLE public.confidential_keybackuparchive DROP CONSTRAINT key_backup_capsule_bounds;
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


class Migration(migrations.Migration):
    dependencies = [
        ("confidential", "0002_directory_guards_and_privacy"),
        ("orgs", "0031_account_erasure_completion"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            reverse_sql="SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
        migrations.CreateModel(
            name="KeyBackupArchive",
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
                ("backup_epoch", models.BigIntegerField()),
                ("kdf_kind", models.TextField()),
                ("iterations", models.IntegerField()),
                ("capsule_sha256", models.TextField()),
                ("capsule", models.BinaryField(null=True)),
                ("discarded_at", models.DateTimeField(null=True)),
                (
                    "membership",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.RESTRICT, to="orgs.membership"
                    ),
                ),
                (
                    "organisation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT, to="orgs.organisation"
                    ),
                ),
                (
                    "source_device",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.RESTRICT, to="e2ee.device"
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("backup_epoch__gte", 1)),
                        name="key_backup_epoch_positive",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(("iterations", 0), ("kdf_kind", "recovery-key")),
                            models.Q(
                                ("iterations__gte", 600000),
                                ("iterations__lte", 2000000),
                                ("kdf_kind", "passphrase"),
                            ),
                            _connector="OR",
                        ),
                        name="key_backup_kdf_valid",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("capsule_sha256__regex", "^[0-9a-f]{64}$")),
                        name="key_backup_sha256_hex",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(("capsule__isnull", False), ("discarded_at__isnull", True)),
                            models.Q(("capsule__isnull", True), ("discarded_at__isnull", False)),
                            _connector="OR",
                        ),
                        name="key_backup_discard_state",
                    ),
                ],
            },
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]

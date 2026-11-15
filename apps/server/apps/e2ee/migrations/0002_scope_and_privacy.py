"""Immutable tenant bindings, committed room counters and existing privacy protocol integration."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.e2ee_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_org uuid; parent_epoch bigint;
BEGIN
 IF TG_TABLE_NAME='e2ee_device' THEN
  IF NOT EXISTS(SELECT 1 FROM public.orgs_membership m JOIN public.identity_identity i ON i.user_id=m.user_id
    JOIN public.orgs_organisation o ON o.id=m.organisation_id
    WHERE m.id=NEW.membership_id AND i.id=NEW.identity_id AND m.organisation_id=NEW.organisation_id
    AND i.organisation_id=o.id AND i.issuer=o.issuer AND i.realm=o.realm)
  THEN RAISE EXCEPTION 'e2ee device authority scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
  THEN RAISE EXCEPTION 'e2ee device revocation is permanent' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='e2ee_room' THEN
  IF NOT EXISTS(SELECT 1 FROM public.workspaces_channel c JOIN public.workspaces_workspace w ON w.id=c.workspace_id
    WHERE c.id=NEW.channel_id AND w.organisation_id=NEW.organisation_id AND c.kind='text')
  THEN RAISE EXCEPTION 'e2ee room channel scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (NEW.epoch<>0 OR NEW.head_sequence<>0 OR NEW.rekey_required)
   OR TG_OP='UPDATE' AND (NEW.epoch<OLD.epoch OR NEW.epoch-OLD.epoch>1 OR NEW.head_sequence<OLD.head_sequence
       OR (OLD.rekey_required AND NOT NEW.rekey_required AND NEW.epoch=OLD.epoch))
  THEN RAISE EXCEPTION 'e2ee room transition refused' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='e2ee_keypackage' THEN
  SELECT organisation_id INTO parent_org FROM public.e2ee_device WHERE id=NEW.device_id;
  IF parent_org IS DISTINCT FROM NEW.organisation_id
   OR NEW.package IS NOT NULL AND NEW.reference IS DISTINCT FROM sha256(NEW.package)
   OR TG_OP='INSERT' AND NEW.package IS NULL
  THEN RAISE EXCEPTION 'e2ee package scope or reference refused' USING ERRCODE='23514'; END IF;
  IF NEW.claimed_for_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.e2ee_room r JOIN public.e2ee_device d ON d.organisation_id=r.organisation_id
    WHERE r.id=NEW.claimed_for_id AND d.id=NEW.claimed_by_id AND r.organisation_id=NEW.organisation_id)
  THEN RAISE EXCEPTION 'e2ee package claim scope refused' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.claimed_at IS NOT NULL AND (NEW.claimed_at,NEW.claimed_for_id,NEW.claimed_by_id,NEW.claimed_epoch)
       IS DISTINCT FROM (OLD.claimed_at,OLD.claimed_for_id,OLD.claimed_by_id,OLD.claimed_epoch)
    OR (OLD.package IS NULL AND NEW.package IS NOT NULL)
    OR (OLD.package IS NOT NULL AND NEW.package IS NOT NULL AND NEW.package IS DISTINCT FROM OLD.package)
    OR (OLD.discarded_at IS NOT NULL AND NEW.discarded_at IS DISTINCT FROM OLD.discarded_at)
   THEN RAISE EXCEPTION 'e2ee package claim and payload are single use' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  SELECT organisation_id,epoch INTO parent_org,parent_epoch FROM public.e2ee_room WHERE id=NEW.room_id;
  IF parent_org IS DISTINCT FROM NEW.organisation_id THEN RAISE EXCEPTION 'e2ee room scope refused' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='e2ee_participant' THEN
   IF NOT EXISTS(SELECT 1 FROM public.e2ee_device WHERE id=NEW.device_id AND organisation_id=NEW.organisation_id)
    OR NEW.joined_epoch>parent_epoch+1 OR NEW.left_epoch>parent_epoch+1
   THEN RAISE EXCEPTION 'e2ee participant scope refused' USING ERRCODE='23514'; END IF;
  ELSE
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'e2ee envelope is append only' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.e2ee_device WHERE id=NEW.sender_id AND organisation_id=NEW.organisation_id)
    OR NEW.recipient_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.e2ee_device WHERE id=NEW.recipient_id AND organisation_id=NEW.organisation_id)
    OR NEW.kind='application' AND NEW.epoch<>parent_epoch
    OR NEW.kind IN ('commit','welcome') AND NEW.epoch<>parent_epoch+1
   THEN RAISE EXCEPTION 'e2ee envelope scope or epoch refused' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_scope_guard() FROM PUBLIC;

CREATE FUNCTION public.e2ee_counter_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid; room public.e2ee_room%ROWTYPE; last_sequence bigint;
BEGIN
 IF TG_TABLE_NAME='e2ee_room' THEN target:=NEW.id; ELSE target:=NEW.room_id; END IF;
 SELECT * INTO room FROM public.e2ee_room WHERE id=target;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT coalesce(max(sequence),0) INTO last_sequence FROM public.e2ee_envelope WHERE room_id=target;
 IF room.head_sequence<>last_sequence OR EXISTS(SELECT 1 FROM public.e2ee_envelope WHERE room_id=target AND epoch>room.epoch)
  OR EXISTS(SELECT 1 FROM public.e2ee_participant WHERE room_id=target AND joined_epoch>room.epoch)
  OR room.epoch>0 AND NOT EXISTS(SELECT 1 FROM public.e2ee_envelope WHERE room_id=target AND kind='commit' AND epoch=room.epoch)
 THEN RAISE EXCEPTION 'e2ee committed counters require matching envelopes' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_counter_guard() FROM PUBLIC;

CREATE FUNCTION public.e2ee_cutoff_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE people uuid[]; person uuid;
BEGIN
 -- A leave-only transition cannot restore authority or disclose new content. It
 -- must remain available to retire an erased account's stale cryptographic leaf.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='e2ee_participant' THEN
  IF OLD.left_epoch IS NULL AND NEW.left_epoch IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['left_epoch','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['left_epoch','updated_at'])
  THEN RETURN NEW; END IF;
 END IF;
 -- Approved account cleanup changes only its own revocation/payload fields. Do
 -- not acquire another claimant's account fence: two account purges may share
 -- claims, and taking their fences in opposite ownership order would deadlock.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='e2ee_device' THEN
  SELECT user_id INTO person FROM public.orgs_membership WHERE id=NEW.membership_id;
  IF public.privacy_account_context(person) AND NEW.revoked_at IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['revoked_at','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','updated_at'])
  THEN RETURN NEW; END IF;
 ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='e2ee_keypackage' THEN
  SELECT m.user_id INTO person FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE d.id=NEW.device_id;
  IF public.privacy_account_context(person) AND NEW.package IS NULL AND NEW.discarded_at IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['package','discarded_at','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['package','discarded_at','updated_at'])
  THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='e2ee_device' THEN
  SELECT ARRAY[m.user_id] INTO people FROM public.orgs_membership m WHERE m.id=NEW.membership_id;
 ELSIF TG_TABLE_NAME IN ('e2ee_participant','e2ee_keypackage') THEN
  SELECT array_agg(DISTINCT m.user_id ORDER BY m.user_id) INTO people FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id
    WHERE d.id=NEW.device_id OR (TG_TABLE_NAME='e2ee_keypackage' AND d.id=(to_jsonb(NEW)->>'claimed_by_id')::uuid);
 ELSIF TG_TABLE_NAME='e2ee_envelope' THEN
  SELECT array_agg(DISTINCT m.user_id ORDER BY m.user_id) INTO people FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE d.id IN (NEW.sender_id,NEW.recipient_id);
 END IF;
 FOREACH person IN ARRAY coalesce(people,ARRAY[]::uuid[]) LOOP
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:'||person::text,0));
  IF EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE user_reference=person) AND NOT public.privacy_account_context(person)
  THEN RAISE EXCEPTION 'durable account cutoff refuses e2ee write' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:'||NEW.organisation_id::text,0));
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=NEW.organisation_id)
  AND NOT public.privacy_erasure_context(NEW.organisation_id)
 THEN RAISE EXCEPTION 'durable organisation cutoff refuses e2ee write' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.e2ee_cutoff_guard() FROM PUBLIC;

CREATE FUNCTION public.e2ee_organisation_inventory(scope uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'devices',(SELECT count(*) FROM public.e2ee_device WHERE organisation_id=scope),
 'rooms',(SELECT count(*) FROM public.e2ee_room WHERE organisation_id=scope),
 'packages',(SELECT count(*) FROM public.e2ee_keypackage WHERE organisation_id=scope),
 'participants',(SELECT count(*) FROM public.e2ee_participant WHERE organisation_id=scope),
 'envelopes',(SELECT count(*) FROM public.e2ee_envelope WHERE organisation_id=scope))) $$;
REVOKE ALL ON FUNCTION public.e2ee_organisation_inventory(uuid) FROM PUBLIC;
CREATE FUNCTION public.e2ee_account_inventory(person uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$ SELECT jsonb_build_object('e2ee',jsonb_build_object(
 'device_ids',coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM public.e2ee_device d JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),'[]'),
 'directory_packages',(SELECT count(*) FROM public.e2ee_keypackage p JOIN public.e2ee_device d ON d.id=p.device_id JOIN public.orgs_membership m ON m.id=d.membership_id WHERE m.user_id=person),
 'retained_policy','controller-owned encrypted history and public signature-verification metadata')) $$;
REVOKE ALL ON FUNCTION public.e2ee_account_inventory(uuid) FROM PUBLIC;

CREATE FUNCTION public.e2ee_purge_organisation(scope uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
CREATE FUNCTION public.e2ee_purge_account(person uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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

CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_device FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','membership_id','identity_id','signing_key');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_room FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','channel_id','algorithm');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_participant FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','room_id','device_id');
CREATE TRIGGER a_resource_binding BEFORE UPDATE ON public.e2ee_keypackage FOR EACH ROW EXECUTE FUNCTION public.privacy_resource_binding_guard('id','created_at','organisation_id','device_id','reference','expires_at');
"""

TABLES = ("device", "room", "participant", "keypackage", "envelope")
for table in TABLES:
    FORWARD += f"""
CREATE TRIGGER b_e2ee_scope BEFORE INSERT OR UPDATE ON public.e2ee_{table} FOR EACH ROW EXECUTE FUNCTION public.e2ee_scope_guard();
CREATE TRIGGER c_e2ee_cutoff BEFORE INSERT OR UPDATE ON public.e2ee_{table} FOR EACH ROW EXECUTE FUNCTION public.e2ee_cutoff_guard();
"""
for table in ("room", "participant", "envelope"):
    FORWARD += f"""
CREATE CONSTRAINT TRIGGER e2ee_committed_counters AFTER INSERT OR UPDATE ON public.e2ee_{table}
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.e2ee_counter_guard();
"""

INVENTORY_ANCHOR = "inventory:=inventory||jsonb_build_object('private_export_expiries',public.privacy_export_expiry_inventory(inventory->'private_exports'));"
EXTENSIONS = (
    (
        "privacy_begin_erasure(uuid,uuid,text,text,timestamptz,uuid)",
        INVENTORY_ANCHOR,
        "\n inventory:=inventory||public.e2ee_organisation_inventory(p_org);",
    ),
    (
        "privacy_begin_account_erasure(uuid,uuid,text,text,timestamptz,uuid)",
        INVENTORY_ANCHOR,
        "\n inventory:=inventory||public.e2ee_account_inventory(person);",
    ),
    (
        "privacy_purge_core(uuid)",
        " UPDATE public.orgs_privacyerasure SET status='core_purged'",
        " purged_counts:=purged_counts||public.e2ee_purge_organisation(org);\n",
    ),
    (
        "privacy_purge_account_core(uuid)",
        " UPDATE public.orgs_accounterasure SET status='core_purged'",
        " purged_counts:=purged_counts||public.e2ee_purge_account(person);\n",
    ),
)


def extend_protocol(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        for signature, anchor, addition in EXTENSIONS:
            cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", [signature])
            definition = cursor.fetchone()[0]
            if definition.count(anchor) != 1 or addition in definition:
                raise RuntimeError("privacy protocol integration anchor changed")
            replacement = (
                anchor + addition if signature.startswith("privacy_begin") else addition + anchor
            )
            cursor.execute(definition.replace(anchor, replacement))


REVERSE_GUARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$
BEGIN
 LOCK TABLE public.orgs_privacyerasure, public.orgs_accounterasure,
  public.orgs_erasurereceipt, public.orgs_accounterasurereceipt,
  public.e2ee_device, public.e2ee_room, public.e2ee_participant,
  public.e2ee_keypackage, public.e2ee_envelope IN SHARE MODE;
 IF EXISTS(SELECT 1 FROM public.orgs_privacyerasure WHERE inventory ? 'e2ee'
  OR counts ?| ARRAY['e2ee_devices','e2ee_rooms','e2ee_packages','e2ee_participants','e2ee_envelopes'])
 OR EXISTS(SELECT 1 FROM public.orgs_accounterasure WHERE inventory ? 'e2ee'
  OR counts ?| ARRAY['e2ee_devices_revoked','e2ee_directory_packages_discarded'])
 OR EXISTS(SELECT 1 FROM public.e2ee_device)
 OR EXISTS(SELECT 1 FROM public.e2ee_room)
 OR EXISTS(SELECT 1 FROM public.e2ee_participant)
 OR EXISTS(SELECT 1 FROM public.e2ee_keypackage)
 OR EXISTS(SELECT 1 FROM public.e2ee_envelope)
 THEN RAISE EXCEPTION 'cannot downgrade confidential relay privacy with retained resources or admitted erasure obligations' USING ERRCODE='23514'; END IF;
END $$;
"""


def restore_protocol(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(REVERSE_GUARD)
        for signature, _anchor, addition in reversed(EXTENSIONS):
            cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", [signature])
            definition = cursor.fetchone()[0]
            if definition.count(addition) != 1:
                raise RuntimeError("privacy protocol integration cannot be restored")
            cursor.execute(definition.replace(addition, ""))


REVERSE = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
for table in ("room", "participant", "envelope"):
    REVERSE += f"DROP TRIGGER e2ee_committed_counters ON public.e2ee_{table};\n"
for table in TABLES:
    REVERSE += f"DROP TRIGGER c_e2ee_cutoff ON public.e2ee_{table}; DROP TRIGGER b_e2ee_scope ON public.e2ee_{table};\n"
    if table != "envelope":
        REVERSE += f"DROP TRIGGER a_resource_binding ON public.e2ee_{table};\n"
REVERSE += """
DROP FUNCTION public.e2ee_purge_account(uuid);
DROP FUNCTION public.e2ee_purge_organisation(uuid);
DROP FUNCTION public.e2ee_account_inventory(uuid);
DROP FUNCTION public.e2ee_organisation_inventory(uuid);
DROP FUNCTION public.e2ee_cutoff_guard();
DROP FUNCTION public.e2ee_counter_guard();
DROP FUNCTION public.e2ee_scope_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("e2ee", "0001_initial"),
        ("orgs", "0033_proximity_erasure_inventory"),
    ]
    operations = [
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunPython(extend_protocol, restore_protocol),
    ]

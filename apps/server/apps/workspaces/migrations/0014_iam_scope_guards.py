"""Database tenant fences, privacy cutoff guards, Core erasure hook and bounded JSON shapes."""

from django.db import migrations

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = """
CREATE FUNCTION workspace_iam_permissions(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN jsonb_typeof(value) <> 'array' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value) item
        WHERE jsonb_typeof(item) <> 'string' OR item #>> '{}' NOT IN (
            'channel.history', 'channel.view', 'file.delete_any', 'file.delete_own', 'file.read', 'file.upload',
            'media.connect', 'media.moderate', 'media.share', 'media.speak', 'media.video',
            'message.delete_any', 'message.delete_own', 'message.edit_own', 'message.pin', 'message.post',
            'message.react', 'message.reply', 'message.search', 'manage_roles', 'view_audit_log'))
    AND jsonb_array_length(value) = (SELECT count(DISTINCT item) FROM jsonb_array_elements(value) item)
END;
$$;
REVOKE ALL ON FUNCTION workspace_iam_permissions(jsonb) FROM PUBLIC;
ALTER TABLE workspaces_workspacerole ADD CONSTRAINT workspace_role_permissions_valid CHECK (workspace_iam_permissions(permissions));
ALTER TABLE workspaces_workspacechannelroleoverride ADD CONSTRAINT workspace_override_permissions_valid CHECK (
    workspace_iam_permissions(allow) AND workspace_iam_permissions(deny));
CREATE FUNCTION workspace_iam_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN
    SELECT organisation_id INTO tenant FROM workspaces_workspace WHERE id=NEW.workspace_id;
    IF TG_OP='UPDATE' AND (NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id) THEN
        RAISE EXCEPTION 'IAM scope is immutable' USING ERRCODE='23514', CONSTRAINT='workspace_iam_binding_immutable';
    END IF;
    IF TG_TABLE_NAME='workspaces_workspacerole' THEN
        IF NEW.organisation_id <> tenant THEN
            RAISE EXCEPTION 'Role belongs to another organisation' USING ERRCODE='23514', CONSTRAINT='workspace_role_same_org';
        END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM workspaces_workspacerole WHERE id=NEW.role_id AND workspace_id=NEW.workspace_id) THEN
            RAISE EXCEPTION 'Role belongs to another workspace' USING ERRCODE='23514', CONSTRAINT='workspace_iam_role_scope';
        END IF;
        IF TG_TABLE_NAME='workspaces_workspacememberrole' THEN
            IF NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id=NEW.membership_id AND organisation_id=tenant) THEN
                RAISE EXCEPTION 'Member belongs to another organisation' USING ERRCODE='23514', CONSTRAINT='workspace_iam_member_scope';
            END IF;
        ELSE
            IF NOT EXISTS (SELECT 1 FROM workspaces_channel WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id) THEN
                RAISE EXCEPTION 'Channel belongs to another workspace' USING ERRCODE='23514', CONSTRAINT='workspace_iam_channel_scope';
            END IF;
            IF NEW.allow ?| ARRAY(SELECT jsonb_array_elements_text(NEW.deny)) THEN
                RAISE EXCEPTION 'Override conflicts' USING ERRCODE='23514', CONSTRAINT='workspace_override_disjoint';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_role_scope BEFORE INSERT OR UPDATE ON workspaces_workspacerole FOR EACH ROW EXECUTE FUNCTION workspace_iam_scope();
CREATE TRIGGER workspace_member_role_scope BEFORE INSERT OR UPDATE ON workspaces_workspacememberrole FOR EACH ROW EXECUTE FUNCTION workspace_iam_scope();
CREATE TRIGGER workspace_override_scope BEFORE INSERT OR UPDATE ON workspaces_workspacechannelroleoverride FOR EACH ROW EXECUTE FUNCTION workspace_iam_scope();
CREATE FUNCTION workspace_iam_cutoff_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb := to_jsonb(CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD ELSE NEW END); org uuid;
BEGIN
    IF item ? 'organisation_id' THEN
        org := (item->>'organisation_id')::uuid;
    ELSIF item ? 'workspace_id' THEN
        SELECT organisation_id INTO org FROM public.workspaces_workspace WHERE id=(item->>'workspace_id')::uuid;
    END IF;
    IF org IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || org::text, 0));
        IF EXISTS (SELECT 1 FROM public.orgs_privacyerasure WHERE organisation_reference=org)
           AND NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'durable erasure cutoff refuses write' USING ERRCODE='23514';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION workspace_iam_cutoff_guard() FROM PUBLIC;
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE OR DELETE ON workspaces_workspacerole FOR EACH ROW EXECUTE FUNCTION workspace_iam_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE OR DELETE ON workspaces_workspacememberrole FOR EACH ROW EXECUTE FUNCTION workspace_iam_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE OR DELETE ON workspaces_workspacechannelroleoverride FOR EACH ROW EXECUTE FUNCTION workspace_iam_cutoff_guard();
CREATE FUNCTION workspace_iam_erasure_hook() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE org uuid := NEW.organisation_reference;
BEGIN
    IF OLD.core_purged_at IS NULL AND NEW.core_purged_at IS NOT NULL THEN
        IF NOT public.privacy_erasure_context(org) THEN
            RAISE EXCEPTION 'workspace iam erasure requires worker authority' USING ERRCODE='23514';
        END IF;
        UPDATE public.workspaces_workspaceinvitelink
        SET auto_role_ids='[]'::jsonb, updated_at=clock_timestamp()
        WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org)
          AND auto_role_ids <> '[]'::jsonb;
        DELETE FROM public.workspaces_workspacechannelroleoverride
        WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
        DELETE FROM public.workspaces_workspacememberrole
        WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
        DELETE FROM public.workspaces_workspacerole
        WHERE workspace_id IN (SELECT id FROM public.workspaces_workspace WHERE organisation_id=org);
        UPDATE public.workspaces_workspace
        SET description='',
            banner_preset='',
            icon_mxc='',
            traits='[]'::jsonb,
            updated_at=clock_timestamp()
        WHERE organisation_id=org;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION workspace_iam_erasure_hook() FROM PUBLIC;
CREATE TRIGGER aa_03_workspace_iam_erasure BEFORE UPDATE ON public.orgs_privacyerasure FOR EACH ROW EXECUTE FUNCTION workspace_iam_erasure_hook();
CREATE FUNCTION workspace_iam_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE channel uuid; badge jsonb;
BEGIN
    IF length(NEW.description)>500 OR (NEW.banner_preset<>'' AND NEW.banner_preset !~ '^[a-z][a-z0-9_-]{0,63}$')
       OR (NEW.icon_mxc<>'' AND (length(NEW.icon_mxc)>512 OR NEW.icon_mxc !~ '^mxc://[a-zA-Z0-9.:-]+/[a-zA-Z0-9_-]+$')) THEN
        RAISE EXCEPTION 'Invalid workspace profile' USING ERRCODE='23514', CONSTRAINT='workspace_profile_valid';
    END IF;
    FOREACH channel IN ARRAY ARRAY[NEW.arrivals_channel_id, NEW.rules_channel_id, NEW.moderator_updates_channel_id, NEW.security_alerts_channel_id] LOOP
        IF channel IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces_channel WHERE id=channel AND workspace_id=NEW.id AND kind='text') THEN
            RAISE EXCEPTION 'Profile channel belongs to another workspace' USING ERRCODE='23514', CONSTRAINT='workspace_profile_channel_scope';
        END IF;
    END LOOP;
    IF jsonb_typeof(NEW.traits)<>'array' OR jsonb_array_length(NEW.traits)>5 THEN
        RAISE EXCEPTION 'Invalid traits' USING ERRCODE='23514', CONSTRAINT='workspace_profile_traits_valid';
    END IF;
    FOR badge IN SELECT jsonb_array_elements(NEW.traits) LOOP
        IF jsonb_typeof(badge)<>'object' OR NOT badge ?& ARRAY['icon','label']
           OR badge - ARRAY['icon','label'] <> '{}'::jsonb
           OR jsonb_typeof(badge->'icon')<>'string' OR jsonb_typeof(badge->'label')<>'string'
           OR length(btrim(badge->>'icon')) NOT BETWEEN 1 AND 32 OR length(btrim(badge->>'label')) NOT BETWEEN 1 AND 50 THEN
            RAISE EXCEPTION 'Invalid trait badge' USING ERRCODE='23514', CONSTRAINT='workspace_profile_traits_valid';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_iam_profile_guard BEFORE INSERT OR UPDATE ON workspaces_workspace FOR EACH ROW EXECUTE FUNCTION workspace_iam_profile_guard();
CREATE FUNCTION workspace_iam_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value jsonb; role_count integer;
BEGIN
    IF NEW.created_by_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM orgs_membership member JOIN workspaces_workspace workspace ON workspace.organisation_id=member.organisation_id
        WHERE member.id=NEW.created_by_id AND workspace.id=NEW.workspace_id) THEN
        RAISE EXCEPTION 'Invite creator belongs to another workspace' USING ERRCODE='23514', CONSTRAINT='workspace_invite_creator_scope';
    END IF;
    IF jsonb_typeof(NEW.auto_role_ids)<>'array' OR jsonb_array_length(NEW.auto_role_ids)>100 THEN
        RAISE EXCEPTION 'Invalid invite roles' USING ERRCODE='23514', CONSTRAINT='workspace_invite_roles_valid';
    END IF;
    FOR value IN SELECT jsonb_array_elements(NEW.auto_role_ids) LOOP
        IF jsonb_typeof(value)<>'string' OR NOT EXISTS (
            SELECT 1 FROM workspaces_workspacerole WHERE id::text=value #>> '{}' AND workspace_id=NEW.workspace_id) THEN
            RAISE EXCEPTION 'Invite role belongs to another workspace' USING ERRCODE='23514', CONSTRAINT='workspace_invite_role_scope';
        END IF;
    END LOOP;
    SELECT count(DISTINCT item) INTO role_count FROM jsonb_array_elements(NEW.auto_role_ids) item;
    IF role_count <> jsonb_array_length(NEW.auto_role_ids) THEN
        RAISE EXCEPTION 'Duplicate invite roles' USING ERRCODE='23514', CONSTRAINT='workspace_invite_roles_valid';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_iam_invite_guard BEFORE INSERT OR UPDATE ON workspaces_workspaceinvitelink FOR EACH ROW EXECUTE FUNCTION workspace_iam_invite_guard();
"""
REVERSE = """
DROP TRIGGER IF EXISTS workspace_iam_invite_guard ON workspaces_workspaceinvitelink;
DROP FUNCTION IF EXISTS workspace_iam_invite_guard();
DROP TRIGGER IF EXISTS workspace_iam_profile_guard ON workspaces_workspace;
DROP FUNCTION IF EXISTS workspace_iam_profile_guard();
DROP TRIGGER IF EXISTS aa_03_workspace_iam_erasure ON public.orgs_privacyerasure;
DROP FUNCTION IF EXISTS workspace_iam_erasure_hook();
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON workspaces_workspacechannelroleoverride;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON workspaces_workspacememberrole;
DROP TRIGGER IF EXISTS aa_privacy_cutoff ON workspaces_workspacerole;
DROP FUNCTION IF EXISTS workspace_iam_cutoff_guard();
DROP TRIGGER IF EXISTS workspace_override_scope ON workspaces_workspacechannelroleoverride;
DROP TRIGGER IF EXISTS workspace_member_role_scope ON workspaces_workspacememberrole;
DROP TRIGGER IF EXISTS workspace_role_scope ON workspaces_workspacerole;
DROP FUNCTION IF EXISTS workspace_iam_scope();
ALTER TABLE workspaces_workspacechannelroleoverride DROP CONSTRAINT workspace_override_permissions_valid;
ALTER TABLE workspaces_workspacerole DROP CONSTRAINT workspace_role_permissions_valid;
DROP FUNCTION IF EXISTS workspace_iam_permissions(jsonb);
"""


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0013_granular_iam")]
    operations = [migrations.RunSQL(TIMEOUTS + FORWARD, TIMEOUTS + REVERSE)]

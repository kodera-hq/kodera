"""Refuse cross-organisation moderation facts and cross-workspace invite scopes."""
from django.db import migrations

MEMBER_GUARD = """
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION workspace_moderation_member_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN
    SELECT organisation_id INTO tenant FROM workspaces_workspace WHERE id = NEW.workspace_id;
    IF NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id = NEW.membership_id AND organisation_id = tenant) THEN
        RAISE EXCEPTION 'Moderation membership is outside the workspace' USING ERRCODE='23514', CONSTRAINT='workspace_moderation_same_org';
    END IF;
    IF TG_TABLE_NAME = 'workspaces_workspaceabusereport' THEN
        IF NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id = NEW.reporter_id AND organisation_id = tenant)
           OR (NEW.resolved_by_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orgs_membership WHERE id = NEW.resolved_by_id AND organisation_id = tenant)) THEN
            RAISE EXCEPTION 'Report actor is outside the workspace' USING ERRCODE='23514', CONSTRAINT='workspace_report_same_org';
        END IF;
        IF NEW.channel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces_channel WHERE id = NEW.channel_id AND workspace_id = NEW.workspace_id) THEN
            RAISE EXCEPTION 'Report channel is outside the workspace' USING ERRCODE='23514', CONSTRAINT='workspace_report_same_workspace';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_moderator_scope BEFORE INSERT OR UPDATE ON workspaces_workspacemoderator FOR EACH ROW EXECUTE FUNCTION workspace_moderation_member_scope();
CREATE TRIGGER workspace_restriction_scope BEFORE INSERT OR UPDATE ON workspaces_workspacememberrestriction FOR EACH ROW EXECUTE FUNCTION workspace_moderation_member_scope();
CREATE TRIGGER workspace_report_scope BEFORE INSERT OR UPDATE ON workspaces_workspaceabusereport FOR EACH ROW EXECUTE FUNCTION workspace_moderation_member_scope();
CREATE FUNCTION workspace_invite_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.channel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces_channel WHERE id=NEW.channel_id AND workspace_id=NEW.workspace_id) THEN
        RAISE EXCEPTION 'Invite channel is outside the workspace' USING ERRCODE='23514', CONSTRAINT='workspace_invite_same_workspace';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_invite_scope BEFORE INSERT OR UPDATE ON workspaces_workspaceinvitelink FOR EACH ROW EXECUTE FUNCTION workspace_invite_scope();
CREATE FUNCTION workspace_redemption_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM workspaces_workspaceinvitelink link JOIN workspaces_workspace workspace ON workspace.id=link.workspace_id JOIN orgs_membership member ON member.organisation_id=workspace.organisation_id WHERE link.id=NEW.link_id AND member.id=NEW.membership_id) THEN
        RAISE EXCEPTION 'Redemption membership is outside the workspace' USING ERRCODE='23514', CONSTRAINT='workspace_redemption_same_org';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_redemption_scope BEFORE INSERT OR UPDATE ON workspaces_workspaceinviteredemption FOR EACH ROW EXECUTE FUNCTION workspace_redemption_scope();
"""

REVERSE = """
DROP TRIGGER workspace_redemption_scope ON workspaces_workspaceinviteredemption;
DROP FUNCTION workspace_redemption_scope();
DROP TRIGGER workspace_invite_scope ON workspaces_workspaceinvitelink;
DROP FUNCTION workspace_invite_scope();
DROP TRIGGER workspace_report_scope ON workspaces_workspaceabusereport;
DROP TRIGGER workspace_restriction_scope ON workspaces_workspacememberrestriction;
DROP TRIGGER workspace_moderator_scope ON workspaces_workspacemoderator;
DROP FUNCTION workspace_moderation_member_scope();
"""


class Migration(migrations.Migration):
    dependencies = [('workspaces', '0009_workspace_moderation')]
    operations = [migrations.RunSQL(MEMBER_GUARD, REVERSE)]

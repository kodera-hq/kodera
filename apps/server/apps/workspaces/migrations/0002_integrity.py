"""Install named parent-scope and immutable-identity guards with bounded locks."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE workspaces_workspace ADD CONSTRAINT workspace_organisation_fk
  FOREIGN KEY (organisation_id) REFERENCES orgs_organisation(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_category ADD CONSTRAINT category_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES workspaces_workspace(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_channel ADD CONSTRAINT channel_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES workspaces_workspace(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_channel ADD CONSTRAINT channel_category_workspace_fk
  FOREIGN KEY (category_id,workspace_id) REFERENCES workspaces_category(id,workspace_id)
  ON DELETE RESTRICT;

CREATE FUNCTION workspace_structure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='workspaces_workspace' THEN
    IF (NEW.id,NEW.organisation_id) IS DISTINCT FROM (OLD.id,OLD.organisation_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='workspace_binding_immutable',
        MESSAGE='Workspace identity and organisation are immutable';
    END IF;
  ELSIF TG_TABLE_NAME='workspaces_category' THEN
    IF (NEW.id,NEW.workspace_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='category_binding_immutable',
        MESSAGE='Category identity and workspace are immutable';
    END IF;
  ELSIF TG_TABLE_NAME='workspaces_channel' THEN
    IF (NEW.id,NEW.workspace_id,NEW.kind) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.kind) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='channel_binding_immutable',
        MESSAGE='Channel identity, workspace and kind are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_binding_immutable BEFORE UPDATE ON workspaces_workspace
  FOR EACH ROW EXECUTE FUNCTION workspace_structure_immutable();
CREATE TRIGGER category_binding_immutable BEFORE UPDATE ON workspaces_category
  FOR EACH ROW EXECUTE FUNCTION workspace_structure_immutable();
CREATE TRIGGER channel_binding_immutable BEFORE UPDATE ON workspaces_channel
  FOR EACH ROW EXECUTE FUNCTION workspace_structure_immutable();

CREATE FUNCTION workspace_channel_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='channel_delete_refused',
    MESSAGE='Channel deletion requires a separately admitted lifecycle';
END $$;
CREATE TRIGGER channel_delete_refused BEFORE DELETE ON workspaces_channel
  FOR EACH ROW EXECUTE FUNCTION workspace_channel_delete();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DROP TRIGGER channel_delete_refused ON workspaces_channel;
DROP TRIGGER channel_binding_immutable ON workspaces_channel;
DROP TRIGGER category_binding_immutable ON workspaces_category;
DROP TRIGGER workspace_binding_immutable ON workspaces_workspace;
DROP FUNCTION workspace_channel_delete();
DROP FUNCTION workspace_structure_immutable();
ALTER TABLE workspaces_channel DROP CONSTRAINT channel_category_workspace_fk;
ALTER TABLE workspaces_channel DROP CONSTRAINT channel_workspace_fk;
ALTER TABLE workspaces_category DROP CONSTRAINT category_workspace_fk;
ALTER TABLE workspaces_workspace DROP CONSTRAINT workspace_organisation_fk;
"""


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]

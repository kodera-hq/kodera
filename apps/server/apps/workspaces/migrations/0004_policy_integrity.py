"""Bind policy scope and serialize rule revisions under bounded migration locks."""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE workspaces_resourcepolicy ADD CONSTRAINT policy_workspace_fk
  FOREIGN KEY (workspace_id) REFERENCES workspaces_workspace(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_resourcepolicyrule ADD CONSTRAINT policy_rule_policy_fk
  FOREIGN KEY (policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_resourcepolicyrule ADD CONSTRAINT policy_rule_membership_fk
  FOREIGN KEY (membership_id) REFERENCES orgs_membership(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_workspace ADD CONSTRAINT workspace_default_policy_fk
  FOREIGN KEY (default_policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_category ADD CONSTRAINT category_default_policy_fk
  FOREIGN KEY (default_policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_channel ADD CONSTRAINT channel_explicit_policy_fk
  FOREIGN KEY (explicit_policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT;

CREATE FUNCTION workspace_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='policy_delete_refused',
      MESSAGE='Policy deletion requires a separately admitted lifecycle';
  END IF;
  IF (NEW.id,NEW.workspace_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='policy_binding_immutable',
      MESSAGE='Policy identity and workspace are immutable';
  END IF;
  IF OLD.revision=9223372036854775807 THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='policy_revision_exhausted',
      MESSAGE='Policy revision is exhausted';
  END IF;
  NEW.revision := OLD.revision+1;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_policy_guard BEFORE UPDATE OR DELETE ON workspaces_resourcepolicy
  FOR EACH ROW EXECUTE FUNCTION workspace_policy_guard();

CREATE FUNCTION workspace_policy_rule_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.policy_id) IS DISTINCT FROM (OLD.id,OLD.policy_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='policy_rule_binding_immutable',
      MESSAGE='Rule identity and policy are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_policy_rule_binding BEFORE UPDATE ON workspaces_resourcepolicyrule
  FOR EACH ROW EXECUTE FUNCTION workspace_policy_rule_binding();

CREATE FUNCTION workspace_policy_rule_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspaces_resourcepolicy p
      JOIN workspaces_workspace w ON w.id=p.workspace_id
      JOIN orgs_membership m ON m.id=NEW.membership_id
      WHERE p.id=NEW.policy_id AND m.organisation_id<>w.organisation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='policy_rule_scope_valid',
      MESSAGE='Rule membership must belong to the policy organisation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_policy_rule_scope BEFORE INSERT OR UPDATE ON workspaces_resourcepolicyrule
  FOR EACH ROW EXECUTE FUNCTION workspace_policy_rule_scope();

CREATE FUNCTION workspace_policy_rule_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target := OLD.policy_id;
  ELSE
    target := NEW.policy_id;
  END IF;
  -- UPDATE acquires the policy row lock. The BEFORE guard alone computes the
  -- increment, so exhaustion raises its named diagnostic before arithmetic.
  UPDATE workspaces_resourcepolicy SET revision=revision WHERE id=target;
  RETURN NULL;
END $$;
CREATE TRIGGER workspace_policy_rule_revision AFTER INSERT OR UPDATE OR DELETE
  ON workspaces_resourcepolicyrule FOR EACH ROW EXECUTE FUNCTION workspace_policy_rule_revision();

CREATE FUNCTION workspace_policy_binding_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  workspace uuid;
  diagnostic text;
BEGIN
  IF TG_TABLE_NAME='workspaces_workspace' THEN
    target := NEW.default_policy_id;
    workspace := NEW.id;
    diagnostic := 'workspace_default_policy_scope_valid';
  ELSIF TG_TABLE_NAME='workspaces_category' THEN
    target := NEW.default_policy_id;
    workspace := NEW.workspace_id;
    diagnostic := 'category_default_policy_scope_valid';
  ELSE
    target := NEW.explicit_policy_id;
    workspace := NEW.workspace_id;
    diagnostic := 'channel_explicit_policy_scope_valid';
  END IF;
  -- Missing targets are diagnosed by the actual named FK, not this scope guard.
  IF EXISTS (
    SELECT 1 FROM workspaces_resourcepolicy p WHERE p.id=target AND p.workspace_id<>workspace
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT=diagnostic,
      MESSAGE='Policy must belong to this workspace';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_policy_workspace_scope BEFORE INSERT OR UPDATE ON workspaces_workspace
  FOR EACH ROW EXECUTE FUNCTION workspace_policy_binding_scope();
CREATE TRIGGER workspace_policy_category_scope BEFORE INSERT OR UPDATE ON workspaces_category
  FOR EACH ROW EXECUTE FUNCTION workspace_policy_binding_scope();
CREATE TRIGGER workspace_policy_channel_scope BEFORE INSERT OR UPDATE ON workspaces_channel
  FOR EACH ROW EXECUTE FUNCTION workspace_policy_binding_scope();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DROP TRIGGER workspace_policy_channel_scope ON workspaces_channel;
DROP TRIGGER workspace_policy_category_scope ON workspaces_category;
DROP TRIGGER workspace_policy_workspace_scope ON workspaces_workspace;
DROP TRIGGER workspace_policy_rule_revision ON workspaces_resourcepolicyrule;
DROP TRIGGER workspace_policy_rule_scope ON workspaces_resourcepolicyrule;
DROP TRIGGER workspace_policy_rule_binding ON workspaces_resourcepolicyrule;
DROP TRIGGER workspace_policy_guard ON workspaces_resourcepolicy;
DROP FUNCTION workspace_policy_binding_scope();
DROP FUNCTION workspace_policy_rule_revision();
DROP FUNCTION workspace_policy_rule_scope();
DROP FUNCTION workspace_policy_rule_binding();
DROP FUNCTION workspace_policy_guard();
ALTER TABLE workspaces_channel DROP CONSTRAINT channel_explicit_policy_fk;
ALTER TABLE workspaces_category DROP CONSTRAINT category_default_policy_fk;
ALTER TABLE workspaces_workspace DROP CONSTRAINT workspace_default_policy_fk;
ALTER TABLE workspaces_resourcepolicyrule DROP CONSTRAINT policy_rule_membership_fk;
ALTER TABLE workspaces_resourcepolicyrule DROP CONSTRAINT policy_rule_policy_fk;
ALTER TABLE workspaces_resourcepolicy DROP CONSTRAINT policy_workspace_fk;
"""


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0003_policy_state")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]

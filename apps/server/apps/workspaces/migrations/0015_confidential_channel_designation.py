"""Immutable confidential channel designation on workspaces.Channel (BUG-0012)."""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = """
CREATE FUNCTION workspace_channel_confidential_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_confidential IS DISTINCT FROM OLD.is_confidential THEN
        RAISE EXCEPTION 'Channel confidential designation is immutable'
            USING ERRCODE='23514', CONSTRAINT='channel_confidential_immutable';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION workspace_channel_confidential_immutable() FROM PUBLIC;
CREATE TRIGGER channel_confidential_immutable
    BEFORE UPDATE ON workspaces_channel
    FOR EACH ROW EXECUTE FUNCTION workspace_channel_confidential_immutable();
"""

REVERSE = """
DROP TRIGGER IF EXISTS channel_confidential_immutable ON workspaces_channel;
DROP FUNCTION IF EXISTS workspace_channel_confidential_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0014_iam_scope_guards")]

    operations = [
        migrations.RunSQL(TIMEOUTS, migrations.RunSQL.noop),
        migrations.AddField(
            model_name="channel",
            name="is_confidential",
            field=models.BooleanField(default=False),
        ),
        migrations.AddConstraint(
            model_name="channel",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("is_confidential", False),
                    ("kind", "text"),
                    _connector="OR",
                ),
                name="channel_confidential_text_only",
            ),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunSQL(migrations.RunSQL.noop, TIMEOUTS),
    ]

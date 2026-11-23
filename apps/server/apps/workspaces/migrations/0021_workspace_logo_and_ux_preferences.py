"""Add workspace identity and default navigation without changing existing role grants."""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0020_governance_guards")]
    operations = [
        migrations.RunSQL("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';", migrations.RunSQL.noop),
        migrations.AddField("workspace", "display_name", models.TextField(default="", blank=True)),
        migrations.AddField("workspace", "logo_url", models.TextField(default="", blank=True)),
        migrations.AddField("workspace", "default_ui_mode", models.TextField(default="pro")),
        migrations.AddField("workspace", "default_channel_id", models.UUIDField(null=True, blank=True)),
        migrations.AddField("workspace", "allow_member_channel_creation", models.BooleanField(default=False)),
        migrations.AddField("workspace", "allow_member_invites", models.BooleanField(default=True)),
        migrations.AddField("workspace", "allow_link_previews", models.BooleanField(default=True)),
        migrations.RunSQL(
            """
            CREATE FUNCTION public.workspace_ux_guard() RETURNS trigger LANGUAGE plpgsql
            SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
              IF NEW.default_ui_mode NOT IN ('pro','messages')
                OR (NEW.display_name <> '' AND (length(NEW.display_name) NOT BETWEEN 2 AND 80 OR NEW.display_name <> btrim(NEW.display_name)))
                OR length(NEW.logo_url) > 2796236
                THEN RAISE EXCEPTION 'Invalid workspace preferences' USING ERRCODE='23514'; END IF;
              IF NEW.default_channel_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.workspaces_channel WHERE id=NEW.default_channel_id AND workspace_id=NEW.id AND kind='text' AND lifecycle IN ('active','provisioning'))
                THEN RAISE EXCEPTION 'Landing channel scope refused' USING ERRCODE='23514'; END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER workspace_ux_guard BEFORE INSERT OR UPDATE ON public.workspaces_workspace
              FOR EACH ROW EXECUTE FUNCTION public.workspace_ux_guard();
            """,
            "DROP TRIGGER workspace_ux_guard ON public.workspaces_workspace; DROP FUNCTION public.workspace_ux_guard();",
        ),
    ]

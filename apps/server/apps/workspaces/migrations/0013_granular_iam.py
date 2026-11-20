from django.db import migrations, models
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThan

import core.db.ids


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0033_proximity_erasure_inventory"),
        ("workspaces", "0012_quota_enforcement"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
            migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="workspace",
            name="arrivals_channel_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workspace",
            name="banner_preset",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="workspace",
            name="description",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="workspace",
            name="icon_mxc",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="workspace",
            name="invites_paused",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="workspace",
            name="moderator_updates_channel_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workspace",
            name="rules_channel_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workspace",
            name="security_alerts_channel_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="workspace",
            name="traits",
            field=models.JSONField(default=list),
        ),
        migrations.AddField(
            model_name="workspaceinvitelink",
            name="auto_role_ids",
            field=models.JSONField(default=list),
        ),
        migrations.AddField(
            model_name="workspaceinvitelink",
            name="created_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.RESTRICT,
                related_name="+",
                to="orgs.membership",
            ),
        ),
        migrations.CreateModel(
            name="WorkspaceRole",
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
                ("organisation_id", models.UUIDField()),
                ("name", models.TextField()),
                ("slug", models.SlugField(max_length=64)),
                (
                    "kind",
                    models.TextField(
                        choices=[("role", "Role"), ("subteam", "Sub-team"), ("tag", "Tag")],
                        default="role",
                    ),
                ),
                ("color", models.TextField(default="#808080")),
                ("icon", models.TextField(blank=True, default="")),
                ("position", models.IntegerField(default=0)),
                ("is_hoisted", models.BooleanField(default=False)),
                ("is_mentionable", models.BooleanField(default=False)),
                ("permissions", models.JSONField(blank=True, default=list)),
                (
                    "workspace",
                    models.ForeignKey(on_delete=models.RESTRICT, to="workspaces.workspace"),
                ),
            ],
        ),
        migrations.CreateModel(
            name="WorkspaceMemberRole",
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
                (
                    "membership",
                    models.ForeignKey(on_delete=models.RESTRICT, to="orgs.membership"),
                ),
                (
                    "workspace",
                    models.ForeignKey(on_delete=models.RESTRICT, to="workspaces.workspace"),
                ),
                (
                    "role",
                    models.ForeignKey(on_delete=models.CASCADE, to="workspaces.workspacerole"),
                ),
            ],
        ),
        migrations.CreateModel(
            name="WorkspaceChannelRoleOverride",
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
                ("allow", models.JSONField(default=list)),
                ("deny", models.JSONField(default=list)),
                (
                    "channel",
                    models.ForeignKey(on_delete=models.CASCADE, to="workspaces.channel"),
                ),
                (
                    "workspace",
                    models.ForeignKey(on_delete=models.RESTRICT, to="workspaces.workspace"),
                ),
                (
                    "role",
                    models.ForeignKey(on_delete=models.CASCADE, to="workspaces.workspacerole"),
                ),
            ],
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.UniqueConstraint(
                fields=("workspace", "slug"), name="workspace_role_slug_unique"
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("name__length__range", (1, 100)),
                    GreaterThan(
                        Length(
                            models.Func(
                                models.F("name"),
                                models.Value(" \t\n\r"),
                                function="BTRIM",
                                output_field=models.TextField(),
                            )
                        ),
                        models.Value(0),
                    ),
                ),
                name="workspace_role_name_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.CheckConstraint(
                condition=models.Q(("position__gte", 0)), name="workspace_role_position_valid"
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.CheckConstraint(
                condition=models.Q(("kind__in", ["role", "subteam", "tag"])),
                name="workspace_role_kind_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.CheckConstraint(
                condition=models.Q(("color__regex", "^#[0-9a-fA-F]{6}$")),
                name="workspace_role_color_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.CheckConstraint(
                condition=models.Q(("slug__regex", "^[a-z][a-z0-9_-]{0,63}$")),
                name="workspace_role_slug_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacerole",
            constraint=models.CheckConstraint(
                condition=models.Q(("icon__length__lte", 32)), name="workspace_role_icon_valid"
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacememberrole",
            constraint=models.UniqueConstraint(
                fields=("membership", "role"), name="workspace_member_role_unique"
            ),
        ),
        migrations.AddConstraint(
            model_name="workspacechannelroleoverride",
            constraint=models.UniqueConstraint(
                fields=("channel", "role"), name="workspace_channel_role_unique"
            ),
        ),
        migrations.RunSQL(
            migrations.RunSQL.noop,
            "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
        ),
    ]

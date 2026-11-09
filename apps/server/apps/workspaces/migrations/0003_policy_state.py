"""Declare normalized policy state without importing current application models."""

import core.db.ids
from django.db import migrations, models

CAPABILITIES = (
    "channel.history", "channel.view", "file.delete_any", "file.delete_own",
    "file.read", "file.upload", "media.connect", "media.moderate", "media.share",
    "media.speak", "media.video", "message.delete_any", "message.delete_own",
    "message.edit_own", "message.pin", "message.post", "message.react",
    "message.reply", "message.search",
)
TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


def stored_fields():
    return [
        ("id", models.UUIDField(default=core.db.ids.new_uuid7, editable=False,
                                primary_key=True, serialize=False)),
        ("created_at", models.DateTimeField(auto_now_add=True)),
        ("updated_at", models.DateTimeField(auto_now=True)),
    ]


def policy_binding():
    return models.ForeignKey(
        to="workspaces.resourcepolicy", on_delete=models.RESTRICT, db_constraint=False,
        null=True, blank=True, related_name="+",
    )


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0002_integrity")]
    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.CreateModel(
            name="ResourcePolicy",
            fields=[
                *stored_fields(),
                ("workspace", models.ForeignKey(
                    to="workspaces.workspace", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("revision", models.BigIntegerField(default=1)),
                ("visibility", models.TextField(
                    choices=[("organisation", "Organisation"), ("restricted", "Restricted")],
                    default="restricted",
                )),
            ],
            options={"constraints": [
                models.CheckConstraint(
                    name="policy_revision_valid", condition=models.Q(revision__gt=0),
                ),
                models.CheckConstraint(
                    name="policy_visibility_valid",
                    condition=models.Q(visibility__in=["organisation", "restricted"]),
                ),
            ]},
        ),
        migrations.CreateModel(
            name="ResourcePolicyRule",
            fields=[
                *stored_fields(),
                ("policy", models.ForeignKey(
                    to="workspaces.resourcepolicy", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("kind", models.TextField(choices=[
                    ("allow_member", "Allow member"), ("deny_member", "Deny member"),
                    ("deny_capability", "Deny capability"),
                ])),
                ("membership", models.ForeignKey(
                    to="orgs.membership", on_delete=models.RESTRICT, db_constraint=False,
                    null=True, blank=True,
                )),
                ("capability", models.TextField(null=True, blank=True)),
            ],
            options={"constraints": [
                models.CheckConstraint(
                    name="policy_rule_shape_valid",
                    condition=(
                        models.Q(kind__in=["allow_member", "deny_member"],
                                 membership__isnull=False, capability__isnull=True)
                        | models.Q(kind="deny_capability", membership__isnull=True,
                                   capability__isnull=False, capability__in=CAPABILITIES)
                    ),
                ),
                models.UniqueConstraint(
                    fields=["policy", "kind", "membership"],
                    condition=models.Q(membership__isnull=False), name="policy_rule_member_unique",
                ),
                models.UniqueConstraint(
                    fields=["policy", "kind", "capability"],
                    condition=models.Q(capability__isnull=False),
                    name="policy_rule_capability_unique",
                ),
            ]},
        ),
        migrations.AddField("workspace", "default_policy", policy_binding()),
        migrations.AddField("category", "default_policy", policy_binding()),
        migrations.AddField("channel", "explicit_policy", policy_binding()),
        migrations.AddField("channel", "policy_mode", models.TextField(
            choices=[("inherit", "Inherit"), ("explicit", "Explicit")], default="inherit",
        )),
        migrations.AddField("channel", "lifecycle", models.TextField(
            choices=[("provisioning", "Provisioning"), ("active", "Active"),
                     ("archived", "Archived"), ("deletion_pending", "Deletion pending"),
                     ("deleted", "Deleted")],
            default="provisioning",
        )),
        migrations.AddConstraint("channel", models.CheckConstraint(
            name="channel_policy_mode_valid",
            condition=(
                models.Q(policy_mode="inherit", explicit_policy__isnull=True)
                | models.Q(policy_mode="explicit", explicit_policy__isnull=False)
            ),
        )),
        migrations.AddConstraint("channel", models.CheckConstraint(
            name="channel_lifecycle_valid",
            condition=models.Q(lifecycle__in=[
                "provisioning", "active", "archived", "deletion_pending", "deleted",
            ]),
        )),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]

"""Espace structure administration (docs/specs/ESPACE_STRUCTURE.md §§4, 5, 9), under bounded locks.

- `category_position_unique` and `channel_position_unique` become DEFERRABLE INITIALLY DEFERRED, so
  a shift that passes through a temporary duplicate commits only when the end state is unique.
  PostgreSQL 16 alters only a foreign key's deferrability, so each is dropped and added again:
  a brief ACCESS EXCLUSIVE lock and an index build over one table of structure rows.
- `Channel.room_state`, `pending` for every row (a constant default, no rewrite), guarded by
  `channel_room_state_valid`, and the nullable `applied_access_etag`.
- `ChannelNotice`, the self-grant notices a channel membership set carries, with its two named
  RESTRICT foreign keys.
"""

import core.db.ids
from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FOREIGN_KEYS = r"""
ALTER TABLE workspaces_channelnotice ADD CONSTRAINT channel_notice_channel_fk
  FOREIGN KEY (channel_id) REFERENCES workspaces_channel(id) ON DELETE RESTRICT;
ALTER TABLE workspaces_channelnotice ADD CONSTRAINT channel_notice_membership_fk
  FOREIGN KEY (membership_id) REFERENCES orgs_membership(id) ON DELETE RESTRICT;
"""
DROP_FOREIGN_KEYS = r"""
ALTER TABLE workspaces_channelnotice DROP CONSTRAINT channel_notice_membership_fk;
ALTER TABLE workspaces_channelnotice DROP CONSTRAINT channel_notice_channel_fk;
"""


def category_position(**deferred):
    return models.UniqueConstraint(
        fields=("workspace", "position"), name="category_position_unique", **deferred
    )


def channel_position(**deferred):
    return models.UniqueConstraint(
        fields=("workspace", "category", "position"),
        name="channel_position_unique",
        nulls_distinct=False,
        **deferred,
    )


DEFERRED = {"deferrable": models.Deferrable.DEFERRED}


class Migration(migrations.Migration):
    dependencies = [
        ("orgs", "0012_validate_notice_contacts"),
        ("workspaces", "0005_template_key"),
    ]
    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.RemoveConstraint(model_name="category", name="category_position_unique"),
        migrations.AddConstraint(model_name="category", constraint=category_position(**DEFERRED)),
        migrations.RemoveConstraint(model_name="channel", name="channel_position_unique"),
        migrations.AddConstraint(model_name="channel", constraint=channel_position(**DEFERRED)),
        migrations.AddField(
            model_name="channel",
            name="room_state",
            field=models.TextField(
                choices=[("pending", "Pending"), ("ready", "Ready"), ("failed", "Failed")],
                default="pending",
            ),
        ),
        migrations.AddField(
            model_name="channel",
            name="applied_access_etag",
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddConstraint(
            model_name="channel",
            constraint=models.CheckConstraint(
                condition=models.Q(("room_state__in", ["pending", "ready", "failed"])),
                name="channel_room_state_valid",
            ),
        ),
        migrations.CreateModel(
            name="ChannelNotice",
            fields=[
                ("id", models.UUIDField(default=core.db.ids.new_uuid7, editable=False,
                                        primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("channel", models.ForeignKey(
                    to="workspaces.channel", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("membership", models.ForeignKey(
                    to="orgs.membership", on_delete=models.RESTRICT, db_constraint=False,
                )),
                ("acknowledged_at", models.DateTimeField(blank=True, null=True)),
            ],
            options={"constraints": [
                models.UniqueConstraint(
                    fields=("channel", "membership"),
                    condition=models.Q(("acknowledged_at__isnull", True)),
                    name="channel_notice_pending_unique",
                ),
            ]},
        ),
        migrations.RunSQL(FOREIGN_KEYS, reverse_sql=DROP_FOREIGN_KEYS),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]

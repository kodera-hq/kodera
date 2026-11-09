"""The revision of the channel set whose result last set a channel's room state
(docs/specs/ESPACE_STRUCTURE.md §13.3), under bounded locks.

A constant default, 0, so adding the column rewrites nothing; `channel_room_state_revision_valid`
holds it non-negative.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"


class Migration(migrations.Migration):
    dependencies = [("workspaces", "0006_espace_structure")]
    operations = [
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(
            model_name="channel",
            name="room_state_revision",
            field=models.BigIntegerField(default=0),
        ),
        migrations.AddConstraint(
            model_name="channel",
            constraint=models.CheckConstraint(
                condition=models.Q(("room_state_revision__gte", 0)),
                name="channel_room_state_revision_valid",
            ),
        ),
        migrations.RunSQL(TIMEOUTS, reverse_sql=TIMEOUTS),
    ]

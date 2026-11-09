"""Validate the command's channel-set foreign key that 0007 added `NOT VALID`
(docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE engine_intents_command VALIDATE CONSTRAINT engine_command_channel_set_fk;\n"
)


class Migration(migrations.Migration):
    dependencies = [("engine_intents", "0007_command_channel_set_fk")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

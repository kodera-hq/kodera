"""Validate the command's exactly-one-set check that 0004 added `NOT VALID` (docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE engine_intents_command VALIDATE CONSTRAINT engine_command_one_set;\n"
)


class Migration(migrations.Migration):
    dependencies = [("engine_intents", "0004_channel_sets")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

"""Validate the recorded subjects' shape check that 0002 added `NOT VALID` (docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE engine_intents_known_subject VALIDATE CONSTRAINT engine_known_subject_valid;\n"
)


class Migration(migrations.Migration):
    dependencies = [("engine_intents", "0002_member_set_anomalies")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

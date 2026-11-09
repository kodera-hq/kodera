"""Validate the subject check that 0004 added `NOT VALID` (docs/dev/MIGRATIONS.md §4).

`VALIDATE CONSTRAINT` takes a weaker lock than adding a validated check, so the scan of
`identity_identity` does not block its writers.
"""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE identity_identity VALIDATE CONSTRAINT identity_subject_valid;\n"
)


class Migration(migrations.Migration):
    dependencies = [("identity", "0004_subject_contract_shape")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

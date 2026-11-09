"""Validate the synthetic-prefix check separately from its brief exclusive-lock addition."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE orgs_organisation VALIDATE CONSTRAINT organisation_slug_not_synthetic;\n"
)


class Migration(migrations.Migration):
    dependencies = [("orgs", "0015_reserved_synthetic_prefix")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

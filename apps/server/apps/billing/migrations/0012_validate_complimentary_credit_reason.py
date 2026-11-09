"""Validate the credit-note reason check that 0011 added `NOT VALID` (docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE billing_creditnote VALIDATE CONSTRAINT billing_creditnote_reason_valid;\n"
)


class Migration(migrations.Migration):
    dependencies = [("billing", "0011_complimentary_credit_reason")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

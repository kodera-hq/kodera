"""Validate the credited-invoice check that 0008 added `NOT VALID` (docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE billing_invoice VALIDATE CONSTRAINT billing_invoice_credited_unpaid;\n"
)


class Migration(migrations.Migration):
    dependencies = [("billing", "0008_credit_notes")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

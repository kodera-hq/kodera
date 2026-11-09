"""Validate the payment and provider-event checks that 0005 added `NOT VALID` (docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

TIMEOUTS = "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
FORWARD = (
    TIMEOUTS
    + "ALTER TABLE billing_payment VALIDATE CONSTRAINT billing_payment_state_valid;\n"
    + "ALTER TABLE billing_providerevent VALIDATE CONSTRAINT billing_providerevent_kind_valid;\n"
    + TIMEOUTS
)


class Migration(migrations.Migration):
    dependencies = [("billing", "0009_validate_invoice_credited_unpaid")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

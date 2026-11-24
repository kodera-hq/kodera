"""Validate the append-only invoice and credit-note checks added `NOT VALID` in 0025 (docs/dev/MIGRATIONS.md §4)."""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE billing_creditnote VALIDATE CONSTRAINT billing_creditnote_vat_regime_valid;\n"
    "ALTER TABLE billing_creditnote VALIDATE CONSTRAINT billing_creditnote_reason_valid;\n"
    "ALTER TABLE billing_invoice VALIDATE CONSTRAINT billing_invoice_vat_regime_valid;\n"
)


class Migration(migrations.Migration):
    dependencies = [("billing", "0025_volet_a_boosts_and_volet_b_vip_connect")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

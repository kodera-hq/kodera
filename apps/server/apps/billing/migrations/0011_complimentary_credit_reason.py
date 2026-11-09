"""A credit note may be `complimentary` (BILLING_MODEL.md §4.2): the reason check widened as
docs/dev/MIGRATIONS.md §4 asks, dropped and added `NOT VALID` in one transaction, validated by
0012. Every existing row already satisfies the wider set."""

from django.db import migrations, models

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE billing_creditnote DROP CONSTRAINT billing_creditnote_reason_valid;\n"
    "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_reason_valid "
    "CHECK (reason IN ('customer_cancellation', 'unpaid_lapse', 'complimentary')) NOT VALID;\n"
)
# Refused while a complimentary credit note exists: the narrower check, NOT VALID, would let the
# row stay and then refuse every later update of it.
REVERSE = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "LOCK TABLE billing_creditnote IN SHARE ROW EXCLUSIVE MODE;\n"
    "DO $$ BEGIN\n"
    "  IF EXISTS (SELECT 1 FROM billing_creditnote WHERE reason = 'complimentary') THEN\n"
    "    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='complimentary credit notes exist; "
    "billing 0011 cannot be reversed';\n"
    "  END IF;\n"
    "END $$;\n"
    "ALTER TABLE billing_creditnote DROP CONSTRAINT billing_creditnote_reason_valid;\n"
    "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_reason_valid "
    "CHECK (reason IN ('customer_cancellation', 'unpaid_lapse')) NOT VALID;\n"
)


class Migration(migrations.Migration):
    dependencies = [("billing", "0010_validate_payment_constraint")]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunSQL(FORWARD, reverse_sql=REVERSE)],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name="creditnote", name="billing_creditnote_reason_valid"
                ),
                migrations.AddConstraint(
                    model_name="creditnote",
                    constraint=models.CheckConstraint(
                        condition=models.Q(
                            (
                                "reason__in",
                                ("customer_cancellation", "unpaid_lapse", "complimentary"),
                            )
                        ),
                        name="billing_creditnote_reason_valid",
                    ),
                ),
            ],
        )
    ]

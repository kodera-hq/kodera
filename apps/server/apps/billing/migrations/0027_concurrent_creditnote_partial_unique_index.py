"""Replace `billing_creditnote_one_per_invoice` with a partial unique index via `CONCURRENTLY` (docs/dev/MIGRATIONS.md §4)."""

from typing import Any

from django.db import migrations, models

SET_SESSION_TIMEOUTS = "SET lock_timeout = '5s'; SET statement_timeout = '30s';"
RESET_SESSION_TIMEOUTS = "RESET lock_timeout; RESET statement_timeout;"
SET_LOCAL_TIMEOUTS = "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';"

CREATE_PARTIAL_CONCURRENTLY = (
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "
    "billing_creditnote_one_non_refund_per_invoice_idx "
    "ON billing_creditnote (invoice_id) WHERE NOT (reason = 'refund');"
)
DROP_PARTIAL_CONCURRENTLY = (
    "DROP INDEX CONCURRENTLY IF EXISTS billing_creditnote_one_non_refund_per_invoice_idx;"
)
SWAP_TO_PARTIAL = (
    "BEGIN;\n"
    "SET LOCAL lock_timeout = '5s';\n"
    "SET LOCAL statement_timeout = '30s';\n"
    "DO $$\n"
    "BEGIN\n"
    "  IF NOT EXISTS (\n"
    "    SELECT 1\n"
    "    FROM pg_index i\n"
    "    JOIN pg_class c ON c.oid = i.indexrelid\n"
    "    JOIN pg_namespace n ON n.oid = c.relnamespace\n"
    "    WHERE n.nspname = current_schema()\n"
    "      AND c.relname = 'billing_creditnote_one_non_refund_per_invoice_idx'\n"
    "      AND i.indisvalid\n"
    "      AND i.indisready\n"
    "  ) THEN\n"
    "    RAISE EXCEPTION 'concurrent index billing_creditnote_one_non_refund_per_invoice_idx is missing or invalid';\n"
    "  END IF;\n"
    "END\n"
    "$$;\n"
    "ALTER TABLE billing_creditnote DROP CONSTRAINT IF EXISTS billing_creditnote_one_per_invoice;\n"
    "ALTER INDEX billing_creditnote_one_non_refund_per_invoice_idx "
    "RENAME TO billing_creditnote_one_per_invoice;\n"
    "COMMIT;"
)
CREATE_FULL_CONCURRENTLY = (
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "
    "billing_creditnote_one_per_invoice_full_idx "
    "ON billing_creditnote (invoice_id);"
)
DROP_FULL_CONCURRENTLY = (
    "DROP INDEX CONCURRENTLY IF EXISTS billing_creditnote_one_per_invoice_full_idx;"
)
SWAP_TO_FULL_CONSTRAINT = (
    "BEGIN;\n"
    "SET LOCAL lock_timeout = '5s';\n"
    "SET LOCAL statement_timeout = '30s';\n"
    "DO $$\n"
    "BEGIN\n"
    "  IF NOT EXISTS (\n"
    "    SELECT 1\n"
    "    FROM pg_index i\n"
    "    JOIN pg_class c ON c.oid = i.indexrelid\n"
    "    JOIN pg_namespace n ON n.oid = c.relnamespace\n"
    "    WHERE n.nspname = current_schema()\n"
    "      AND c.relname = 'billing_creditnote_one_per_invoice_full_idx'\n"
    "      AND i.indisvalid\n"
    "      AND i.indisready\n"
    "  ) THEN\n"
    "    RAISE EXCEPTION 'concurrent index billing_creditnote_one_per_invoice_full_idx is missing or invalid';\n"
    "  END IF;\n"
    "END\n"
    "$$;\n"
    "DROP INDEX IF EXISTS billing_creditnote_one_per_invoice;\n"
    "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_one_per_invoice "
    "UNIQUE USING INDEX billing_creditnote_one_per_invoice_full_idx;\n"
    "COMMIT;"
)

DROP_PARTIAL_IN_TX = "DROP INDEX IF EXISTS billing_creditnote_one_non_refund_per_invoice_idx;"
CREATE_PARTIAL_IN_TX = (
    "CREATE UNIQUE INDEX IF NOT EXISTS "
    "billing_creditnote_one_non_refund_per_invoice_idx "
    "ON billing_creditnote (invoice_id) WHERE NOT (reason = 'refund');"
)
SWAP_TO_PARTIAL_IN_TX = (
    "ALTER TABLE billing_creditnote DROP CONSTRAINT IF EXISTS billing_creditnote_one_per_invoice;\n"
    "ALTER INDEX billing_creditnote_one_non_refund_per_invoice_idx "
    "RENAME TO billing_creditnote_one_per_invoice;"
)
DROP_FULL_IN_TX = "DROP INDEX IF EXISTS billing_creditnote_one_per_invoice_full_idx;"
CREATE_FULL_IN_TX = (
    "CREATE UNIQUE INDEX IF NOT EXISTS "
    "billing_creditnote_one_per_invoice_full_idx "
    "ON billing_creditnote (invoice_id);"
)
SWAP_TO_FULL_IN_TX = (
    "DROP INDEX IF EXISTS billing_creditnote_one_per_invoice;\n"
    "ALTER TABLE billing_creditnote ADD CONSTRAINT billing_creditnote_one_per_invoice "
    "UNIQUE USING INDEX billing_creditnote_one_per_invoice_full_idx;"
)


def _forwards(apps: Any, schema_editor: Any) -> None:
    del apps
    if schema_editor.connection.in_atomic_block:
        schema_editor.execute(SET_LOCAL_TIMEOUTS)
        schema_editor.execute(DROP_PARTIAL_IN_TX)
        schema_editor.execute(CREATE_PARTIAL_IN_TX)
        schema_editor.execute(SWAP_TO_PARTIAL_IN_TX)
        return
    schema_editor.execute(SET_SESSION_TIMEOUTS)
    schema_editor.execute(DROP_PARTIAL_CONCURRENTLY)
    schema_editor.execute(CREATE_PARTIAL_CONCURRENTLY)
    schema_editor.execute(SWAP_TO_PARTIAL)
    schema_editor.execute(RESET_SESSION_TIMEOUTS)


def _backwards(apps: Any, schema_editor: Any) -> None:
    del apps
    if schema_editor.connection.in_atomic_block:
        schema_editor.execute(SET_LOCAL_TIMEOUTS)
        schema_editor.execute(DROP_PARTIAL_IN_TX)
        schema_editor.execute(DROP_FULL_IN_TX)
        schema_editor.execute(CREATE_FULL_IN_TX)
        schema_editor.execute(SWAP_TO_FULL_IN_TX)
        return
    schema_editor.execute(SET_SESSION_TIMEOUTS)
    schema_editor.execute(DROP_FULL_CONCURRENTLY)
    schema_editor.execute(CREATE_FULL_CONCURRENTLY)
    schema_editor.execute(SWAP_TO_FULL_CONSTRAINT)
    schema_editor.execute(DROP_PARTIAL_CONCURRENTLY)
    schema_editor.execute(RESET_SESSION_TIMEOUTS)


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("billing", "0026_validate_h3_1_append_only_constraints"),
    ]

    operations = [
        migrations.RunPython(_forwards, _backwards),
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name="creditnote",
                    name="billing_creditnote_one_per_invoice",
                ),
                migrations.AddConstraint(
                    model_name="creditnote",
                    constraint=models.UniqueConstraint(
                        condition=models.Q(("reason", "refund"), _negated=True),
                        fields=("invoice",),
                        name="billing_creditnote_one_per_invoice",
                    ),
                ),
            ],
        ),
    ]

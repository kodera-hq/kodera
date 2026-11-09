"""Validate the reserved-slug check that 0003 added `NOT VALID` (docs/dev/MIGRATIONS.md §4).

`VALIDATE CONSTRAINT` takes a weaker lock than adding a validated check, and runs here apart from
the drop and add so that their exclusive lock is not held during the scan.
"""

from django.db import migrations

FORWARD = (
    "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
    "ALTER TABLE tenancy_tenant VALIDATE CONSTRAINT tenancy_tenant_slug_not_reserved;\n"
)


class Migration(migrations.Migration):
    dependencies = [("tenancy", "0003_reserved_platform_labels")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

"""Validate the notice addresses' checks that 0011 added `NOT VALID` (docs/dev/MIGRATIONS.md §4).

`VALIDATE CONSTRAINT` takes a weaker lock than adding a validated check, and runs here apart from the
column additions so that their exclusive lock is not held during the scan.
"""

from django.db import migrations

FIELDS = ("security_contact_email", "privacy_contact_email", "subprocessor_notice_email")

FORWARD = "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n" + "".join(
    f"ALTER TABLE orgs_organisation VALIDATE CONSTRAINT organisation_{field}_valid;\n"
    for field in FIELDS
)


class Migration(migrations.Migration):
    dependencies = [("orgs", "0011_organisation_notice_contacts")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=migrations.RunSQL.noop)]

"""The durable erasure cutoff guard on the billing profile, this application's own table.

The statutory accounting records keep their own retention clock; only the profile, which is
customer contact data and not an accounting record, is fenced by the organisation cutoff of
orgs 0025. The trigger is installed here because this application depends on the audit writer.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON billing_billingprofile FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DROP TRIGGER aa_privacy_cutoff ON billing_billingprofile;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("billing", "0021_legal_retention_diagnostics"),
        ("orgs", "0025_durable_core_erasure"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

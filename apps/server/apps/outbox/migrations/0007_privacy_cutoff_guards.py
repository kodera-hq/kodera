"""The durable erasure and account cutoff guards on this application's own tables.

orgs 0025 and 0029 own the guard functions and the journals. The triggers on the delivery,
message and realm-access tables belong here: the queue applications are installed by profiles
that the customer applications' migrations must not depend on (orgs 0007).
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_outboxdelivery FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_message FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_realmaccount FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER aa_privacy_cutoff BEFORE INSERT OR UPDATE ON outbox_realmaccess FOR EACH ROW EXECUTE FUNCTION privacy_cutoff_guard();
CREATE TRIGGER ab_account_cutoff BEFORE INSERT OR UPDATE ON outbox_realmaccess FOR EACH ROW EXECUTE FUNCTION privacy_account_cutoff_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DROP TRIGGER ab_account_cutoff ON outbox_realmaccess;
DROP TRIGGER aa_privacy_cutoff ON outbox_realmaccess;
DROP TRIGGER aa_privacy_cutoff ON outbox_realmaccount;
DROP TRIGGER aa_privacy_cutoff ON outbox_message;
DROP TRIGGER aa_privacy_cutoff ON outbox_outboxdelivery;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("outbox", "0006_invitations"),
        ("orgs", "0029_account_erasure_guards"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

"""The audit table is append-only: docs/domain/AUDIT_TAXONOMY.md §1, docs/specs/JOB_QUEUE.md §6.

Each clause carries the marker of the test-only flag that disables it (§9.2). TRUNCATE is refused
by privilege, not by trigger, so that a test database can still be flushed.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION audit_auditevent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND /*guard:audit_update_allowed*/ true)
     OR (TG_OP = 'DELETE' AND /*guard:audit_delete_allowed*/ true) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='audit_auditevent_immutable', MESSAGE='An audit row never changes';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_auditevent_immutable BEFORE UPDATE OR DELETE ON audit_auditevent
  FOR EACH ROW EXECUTE FUNCTION audit_auditevent_guard();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER audit_auditevent_immutable ON audit_auditevent;
DROP FUNCTION audit_auditevent_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("audit", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]

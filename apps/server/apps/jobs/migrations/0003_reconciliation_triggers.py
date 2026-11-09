"""The job path's reconciliation guards, the delivery path's counterparts of §7: docs/specs/JOB_QUEUE.md
§5.4 and docs/domain/MODEL.md §8.

A decision row gains decided_txid, forced by a BEFORE INSERT trigger to the top-level transaction's
identifier, whatever the insert supplied. The same trigger validates decided_at, which the decision
function reads once it holds the job row, and never overwrites it: forcing it would hide a function
that read its clock too early. A job leaves needs_reconciliation only in an update that sets
reconciliation_decision_ref to a decision of its own, inserted in the same transaction, not the
reference it already carried, and mapped to the new status. Every guarded clause carries a marker,
/*guard:<flag>*/ true, as in 0002_guards.

decided_txid is NOT NULL with a one-off default of 0 that the column does not keep: the table is new
in the same release, and every row the trigger writes carries its own value.
"""

from django.db import migrations, models

TIMEOUTS = "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';"

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION jobs_jobreconciliationdecision_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest timestamptz;
BEGIN
  SELECT max(dispatched_at) INTO latest FROM jobs_jobdispatch WHERE job_id = NEW.job_id;
  IF (/*guard:job_decided_at_future*/ true AND NEW.decided_at > clock_timestamp())
     OR (/*guard:job_decided_at_before_dispatch*/ true AND NEW.decided_at < latest) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_jobreconciliationdecision_valid', MESSAGE='A job decision is decided after its job''s latest dispatch and no later than its insert';
  END IF;
  IF /*guard:job_decided_txid_not_forced*/ true OR NEW.decided_txid IS NULL THEN
    NEW.decided_txid := txid_current();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_jobreconciliationdecision_valid BEFORE INSERT ON jobs_jobreconciliationdecision
  FOR EACH ROW EXECUTE FUNCTION jobs_jobreconciliationdecision_valid();

CREATE FUNCTION jobs_job_reconciliation_exit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  IF /*guard:job_exit_unguarded*/ true AND OLD.status = 'needs_reconciliation' AND NEW.status <> OLD.status THEN
    SELECT x.id, x.decided_txid, x.exit INTO d
      FROM jobs_jobreconciliationdecision x
      WHERE x.id = NEW.reconciliation_decision_ref
        AND (NOT /*guard:job_exit_accepts_other_job*/ true OR x.job_id = NEW.id);
    IF NEW.reconciliation_decision_ref IS NULL OR d.id IS NULL
       OR (/*guard:job_exit_reuses_reference*/ true AND NEW.reconciliation_decision_ref IS NOT DISTINCT FROM OLD.reconciliation_decision_ref)
       OR (/*guard:job_exit_any_transaction*/ true AND d.decided_txid IS DISTINCT FROM txid_current())
       OR (/*guard:job_exit_resume_unbound*/ true AND d.exit = 'resume' AND NEW.status <> 'queued')
       OR (/*guard:job_exit_fail_unbound*/ true AND d.exit = 'fail' AND NEW.status <> 'failed') THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_job_reconciliation_exit', MESSAGE='A job leaves reconciliation only on its own decision';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_job_reconciliation_exit BEFORE UPDATE ON jobs_job
  FOR EACH ROW EXECUTE FUNCTION jobs_job_reconciliation_exit();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER jobs_job_reconciliation_exit ON jobs_job;
DROP FUNCTION jobs_job_reconciliation_exit();
DROP TRIGGER jobs_jobreconciliationdecision_valid ON jobs_jobreconciliationdecision;
DROP FUNCTION jobs_jobreconciliationdecision_valid();
"""


class Migration(migrations.Migration):
    dependencies = [("jobs", "0002_guards")]
    operations = [
        migrations.RunSQL(sql=TIMEOUTS, reverse_sql=TIMEOUTS),
        migrations.AddField(
            model_name="jobreconciliationdecision",
            name="decided_txid",
            field=models.BigIntegerField(default=0),
            preserve_default=False,
        ),
        migrations.RunSQL(FORWARD, reverse_sql=REVERSE),
    ]

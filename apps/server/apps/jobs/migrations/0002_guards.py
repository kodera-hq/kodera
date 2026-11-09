"""The job queue's database guards: docs/specs/JOB_QUEUE.md §3.2 and docs/domain/MODEL.md §8.

Every guarded clause carries a marker, /*guard:<flag>*/ true, naming the test-only flag that disables
exactly that clause (§9.2): a database mutant replaces that one `true` with `false`. No trigger fires
on TRUNCATE, which the production role is refused by privilege, and none guards not_before or the
other columns §3.2 lists as test-session writes.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE jobs_job ADD CONSTRAINT jobs_job_organisation_fk FOREIGN KEY (organisation_id) REFERENCES orgs_organisation(id) ON DELETE RESTRICT;
ALTER TABLE jobs_job ADD CONSTRAINT jobs_job_parent_fk FOREIGN KEY (parent_job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_job ADD CONSTRAINT jobs_job_depends_on_fk FOREIGN KEY (depends_on_job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_job ADD CONSTRAINT jobs_job_unresolved_step_fk FOREIGN KEY (unresolved_step_id) REFERENCES jobs_jobstep(id) ON DELETE RESTRICT;
ALTER TABLE jobs_job ADD CONSTRAINT jobs_job_decision_fk FOREIGN KEY (reconciliation_decision_ref) REFERENCES jobs_jobreconciliationdecision(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobstep ADD CONSTRAINT jobs_jobstep_job_fk FOREIGN KEY (job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_joblockreservation ADD CONSTRAINT jobs_joblockreservation_job_fk FOREIGN KEY (job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobdispatch ADD CONSTRAINT jobs_jobdispatch_job_fk FOREIGN KEY (job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobdispatch ADD CONSTRAINT jobs_jobdispatch_step_fk FOREIGN KEY (step_id) REFERENCES jobs_jobstep(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobdispatch ADD CONSTRAINT jobs_jobdispatch_sub_job_fk FOREIGN KEY (sub_job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobreconciliationdecision ADD CONSTRAINT jobs_jobreconciliationdecision_job_fk FOREIGN KEY (job_id) REFERENCES jobs_job(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobreconciliationdecision ADD CONSTRAINT jobs_jobreconciliationdecision_step_fk FOREIGN KEY (unresolved_step_id) REFERENCES jobs_jobstep(id) ON DELETE RESTRICT;
ALTER TABLE jobs_jobreconciliationdecision ADD CONSTRAINT jobs_jobreconciliationdecision_identity_fk FOREIGN KEY (decided_by_identity_id) REFERENCES identity_identity(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX jobs_joblockreservation_one_unended
  ON jobs_joblockreservation (job_id, lock_class, lock_key) WHERE ended_at IS NULL;

CREATE FUNCTION jobs_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF /*guard:job_delete_allowed*/ true THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_job_delete_refused', MESSAGE='A job row is retained';
    END IF;
    RETURN OLD;
  END IF;
  IF (/*guard:job_spec_mutable_id*/ true AND NEW.id IS DISTINCT FROM OLD.id)
     OR (/*guard:job_spec_mutable_organisation_id*/ true AND NEW.organisation_id IS DISTINCT FROM OLD.organisation_id)
     OR (/*guard:job_spec_mutable_tenant_id*/ true AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
     OR (/*guard:job_spec_mutable_kind*/ true AND NEW.kind IS DISTINCT FROM OLD.kind)
     OR (/*guard:job_spec_mutable_idempotency_key*/ true AND NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key)
     OR (/*guard:job_spec_mutable_desired_spec_hash*/ true AND NEW.desired_spec_hash IS DISTINCT FROM OLD.desired_spec_hash)
     OR (/*guard:job_spec_mutable_max_attempts*/ true AND NEW.max_attempts IS DISTINCT FROM OLD.max_attempts)
     OR (/*guard:job_spec_mutable_actor_type*/ true AND NEW.actor_type IS DISTINCT FROM OLD.actor_type)
     OR (/*guard:job_spec_mutable_actor_id*/ true AND NEW.actor_id IS DISTINCT FROM OLD.actor_id)
     OR (/*guard:job_spec_mutable_parent_job_id*/ true AND NEW.parent_job_id IS DISTINCT FROM OLD.parent_job_id)
     OR (/*guard:job_spec_mutable_depends_on_job_id*/ true AND NEW.depends_on_job_id IS DISTINCT FROM OLD.depends_on_job_id)
     OR (/*guard:job_spec_mutable_request_id*/ true AND NEW.request_id IS DISTINCT FROM OLD.request_id)
     OR (/*guard:job_spec_mutable_created_at*/ true AND NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_job_specification_immutable', MESSAGE='A job specification never changes';
  END IF;
  IF (/*guard:place_may_be_cleared*/ true AND OLD.lock_requested_at IS NOT NULL AND NEW.lock_requested_at IS NULL)
     OR (/*guard:place_may_move_earlier*/ true AND NEW.lock_requested_at < OLD.lock_requested_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_job_place_kept', MESSAGE='A place in request order is never cleared or moved earlier';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_job_guard BEFORE UPDATE OR DELETE ON jobs_job FOR EACH ROW EXECUTE FUNCTION jobs_job_guard();

CREATE FUNCTION jobs_jobstep_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF /*guard:step_delete_allowed*/ true THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_jobstep_delete_refused', MESSAGE='A step row is retained';
    END IF;
    RETURN OLD;
  END IF;
  IF (/*guard:step_spec_mutable_id*/ true AND NEW.id IS DISTINCT FROM OLD.id)
     OR (/*guard:step_spec_mutable_job_id*/ true AND NEW.job_id IS DISTINCT FROM OLD.job_id)
     OR (/*guard:step_spec_mutable_seq*/ true AND NEW.seq IS DISTINCT FROM OLD.seq)
     OR (/*guard:step_spec_mutable_name*/ true AND NEW.name IS DISTINCT FROM OLD.name)
     OR (/*guard:step_spec_mutable_retry_class*/ true AND NEW.retry_class IS DISTINCT FROM OLD.retry_class)
     OR (/*guard:step_spec_mutable_conditional*/ true AND NEW.conditional IS DISTINCT FROM OLD.conditional)
     OR (/*guard:step_spec_mutable_timeout_s*/ true AND NEW.timeout_s IS DISTINCT FROM OLD.timeout_s) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_jobstep_specification_immutable', MESSAGE='A step specification never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_jobstep_guard BEFORE UPDATE OR DELETE ON jobs_jobstep FOR EACH ROW EXECUTE FUNCTION jobs_jobstep_guard();

CREATE FUNCTION jobs_joblockreservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF /*guard:reservation_end_rewritable*/ true AND OLD.ended_at IS NOT NULL
     AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_joblockreservation_end_once', MESSAGE='A reservation ends once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_joblockreservation_guard BEFORE UPDATE ON jobs_joblockreservation FOR EACH ROW EXECUTE FUNCTION jobs_joblockreservation_guard();

CREATE FUNCTION jobs_jobdispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL AND (
       (/*guard:dispatch_closed_at_rewritable*/ true AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
    OR (/*guard:dispatch_outcome_rewritable*/ true AND NEW.terminal_outcome IS DISTINCT FROM OLD.terminal_outcome)
    OR (/*guard:dispatch_evidence_rewritable*/ true AND NEW.terminal_evidence_ref IS DISTINCT FROM OLD.terminal_evidence_ref)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_jobdispatch_close_once', MESSAGE='A dispatch is closed once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_jobdispatch_guard BEFORE UPDATE ON jobs_jobdispatch FOR EACH ROW EXECUTE FUNCTION jobs_jobdispatch_guard();

CREATE FUNCTION jobs_jobreconciliationdecision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND /*guard:job_decision_update_allowed*/ true)
     OR (TG_OP = 'DELETE' AND /*guard:job_decision_delete_allowed*/ true) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='jobs_jobreconciliationdecision_immutable', MESSAGE='A decision row never changes';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_jobreconciliationdecision_immutable BEFORE UPDATE OR DELETE ON jobs_jobreconciliationdecision
  FOR EACH ROW EXECUTE FUNCTION jobs_jobreconciliationdecision_immutable();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER jobs_jobreconciliationdecision_immutable ON jobs_jobreconciliationdecision;
DROP FUNCTION jobs_jobreconciliationdecision_immutable();
DROP TRIGGER jobs_jobdispatch_guard ON jobs_jobdispatch;
DROP FUNCTION jobs_jobdispatch_guard();
DROP TRIGGER jobs_joblockreservation_guard ON jobs_joblockreservation;
DROP FUNCTION jobs_joblockreservation_guard();
DROP TRIGGER jobs_jobstep_guard ON jobs_jobstep;
DROP FUNCTION jobs_jobstep_guard();
DROP TRIGGER jobs_job_guard ON jobs_job;
DROP FUNCTION jobs_job_guard();
DROP INDEX jobs_joblockreservation_one_unended;
ALTER TABLE jobs_jobreconciliationdecision DROP CONSTRAINT jobs_jobreconciliationdecision_identity_fk;
ALTER TABLE jobs_jobreconciliationdecision DROP CONSTRAINT jobs_jobreconciliationdecision_step_fk;
ALTER TABLE jobs_jobreconciliationdecision DROP CONSTRAINT jobs_jobreconciliationdecision_job_fk;
ALTER TABLE jobs_jobdispatch DROP CONSTRAINT jobs_jobdispatch_sub_job_fk;
ALTER TABLE jobs_jobdispatch DROP CONSTRAINT jobs_jobdispatch_step_fk;
ALTER TABLE jobs_jobdispatch DROP CONSTRAINT jobs_jobdispatch_job_fk;
ALTER TABLE jobs_joblockreservation DROP CONSTRAINT jobs_joblockreservation_job_fk;
ALTER TABLE jobs_jobstep DROP CONSTRAINT jobs_jobstep_job_fk;
ALTER TABLE jobs_job DROP CONSTRAINT jobs_job_decision_fk;
ALTER TABLE jobs_job DROP CONSTRAINT jobs_job_unresolved_step_fk;
ALTER TABLE jobs_job DROP CONSTRAINT jobs_job_depends_on_fk;
ALTER TABLE jobs_job DROP CONSTRAINT jobs_job_parent_fk;
ALTER TABLE jobs_job DROP CONSTRAINT jobs_job_organisation_fk;
"""


class Migration(migrations.Migration):
    dependencies = [("jobs", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]

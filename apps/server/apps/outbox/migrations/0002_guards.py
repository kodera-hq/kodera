"""The outbox delivery's database guards: docs/specs/JOB_QUEUE.md §7.

Every guarded clause carries a marker, /*guard:<flag>*/ true, naming the test-only flag that disables
exactly that clause (§9.2). The two CHECKs a database mutant redefines with one clause fewer are
written here, not in the model, so that the migration state never has to follow a mutant.
"""

from django.db import migrations

FORWARD = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE outbox_outboxdelivery ADD CONSTRAINT outbox_delivery_organisation_fk FOREIGN KEY (organisation_id) REFERENCES orgs_organisation(id) ON DELETE RESTRICT;
ALTER TABLE outbox_outboxdelivery ADD CONSTRAINT outbox_delivery_decision_fk FOREIGN KEY (reconciliation_decision_ref) REFERENCES outbox_deliverydecision(id) ON DELETE RESTRICT;
ALTER TABLE outbox_deliverydecision ADD CONSTRAINT outbox_deliverydecision_delivery_fk FOREIGN KEY (delivery_id) REFERENCES outbox_outboxdelivery(id) ON DELETE RESTRICT;
ALTER TABLE outbox_deliverydecision ADD CONSTRAINT outbox_deliverydecision_identity_fk FOREIGN KEY (decided_by_identity_id) REFERENCES identity_identity(id) ON DELETE RESTRICT;
ALTER TABLE outbox_outboxdelivery ADD CONSTRAINT outbox_delivery_started_when_in_flight
  CHECK (status NOT IN ('in_flight', 'needs_reconciliation') OR started_at IS NOT NULL);
ALTER TABLE outbox_deliverydecision ADD CONSTRAINT outbox_deliverydecision_evidence_present CHECK (
  coalesce(compute_terminated_provider, '') <> '' AND coalesce(compute_terminated_resource_id, '') <> ''
  AND coalesce(compute_terminated_request_id, '') <> '' AND coalesce(target_read_provider, '') <> ''
  AND coalesce(target_read_resource_id, '') <> '' AND coalesce(target_read_request_id, '') <> '');

CREATE FUNCTION outbox_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (/*guard:delete_allowed_in_flight*/ true AND OLD.status = 'in_flight')
       OR (/*guard:delete_allowed_unresolved*/ true AND OLD.status = 'needs_reconciliation') THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_delivery_delete_refused', MESSAGE='A started delivery is retained';
    END IF;
    RETURN OLD;
  END IF;
  IF ((/*guard:freeze_unresolved_only*/ true AND OLD.status = 'in_flight')
      OR (/*guard:freeze_in_flight_only*/ true AND OLD.status = 'needs_reconciliation'))
     AND ((/*guard:freeze_skips_changes_realm*/ true AND NEW.changes_realm IS DISTINCT FROM OLD.changes_realm)
       OR (/*guard:freeze_skips_category*/ true AND NEW.category IS DISTINCT FROM OLD.category)
       OR (/*guard:freeze_skips_organisation*/ true AND NEW.organisation_id IS DISTINCT FROM OLD.organisation_id)
       OR (/*guard:freeze_skips_started_at*/ true AND NEW.started_at IS DISTINCT FROM OLD.started_at)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_delivery_frozen', MESSAGE='A started delivery keeps its identity';
  END IF;
  IF /*guard:delivery_exit_unguarded*/ true AND OLD.status = 'needs_reconciliation' AND NEW.status <> OLD.status THEN
    SELECT x.id, x.decided_at, x.decided_txid, x.exit, x.operation_outcome, x.xmin AS row_xmin INTO d
      FROM outbox_deliverydecision x
      WHERE x.id = NEW.reconciliation_decision_ref
        AND (NOT /*guard:delivery_exit_accepts_other_delivery*/ true OR x.delivery_id = NEW.id);
    IF NEW.reconciliation_decision_ref IS NULL OR d.id IS NULL
       OR (/*guard:delivery_exit_reuses_reference*/ true AND NEW.reconciliation_decision_ref IS NOT DISTINCT FROM OLD.reconciliation_decision_ref)
       OR (/*guard:delivery_exit_any_transaction*/ true AND /*guard:delivery_exit_compares_xmin*/ true AND d.decided_txid IS DISTINCT FROM txid_current())
       OR (/*guard:delivery_exit_any_transaction*/ true AND NOT /*guard:delivery_exit_compares_xmin*/ true AND d.row_xmin <> pg_current_xact_id()::xid)
       OR (/*guard:delivery_exit_ignores_started_at*/ true AND d.decided_at < NEW.started_at)
       OR (/*guard:delivery_exit_fail_unbound*/ true AND d.exit = 'fail' AND NEW.status <> 'failed')
       OR (/*guard:delivery_exit_completed_unbound*/ true AND d.exit = 'resume' AND d.operation_outcome = 'completed' AND NEW.status <> 'succeeded')
       OR (/*guard:delivery_exit_no_effect_unbound*/ true AND d.exit = 'resume' AND d.operation_outcome = 'no_effect' AND NEW.status <> 'pending') THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_delivery_reconciliation_exit', MESSAGE='A delivery leaves reconciliation only on its own decision';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_delivery_reconciliation_exit BEFORE UPDATE OR DELETE ON outbox_outboxdelivery
  FOR EACH ROW EXECUTE FUNCTION outbox_delivery_guard();

CREATE FUNCTION outbox_deliverydecision_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  IF /*guard:decided_at_not_forced*/ true OR NEW.decided_at IS NULL THEN
    NEW.decided_at := clock_timestamp();
  END IF;
  SELECT status, started_at INTO v FROM outbox_outboxdelivery WHERE id = NEW.delivery_id;
  IF (/*guard:decision_trigger_ignores_status*/ true AND v.status IS DISTINCT FROM 'needs_reconciliation')
     OR (/*guard:decision_trigger_ignores_start_order*/ true AND NOT NEW.compute_terminated_observed_at
         > v.started_at - interval '5 minutes' * (CASE WHEN /*guard:decision_trigger_no_start_tolerance*/ true THEN 1 ELSE 0 END))
     OR (/*guard:decision_trigger_target_before_compute*/ true AND NOT NEW.compute_terminated_observed_at <= NEW.target_read_observed_at)
     OR (/*guard:decision_trigger_future*/ true AND NOT NEW.target_read_observed_at
         <= NEW.decided_at + interval '5 minutes' * (CASE WHEN /*guard:decision_trigger_no_future_tolerance*/ true THEN 1 ELSE 0 END)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_deliverydecision_valid', MESSAGE='A delivery decision must follow its evidence';
  END IF;
  IF /*guard:decided_txid_not_forced*/ true OR NEW.decided_txid IS NULL THEN
    NEW.decided_txid := txid_current();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_deliverydecision_valid BEFORE INSERT ON outbox_deliverydecision
  FOR EACH ROW EXECUTE FUNCTION outbox_deliverydecision_valid();

CREATE FUNCTION outbox_deliverydecision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND /*guard:delivery_decision_update_allowed*/ true)
     OR (TG_OP = 'DELETE' AND /*guard:delivery_decision_delete_allowed*/ true) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='outbox_deliverydecision_immutable', MESSAGE='A decision row never changes';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_deliverydecision_immutable BEFORE UPDATE OR DELETE ON outbox_deliverydecision
  FOR EACH ROW EXECUTE FUNCTION outbox_deliverydecision_immutable();
"""

REVERSE = r"""
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER outbox_deliverydecision_immutable ON outbox_deliverydecision;
DROP FUNCTION outbox_deliverydecision_immutable();
DROP TRIGGER outbox_deliverydecision_valid ON outbox_deliverydecision;
DROP FUNCTION outbox_deliverydecision_valid();
DROP TRIGGER outbox_delivery_reconciliation_exit ON outbox_outboxdelivery;
DROP FUNCTION outbox_delivery_guard();
ALTER TABLE outbox_deliverydecision DROP CONSTRAINT outbox_deliverydecision_evidence_present;
ALTER TABLE outbox_outboxdelivery DROP CONSTRAINT outbox_delivery_started_when_in_flight;
ALTER TABLE outbox_deliverydecision DROP CONSTRAINT outbox_deliverydecision_identity_fk;
ALTER TABLE outbox_deliverydecision DROP CONSTRAINT outbox_deliverydecision_delivery_fk;
ALTER TABLE outbox_outboxdelivery DROP CONSTRAINT outbox_delivery_decision_fk;
ALTER TABLE outbox_outboxdelivery DROP CONSTRAINT outbox_delivery_organisation_fk;
"""


class Migration(migrations.Migration):
    dependencies = [("outbox", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, reverse_sql=REVERSE)]

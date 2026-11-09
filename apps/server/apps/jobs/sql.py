"""The queue's claim and runner statements: docs/specs/JOB_QUEUE.md §4.2 to §4.4 and §5.3.

A `{name}` field is a fixed clause the caller chooses from this module's own text, never a value;
every value is a bound parameter. Every instant is clock_timestamp(), never the statement's start.
"""

# Exactly Python str.strip()'s 29 whitespace codepoints. SQL btrim and both Python completion
# predicates share this explicit set; validation never normalizes the retained proof itself.
EVIDENCE_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u001c\u001d\u001e\u001f\u0020\u0085\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)

# §5.3: one instant per statement, and due against that same instant.
PROMOTION = """
WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
UPDATE jobs_job SET lock_requested_at = {placed_at}
FROM instant
WHERE id IN (
  SELECT id FROM jobs_job
  WHERE status = 'queued' AND parent_job_id IS NULL AND lock_requested_at IS NULL
    {due}
    AND (depends_on_job_id IS NULL
         OR depends_on_job_id IN (SELECT id FROM jobs_job WHERE status = 'succeeded'))
  {row_lock}
)
"""
PROMOTION_AT_INSTANT = "instant.at"
PROMOTION_AT_EACH_ROW = "clock_timestamp()"
PROMOTION_DUE = "AND not_before <= (SELECT at FROM instant)"

NO_KEY_UPDATE = "FOR NO KEY UPDATE"
UPDATE = "FOR UPDATE"
SKIP_LOCKED = " SKIP LOCKED"

# §4.2: sub-jobs first, then the unplaced top-level rows, then the placed ones in request order.
SCAN = """
SELECT id FROM jobs_job
WHERE status IN ('queued', 'orphaned') AND not_before <= clock_timestamp() {only}
ORDER BY {sub_jobs}, lock_requested_at NULLS FIRST, id
"""
SCAN_SUB_JOBS_FIRST = "(parent_job_id IS NULL)"
SCAN_SUB_JOBS_LAST = "(parent_job_id IS NOT NULL)"
SCAN_TOP_LEVEL_ONLY = "AND parent_job_id IS NULL"
SCAN_PLACED_ONLY = "AND (parent_job_id IS NOT NULL OR lock_requested_at IS NOT NULL)"

# §4.2 step 1.
CLAIM_ROW = """
SELECT status, not_before <= clock_timestamp(), parent_job_id, depends_on_job_id,
       lock_requested_at, kind, organisation_id, tenant_id, fence
FROM jobs_job WHERE id = %s {row_lock}
"""

# §4.3's sub-job rule: read without a lock, the parent and its open dispatch naming the sub-job.
PARENT_RUNNING = """
SELECT 1 FROM jobs_job p JOIN jobs_jobdispatch d ON d.job_id = p.id
WHERE p.id = %(parent)s AND p.status = 'running' AND d.sub_job_id = %(job)s
  AND d.closed_at IS NULL {fence}
LIMIT 1
"""
PARENT_FENCE = "AND d.fence = p.fence"

DEPENDENCY_STATUS = "SELECT status FROM jobs_job WHERE id = %s"

FAIL_PREREQUISITE = """
UPDATE jobs_job SET status = 'failed', error_code = 'prerequisite_failed'
WHERE id = %s AND status = 'queued'
"""

# Check 1, per lock of the set.
RESERVATION_CONFLICT = """
SELECT 1 FROM jobs_joblockreservation
WHERE ended_at IS NULL AND job_id <> %(job)s AND lock_class = %(class)s AND lock_key = %(key)s
  AND (mode = 'exclusive' OR %(mode)s = 'exclusive')
LIMIT 1
"""

# Check 2: earlier placed, claimable, unclaimed top-level jobs sharing a key. Whether one conflicts
# is decided from its lock set.
EARLIER_REQUESTS = """
SELECT e.kind, e.organisation_id, e.tenant_id FROM jobs_job e
LEFT JOIN jobs_job d ON d.id = e.depends_on_job_id
WHERE e.id <> %(job)s AND e.parent_job_id IS NULL AND e.status IN ('queued', 'orphaned')
  AND e.lock_requested_at IS NOT NULL AND e.not_before <= clock_timestamp()
  AND (e.depends_on_job_id IS NULL OR d.status = 'succeeded')
  AND (e.lock_requested_at, e.id) < (%(placed)s, %(job)s)
  AND (e.organisation_id = %(organisation)s OR e.tenant_id = %(tenant)s)
"""

# §4.2 step 5. "The first claim after a resume" is status = 'queued' AND fence > 0: a resume decision
# is the only writer that returns a claimed job to queued (§3.3).
COMMIT_CLAIM = """
UPDATE jobs_job SET status = 'leased', fence = fence + 1, runner_id = %(runner)s,
       attempt = attempt + {attempt},
       lease_expires_at = clock_timestamp() + interval '120 seconds'
WHERE id = %(job)s AND status = %(status)s AND fence = %(fence)s
RETURNING fence
"""
ATTEMPT_UNLESS_RESUMED = "CASE WHEN status = 'queued' AND fence > 0 THEN 0 ELSE 1 END"
ATTEMPT_ALWAYS = "1"

END_RESERVATIONS = """
UPDATE jobs_joblockreservation SET ended_at = clock_timestamp()
WHERE job_id = %s AND ended_at IS NULL
"""

INSERT_RESERVATION = """
INSERT INTO jobs_joblockreservation (id, job_id, fence, lock_class, lock_key, mode)
VALUES (%s, %s, %s, %s, %s, %s)
"""

# A pending class C step whose latest dispatch in the current resolution cycle closed completed.
COMPLETE_CLASS_C = """
WITH recoverable AS (
    SELECT st.id, latest.terminal_evidence_ref
    FROM jobs_jobstep st
    CROSS JOIN LATERAL (
        SELECT d.job_id, d.closed_at, d.terminal_outcome, d.terminal_evidence_ref
        FROM jobs_jobdispatch d WHERE d.step_id = st.id {cycle}
        ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 1
    ) latest
    WHERE st.job_id = %(job)s AND st.status = 'pending' {class_c}
      AND latest.job_id = st.job_id AND latest.closed_at IS NOT NULL
      AND latest.terminal_outcome = 'completed'
      AND btrim(latest.terminal_evidence_ref, %(evidence_whitespace)s) <> ''
)
UPDATE jobs_jobstep st SET status = 'succeeded',
       output_ref = recoverable.terminal_evidence_ref, error_code = NULL
FROM recoverable WHERE st.id = recoverable.id AND st.status = 'pending'
RETURNING st.id, st.seq, st.output_ref
"""
# Select the latest dispatch before testing its outcome: an older failure cannot override a
# newer open or differently closed dispatch. The job row is locked by the claiming transaction.
RECOVER_FAILED_CLASS_C = """
WITH recoverable AS (
    SELECT st.id, latest.terminal_evidence_ref
    FROM jobs_jobstep st
    CROSS JOIN LATERAL (
        SELECT d.closed_at, d.terminal_outcome, d.terminal_evidence_ref
        FROM jobs_jobdispatch d WHERE d.step_id = st.id {cycle}
        ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 1
    ) latest
    WHERE st.job_id = %(job)s AND st.status = 'pending' AND st.retry_class = 'C'
      AND latest.closed_at IS NOT NULL AND latest.terminal_outcome = 'failed'
)
UPDATE jobs_jobstep st SET status = 'failed', output_ref = recoverable.terminal_evidence_ref
FROM recoverable WHERE st.id = recoverable.id AND st.status = 'pending'
RETURNING st.id, st.seq, st.output_ref
"""
CLASS_C = "AND st.retry_class = 'C'"
CYCLE = """
         AND d.dispatched_at > COALESCE(
             (SELECT {bound}(r.decided_at) FROM jobs_jobreconciliationdecision r
              WHERE r.unresolved_step_id = st.id AND r.exit = 'resume'
                AND r.operation_outcome = 'no_effect'),
             '-infinity')"""
CYCLE_FROM_LATEST = "max"
CYCLE_FROM_FIRST = "min"

# Select latest before classifying: no outcome, proof or relationship filter may expose an
# older completion. A left join distinguishes a missing step from a step without dispatches.
COMPLETION_READ = """
SELECT st.id, st.status, st.output_ref, st.error_code,
       latest.id, latest.job_id, latest.step_id, latest.fence, latest.operation_ref,
       latest.sub_job_id, latest.closed_at, latest.terminal_outcome, latest.terminal_evidence_ref
FROM jobs_jobstep st
LEFT JOIN LATERAL (
    SELECT d.* FROM jobs_jobdispatch d WHERE d.step_id = st.id {cycle}
    ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 1
) latest ON TRUE
WHERE st.job_id = %(job)s AND st.seq = %(seq)s
"""

ACK_CLOSE_COMPLETED = """
UPDATE jobs_jobdispatch SET closed_at = clock_timestamp(), terminal_outcome = 'completed',
       terminal_evidence_ref = %(evidence)s
WHERE id = %(dispatch)s AND job_id = %(job)s AND step_id = %(step)s
  AND fence = %(fence)s AND operation_ref = %(operation)s AND sub_job_id IS NULL
  AND closed_at IS NULL AND terminal_outcome IS NULL AND terminal_evidence_ref IS NULL
RETURNING id
"""
# Read only by the two mutants named *class_c_cycle_restarts_at_claim, one per writer of a dispatch:
# a cycle that restarts at every claim.
CYCLE_CURRENT_CLAIM = """
         AND d.fence = (SELECT j.fence FROM jobs_job j WHERE j.id = st.job_id)"""

RELEASE_SUBJECT = (
    "SELECT kind, organisation_id, tenant_id, parent_job_id FROM jobs_job WHERE id = %s"
)

# §4.4: the first statement of every runner write, then the re-check once the row is held.
OWNED = """
SELECT id, organisation_id, tenant_id, kind, parent_job_id, fence, status FROM jobs_job
WHERE id = %(job)s {fence} AND status IN ('leased', 'running') {lease}
{row_lock}
"""
OWNED_FENCE = "AND fence = %(fence)s"
OWNED_LEASE = "AND lease_expires_at > {clock}"
CLOCK = "clock_timestamp()"
TRANSACTION_START = "now()"
LEASE_HELD = "SELECT lease_expires_at > {clock} FROM jobs_job WHERE id = %s"

# §4.4: a sub-job's effect-starting write holds its parent running, with the dispatch naming it open
# at the parent's current fence.
PARENT_HELD = "SELECT status, fence FROM jobs_job WHERE id = %s FOR SHARE"
PARENT_DISPATCH_OPEN = """
SELECT 1 FROM jobs_jobdispatch
WHERE TRUE {owner} {child} {open} {fence}
"""
PARENT_DISPATCH_OWNER = "AND job_id = %(parent)s"
PARENT_DISPATCH_CHILD = "AND sub_job_id = %(job)s"
PARENT_DISPATCH_IS_OPEN = "AND closed_at IS NULL"
PARENT_DISPATCH_FENCE = "AND fence = %(parent_fence)s"

RENEW = "UPDATE jobs_job SET lease_expires_at = clock_timestamp() + interval '120 seconds' WHERE id = %s"

STEP = "SELECT id, status, conditional FROM jobs_jobstep WHERE job_id = %s AND seq = %s"
LOWER_STEPS_DONE = """
SELECT NOT EXISTS (
  SELECT 1 FROM jobs_jobstep
  WHERE job_id = %s AND seq < %s AND status NOT IN ('succeeded', 'skipped')
)
"""
SET_STEP = "UPDATE jobs_jobstep SET status = %s WHERE id = %s"
END_STEP = """
UPDATE jobs_jobstep SET status = %(status)s, error_code = %(error_code)s,
       output_ref = {output_ref}
WHERE id = %(step)s
RETURNING output_ref
"""
END_STEP_OUTPUT_REF = "COALESCE(%(output_ref)s, output_ref)"
END_STEP_KEEP_OUTPUT_REF = "output_ref"
JOB_RUNNING = "UPDATE jobs_job SET status = 'running' WHERE id = %s AND status = 'leased'"

# §4.4 finish_job.
STEPS_UNFINISHED = """
SELECT EXISTS (
  SELECT 1 FROM jobs_jobstep WHERE job_id = %s AND status NOT IN ('succeeded', 'skipped')
)
"""
DISPATCH_OPEN = (
    "SELECT EXISTS (SELECT 1 FROM jobs_jobdispatch WHERE job_id = %s AND closed_at IS NULL)"
)
SUB_JOB_LIVE = """
SELECT EXISTS (
  SELECT 1 FROM jobs_job
  WHERE parent_job_id = %s AND status NOT IN ('succeeded', 'failed', 'cancelled')
)
"""
FINISH = """
UPDATE jobs_job SET status = %(status)s, error_code = %(error_code)s, lease_expires_at = NULL
WHERE id = %(job)s
"""
# §3.3: a sub-job's own terminal write closes its parent's dispatch naming it.
CLOSE_PARENT_DISPATCH = """
UPDATE jobs_jobdispatch SET closed_at = clock_timestamp(), terminal_outcome = %(outcome)s,
       terminal_evidence_ref = {evidence_ref}
WHERE sub_job_id = %(job)s AND closed_at IS NULL
"""
EVIDENCE_OPERATION_REF = "operation_ref"
EVIDENCE_NONE = "NULL"

# §4.4 dispatch writes.
DISPATCH_STEP = "SELECT id, status, retry_class FROM jobs_jobstep WHERE job_id = %s AND seq = %s"
# A class C step dispatched in its current resolution cycle: the claim's CYCLE clause, on one step.
CLASS_C_DISPATCHED = """
SELECT EXISTS (
  SELECT 1 FROM jobs_jobstep st JOIN jobs_jobdispatch d ON d.step_id = st.id
  WHERE st.id = %s {cycle}
)
"""
INSERT_DISPATCH = """
INSERT INTO jobs_jobdispatch (id, job_id, step_id, fence, operation_ref, sub_job_id)
VALUES (%(id)s, %(job)s, %(step)s, %(fence)s, %(operation_ref)s, %(sub_job)s)
"""
RETARGET = """
UPDATE jobs_jobdispatch SET operation_ref = %(operation_ref)s
WHERE id = %(dispatch)s AND job_id = %(job)s {open} {not_sub_job}
RETURNING id
"""
CLOSE_DISPATCH = """
UPDATE jobs_jobdispatch SET closed_at = clock_timestamp(), terminal_outcome = %(outcome)s,
       terminal_evidence_ref = %(evidence_ref)s
WHERE id = %(dispatch)s AND job_id = %(job)s AND closed_at IS NULL {not_sub_job}
RETURNING id
"""
DISPATCH_IS_OPEN = "AND closed_at IS NULL"
DISPATCH_NOT_SUB_JOB = "AND sub_job_id IS NULL"
OPEN_DISPATCH = """
SELECT step_id, operation_ref FROM jobs_jobdispatch
WHERE id = %s AND job_id = %s AND closed_at IS NULL
"""
HOLD = """
UPDATE jobs_job SET status = 'needs_reconciliation', lease_expires_at = NULL,
       unresolved_step_id = %(step)s, unresolved_operation_ref = %(operation_ref)s
WHERE id = %(job)s
"""
# A sub-job has no place in request order; only the mutant gives it one.
SUB_JOB_PLACE = "UPDATE jobs_job SET lock_requested_at = clock_timestamp() WHERE id = %s"

# §5.2: the sweep's candidates, then each one locked and re-checked before any dispatch read.
SWEEP_CANDIDATES = "SELECT id, fence FROM jobs_job WHERE status IN ('leased', 'running') {expired}"
SWEEP_EXPIRED = "AND lease_expires_at < clock_timestamp()"
SWEEP_ROW = """
SELECT id, organisation_id, fence, status, attempt, max_attempts, parent_job_id FROM jobs_job
WHERE id = %s
{row_lock}
"""
SWEEP_STILL_EXPIRED = "SELECT lease_expires_at < clock_timestamp() FROM jobs_job WHERE id = %s"
SWEEP_OPEN_DISPATCH = """
SELECT step_id, operation_ref FROM jobs_jobdispatch
WHERE job_id = %s AND closed_at IS NULL {sub_job}
ORDER BY dispatched_at, id LIMIT 1
"""
SWEEP_LIVE_SUB_JOB_DISPATCH = """
SELECT d.step_id, d.operation_ref FROM jobs_jobdispatch d JOIN jobs_job s ON s.id = d.sub_job_id
WHERE d.job_id = %s AND s.status NOT IN ('succeeded', 'failed', 'cancelled')
ORDER BY d.dispatched_at, d.id LIMIT 1
"""
ORPHAN = """
UPDATE jobs_job SET status = 'orphaned', lease_expires_at = NULL {lock_requested_at}
WHERE id = %s
"""
ORPHAN_LOSES_PLACE = ", lock_requested_at = NULL"
# The mutant sweep_completes_closed_step: a running step whose latest dispatch closed completed.
RUNNING_STEPS_COMPLETED = """
UPDATE jobs_jobstep st SET status = 'succeeded'
WHERE st.job_id = %s AND st.status = 'running'
  AND (SELECT d.terminal_outcome FROM jobs_jobdispatch d WHERE d.step_id = st.id
       ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 1) = 'completed'
"""
RUNNING_STEPS_PENDING = (
    "UPDATE jobs_jobstep SET status = 'pending' WHERE job_id = %s AND status = 'running'"
)

# §5.2: the stranding pass.
STRANDING_CANDIDATES = """
SELECT id FROM jobs_job WHERE status IN ('queued', 'orphaned') AND parent_job_id IS NOT NULL
"""
STRANDING_ROW = """
SELECT id, organisation_id, status, parent_job_id FROM jobs_job
WHERE id = %s
{row_lock}
"""
STRANDING_PARENT = "SELECT status, fence FROM jobs_job WHERE id = %s"
STRANDING_DISPATCH = """
SELECT 1 FROM jobs_jobdispatch
WHERE job_id = %(parent)s AND sub_job_id = %(job)s AND closed_at IS NULL {fence}
"""
STRANDING_FENCE = "AND fence = %(parent_fence)s"
# Read only by the mutant stranding_resets_steps.
SUCCEEDED_STEPS_PENDING = (
    "UPDATE jobs_jobstep SET status = 'pending' WHERE job_id = %s AND status = 'succeeded'"
)

# §5.4: a decision takes the job out of needs_reconciliation.
DECIDE_JOB = """
SELECT id, organisation_id, parent_job_id, unresolved_step_id, unresolved_operation_ref
FROM jobs_job WHERE id = %s {status}
{row_lock}
"""
DECIDE_RECONCILING = "AND status = 'needs_reconciliation'"
CLOCK_NOW = "SELECT clock_timestamp()"
UNRESOLVED_DISPATCH = """
SELECT id, dispatched_at, terminal_outcome FROM jobs_jobdispatch
WHERE job_id = %s AND step_id = %s AND operation_ref = %s
ORDER BY dispatched_at DESC, id DESC LIMIT 1
"""
INSERT_DECISION = """
INSERT INTO jobs_jobreconciliationdecision (
  id, job_id, exit, operation_outcome,
  compute_terminated_provider, compute_terminated_resource_id, compute_terminated_request_id,
  compute_terminated_observed_at,
  target_read_provider, target_read_resource_id, target_read_request_id, target_read_observed_at,
  unresolved_step_id, unresolved_operation_ref, dispatch_outcome_at_decision,
  decided_by_identity_id, decided_by_role, decided_at)
VALUES (
  %(id)s, %(job)s, %(exit)s, %(operation_outcome)s,
  %(c_provider)s, %(c_resource_id)s, %(c_request_id)s, %(c_observed_at)s,
  %(t_provider)s, %(t_resource_id)s, %(t_request_id)s, %(t_observed_at)s,
  %(step)s, %(operation_ref)s, %(dispatch_outcome)s,
  %(identity)s, %(role)s, %(decided_at)s)
"""
DECISION_CLOSES_DISPATCH = """
UPDATE jobs_jobdispatch SET closed_at = clock_timestamp(), terminal_outcome = %(outcome)s,
       terminal_evidence_ref = %(evidence_ref)s
WHERE id = %(dispatch)s {open}
"""
# The exit sets the decision reference in the same update: the exit trigger requires it (§5.4).
RESUME_JOB = """
UPDATE jobs_job SET status = 'queued', lease_expires_at = NULL, reconciliation_decision_ref = %s
WHERE id = %s
"""
FAIL_JOB = """
UPDATE jobs_job SET status = 'failed', error_code = 'reconciliation_failed', lease_expires_at = NULL,
       reconciliation_decision_ref = %s
WHERE id = %s
"""
STEP_SEQ = "SELECT seq, output_ref FROM jobs_jobstep WHERE id = %s"


# The runner's one rule before a provider call (G1.5-B, worker/runner.py `_owned`): the job is
# running, at the claim's fence, under a lease the database's own clock has not ended. A sweep on
# another connection can move a running job to needs_reconciliation with its dispatch left open; no
# provider call, first or replayed, starts on it. RUNNER_OWNERSHIP reads each clause, and
# RUNNER_OPEN_DISPATCH requires all three, from these same fragments (apps/jobs/runner_selectors.py).
RUNNER_OWNED_STATUS = "j.status = 'running'"
RUNNER_OWNED_FENCE = "j.fence = %(fence)s"
RUNNER_OWNED_LEASE = "(j.lease_expires_at IS NOT NULL AND j.lease_expires_at > clock_timestamp())"
RUNNER_OWNERSHIP = "SELECT {status}, {fence}, {lease} FROM jobs_job j WHERE j.id = %(job)s"
RUNNER_OPEN_DISPATCH = """
SELECT d.id, d.operation_ref FROM jobs_jobdispatch d JOIN jobs_job j ON j.id = d.job_id
WHERE d.job_id = %(job)s AND d.fence = %(fence)s AND d.closed_at IS NULL
  AND {status} AND {fence} AND {lease}
LIMIT 2
"""

# The runner's handoff (worker/handoff.py): the same three clauses, read under a row lock held from
# the final authorisation through the spawn and the request's send, and released at commit, before
# the provider call runs. The lock is FOR NO KEY UPDATE: the sweep's own row lock (SWEEP_ROW, from
# `_claim.row_lock(for_update=False, waits=False)`) is FOR NO KEY UPDATE SKIP LOCKED, so a sweep
# skips a job mid-handoff and meets it on its next pass, already handed off; a renewal's UPDATE
# waits for the commit; a claim's scan skips it. Nothing can hold the job between the authorisation
# and the send.
RUNNER_HANDOFF = """
SELECT j.id FROM jobs_job j
WHERE j.id = %(job)s AND {status} AND {fence} AND {lease}
{row_lock}
"""
# Set in the handoff's transaction before the lock is asked: the wait for the row is bounded (the
# connection's own statement_timeout bounds it too, and must stay the longer of the two).
RUNNER_HANDOFF_TIMEOUTS = ("SET LOCAL lock_timeout = '1s'",)

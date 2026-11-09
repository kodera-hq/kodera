"""The worker's mutant flags: test-only switches that each disable one guard of the runner (G1.5-B).

A guard reads its flag through `on("<flag>")` at the one clause it disables, and nowhere else is a
flag named. A flag is made active in process by `activate()`, never read from settings, the
environment or any other input, and `activate()` is refused unless the process runs
config.settings.test with its fault-point permission. That gate is core/faults.py's own
`require_permitted()`, shared and not copied: the same function gates `arm()`, `load_control()`,
the synthetic provider's key and these flags, and every other profile refuses it
(tests/test_job_queue_flags_refused.py). With nothing active, `on()` is False.
tests/worker/test_worker_execution.py proves each flag fails the check that owns it (`OWNERS`), by
that check's message, while the same check passes with no flag active.

This is a configuration boundary, not a sandbox against arbitrary Python that rebinds `on`.
"""

from __future__ import annotations

import threading

from core import faults

FLAGS: frozenset[str] = frozenset(
    {
        # worker/lease.py: the runner keeps working after two failed renewals in a row.
        "lease_survives_failed_renewals",
        # worker/lease.py: a renewal the database refused counts as one failure, not a loss.
        "lease_retries_a_refused_renewal",
        # worker/lease.py: a keeper thread that dies leaves its lease looking held.
        "lease_keeper_dies_silently",
        # worker/lease.py: a renewal blocked past the lease's end leaves the lease held.
        "lease_ignores_its_deadline",
        # worker/lease.py: stop() waits for ever on a keeper blocked in a renewal.
        "lease_stop_waits_on_a_blocked_renewal",
        # worker/lease.py: the keeper issues a renewal after stop() was asked.
        "lease_renews_after_stop",
        # worker/child.py: a lost lease does not kill the step's process group.
        "no_reap_on_lease_loss",
        # worker/child.py: the step child runs in the worker's own process group.
        "child_shares_worker_group",
        # worker/child.py: the credential reaches the step child through its environment.
        "credential_in_child_environment",
        # worker/child.py: the credential is added to the live child's environment past
        # child_environment().
        "credential_in_live_environment",
        # worker/child.py: the step child is not reaped once its group is killed.
        "child_left_unreaped",
        # worker/child.py: the child is reaped before its group is killed.
        "group_killed_after_reaping",
        # worker/child.py: the runner reads the child's stdout until end of file, which a
        # grandchild that escaped the group holds back.
        "child_waits_for_end_of_file",
        # worker/child.py: one poll reads the child's stdout until it is empty, however long.
        "output_read_unbounded",
        # worker/child.py: the child's stdout is buffered without a limit.
        "output_uncapped",
        # worker/child.py: a step child is spawned, and sent its request, after the lease is lost.
        "child_started_after_lease_loss",
        # worker/child.py: credential and step.err are opened by path, not in the job directory's
        # descriptor.
        "job_files_opened_by_path",
        # worker/child.py: a credential whose write failed half way stays on disk.
        "credential_kept_on_a_failed_write",
        # worker/child.py: step.err is opened through a symbolic link.
        "step_errors_follow_a_link",
        # worker/child.py: a call that cannot be prepared raises instead of ending not started.
        "unprepared_call_raises",
        # worker/runner.py: a provider call starts without the database's word that this claim
        # owns a runnable job.
        "provider_call_without_db_ownership",
        # worker/child.py: the request is written outside the runner's locked handoff.
        "handoff_skipped",
        # worker/handoff.py: the handoff reads the ownership rule without locking the job's row.
        "handoff_without_row_lock",
        # worker/handoff.py: the ownership rule is not re-read once the row lock is had.
        "handoff_without_reread_after_lock",
        # worker/child.py: a post-commit event that raises leaves the child unkilled and unreaped.
        "child_kept_when_its_event_fails",
        # worker/runner.py: ownership is granted on a job that is not running.
        "ownership_ignores_status",
        # worker/runner.py: ownership is granted at a fence that is not the job's.
        "ownership_ignores_fence",
        # worker/runner.py: ownership is granted under a lease the database's clock has ended.
        "ownership_ignores_lease",
        # worker/runner.py: a runner whose steps are handed a credential starts without a source.
        "runner_starts_without_its_credentials",
        # worker/jobdir.py: a job root that is a link, foreign-owned or not 0700 is trusted.
        "job_root_unchecked",
        # worker/jobdir.py: the startup sweep removes a live runner's directory.
        "sweep_ignores_live_runners",
        # worker/jobdir.py: sweeping and making a runner's directory do not hold the root's lock.
        "sweep_unserialised",
        # worker/convergence.py: a replay is admitted on a dispatch that is no longer open.
        "replay_ignores_open_dispatch",
        # worker/convergence.py: a replay is admitted with another operation_ref.
        "replay_ignores_operation_ref",
        # worker/convergence.py: a replay is admitted with another payload.
        "replay_ignores_payload_hash",
        # worker/convergence.py: a proof whose tag does not verify closes the dispatch.
        "settle_accepts_unauthenticated_proof",
        # worker/jobdir.py: the per-job directory outlives its job.
        "job_directory_kept",
        # worker/jobdir.py: the startup sweep leaves a killed run's directories.
        "startup_sweep_skipped",
        # worker/registry.py: a realm kind is served before G1.5-C (lane decision W4).
        "registry_admits_realm_kinds",
    }
)

_lock = threading.Lock()
_active: str | None = None


def on(flag: str) -> bool:
    """Whether `flag` is the active flag. A name that is no flag is a programming error."""
    if flag not in FLAGS:
        raise ValueError(f"{flag!r} is not a worker mutant flag")
    return _active == flag


def activate(flag: str) -> None:
    """Make `flag` the one active flag of this process, until deactivate()."""
    global _active
    faults.require_permitted()
    if flag not in FLAGS:
        raise ValueError(f"{flag!r} is not a worker mutant flag")
    with _lock:
        if _active not in (None, flag):
            raise faults.FaultPointsRefused(f"{_active} is still active: deactivate it first")
        _active = flag


def deactivate() -> None:
    global _active
    with _lock:
        _active = None

"""The job queue's mutant flags: test-only switches that each disable one guard (JOB_QUEUE.md §9.2).

Each flag of tests/job_queue/mutants.toml is committed here, and nowhere else is a flag named. A guard
written in Python reads its flag through `on("<flag>")` at the one clause the row describes; a guard
written in the database carries the marker `/*guard:<flag>*/ true` and its flag is a
DATABASE_MUTANTS entry in tests/job_queue/database_mutants.py, which rewrites that guard in a
test database only. The installer and guard snapshot/restore machinery are not runtime exports.

The flags are inert unless Django's selected profile and underlying configured settings module are both
config.settings.test and its permission is exactly True. Imported copies and direct settings
assignment cannot admit another selected profile. This is a configuration boundary, not a sandbox
against arbitrary Python that replaces this guard or rewrites both the selector and settings.
tests/test_job_queue_flags_refused.py starts every other module under config/settings/, once with no
input and once per input it reads, and requires it to enable, permit and accept no flag; and it reads
every module under config/ and requires that none but config/settings/test.py names these settings
or imports config.settings.test. A flag reachable from production would be a standing bypass of a
guard of ADR-0004.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable

from django.conf import Settings, UserSettingsHolder, settings
from django.core.exceptions import ImproperlyConfigured

FLAGS: frozenset[str] = frozenset(
    {
        "any_role",
        "apply_state_on_duplicate",
        "audit_delete_allowed",
        "audit_second_txn",
        "audit_update_allowed",
        "budget_before_dispatch",
        "budget_off_by_one",
        "check1_reads_deliveries_first",
        "check4_skips_reservations",
        "claim_completes_across_cycles",
        "claim_completes_any_class",
        "claim_completion_unaudited",
        "claim_cycle_from_first_resume",
        "claim_ignores_closed_class_c",
        "claim_ignores_dependency",
        "claim_ignores_not_before",
        "claim_inside_transaction_allowed",
        "claim_locks_for_update",
        "claim_skips_promotion",
        "claim_waits",
        "class_c_cycle_restarts_at_claim",
        "class_c_never_again",
        "class_c_unlimited",
        "close_accepts_any_outcome",
        "close_accepts_blank_evidence",
        "close_ignores_fence",
        "close_ignores_lease",
        "close_inside_transaction_allowed",
        "close_locks_for_update",
        "close_needs_parent",
        "close_no_recheck_after_lock",
        "closed_dispatch_governs_step",
        "cycle_from_first_resume",
        "decide_any_status",
        "decide_closes_always_completed",
        "decide_closes_always_no_effect",
        "decide_closes_partial_no_effect",
        "decide_either_evidence",
        "decide_leaves_dispatch_open",
        "decide_locks_for_update",
        "decide_with_live_subjob",
        "decide_without_row_lock",
        "decided_at_before_lock",
        "decided_at_not_forced",
        "decided_txid_not_forced",
        "decision_audit_omits_staff_grant",
        "decision_omits_closed_outcome",
        "decision_rewrites_closed_dispatch",
        "decision_trigger_future",
        "decision_trigger_ignores_start_order",
        "decision_trigger_ignores_status",
        "decision_trigger_no_future_tolerance",
        "decision_trigger_no_start_tolerance",
        "decision_trigger_target_before_compute",
        "delete_allowed_in_flight",
        "delete_allowed_unresolved",
        "deleted_staff_identity_decides",
        "deleted_staff_person_decides",
        "delivery_check_ignores_changes_realm",
        "delivery_decide_any_status",
        "delivery_decide_fail_maps_pending",
        "delivery_decide_locks_for_update",
        "delivery_decide_no_effect_maps_succeeded",
        "delivery_decide_without_row_lock",
        "delivery_decision_audit_omits_staff_grant",
        "delivery_decision_audit_second_txn",
        "delivery_decision_delete_allowed",
        "delivery_decision_future",
        "delivery_decision_ignores_compute",
        "delivery_decision_ignores_role",
        "delivery_decision_ignores_start_order",
        "delivery_decision_ignores_target",
        "delivery_decision_partial_resume",
        "delivery_decision_target_before_compute",
        "delivery_decision_unaudited",
        "delivery_decision_update_allowed",
        "delivery_deleted_staff_identity_decides",
        "delivery_deleted_staff_person_decides",
        "delivery_disabled_staff_identity_decides",
        "delivery_disabled_staff_person_decides",
        "delivery_evidence_checked_before_role",
        "delivery_exit_accepts_other_delivery",
        "delivery_exit_any_transaction",
        "delivery_exit_compares_xmin",
        "delivery_exit_completed_unbound",
        "delivery_exit_fail_unbound",
        "delivery_exit_ignores_started_at",
        "delivery_exit_no_effect_unbound",
        "delivery_exit_reuses_reference",
        "delivery_exit_unguarded",
        "delivery_future_start_allowed",
        "delivery_in_flight_only",
        "delivery_no_clock_tolerance",
        "delivery_order_checked_before_presence",
        "delivery_partial_check_missing",
        "delivery_partial_checked_before_order",
        "delivery_revoked_role_decides",
        "delivery_role_of_any_identity",
        "dependent_gets_request_time",
        "disabled_staff_identity_decides",
        "disabled_staff_person_decides",
        "dispatch_closed_at_rewritable",
        "dispatch_evidence_rewritable",
        "dispatch_ignores_fence",
        "dispatch_ignores_lease",
        "dispatch_ignores_parent",
        "dispatch_inside_transaction_allowed",
        "dispatch_locks_for_update",
        "dispatch_no_recheck_after_lock",
        "dispatch_no_recheck_after_parent",
        "dispatch_outcome_rewritable",
        "dispatch_without_row_lock",
        "evidence_check_skips_compute_terminated_provider",
        "evidence_check_skips_compute_terminated_request_id",
        "evidence_check_skips_compute_terminated_resource_id",
        "evidence_check_skips_target_read_provider",
        "evidence_check_skips_target_read_request_id",
        "evidence_check_skips_target_read_resource_id",
        "evidence_checked_before_role",
        "evidence_order_unchecked",
        "exhausted_closes_completed",
        "exhausted_closes_without_evidence_ref",
        "exhausted_resets_steps",
        "exhausted_subjob_leaves_dispatch_open",
        "fail_decision_closes_completed",
        "fail_decision_closes_without_evidence_ref",
        "fail_decision_leaves_parent_dispatch_open",
        "fail_decision_resets_steps",
        "fail_keeps_reservation",
        "finish_accepts_any_status",
        "finish_closes_without_evidence_ref",
        "finish_error_code_outside_set",
        "finish_failed_ignores_live_subjob",
        "finish_failed_with_open_dispatch",
        "finish_ignores_fence",
        "finish_ignores_lease",
        "finish_ignores_live_subjob",
        "finish_ignores_open_dispatch",
        "finish_ignores_steps",
        "finish_inside_transaction_allowed",
        "finish_keeps_live_locks",
        "finish_leaves_parent_dispatch_open",
        "finish_locks_for_update",
        "finish_needs_parent",
        "finish_no_recheck_after_lock",
        "finish_succeeded_with_error_code",
        "freeze_in_flight_only",
        "freeze_skips_category",
        "freeze_skips_changes_realm",
        "freeze_skips_organisation",
        "freeze_skips_started_at",
        "freeze_unresolved_only",
        "future_evidence_allowed",
        "hold_ends_reservation",
        "hold_ignores_fence",
        "hold_ignores_lease",
        "hold_inside_transaction_allowed",
        "hold_locks_for_update",
        "hold_needs_parent",
        "hold_no_recheck_after_lock",
        "hold_unaudited",
        "interleave_reservation_and_live",
        "job_decided_at_before_dispatch",
        "job_decided_at_future",
        "job_decided_txid_not_forced",
        "job_decision_delete_allowed",
        "job_decision_update_allowed",
        "isolation_unchecked",
        "job_delete_allowed",
        "job_error_code_check_failed_missing",
        "job_error_code_check_unfailed_missing",
        "job_exit_accepts_other_job",
        "job_exit_any_transaction",
        "job_exit_fail_unbound",
        "job_exit_resume_unbound",
        "job_exit_reuses_reference",
        "job_exit_unguarded",
        "job_lease_check_claimed_missing",
        "job_lease_check_unclaimed_missing",
        "job_partial_check_missing",
        "job_spec_mutable_actor_id",
        "job_spec_mutable_actor_type",
        "job_spec_mutable_created_at",
        "job_spec_mutable_depends_on_job_id",
        "job_spec_mutable_desired_spec_hash",
        "job_spec_mutable_id",
        "job_spec_mutable_idempotency_key",
        "job_spec_mutable_kind",
        "job_spec_mutable_max_attempts",
        "job_spec_mutable_organisation_id",
        "job_spec_mutable_parent_job_id",
        "job_spec_mutable_request_id",
        "job_spec_mutable_tenant_id",
        "job_tenant_check_realm_missing",
        "job_tenant_check_tenant_missing",
        "job_unresolved_operation_check_missing",
        "job_unresolved_step_check_missing",
        "keep_locks_on_refusal",
        "lease_uses_now",
        "no_clock_tolerance",
        "no_dedupe",
        "no_delivery_check",
        "no_effect_marks_succeeded",
        "no_effect_resume_audited",
        "no_finally_release",
        "no_promotion",
        "no_request_order",
        "no_reservation_check",
        "none_not_before_not_now",
        "order_checked_before_presence",
        "orphan_loses_place",
        "outcome_at_decision_always",
        "output_ref_accepted_with_running",
        "output_ref_accepted_with_skipped",
        "output_ref_dropped",
        "parent_closes_subjob_dispatch",
        "partial_checked_before_order",
        "partial_resume",
        "place_may_be_cleared",
        "place_may_move_earlier",
        "prerequisite_not_failed",
        "promotion_ignores_not_before",
        "promotion_instant_per_row",
        "promotion_locks_for_update",
        "promotion_waits",
        "reentrant_claim",
        "reentrant_org_unchecked",
        "release_noop",
        "renew_always_false",
        "renew_does_not_extend",
        "renew_ignores_fence",
        "renew_ignores_lease",
        "renew_inside_transaction_allowed",
        "renew_locks_for_update",
        "renew_needs_parent",
        "renew_no_recheck_after_lock",
        "request_order_tenant_only",
        "rerun_succeeded_step",
        "reservation_end_rewritable",
        "resume_claim_counts_attempt",
        "resume_completion_unaudited",
        "retarget_closed",
        "retarget_ignores_fence",
        "retarget_ignores_lease",
        "retarget_ignores_parent",
        "retarget_inside_transaction_allowed",
        "retarget_locks_for_update",
        "retarget_no_recheck_after_lock",
        "retarget_no_recheck_after_parent",
        "retarget_noop",
        "retarget_subjob_dispatch",
        "reuse_not_refused",
        "revoked_role_decides",
        "role_checked_before_status",
        "role_checked_before_subjobs",
        "role_of_any_identity",
        "run_skipped_step",
        "scan_skips_dependency_failed",
        "scan_skips_subjobs",
        "scan_subjobs_last",
        "second_open_dispatch",
        "shared_passes_exclusive",
        "skip_any_status",
        "skip_any_step",
        "skip_out_of_order",
        "start_check_skips_in_flight",
        "start_check_skips_unresolved",
        "started_every_claim",
        "step_accepts_compensated",
        "step_accepts_unknown_status",
        "step_delete_allowed",
        "step_ends_from_any_status",
        "step_error_code_without_failed",
        "step_failed_audit_drops_output_ref",
        "step_failed_unaudited",
        "step_ignores_fence",
        "step_ignores_lease",
        "step_inside_transaction_allowed",
        "step_locks_for_update",
        "step_no_recheck_after_lock",
        "step_no_recheck_after_parent",
        "step_order_unchecked",
        "step_spec_mutable_conditional",
        "step_spec_mutable_id",
        "step_spec_mutable_job_id",
        "step_spec_mutable_name",
        "step_spec_mutable_retry_class",
        "step_spec_mutable_seq",
        "step_spec_mutable_timeout_s",
        "step_succeeded_unaudited",
        "steps_after_audit",
        "stranded_subjob_kept",
        "stranding_closes_completed",
        "stranding_closes_without_evidence_ref",
        "stranding_ignores_fence",
        "stranding_ignores_parent",
        "stranding_leaves_dispatch_open",
        "stranding_locks_for_update",
        "stranding_resets_steps",
        "stranding_waits",
        "structured_evidence_unchecked",
        "subjob_close_always_completed",
        "subjob_close_always_failed",
        "subjob_full_checks",
        "subjob_gets_request_time",
        "subjob_ignores_fence",
        "subjob_key_by_step",
        "subjob_not_before_not_now",
        "subjob_relation_unguarded",
        "subjob_reports_need_parent",
        "subjob_start_class_c_cycle_restarts_at_claim",
        "subjob_start_class_c_never_again",
        "subjob_start_class_c_unlimited",
        "subjob_start_cycle_from_first_resume",
        "subjob_start_ignores_fence",
        "subjob_start_ignores_lease",
        "subjob_start_ignores_parent",
        "subjob_start_inside_transaction_allowed",
        "subjob_start_locks_for_update",
        "subjob_start_no_recheck_after_lock",
        "subjob_start_no_recheck_after_parent",
        "subjob_start_second_open_dispatch",
        "parent_write_ignores_dispatch_child",
        "parent_write_ignores_dispatch_fence",
        "parent_write_ignores_dispatch_open",
        "parent_write_ignores_dispatch_owner",
        "parent_write_ignores_status",
        "subjob_writes_ignore_parent",
        "sweep_completes_closed_step",
        "sweep_ignores_dispatch",
        "sweep_ignores_subjob_dispatch",
        "sweep_inside_transaction_allowed",
        "sweep_locks_for_update",
        "sweep_no_step_reset",
        "sweep_reads_only_dispatch_records",
        "sweep_unexpired",
        "sweep_waits",
        "target_before_compute_allowed",
    }
)


class MutantsRefused(ImproperlyConfigured):
    """A mutant flag was asked for where these settings do not permit one, or is no flag."""


def _settings_profile() -> object:
    """Find the configured profile through ordinary test overrides.

    Django's UserSettingsHolder has a class-level SETTINGS_MODULE=None, which hides the default
    holder's profile. Follow only those wrappers; an explicit assignment or deletion still wins.
    Manually configured settings without an underlying profile remain refused.
    """
    getattr(settings, "SETTINGS_MODULE", None)  # Initialize LazySettings before reading its holder.
    holder = vars(settings).get("_wrapped")
    while isinstance(holder, UserSettingsHolder):
        values = vars(holder)
        if "SETTINGS_MODULE" in values.get("_deleted", set()):
            return None
        if "SETTINGS_MODULE" in values and values["SETTINGS_MODULE"] != "config.settings.test":
            return None
        holder = holder.default_settings
    return getattr(holder, "SETTINGS_MODULE", None) if isinstance(holder, Settings) else None


def _require_permitted() -> None:
    if (
        os.environ.get("DJANGO_SETTINGS_MODULE") != "config.settings.test"
        or _settings_profile() != "config.settings.test"
        or getattr(settings, "JOB_QUEUE_MUTANTS_PERMITTED", False) is not True
    ):
        raise MutantsRefused(
            "job-queue mutant flags are refused: these settings do not permit them"
        )


def active() -> frozenset[str]:
    """The active flags: settings.JOB_QUEUE_MUTANTS, refused unless the settings permit flags and
    every member is a flag."""
    flags: object = getattr(settings, "JOB_QUEUE_MUTANTS", frozenset())
    if not isinstance(flags, frozenset):
        raise MutantsRefused("JOB_QUEUE_MUTANTS must be a frozenset of job-queue mutant flags")
    if not flags:
        return flags
    _require_permitted()
    unknown = sorted(str(flag) for flag in flags - FLAGS)
    if unknown:
        raise MutantsRefused(f"not job-queue mutant flags: {', '.join(unknown)}")
    return flags


def on(flag: str) -> bool:
    """Whether `flag` is active. A name that is no flag is a programming error."""
    if flag not in FLAGS:
        raise ValueError(f"{flag!r} is not a job-queue mutant flag")
    return flag in active()


_activation_lock = threading.Lock()
# The active flag and what undoes its settings override.
_activation: tuple[str, Callable[[], None]] | None = None


def activate(flag: str) -> None:
    """Make `flag` the one active flag of this process, until deactivate()."""
    global _activation
    _require_permitted()
    if flag not in FLAGS:
        raise ValueError(f"{flag!r} is not a job-queue mutant flag")
    # Imported here, once the settings permit a flag: every process imports this module, and only
    # a test activates one.
    from django.test.utils import override_settings

    with _activation_lock:
        if _activation is not None:
            if _activation[0] == flag:
                return
            raise MutantsRefused(f"{_activation[0]} is still active: deactivate it before {flag}")
        override = override_settings(JOB_QUEUE_MUTANTS=frozenset({flag}))
        override.enable()
        _activation = (flag, override.disable)


def deactivate() -> None:
    """Undo activate(); a no-op when no flag is active."""
    global _activation
    with _activation_lock:
        if _activation is not None:
            _activation[1]()
            _activation = None

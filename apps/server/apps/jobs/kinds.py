"""The kind registry: docs/specs/JOB_QUEUE.md §3.5, transcribed from docs/domain/JOB_CATALOGUE.md.

Per kind: the organisation-lock mode (§1, **Locks**), the tenant-lock mode (§2's `Lock` column),
`max_attempts`, and the ordered steps with their timeout in seconds, retry class and whether the
catalogue runs them only for some tenants. One entry per kind, in the catalogue's order.

Three entries are transcribed where the catalogue names no step: `provision` step 13 is its three
preflight phases as one step of 10 minutes each; `remove_domain` reverses `add_domain` steps 8, 7
and 5, then soft-deletes; `resume` checks the subscription, then reverses `suspend` steps 4, 3 and 2.
Which source the offline catalogue check compares with is open decision OD7.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, NamedTuple
from uuid import UUID

Mode = Literal["shared", "exclusive"]
RetryClass = Literal["A", "B", "C", "D"]

MINUTE = 60
HOUR = 60 * MINUTE


@dataclass(frozen=True)
class StepSpec:
    name: str
    timeout_s: int
    retry_class: RetryClass
    conditional: bool = False


@dataclass(frozen=True)
class KindSpec:
    kind: str
    organisation_lock: Mode | None
    tenant_lock: Mode | None
    max_attempts: int
    steps: tuple[StepSpec, ...]


class Lock(NamedTuple):
    lock_class: Literal["organisation", "tenant"]
    key: UUID
    mode: Mode


class SubJobRelation(NamedTuple):
    parent_kind: str
    parent_step: str
    child_kind: str


def _kind(
    kind: str,
    organisation_lock: Mode | None,
    tenant_lock: Mode | None,
    max_attempts: int,
    *steps: StepSpec,
) -> tuple[str, KindSpec]:
    return kind, KindSpec(kind, organisation_lock, tenant_lock, max_attempts, steps)


S = StepSpec

KINDS: Mapping[str, KindSpec] = dict(
    [
        _kind(
            "bootstrap_verify",
            None,
            "exclusive",
            2,
            S("load_key", MINUTE, "A"),
            S("verify_identity", 2 * MINUTE, "A"),
            S("verify_policy", 2 * MINUTE, "A"),
            S("verify_boundary", 2 * MINUTE, "A"),
            S("record", 30, "C"),
        ),
        _kind(
            "provision",
            "shared",
            "exclusive",
            3,
            S("preflight_order", MINUTE, "A"),
            S("render_profile", 3 * MINUTE, "A"),
            S("verify_project_bootstrap", 5 * MINUTE, "A"),
            S("reserve_ips", 3 * MINUTE, "A"),
            S("create_host", 20 * MINUTE, "B"),
            S("create_dns", 5 * MINUTE, "A"),
            S("create_mail_domain", 10 * MINUTE, "A"),
            S("create_storage", 5 * MINUTE, "A"),
            S("create_clients", 5 * MINUTE, "A"),
            S("store_secrets", 2 * MINUTE, "A"),
            S("configure_host", 25 * MINUTE, "B"),
            S("enrol_agent", 10 * MINUTE, "D"),
            S("preflight", 3 * 10 * MINUTE, "A"),
            S("register_observability", 3 * MINUTE, "A"),
            S("first_backup", 20 * MINUTE, "A"),
            S("mark_ready", 30, "C"),
        ),
        _kind(
            "upgrade",
            "shared",
            "exclusive",
            2,
            S("check_release", MINUTE, "A"),
            S("maintenance_on", 2 * MINUTE, "A"),
            S("safety_snapshot", 15 * MINUTE, "A"),
            S("pull", 15 * MINUTE, "B"),
            S("up", 10 * MINUTE, "B"),
            S("migrate", 15 * MINUTE, "C"),
            S("preflight", 10 * MINUTE, "A"),
            S("maintenance_off", 2 * MINUTE, "A"),
            S("record_release", 30, "C"),
        ),
        _kind(
            "backup",
            None,
            "shared",
            3,
            S("quiesce", 10 * MINUTE, "A"),
            S("snapshot", HOUR, "A"),
            S("record", 30, "C"),
            S("verify_age", MINUTE, "A"),
        ),
        _kind(
            "restore",
            "shared",
            "exclusive",
            1,
            S("select_snapshot", MINUTE, "A"),
            S("maintenance_on", 2 * MINUTE, "A"),
            S("pre_restore_snapshot", 15 * MINUTE, "A"),
            S("stop_services", 5 * MINUTE, "A"),
            S("restore_data", HOUR, "C"),
            S("start_services", 10 * MINUTE, "A"),
            S("preflight", 10 * MINUTE, "A"),
            S("maintenance_off", 2 * MINUTE, "A"),
        ),
        _kind(
            "rotate_secret",
            "shared",
            "exclusive",
            2,
            S("generate", MINUTE, "A"),
            S("update_consumers", 5 * MINUTE, "A"),
            S("push", 5 * MINUTE, "A"),
            S("reload", 5 * MINUTE, "A"),
            S("verify", 3 * MINUTE, "A"),
            S("retire", 30, "C"),
        ),
        _kind(
            "add_domain",
            "shared",
            "exclusive",
            1,
            S("issue_nonce", 30, "A"),
            S("await_txt", 72 * HOUR, "D"),
            S("check_caa", MINUTE, "A"),
            # "The remainder of the TTL": bounded here by the TTL itself.
            S("await_target", 72 * HOUR, "D"),
            S("add_to_cert_list", 2 * MINUTE, "A"),
            S("await_certificate", 15 * MINUTE, "D"),
            S("sync_media_cert", 5 * MINUTE, "A", conditional=True),
            S("update_application", 5 * MINUTE, "A"),
            S("mark_live", 30, "C"),
        ),
        _kind(
            "remove_domain",
            "shared",
            "exclusive",
            3,
            S("revert_application", 5 * MINUTE, "A"),
            S("remove_media_cert", 5 * MINUTE, "A", conditional=True),
            S("remove_from_cert_list", 2 * MINUTE, "A"),
            S("soft_delete", 30, "C"),
        ),
        _kind(
            "suspend",
            "shared",
            "exclusive",
            3,
            S("record_reason", 30, "C"),
            S("disable_logins", 2 * MINUTE, "A"),
            S("edge_notice", 2 * MINUTE, "A"),
            S("pause_schedules", MINUTE, "A"),
            S("notify", MINUTE, "A"),
        ),
        _kind(
            "resume",
            "shared",
            "exclusive",
            3,
            S("check_subscription", 30, "A"),
            S("resume_schedules", MINUTE, "A"),
            S("remove_edge_notice", 2 * MINUTE, "A"),
            S("enable_logins", 2 * MINUTE, "A"),
        ),
        _kind(
            "decommission",
            "shared",
            "exclusive",
            1,
            S("verify_exit_boundary", 30, "A"),
            S("disable_clients", 2 * MINUTE, "A"),
            S("stop_and_drain_services", 10 * MINUTE, "A"),
            S("final_backup", 30 * MINUTE, "A"),
            S("mark_exit_prepared", 30, "C"),
        ),
        _kind(
            "export",
            "shared",
            "shared",
            2,
            S("resolve_scope", 30, "A"),
            S("collect_users", 10 * MINUTE, "A"),
            S("collect_rooms", 10 * MINUTE, "A"),
            S("collect_documents", HOUR, "A"),
            S("collect_realm", 10 * MINUTE, "A"),
            S("collect_audit", 10 * MINUTE, "A"),
            S("package", 20 * MINUTE, "C"),
            S("publish", MINUTE, "C"),
        ),
        _kind(
            "delete",
            "shared",
            "exclusive",
            1,
            S("confirm", 30, "C"),
            S("destroy_infrastructure", 30 * MINUTE, "C"),
            S("release_addresses", 5 * MINUTE, "C"),
            S("delete_dns", 5 * MINUTE, "C"),
            S("delete_clients", 5 * MINUTE, "C"),
            S("revoke_secrets", MINUTE, "C"),
            S("hand_over_project_closure", MINUTE, "C"),
            S("register_deletion_finalization", MINUTE, "C"),
            S("mark_destruction_complete", 30, "C"),
        ),
        _kind(
            "drift_check",
            None,
            "shared",
            2,
            S("plan", 15 * MINUTE, "A"),
            S("ansible_check", 20 * MINUTE, "A"),
            S("render_registry", 2 * MINUTE, "A"),
            S("domain_checks", 5 * MINUTE, "A"),
            S("record", 30, "C"),
        ),
        _kind(
            "realm_create",
            "exclusive",
            None,
            3,
            S("create_realm", 2 * MINUTE, "A"),
            S("create_clients", 2 * MINUTE, "A"),
            S("create_service_account", MINUTE, "A"),
            S("configure_idp", 3 * MINUTE, "A"),
            S("configure_smtp", MINUTE, "A"),
            S("apply_theme", MINUTE, "A"),
            S("verify", 2 * MINUTE, "A"),
        ),
        _kind(
            "realm_update",
            "exclusive",
            None,
            3,
            S("create_clients", 2 * MINUTE, "A"),
            S("configure_idp", 3 * MINUTE, "A"),
            S("configure_smtp", MINUTE, "A"),
            S("apply_theme", MINUTE, "A"),
            S("verify", 2 * MINUTE, "A"),
        ),
    ]
)

REALM_KINDS = frozenset({"realm_create", "realm_update"})

# This is the closed production authorization list. The current catalogue declares no sub-job
# producer, so every production attempt is refused. Tests of the generic queue primitive pass an
# exact relation directly to the private runner implementation instead of widening this registry.
SUB_JOB_RELATIONS: frozenset[SubJobRelation] = frozenset()


def sub_job_relation(parent_kind: str, parent_seq: int, child_kind: str) -> SubJobRelation | None:
    """Return the named relation for three valid catalogue coordinates, otherwise no relation."""
    parent = KINDS.get(parent_kind)
    if parent is None or child_kind not in KINDS or not 1 <= parent_seq <= len(parent.steps):
        return None
    return SubJobRelation(parent_kind, parent.steps[parent_seq - 1].name, child_kind)


def lock_set(kind: str, organisation_id: UUID, tenant_id: UUID | None) -> tuple[Lock, ...]:
    """The locks a job of `kind` takes, in the order it takes them: organisation, then tenant."""
    spec = KINDS[kind]
    locks: list[Lock] = []
    if spec.organisation_lock is not None:
        locks.append(Lock("organisation", organisation_id, spec.organisation_lock))
    if spec.tenant_lock is not None:
        if tenant_id is None:
            raise ValueError(f"{kind} takes a tenant lock and needs a tenant")
        locks.append(Lock("tenant", tenant_id, spec.tenant_lock))
    return tuple(locks)

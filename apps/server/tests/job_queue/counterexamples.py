"""Two deliberately broken job queues. Neither is an implementation, and neither can pass a test.

`test_job_queue_selftest.py` runs every acceptance test against both and requires each to fail
with the exact assertion its row in `acceptance.toml` names. That is how a reader can tell a test
fails against these two broken queues for the reason it names, rather than being red only because
`apps.jobs` does not exist.

- `PermissiveBinding` writes the tables of `docs/specs/JOB_QUEUE.md` §3 with the same names and
  columns, in a scratch schema, and gets every guard wrong: each statement commits on its own, no key
  is deduplicated, no fence, lease, reservation, request order, dependency, parent, role or evidence
  is checked, no row is locked, any step may be skipped, a refused claim keeps the live locks it took, releasing live locks
  does nothing, and the sweep orphans whatever expired. It does take live advisory locks, under the
  spec's keys, so a test cannot pass merely because a queue ignores locks altogether.
- `InertBinding` writes nothing and refuses everything: the queue a test that only asserts absences
  would wrongly accept.

The single-guard mutants of a conforming queue, each naming the owning test of its property that
must catch it, are listed in `mutants.toml`; this repository does not run them, and running them
needs the implementation (docs/specs/JOB_QUEUE.md §9.2).
"""

from __future__ import annotations

import uuid
from typing import Any

from queue_harness import (
    COUNTEREXAMPLE_SCHEMA,
    LOCK_CLASS_CODE,
    ORGANISATION_LOCK,
    RECORDED,
    TENANT_LOCK,
    insert_probe,
    refusal,
    sql,
)

STEPS = {
    "backup": ("quiesce", "snapshot", "record", "verify_age"),
    "rotate_secret": ("generate", "update_consumers", "push", "reload", "verify", "retire"),
    "restore": (
        "select_snapshot",
        "maintenance_on",
        "pre_restore_snapshot",
        "stop_services",
        "restore_data",
        "start_services",
        "preflight",
        "maintenance_off",
    ),
    "decommission": (
        "verify_exit_boundary",
        "disable_clients",
        "stop_and_drain_services",
        "final_backup",
        "mark_exit_prepared",
    ),
    "export": (
        "resolve_scope",
        "collect_users",
        "collect_rooms",
        "collect_documents",
        "collect_realm",
        "collect_audit",
        "package",
        "publish",
    ),
    "delete": (
        "confirm",
        "destroy_infrastructure",
        "release_addresses",
        "delete_dns",
        "delete_clients",
        "revoke_secrets",
        "hand_over_project_closure",
        "register_deletion_finalization",
        "mark_destruction_complete",
    ),
    "realm_create": (
        "create_realm",
        "create_clients",
        "create_service_account",
        "configure_idp",
        "configure_smtp",
        "apply_theme",
        "verify",
    ),
    "realm_update": ("create_clients", "configure_idp", "configure_smtp", "apply_theme", "verify"),
    "provision": ("preflight_order", "render_profile", "verify_project_bootstrap"),
    "add_domain": (
        "issue_nonce",
        "await_txt",
        "check_caa",
        "await_target",
        "add_to_cert_list",
        "await_certificate",
        "sync_media_cert",
        "update_application",
        "mark_live",
    ),
}
# JOB_CATALOGUE.md §2: `max_attempts` per kind the tests use.
MAX_ATTEMPTS = {
    "restore": 1,
    "backup": 3,
    "rotate_secret": 2,
    "decommission": 1,
    "export": 2,
    "delete": 1,
    "provision": 3,
    "realm_create": 3,
    "realm_update": 3,
    "add_domain": 1,
}
# JOB_CATALOGUE.md §2: the retry class C steps of those kinds, by (kind, seq).
CLASS_C = {
    ("backup", 3),
    ("rotate_secret", 6),
    ("restore", 5),
    ("decommission", 5),
    ("export", 7),
    ("export", 8),
    ("delete", 1),
    ("delete", 2),
    ("delete", 3),
    ("delete", 4),
    ("delete", 5),
    ("delete", 6),
    ("delete", 7),
    ("delete", 8),
    ("delete", 9),
    ("add_domain", 9),
}
# JOB_CATALOGUE.md §2: the steps a kind runs only for some tenants, by (kind, seq).
CONDITIONAL = {("add_domain", 7)}

EVIDENCE_COLUMNS = """
  compute_terminated_provider text, compute_terminated_resource_id text,
  compute_terminated_request_id text, compute_terminated_observed_at timestamptz,
  target_read_provider text, target_read_resource_id text, target_read_request_id text,
  target_read_observed_at timestamptz, decided_by_identity_id uuid, decided_by_role text,
  decided_at timestamptz DEFAULT clock_timestamp()"""

DDL = (
    """
CREATE SCHEMA IF NOT EXISTS {s};
CREATE TABLE IF NOT EXISTS {s}.jobs_job (
  id uuid PRIMARY KEY, organisation_id uuid, tenant_id uuid, kind text, idempotency_key text,
  desired_spec_hash text, status text, lease_expires_at timestamptz, runner_id text,
  fence bigint NOT NULL DEFAULT 0, attempt int NOT NULL DEFAULT 0, max_attempts int,
  unresolved_step_id uuid, unresolved_operation_ref text, reconciliation_decision_ref uuid,
  lock_requested_at timestamptz, depends_on_job_id uuid, parent_job_id uuid,
  not_before timestamptz NOT NULL DEFAULT clock_timestamp(), actor_type text, actor_id uuid,
  request_id text, started_at timestamptz, finished_at timestamptz, error_code text,
  artefact_refs jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS {s}.jobs_jobstep (
  id uuid PRIMARY KEY, job_id uuid, seq int, name text, status text, retry_class text,
  conditional boolean DEFAULT false, attempt int DEFAULT 0, started_at timestamptz,
  finished_at timestamptz, timeout_s int, output_ref text, error_code text);
CREATE TABLE IF NOT EXISTS {s}.jobs_joblockreservation (
  id uuid PRIMARY KEY, job_id uuid, fence bigint, lock_class text, lock_key uuid, mode text,
  reserved_at timestamptz DEFAULT now(), ended_at timestamptz);
CREATE TABLE IF NOT EXISTS {s}.jobs_jobdispatch (
  id uuid PRIMARY KEY, job_id uuid, step_id uuid, fence bigint, operation_ref text,
  sub_job_id uuid, dispatched_at timestamptz DEFAULT clock_timestamp(), closed_at timestamptz,
  terminal_outcome text, terminal_evidence_ref text);
CREATE TABLE IF NOT EXISTS {s}.jobs_jobreconciliationdecision (
  id uuid PRIMARY KEY, job_id uuid, exit text, operation_outcome text,
  unresolved_step_id uuid, unresolved_operation_ref text, dispatch_outcome_at_decision text,"""
    + EVIDENCE_COLUMNS
    + """);
CREATE TABLE IF NOT EXISTS {s}.outbox_outboxdelivery (
  id uuid PRIMARY KEY, organisation_id uuid, category text, changes_realm boolean, status text,
  operation_ref text, reconciliation_decision_ref uuid, started_at timestamptz,
  finished_at timestamptz, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS {s}.outbox_deliverydecision (
  id uuid PRIMARY KEY, delivery_id uuid, exit text, operation_outcome text,
  decided_txid bigint,"""
    + EVIDENCE_COLUMNS
    + """);
CREATE TABLE IF NOT EXISTS {s}.audit_auditevent (
  id uuid PRIMARY KEY, occurred_at timestamptz DEFAULT now(), actor_type text, actor_id uuid,
  actor_label text, organisation_id uuid, action text, target_urn text, before jsonb, after jsonb,
  request_id text, job_id uuid, source_ip_trunc inet, retention_class text, metadata jsonb);
TRUNCATE {s}.jobs_job, {s}.jobs_jobstep, {s}.jobs_joblockreservation, {s}.jobs_jobdispatch,
  {s}.jobs_jobreconciliationdecision, {s}.outbox_outboxdelivery, {s}.outbox_deliverydecision,
  {s}.audit_auditevent;
"""
)


def install(connection: Any, schema: str = COUNTEREXAMPLE_SCHEMA) -> None:
    connection.execute(sql(DDL, schema))


def locks_of(kind: str, organisation: Any, tenant: Any) -> list[tuple[str, str, str]]:
    found = []
    if kind in ORGANISATION_LOCK:
        found.append(("organisation", str(organisation), ORGANISATION_LOCK[kind]))
    if kind in TENANT_LOCK:
        found.append(("tenant", str(tenant), TENANT_LOCK[kind]))
    return found


def _retry_class(kind: str, seq: int) -> str:
    return "C" if (kind, seq) in CLASS_C else "A"


class ScratchQueue:
    """Plumbing shared by the counterexamples: a scratch schema and the actor's own session."""

    schema = COUNTEREXAMPLE_SCHEMA

    @classmethod
    def install(cls, connection: Any) -> None:
        install(connection, cls.schema)

    def run(self, template: str, parameters: Any = ()) -> list[tuple[Any, ...]]:
        from django.db import connection

        with connection.cursor() as cursor:
            cursor.execute(sql(template, self.schema), parameters)
            return list(cursor.fetchall()) if cursor.description else []

    def one(self, template: str, parameters: Any = ()) -> Any:
        found = self.run(template, parameters)
        return found[0] if found else None

    def job(self, job_id: str, suffix: str = "") -> dict[str, Any] | None:
        from django.db import connection

        query = "SELECT * FROM {s}.jobs_job WHERE id = %s " + suffix  # noqa: S608 - locking clause
        with connection.cursor() as cursor:
            cursor.execute(sql(query, self.schema), [str(job_id)])
            row = cursor.fetchone()
            if row is None:
                return None
            return dict(zip([column.name for column in cursor.description], row, strict=True))

    def audit(self, action: str, job_id: str, actor: str = "system") -> None:
        self.run(
            "INSERT INTO {s}.audit_auditevent (id, action, job_id, actor_type) "
            "VALUES (%s, %s, %s, %s)",
            [str(uuid.uuid4()), action, str(job_id), actor],
        )


class PermissiveBinding(ScratchQueue):
    name = "permissive"

    def _insert_job(self, request: dict[str, Any], parent: str | None) -> str:
        job_id = str(uuid.uuid4())
        self.run(
            "INSERT INTO {s}.jobs_job (id, organisation_id, tenant_id, kind, idempotency_key, "
            "desired_spec_hash, status, max_attempts, depends_on_job_id, parent_job_id, actor_type, "
            "not_before, lock_requested_at) VALUES (%s, %s, %s, %s, %s, %s, 'queued', %s, %s, %s, "
            "%s, coalesce(%s::timestamptz, clock_timestamp()), clock_timestamp())",
            [
                job_id,
                request["organisation_id"],
                request["tenant_id"],
                request["kind"],
                request["idempotency_key"],
                request["desired_spec_hash"],
                MAX_ATTEMPTS.get(request["kind"], 3),
                request.get("depends_on_job_id"),
                parent,
                request["actor_type"],
                request.get("not_before"),
            ],
        )
        return job_id

    def _insert_steps(self, job_id: str, kind: str) -> None:
        for seq, name in enumerate(STEPS.get(kind, ("step",)), start=1):
            self.run(
                "INSERT INTO {s}.jobs_jobstep (id, job_id, seq, name, status, retry_class, "
                "conditional) VALUES (%s, %s, %s, %s, 'pending', %s, %s)",
                [
                    str(uuid.uuid4()),
                    job_id,
                    seq,
                    name,
                    _retry_class(kind, seq),
                    (kind, seq) in CONDITIONAL,
                ],
            )

    def enqueue(self, *, request: dict[str, Any], probe: str | None) -> dict[str, Any]:
        job_id = self._insert_job(request, None)
        if probe is not None:
            insert_probe(self.schema, probe)
        self._insert_steps(job_id, request["kind"])
        self.audit("job.created", job_id)
        return {"job_id": job_id, "created": True}

    def claim(self, *, runner_id: str, job_id: str | None) -> tuple[dict[str, Any], Any]:
        if job_id is None:
            found = self.one(
                "SELECT id FROM {s}.jobs_job WHERE status IN ('queued', 'orphaned') "
                "ORDER BY lock_requested_at NULLS LAST, id LIMIT 1"
            )
            if found is None:
                return {"outcome": "none"}, None
            job_id = str(found[0])
        job = self.job(job_id)
        if job is None or job["status"] not in ("queued", "orphaned"):
            return {"outcome": "refused", "job_id": job_id, "reason": "not_claimable"}, None
        locks = locks_of(job["kind"], job["organisation_id"], job["tenant_id"])
        for lock_class, key, mode in locks:
            function = "pg_try_advisory_lock_shared" if mode == "shared" else "pg_try_advisory_lock"
            taken = self.one(
                "SELECT " + function + "(%s, hashtext(%s))", [LOCK_CLASS_CODE[lock_class], key]
            )
            if not taken[0]:
                return {"outcome": "refused", "job_id": job_id, "reason": "live_lock_busy"}, None
        fence = self.one(
            "UPDATE {s}.jobs_job SET status = 'leased', fence = fence + 1, attempt = attempt + 1, "
            "runner_id = %s, lease_expires_at = clock_timestamp() + interval '120 seconds' "
            "WHERE id = %s RETURNING fence",
            [runner_id, job_id],
        )[0]
        for lock_class, key, mode in locks:
            self.run(
                "INSERT INTO {s}.jobs_joblockreservation (id, job_id, fence, lock_class, lock_key, "
                "mode) VALUES (%s, %s, %s, %s, %s, %s)",
                [str(uuid.uuid4()), job_id, fence, lock_class, key, mode],
            )
        claim = {"job_id": job_id, "fence": int(fence)}
        return {"outcome": "claimed", "job_id": job_id, "fence": int(fence)}, claim

    def renew(self, *, claim: Any) -> bool:
        self.run(
            "UPDATE {s}.jobs_job SET lease_expires_at = clock_timestamp() + interval '120 seconds' "
            "WHERE id = %s",
            [claim["job_id"]],
        )
        return True

    def record_step(
        self,
        *,
        claim: Any,
        seq: int,
        status: str,
        error_code: str | None = None,
        output_ref: str | None = None,
    ) -> bool:
        self.run(
            "UPDATE {s}.jobs_jobstep SET status = %s WHERE job_id = %s AND seq = %s",
            [status, claim["job_id"], seq],
        )
        if status == "running":
            self.run("UPDATE {s}.jobs_job SET status = 'running' WHERE id = %s", [claim["job_id"]])
        return True

    def _dispatch(self, claim: Any, seq: int, operation_ref: str, sub_job_id: str | None) -> str:
        dispatch_id = str(uuid.uuid4())
        self.run(
            "INSERT INTO {s}.jobs_jobdispatch (id, job_id, step_id, fence, operation_ref, "
            "sub_job_id) SELECT %s, %s, id, %s, %s, %s FROM {s}.jobs_jobstep "
            "WHERE job_id = %s AND seq = %s",
            [
                dispatch_id,
                claim["job_id"],
                claim["fence"],
                operation_ref,
                sub_job_id,
                claim["job_id"],
                seq,
            ],
        )
        return dispatch_id

    def record_dispatch(self, *, claim: Any, seq: int, operation_ref: str) -> str:
        return self._dispatch(claim, seq, operation_ref, None)

    def retarget_dispatch(self, *, claim: Any, dispatch_id: str, operation_ref: str) -> bool:
        self.run(
            "UPDATE {s}.jobs_jobdispatch SET operation_ref = %s WHERE id = %s",
            [operation_ref, dispatch_id],
        )
        return True

    def start_sub_job(
        self,
        *,
        claim: Any,
        seq: int,
        kind: str,
        desired_spec_hash: str,
        test_relation: bool = True,
    ) -> str:
        parent = self.job(claim["job_id"])
        assert parent is not None
        request = {
            "organisation_id": str(parent["organisation_id"]),
            "tenant_id": None if parent["tenant_id"] is None else str(parent["tenant_id"]),
            "kind": kind,
            "idempotency_key": uuid.uuid4().hex,
            "desired_spec_hash": desired_spec_hash,
            "actor_type": "system",
        }
        sub_job_id = self._insert_job(request, claim["job_id"])
        self._insert_steps(sub_job_id, kind)
        self._dispatch(claim, seq, "job:" + sub_job_id, sub_job_id)
        return sub_job_id

    def close_dispatch(
        self, *, claim: Any, dispatch_id: str, outcome: str, evidence_ref: str
    ) -> bool:
        self.run(
            "UPDATE {s}.jobs_jobdispatch SET closed_at = clock_timestamp(), terminal_outcome = %s, "
            "terminal_evidence_ref = %s WHERE id = %s",
            [outcome, evidence_ref, dispatch_id],
        )
        return True

    def hold_for_reconciliation(self, *, claim: Any, dispatch_id: str) -> bool:
        step_id, operation_ref = self.one(
            "SELECT step_id, operation_ref FROM {s}.jobs_jobdispatch WHERE id = %s", [dispatch_id]
        )
        self.run(
            "UPDATE {s}.jobs_job SET status = 'needs_reconciliation', lease_expires_at = NULL, "
            "unresolved_step_id = %s, unresolved_operation_ref = %s WHERE id = %s",
            [step_id, operation_ref, claim["job_id"]],
        )
        self.audit("job.reconciliation_required", claim["job_id"])
        return True

    def _end(self, job_id: str) -> None:
        self.run(
            "UPDATE {s}.jobs_joblockreservation SET ended_at = now() "
            "WHERE job_id = %s AND ended_at IS NULL",
            [job_id],
        )

    def finish(self, *, claim: Any, status: str, error_code: str | None = None) -> bool:
        self.run(
            "UPDATE {s}.jobs_job SET status = %s, error_code = %s, lease_expires_at = NULL "
            "WHERE id = %s",
            [status, error_code, claim["job_id"]],
        )
        self._end(claim["job_id"])
        job = self.job(claim["job_id"])
        assert job is not None
        for lock_class, key, mode in locks_of(
            job["kind"], job["organisation_id"], job["tenant_id"]
        ):
            function = "pg_advisory_unlock_shared" if mode == "shared" else "pg_advisory_unlock"
            self.run(
                "SELECT " + function + "(%s, hashtext(%s))", [LOCK_CLASS_CODE[lock_class], key]
            )
        self.audit("job." + status, claim["job_id"])
        return True

    def release_live_locks(self, *, claim: Any) -> None:
        return None

    def sweep(self) -> None:
        for (job_id,) in self.run(
            "SELECT id FROM {s}.jobs_job WHERE status IN ('leased', 'running') "
            "AND lease_expires_at < clock_timestamp()"
        ):
            self.run(
                "UPDATE {s}.jobs_job SET status = 'orphaned', lease_expires_at = NULL WHERE id = %s",
                [job_id],
            )
            self.run(
                "UPDATE {s}.jobs_jobstep SET status = 'pending' "
                "WHERE job_id = %s AND status = 'running'",
                [job_id],
            )
            self._end(str(job_id))
            self.audit("job.orphaned", str(job_id))

    def resolve(self, *, principal: dict[str, Any]) -> str:
        return "resolved"

    def decide(self, *, principal: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
        job_id = decision["subject_id"]
        self.run(
            "INSERT INTO {s}.jobs_jobreconciliationdecision (id, job_id, exit, operation_outcome) "
            "VALUES (%s, %s, %s, %s)",
            [str(uuid.uuid4()), job_id, decision["exit"], decision["operation_outcome"]],
        )
        if decision["exit"] == "resume":
            self.run("UPDATE {s}.jobs_job SET status = 'queued' WHERE id = %s", [job_id])
        else:
            self.run(
                "UPDATE {s}.jobs_job SET status = 'failed', error_code = 'reconciliation_failed' "
                "WHERE id = %s",
                [job_id],
            )
            self._end(job_id)
        self.audit("job.reconciliation_decided", job_id, actor="staff")
        return RECORDED

    def decide_delivery(
        self, *, principal: dict[str, Any], decision: dict[str, Any]
    ) -> dict[str, Any]:
        self.run(
            "UPDATE {s}.outbox_outboxdelivery SET status = 'succeeded' WHERE id = %s",
            [decision["subject_id"]],
        )
        return RECORDED


class InertBinding(ScratchQueue):
    name = "inert"

    def enqueue(self, *, request: dict[str, Any], probe: str | None) -> dict[str, Any]:
        return {"job_id": str(uuid.uuid4()), "created": True}

    def claim(self, *, runner_id: str, job_id: str | None) -> tuple[dict[str, Any], Any]:
        if job_id is None:
            return {"outcome": "none"}, None
        return {"outcome": "refused", "job_id": job_id, "reason": "not_claimable"}, None

    def renew(self, **_: Any) -> bool:
        return False

    def record_step(self, **_: Any) -> bool:
        return False

    def record_dispatch(self, **_: Any) -> None:
        return None

    def retarget_dispatch(self, **_: Any) -> bool:
        return False

    def start_sub_job(self, **_: Any) -> None:
        return None

    def close_dispatch(self, **_: Any) -> bool:
        return False

    def hold_for_reconciliation(self, **_: Any) -> bool:
        return False

    def finish(self, **_: Any) -> bool:
        return False

    def release_live_locks(self, **_: Any) -> None:
        return None

    def sweep(self) -> None:
        return None

    def resolve(self, **_: Any) -> None:
        return None

    def decide(self, **_: Any) -> dict[str, Any]:
        return refusal("not_in_reconciliation")

    def decide_delivery(self, **_: Any) -> dict[str, Any]:
        return refusal("not_in_reconciliation")


BINDINGS: dict[str, type[ScratchQueue]] = {"permissive": PermissiveBinding, "inert": InertBinding}

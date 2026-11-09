"""The harness the job-queue acceptance tests run on: a binding, actors, and an observer.

`docs/specs/JOB_QUEUE.md` §4 names the service functions A3 must provide. The tests never call
them directly. They call a **binding**, which turns JSON-shaped arguments into those calls, from an
**actor**: a thread or a child process with its own database session, so that sessions, live
advisory locks and process death are real. What happened is read by an **observer**, a separate
PostgreSQL session reading the spec's tables and PostgreSQL's own lock views, so no assertion rests
on the implementation's account of itself.

Bindings: `real` is the implementation, and today it measures what is missing and raises
`QueueGapError` naming it. `permissive` and `inert` are the counterexample queues of
`counterexamples.py`, bound to a scratch schema. `JOB_QUEUE_EXTRA_BINDINGS` may name a module whose
`BINDINGS` adds more — a local reference queue and its single-guard mutants, which this repository
does not carry; it is refused under `CI`. `real:<flag>` is the implementation with one mutant flag of
`mutants.toml` active (§9.2).

SQL here names only the spec's fixed tables and a test-owned schema, substituted for `{s}`; every
value is a bound parameter.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import hashlib
import importlib
import importlib.util
import itertools
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import database_mutants
import pytest

HERE = Path(__file__).resolve().parent
# A proof run from a disposable copy of this directory names the repository it belongs to.
ROOT = Path(os.environ.get("JOB_QUEUE_REPOSITORY_ROOT") or HERE.parents[1])
INVENTORY_PATH = HERE / "acceptance.toml"
MUTANTS_PATH = HERE / "mutants.toml"
SPEC_PATH = ROOT / "docs" / "specs" / "JOB_QUEUE.md"
MARKER = "job_queue_acceptance"
ID_PATTERN = re.compile(r"A3-\d{2}")
GAP_PATTERN = re.compile(r"(app|module|service):[A-Za-z0-9_.]+")

PUBLIC = "public"
COUNTEREXAMPLE_SCHEMA = "a3_counterexample"
PROBE_TABLE = "a3_desired_state_probe"

# docs/specs/JOB_QUEUE.md §4.3: the two-integer advisory key, class code first.
LOCK_CLASS_CODE = {"organisation": 1, "tenant": 2}
ACTOR_TIMEOUT_S = 45.0
BARRIER_TIMEOUT_S = 30.0

# JOB_CATALOGUE.md §1 (organisation-lock modes) and §2 (the `Lock` column, which is the tenant lock).
ORGANISATION_LOCK = {
    "realm_create": "exclusive",
    "realm_update": "exclusive",
    "provision": "shared",
    "upgrade": "shared",
    "restore": "shared",
    "rotate_secret": "shared",
    "add_domain": "shared",
    "remove_domain": "shared",
    "suspend": "shared",
    "resume": "shared",
    "decommission": "shared",
    "export": "shared",
    "delete": "shared",
}
TENANT_LOCK = {
    "bootstrap_verify": "exclusive",
    "provision": "exclusive",
    "upgrade": "exclusive",
    "backup": "shared",
    "restore": "exclusive",
    "rotate_secret": "exclusive",
    "add_domain": "exclusive",
    "remove_domain": "exclusive",
    "suspend": "exclusive",
    "resume": "exclusive",
    "decommission": "exclusive",
    "export": "shared",
    "delete": "exclusive",
    "drift_check": "shared",
}
# JOB_CATALOGUE.md §2, `backup`: its steps, and step 3 `record` is retry class C.
BACKUP_STEPS = ("quiesce", "snapshot", "record", "verify_age")

# The one staff issuer, config.settings.test's fixed KODERA_STAFF_ISSUER, which every actor
# process reads too (docs/specs/STAFF_IDENTITY.md §1, §5). A staff principal's evidence names it; a
# customer's names its organisation's issuer.
STAFF_ISSUER = "https://identity.staff.test/realms/kodera-staff"
# What a binding's `decide` and `decide_delivery` return when no staff principal could be resolved
# from the evidence: the decision function was not reached. Not a §3.3 reason.
PRINCIPAL_REFUSED: dict[str, Any] = {"recorded": False, "reason": "principal_refused"}

# One identifier per acceptance test; its state is `acceptance.toml`'s, bound by the conftest.
job_queue_acceptance = pytest.mark.job_queue_acceptance


class QueueGapError(Exception):
    """The first thing a test reached that this tree does not have. Never a verdict on a queue."""

    def __init__(self, gap: str, detail: str) -> None:
        if GAP_PATTERN.fullmatch(gap) is None:
            raise ValueError(f"malformed gap name: {gap!r}")
        super().__init__(f"{gap}: {detail}")
        self.gap = gap
        self.detail = detail


class ActorError(RuntimeError):
    """An actor's call raised something other than a gap: a failure of the queue or the harness."""


class BarrierError(RuntimeError):
    """An actor never reached, or never left, a barrier the test set for it.

    A failure of the harness's own expectation, so deliberately not an `AssertionError`: a timeout
    must never read as a verdict on the queue."""


def gap_is_missing(gap: str) -> bool:
    """Measure a recorded gap again: True while this tree still lacks what the gap names."""
    kind, _, name = gap.partition(":")
    if kind == "app":
        from django.apps import apps as registry

        return not registry.is_installed(name)
    module = name if kind == "module" else name.rpartition(".")[0]
    try:
        found = importlib.util.find_spec(module)
    except ModuleNotFoundError:
        return True
    if found is None:
        return True
    return kind != "module" and not hasattr(
        importlib.import_module(module), name.rpartition(".")[2]
    )


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def key_digest(*parts: str | int) -> str:
    """docs/specs/JOB_QUEUE.md §3.4: sha256 over the parts as one canonical JSON array."""
    return digest(json.dumps(list(parts), separators=(",", ":"), ensure_ascii=True))


def sql(template: str, schema: str) -> str:
    return template.replace("{s}", f'"{schema}"')


# ------------------------------------------------------------------------------- bindings ----


def _uuid(value: str | None) -> uuid.UUID | None:
    return None if value is None else uuid.UUID(value)


def _instant(value: str | None) -> dt.datetime | None:
    return None if value is None else dt.datetime.fromisoformat(value)


class RealBinding:
    """`apps.jobs.services`, measured: each missing piece raises the gap that names it."""

    name = "real"
    schema = PUBLIC
    APPS = ("apps.jobs", "apps.outbox", "apps.audit")
    SERVICES = "apps.jobs.services"
    # Every name `require` is ever asked for: with APPS and SERVICES, the closed list of gaps.
    NAMES = (
        "JobRequest",
        "resolve_staff_principal",
        "StaffPrincipalError",
        "Evidence",
        "ReconciliationDecision",
        "DecisionRefused",
        "IdempotencyKeyReuse",
        "Claim",
        "enqueue_job",
        "claim_job",
        "renew_lease",
        "record_step",
        "record_dispatch",
        "retarget_dispatch",
        "start_sub_job",
        "close_dispatch",
        "hold_for_reconciliation",
        "finish_job",
        "release_live_locks",
        "sweep_expired_leases",
        "record_reconciliation_decision",
        "record_delivery_reconciliation_decision",
    )

    @classmethod
    def gaps(cls) -> frozenset[str]:
        """The closed list of gaps this binding can raise; no other gap is ever an honest one."""
        return frozenset(
            [f"app:{app}" for app in cls.APPS]
            + [f"module:{cls.SERVICES}"]
            + [f"service:{cls.SERVICES}.{name}" for name in cls.NAMES]
        )

    # The one mutant flag a binding runs under: binding_class sets it on each real:<flag> class.
    # None here.
    flag = ""

    def __init__(self, *, apps: tuple[str, ...] = APPS, services: str = SERVICES) -> None:
        self.apps = apps
        self.services = services
        # Principals resolved ahead of a decision by `resolve`, by the handle it returned.
        self.resolved: dict[str, Any] = {}
        if not self.flag:
            from django.conf import settings

            # Read from the settings, not apps.jobs.mutants: the binding must still measure a
            # tree without apps.jobs.
            active = sorted(getattr(settings, "JOB_QUEUE_MUTANTS", frozenset()))
            assert not active, f"the real binding was built while {', '.join(active)} is active"

    @classmethod
    def install(cls, connection: Any) -> None:
        """The migrations own the real tables, and the unflagged queue opens on their guards only:
        not on a database mutant an earlier case left installed."""
        from django.apps import apps as registry

        # A tree that lacks one of the queue's applications lacks its guards too: the binding
        # reports that gap itself, from `require`.
        if not all(registry.is_installed(app) for app in cls.APPS):
            return

        with connection.cursor() as cursor:
            differences = database_mutants.pristine_differences(
                database_mutants.snapshot_guards(cursor)
            )
        assert not differences, (
            f"the real queue's database guards are not the migrated ones: {'; '.join(differences)}"
        )

    def require(self, function: str) -> Any:
        from django.apps import apps as registry

        if function not in self.NAMES:
            raise LookupError(f"{function} is not in the binding's closed list of names")

        for app in self.apps:
            if not registry.is_installed(app):
                raise QueueGapError(f"app:{app}", f"{app} is not in INSTALLED_APPS")
        try:
            found = importlib.util.find_spec(self.services)
        except ModuleNotFoundError as error:
            if error.name and self.services.startswith(error.name):
                found = None
            else:
                raise
        if found is None:
            raise QueueGapError(f"module:{self.services}", f"{self.services} does not exist")
        module = importlib.import_module(self.services)
        target = getattr(module, function, None)
        if target is None:
            raise QueueGapError(
                f"service:{self.services}.{function}",
                f"{self.services} defines no {function}",
            )
        return target

    def _request(self, request: dict[str, Any]) -> Any:
        values = dict(request)
        for key in ("organisation_id", "tenant_id", "actor_id", "depends_on_job_id"):
            values[key] = _uuid(values.get(key))
        values["not_before"] = _instant(values.get("not_before"))
        return self.require("JobRequest")(**values)

    def resolve(self, *, principal: dict[str, Any]) -> str | None:
        """Resolve a principal now, for a decision this actor takes later: the handle that decision
        names as `{"resolved": handle}`, or None when the resolver refuses."""
        resolved = self._principal(principal)
        if resolved is None:
            return None
        handle = uuid.uuid4().hex
        self.resolved[handle] = resolved
        return handle

    def _principal(self, principal: dict[str, Any]) -> Any:
        """The staff principal the queue's resolver builds from a verified token's evidence, or
        None when it refuses; or the one `resolve` built earlier. The evidence stands for what
        `verify_configured_token` returns: the signature is not what these tests are about
        (tests/test_access_tokens.py)."""
        from services.identity.access_tokens import VerifiedAccessToken

        if "resolved" in principal:
            return self.resolved[principal["resolved"]]

        resolve = self.require("resolve_staff_principal")
        refused: Any = self.require("StaffPrincipalError")
        now = int(time.time())
        verified = VerifiedAccessToken(
            issuer=principal["issuer"],
            subject=principal["subject"],
            audience=("kodera-server",),
            issued_at=now,
            expires_at=now + 300,
            not_before=None,
            amr=None if principal["amr"] is None else tuple(principal["amr"]),
            acr=None,
            auth_time=now,
        )
        try:
            return resolve(verified, principal["lane"])
        except refused:
            return None

    def _decision(self, decision: dict[str, Any]) -> Any:
        evidence = self.require("Evidence")
        values = dict(decision)
        values["subject_id"] = uuid.UUID(values["subject_id"])
        for key in ("compute_terminated", "target_read"):
            item = dict(values[key])
            item["observed_at"] = _instant(item["observed_at"])
            values[key] = evidence(**item)
        return self.require("ReconciliationDecision")(**values)

    def enqueue(self, *, request: dict[str, Any], probe: str | None) -> dict[str, Any]:
        enqueue_job = self.require("enqueue_job")
        refusal: Any = self.require("IdempotencyKeyReuse")

        def apply_desired_state() -> None:
            if probe is not None:
                insert_probe(self.schema, probe)

        try:
            result = enqueue_job(
                request=self._request(request), apply_desired_state=apply_desired_state
            )
        except refusal:
            return {"refused": "idempotency_key_reuse"}
        return {"job_id": str(result.job_id), "created": bool(result.created)}

    def claim(self, *, runner_id: str, job_id: str | None) -> tuple[dict[str, Any], Any]:
        claim_job = self.require("claim_job")
        result = claim_job(runner_id=runner_id, job_id=_uuid(job_id))
        if result is None:
            return {"outcome": "none"}, None
        claim_type: Any = self.require("Claim")
        if isinstance(result, claim_type):
            found = {"outcome": "claimed", "job_id": str(result.job_id), "fence": int(result.fence)}
            return found, result
        return {"outcome": "refused", "job_id": str(result.job_id), "reason": result.reason}, None

    def renew(self, *, claim: Any) -> bool:
        return bool(self.require("renew_lease")(claim=claim))

    def record_step(
        self,
        *,
        claim: Any,
        seq: int,
        status: str,
        error_code: str | None = None,
        output_ref: str | None = None,
    ) -> bool:
        record = self.require("record_step")
        return bool(
            record(
                claim=claim, seq=seq, status=status, error_code=error_code, output_ref=output_ref
            )
        )

    def record_dispatch(self, *, claim: Any, seq: int, operation_ref: str) -> str | None:
        found = self.require("record_dispatch")(claim=claim, seq=seq, operation_ref=operation_ref)
        return None if found is None else str(found)

    def retarget_dispatch(self, *, claim: Any, dispatch_id: str, operation_ref: str) -> bool:
        retarget = self.require("retarget_dispatch")
        return bool(
            retarget(claim=claim, dispatch_id=uuid.UUID(dispatch_id), operation_ref=operation_ref)
        )

    def start_sub_job(
        self,
        *,
        claim: Any,
        seq: int,
        kind: str,
        desired_spec_hash: str,
        test_relation: bool = True,
    ) -> str | None:
        start = self.require("start_sub_job")
        if not test_relation:
            found = start(claim=claim, seq=seq, kind=kind, desired_spec_hash=desired_spec_hash)
            return None if found is None else str(found)

        from django.db import connection

        from apps.jobs._runner import _start_sub_job
        from apps.jobs.kinds import sub_job_relation

        with connection.cursor() as cursor:
            cursor.execute("SELECT kind FROM jobs_job WHERE id = %s", [claim.job_id])
            row = cursor.fetchone()
        assert row is not None, "the test relation's parent job does not exist"
        relation = sub_job_relation(row[0], seq, kind)
        assert relation is not None, "the test relation does not name catalogue coordinates"
        found = _start_sub_job(
            claim=claim,
            seq=seq,
            kind=kind,
            desired_spec_hash=desired_spec_hash,
            allowed_relations=frozenset({relation}),
        )
        return None if found is None else str(found)

    def close_dispatch(
        self, *, claim: Any, dispatch_id: str, outcome: str, evidence_ref: str
    ) -> bool:
        close = self.require("close_dispatch")
        return bool(
            close(
                claim=claim,
                dispatch_id=uuid.UUID(dispatch_id),
                outcome=outcome,
                evidence_ref=evidence_ref,
            )
        )

    def hold_for_reconciliation(self, *, claim: Any, dispatch_id: str) -> bool:
        hold = self.require("hold_for_reconciliation")
        return bool(hold(claim=claim, dispatch_id=uuid.UUID(dispatch_id)))

    def finish(self, *, claim: Any, status: str, error_code: str | None = None) -> bool:
        return bool(self.require("finish_job")(claim=claim, status=status, error_code=error_code))

    def release_live_locks(self, *, claim: Any) -> None:
        self.require("release_live_locks")(claim=claim)

    def sweep(self) -> None:
        self.require("sweep_expired_leases")()

    def _decided(self, result: Any) -> dict[str, Any]:
        refused_type: Any = self.require("DecisionRefused")
        if isinstance(result, refused_type):
            return refusal(str(result.reason))
        return RECORDED

    def decide(self, *, principal: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
        record = self.require("record_reconciliation_decision")
        resolved = self._principal(principal)
        if resolved is None:
            return PRINCIPAL_REFUSED
        return self._decided(record(principal=resolved, decision=self._decision(decision)))

    def decide_delivery(
        self, *, principal: dict[str, Any], decision: dict[str, Any]
    ) -> dict[str, Any]:
        record = self.require("record_delivery_reconciliation_decision")
        resolved = self._principal(principal)
        if resolved is None:
            return PRINCIPAL_REFUSED
        return self._decided(record(principal=resolved, decision=self._decision(decision)))


# What a binding's `decide` and `decide_delivery` return (docs/specs/JOB_QUEUE.md §3.3, §5.4).
RECORDED: dict[str, Any] = {"recorded": True, "reason": None}


def refusal(reason: str) -> dict[str, Any]:
    return {"recorded": False, "reason": reason}


def insert_probe(schema: str, label: str) -> None:
    """The caller's desired-state change: one row in a test-owned table, on the actor's session."""
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            sql("INSERT INTO {s}.a3_desired_state_probe (label) VALUES (%s)", schema), [label]
        )


class FlaggedRealBinding(RealBinding):
    """The real queue with one mutant flag of mutants.toml active (§9.2)."""

    def __init__(self) -> None:
        super().__init__()
        from apps.jobs import mutants

        # In this process: the parent's thread actors, or a child that built the same binding.
        mutants.activate(self.flag)

    @classmethod
    def install(cls, connection: Any) -> None:

        if cls.flag in database_mutants.DATABASE_MUTANTS:
            with connection.cursor() as cursor:
                database_mutants.install_database_mutant(cursor, cls.flag)


def binding_class(name: str) -> Any:
    if name == "real":
        return RealBinding
    if name.startswith("real:"):
        return type(f"Flagged_{name[5:]}", (FlaggedRealBinding,), {"name": name, "flag": name[5:]})
    import counterexamples

    if name in counterexamples.BINDINGS:
        return counterexamples.BINDINGS[name]
    extra = os.environ.get("JOB_QUEUE_EXTRA_BINDINGS")
    if extra and os.environ.get("CI"):
        raise LookupError(
            "JOB_QUEUE_EXTRA_BINDINGS is refused under CI: no binding outside the repository "
            "stands in for the queue"
        )
    if extra:
        module = importlib.import_module(extra)
        if name in module.BINDINGS:
            return module.BINDINGS[name]
    raise LookupError(f"no job-queue binding is named {name!r}")


def binding_for(name: str) -> Any:
    return binding_class(name)()


# --------------------------------------------------------------------------------- actors ----

CLAIM_METHODS = {
    "renew",
    "record_step",
    "record_dispatch",
    "retarget_dispatch",
    "start_sub_job",
    "close_dispatch",
    "hold_for_reconciliation",
    "finish",
    "release_live_locks",
}


class ActorCore:
    """One runner's memory: its binding and the claims it holds, which outlive its session."""

    def __init__(self, binding: Any, runner_id: str) -> None:
        self.binding = binding
        self.runner_id = runner_id
        self.claims: dict[str, Any] = {}

    @staticmethod
    def prepare_session() -> int:
        """Give the session room to wait at a barrier, and make a dead client end it promptly."""
        from django.db import connection

        with connection.cursor() as cursor:
            cursor.execute("SET statement_timeout = '40s'")
            cursor.execute("SET client_connection_check_interval = '100ms'")
            cursor.execute("SELECT pg_backend_pid()")
            return int(cursor.fetchone()[0])

    @staticmethod
    def end_session() -> None:
        from django.db import connections

        connections.close_all()

    @staticmethod
    def execute(statements: list[str]) -> None:
        """Harness controls only: plain SQL on this session, to prove an observation can see both
        outcomes. No acceptance test uses it."""
        from django.db import connection

        with connection.cursor() as cursor:
            for statement in statements:
                cursor.execute(statement)

    def dispatch(self, method: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            if method == "end_session":
                self.end_session()
                return {"value": None}
            pid = self.prepare_session()
            if method == "session":
                return {"value": pid, "pid": pid}
            if method == "execute":
                return {"value": self.execute(arguments["statements"]), "pid": pid}
            if method == "noise":
                # Harness controls only: what an implementation's stray `print` would do.
                print(arguments["text"], flush=True)  # noqa: T201 - the stray line is the point
                return {"value": None, "pid": pid}
            if method == "under_isolation":
                return {"value": self.under_isolation(arguments), "pid": pid}
            if method == "in_transaction":
                inner = self.in_transaction(
                    arguments["call"], dict(arguments["arguments"]), arguments.get("probe")
                )
                return {"value": inner, "pid": pid}
            return {"value": self._call(method, dict(arguments)), "pid": pid}
        except QueueGapError as gap:
            return {"gap": gap.gap, "detail": gap.detail}
        except Exception as error:  # noqa: BLE001 - reported to the test, which fails on it
            return {"error": f"{type(error).__name__}: {error}"}

    def under_isolation(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Test-only actual session setting, restored even when the service raises."""
        from django.db import connection

        level = arguments["level"]
        if level not in {"read committed", "read uncommitted", "repeatable read", "serializable"}:
            raise ValueError("unsupported test isolation")
        with connection.cursor() as cursor:
            cursor.execute("SHOW default_transaction_isolation")
            previous = cursor.fetchone()[0]
            cursor.execute("SELECT set_config('default_transaction_isolation', %s, false)", [level])
        try:
            try:
                return {"returned": self._call(arguments["call"], dict(arguments["arguments"]))}
            except QueueGapError:
                raise
            except Exception as error:  # noqa: BLE001 - exact service outcome is the test observation
                return {"raised": f"{type(error).__name__}: {error}"}
        finally:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_config('default_transaction_isolation', %s, false)", [previous]
                )

    def in_transaction(
        self, method: str, arguments: dict[str, Any], probe: str | None = None
    ) -> dict[str, Any]:
        """One call made inside a transaction its caller opened, committed when the call returns:
        what the call returned, or what it raised. An optional probe is written after it returns."""
        from django.db import transaction

        try:
            with transaction.atomic():
                result = self._call(method, arguments)
                if probe is not None:
                    insert_probe(self.binding.schema, probe)
                return {"returned": result}
        except QueueGapError:
            raise
        except Exception as error:  # noqa: BLE001 - what it raised is the observation
            return {"raised": f"{type(error).__name__}: {error}"}

    def _call(self, method: str, arguments: dict[str, Any]) -> Any:
        if method == "claim":
            result, claim = self.binding.claim(
                runner_id=self.runner_id, job_id=arguments.get("job_id")
            )
            if claim is not None:
                self.claims[result["job_id"]] = claim
            return result
        if method in CLAIM_METHODS:
            job_id = arguments.pop("job_id")
            if job_id not in self.claims:
                raise ActorError(f"{self.runner_id} holds no claim on job {job_id}")
            return getattr(self.binding, method)(claim=self.claims[job_id], **arguments)
        return getattr(self.binding, method)(**arguments)


def unwrap(reply: dict[str, Any], method: str) -> Any:
    if "gap" in reply:
        raise QueueGapError(reply["gap"], reply["detail"])
    if "error" in reply:
        raise ActorError(f"{method} raised {reply['error']}")
    return reply["value"]


class Pending:
    def __init__(self, method: str, future: concurrent.futures.Future[dict[str, Any]]) -> None:
        self.method = method
        self.future = future

    def done(self) -> bool:
        return self.future.done()

    def result(self, timeout: float = ACTOR_TIMEOUT_S) -> Any:
        try:
            reply = self.future.result(timeout)
        except concurrent.futures.TimeoutError:
            raise BarrierError(f"{self.method} did not return within the actor timeout") from None
        return unwrap(reply, self.method)


RAISED = "raised"


def attempt(pending: Pending) -> Any:
    """A call's value, or `RAISED` when the queue raised instead of refusing. A refusal the spec says
    a function returns must not be satisfied by a database error surfacing through it; a gap still
    propagates."""
    try:
        return pending.result()
    except ActorError:
        return RAISED


class ThreadActor:
    """A runner on its own thread, so on its own Django connection and database session."""

    def __init__(self, binding_name: str, runner_id: str) -> None:
        self.runner_id = runner_id
        self.backend_pid = 0
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=runner_id
        )
        try:
            self._core = self._executor.submit(
                ActorCore, binding_for(binding_name), runner_id
            ).result()
            self.call("session")
        except BaseException:
            self.close()
            raise

    def _dispatch(self, method: str, arguments: dict[str, Any]) -> dict[str, Any]:
        reply = self._core.dispatch(method, arguments)
        if "pid" in reply:
            self.backend_pid = int(reply["pid"])
        return reply

    def send(self, method: str, **arguments: Any) -> Pending:
        return Pending(method, self._executor.submit(self._dispatch, method, arguments))

    def call(self, method: str, **arguments: Any) -> Any:
        return self.send(method, **arguments).result()

    def try_call(self, method: str, **arguments: Any) -> Any:
        return attempt(self.send(method, **arguments))

    def end_session(self) -> None:
        """The session ends; the runner, and every claim it holds in memory, does not."""
        self.call("end_session")

    def close(self) -> None:
        with suppress(Exception):
            self._executor.submit(ActorCore.end_session).result(ACTOR_TIMEOUT_S)
        self._executor.shutdown(wait=True, cancel_futures=True)


class ProcessActor:
    """A runner in a child process, so that `kill` is a real `SIGKILL` of a real process.

    Every request carries an identifier, and a reply is delivered only to the request that carries
    the same one: a reply that arrives after its request timed out is dropped, never handed to the
    next call.
    """

    def __init__(self, binding_name: str, runner_id: str, database_name: str) -> None:
        self.runner_id = runner_id
        self.backend_pid = 0
        self._pending: dict[int, concurrent.futures.Future[dict[str, Any]]] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._stderr: list[str] = []
        self.noise: list[str] = []
        self._threads: list[threading.Thread] = []
        environment = dict(os.environ)
        environment.update(
            {
                "DJANGO_SETTINGS_MODULE": "config.settings.test",
                "JOB_QUEUE_BINDING": binding_name,
                "JOB_QUEUE_RUNNER_ID": runner_id,
                "JOB_QUEUE_TEST_DATABASE": database_name,
                "PYTHONPATH": os.pathsep.join(
                    [str(ROOT), str(HERE), environment.get("PYTHONPATH", "")]
                ),
            }
        )
        self._process = subprocess.Popen(  # noqa: S603 - a fixed interpreter and script
            [sys.executable, str(HERE / "queue_actor.py")],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self._threads = [
                threading.Thread(target=self._read, daemon=True),
                threading.Thread(target=self._drain, daemon=True),
            ]
            for thread in self._threads:
                thread.start()
            self.backend_pid = int(self.call("session"))
        except BaseException:
            self.close()
            raise

    def _read(self) -> None:
        assert self._process.stdout is not None
        try:
            for line in self._process.stdout:
                try:
                    reply = json.loads(line)
                    request = int(reply.pop("request"))
                except (ValueError, KeyError, TypeError, AttributeError):
                    # A stray line on the child's stdout — a `print`, a log handler — is not a
                    # reply. It is kept for the timeout message and never ends the reader.
                    self.noise.append(line.rstrip("\n"))
                    continue
                with self._lock:
                    future = self._pending.pop(request, None)
                if future is not None:
                    future.set_result(reply)
        finally:
            with self._lock:
                waiting, self._pending = list(self._pending.values()), {}
            for future in waiting:
                future.set_result(
                    {"error": "the child process exited: " + "".join(self._stderr[-5:])}
                )

    def _drain(self) -> None:
        assert self._process.stderr is not None
        for line in self._process.stderr:
            self._stderr.append(line)

    def send(self, method: str, **arguments: Any) -> Pending:
        assert self._process.stdin is not None
        future: concurrent.futures.Future[dict[str, Any]] = concurrent.futures.Future()
        with self._lock:
            request = next(self._ids)
            self._pending[request] = future
            self._process.stdin.write(
                json.dumps({"request": request, "method": method, "arguments": arguments}) + "\n"
            )
            self._process.stdin.flush()
        return _Forgetting(method, future, self, request)

    def forget(self, request: int) -> None:
        with self._lock:
            self._pending.pop(request, None)

    def call(self, method: str, **arguments: Any) -> Any:
        return self.send(method, **arguments).result()

    def try_call(self, method: str, **arguments: Any) -> Any:
        return attempt(self.send(method, **arguments))

    def kill(self) -> None:
        if self._process.poll() is None:
            self._process.send_signal(signal.SIGKILL)
        self._process.wait(ACTOR_TIMEOUT_S)

    def close(self) -> None:
        self.kill()
        if self._process.stdin is not None:
            with suppress(Exception):
                self._process.stdin.close()
        for thread in self._threads:
            thread.join(ACTOR_TIMEOUT_S)
        for stream in (self._process.stdout, self._process.stderr):
            if stream is not None:
                with suppress(Exception):
                    stream.close()


class _Forgetting(Pending):
    """A pending child request that is forgotten when it times out."""

    def __init__(
        self,
        method: str,
        future: concurrent.futures.Future[dict[str, Any]],
        actor: ProcessActor,
        request: int,
    ) -> None:
        super().__init__(method, future)
        self.actor = actor
        self.request = request

    def result(self, timeout: float = ACTOR_TIMEOUT_S) -> Any:
        try:
            return super().result(timeout)
        except BarrierError as error:
            self.actor.forget(self.request)
            if self.actor.noise:
                raise BarrierError(
                    f"{error}; the child wrote {len(self.actor.noise)} line(s) to stdout that "
                    f"were not replies, the last: {self.actor.noise[-1][:200]!r}"
                ) from None
            raise


# ------------------------------------------------------------------------------- observer ----


class Observer:
    """A PostgreSQL session of the test's own: what was committed, and who holds which lock."""

    def __init__(self, parameters: dict[str, Any], schema: str) -> None:
        import psycopg

        self.schema = schema
        self.connection = psycopg.connect(**parameters, autocommit=True)
        self.connection.execute("SET statement_timeout = '20s'")

    def rows(self, template: str, parameters: Any = ()) -> list[tuple[Any, ...]]:
        return list(self.connection.execute(sql(template, self.schema), parameters))

    def value(self, template: str, parameters: Any = ()) -> Any:
        found = self.rows(template, parameters)
        return found[0][0] if found else None

    def refused(self, template: str, parameters: Any = ()) -> tuple[str, str] | None:
        """Run one write; None when it committed, else the SQLSTATE and constraint that refused it."""
        import psycopg

        try:
            self.connection.execute(sql(template, self.schema), parameters)
        except psycopg.Error as error:
            return str(error.sqlstate), str(error.diag.constraint_name)
        return None

    def refused_together(
        self, statements: list[tuple[str, Any]], *, savepoint_first: bool = False
    ) -> tuple[str, str] | None:
        """Run writes in one transaction; None when it committed, else what refused it.

        With `savepoint_first`, the first write runs under a savepoint that is then released, as a
        function's own `atomic()` does inside its caller's transaction."""
        import psycopg

        try:
            with self.connection.transaction():
                for index, (template, parameters) in enumerate(statements):
                    if index == 0 and savepoint_first:
                        with self.connection.transaction():
                            self.connection.execute(sql(template, self.schema), parameters)
                    else:
                        self.connection.execute(sql(template, self.schema), parameters)
        except psycopg.Error as error:
            return str(error.sqlstate), str(error.diag.constraint_name)
        return None

    def inserted_under(self, template: str, parameters: Any, column: str, table: str) -> bool:
        """Insert one row in a transaction of its own; True when `column` of the row whose id is the
        first parameter holds that transaction's top-level identifier afterwards."""
        with self.connection.transaction():
            self.connection.execute(sql(template, self.schema), parameters)
            query = "SELECT " + column + " = txid_current() FROM {s}." + table + " WHERE id = %s"  # noqa: S608 - spec names
            found = self.connection.execute(sql(query, self.schema), [parameters[0]]).fetchone()
        return bool(found and found[0])

    def sub_job_dispatch(self, sub_job_id: str) -> dict[str, Any]:
        found = self.value(
            "SELECT id FROM {s}.jobs_jobdispatch WHERE sub_job_id = %s", [sub_job_id]
        )
        assert found is not None, "a sub-job the test started has no dispatch naming it"
        return self.record("jobs_jobdispatch", str(found))

    def now(self) -> dt.datetime:
        instant: dt.datetime = self.value("SELECT clock_timestamp()")
        return instant

    def record(self, table: str, identifier: str) -> dict[str, Any]:
        query = "SELECT * FROM {s}." + table + " WHERE id = %s"  # noqa: S608 - spec table name
        cursor = self.connection.execute(sql(query, self.schema), [identifier])
        row = cursor.fetchone()
        assert row is not None, "a record the test expected has no committed row"
        columns = cursor.description or []
        return dict(zip([column.name for column in columns], row, strict=True))

    def job(self, job_id: str) -> dict[str, Any]:
        return self.record("jobs_job", job_id)

    def status(self, job_id: str) -> str:
        return str(self.job(job_id)["status"])

    def steps(self, job_id: str) -> list[tuple[int, str, str]]:
        return [
            (int(seq), str(name), str(status))
            for seq, name, status in self.rows(
                "SELECT seq, name, status FROM {s}.jobs_jobstep WHERE job_id = %s ORDER BY seq",
                [job_id],
            )
        ]

    def step_status(self, job_id: str, seq: int) -> str:
        return str(
            self.value(
                "SELECT status FROM {s}.jobs_jobstep WHERE job_id = %s AND seq = %s", [job_id, seq]
            )
        )

    def open_reservations(self, job_id: str) -> list[tuple[str, str, int]]:
        return [
            (str(lock_class), str(mode), int(fence))
            for lock_class, mode, fence in self.rows(
                "SELECT lock_class, mode, fence FROM {s}.jobs_joblockreservation "
                "WHERE job_id = %s AND ended_at IS NULL ORDER BY lock_class",
                [job_id],
            )
        ]

    def count(self, table: str, where: str = "true", parameters: Any = ()) -> int:
        query = "SELECT count(*) FROM {s}." + table + " WHERE " + where  # noqa: S608 - test SQL
        return int(self.value(query, parameters))

    def audit_count(self, action: str, job_id: str | None = None) -> int:
        if job_id is None:
            return self.count("audit_auditevent", "action = %s", [action])
        return self.count("audit_auditevent", "action = %s AND job_id = %s", [action, job_id])

    def expire_lease(self, job_id: str) -> None:
        """Move database time for one lease: back-date it (docs/specs/JOB_QUEUE.md §3.2)."""
        changed = self.connection.execute(
            sql(
                "UPDATE {s}.jobs_job SET lease_expires_at = clock_timestamp() - interval '1 second' "
                "WHERE id = %s AND lease_expires_at IS NOT NULL",
                self.schema,
            ),
            [job_id],
        ).rowcount
        assert changed == 1, "the job the test expected to be leased has no lease to expire"

    def shorten_leases(self, job_ids: list[str], seconds: int) -> None:
        """Give claimed jobs a lease that ends in a few seconds (docs/specs/JOB_QUEUE.md §3.2)."""
        changed = self.connection.execute(
            sql(
                "UPDATE {s}.jobs_job SET lease_expires_at = clock_timestamp() "
                "+ make_interval(secs => %s) WHERE id = ANY(%s::uuid[]) "
                "AND lease_expires_at IS NOT NULL",
                self.schema,
            ),
            [seconds, job_ids],
        ).rowcount
        assert changed == len(job_ids), (
            "a job the test expected to be leased has no lease to shorten"
        )

    def wait_leases_passed(self, job_ids: list[str]) -> None:
        """Wait, on the database's clock and in the database, until every job's lease has passed."""
        self.value(
            "SELECT pg_sleep(greatest(0, extract(epoch FROM max(lease_expires_at) "
            "- clock_timestamp())) + 0.05) FROM {s}.jobs_job WHERE id = ANY(%s::uuid[])",
            [job_ids],
        )
        passed = self.value(
            "SELECT bool_and(lease_expires_at < clock_timestamp()) FROM {s}.jobs_job "
            "WHERE id = ANY(%s::uuid[])",
            [job_ids],
        )
        assert passed, "a lease the test waited out had not passed by the database's clock"

    def defer(self, job_id: str, until: dt.datetime) -> None:
        """Move one job's `not_before` later, as a later item's backoff would
        (docs/specs/JOB_QUEUE.md §3.2)."""
        self.connection.execute(
            sql("UPDATE {s}.jobs_job SET not_before = %s WHERE id = %s", self.schema),
            [until, job_id],
        )

    def make_due(self, job_id: str) -> None:
        """Move database time for one `not_before`: back-date it."""
        self.connection.execute(
            sql(
                "UPDATE {s}.jobs_job SET not_before = clock_timestamp() - interval '1 second' "
                "WHERE id = %s",
                self.schema,
            ),
            [job_id],
        )

    def advisory_key(self, lock_class: str, key: str) -> tuple[int, int]:
        """The (classid, objid) pg_locks shows for the spec's two-integer advisory key."""
        code = LOCK_CLASS_CODE[lock_class]
        objid = self.value("SELECT (hashtext(%s)::bigint & 4294967295)", [key])
        return code, int(objid)

    def advisory_locks(self, pid: int) -> set[tuple[int, int, str]]:
        return {
            (int(classid), int(objid), str(mode))
            for classid, objid, mode in self.connection.execute(
                "SELECT classid::bigint, objid::bigint, mode FROM pg_locks "
                "WHERE locktype = 'advisory' AND objsubid = 2 AND granted AND pid = %s",
                [pid],
            )
        }

    def holders(self, lock_class: str, key: str) -> set[int]:
        classid, objid = self.advisory_key(lock_class, key)
        return {
            int(pid)
            for (pid,) in self.connection.execute(
                "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 "
                "AND granted AND classid::bigint = %s AND objid::bigint = %s",
                [classid, objid],
            )
        }

    def _relations(self, pid: int, mode: str) -> set[str]:
        return {
            str(name)
            for (name,) in self.connection.execute(
                "SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE l.locktype = 'relation' AND l.granted AND l.pid = %s AND n.nspname = %s "
                "AND c.relkind = 'r' AND l.mode = %s",
                [pid, self.schema, mode],
            )
        }

    def written_relations(self, pid: int) -> set[str]:
        """The tables the backend's open transaction has written: the lock mode an `INSERT`,
        `UPDATE` or `DELETE` takes. A table it only read holds `AccessShareLock` and is not here."""
        return self._relations(pid, "RowExclusiveLock")

    def read_relations(self, pid: int) -> set[str]:
        return self._relations(pid, "AccessShareLock")

    def blocked_by(self, pid: int) -> set[int]:
        return {int(p) for p in self.value("SELECT pg_blocking_pids(%s)", [pid]) or []}

    def cancel(self, pid: int) -> None:
        self.value("SELECT pg_cancel_backend(%s)", [pid])

    def backend_alive(self, pid: int) -> bool:
        return bool(self.value("SELECT count(*) FROM pg_stat_activity WHERE pid = %s", [pid]))

    def wait_backend_gone(self, pid: int, timeout: float = BARRIER_TIMEOUT_S) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.backend_alive(pid):
                return
            time.sleep(0.05)
        raise BarrierError("a killed backend was still alive after the barrier timeout")

    def close(self) -> None:
        with suppress(Exception):
            self.connection.close()


def wait_blocked(observer: Observer, pid: int, blocker: int, pending: Pending) -> bool:
    """True once `pid` waits on `blocker`; False when the call returned first, without waiting."""
    deadline = time.monotonic() + BARRIER_TIMEOUT_S
    while time.monotonic() < deadline:
        if blocker in observer.blocked_by(pid):
            return True
        if pending.done():
            return False
        time.sleep(0.02)
    raise BarrierError("a call neither waited on the test's session nor returned")


@dataclass
class Barrier:
    """A lock held by a session of its own: the first conflicting write waits on it."""

    observer: Observer
    session: Any
    table: str

    def reached(self, pid: int, pending: Pending) -> bool:
        """True once the call waits at this barrier; False when it returned without reaching it.
        A call that returned a gap or an error raises that instead: it outranks "did not wait"."""
        if wait_blocked(self.observer, pid, self.session.info.backend_pid, pending):
            return True
        pending.result()
        return False

    def wait_blocked(self, pid: int, pending: Pending) -> None:
        if not self.reached(pid, pending):
            raise BarrierError(f"the call returned without reaching the barrier at {self.table}")


# ------------------------------------------------------------------------------ the world ----


@dataclass
class QueueEnv:
    binding_name: str
    schema: str
    database_parameters: dict[str, Any]
    database_name: str
    observer: Observer
    actors: list[Any] = field(default_factory=list)
    _count: int = 0

    def thread_actor(self, label: str = "runner") -> ThreadActor:
        self._count += 1
        actor = ThreadActor(self.binding_name, f"{label}-{self._count}")
        self.actors.append(actor)
        return actor

    def process_actor(self, label: str = "process") -> ProcessActor:
        self._count += 1
        actor = ProcessActor(self.binding_name, f"{label}-{self._count}", self.database_name)
        self.actors.append(actor)
        return actor

    def session(self) -> Any:
        import psycopg

        connection = psycopg.connect(**self.database_parameters, autocommit=True)
        connection.execute("SET statement_timeout = '40s'")
        self.actors.append(connection)
        return connection

    def end_session(self, actor: Any) -> None:
        """End a runner's session and wait until PostgreSQL has let its backend go, so its live locks
        are released before the test looks, rather than whenever the disconnect lands."""
        pid = actor.backend_pid
        actor.end_session()
        self.observer.wait_backend_gone(pid)

    @contextmanager
    def barrier(self, table: str, *, reads: bool = False) -> Iterator[Barrier]:
        """A table lock the first conflicting write waits on; with `reads`, the first read too."""
        session = self.session()
        session.execute("BEGIN")
        mode = "ACCESS EXCLUSIVE" if reads else "SHARE ROW EXCLUSIVE"
        lock = "LOCK TABLE {s}." + table + " IN " + mode + " MODE"
        session.execute(sql(lock, self.schema))
        try:
            yield Barrier(self.observer, session, table)
        finally:
            with suppress(Exception):
                session.execute("ROLLBACK")

    @contextmanager
    def row_holder(self, job_id: str, *, key_share: bool = False) -> Iterator[Any]:
        """A session of the test's own holding one job row: exclusively, as a sweep's transaction
        would, or with `key_share` in the mode the foreign-key check of an uncommitted insert
        naming the job holds."""
        session = self.session()
        session.execute("BEGIN")
        strength = "FOR KEY SHARE" if key_share else "FOR UPDATE"
        query = "SELECT 1 FROM {s}.jobs_job WHERE id = %s " + strength  # noqa: S608 - fixed clause
        session.execute(sql(query, self.schema), [job_id])
        try:
            yield session
        finally:
            with suppress(Exception):
                session.execute("ROLLBACK")

    @contextmanager
    def delivery_holder(self, delivery_id: str, *, key_share: bool = False) -> Iterator[Any]:
        """A session of the test's own holding one delivery row: exclusively, as another writer
        moving it would, or with `key_share` in the mode the foreign-key check of an uncommitted
        insert naming the delivery holds."""
        session = self.session()
        session.execute("BEGIN")
        strength = "FOR KEY SHARE" if key_share else "FOR UPDATE"
        query = "SELECT 1 FROM {s}.outbox_outboxdelivery WHERE id = %s " + strength  # noqa: S608 - fixed clause
        session.execute(sql(query, self.schema), [delivery_id])
        try:
            yield session
        finally:
            with suppress(Exception):
                session.execute("ROLLBACK")

    @contextmanager
    def rows_holder(self, job_ids: list[str]) -> Iterator[Any]:
        """One session of the test's own holding several job rows exclusively, and changing none."""
        session = self.session()
        session.execute("BEGIN")
        session.execute(
            sql("SELECT 1 FROM {s}.jobs_job WHERE id = ANY(%s::uuid[]) FOR UPDATE", self.schema),
            [job_ids],
        )
        try:
            yield session
        finally:
            with suppress(Exception):
                session.execute("ROLLBACK")

    def organisation(self) -> str:
        """A real `orgs.Organisation` in `prospect`, which the job's foreign key needs."""
        from django.apps import apps
        from django.db import transaction

        slug = "q" + uuid.uuid4().hex[:12]
        with transaction.atomic():
            organisation = apps.get_model("orgs", "Organisation").objects.create(
                slug=slug,
                realm=slug,
                issuer=f"https://identity.customer.test/realms/{slug}",
                name="Synthetic organisation",
                state="prospect",
            )
            apps.get_model("orgs", "SlugReservation").objects.create(
                namespace="organisation",
                slug=slug,
                organisation=organisation,
                state="provisional",
                protected_at=None,
            )
        return str(organisation.pk)

    def staff_principal(
        self, organisation_id: str, roles: tuple[str, ...] = ("staff_operator",)
    ) -> dict[str, Any]:
        """The evidence of a verified staff token with a second factor, for a new stored staff
        identity holding a current grant of each of `roles` (docs/specs/STAFF_IDENTITY.md). A staff
        identity belongs to no organisation: `organisation_id` names the one it acts on, unused."""
        identity_id, subject = self.staff_identity(roles)
        return {
            "identity_id": identity_id,
            "issuer": STAFF_ISSUER,
            "subject": subject,
            "amr": ["pwd", "otp"],
            "lane": "staff",
        }

    def staff_identity(self, roles: tuple[str, ...]) -> tuple[str, str]:
        from django.apps import apps
        from django.db import transaction

        subject = "synthetic-operator-" + uuid.uuid4().hex[:8]
        with transaction.atomic():
            user = apps.get_model("identity", "User").objects.create(
                email="operator@staff.test", enabled=True
            )
            found = apps.get_model("identity", "Identity").objects.create(
                user=user,
                organisation=None,
                issuer=STAFF_ISSUER,
                realm="kodera-staff",
                subject=subject,
                email="operator@staff.test",
                enabled=True,
            )
            for role in roles:
                apps.get_model("identity", "StaffRole").objects.create(
                    identity=found, realm="kodera-staff", role=role
                )
        return str(found.pk), subject

    def customer_principal(self, organisation_id: str) -> dict[str, Any]:
        """The evidence of a verified customer-lane token with a second factor, for a new
        identity in the organisation's own realm."""
        from django.apps import apps
        from django.db import transaction

        organisation = apps.get_model("orgs", "Organisation").objects.get(pk=organisation_id)
        subject = "synthetic-customer-" + uuid.uuid4().hex[:8]
        with transaction.atomic():
            user = apps.get_model("identity", "User").objects.create(
                email="person@customer.test", enabled=True
            )
            found = apps.get_model("identity", "Identity").objects.create(
                user=user,
                organisation=organisation,
                issuer=organisation.issuer,
                realm=organisation.realm,
                subject=subject,
                email="person@customer.test",
                enabled=True,
            )
        return {
            "identity_id": str(found.pk),
            "issuer": organisation.issuer,
            "subject": subject,
            "amr": ["pwd", "otp"],
            "lane": "customer",
        }

    @staticmethod
    def retire_staff(principal: dict[str, Any], part: str) -> None:
        """Disable or delete the staff identity, or its person: `part` is `identity-disabled`,
        `identity-deleted`, `person-disabled` or `person-deleted`."""
        from django.apps import apps
        from django.utils import timezone

        identity = apps.get_model("identity", "Identity")
        now = timezone.now()
        retired = {"deleted_at": now, "purge_after": now + dt.timedelta(days=1)}
        values = retired if part.endswith("deleted") else {"enabled": False}
        if part.startswith("identity"):
            changed = identity.objects.filter(pk=principal["identity_id"]).update(**values)
        else:
            user_id = identity.objects.get(pk=principal["identity_id"]).user_id
            changed = apps.get_model("identity", "User").objects.filter(pk=user_id).update(**values)
        assert changed == 1, f"the staff principal's {part} could not be set"

    @staticmethod
    def staff_grant(principal: dict[str, Any], role: str) -> str:
        """The id of the staff identity's current grant of `role`."""
        from django.apps import apps

        grant = apps.get_model("identity", "StaffRole").objects.get(
            identity_id=principal["identity_id"], role=role, revoked_at=None
        )
        return str(grant.pk)

    @staticmethod
    def revoke_staff_role(principal: dict[str, Any], role: str) -> None:
        """End the staff identity's current grant of `role`, as `revoke_staff_role` does."""
        from django.apps import apps
        from django.utils import timezone

        revoked = (
            apps.get_model("identity", "StaffRole")
            .objects.filter(identity_id=principal["identity_id"], role=role, revoked_at=None)
            .update(revoked_at=timezone.now())
        )
        assert revoked == 1, "the staff identity held no current grant of the role to revoke"

    @staticmethod
    def tenant() -> str:
        return str(uuid.uuid4())

    @staticmethod
    def request(
        kind: str,
        organisation_id: str,
        tenant_id: str | None = None,
        *,
        key: str | None = None,
        spec: str = "desired",
        depends_on: str | None = None,
        not_before: dt.datetime | None = None,
    ) -> dict[str, Any]:
        return {
            "organisation_id": organisation_id,
            "tenant_id": tenant_id,
            "kind": kind,
            "idempotency_key": digest(key or uuid.uuid4().hex),
            "desired_spec_hash": digest(spec),
            "actor_type": "system",
            "actor_id": None,
            "request_id": None,
            "depends_on_job_id": depends_on,
            "not_before": None if not_before is None else not_before.isoformat(),
        }

    @staticmethod
    def evidence(
        observed_at: dt.datetime,
        *,
        provider: str = "scaleway",
        resource_id: str = "fr-par-1/instance-7",
        request_id: str = "req-3f9",
    ) -> dict[str, Any]:
        return {
            "provider": provider,
            "resource_id": resource_id,
            "request_id": request_id,
            "observed_at": observed_at.isoformat(),
        }

    def decision(
        self,
        subject_id: str,
        *,
        exit: str = "resume",  # noqa: A002 - the spec's field name
        outcome: str = "completed",
        compute: dict[str, Any] | None = None,
        target: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = self.observer.now()
        return {
            "subject_id": subject_id,
            "exit": exit,
            "operation_outcome": outcome,
            "compute_terminated": compute if compute is not None else self.evidence(now),
            "target_read": target if target is not None else self.evidence(now),
        }

    def enqueue(self, actor: Any, request: dict[str, Any], probe: str | None = None) -> str:
        result = actor.call("enqueue", request=request, probe=probe)
        assert result.get("created") is True, "enqueuing a new job did not report a created job"
        assert self.observer.count("jobs_job", "id = %s", [result["job_id"]]) == 1, (
            "enqueue_job returned a job that has no committed row"
        )
        return str(result["job_id"])

    def claimed(self, actor: Any, job_id: str) -> int:
        result = actor.call("claim", job_id=job_id)
        assert result["outcome"] == "claimed", (
            "a claim with no conflicting lock, reservation or earlier request was refused"
        )
        return int(result["fence"])

    def run_steps(self, actor: Any, job_id: str, seqs: range | tuple[int, ...]) -> None:
        for seq in seqs:
            for status in ("running", "succeeded"):
                assert actor.call("record_step", job_id=job_id, seq=seq, status=status), (
                    "the current claim could not move a step it owns"
                )

    def to_reconciliation(
        self, organisation: str, tenant: str, label: str, kind: str = "rotate_secret"
    ) -> tuple[str, str]:
        """A claimed job whose runner holds its first step's operation for reconciliation, then
        releases its live locks, so only the durable reservation keeps the job's place."""
        runner = self.thread_actor(label)
        job = self.enqueue(runner, self.request(kind, organisation, tenant))
        self.claimed(runner, job)
        assert runner.call("record_step", job_id=job, seq=1, status="running"), (
            "the current claim could not set its first step running"
        )
        dispatch = runner.call("record_dispatch", job_id=job, seq=1, operation_ref=f"op-{label}")
        assert dispatch is not None, "the current claim could not record a dispatch"
        assert runner.call("hold_for_reconciliation", job_id=job, dispatch_id=dispatch), (
            "a live runner could not hold its own job for reconciliation"
        )
        runner.call("release_live_locks", job_id=job)
        return job, dispatch

    def probe_count(self, label: str) -> int:
        return self.observer.count(PROBE_TABLE, "label = %s", [label])

    def close(self) -> None:
        errors = []
        for actor in reversed(self.actors):
            try:
                actor.close()
            except Exception as error:  # noqa: BLE001 - every actor is closed before reporting
                errors.append(error)
        self.observer.close()
        if errors:
            raise ExceptionGroup("job-queue actors did not close", errors)


def prepare_schema(parameters: dict[str, Any], binding_name: str) -> str:
    """The probe table, and for a scratch binding its schema, each emptied for the test."""
    import psycopg

    binding = binding_class(binding_name)
    schema = str(binding.schema)
    with psycopg.connect(**parameters, autocommit=True) as connection:
        binding.install(connection)
        connection.execute(
            sql(
                "CREATE TABLE IF NOT EXISTS {s}.a3_desired_state_probe (label text NOT NULL)",
                schema,
            )
        )
        connection.execute(sql("TRUNCATE {s}.a3_desired_state_probe", schema))
    return schema


@contextmanager
def open_queue_env(binding_name: str) -> Iterator[QueueEnv]:
    from django.db import connection

    assert connection.vendor == "postgresql"
    name = str(connection.settings_dict["NAME"])
    assert name.startswith("test_"), f"the job-queue harness refuses database {name!r}"
    parameters = dict(connection.get_connection_params())
    parameters.pop("cursor_factory", None)
    parameters.pop("context", None)
    parameters.pop("prepare_threshold", None)
    schema = prepare_schema(parameters, binding_name)
    env = QueueEnv(
        binding_name=binding_name,
        schema=schema,
        database_parameters=parameters,
        database_name=name,
        observer=Observer(parameters, schema),
    )
    try:
        yield env
    finally:
        env.close()

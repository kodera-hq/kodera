"""The job-queue kind registry, key derivation and audit writer, against the acceptance harness.

docs/specs/JOB_QUEUE.md §3.4 pins the key derivation and §3.5 the registry; the harness and the
counterexamples each carry the part of docs/domain/JOB_CATALOGUE.md the acceptance tests rely on.
They are loaded by path, so this module proves the registry and the tests read the same catalogue.
"""

import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from apps.audit.models import AuditEvent
from apps.audit.services import JOB_ACTIONS, record_job_event
from apps.jobs import models
from apps.jobs.keys import derive_key, sub_job_key
from apps.jobs.kinds import KINDS, REALM_KINDS, SUB_JOB_RELATIONS, Lock, lock_set

HARNESS = Path(__file__).parent / "job_queue"


def _harness_module(name: str) -> ModuleType:
    """A harness module by path, under the name its siblings import it by."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, HARNESS / f"{name}.py")
    assert spec is not None and spec.loader is not None, f"no harness module {name}"
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


harness = _harness_module("queue_harness")
counterexamples = _harness_module("counterexamples")


class _Int(int):
    pass


def test_the_registry_holds_every_kind_once_in_catalogue_order() -> None:
    assert tuple(KINDS) == models.KINDS
    assert all(spec.kind == kind for kind, spec in KINDS.items())
    assert frozenset(models.REALM_KINDS) == REALM_KINDS


def test_the_production_registry_authorizes_no_sub_job_relation() -> None:
    assert SUB_JOB_RELATIONS == frozenset()


def test_each_kind_takes_the_locks_the_harness_reads_from_the_catalogue() -> None:
    for kind, spec in KINDS.items():
        assert spec.organisation_lock == harness.ORGANISATION_LOCK.get(kind), kind
        assert spec.tenant_lock == harness.TENANT_LOCK.get(kind), kind


def test_each_kind_the_counterexamples_name_has_their_steps_and_attempts() -> None:
    for kind, names in counterexamples.STEPS.items():
        steps = KINDS[kind].steps
        # The counterexamples list only provision's first three steps; every other kind in full.
        found = tuple(step.name for step in steps)
        assert found[: len(names)] == names if kind == "provision" else found == names, kind
        assert KINDS[kind].max_attempts == counterexamples.MAX_ATTEMPTS[kind], kind
        named = steps[: len(names)]
        class_c = {(kind, seq) for seq, step in enumerate(named, 1) if step.retry_class == "C"}
        assert class_c == {item for item in counterexamples.CLASS_C if item[0] == kind}, kind
        conditional = {(kind, seq) for seq, step in enumerate(named, 1) if step.conditional}
        assert conditional == {item for item in counterexamples.CONDITIONAL if item[0] == kind}
    assert tuple(step.name for step in KINDS["backup"].steps) == harness.BACKUP_STEPS


def test_every_step_carries_a_positive_timeout_and_a_known_retry_class() -> None:
    for kind, spec in KINDS.items():
        assert spec.steps, kind
        assert spec.max_attempts >= 1, kind
        for step in spec.steps:
            assert step.timeout_s > 0, (kind, step.name)
            assert step.retry_class in models.RETRY_CLASSES, (kind, step.name)
    assert [
        (kind, seq)
        for kind, spec in KINDS.items()
        for seq, step in enumerate(spec.steps, 1)
        if step.conditional
    ] == [("add_domain", 7), ("remove_domain", 2)]


def test_the_lock_set_is_the_organisation_lock_then_the_tenant_lock() -> None:
    organisation, tenant = uuid.uuid4(), uuid.uuid4()
    assert lock_set("provision", organisation, tenant) == (
        Lock("organisation", organisation, "shared"),
        Lock("tenant", tenant, "exclusive"),
    )
    assert lock_set("realm_update", organisation, None) == (
        Lock("organisation", organisation, "exclusive"),
    )
    assert lock_set("backup", organisation, tenant) == (Lock("tenant", tenant, "shared"),)


def test_a_tenant_kind_without_a_tenant_is_a_programming_error() -> None:
    with pytest.raises(ValueError, match="backup takes a tenant lock and needs a tenant"):
        lock_set("backup", uuid.uuid4(), None)
    with pytest.raises(KeyError):
        lock_set("no_such_kind", uuid.uuid4(), None)


def test_the_key_is_the_harness_digest_of_the_canonical_json_array() -> None:
    parent, dispatch = uuid.uuid4(), uuid.uuid4()
    parts: list[str | int] = ["urn:kodera:identity:é", "POST", "/v1/a%2Fb", "backup", 'k"1,', 0]
    assert derive_key(parts) == harness.key_digest(*parts)
    assert derive_key(["sub", parent, dispatch]) == harness.key_digest(
        "sub", str(parent), str(dispatch)
    )
    assert sub_job_key(parent, dispatch) == harness.key_digest("sub", str(parent), str(dispatch))


def test_zero_and_the_string_zero_derive_two_keys() -> None:
    assert derive_key(["n", 0]) != derive_key(["n", "0"])


@pytest.mark.parametrize("part", [True, False, _Int(0), 0.0, None, b"0"])
def test_a_part_that_is_not_a_string_an_int_or_a_uuid_is_refused(part: Any) -> None:
    with pytest.raises(TypeError, match="a key part is a str, an int or a UUID"):
        derive_key(["n", part])


def test_an_action_outside_the_job_rows_is_refused_before_any_write() -> None:
    assert "job.created" in JOB_ACTIONS and "job.state_force_unlocked" not in JOB_ACTIONS
    with pytest.raises(ValueError, match="tenant.suspended is not a job action"):
        record_job_event(
            action="tenant.suspended",
            job_id=uuid.uuid4(),
            organisation_id=uuid.uuid4(),
            actor_type="system",
            actor_id=None,
            request_id=None,
            metadata={},
        )


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("actor_type", "actor_id", "label"),
    [
        ("system", None, "system"),
        ("staff", uuid.UUID(int=7), "urn:kodera:identity:00000000-0000-0000-0000-000000000007"),
    ],
)
def test_a_job_event_is_one_standard_audit_row_naming_the_job(
    actor_type: str, actor_id: uuid.UUID | None, label: str
) -> None:
    job, organisation = uuid.uuid4(), uuid.uuid4()
    record_job_event(
        action="job.created",
        job_id=job,
        organisation_id=organisation,
        actor_type=actor_type,
        actor_id=actor_id,
        request_id="req-1",
        metadata={"kind": "backup"},
    )
    (event,) = AuditEvent.objects.filter(job_id=job)
    assert (
        event.action,
        event.target_urn,
        event.organisation_id,
        event.actor_type,
        event.actor_id,
        event.actor_label,
        event.request_id,
        event.retention_class,
        event.metadata,
    ) == (
        "job.created",
        f"urn:kodera:job:{job}",
        organisation,
        actor_type,
        actor_id,
        label,
        "req-1",
        "standard",
        {"kind": "backup"},
    )

"""Worker acceptance (G1.5): tests/worker/acceptance.toml holds each test's state.

The worker is a separate process with no inbound network (ADR-0003): its accident guard refuses
the binds and listens it can see, it serves no URL, loads only its own profile, holds no credential
in its environment, and on the development network reaches the database alone (G1.5-A). It claims
a queued job, runs each step in a child process that holds no listening socket either, records the
outcome under authenticated proof, and lets no credential outlive its call (G1.5-B: WK-11 to
WK-14). WK-11 to WK-13 start a real worker against the test database; WK-14 needs none.
"""

import dataclasses
import os
import shutil
import signal
import stat
import tempfile
import uuid
from pathlib import Path

import pytest
import yaml
from worker_acceptance import (
    ROOT,
    WORKER_SETTINGS,
    acceptance,
    api_image_worker_refusals,
    check_report,
    last_line,
    worker_image_files,
    worker_image_refusals,
    worker_network_refusals,
    worker_process,
    worker_supervision_refusals,
)
from worker_fixtures import SENTINEL, credential_ledger
from worker_harness import (
    Control,
    WorkerProcess,
    alive,
    audit_actions,
    database_name,
    dispatches,
    enqueue,
    environment_names,
    environment_of,
    expire_lease,
    job,
    listening_sockets,
    open_reservations,
    short_directory,
    steps,
    wait_gone,
)

from dev.image_context import image_files, image_tree

BOOTED = "import worker.boot; worker.boot.enter()\n"
BIND_REFUSED = (
    "worker.boot.BoundaryRefusal: the worker binds no socket: it has no inbound network (ADR-0003)"
)
LISTEN_REFUSED = (
    "worker.boot.BoundaryRefusal: the worker listens on no socket: it has no inbound network "
    "(ADR-0003)"
)


# WK-01 and WK-02 hold the worker's accident guard: a library or our own code
# cannot open a listener by mistake. It is not a sandbox; what enforces no inbound network is the
# network, WK-07.


@acceptance("WK-01")
def test_wk_01_the_booted_worker_refuses_to_bind_a_socket():
    # A short path: an AF_UNIX path longer than the platform's limit fails before the bind event.
    unix = Path(tempfile.gettempdir()) / f"kodera-wk-{uuid.uuid4().hex[:12]}"
    for program in (
        "import socket; socket.socket().bind(('127.0.0.1', 0))",
        "import socket; socket.socket(socket.AF_INET6).bind(('::1', 0))",
        f"import socket; socket.socket(socket.AF_UNIX).bind({str(unix)!r})",
        "import _socket; _socket.socket().bind(('127.0.0.1', 0))",
        "import asyncio; asyncio.run(asyncio.start_server(lambda r, w: None, '127.0.0.1', 0))",
    ):
        refused = worker_process(program=BOOTED + program)
        assert refused.returncode != 0 and last_line(refused) == BIND_REFUSED, program
    assert not unix.exists()


@acceptance("WK-02")
def test_wk_02_the_booted_worker_refuses_to_listen():
    # The accident guard, not a sandbox (worker/boot.py): an unbound socket that listens is bound by
    # the kernel to an ephemeral port on every address, with no `socket.bind` event, and CPython 3.12
    # raises no `socket.listen` event. So the ordinary ways to reach `listen` refuse it: the socket
    # module's class and the raw `_socket` type's names. Code set on getting past it still can.
    for program in (
        "import socket; socket.socket().listen()",
        "import socket; socket.SocketType().listen(1)",
        "import _socket; _socket.socket().listen(1)",
        "import _socket; _socket.SocketType().listen(1)",
    ):
        refused = worker_process(program=BOOTED + program)
        assert refused.returncode != 0 and last_line(refused) == LISTEN_REFUSED, program


@acceptance("WK-03")
def test_wk_03_the_worker_starts_with_no_http_surface():
    report = check_report(worker_process("check"))
    assert report == {
        "settings": WORKER_SETTINGS,
        "bind": "refused",
        "listen": "refused",
        "raw_listen": "refused",
        "root_urlconf": None,
        "wsgi_application": None,
        "middleware": [],
        "debug": False,
        "http_modules": [],
        "credentials": "worker.credentials",
    }


@acceptance("WK-04")
def test_wk_04_the_worker_profile_refuses_to_load_outside_the_worker():
    program = "import django; django.setup()"
    refused = worker_process(
        program=program, environment={"DJANGO_SETTINGS_MODULE": WORKER_SETTINGS}
    )
    assert refused.returncode != 0
    assert last_line(refused) == (
        "django.core.exceptions.ImproperlyConfigured: "
        "config.settings.deploy_worker loads only in the worker process: python -m worker"
    )


@acceptance("WK-05")
def test_wk_05_the_worker_refuses_a_credential_in_its_environment():
    # ADR-0003 rejects credentials in the worker's environment: a job loads its own, per job.
    for name in (
        "SCW_SECRET_KEY",
        "SSH_PRIVATE_KEY",
        "SOPS_AGE_KEY_FILE",
        "TF_VAR_SCW_SECRET_KEY",
        "TF_TOKEN_STATE_BACKEND",
        "TF_HTTP_PASSWORD",
        "PG_CONN_STR",
        "GOOGLE_CREDENTIALS",
        "CONSUL_HTTP_TOKEN",
        "VAULT_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "KUBECONFIG",
        "PGPASSFILE",
        "DOCKER_CONFIG",
        "ANSIBLE_PRIVATE_KEY_FILE",
        "KEYCLOAK_ADMIN_PASSWORD",
    ):
        refused = worker_process("check", environment={name: "synthetic-private-sentinel"})
        assert refused.returncode != 0, name
        assert last_line(refused) == (
            "django.core.exceptions.ImproperlyConfigured: Deployment configuration refused"
        ), name
        assert "synthetic-private-sentinel" not in refused.stdout + refused.stderr


@acceptance("WK-06")
def test_wk_06_the_worker_starts_only_with_its_own_profile():
    for selector in ("config.settings.deploy", "config.settings.test", "config.settings.dev"):
        refused = worker_process("check", environment={"DJANGO_SETTINGS_MODULE": selector})
        assert refused.returncode != 0
        assert last_line(refused) == f"the worker starts only with {WORKER_SETTINGS}", selector


# WK-07 is a static proof of what compose declares. A live proof that a forbidden peer cannot be
# reached is out of scope here: production isolation is Fleet's network policy, the SRE's
# evidence (lane decision W2).
@acceptance("WK-07")
def test_wk_07_compose_puts_the_worker_on_an_internal_network_with_the_database_alone():
    compose = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
    assert worker_network_refusals(compose) == []
    assert worker_supervision_refusals(compose) == []
    worker = compose["services"]["worker"]
    assert worker["command"] == ["python", "-m", "worker", "run"]
    assert worker["build"]["dockerfile"] == "Dockerfile.worker"
    assert worker["environment"]["DJANGO_SETTINGS_MODULE"] == WORKER_SETTINGS


@acceptance("WK-08")
def test_wk_08_the_api_image_carries_no_worker_module():
    files = image_files(ROOT)
    assert api_image_worker_refusals(files) == []
    assert "apps/outbox/realm_enqueue.py" in files, "the API image's files were not read"


@acceptance("WK-09")
def test_wk_09_the_worker_image_carries_no_url_or_api_module():
    files = worker_image_files()
    assert worker_image_refusals(files) == []
    assert "worker/credentials/realm.py" in files


@acceptance("WK-10")
def test_wk_10_the_worker_image_starts_the_worker_from_its_own_files(tmp_path: Path):
    image_tree(ROOT, tmp_path, "Dockerfile.worker")
    assert not (tmp_path / "tests").exists() and not (tmp_path / "manage.py").exists()
    report = check_report(worker_process("check", cwd=tmp_path))
    assert report["settings"] == WORKER_SETTINGS and report["http_modules"] == []
    shutil.rmtree(tmp_path / "worker")
    refused = worker_process("check", cwd=tmp_path)
    assert refused.returncode != 0 and "No module named worker" in refused.stderr


# WK-11 to WK-13 start a real worker (tests/worker/worker_entry.py) on the test database, serving
# the synthetic registry: `backup`, whose first step is handed a sentinel credential.


@pytest.mark.django_db(transaction=True)
@acceptance("WK-11")
def test_wk_11_a_running_worker_holds_no_listening_socket(tmp_path: Path):
    # Inspected from outside the processes, idle and while a step runs: no LISTEN socket at all in
    # the worker or in its step child, including one native code would open past the accident
    # guard, which the child re-enters.
    control = Control(tmp_path)
    control.plan(quiesce=["hold"])
    with short_directory("wk11") as jobs:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=jobs)
        try:
            assert worker.started["guarded"] is True
            assert listening_sockets(worker.pid) == []
            job_id = enqueue()
            name, child = control.held()
            assert listening_sockets(worker.pid) == []
            assert listening_sockets(child) == []
            assert control.ledger()[0]["guarded"] is True, "the step child is unguarded"
            control.release(name)
            assert worker.ended(job_id) == "succeeded"
        finally:
            worker.kill()


@pytest.mark.django_db(transaction=True)
@acceptance("WK-12")
def test_wk_12_the_runner_claims_a_queued_job_and_records_its_outcome(tmp_path: Path):
    control = Control(tmp_path)
    with short_directory("wk12") as jobs:
        worker = WorkerProcess(database=database_name(), control=tmp_path, job_root=jobs)
        try:
            done = enqueue()
            assert worker.ended(done) == "succeeded"
            control.plan(snapshot=["fail"])
            failed = enqueue()
            assert worker.ended(failed) == "failed"
        finally:
            worker.kill()

    assert job(done)["status"] == "succeeded" and job(done)["error_code"] is None
    assert steps(done) == ["succeeded"] * 4
    closed = dispatches(done)
    assert [row["seq"] for row in closed] == [1, 2, 3, 4]
    assert all(row["terminal_outcome"] == "completed" for row in closed)
    assert all(row["terminal_evidence_ref"].startswith("synthetic-proof:") for row in closed)
    assert open_reservations(done) == 0
    actions = audit_actions(done)
    assert actions.count("job.step_succeeded") == 4 and actions[-1] == "job.succeeded"

    assert job(failed)["status"] == "failed" and job(failed)["error_code"] == "step_failed"
    assert steps(failed) == ["succeeded", "failed", "pending", "pending"]
    assert [(row["seq"], row["terminal_outcome"]) for row in dispatches(failed)] == [
        (1, "completed"),
        (2, "failed"),
    ]
    assert open_reservations(failed) == 0
    assert "job.step_failed" in audit_actions(failed) and audit_actions(failed)[-1] == "job.failed"


def _released(control: Path) -> tuple[set[object], set[object], list[dict[str, object]]]:
    rows = credential_ledger(control)
    issued = {row["token"] for row in rows if row["event"] == "issued"}
    released = {row["token"] for row in rows if row["event"] == "released"}
    return issued, released, rows


@pytest.mark.django_db(transaction=True)
@acceptance("WK-13")
def test_wk_13_no_credential_outlives_its_job(tmp_path: Path):
    # A sentinel credential source records issue and release: after success, failure, a child
    # SIGKILL and a restart, nothing is held, the child's environment never carried the credential
    # and the per-job directory is gone. Python cannot zero a str: this is proven by lifetimes.
    database = database_name()
    for case, plan, ending in (
        ("success", {}, "succeeded"),
        ("failure", {"quiesce": ["fail"]}, "failed"),
        ("child-kill", {"quiesce": ["hold", "complete"]}, "succeeded"),
    ):
        control = tmp_path / case
        control.mkdir()
        Control(control).plan(**plan)
        with short_directory("wk13") as jobs:
            worker = WorkerProcess(database=database, control=control, job_root=jobs)
            try:
                job_id = enqueue()
                if case == "child-kill":
                    name, child = Control(control).held()
                    assert SENTINEL not in environment_of(child), "the credential is in environ"
                    names = environment_names(child)
                    assert names is None or not any("CREDENTIAL" in n for n in names)
                    handed = worker.job_directory(job_id) / "credential"
                    assert stat.S_IMODE(handed.stat().st_mode) == 0o600
                    os.kill(child, signal.SIGKILL)
                assert worker.ended(job_id) == ending, case
                gone = not worker.job_directory(job_id).exists()
                assert gone, f"{case}: the job directory outlived it"
            finally:
                worker.kill()
        issued, released, _ = _released(control)
        assert issued and issued == released, f"{case}: a credential was not released"
    assert len(dispatches(job_id)) == 4, "the killed child's replay opened a second dispatch"

    # A restart: the worker dies while its step holds the credential.
    control = tmp_path / "restart"
    control.mkdir()
    Control(control).plan(quiesce=["hold"])
    with short_directory("wk13") as jobs:
        first = WorkerProcess(database=database, control=control, job_root=jobs)
        job_id = enqueue()
        _, child = Control(control).held()
        left = first.job_directory(job_id)
        assert (left / "credential").exists()
        first.kill()
        wait_gone(child)
        assert left.exists(), "nothing was left for the startup sweep to prove"
        issued, released, rows = _released(control)
        unreleased = [row for row in rows if row["token"] in issued - released]
        assert [row["pid"] for row in unreleased] == [first.pid]
        assert not alive(first.pid), "the credential's only holder is still alive"
        expire_lease(job_id)
        second = WorkerProcess(database=database, control=control, job_root=jobs)
        try:
            # Another runner's directory, its lock released with its process (worker/jobdir.py).
            assert f"{first.started['runner_id']}/{job_id}" in second.started["swept"]
            assert not left.exists(), "the startup sweep left the killed run's job directory"
            second.wait_for(lambda event: event["event"] == "started")
        finally:
            second.kill()


@acceptance("WK-14")
def test_wk_14_the_synthetic_provider_authenticates_its_terminal_proof(tmp_path: Path):
    from worker.providers.synthetic import KEY_BYTES, SyntheticProvider

    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    provider = SyntheticProvider.for_run(tmp_path / "a")
    other_run = SyntheticProvider.for_run(tmp_path / "b")
    proof = provider.terminal_proof(dispatch_id="d-1", operation_ref="urn:o", outcome="succeeded")
    assert provider.verify(proof)
    assert SyntheticProvider.for_run(tmp_path / "a").verify(proof), "one run has one key"
    for forged in (
        dataclasses.replace(proof, outcome="failed"),
        dataclasses.replace(proof, dispatch_id="d-2"),
        dataclasses.replace(proof, operation_ref="urn:p"),
        other_run.terminal_proof(dispatch_id="d-1", operation_ref="urn:o", outcome="succeeded"),
    ):
        assert not provider.verify(forged), forged
    key = tmp_path / "a" / "provider" / "key"
    assert len(key.read_bytes()) == KEY_BYTES and stat.S_IMODE(key.stat().st_mode) == 0o600
    assert key.read_bytes() != (tmp_path / "b" / "provider" / "key").read_bytes()

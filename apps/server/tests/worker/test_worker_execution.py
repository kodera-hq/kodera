"""The runner's parts, each held by a check that names what it refuses (G1.5-B). No database.

Real processes where a process is the subject: a step child is started, held, killed and reaped
for real, and a worker that dies is SIGKILLed for real. Each check is a function that raises an
AssertionError with one sentence; `OWNERS` binds every worker mutant flag to the one check it must
fail, and `test_each_worker_mutant_fails_the_check_that_owns_it` proves it does, by that sentence,
while the same check passes with no flag active. A source rewrite stands in for a mutant flag where
the guard sits outside the worker (core/faults.py, config/deploy_environment.py) or is the gate
itself.
"""

from __future__ import annotations

import ast
import contextlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
import warnings
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from worker_acceptance import ROOT, last_line, worker_process
from worker_fixtures import SENTINEL, SentinelCredentialSource, synthetic_registry
from worker_harness import environment_names, environment_of, reaped, wait_gone

from apps.jobs.kinds import KINDS, REALM_KINDS
from apps.jobs.runner_selectors import OWNED, JobOwnership
from apps.jobs.types import Claim
from core import faults
from dev.image_context import image_tree
from worker import child as child_module, handoff, jobdir, mutants
from worker.child import (
    CHILD_ENVIRONMENT,
    CREDENTIAL_FILE,
    ERRORS_FILE,
    NOT_OWNED,
    NOT_STARTED,
    OVERFLOW,
    READS_PER_POLL,
    ChildResult,
    _open_errors,
    _Output,
    _write_credential,
    child_environment,
    run_child,
)
from worker.convergence import Convergence, Dispatched, settle
from worker.credentials import WORKER_CLIENT_ID, ClientCredential
from worker.jobdir import JobRoot, JobRootRefused
from worker.lease import LEASE_S, Lease
from worker.providers import synthetic
from worker.providers.synthetic import SyntheticProvider, TerminalProof
from worker.registry import G15C_GAPS, PRODUCTION, JobContext, Registry, RegistryError, StepPlan
from worker.runner import (
    NO_KIND_SERVED,
    Runner,
    _proof,
    _replayable,
    database_budget_refusals,
    ownership_refusals,
)
from worker.step import SYNTHETIC_REFUSED

HERE = Path(__file__).resolve().parent
SITE = "realm_create:after-provider-success-before-acknowledgement"


@contextmanager
def active(flag: str) -> Iterator[None]:
    mutants.activate(flag)
    try:
        yield
    finally:
        mutants.deactivate()


def provider(tmp: Path, **plan: list[str]) -> SyntheticProvider:
    control = tmp / f"control-{uuid.uuid4().hex[:8]}"
    control.mkdir()
    found = SyntheticProvider.for_run(control)
    if plan:
        (found.directory / "plan.json").write_text(json.dumps(plan))
    return found


def request(found: SyntheticProvider, step: str = "quiesce", attempt: int = 1) -> dict[str, object]:
    return found.request(
        dispatch_id=str(uuid.uuid4()),
        operation_ref=f"urn:kodera:worker:test:{step}",
        payload_hash="0" * 64,
        step=step,
        attempt=attempt,
    )


def held(found: SyntheticProvider, timeout: float = 30.0) -> tuple[str, int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        files = sorted((found.directory / "held").glob("*.json"))
        if files:
            return files[0].stem, int(json.loads(files[0].read_text())["pid"])
        time.sleep(0.05)
    raise AssertionError("the synthetic provider never held the call")


def release(found: SyntheticProvider, name: str) -> None:
    (found.directory / "release").mkdir(exist_ok=True)
    (found.directory / "release" / name).write_text("")


def ledger(found: SyntheticProvider) -> list[dict[str, object]]:
    return [json.loads(p.read_text()) for p in sorted((found.directory / "ledger").glob("*.json"))]


class Running:
    """run_child on a thread, so the test can act on the child while the runner waits on it."""

    def __init__(self, request: dict[str, object], directory: Path, secret: str | None = None):
        self.lost = threading.Event()
        self.result: object = None
        directory.mkdir(parents=True, exist_ok=True)
        self.thread = threading.Thread(
            target=lambda: setattr(
                self,
                "result",
                run_child(
                    request,
                    directory=directory,
                    secret=secret,
                    lost=self.lost.is_set,
                    timeout_s=60,
                ),
            ),
            daemon=True,
        )
        self.thread.start()


def kill_group(pid: int) -> None:
    for kill in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
        try:
            kill()
        except (ProcessLookupError, PermissionError):
            continue


# ------------------------------------------------------------------- the owning checks ----


def renewals(*answers: bool | None) -> Callable[[Claim], bool]:
    """A renewal that answers each of `answers` in turn, then True: None is a database error."""
    from django.db import OperationalError

    pending = iter(answers)

    def renew(claim: Claim) -> bool:
        answer = next(pending, True)
        if answer is None:
            raise OperationalError("synthetic: the database did not answer")
        return answer

    return renew


class Blocked:
    """A renewal that blocks, as one does on a half-open TCP connection, until released."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.released = threading.Event()

    def __call__(self, claim: Claim) -> bool:
        self.entered.set()
        self.released.wait(30)
        return True


def check_two_failed_renewals_lose_the_lease(tmp: Path) -> None:
    lease = Lease(
        Claim(uuid.uuid4(), 1, "r"),
        renew=renewals(True, None, None),
        every_s=0.01,
        on_stop=lambda: None,
    ).start()
    lost = lease.lost.wait(2)
    lease.stop()
    assert lost, "the lease was not given up after two failed renewals in a row"


def check_a_refused_renewal_loses_the_lease_at_once(tmp: Path) -> None:
    # The database answered False once: the fence moved or the lease is gone. Nothing comes back.
    lease = Lease(
        Claim(uuid.uuid4(), 1, "r"),
        renew=renewals(True, False),
        every_s=0.01,
        on_stop=lambda: None,
    ).start()
    lost = lease.lost.wait(2)
    lease.stop()
    assert lost, "a renewal the database refused did not lose the lease at once"


def check_a_dead_keeper_loses_its_lease(tmp: Path) -> None:
    def broken(claim: Claim) -> bool:
        raise RuntimeError("synthetic: the keeper's own defect")

    # The keeper's exception is the subject, not a defect of this test: keep it off the hook that
    # reports unhandled thread exceptions.
    with mock.patch.object(threading, "excepthook", lambda arguments: None):
        lease = Lease(
            Claim(uuid.uuid4(), 1, "r"), renew=broken, every_s=0.01, on_stop=lambda: None
        ).start()
        lost = lease.lost.wait(2)
        lease.stop()
    assert lost, "a lease keeper that died left its lease looking held"


def check_a_renewal_blocked_past_the_lease_end_loses_it(tmp: Path) -> None:
    blocked = Blocked()
    lease = Lease(
        Claim(uuid.uuid4(), 1, "r"),
        renew=blocked,
        every_s=0.01,
        lease_s=0.6,
        margin_s=0.1,
        stop_join_s=0.2,
        on_stop=lambda: None,
    ).start()
    try:
        assert blocked.entered.wait(5), "the keeper never renewed"
        deadline = time.monotonic() + 3
        while not lease.is_lost() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert lease.is_lost(), "a renewal blocked past the lease's end left the lease held"
    finally:
        blocked.released.set()
        lease.stop()


def check_a_stopped_keeper_issues_no_renewal(tmp: Path) -> None:
    asked: list[Claim] = []

    def renew(claim: Claim) -> bool:
        asked.append(claim)
        return True

    lease = Lease(Claim(uuid.uuid4(), 1, "r"), renew=renew, on_stop=lambda: None)
    # The keeper woke for a renewal just as the runner asked it to stop: the stop wins.
    lease._stop.set()
    lease._renew_once()
    assert asked == [], "the keeper renewed after it was stopped"


def check_stopping_a_lease_does_not_wait_on_a_blocked_renewal(tmp: Path) -> None:
    blocked = Blocked()
    lease = Lease(
        Claim(uuid.uuid4(), 1, "r"),
        renew=blocked,
        every_s=0.01,
        stop_join_s=0.2,
        on_stop=lambda: None,
    ).start()
    stopper = threading.Thread(target=lease.stop, daemon=True)
    try:
        assert blocked.entered.wait(5), "the keeper never renewed"
        stopper.start()
        stopper.join(3)
        assert not stopper.is_alive(), "stopping the lease waited on a blocked renewal"
    finally:
        blocked.released.set()
        stopper.join(10)


def check_a_lost_lease_kills_and_reaps_the_step(tmp: Path) -> None:
    found = provider(tmp, quiesce=["hold"])
    # A child left unreaped also leaves its Popen to warn when it is collected: that warning is the
    # mutant's, and the check below is what names it.
    with warnings.catch_warnings():
        if mutants.on("child_left_unreaped"):
            warnings.simplefilter("ignore", ResourceWarning)
        running = Running(request(found), tmp / "job")
        _, pid = held(found)
        try:
            running.lost.set()
            running.thread.join(5)
            assert not running.thread.is_alive(), (
                "the step's process group was not killed when the lease was lost"
            )
            assert getattr(running.result, "killed", None) == "lease_lost"
            # This process is the step's parent and is alive: a zombie is a child nobody reaped.
            assert reaped(pid), "the step child was not reaped after the lease was lost"
        finally:
            kill_group(pid)
            running.thread.join(10)


def check_the_group_is_killed_before_its_leader_is_reaped(tmp: Path) -> None:
    found = provider(tmp)
    (tmp / "job").mkdir()
    killed: list[tuple[int, bool]] = []
    real_killpg = os.killpg

    def recording(pgid: int, number: int) -> None:
        try:
            os.kill(pgid, 0)  # a zombie still answers: its pid, the group's id, is still held
        except ProcessLookupError:
            killed.append((pgid, False))
        else:
            killed.append((pgid, True))
        real_killpg(pgid, number)

    with mock.patch.object(os, "killpg", recording):
        result = run_child(
            request(found),
            directory=tmp / "job",
            secret=None,
            lost=threading.Event().is_set,
            timeout_s=60,
        )
    assert result.killed is None and result.answer is not None, "the step did not answer"
    mine = [present for pgid, present in killed if pgid == result.pid]
    assert mine, "the step's group was never killed after the step ended"
    assert mine[0], "the step's group was killed after its leader was reaped"


def check_the_step_runs_in_its_own_process_group(tmp: Path) -> None:
    found = provider(tmp, quiesce=["hold"])
    running = Running(request(found), tmp / "job")
    name, pid = held(found)
    try:
        entry = ledger(found)[0]
        assert entry["pgid"] == pid != os.getpgrp(), (
            "the step child does not run in its own process group"
        )
    finally:
        release(found, name)
        running.thread.join(30)
        kill_group(pid)


def check_the_credential_never_reaches_the_child_environment(tmp: Path) -> None:
    secret = SENTINEL + uuid.uuid4().hex
    assert secret not in json.dumps(child_environment(secret)), (
        "the credential reached the step child's environment"
    )
    found = provider(tmp, quiesce=["hold"])
    directory = tmp / "job"
    running = Running(request(found), directory, secret=secret)
    name, pid = held(found)
    try:
        assert SENTINEL not in environment_of(pid), (
            "the credential reached the step child's environment"
        )
        names = environment_names(pid)
        if names is not None:
            assert names <= set(CHILD_ENVIRONMENT), f"the step child inherited {sorted(names)}"
        mode = stat.S_IMODE((directory / CREDENTIAL_FILE).stat().st_mode)
        assert mode == 0o600, f"the credential file is mode {mode:o}"
        assert ledger(found)[0]["credential_handed"] is True
    finally:
        release(found, name)
        running.thread.join(30)
        kill_group(pid)
    assert not (directory / CREDENTIAL_FILE).exists(), "the credential file outlived its call"


def check_the_live_step_child_environment_holds_no_credential(tmp: Path) -> None:
    # Read from outside, as the system shows it: /proc on Linux, `ps eww` elsewhere. A reader
    # that saw nothing would pass vacuously, so it must first see a name the child always has.
    secret = SENTINEL + uuid.uuid4().hex
    found = provider(tmp, quiesce=["hold"])
    running = Running(request(found), tmp / "job", secret=secret)
    name, pid = held(found)
    try:
        seen = environment_of(pid)
        assert "PYTHONSAFEPATH=1" in seen, f"the environment reader saw nothing of {pid}: {seen!r}"
        assert SENTINEL not in seen, "the credential reached the live step child's environment"
    finally:
        release(found, name)
        running.thread.join(30)
        kill_group(pid)


ESCAPE = (
    "    boot.enter()\n",
    "    boot.enter()\n"
    "    import subprocess as escape\n"
    "    escaped = escape.Popen([sys.executable, '-c', 'import time; time.sleep(8)'],\n"
    "                           start_new_session=True, stdin=escape.DEVNULL)\n"
    "    Path('escaped.pid').write_text(str(escaped.pid))\n",
)


def check_an_escaped_grandchild_does_not_hold_the_runner(tmp: Path) -> None:
    # The step starts a grandchild that leaves its group with setsid() and keeps its stdout: the
    # group kill misses it (gap worker:kill-all-descendants), and the runner must not wait on it.
    tree = weakened_worker(tmp / "tree", "worker/step.py", *ESCAPE)
    found = provider(tmp)
    job = tmp / "job"
    job.mkdir()
    outcome: list[object] = []
    with mock.patch("worker.child.code_root", return_value=tree):
        thread = threading.Thread(
            target=lambda: outcome.append(
                run_child(
                    request(found),
                    directory=job,
                    secret=None,
                    lost=threading.Event().is_set,
                    timeout_s=60,
                )
            ),
            daemon=True,
        )
        thread.start()
        try:
            thread.join(4)
            assert not thread.is_alive(), (
                "the runner waited on a grandchild that escaped the step's group"
            )
            assert getattr(outcome[0], "answer", None) is not None, (
                "the runner lost the answer of a step whose grandchild escaped"
            )
        finally:
            escaped = job / "escaped.pid"
            if escaped.exists():
                kill_group(int(escaped.read_text()))
            thread.join(15)


def check_a_failed_credential_write_leaves_no_credential(tmp: Path) -> None:
    job = tmp / "job"
    job.mkdir()

    def failing(descriptor: int, *arguments: object, **options: object) -> object:
        os.close(descriptor)
        raise OSError("synthetic: the disk is full")

    call = request(provider(tmp))
    with mock.patch.object(os, "fdopen", failing):
        result = run_child(
            call,
            directory=job,
            secret=SENTINEL + uuid.uuid4().hex,
            lost=threading.Event().is_set,
            timeout_s=60,
        )
    assert not (job / CREDENTIAL_FILE).exists(), "a credential whose write failed stayed on disk"
    assert result.killed == NOT_STARTED


def check_a_linked_step_errors_file_is_not_followed(tmp: Path) -> None:
    job = tmp / "job"
    job.mkdir()
    elsewhere = tmp / "elsewhere"
    (job / ERRORS_FILE).symlink_to(elsewhere)
    result = run_child(
        request(provider(tmp)),
        directory=job,
        secret=None,
        lost=threading.Event().is_set,
        timeout_s=60,
    )
    assert not elsewhere.exists(), "step.err was opened through a symbolic link"
    assert result.killed == NOT_STARTED


def check_a_credential_clash_is_a_call_not_started(tmp: Path) -> None:
    job = tmp / "job"
    job.mkdir()
    (job / CREDENTIAL_FILE).write_text("left by something else")
    try:
        result = run_child(
            request(provider(tmp)),
            directory=job,
            secret=SENTINEL + uuid.uuid4().hex,
            lost=threading.Event().is_set,
            timeout_s=60,
        )
    except FileExistsError:
        raise AssertionError(
            "a credential clash escaped as an exception instead of a call not started"
        ) from None
    assert result.killed == NOT_STARTED and result.pid == 0
    assert (job / CREDENTIAL_FILE).read_text() == "left by something else"
    # Any failure to prepare the call, not an OSError alone: a secret the file cannot hold.
    unwritable = tmp / "unwritable"
    unwritable.mkdir()
    try:
        result = run_child(
            request(provider(tmp)),
            directory=unwritable,
            secret="synth\u00e9tique",
            lost=threading.Event().is_set,
            timeout_s=60,
        )
    except UnicodeEncodeError:
        raise AssertionError(
            "a credential that cannot be written escaped as an exception instead of a call not "
            "started"
        ) from None
    assert result.killed == NOT_STARTED
    assert not (unwritable / CREDENTIAL_FILE).exists(), "a credential half written stayed on disk"


class Spawned(BaseException):  # noqa: N818 - a sentinel, past any `except Exception`
    """Raised by a patched Popen: a step child would have been started."""


def _never_spawned(*arguments: object, **options: object) -> object:
    raise Spawned


class LosingWhileLoading:
    """A credential source whose load takes so long the lease is lost meanwhile."""

    def __init__(self, lease: Lease) -> None:
        self.lease = lease
        self.released = False

    @contextmanager
    def load(self, realm: str) -> Iterator[ClientCredential]:
        self.lease.lost.set()  # the keeper gave the lease up while the source was answering
        try:
            yield ClientCredential(WORKER_CLIENT_ID, SENTINEL + uuid.uuid4().hex)
        finally:
            self.released = True


def handed_off_while(
    running: Callable[[], bool], inside: list[bool] | None = None
) -> mock._patch[object]:
    """The runner's locked handoff (worker/handoff.py) as a test double: it runs `write`, with
    `inside` recording "begin" and "commit" around it, only while `running()` holds."""

    def hand_off(job_id: uuid.UUID, fence: int, write: Callable[[], bool]) -> str:
        if not running():
            return handoff.NOT_OWNED
        if inside is not None:
            inside.append("begin")  # type: ignore[arg-type]
        try:
            return handoff.WRITTEN if write() else handoff.WRITE_REFUSED
        finally:
            if inside is not None:
                inside.append("commit")  # type: ignore[arg-type]

    return mock.patch("worker.handoff.hand_off", hand_off)


def owned_while(running: Callable[[], bool]) -> mock._patch[object]:
    """The database's ownership read, answering `running()` for the status at a current fence
    under a live lease: what a sweep on another connection changes."""
    return mock.patch(
        "apps.jobs.runner_selectors.job_ownership",
        lambda job_id, fence: JobOwnership(running(), True, True),
    )


def check_no_step_starts_once_the_lease_is_lost(tmp: Path) -> None:
    # The lease is lost while the step's credential loads: the runner must spawn nothing.
    lease = Lease(Claim(uuid.uuid4(), 1, "r"), renew=lambda claim: True, on_stop=lambda: None)
    source = LosingWhileLoading(lease)
    runner = Runner(
        runner_id="r",
        registry=synthetic_registry(),
        provider=provider(tmp),
        credentials=source,
        job_root=tmp / "jobs",
        emit=lambda event, fields: None,
    )
    jobs = JobRoot(tmp / "jobs", "r")
    try:
        with (
            jobs.job(uuid.uuid4()) as directory,
            mock.patch("worker.child.subprocess.Popen", _never_spawned),
            owned_while(lambda: True),
            handed_off_while(lambda: True),
        ):
            plan = runner.registry.plan("backup", 1)
            try:
                result = runner._call(
                    lease.claim,
                    plan,
                    KINDS["backup"].steps[0],
                    uuid.uuid4(),
                    "urn:ref",
                    "0" * 64,
                    1,
                    directory,
                    lease,
                )
            except Spawned:
                raise AssertionError("a step child was started after the lease was lost") from None
            assert result.killed == "lease_lost" and result.pid == 0
            assert not (directory.path / CREDENTIAL_FILE).exists()
    finally:
        jobs.close()
    assert source.released, "the credential loaded for a step never started was not released"
    # The lease already lost when the call is asked: no Popen, no credential file left.
    job = tmp / "job"
    job.mkdir()
    with mock.patch("worker.child.subprocess.Popen", _never_spawned):
        try:
            result = run_child(
                request(provider(tmp)),
                directory=job,
                secret=SENTINEL + uuid.uuid4().hex,
                lost=lambda: True,
                timeout_s=60,
            )
        except Spawned:
            raise AssertionError("a step child was started after the lease was lost") from None
    assert result.killed == "lease_lost" and not (job / CREDENTIAL_FILE).exists()


def check_the_step_files_are_opened_in_the_directory_handed(tmp: Path) -> None:
    # The job directory is swapped for another after it was opened: the files follow the
    # descriptor, never the name.
    job = tmp / "job"
    job.mkdir(mode=0o700)
    descriptor = os.open(job, os.O_RDONLY | os.O_DIRECTORY)
    try:
        job.rename(tmp / "opened")
        job.mkdir(mode=0o700)
        _write_credential(job, descriptor, "synthetic")
        os.close(_open_errors(job, descriptor))
    finally:
        os.close(descriptor)
    for name in (CREDENTIAL_FILE, ERRORS_FILE):
        assert not (job / name).exists(), f"{name} was opened by path, not in its job directory"
        assert (tmp / "opened" / name).exists()


def check_one_poll_reads_a_bounded_batch(tmp: Path) -> None:
    read_end, write_end = os.pipe()
    reads: list[int] = []

    def endless(descriptor: int, size: int) -> bytes:
        reads.append(size)  # a child that never stops writing: the pipe is never empty
        return b"x" * size

    try:
        output = _Output(read_end)
        with mock.patch.object(os, "read", endless):
            output.read()
    finally:
        os.close(read_end)
        os.close(write_end)
    assert len(reads) <= READS_PER_POLL, "one poll read the step's stdout without bound"


FLOOD = (
    "    boot.enter()\n",
    "    boot.enter()\n"
    "    import time as flooding\n"
    "    while True:\n"
    "        os.write(1, b'x' * 65536)\n"
    "        flooding.sleep(FLOOD_PAUSE)\n",
)


def _flooding(tmp: Path, pause: float, lost: Callable[[], bool], timeout_s: float) -> ChildResult:
    old, new = FLOOD
    tree = weakened_worker(
        tmp / "tree", "worker/step.py", old, new.replace("FLOOD_PAUSE", str(pause))
    )
    job = tmp / "job"
    job.mkdir()
    found = provider(tmp)
    with mock.patch("worker.child.code_root", return_value=tree):
        return run_child(request(found), directory=job, secret=None, lost=lost, timeout_s=timeout_s)


def check_a_flooding_step_is_killed_and_answers_nothing(tmp: Path) -> None:
    # About 6 MB/s: past the 1 MiB limit in a fraction of a second, and harmless without one.
    result = _flooding(tmp, 0.01, threading.Event().is_set, 2)
    assert result.killed == OVERFLOW, "a flooding step was not killed for its overflow"
    assert result.answer is None


def check_a_runner_without_its_credentials_is_refused(tmp: Path) -> None:
    try:
        Runner(
            runner_id="r",
            registry=synthetic_registry(),
            provider=provider(tmp),
            credentials=None,
            job_root=tmp / "jobs",
        )
    except ValueError as refused:
        assert str(refused) == (
            "backup step 1 is handed a synthetic-realm credential, and the runner has no "
            "credential source"
        )
    else:
        raise AssertionError(
            "a runner whose steps are handed a credential started without a credential source"
        )


def _job_roots(tmp: Path) -> Iterator[tuple[str, Path, str]]:
    """Each job root that is not the runner's own, and the refusal it must meet."""
    real = tmp / "real"
    real.mkdir(mode=0o700)
    linked = tmp / "linked"
    linked.symlink_to(real)
    yield "a symbolic link", linked, "the job root is a symbolic link or not a directory"
    open_root = tmp / "open"
    open_root.mkdir()
    open_root.chmod(0o777)
    yield "mode 0777", open_root, "the job root is mode 777, not 700"
    foreign = tmp / "foreign"
    foreign.mkdir(mode=0o700)
    foreign.chmod(0o700)
    owner = os.getuid()
    with mock.patch.object(os, "getuid", return_value=owner + 1):
        yield (
            "another user's",
            foreign,
            f"the job root is owned by uid {owner}, not by the runner's",
        )
    runner_linked = tmp / "runner-linked"
    runner_linked.mkdir(mode=0o700)
    runner_linked.chmod(0o700)
    (runner_linked / "r1").symlink_to(real)
    yield (
        "a runner directory that is a link",
        runner_linked,
        "the runner's job directory is a symbolic link or not a directory",
    )


def check_a_job_root_that_is_not_the_runners_own_is_refused(tmp: Path) -> None:
    for case, root, message in _job_roots(tmp):
        try:
            JobRoot(root, "r1").close()
        except JobRootRefused as refused:
            assert str(refused) == message, f"{case}: {refused}"
        else:
            raise AssertionError(f"a job root that is not the runner's own was trusted: {case}")


def check_each_ownership_clause_refuses(tmp: Path) -> None:
    assert ownership_refusals(JobOwnership(True, True, True)) == []
    assert ownership_refusals(None) == ["the job is gone"]
    cases = (
        (JobOwnership(False, True, True), "the job is not running", "a job that is not running"),
        (
            JobOwnership(True, False, True),
            "the job's fence has moved past this claim",
            "a fence that is not the job's",
        ),
        (
            JobOwnership(True, True, False),
            "the job's lease has ended by the database's clock",
            "a lease the database's clock has ended",
        ),
    )
    for found, refusal, what in cases:
        assert ownership_refusals(found) == [refusal], f"a provider call was authorised on {what}"


def _swept_mid_step(tmp: Path, store: dict[str, str]) -> tuple[Runner, list[str], str]:
    """The reviewer's case, with the real _step, _call and launch: the first call runs while the
    job is running, a sweep on another connection holds it meanwhile, the call answers nothing.
    The open dispatch is still read back, as the old replay query read it. The spawns, by the
    job's status at each, and the step's ending."""
    found = provider(tmp, quiesce=["silent", "complete"])
    plans = [
        StepPlan("backup", seq, spec.name, convergent=True)
        for seq, spec in enumerate(KINDS["backup"].steps, start=1)
    ]
    runner = Runner(
        runner_id="r",
        registry=Registry(plans),
        provider=found,
        job_root=tmp / "jobs",
        emit=lambda event, fields: None,
    )
    claim = Claim(uuid.uuid4(), 1, "r")
    job = JobContext(claim.job_id, "backup", uuid.uuid4(), uuid.uuid4())
    dispatch = uuid.uuid4()
    spawned: list[str] = []
    real_popen, real_send = subprocess.Popen, child_module._send

    def popen(*arguments: object, **options: object) -> object:
        spawned.append(store["status"])
        return real_popen(*arguments, **options)  # type: ignore[call-overload]

    def send(process: object, body: object) -> bool:
        sent = real_send(process, body)  # type: ignore[arg-type]
        store["status"] = "needs_reconciliation"  # the sweep, once the step has its request
        return sent

    lease = Lease(claim, renew=lambda held: True, on_stop=lambda: None)
    jobs = JobRoot(tmp / "jobs", "r")
    refused = lambda **fields: False  # noqa: E731 - every write after the sweep is refused
    try:
        with (
            mock.patch("apps.jobs._runner.record_dispatch", lambda **fields: dispatch),
            mock.patch("apps.jobs._runner.hold_for_reconciliation", refused),
            mock.patch("apps.jobs._runner.close_dispatch", refused),
            mock.patch("apps.jobs._runner.record_step", refused),
            mock.patch("apps.jobs._runner.finish_job", refused),
            mock.patch(
                "apps.jobs.runner_selectors.open_dispatch",
                lambda job_id, fence: (dispatch, plans[0].operation_ref(job.id)),
            ),
            owned_while(lambda: store["status"] == "running"),
            handed_off_while(lambda: store["status"] == "running"),
            mock.patch("worker.child.subprocess.Popen", popen),
            mock.patch("worker.child._send", send),
            jobs.job(claim.job_id) as directory,
        ):
            ending = runner._step(claim, job, plans[0], KINDS["backup"].steps[0], directory, lease)
    finally:
        jobs.close()
    return runner, spawned, ending


def check_no_credential_loads_for_a_job_not_owned(tmp: Path) -> None:
    # The job was swept before the call was asked: the ownership read comes first, and the step's
    # credential is never loaded for it.
    class Recording:
        loads: list[str] = []

        @contextmanager
        def load(self, realm: str) -> Iterator[ClientCredential]:
            self.loads.append(realm)
            yield ClientCredential(WORKER_CLIENT_ID, SENTINEL + uuid.uuid4().hex)

    source = Recording()
    runner = Runner(
        runner_id="r",
        registry=synthetic_registry(),
        provider=provider(tmp),
        credentials=source,
        job_root=tmp / "jobs",
        emit=lambda event, fields: None,
    )
    lease = Lease(Claim(uuid.uuid4(), 1, "r"), renew=lambda claim: True, on_stop=lambda: None)
    jobs = JobRoot(tmp / "jobs", "r")
    try:
        with (
            jobs.job(uuid.uuid4()) as directory,
            owned_while(lambda: False),
            handed_off_while(lambda: False),
        ):
            result = runner._call(
                lease.claim,
                runner.registry.plan("backup", 1),
                KINDS["backup"].steps[0],
                uuid.uuid4(),
                "urn:ref",
                "0" * 64,
                1,
                directory,
                lease,
            )
    finally:
        jobs.close()
    assert source.loads == [], "a credential was loaded for a job this claim no longer owns"
    assert result.killed == NOT_OWNED


def test_a_swept_job_is_never_replayed(tmp_path: Path) -> None:
    check_a_swept_job_is_never_replayed(tmp_path)


def check_a_swept_job_is_never_replayed(tmp: Path) -> None:
    store = {"status": "running"}
    _, spawned, ending = _swept_mid_step(tmp, store)
    assert spawned == ["running"], (
        f"a provider call started on a job this claim no longer owns: {spawned}"
    )
    assert ending == "refused" and store["status"] == "needs_reconciliation"


def check_ownership_is_asked_again_after_the_credential_loads(tmp: Path) -> None:
    # The job is swept while the step's credential loads: the child spawned next, waiting on its
    # stdin, must never be sent its request.
    store = {"status": "running"}
    sent: list[object] = []
    real_send = child_module._send

    def recording_send(process: subprocess.Popen[bytes], body: dict[str, object]) -> bool:
        sent.append(body)
        return real_send(process, body)

    class SweptWhileLoading:
        released = False

        @contextmanager
        def load(self, realm: str) -> Iterator[ClientCredential]:
            store["status"] = "needs_reconciliation"
            try:
                yield ClientCredential(WORKER_CLIENT_ID, SENTINEL + uuid.uuid4().hex)
            finally:
                self.released = True

    runner = Runner(
        runner_id="r",
        registry=synthetic_registry(),
        provider=provider(tmp),
        credentials=SweptWhileLoading(),
        job_root=tmp / "jobs",
        emit=lambda event, fields: None,
    )
    lease = Lease(Claim(uuid.uuid4(), 1, "r"), renew=lambda claim: True, on_stop=lambda: None)
    jobs = JobRoot(tmp / "jobs", "r")
    try:
        with (
            jobs.job(uuid.uuid4()) as directory,
            owned_while(lambda: store["status"] == "running"),
            handed_off_while(lambda: store["status"] == "running"),
            mock.patch("worker.child._send", recording_send),
        ):
            result = runner._call(
                lease.claim,
                runner.registry.plan("backup", 1),
                KINDS["backup"].steps[0],
                uuid.uuid4(),
                "urn:ref",
                "0" * 64,
                1,
                directory,
                lease,
            )
            assert sent == [], (
                "a provider call started after ownership was lost while its credential loaded"
            )
            assert result.killed == NOT_OWNED
            assert reaped(result.pid), "the unsent step child was not killed and reaped"
            assert not (directory.path / CREDENTIAL_FILE).exists()
    finally:
        jobs.close()


def test_the_spawn_comes_before_the_handoff_and_only_the_write_runs_under_it(
    tmp_path: Path,
) -> None:
    # The handoff's own lock and re-read are proven against PostgreSQL
    # (tests/worker/test_worker_runner.py); here, the order around it: the child is spawned before
    # the transaction begins, the request's write is the one thing inside it, and the `child`
    # event is emitted after the commit.
    order: list[str] = []
    real_popen, real_send = subprocess.Popen, child_module._send

    def popen(*arguments: object, **options: object) -> object:
        order.append("spawn")
        return real_popen(*arguments, **options)  # type: ignore[call-overload]

    def send(process: object, body: object) -> bool:
        order.append("write")
        return real_send(process, body)  # type: ignore[arg-type]

    def emit(event: str, fields: object) -> None:
        if event == "child":
            order.append("started")

    runner = Runner(
        runner_id="r",
        registry=synthetic_registry(),
        provider=provider(tmp_path),
        credentials=SentinelCredentialSource(tmp_path),
        job_root=tmp_path / "jobs",
        emit=emit,
    )
    lease = Lease(Claim(uuid.uuid4(), 1, "r"), renew=lambda claim: True, on_stop=lambda: None)
    jobs = JobRoot(tmp_path / "jobs", "r")
    try:
        with (
            jobs.job(uuid.uuid4()) as directory,
            owned_while(lambda: True),
            handed_off_while(lambda: True, order),  # type: ignore[arg-type]
            mock.patch("worker.child.subprocess.Popen", popen),
            mock.patch("worker.child._send", send),
        ):
            result = runner._call(
                lease.claim,
                runner.registry.plan("backup", 1),
                KINDS["backup"].steps[0],
                uuid.uuid4(),
                "urn:ref",
                "0" * 64,
                1,
                directory,
                lease,
            )
    finally:
        jobs.close()
    assert order == ["spawn", "begin", "write", "commit", "started"], order
    assert result.killed is None and result.answer is not None


def test_a_send_that_fails_inside_the_handoff_is_killed_unsent(tmp_path: Path) -> None:
    job = tmp_path / "job"
    job.mkdir()
    with mock.patch("worker.child._send", lambda process, body: False):
        result = run_child(
            request(provider(tmp_path)),
            directory=job,
            secret=SENTINEL + uuid.uuid4().hex,
            lost=threading.Event().is_set,
            timeout_s=60,
            hand_off=lambda write: write(),
        )
    assert result.killed == NOT_OWNED and result.pid != 0
    assert reaped(result.pid), "a child whose send failed was left running"
    assert not (job / CREDENTIAL_FILE).exists()


class EventFailed(Exception):  # noqa: N818 - named for the event, not an error class
    """The `child` event's own failure: stderr closed under the runner, say."""


def check_a_failing_event_still_kills_and_reaps_the_step(tmp: Path) -> None:
    # The request is sent and committed; then the `child` event raises (a broken pipe on the
    # flushed stderr). The run ends in that exception, never replayed or settled, and the child is
    # still killed and reaped, its stdin closed and its credential removed. What the code under
    # test did is read off the child's own Popen before this check cleans up after a mutant, so
    # nothing is left for the garbage collector to report in a later test.
    job = tmp / "job"
    job.mkdir()
    spawned: list[subprocess.Popen[bytes]] = []
    real_popen = subprocess.Popen

    def recording(*args: Any, **kwargs: Any) -> subprocess.Popen[bytes]:
        process = real_popen(*args, **kwargs)
        spawned.append(process)
        return process

    def started(pid: int) -> None:
        raise EventFailed("synthetic: stderr is gone")

    try:
        with mock.patch.object(subprocess, "Popen", recording):
            with pytest.raises(EventFailed):
                run_child(
                    request(provider(tmp, quiesce=["hold"])),
                    directory=job,
                    secret=SENTINEL + uuid.uuid4().hex,
                    lost=threading.Event().is_set,
                    timeout_s=60,
                    started=started,
                    hand_off=lambda write: write(),
                )
        assert len(spawned) == 1, f"one step child, not {len(spawned)}"
        (process,) = spawned
        assert process.returncode is not None and reaped(process.pid), (
            "the step child was left unreaped when its event failed"
        )
        assert process.stdin is None or process.stdin.closed, (
            "the step child's stdin outlived a failed event"
        )
    finally:
        for process in spawned:
            if process.returncode is None:
                kill_group(process.pid)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(10)
            if process.stdin is not None and not process.stdin.closed:
                with contextlib.suppress(OSError):
                    process.stdin.close()
    assert not (job / CREDENTIAL_FILE).exists(), "the credential outlived a failed event"


def _replay(tmp: Path, *, open_dispatch: str = "same", ref: str = "same", payload: str = "same"):
    plan = StepPlan("backup", 2, "snapshot", convergent=True)
    convergence = Convergence()
    dispatch_id = uuid.uuid4()
    convergence.record(Dispatched(dispatch_id, "urn:ref", "a" * 64))
    again = Dispatched(
        dispatch_id,
        "urn:ref" if ref == "same" else "urn:other",
        "a" * 64 if payload == "same" else "b" * 64,
    )
    current = {"same": (dispatch_id, "urn:ref"), "closed": None, "other": (uuid.uuid4(), "urn:ref")}
    return convergence.replay_refusals(plan, again, current[open_dispatch]), dispatch_id


def check_a_replay_needs_its_dispatch_still_open(tmp: Path) -> None:
    assert _replay(tmp)[0] == []
    for case in ("closed", "other"):
        refusals, dispatch_id = _replay(tmp, open_dispatch=case)
        assert refusals == [f"dispatch {dispatch_id} is no longer the job's open dispatch"], (
            "a replay was admitted on a dispatch that is no longer open"
        )


def check_a_replay_needs_its_operation_ref(tmp: Path) -> None:
    refusals, dispatch_id = _replay(tmp, ref="other")
    assert refusals == [f"dispatch {dispatch_id}'s operation_ref changed"], (
        "a replay was admitted with another operation_ref"
    )


def check_a_replay_needs_its_payload(tmp: Path) -> None:
    refusals, dispatch_id = _replay(tmp, payload="other")
    assert refusals == [f"dispatch {dispatch_id}'s payload changed since it was sent"], (
        "a replay was admitted with another payload"
    )


def check_an_unauthenticated_proof_holds(tmp: Path) -> None:
    mine, theirs = provider(tmp), provider(tmp)
    dispatch_id = uuid.uuid4()
    forged = theirs.terminal_proof(
        dispatch_id=str(dispatch_id), operation_ref="urn:ref", outcome="succeeded"
    )
    settled = settle(forged, dispatch_id=dispatch_id, operation_ref="urn:ref", verify=mine.verify)
    assert settled.action == "hold", "a proof whose tag does not verify closed the dispatch"
    assert settled.reason == "the terminal proof is not authenticated"


def check_the_job_directory_ends_with_its_job(tmp: Path) -> None:
    job_id = uuid.uuid4()
    jobs = JobRoot(tmp / "jobs", "r1")
    try:
        with pytest.raises(RuntimeError), jobs.job(job_id) as directory:
            (directory.path / CREDENTIAL_FILE).write_text("synthetic")
            raise RuntimeError("the step failed")
    finally:
        jobs.close()
    assert not (tmp / "jobs" / "r1" / str(job_id)).exists(), (
        "the per-job directory outlived its job"
    )


def _left_by(root: Path, runner_id: str) -> Path:
    """A job directory a runner left when it was killed: its lock went with its process."""
    JobRoot(root, runner_id).close()
    left = root / runner_id / str(uuid.uuid4())
    left.mkdir(mode=0o700)
    (left / CREDENTIAL_FILE).write_text("synthetic")
    return left


def check_the_startup_sweep_removes_what_a_killed_run_left(tmp: Path) -> None:
    root = tmp / "jobs"
    mine, theirs = _left_by(root, "r1"), _left_by(root, "dead-runner")
    jobs = JobRoot(root, "r1")
    try:
        swept = jobs.sweep()
    finally:
        jobs.close()
    assert not mine.exists() and not theirs.exists(), (
        "the startup sweep left a killed run's job directory"
    )
    assert swept == sorted([f"r1/{mine.name}", f"dead-runner/{theirs.name}"])
    assert not (root / "dead-runner").exists()


def check_a_sweep_never_removes_a_live_replacement(tmp: Path) -> None:
    # Sweeper A opens dead runner R's directory and pauses before it locks it. Meanwhile sweeper B
    # sweeps, and R restarts. A then resumes. Played in one thread, in that order, by a hook.
    root = tmp / "jobs"
    stale = _left_by(root, "R")
    stale_inode = (root / "R").stat().st_ino
    a, b = JobRoot(root, "A"), JobRoot(root, "B")
    replacement: list[JobRoot] = []
    real_lock = jobdir._lock
    paused: list[int] = []

    def pausing(descriptor: int) -> bool:
        if not paused and os.fstat(descriptor).st_ino == stale_inode:
            paused.append(descriptor)
            b.sweep()
            try:
                replacement.append(JobRoot(root, "R"))
            except JobRootRefused as refused:
                assert str(refused) == "the job root is busy: another runner holds it"
            else:
                (replacement[0].path / "live-job").mkdir()
        return real_lock(descriptor)

    try:
        with (
            mock.patch.object(jobdir, "ROOT_LOCK_WAIT_S", 0.0),
            mock.patch.object(jobdir, "_lock", pausing),
        ):
            a.sweep()
        assert paused, "the sweep never reached the dead runner's directory"
        if replacement:
            assert (replacement[0].path / "live-job").exists(), (
                "the sweep removed a live replacement runner directory"
            )
        else:
            assert not stale.exists(), "the sweep left the dead runner's directory"
            JobRoot(root, "R").close()  # the restart, once the sweep let the root go
    finally:
        for held in (a, b, *replacement):
            held.close()


def check_the_startup_sweep_spares_a_live_runner(tmp: Path) -> None:
    root = tmp / "jobs"
    live = JobRoot(root, "live-runner")
    try:
        with live.job(uuid.uuid4()) as working:
            jobs = JobRoot(root, "r1")
            try:
                jobs.sweep()
            finally:
                jobs.close()
            assert working.path.exists(), "the startup sweep removed a live runner's job directory"
    finally:
        live.close()


def _complete_plans(kind: str) -> list[StepPlan]:
    return [
        StepPlan(kind, seq, spec.name, convergent=False)
        for seq, spec in enumerate(KINDS[kind].steps, start=1)
    ]


def check_no_realm_kind_is_served_before_g15c(tmp: Path) -> None:
    for kind in sorted(REALM_KINDS):
        try:
            Registry(_complete_plans(kind))
        except RegistryError as refused:
            assert str(refused) == (
                f"{kind} is not served before G1.5-C binds its steps (lane decision W4)"
            )
        else:
            raise AssertionError(f"the registry serves {kind} before G1.5-C (lane decision W4)")


OWNERS: dict[str, tuple[Callable[[Path], None], str]] = {
    "lease_survives_failed_renewals": (
        check_two_failed_renewals_lose_the_lease,
        "the lease was not given up after two failed renewals in a row",
    ),
    "lease_retries_a_refused_renewal": (
        check_a_refused_renewal_loses_the_lease_at_once,
        "a renewal the database refused did not lose the lease at once",
    ),
    "lease_keeper_dies_silently": (
        check_a_dead_keeper_loses_its_lease,
        "a lease keeper that died left its lease looking held",
    ),
    "lease_ignores_its_deadline": (
        check_a_renewal_blocked_past_the_lease_end_loses_it,
        "a renewal blocked past the lease's end left the lease held",
    ),
    "lease_stop_waits_on_a_blocked_renewal": (
        check_stopping_a_lease_does_not_wait_on_a_blocked_renewal,
        "stopping the lease waited on a blocked renewal",
    ),
    "no_reap_on_lease_loss": (
        check_a_lost_lease_kills_and_reaps_the_step,
        "the step's process group was not killed when the lease was lost",
    ),
    "child_left_unreaped": (
        check_a_lost_lease_kills_and_reaps_the_step,
        "the step child was not reaped after the lease was lost",
    ),
    "group_killed_after_reaping": (
        check_the_group_is_killed_before_its_leader_is_reaped,
        "the step's group was killed after its leader was reaped",
    ),
    "credential_in_live_environment": (
        check_the_live_step_child_environment_holds_no_credential,
        "the credential reached the live step child's environment",
    ),
    "provider_call_without_db_ownership": (
        check_no_credential_loads_for_a_job_not_owned,
        "a credential was loaded for a job this claim no longer owns",
    ),
    "child_kept_when_its_event_fails": (
        check_a_failing_event_still_kills_and_reaps_the_step,
        "the step child was left unreaped when its event failed",
    ),
    "handoff_skipped": (
        check_ownership_is_asked_again_after_the_credential_loads,
        "a provider call started after ownership was lost while its credential loaded",
    ),
    "ownership_ignores_status": (
        check_each_ownership_clause_refuses,
        "a provider call was authorised on a job that is not running",
    ),
    "ownership_ignores_fence": (
        check_each_ownership_clause_refuses,
        "a provider call was authorised on a fence that is not the job's",
    ),
    "ownership_ignores_lease": (
        check_each_ownership_clause_refuses,
        "a provider call was authorised on a lease the database's clock has ended",
    ),
    "child_started_after_lease_loss": (
        check_no_step_starts_once_the_lease_is_lost,
        "a step child was started after the lease was lost",
    ),
    "job_files_opened_by_path": (
        check_the_step_files_are_opened_in_the_directory_handed,
        "credential was opened by path, not in its job directory",
    ),
    "output_read_unbounded": (
        check_one_poll_reads_a_bounded_batch,
        "one poll read the step's stdout without bound",
    ),
    "output_uncapped": (
        check_a_flooding_step_is_killed_and_answers_nothing,
        "a flooding step was not killed for its overflow",
    ),
    "lease_renews_after_stop": (
        check_a_stopped_keeper_issues_no_renewal,
        "the keeper renewed after it was stopped",
    ),
    "sweep_unserialised": (
        check_a_sweep_never_removes_a_live_replacement,
        "the sweep removed a live replacement runner directory",
    ),
    "child_waits_for_end_of_file": (
        check_an_escaped_grandchild_does_not_hold_the_runner,
        "the runner waited on a grandchild that escaped the step's group",
    ),
    "credential_kept_on_a_failed_write": (
        check_a_failed_credential_write_leaves_no_credential,
        "a credential whose write failed stayed on disk",
    ),
    "step_errors_follow_a_link": (
        check_a_linked_step_errors_file_is_not_followed,
        "step.err was opened through a symbolic link",
    ),
    "unprepared_call_raises": (
        check_a_credential_clash_is_a_call_not_started,
        "a credential clash escaped as an exception instead of a call not started",
    ),
    "runner_starts_without_its_credentials": (
        check_a_runner_without_its_credentials_is_refused,
        "a runner whose steps are handed a credential started without a credential source",
    ),
    "job_root_unchecked": (
        check_a_job_root_that_is_not_the_runners_own_is_refused,
        "a job root that is not the runner's own was trusted: a symbolic link",
    ),
    "sweep_ignores_live_runners": (
        check_the_startup_sweep_spares_a_live_runner,
        "the startup sweep removed a live runner's job directory",
    ),
    "child_shares_worker_group": (
        check_the_step_runs_in_its_own_process_group,
        "the step child does not run in its own process group",
    ),
    "credential_in_child_environment": (
        check_the_credential_never_reaches_the_child_environment,
        "the credential reached the step child's environment",
    ),
    "replay_ignores_open_dispatch": (
        check_a_replay_needs_its_dispatch_still_open,
        "a replay was admitted on a dispatch that is no longer open",
    ),
    "replay_ignores_operation_ref": (
        check_a_replay_needs_its_operation_ref,
        "a replay was admitted with another operation_ref",
    ),
    "replay_ignores_payload_hash": (
        check_a_replay_needs_its_payload,
        "a replay was admitted with another payload",
    ),
    "settle_accepts_unauthenticated_proof": (
        check_an_unauthenticated_proof_holds,
        "a proof whose tag does not verify closed the dispatch",
    ),
    "job_directory_kept": (
        check_the_job_directory_ends_with_its_job,
        "the per-job directory outlived its job",
    ),
    "startup_sweep_skipped": (
        check_the_startup_sweep_removes_what_a_killed_run_left,
        "the startup sweep left a killed run's job directory",
    ),
    "registry_admits_realm_kinds": (
        check_no_realm_kind_is_served_before_g15c,
        "the registry serves realm_create before G1.5-C",
    ),
}


@pytest.mark.parametrize("flag", sorted(OWNERS))
def test_each_worker_check_holds_with_no_mutant(flag: str, tmp_path: Path) -> None:
    OWNERS[flag][0](tmp_path)


@pytest.mark.parametrize("flag", sorted(OWNERS))
def test_each_worker_mutant_fails_the_check_that_owns_it(flag: str, tmp_path: Path) -> None:
    check, message = OWNERS[flag]
    with active(flag), pytest.raises(AssertionError) as failed:
        check(tmp_path)
    assert str(failed.value).startswith(message), str(failed.value)


# Flags whose guard only PostgreSQL can exercise: each is owned by a check of the Postgres suite,
# which activates the flag in process and asserts that check's message.
DATABASE_OWNED = {
    "handoff_without_row_lock": "tests/worker/test_worker_runner.py::"
    "test_the_handoff_holds_the_job_against_the_sweep",
    "handoff_without_reread_after_lock": "tests/worker/test_worker_runner.py::"
    "test_a_lease_that_ends_while_the_handoff_waits_for_the_lock_refuses",
}


def test_every_worker_mutant_has_an_owning_check() -> None:
    assert not set(OWNERS) & set(DATABASE_OWNED)
    assert set(OWNERS) | set(DATABASE_OWNED) == mutants.FLAGS
    runner_tests = (HERE / "test_worker_runner.py").read_text()
    for flag, owner in DATABASE_OWNED.items():
        assert owner.split("::")[1] in runner_tests and f'"{flag}"' in runner_tests, owner


# --------------------------------------------------------------------- the lease keeper ----


def test_a_renewal_that_succeeds_between_two_failures_keeps_the_lease() -> None:
    lease = Lease(
        Claim(uuid.uuid4(), 1, "r"),
        renew=renewals(None, True, None, True, None, True),
        every_s=0.01,
        on_stop=lambda: None,
    ).start()
    time.sleep(0.3)
    lease.stop()
    assert not lease.lost.is_set()


def test_a_database_error_counts_as_a_failed_renewal() -> None:
    from django.db import OperationalError

    def broken(claim: Claim) -> bool:
        raise OperationalError("synthetic: the database did not answer")

    lease = Lease(Claim(uuid.uuid4(), 1, "r"), renew=broken, every_s=0.01, on_stop=lambda: None)
    assert lease.start().lost.wait(2)
    lease.stop()
    assert lease.failures == 2, "a database error was read as a refusal, not a failure"


def test_a_successful_renewal_moves_the_lease_clock_to_when_it_was_asked() -> None:
    asked: list[float] = []

    def renew(claim: Claim) -> bool:
        asked.append(time.monotonic())
        time.sleep(0.05)  # the round trip: the database set the lease before the answer arrived
        return True

    lease = Lease(
        Claim(uuid.uuid4(), 1, "r"), renew=renew, every_s=0.01, since=0.0, on_stop=lambda: None
    ).start()
    deadline = time.monotonic() + 2
    while lease.last_renewed == 0.0 and time.monotonic() < deadline:
        time.sleep(0.01)
    lease.stop()
    # Asked within the keeper's own call, before the 50 ms round trip, never after it.
    assert any(at - 0.01 <= lease.last_renewed <= at for at in asked), (
        "the lease's clock moved to when a renewal answered"
    )


# ------------------------------------------------------------------- the step child ----


def test_the_step_child_answers_with_a_proof_the_runner_verifies(tmp_path: Path) -> None:
    found = provider(tmp_path)
    call = request(found)
    (tmp_path / "job").mkdir()
    result = run_child(
        call,
        directory=tmp_path / "job",
        secret=None,
        lost=threading.Event().is_set,
        timeout_s=60,
    )
    assert result.killed is None and result.returncode == 0 and result.answer is not None
    proof = TerminalProof.from_wire(result.answer["answer"])
    assert found.verify(proof)
    assert (proof.dispatch_id, proof.operation_ref) == (call["dispatch_id"], call["operation_ref"])
    assert reaped(result.pid), "the step child that answered was not reaped"


def test_a_lease_lost_mid_flood_kills_the_step_within_a_bounded_time(tmp_path: Path) -> None:
    # No answer limit to stop it first: the lease is read between bounded batches.
    asked = time.monotonic()
    with mock.patch("worker.child.ANSWER_LIMIT_BYTES", 1 << 40):
        result = _flooding(tmp_path, 0.001, lambda: time.monotonic() > asked + 1.0, 60)
    assert result.killed == "lease_lost" and result.answer is None
    assert time.monotonic() - asked < 20, "the flood held the runner past the lease's loss"


def test_an_overflow_is_held_and_never_replayed() -> None:
    overflowed = ChildResult(1, -9, None, OVERFLOW)
    assert not _replayable(overflowed)
    assert not _replayable(ChildResult(0, None, None, NOT_STARTED))
    assert _replayable(ChildResult(1, -9, None, "timeout"))
    held = settle(_proof(overflowed), dispatch_id=uuid.uuid4(), operation_ref="o", verify=bool)
    assert (held.action, held.reason) == ("hold", "the provider returned no terminal proof")


def test_the_step_child_re_enters_the_accident_guard(tmp_path: Path) -> None:
    found = provider(tmp_path)
    (tmp_path / "job").mkdir()
    run_child(
        request(found),
        directory=tmp_path / "job",
        secret=None,
        lost=threading.Event().is_set,
        timeout_s=60,
    )
    assert guard_refusals(ledger(found)[0]) == []


def guard_refusals(entry: dict[str, object]) -> list[str]:
    return (
        [] if entry["guarded"] is True else ["the step child did not re-enter the accident guard"]
    )


def weakened_worker(tmp: Path, path: str, old: str, new: str) -> Path:
    """A copy of the tree's sources with one change, for a source-rewrite mutation."""
    for top in ("worker", "core", "config", "apps", "services"):
        shutil.copytree(ROOT / top, tmp / top, ignore=shutil.ignore_patterns("__pycache__"))
    target = tmp / path
    text = target.read_text()
    assert text.count(old) == 1, f"the mutation no longer finds {old!r} in {path}"
    target.write_text(text.replace(old, new))
    return tmp


def step_child(
    tree: Path,
    found: SyntheticProvider,
    call: dict[str, object],
    settings: str = "config.settings.test",
) -> subprocess.Popen[bytes]:
    process = subprocess.Popen(  # noqa: S603 - a fixed interpreter and module
        [sys.executable, "-B", "-m", "worker.step"],
        cwd=tree,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": str(tree),
            "PYTHONSAFEPATH": "1",
            "DJANGO_SETTINGS_MODULE": settings,
        },
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    assert process.stdin is not None
    process.stdin.write((json.dumps(dict(call, credential=None)) + "\n").encode())
    process.stdin.flush()
    return process


def test_the_guard_check_sees_a_step_child_that_skips_the_guard(tmp_path: Path) -> None:
    tree = weakened_worker(tmp_path / "tree", "worker/step.py", "    boot.enter()\n", "")
    found = provider(tmp_path)
    child = step_child(tree, found, request(found))
    assert child.stdout is not None and child.stdin is not None
    # stdin stays open until the answer, as the runner keeps it: end of file means its death.
    answered = child.stdout.readline()
    child.stdin.close()
    child.wait(60)
    for stream in (child.stdout, child.stderr):
        if stream is not None:
            stream.close()
    assert json.loads(answered)["answer"] is not None
    assert guard_refusals(ledger(found)[0]) == [
        "the step child did not re-enter the accident guard"
    ]


PARENT = """
import os, sys, threading
import django
django.setup()
from pathlib import Path
from worker.child import run_child
from worker.providers.synthetic import SyntheticProvider
found = SyntheticProvider.for_run(Path(sys.argv[1]))
call = found.request(dispatch_id="d-parent", operation_ref="urn:parent", payload_hash="0" * 64,
                     step="quiesce", attempt=1)
Path(sys.argv[2]).mkdir()
run_child(call, directory=Path(sys.argv[2]), secret=None, lost=threading.Event().is_set,
          timeout_s=60)
"""


def outlived_refusals(tree: Path, control: Path, job: Path) -> list[str]:
    """Start a worker-shaped parent from `tree` whose step is held, SIGKILL the parent, and say
    whether the step child outlived it."""
    control.mkdir()
    found = SyntheticProvider.for_run(control)
    (found.directory / "plan.json").write_text(json.dumps({"quiesce": ["hold"]}))
    parent = subprocess.Popen(  # noqa: S603 - a fixed interpreter and program
        [sys.executable, "-B", "-c", PARENT, str(control), str(job)],
        cwd=tree,
        env={
            **os.environ,
            "PYTHONPATH": os.pathsep.join([str(tree), str(ROOT)]),
            "DJANGO_SETTINGS_MODULE": "config.settings.test",
        },
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    _, child = held(found)
    try:
        parent.send_signal(signal.SIGKILL)
        parent.wait(30)
        try:
            wait_gone(child, timeout=5)
        except AssertionError:
            return ["the step child outlived the worker that started it"]
        return []
    finally:
        kill_group(child)


def test_a_step_child_dies_with_its_worker(tmp_path: Path) -> None:
    assert outlived_refusals(ROOT, tmp_path / "control", tmp_path / "job") == []


def test_the_outlived_check_sees_a_child_that_ignores_its_worker(tmp_path: Path) -> None:
    tree = weakened_worker(
        tmp_path / "tree",
        "worker/step.py",
        "    threading.Thread(target=_die_with_the_worker, daemon=True).start()\n",
        "",
    )
    assert outlived_refusals(tree, tmp_path / "control", tmp_path / "job") == [
        "the step child outlived the worker that started it"
    ]


# ----------------------------------------------------- fault control from outside the worker ----

KILL_CHILD = """
import json, os, subprocess, sys
import django
django.setup()
from core import faults
faults.load_control(os.environ)
sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
print(json.dumps({"grandchild": sleeper.pid}), flush=True)
faults.reach(sys.argv[1])
print("passed the site", flush=True)
"""


def test_a_point_armed_from_outside_in_kill_mode_waits_to_be_killed(tmp_path: Path) -> None:
    (tmp_path / "armed.json").write_text(json.dumps([{"point": SITE, "mode": "kill"}]))
    child = subprocess.Popen(  # noqa: S603 - a fixed interpreter and program
        [sys.executable, "-B", "-c", KILL_CHILD, SITE],
        cwd=ROOT,
        env={
            **os.environ,
            "PYTHONPATH": str(ROOT),
            "DJANGO_SETTINGS_MODULE": "config.settings.test",
            "KODERA_FAULT_CONTROL": str(tmp_path),
        },
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    assert child.stdout is not None
    grandchild = json.loads(child.stdout.readline())["grandchild"]
    reached = tmp_path / "reached" / SITE
    deadline = time.monotonic() + 30
    while not reached.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert reached.exists(), "the worker never recorded reaching the armed point"
    assert json.loads(reached.read_text())["pid"] == child.pid
    os.killpg(child.pid, signal.SIGKILL)
    assert child.wait(30) == -signal.SIGKILL
    wait_gone(grandchild)
    assert "passed the site" not in child.stdout.read()
    child.stdout.close()


OPEN_PROBE = """
import json, os, sys
opened = []
control = sys.argv[1]
def audit(event, args):
    if event in ("open", "os.mkdir") and str(args[0]).startswith(control):
        opened.append(event + " " + str(args[0]))
sys.addaudithook(audit)
import django
django.setup()
from core import faults
try:
    if sys.argv[2] == "control":
        faults.load_control({"KODERA_FAULT_CONTROL": control})
    elif sys.argv[2] == "provider":
        from pathlib import Path
        from worker.providers.synthetic import SyntheticProvider
        SyntheticProvider.for_run(Path(control))
    elif sys.argv[2] == "provider_init":
        from pathlib import Path
        from worker.providers.synthetic import KEY_BYTES, SyntheticProvider
        SyntheticProvider(key=bytes(KEY_BYTES), directory=Path(control))
    else:
        from worker import mutants
        mutants.activate("job_directory_kept")
except faults.FaultPointsRefused as error:
    refused = str(error)
else:
    refused = None
print(json.dumps({"refused": refused, "opened": opened}))
"""


def gate_refusals(tree: Path, control: Path, what: str) -> list[str]:
    """Why `what`, asked for under a profile that does not permit fault points, read or wrote
    anything under `control`, or was admitted at all, or []."""
    (control / "armed.json").write_text("[]")
    result = subprocess.run(  # noqa: S603 - a fixed interpreter and program
        [sys.executable, "-B", "-c", OPEN_PROBE, str(control), what],
        cwd=tree,
        env={
            **{k: v for k, v in os.environ.items() if k != "DJANGO_SETTINGS_MODULE"},
            "PYTHONPATH": os.pathsep.join([str(tree), str(ROOT)]),
            "DJANGO_SETTINGS_MODULE": "config.settings.job_queue",
        },
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    report = json.loads(result.stdout.strip().splitlines()[-1])
    refusals = []
    if report["opened"]:
        refusals.append(f"a profile that does not permit fault points touched {control.name}")
    if report["refused"] != "fault points are refused: these settings do not permit them":
        refusals.append(f"a profile that does not permit fault points was admitted to {what}")
    return refusals


@pytest.mark.parametrize("what", ["control", "provider", "provider_init", "mutants"])
def test_nothing_test_only_is_read_before_the_test_profile_gate(tmp_path: Path, what: str) -> None:
    control = tmp_path / "control"
    control.mkdir()
    assert gate_refusals(ROOT, control, what) == []


@pytest.mark.parametrize(
    ("what", "path", "old", "new", "message"),
    [
        (
            # The new mutant of G1.5-B: the control directory read before the gate.
            "control",
            "core/faults.py",
            "    _require_permitted()\n    if names != [CONTROL]:",
            "    (Path(environment[CONTROL]) / ARMED_FILE).read_text()\n"
            "    _require_permitted()\n    if names != [CONTROL]:",
            "a profile that does not permit fault points touched control",
        ),
        (
            "provider",
            "worker/providers/synthetic.py",
            "        faults.require_permitted()\n        directory = control / PROVIDER_DIRECTORY",
            "        directory = control / PROVIDER_DIRECTORY",
            "a profile that does not permit fault points touched control",
        ),
        (
            # A provider built directly, past for_run(), verifies proofs all the same.
            "provider_init",
            "worker/providers/synthetic.py",
            "        faults.require_permitted()\n        if len(key) != KEY_BYTES:",
            "        if len(key) != KEY_BYTES:",
            "a profile that does not permit fault points was admitted to provider_init",
        ),
        (
            "mutants",
            "worker/mutants.py",
            "    faults.require_permitted()\n    if flag not in FLAGS:",
            "    if flag not in FLAGS:",
            "a profile that does not permit fault points was admitted to mutants",
        ),
    ],
)
def test_the_gate_check_sees_each_read_before_the_gate(  # noqa: PLR0913 - one row per mutation
    tmp_path: Path, what: str, path: str, old: str, new: str, message: str
) -> None:
    tree = weakened_worker(tmp_path / "tree", path, old, new)
    control = tmp_path / "control"
    control.mkdir()
    assert message in gate_refusals(tree, control, what)


def test_every_deployed_profile_refuses_fault_control() -> None:
    from django.core.exceptions import ImproperlyConfigured

    from config.deploy_environment import deployment, operator_deployment, worker_deployment

    database = {"DATABASE_URL": "postgresql://synthetic:synthetic-pass@db.synthetic.test/core"}
    served = {
        **database,
        "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
        "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
    }
    for name in ("KODERA_FAULT_CONTROL", "KODERA_FAULT_ANYTHING"):
        for profile, environment in (
            (worker_deployment, database),
            (deployment, served),
            (operator_deployment, served),
        ):
            profile(environment)
            with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
                profile({**environment, name: "/synthetic/control"})
    refused = worker_process("check", environment={"KODERA_FAULT_CONTROL": "/synthetic/control"})
    assert refused.returncode != 0
    assert last_line(refused) == (
        "django.core.exceptions.ImproperlyConfigured: Deployment configuration refused"
    )


ARM_IN_THE_IMAGE = """
import json, os
import worker.boot; worker.boot.enter()
import django; django.setup()
from core import faults
try:
    faults.load_control(os.environ)
except faults.FaultPointsRefused as refused:
    print(json.dumps({"refused": str(refused), "armed": list(faults.armed_points())}))
else:
    print(json.dumps({"refused": None, "armed": list(faults.armed_points())}))
"""


def test_the_refusal_is_what_stops_fault_control_reaching_the_worker(tmp_path: Path) -> None:
    tree = tmp_path / "image"
    image_tree(ROOT, tree, "Dockerfile.worker")
    profile = tree / "config" / "deploy_environment.py"
    text = profile.read_text()
    guard = 'if any(name.startswith("KODERA_FAULT_") for name in environment):'
    assert text.count(guard) == 1, "the mutation no longer finds the refusal it removes"
    profile.write_text(text.replace(guard, "if False:"))
    admitted = worker_process(
        "check", cwd=tree, environment={"KODERA_FAULT_CONTROL": "/synthetic/control"}
    )
    assert admitted.returncode == 0, admitted.stderr[-2000:]
    # The refusal gone, the image's tree still arms nothing: core/faults.py's gate needs
    # config.settings.test, which the image does not carry.
    control = tmp_path / "control"
    control.mkdir()
    (control / "armed.json").write_text(json.dumps([{"point": SITE, "mode": "kill"}]))
    armed = worker_process(
        program=ARM_IN_THE_IMAGE,
        cwd=tree,
        environment={
            "KODERA_FAULT_CONTROL": str(control),
            "DJANGO_SETTINGS_MODULE": "config.settings.deploy_worker",
        },
    )
    assert armed.returncode == 0, armed.stderr[-2000:]
    assert json.loads(armed.stdout.strip().splitlines()[-1]) == {
        "refused": "fault points are refused: these settings do not permit them",
        "armed": [],
    }
    assert not (control / "reached").exists()
    as_test = worker_process(
        program=ARM_IN_THE_IMAGE,
        cwd=tree,
        environment={
            "KODERA_FAULT_CONTROL": str(control),
            "DJANGO_SETTINGS_MODULE": "config.settings.test",
        },
    )
    assert as_test.returncode != 0
    assert last_line(as_test) == "ModuleNotFoundError: No module named 'config.settings.test'"


# ---------------------------------------------------------------- the database budget ----


def test_the_worker_keeps_the_apis_database_budget_and_it_fits_the_lease() -> None:
    from config.deploy_environment import worker_deployment

    database = worker_deployment(
        {"DATABASE_URL": "postgresql://synthetic:synthetic-pass@db.synthetic.test/core"}
    )["DATABASES"]["default"]
    assert database["OPTIONS"] == {**API_BUDGET, **KEEPALIVE}
    assert database_budget_refusals(database["OPTIONS"]) == []


API_BUDGET = {"connect_timeout": 2, "options": "-c statement_timeout=2000"}
KEEPALIVE = {
    "keepalives": 1,
    "keepalives_idle": 5,
    "keepalives_interval": 2,
    "keepalives_count": 3,
    "tcp_user_timeout": 10000,
}


def test_the_budget_check_refuses_a_budget_that_outlives_the_lease() -> None:
    assert database_budget_refusals(
        {**KEEPALIVE, "connect_timeout": 2, "options": "-c statement_timeout=30000"}
    ) == [
        "two failed renewals take 124 s to notice, not less than the 105 s of the lease the "
        "runner keeps"
    ]
    # A half-open connection is bounded by the client's keepalive and tcp_user_timeout alone.
    assert database_budget_refusals({**API_BUDGET, **KEEPALIVE, "keepalives_idle": 60}) == [
        "two failed renewals take 196 s to notice, not less than the 105 s of the lease the "
        "runner keeps"
    ]
    assert database_budget_refusals({**API_BUDGET, **KEEPALIVE, "tcp_user_timeout": 60000}) == [
        "two failed renewals take 184 s to notice, not less than the 105 s of the lease the "
        "runner keeps"
    ]
    assert database_budget_refusals({"options": ""}) == [
        "the worker's database has no connect_timeout",
        "the worker's database has no statement_timeout",
        "the worker's database has no TCP keepalives",
        "the worker's database has no tcp_user_timeout",
    ]
    # The API's budget alone, as the worker had it before G1.5-B's review.
    assert database_budget_refusals(API_BUDGET) == [
        "the worker's database has no TCP keepalives",
        "the worker's database has no tcp_user_timeout",
    ]
    for name in ("keepalives_idle", "keepalives_interval", "keepalives_count"):
        assert database_budget_refusals({**API_BUDGET, **KEEPALIVE, name: 0}) == [
            "the worker's database has no TCP keepalives"
        ]
    assert database_budget_refusals({**API_BUDGET, **KEEPALIVE, "keepalives": 0}) == [
        "the worker's database has no TCP keepalives"
    ]


# ------------------------------------------------------------- registry and production ----


def test_the_production_registry_serves_no_kind_before_g15c() -> None:
    assert PRODUCTION.kinds == frozenset()


PRODUCTION_PROBE = """
import json
from worker import registry
print(json.dumps({"kinds": sorted(registry.PRODUCTION.kinds), "gaps": list(registry.G15C_GAPS)}))
"""


def production_refusals(tree: Path) -> list[str]:
    """Why `tree`'s production registry serves a kind while a G1.5-C gap is open, or []."""
    result = subprocess.run(  # noqa: S603 - a fixed interpreter and program
        [sys.executable, "-B", "-c", PRODUCTION_PROBE],
        cwd=tree,
        env={
            **{k: v for k, v in os.environ.items() if k not in {"PYTHONPATH"}},
            "PYTHONPATH": str(tree),
            "DJANGO_SETTINGS_MODULE": "config.settings.test",
        },
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    found = json.loads(result.stdout.strip().splitlines()[-1])
    if found["gaps"] and found["kinds"]:
        return [
            f"the production registry serves {', '.join(found['kinds'])} while G1.5-C gaps are "
            f"open: {', '.join(found['gaps'])}"
        ]
    return []


def test_no_kind_is_served_in_production_while_a_g15c_gap_is_open() -> None:
    assert G15C_GAPS == (
        "worker:resume-failed-dispatch",
        "worker:kill-all-descendants",
        "worker:kind-claim-starvation",
        "worker:completed-dispatch-step-refused",
        "worker:provider-idempotency",
    )
    assert production_refusals(ROOT) == []


def test_the_production_check_sees_a_kind_registered_while_gaps_are_open(tmp_path: Path) -> None:
    tree = weakened_worker(
        tmp_path / "tree",
        "worker/registry.py",
        "PRODUCTION = Registry(())",
        "PRODUCTION = Registry(\n"
        "    StepPlan('backup', seq, spec.name, convergent=False)\n"
        "    for seq, spec in enumerate(KINDS['backup'].steps, start=1)\n"
        ")",
    )
    assert production_refusals(tree) == [
        "the production registry serves backup while G1.5-C gaps are open: "
        "worker:resume-failed-dispatch, worker:kill-all-descendants, "
        "worker:kind-claim-starvation, worker:completed-dispatch-step-refused, "
        "worker:provider-idempotency"
    ]


# ------------------------------------------------------------------ files read while written ----


def in_place_refusals(write: Callable[[], object], target: Path) -> list[str]:
    """Why `write()` could let a reader polling for `target` read half of it, or []: it must write
    a hidden temporary file in full and move it onto `target` with one os.replace."""
    replaced: list[tuple[str, bool, str]] = []
    real_replace = os.replace

    def recording(source: str | Path, destination: str | Path) -> None:
        source, destination = Path(source), Path(destination)
        replaced.append((source.name, destination.exists(), source.read_text()))
        real_replace(source, destination)

    with mock.patch.object(os, "replace", recording):
        write()
    refusals = []
    if not replaced:
        refusals.append(f"{target.name} was written in place")
    for name, existed, text in replaced:
        if existed:
            refusals.append(f"{target.name} existed before it was replaced whole")
        if not name.startswith(".") or name.endswith(".json") or name == target.name:
            refusals.append(f"{target.name}'s temporary name {name} is one a reader could match")
        if text != target.read_text():
            refusals.append(f"{target.name} was replaced by a partial copy")
    return refusals


def test_files_a_harness_polls_for_are_written_whole(tmp_path: Path) -> None:
    (tmp_path / "provider").mkdir()
    held_file = tmp_path / "provider" / "held" / "d-1.json"
    assert in_place_refusals(lambda: synthetic._write(held_file, {"pid": 1}), held_file) == []
    ledger_file = tmp_path / "provider" / "ledger" / "d-1.json"
    (tmp_path / "provider" / "ledger").mkdir()
    assert in_place_refusals(lambda: synthetic._write(ledger_file, {"a": 1}), ledger_file) == []
    entry = faults._Armed(SITE, "kill", None, hits=1, control=tmp_path)
    reached = tmp_path / "reached" / SITE
    assert in_place_refusals(lambda: faults._record_reached(entry), reached) == []


def test_the_whole_write_check_sees_a_file_written_in_place(tmp_path: Path) -> None:
    target = tmp_path / "d-1.json"
    assert in_place_refusals(lambda: target.write_text("{}"), target) == [
        "d-1.json was written in place"
    ]


def test_a_registry_refuses_a_kind_whose_plans_are_not_its_steps() -> None:
    plans = _complete_plans("backup")
    with pytest.raises(RegistryError, match="backup's plans are not its catalogue steps"):
        Registry(plans[:-1])
    with pytest.raises(RegistryError, match="backup step 1 has two plans"):
        Registry([*plans, plans[0]])


def test_the_image_qualification_expects_the_runners_own_ending() -> None:
    tree = ast.parse((ROOT / "dev" / "accept_worker_image.py").read_text())
    values = [
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(getattr(t, "id", None) == "NO_KIND_SERVED" for t in node.targets)
    ]
    assert values == [NO_KIND_SERVED]


IMPORTS = """
import worker.boot; worker.boot.enter()
import os; os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.deploy_worker"
import django; django.setup()
import worker.runner, worker.step
import apps.jobs._claim, apps.jobs._runner, apps.jobs._sweep, apps.jobs.runner_selectors
print("imported")
"""


def runner_import_refusals(tree: Path) -> list[str]:
    result = worker_process(program=IMPORTS, cwd=tree)
    if result.returncode != 0 or result.stdout.strip() != "imported":
        return [f"the worker image cannot import its runner: {last_line(result)}"]
    return []


def test_the_worker_image_carries_what_its_runner_imports(tmp_path: Path) -> None:
    image_tree(ROOT, tmp_path, "Dockerfile.worker")
    assert runner_import_refusals(tmp_path) == []


def test_the_import_check_sees_a_worker_image_missing_the_audit_writer(tmp_path: Path) -> None:
    image_tree(ROOT, tmp_path, "Dockerfile.worker")
    (tmp_path / "apps" / "audit" / "services.py").unlink()
    assert runner_import_refusals(tmp_path) == [
        "the worker image cannot import its runner: "
        "ModuleNotFoundError: No module named 'apps.audit.services'"
    ]


# ------------------------------------------------------------- the lease, in two places ----

LEASE_INTERVAL = re.compile(
    r"lease_expires_at\s*=\s*clock_timestamp\(\)\s*\+\s*interval\s*'([^']*)'"
)


def lease_interval_refusals(sql: str) -> list[str]:
    """Why the queue's SQL sets a lease other than worker/lease.py's LEASE_S, or none at all."""
    found = LEASE_INTERVAL.findall(sql)
    if not found:
        return ["apps/jobs/sql.py sets no lease the check can read"]
    expected = f"{LEASE_S:g} seconds"
    return [
        f"apps/jobs/sql.py sets a lease of {interval}, not LEASE_S ({expected})"
        for interval in found
        if interval != expected
    ]


def test_the_runners_lease_is_the_lease_the_queue_sets() -> None:
    sql = (ROOT / "apps" / "jobs" / "sql.py").read_text()
    assert len(LEASE_INTERVAL.findall(sql)) == 2, "the claim and the renewal each set a lease"
    assert lease_interval_refusals(sql) == []


def test_the_lease_check_sees_a_queue_lease_that_moved() -> None:
    sql = (ROOT / "apps" / "jobs" / "sql.py").read_text()
    renew = "RENEW = \"UPDATE jobs_job SET lease_expires_at = clock_timestamp() + interval '120 seconds'"
    assert sql.count(renew) == 1, "the mutation no longer finds the renewal's lease"
    assert lease_interval_refusals(sql.replace(renew, renew.replace("120", "60"))) == [
        "apps/jobs/sql.py sets a lease of 60 seconds, not LEASE_S (120 seconds)"
    ]
    assert lease_interval_refusals("") == ["apps/jobs/sql.py sets no lease the check can read"]


# ----------------------------------------------- the synthetic provider and the shipped image ----

STEP_SETTINGS = {"image": "config.settings.deploy_worker", "other": "config.settings.job_queue"}


def synthetic_step_refusals(tree: Path, tmp: Path, settings: str) -> list[str]:
    """Why `python -m worker.step`, from `tree` under `settings`, served a synthetic request
    (its ledger written, or an answer given), or []. It must refuse, by its own message."""
    found = provider(tmp)
    call = request(found)
    child = step_child(tree, found, call, settings=settings)
    assert child.stdout is not None and child.stderr is not None
    try:
        # stdin stays open until the child ends, as the runner keeps it: end of file is its death.
        child.wait(60)
        out, err = child.stdout.read(), child.stderr.read()
    finally:
        for stream in (child.stdin, child.stdout, child.stderr):
            if stream is not None:
                stream.close()
    refusals = []
    if (found.directory / "ledger").exists() or b'"answer"' in out:
        refusals.append("the step entry point ran the synthetic provider")
    if child.returncode == 0 or SYNTHETIC_REFUSED.encode() not in err:
        refusals.append(f"the step entry point did not refuse by its message: {err[-300:]!r}")
    return refusals


def test_the_shipped_image_carries_no_synthetic_provider_and_its_step_refuses(
    tmp_path: Path,
) -> None:
    tree = tmp_path / "image"
    image_tree(ROOT, tree, "Dockerfile.worker")
    assert (tree / "worker" / "step.py").exists() and (tree / "worker" / "proof.py").exists()
    assert not (tree / "worker" / "providers" / "synthetic.py").exists(), (
        "the worker image carries the synthetic provider"
    )
    assert synthetic_step_refusals(tree, tmp_path, STEP_SETTINGS["image"]) == []


def test_the_step_entry_point_refuses_a_synthetic_request_outside_the_test_profile(
    tmp_path: Path,
) -> None:
    assert synthetic_step_refusals(ROOT, tmp_path, STEP_SETTINGS["other"]) == []


def test_the_step_check_sees_a_step_entry_point_without_its_gate(tmp_path: Path) -> None:
    tree = weakened_worker(tmp_path / "tree", "worker/step.py", "    _require_test_profile()\n", "")
    assert synthetic_step_refusals(tree, tmp_path, STEP_SETTINGS["other"])[:1] == [
        "the step entry point ran the synthetic provider"
    ]


def test_the_replay_read_and_the_ownership_read_share_one_rule() -> None:
    from apps.jobs import sql

    assert set(OWNED) == {"status", "fence", "lease"}
    assert "clock_timestamp()" in OWNED["lease"], "the lease is read by the database's clock"
    for statement in (sql.RUNNER_OWNERSHIP, sql.RUNNER_OPEN_DISPATCH):
        rendered = statement.format(**OWNED)
        assert all(clause in rendered for clause in OWNED.values()), statement

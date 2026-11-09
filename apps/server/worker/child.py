"""One provider call in a child process: `python -m worker.step`, in its own process group.

The child starts in the job's directory with an environment built here from nothing but a path, the
worker's code, the interpreter's settings and the runner's settings module name (which worker/step.py
needs to ask the test-profile gate): never the worker's own environment, and never a credential. A
credential the step is handed is written to `credential` in the job's directory, mode 0600, created
exclusively, for the length of the call, and removed when the call ends, or when its own write fails
half way. `credential` and `step.err` are opened relative to the job directory's descriptor
(`dir_fd`, with O_NOFOLLOW), never by a path re-resolved after the directory was made; the child's
working directory is still given by path (Popen takes no descriptor), so a step that opens files by
name resolves them anew, inside a job root only this user can write (worker/jobdir.py). The request
goes over stdin, which stays open for the call: the child kills its own group when it reads end of
file, so a worker that dies takes its step with it.

**No step is sent its request without its lease, nor without the database's word.** `lost()` is
read when the call is asked (after the step's credential was loaded, which can block) and again
before the spawn: a lease lost by then spawns nothing (`lease_lost`). The child is then spawned,
outside any transaction, and sent nothing: it waits on stdin. The request is handed over by the
runner's handoff (worker/handoff.py): one transaction that locks the job's row, re-reads the
ownership rule after the lock is had, and under the lock does one thing, `write()`: the local lease,
then one non-blocking write of the request. Commit follows at once; the `started` event comes after
it. Any refusal (no row, the lock not had, a clause or the local lease failed, a write that would
block) kills and reaps the unsent child: `not_owned`. A spawn that fails is `not_started`.

If the call cannot be prepared, for any reason (`credential` already there, `step.err` a symbolic
link, a credential that cannot be written), nothing is started and the result says `not_started`,
its credential file removed: the runner holds the job for reconciliation rather than dying.

**A step's stdout is bounded.** At most `READS_PER_POLL` reads of `READ_BYTES` per poll, so the lease
and the deadline are read between batches however fast the child writes, and `ANSWER_LIMIT_BYTES`
in all: past it the answer is absent, the group is killed and the result says `overflow`, which the
runner holds and never settles.

The runner waits for the child and for its lease (`lost()`, worker/lease.py, read on every poll).
When the lease is lost, or the step's catalogue timeout passes, it kills the child's process group
with SIGKILL; when the child ends on its own, it kills the group too, for anything the child left
running in it. The group is always killed **before** the child is reaped: until then the child's pid,
which is the group's id, cannot be reused, so the kill cannot reach a stranger's group.

**What the kill reaches.** The step's process group, and only it. A descendant that calls `setsid()`
or `setpgid()` leaves the group, escapes the kill, and outlives its step until G1.5-C kills every
descendant (a subreaper, a cgroup or a PID namespace; gap `worker:kill-all-descendants`). The
runner does not wait on such an escapee: it reads the child's stdout from its raw descriptor,
without blocking, and closes it when the call ends, so a grandchild that still holds the pipe can
neither hang the runner nor hold its answer back.

A Python child re-enters the worker's accident guard (worker/step.py); a non-Python child a later
step starts has the network layer alone.
"""

from __future__ import annotations

import json
import os
import select
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import worker

from . import mutants

CREDENTIAL_FILE = "credential"
ERRORS_FILE = "step.err"
# What the child's environment may hold: names, and only these.
CHILD_ENVIRONMENT = (
    "PATH",
    "PYTHONPATH",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONSAFEPATH",
    "LANG",
    # The runner's own profile, a module name: worker/step.py asks the test-profile gate with it.
    "DJANGO_SETTINGS_MODULE",
)
WAIT_POLL_S = 0.05
READ_BYTES = 65536
READS_PER_POLL = 4
ANSWER_LIMIT_BYTES = 1 << 20
# After the group is killed, what is left is read in at most this many batches.
DRAIN_BATCHES = 64
# The runner's locked handoff (worker/handoff.py), as run_child sees it: runs `write` under the
# job's row lock, after re-reading the ownership rule, and returns whether the request was written.
HandOff = Callable[[Callable[[], bool]], bool]
# ChildResult.killed: the runner killed the group, or never started the child.
LEASE_LOST = "lease_lost"
TIMEOUT = "timeout"
OVERFLOW = "overflow"
NOT_STARTED = "not_started"
# The database no longer says this claim owns a runnable job: nothing was started.
NOT_OWNED = "not_owned"


@dataclass(frozen=True)
class ChildResult:
    pid: int  # 0 when no child was started
    returncode: int | None
    answer: Mapping[str, Any] | None
    # LEASE_LOST, TIMEOUT or OVERFLOW when the runner killed the group (LEASE_LOST with pid 0 when
    # the lease was lost before the spawn); NOT_STARTED when the call could not be prepared.
    killed: str | None


def code_root() -> Path:
    return Path(worker.__file__).resolve().parents[1]


def child_environment(secret: str | None = None) -> dict[str, str]:
    environment = {
        "PATH": os.environ.get("PATH", os.defpath),
        "PYTHONPATH": str(code_root()),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONSAFEPATH": "1",
        "LANG": "C.UTF-8",
    }
    if "DJANGO_SETTINGS_MODULE" in os.environ:
        environment["DJANGO_SETTINGS_MODULE"] = os.environ["DJANGO_SETTINGS_MODULE"]
    if secret is not None and mutants.on("credential_in_child_environment"):
        environment["KODERA_STEP_CREDENTIAL"] = secret
    return environment


def _open_in(directory: Path, directory_fd: int, name: str, flags: int) -> int:
    if mutants.on("job_files_opened_by_path"):
        return os.open(directory / name, flags, 0o600)
    return os.open(name, flags, 0o600, dir_fd=directory_fd)


def _unlink_in(directory_fd: int, name: str) -> None:
    try:
        os.unlink(name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass


def _write_credential(directory: Path, directory_fd: int, secret: str) -> None:
    """`credential` in the job directory, created exclusively and mode 0600; removed again if its
    own write fails (never when the exclusive create itself fails: that file is not ours)."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    descriptor = _open_in(directory, directory_fd, CREDENTIAL_FILE, flags)
    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(secret)
    except BaseException:
        if not mutants.on("credential_kept_on_a_failed_write"):
            _unlink_in(directory_fd, CREDENTIAL_FILE)
        raise


def _open_errors(directory: Path, directory_fd: int) -> int:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    if mutants.on("step_errors_follow_a_link"):
        flags &= ~os.O_NOFOLLOW
    return _open_in(directory, directory_fd, ERRORS_FILE, flags)


def _open_directory(directory: Path) -> int:
    return os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


class _Exit:
    """Whether the child has exited, read without reaping it (waitid WNOWAIT on Linux, a kqueue
    NOTE_EXIT elsewhere): its pid, the group's id, stays reserved until the runner has killed the
    group and then reaps the child itself."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self._process = process
        self._seen = False
        self._queue: Any = None
        if getattr(os, "waitid", None) is None:
            kqueue = getattr(select, "kqueue")  # noqa: B009 - absent from Linux's typeshed
            self._queue = kqueue()
            event = getattr(select, "kevent")(  # noqa: B009
                process.pid,
                filter=getattr(select, "KQ_FILTER_PROC"),  # noqa: B009
                flags=getattr(select, "KQ_EV_ADD"),  # noqa: B009
                fflags=getattr(select, "KQ_NOTE_EXIT"),  # noqa: B009
            )
            try:
                self._queue.control([event], 0, 0)
            except ProcessLookupError:
                # Already exited: an unreaped child is a zombie, which kqueue no longer watches.
                self._seen = True

    def exited(self) -> bool:
        if mutants.on("group_killed_after_reaping"):
            return self._process.poll() is not None
        if self._seen:
            return True
        waitid = getattr(os, "waitid", None)
        if waitid is not None:
            flags = getattr(os, "WEXITED") | os.WNOHANG | getattr(os, "WNOWAIT")  # noqa: B009
            self._seen = waitid(getattr(os, "P_PID"), self._process.pid, flags) is not None  # noqa: B009
        else:
            self._seen = bool(self._queue.control(None, 1, 0))
        return self._seen

    def close(self) -> None:
        if self._queue is not None:
            self._queue.close()


class _Output:
    """The child's stdout, read from its raw descriptor without ever blocking, and bounded."""

    def __init__(self, descriptor: int) -> None:
        os.set_blocking(descriptor, False)
        self._descriptor = descriptor
        self._buffer = bytearray()
        self.overflowed = False

    def read(self) -> bool:
        """One batch: at most READS_PER_POLL reads, never past ANSWER_LIMIT_BYTES. True when the
        batch ended with more perhaps waiting; False when the pipe was empty, closed or full."""
        reads = 0
        while reads < READS_PER_POLL or mutants.on("output_read_unbounded"):
            reads += 1
            try:
                chunk = os.read(self._descriptor, READ_BYTES)
            except BlockingIOError:
                return False
            if not chunk:
                return False
            self._buffer += chunk
            if len(self._buffer) > ANSWER_LIMIT_BYTES and not mutants.on("output_uncapped"):
                # Past the limit there is no answer to keep: what was read is dropped with it.
                self.overflowed = True
                self._buffer.clear()
                return False
        return True

    def drain(self) -> None:
        """What is left once the group is killed, in at most DRAIN_BATCHES batches."""
        if mutants.on("child_waits_for_end_of_file"):
            os.set_blocking(self._descriptor, True)
        for _ in range(DRAIN_BATCHES):
            if not self.read():
                return

    def close(self) -> None:
        os.close(self._descriptor)

    def answers(self) -> list[Mapping[str, Any]]:
        found: list[Mapping[str, Any]] = []
        for line in bytes(self._buffer).splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and "answer" in value:
                found.append(value)
        return found


def _lease_lost(lost: Callable[[], bool]) -> bool:
    return lost() and not mutants.on("child_started_after_lease_loss")


def run_child(  # noqa: PLR0913 - the call, its place, its secret and its two bounds
    request: Mapping[str, Any],
    *,
    directory: Path,
    secret: str | None,
    lost: Callable[[], bool],
    timeout_s: float,
    started: Callable[[int], None] | None = None,
    directory_fd: int | None = None,
    hand_off: HandOff | None = None,
) -> ChildResult:
    """Run one call to its end, its timeout or the lease's loss; the child is reaped on every path.
    `lost` is read before the spawn, before the send and on every poll: the lease's own clock
    (worker/lease.py), not a thread's word. `directory_fd` is the job directory, open (JobRoot.job);
    without it the directory is opened here, once, with O_NOFOLLOW. `hand_off` is the runner's
    locked handoff (worker/handoff.py): the child, already spawned and waiting, is sent its request
    inside it and nowhere else; a refusal kills and reaps the unsent child: `not_owned`."""
    if _lease_lost(lost):
        # Asked after its credential was loaded, which can block past the lease: nothing starts.
        return ChildResult(0, None, None, LEASE_LOST)
    owned_fd = directory_fd is None
    folder = _open_directory(directory) if directory_fd is None else directory_fd
    try:
        return _run_in(request, directory, folder, secret, lost, timeout_s, started, hand_off)
    finally:
        if owned_fd:
            os.close(folder)


def _run_in(  # noqa: PLR0913
    request: Mapping[str, Any],
    directory: Path,
    folder: int,
    secret: str | None,
    lost: Callable[[], bool],
    timeout_s: float,
    started: Callable[[int], None] | None,
    hand_off: HandOff | None,
) -> ChildResult:
    own_group = not mutants.on("child_shares_worker_group")
    written = False
    try:
        try:
            if secret is not None:
                _write_credential(directory, folder, secret)
                written = True
            errors = _open_errors(directory, folder)
        except Exception:
            # `credential` already there, `step.err` a link, a secret that cannot be written: the
            # call is not made, and any credential this call wrote is already removed.
            if mutants.on("unprepared_call_raises"):
                raise
            return ChildResult(0, None, None, NOT_STARTED)
        # Own step.err through every preparation exit, before handoff.
        try:
            if _lease_lost(lost):
                return ChildResult(0, None, None, LEASE_LOST)
            environment = child_environment(secret)
            if secret is not None and mutants.on("credential_in_live_environment"):
                environment["KODERA_STEP_CREDENTIAL"] = secret
            body = dict(request, credential=CREDENTIAL_FILE if written else None)
            read_end, write_end = os.pipe()
            try:
                # Spawned before the handoff, sent nothing: it waits on stdin (worker/step.py). No
                # spawn, and nothing that can block, ever runs under the handoff's row lock.
                process = subprocess.Popen(  # noqa: S603 - a fixed interpreter and module
                    [sys.executable, "-B", "-m", "worker.step"],
                    cwd=directory,
                    env=environment,
                    stdin=subprocess.PIPE,
                    stdout=write_end,
                    stderr=errors,
                    start_new_session=own_group,
                    close_fds=True,
                )
            except Exception:  # noqa: BLE001 - nothing was spawned: the call could not be prepared
                os.close(read_end)
                return ChildResult(0, None, None, NOT_STARTED)
            except BaseException:
                os.close(read_end)
                raise
            finally:
                os.close(write_end)
        finally:
            os.close(errors)

        def write() -> bool:
            """Under the handoff's lock, after its re-read: the local lease, then the one
            non-blocking write of the request. Nothing else."""
            return not _lease_lost(lost) and _send(process, body)

        try:
            if _lease_lost(lost):
                handed = False
            elif hand_off is None or mutants.on("handoff_skipped"):
                handed = write()
            else:
                handed = hand_off(write)
        except BaseException:
            _abandon(process, own_group)
            os.close(read_end)
            raise
        if not handed:
            # Not owned, the lock not had, the lease ended (by either clock) or the write failed:
            # the child is killed and reaped, never sent its request.
            _abandon(process, own_group)
            os.close(read_end)
            return ChildResult(process.pid, None, None, NOT_OWNED)
        # Committed: the child has its request, and the lock is released. Only now the event, and
        # inside the same guard as the wait: a callback that raises (a broken stderr) still kills
        # and reaps the child and closes its descriptors.
        output: _Output | None = None
        try:
            if started is not None:
                started(process.pid)
            output = _Output(read_end)
            killed = _wait(process, output, lost, timeout_s, own_group)
        except BaseException:
            if not mutants.on("child_kept_when_its_event_fails"):
                _abandon(process, own_group)
            raise
        finally:
            if output is not None:
                output.close()
            else:
                os.close(read_end)
        answers = output.answers()
        with_answer = answers[-1] if answers and killed is None else None
        return ChildResult(process.pid, process.returncode, with_answer, killed)
    finally:
        if written:
            _unlink_in(folder, CREDENTIAL_FILE)


def _send(process: subprocess.Popen[bytes], body: Mapping[str, Any]) -> bool:
    """The request, written whole to the child's stdin without blocking, or False: a send that
    would block, or a child already gone, is no send. It runs under the handoff's lock."""
    assert process.stdin is not None  # noqa: S101 - piped
    data = (json.dumps(body) + "\n").encode("utf-8")
    descriptor = process.stdin.fileno()
    os.set_blocking(descriptor, False)
    try:
        return os.write(descriptor, data) == len(data)
    except (BlockingIOError, BrokenPipeError):
        return False


def _close_stdin(process: subprocess.Popen[bytes]) -> None:
    if process.stdin is not None:
        try:
            process.stdin.close()
        except BrokenPipeError:
            pass


def _abandon(process: subprocess.Popen[bytes], own_group: bool) -> None:
    """The runner failed mid-call: the child goes, its stdin is closed and it is reaped."""
    if own_group:
        _kill_group(process.pid)
    else:
        process.kill()
    _close_stdin(process)
    process.wait()


def _wait(
    process: subprocess.Popen[bytes],
    output: _Output,
    lost: Callable[[], bool],
    timeout_s: float,
    own_group: bool,
) -> str | None:
    deadline = time.monotonic() + timeout_s
    killed = None
    watch = _Exit(process)
    try:
        while not watch.exited():
            # One bounded batch: however fast the child writes, the lease and the deadline are
            # read between batches.
            more = output.read()
            if output.overflowed:
                killed = OVERFLOW
                break
            if lost() and not mutants.on("no_reap_on_lease_loss"):
                killed = LEASE_LOST
                break
            if time.monotonic() > deadline:
                killed = TIMEOUT
                break
            if not more:
                time.sleep(WAIT_POLL_S)
    finally:
        watch.close()
    # Killed or done, the group goes before the child is reaped: anything the child left running
    # in its group goes with it, and the group's id is still the child's own.
    if own_group:
        _kill_group(process.pid)
    elif killed is not None:
        process.kill()
    _close_stdin(process)
    output.drain()
    if killed is None and output.overflowed:
        killed = OVERFLOW
    if not mutants.on("child_left_unreaped"):
        process.wait()
    return killed

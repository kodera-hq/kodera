"""The harness of the worker's execution tests: a real worker process, its control directory, and
what a test reads of the database and of the operating system from outside the worker.

`WorkerProcess` starts tests/worker/worker_entry.py in its own session, so a test can SIGKILL its
whole process group, or SIGSTOP it, as an operator or the kernel would. `Control` is the test's
side of the control directory: the synthetic provider's instructions, its ledger, the calls it
holds, the credential ledger, and the fault points armed from outside. The database is read and
back-dated through the test's own connection, under JOB_QUEUE.md §3.2's list of test writes.
Sockets and environments are read from /proc on Linux, where CI runs; elsewhere through lsof and
ps, as far as those show them.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WAIT_S = 30.0


# ------------------------------------------------------------------------- the process ----


class WorkerProcess:
    def __init__(
        self,
        *,
        database: str,
        control: Path,
        job_root: Path,
        mutant: str | None = None,
        skip_failed_recovery: bool = False,
        completion_mode: str | None = None,
        completion_seq: int = 1,
        renew_every_s: float = 0.3,
    ) -> None:
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"DJANGO_SETTINGS_MODULE", "PYTHONPATH"}
        }
        environment.update(
            {
                "DJANGO_SETTINGS_MODULE": "config.settings.test",
                "PYTHONPATH": os.pathsep.join([str(ROOT), str(HERE)]),
                "PYTHONDONTWRITEBYTECODE": "1",
                "WORKER_TEST_DATABASE": database,
                "WORKER_TEST_JOB_ROOT": str(job_root),
                "WORKER_TEST_RENEW_S": str(renew_every_s),
                "KODERA_FAULT_CONTROL": str(control),
            }
        )
        if mutant:
            environment["WORKER_TEST_MUTANT"] = mutant
        if skip_failed_recovery:
            environment["WORKER_TEST_SKIP_FAILED_RECOVERY"] = "1"
        if completion_mode is not None:
            environment["WORKER_TEST_COMPLETION_MODE"] = completion_mode
            environment["WORKER_TEST_COMPLETION_SEQ"] = str(completion_seq)
        self._events: list[dict[str, Any]] = []
        self._changed = threading.Condition()
        self._done = False
        self._stderr: list[str] = []
        self.process = subprocess.Popen(  # noqa: S603 - a fixed interpreter and script
            [sys.executable, "-B", str(HERE / "worker_entry.py")],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        self.pid = self.process.pid
        self.job_root = job_root
        self._readers = [
            threading.Thread(target=self._read, daemon=True),
            threading.Thread(target=self._drain, daemon=True),
        ]
        for reader in self._readers:
            reader.start()
        try:
            self.started = self.wait_for(lambda event: event["event"] == "started")
        except BaseException:
            self.kill()
            raise

    def _read(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            with contextlib.suppress(ValueError), self._changed:
                self._events.append(json.loads(line))
                self._changed.notify_all()
        with self._changed:
            self._done = True
            self._changed.notify_all()

    def _drain(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self._stderr.append(line)

    def events(self, name: str | None = None) -> list[dict[str, Any]]:
        with self._changed:
            return [e for e in self._events if name is None or e["event"] == name]

    def wait_for(
        self, predicate: Callable[[dict[str, Any]], bool], timeout: float = WAIT_S
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self._changed:
            while True:
                for event in self._events:
                    if predicate(event):
                        return event
                left = deadline - time.monotonic()
                if left <= 0 or self._done:
                    break
                self._changed.wait(min(left, 0.5))
        raise AssertionError(
            f"the worker never emitted the awaited event; events: {self._events[-8:]}; "
            f"stderr: {''.join(self._stderr[-20:])}"
        )

    def ended(self, job_id: object, timeout: float = WAIT_S) -> str:
        event = self.wait_for(
            lambda e: e["event"] == "ended" and e["job_id"] == str(job_id), timeout
        )
        return str(event["ending"])

    def job_directory(self, job_id: object) -> Path:
        """Where this worker's runner keeps `job_id`'s directory (worker/jobdir.py)."""
        return self.job_root / str(self.started["runner_id"]) / str(job_id)

    def signal_group(self, number: int) -> None:
        # PermissionError: macOS answers EPERM for a group whose one member is a zombie.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self.pid, number)

    def kill(self) -> None:
        """SIGKILL the worker's whole process group, reap the worker and close its pipes."""
        try:
            self.signal_group(signal.SIGKILL)
        finally:
            try:
                self.process.wait(WAIT_S)
            finally:
                self._close()

    def stop(self) -> None:
        if self.process.poll() is None:
            self.signal_group(signal.SIGCONT)
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(WAIT_S)
            except subprocess.TimeoutExpired:
                self.kill()
                return
        self._close()

    def _close(self) -> None:
        """Join the readers, which end at the pipes' end of file, then close both pipes: a pipe
        left open warns when it is collected, in whichever later test that happens."""
        for reader in self._readers:
            reader.join(WAIT_S)
        for stream in (self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


def alive(pid: int) -> bool:
    """Whether `pid` names a process that has not been reaped (a zombie counts as gone)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    status = Path(f"/proc/{pid}/stat")
    if status.exists():
        with contextlib.suppress(OSError):
            return status.read_text().split(") ", 1)[1][:1] != "Z"
    found = subprocess.run(  # noqa: S603 - a fixed program
        ["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False
    )
    return bool(found.stdout.strip()) and not found.stdout.strip().startswith("Z")


def reaped(pid: int) -> bool:
    """Whether `pid` is gone for good: not running, and not a zombie its parent has yet to wait for.

    For use while the parent that should have reaped `pid` is alive, where a zombie means it did not.
    A child of this very process (run_child runs in the test's own) is asked with waitpid(WNOHANG),
    which reaps a zombie it finds: the answer is then already False, so nothing is lost. Any other
    pid is read from /proc or ps without reaping it (`alive()`'s reading, zombie included).
    """
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass  # not this process's child, or already reaped by it
    else:
        return False  # this process's child, running (0) or a zombie nobody had reaped
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def wait_gone(pid: int, timeout: float = WAIT_S) -> None:
    deadline = time.monotonic() + timeout
    while alive(pid):
        if time.monotonic() > deadline:
            raise AssertionError(f"process {pid} is still running")
        time.sleep(0.05)


# ------------------------------------------------------------------ sockets, environment ----


def listening_sockets(pid: int) -> list[str]:
    """Every socket `pid` holds that listens: TCP in LISTEN, or a UNIX socket accepting."""
    proc = Path(f"/proc/{pid}")
    if not proc.exists():
        found = subprocess.run(  # noqa: S603 - a fixed program
            [
                shutil.which("lsof") or "/usr/sbin/lsof",
                "-nP",
                "-a",
                "-p",
                str(pid),
                "-iTCP",
                "-sTCP:LISTEN",
                "-Fn",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return [line for line in found.stdout.splitlines() if line.startswith("n")]
    inodes = set()
    for descriptor in (proc / "fd").iterdir():
        with contextlib.suppress(OSError):
            target = os.readlink(descriptor)
            if target.startswith("socket:["):
                inodes.add(target[len("socket:[") : -1])
    listening = []
    for table in ("tcp", "tcp6"):
        path = proc / "net" / table
        if path.exists():
            for row in path.read_text().splitlines()[1:]:
                columns = row.split()
                if columns[3] == "0A" and columns[9] in inodes:
                    listening.append(f"{table} {columns[1]}")
    unix = proc / "net" / "unix"
    if unix.exists():
        for row in unix.read_text().splitlines()[1:]:
            columns = row.split()
            # Flags 00010000 is __SO_ACCEPTCON: a socket that listens.
            if int(columns[3], 16) & 0x10000 and columns[6] in inodes:
                listening.append(f"unix {columns[7] if len(columns) > 7 else '@'}")
    return listening


def environment_of(pid: int) -> str:
    """The process's environment as the system shows it, NUL- or space-separated."""
    path = Path(f"/proc/{pid}/environ")
    if path.exists():
        return path.read_bytes().decode("utf-8", "replace")
    found = subprocess.run(  # noqa: S603 - a fixed program
        ["/bin/ps", "eww", "-o", "command=", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    return found.stdout


def environment_names(pid: int) -> set[str] | None:
    """The names in the process's environment, when /proc shows them exactly; else None."""
    path = Path(f"/proc/{pid}/environ")
    if not path.exists():
        return None
    return {item.split("=", 1)[0] for item in path.read_bytes().decode().split("\0") if item}


# ----------------------------------------------------------------------- the control ----


class Control:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.provider = path / "provider"

    def plan(self, **steps: list[str]) -> None:
        self.provider.mkdir(exist_ok=True)
        (self.provider / "plan.json").write_text(json.dumps(steps), encoding="utf-8")

    def held(self, timeout: float = WAIT_S) -> tuple[str, int]:
        """The first call the provider holds: its name and the child's pid."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = sorted((self.provider / "held").glob("*.json"))
            if found:
                name = found[0].stem
                return name, int(json.loads(found[0].read_text())["pid"])
            time.sleep(0.05)
        raise AssertionError("the synthetic provider never held a call")

    def release(self, name: str) -> None:
        (self.provider / "release").mkdir(exist_ok=True)
        (self.provider / "release" / name).write_text("", encoding="utf-8")

    def ledger(self) -> list[dict[str, Any]]:
        return [
            json.loads(path.read_text())
            for path in sorted((self.provider / "ledger").glob("*.json"))
        ]

    def arm(self, point: str, mode: str) -> None:
        (self.path / "armed.json").write_text(json.dumps([{"point": point, "mode": mode}]))

    def reached(self, point: str) -> bool:
        return (self.path / "reached" / point).exists()


@contextlib.contextmanager
def short_directory(label: str) -> Iterator[Path]:
    """A directory with a short path, for job roots whose UNIX socket paths stay short too."""
    with tempfile.TemporaryDirectory(prefix=f"kw-{label}-") as name:
        yield Path(name)


# ---------------------------------------------------------------------- the database ----


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def organisation() -> uuid.UUID:
    """A real `orgs.Organisation` in `prospect`, which a job's foreign key needs."""
    from django.apps import apps
    from django.db import transaction

    slug = "w" + uuid.uuid4().hex[:12]
    with transaction.atomic():
        created = apps.get_model("orgs", "Organisation").objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.customer.test/realms/{slug}",
            name="Synthetic organisation",
            state="prospect",
        )
        apps.get_model("orgs", "SlugReservation").objects.create(
            namespace="organisation",
            slug=slug,
            organisation=created,
            state="provisional",
            protected_at=None,
        )
    found: uuid.UUID = created.pk
    return found


def enqueue(kind: str = "backup", organisation_id: uuid.UUID | None = None) -> uuid.UUID:
    from apps.jobs.kinds import REALM_KINDS
    from apps.jobs.services import JobRequest, enqueue_job

    request = JobRequest(
        organisation_id=organisation_id or organisation(),
        tenant_id=None if kind in REALM_KINDS else uuid.uuid4(),
        kind=kind,
        idempotency_key=digest(uuid.uuid4().hex),
        desired_spec_hash=digest("desired"),
        actor_type="system",
        actor_id=None,
    )
    return enqueue_job(request=request, apply_desired_state=lambda: None).job_id


def job(job_id: uuid.UUID) -> dict[str, Any]:
    from apps.jobs.models import Job

    return dict(Job.objects.filter(pk=job_id).values()[0])


def steps(job_id: uuid.UUID) -> list[str]:
    from apps.jobs.models import JobStep

    return list(
        JobStep.objects.filter(job_id=job_id).order_by("seq").values_list("status", flat=True)
    )


def dispatches(job_id: uuid.UUID) -> list[dict[str, Any]]:
    from apps.jobs.models import JobDispatch, JobStep

    seqs = dict(JobStep.objects.filter(job_id=job_id).values_list("id", "seq"))
    # The database's clock_timestamp(), then the id: a UUIDv7 orders only within the process that
    # made it, and these rows are made by the worker's process and the test's.
    rows = JobDispatch.objects.filter(job_id=job_id).order_by("dispatched_at", "id").values()
    return [{**row, "seq": seqs[row["step_id"]]} for row in rows]


def open_reservations(job_id: uuid.UUID) -> int:
    from apps.jobs.models import JobLockReservation

    return JobLockReservation.objects.filter(job_id=job_id, ended_at__isnull=True).count()


def audit_actions(job_id: uuid.UUID) -> list[str]:
    from apps.audit.models import AuditEvent

    return list(
        AuditEvent.objects.filter(job_id=job_id)
        .order_by("occurred_at", "id")  # clock_timestamp(): ids are UUIDv7 from two processes
        .values_list("action", flat=True)
    )


def expire_lease(job_id: uuid.UUID) -> None:
    """Back-date the lease (JOB_QUEUE.md §3.2): PostgreSQL's clock cannot be moved."""
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE jobs_job SET lease_expires_at = clock_timestamp() - interval '1 second' "
            "WHERE id = %s AND lease_expires_at IS NOT NULL",
            [job_id],
        )
        assert cursor.rowcount == 1, "the job has no lease to expire"


def advisory_locks(backend_pid: int) -> int:
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = %s", [backend_pid]
        )
        found: int = cursor.fetchone()[0]
        return found


def advisory_locks_once_exited(backend_pid: int, *, within: float = 10.0) -> int:
    """The advisory locks a killed worker's backend holds once that backend has exited.

    Killing the worker closes its connection at once, but PostgreSQL ends the backend, and releases
    its session locks, a moment later; counting at once races that exit. This waits for the
    backend to leave pg_stat_activity, failing after `within` seconds, then counts."""
    from django.db import connection

    deadline = time.monotonic() + within
    while True:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_stat_activity WHERE pid = %s", [backend_pid])
            alive = cursor.fetchone() is not None
        if not alive:
            return advisory_locks(backend_pid)
        assert time.monotonic() < deadline, f"backend {backend_pid} outlived its killed worker"
        time.sleep(0.05)


def database_name() -> str:
    from django.db import connection

    name = str(connection.settings_dict["NAME"])
    assert name.startswith("test_"), f"the worker harness refuses database {name!r}"
    return name

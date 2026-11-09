"""The job root and the per-job directory: the only place a step's files, its credential among them,
are written.

The job root is trusted only if it is the runner's own: opened with O_NOFOLLOW and O_DIRECTORY, so
neither a symbolic link nor a file stands in for it, and held to a directory owned by this process's
user with mode 0700. Anything else refuses to start (`JobRootRefused`): the default root sits in the
shared temporary directory, where another user could have made it first. A root the runner creates,
it creates 0700 itself.

Each runner works in its own subdirectory, `<root>/<runner_id>`, held to the same rule and locked
with `flock` for as long as the runner lives, and one directory per claimed job inside it, mode 0700,
removed when the job ends on every path, failure and a lost lease included. A worker that was killed
cannot remove its own, so a starting runner sweeps first: what it left in its own subdirectory, and
the subdirectory of every other runner whose lock nobody holds, which only a dead runner leaves. A
live runner's subdirectory, its lock held, is never touched. Every removal goes through the open
directory's descriptor (`dir_fd`), never a path that could be swapped under it: no directory
outlives its job by more than one restart.

**One root lock serialises the root.** Making and locking a runner's subdirectory, and sweeping
other runners' subdirectories, both hold an exclusive `flock` on the root itself. A sweep locks a
dead runner's directory and then removes it by name; without the root lock, another sweep could
remove that directory meanwhile and a restarted runner make and lock a new one under the same name,
which the first sweep would then remove, live. Under the root lock no subdirectory is made while a
sweep runs, so the name a sweep locked is the name it removes. A starting runner waits
`ROOT_LOCK_WAIT_S` for the root, then refuses to start; a sweep that cannot get it in time leaves
other runners' directories to the sweep that holds it.

A job's directory is handed out open (`JobDirectory.fd`): the step's files are opened relative to it
(worker/child.py), and only the child's working directory is given by path.
"""

from __future__ import annotations

import fcntl
import os
import re
import shutil
import stat
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from . import mutants

RUNNER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
MODE = 0o700
ROOT_LOCK_WAIT_S = 5.0
ROOT_LOCK_POLL_S = 0.05


@dataclass(frozen=True)
class JobDirectory:
    """A job's directory: its path, for the child's working directory, and its open descriptor."""

    path: Path
    fd: int


class JobRootRefused(RuntimeError):  # noqa: N818 - a refusal, read by its name
    """The job root, or a runner's directory in it, is not the runner's own."""


def _open_owned(name: str, label: str, *, dir_fd: int | None = None) -> int:
    """Open (creating it 0700 if absent) a directory this user owns, mode 0700, never a link."""
    created = False
    with suppress(FileExistsError):
        os.mkdir(name, MODE, dir_fd=dir_fd)
        created = True
    unchecked = mutants.on("job_root_unchecked")
    flags = os.O_RDONLY | os.O_DIRECTORY | (0 if unchecked else os.O_NOFOLLOW)
    try:
        descriptor = os.open(name, flags, dir_fd=dir_fd)
    except OSError:
        raise JobRootRefused(f"{label} is a symbolic link or not a directory") from None
    if created:
        # mkdir's mode passes through the umask; a root this runner made is 0700 exactly.
        os.fchmod(descriptor, MODE)
    found = os.fstat(descriptor)
    refusal = None
    if not stat.S_ISDIR(found.st_mode):
        refusal = f"{label} is not a directory"
    elif found.st_uid != os.getuid():
        refusal = f"{label} is owned by uid {found.st_uid}, not by the runner's"
    elif stat.S_IMODE(found.st_mode) != MODE:
        refusal = f"{label} is mode {stat.S_IMODE(found.st_mode):o}, not 700"
    if refusal is not None and not unchecked:
        os.close(descriptor)
        raise JobRootRefused(refusal)
    return descriptor


def _lock(descriptor: int) -> bool:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def _remove(name: str, dir_fd: int) -> None:
    """Remove `name` under `dir_fd`: a directory through descriptors, anything else unlinked."""
    if stat.S_ISDIR(os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode):
        shutil.rmtree(name, dir_fd=dir_fd)
    else:
        os.unlink(name, dir_fd=dir_fd)


def _wait_for_lock(descriptor: int, wait_s: float) -> bool:
    deadline = time.monotonic() + wait_s
    while not _lock(descriptor):
        if time.monotonic() >= deadline:
            return False
        time.sleep(ROOT_LOCK_POLL_S)
    return True


class JobRoot:
    """The runner's own directory under the job root, locked while the runner lives."""

    def __init__(self, root: Path, runner_id: str) -> None:
        if not RUNNER_ID.fullmatch(runner_id):
            raise JobRootRefused(f"{runner_id!r} cannot name a runner's directory")
        root.parent.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.runner_id = runner_id
        self.path = root / runner_id
        self._root = _open_owned(str(root), "the job root")
        try:
            with self._root_lock() as held:
                if not held:
                    raise JobRootRefused("the job root is busy: another runner holds it")
                self._own = _open_owned(runner_id, "the runner's job directory", dir_fd=self._root)
                if not _lock(self._own):
                    os.close(self._own)
                    raise JobRootRefused(f"runner {runner_id} is already running on this job root")
        except BaseException:
            os.close(self._root)
            raise

    @contextmanager
    def _root_lock(self) -> Iterator[bool]:
        """The root's own lock, for making a runner's directory or sweeping others'; whether it
        was had within ROOT_LOCK_WAIT_S. Released when the block ends."""
        if mutants.on("sweep_unserialised"):
            yield True
            return
        held = _wait_for_lock(self._root, ROOT_LOCK_WAIT_S)
        try:
            yield held
        finally:
            if held:
                fcntl.flock(self._root, fcntl.LOCK_UN)

    def close(self) -> None:
        for descriptor in (self._own, self._root):
            with suppress(OSError):
                os.close(descriptor)

    def sweep(self) -> list[str]:
        """Remove what a killed run left: in this runner's directory, and every other runner's
        directory nobody holds. The paths removed, relative to the root, sorted."""
        if mutants.on("startup_sweep_skipped"):
            return []
        removed = []
        for name in sorted(os.listdir(self._own)):
            _remove(name, self._own)
            removed.append(f"{self.runner_id}/{name}")
        with self._root_lock() as held:
            if held:
                for name in sorted(os.listdir(self._root)):
                    if name != self.runner_id:
                        removed += self._sweep_other(name)
        return sorted(removed)

    def _sweep_other(self, name: str) -> list[str]:
        try:
            found = os.stat(name, dir_fd=self._root, follow_symlinks=False)
            if not stat.S_ISDIR(found.st_mode):
                os.unlink(name, dir_fd=self._root)
                return [name]
            descriptor = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self._root
            )
        except FileNotFoundError:
            return []  # gone meanwhile
        except OSError:
            return []
        try:
            if not _lock(descriptor) and not mutants.on("sweep_ignores_live_runners"):
                return []  # a live runner's: its lock is held
            left = [f"{name}/{entry}" for entry in sorted(os.listdir(descriptor))]
            with suppress(FileNotFoundError):
                shutil.rmtree(name, dir_fd=self._root)
            return left or [name]
        finally:
            os.close(descriptor)

    @contextmanager
    def job(self, job_id: UUID) -> Iterator[JobDirectory]:
        """The job's own directory, new and empty, and open; removed when the block ends however
        it ends."""
        name = str(job_id)
        with suppress(FileNotFoundError):
            # A reclaim in this same process: what an earlier claim left is not this claim's.
            _remove(name, self._own)
        os.mkdir(name, MODE, dir_fd=self._own)
        try:
            descriptor = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self._own
            )
            try:
                yield JobDirectory(self.path / name, descriptor)
            finally:
                os.close(descriptor)
        finally:
            if not mutants.on("job_directory_kept"):
                with suppress(OSError):
                    _remove(name, self._own)

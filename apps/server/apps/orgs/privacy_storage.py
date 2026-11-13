"""Worker-only private immutable volume, with atomic expiry binding and no-follow traversal."""

from __future__ import annotations

import fcntl
import os
import re
import secrets
import stat
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from .privacy_archives import ArchiveRefusalError, require

MAX_OBJECT_BYTES = 96 * 1024 * 1024
PART = re.compile(r"[a-z0-9][a-z0-9_.-]{0,180}\Z")


class MissingPrivateObjectError(ArchiveRefusalError):
    def __init__(self) -> None:
        super().__init__("private object absent", 404)


@dataclass(frozen=True)
class InventoryPage:
    keys: tuple[str, ...]
    complete: bool


@dataclass(frozen=True)
class CollectionPage:
    inspected: int
    removed: int
    inventory_complete: bool


class PrivateVolume:
    """Explicit service-owned volume; no path, key, credential or bucket fallback."""

    def __init__(self, root: str | Path, *, clock: Callable[[], float] = time.time) -> None:
        self.root = Path(root)
        require(self.root.is_absolute(), "private root must be absolute")
        self.clock = clock
        descriptor = self._root_fd()
        os.close(descriptor)

    def _root_fd(self) -> int:
        # Validate all ancestors without requiring ownership of system mount points.
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in self.root.parts[1:]:
                following = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor
                )
                os.close(descriptor)
                descriptor = following
            self._private(descriptor, directory=True)
            return descriptor
        except OSError:
            os.close(descriptor)
            raise ArchiveRefusalError("private root unavailable") from None
        except BaseException:
            os.close(descriptor)
            raise

    @staticmethod
    def _private(descriptor: int, *, directory: bool) -> None:
        info = os.fstat(descriptor)
        require(
            info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) & 0o077 == 0
            and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and (directory or info.st_nlink == 1),
            "private object ownership or mode",
        )

    @staticmethod
    def _parts(key: str) -> list[str]:
        require(isinstance(key, str) and len(key) <= 512, "private object key")
        parts = key.split("/")
        require(
            3 <= len(parts) <= 6
            and parts[0] == "privacy"
            and all(PART.fullmatch(part) is not None and part not in {".", ".."} for part in parts),
            "private object key",
        )
        return parts

    @contextmanager
    def _parent(self, key: str, *, create: bool = False) -> Iterator[tuple[int, str]]:
        parts = self._parts(key)
        descriptor = None
        request_descriptor = None
        try:
            descriptor = self._root_fd()
            for index, part in enumerate(parts[:-1]):
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=descriptor)
                        os.fsync(descriptor)
                    except FileExistsError:
                        pass
                following = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor
                )
                try:
                    self._private(following, directory=True)
                except BaseException:
                    os.close(following)
                    raise
                os.close(descriptor)
                descriptor = following
                if index == 1:
                    # Every nested object and request-wide inventory shares this lock.
                    # Keep a duplicate alive while traversal advances into child directories.
                    request_descriptor = os.dup(descriptor)
                    fcntl.flock(request_descriptor, fcntl.LOCK_EX)
            yield descriptor, parts[-1]
        except FileNotFoundError:
            raise MissingPrivateObjectError() from None
        except OSError:
            raise ArchiveRefusalError("private object unavailable") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if request_descriptor is not None:
                os.close(request_descriptor)

    def _read(
        self, parent: int, name: str, limit: int, *, expired: bool = False
    ) -> tuple[int, bytes]:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            self._private(descriptor, directory=False)
            info = os.fstat(descriptor)
            require(8 <= info.st_size <= limit + 8, "private object size")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                deadline = int.from_bytes(stream.read(8), "big")
                require(deadline > 0, "private object expiry binding")
                require(expired or self.clock() < deadline, "private object expired", 409)
                raw = stream.read(limit + 1)
            require(len(raw) == info.st_size - 8 and len(raw) <= limit, "private object size")
            return deadline, raw
        finally:
            os.close(descriptor)

    def read(self, key: str, limit: int) -> bytes:
        require(type(limit) is int and 0 <= limit <= MAX_OBJECT_BYTES, "private read bound")
        with self._parent(key) as (parent, name):
            return self._read(parent, name, limit)[1]

    def put_immutable(self, key: str, content: bytes, expires_at: int) -> None:
        require(type(content) is bytes and len(content) <= MAX_OBJECT_BYTES, "private object size")
        require(
            type(expires_at) is int and self.clock() < expires_at <= self.clock() + 86400,
            "private object expiry bound",
        )
        with self._parent(key, create=True) as (parent, name):
            require(self.clock() < expires_at, "private object expired", 409)
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                require(
                    self._read(parent, name, MAX_OBJECT_BYTES) == (expires_at, content),
                    "private immutable replacement",
                    409,
                )
                return
            temporary = "pending-" + secrets.token_hex(16)
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=parent,
            )
            try:
                with os.fdopen(descriptor, "wb", closefd=False) as stream:
                    stream.write(expires_at.to_bytes(8, "big"))
                    stream.write(content)
                    stream.flush()
                    os.fsync(descriptor)
                # All service writers hold the request directory's lock. Rename publishes
                # one complete inode, avoiding a hard-link/unlink interruption window.
                os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                temporary = ""
            finally:
                os.close(descriptor)
                if temporary:
                    os.unlink(temporary, dir_fd=parent)
                os.fsync(parent)

    def collect(self, key: str) -> bool:
        """Delete exactly one expired object. A caller supplies its durable inventory key."""
        with self._parent(key) as (parent, name):
            deadline = self._deadline(parent, name)
            require(self.clock() >= deadline, "private object still live", 409)
            os.unlink(name, dir_fd=parent)
            os.fsync(parent)
        return True

    def _deadline(self, parent: int, name: str) -> int:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if re.fullmatch(r"pending-[0-9a-f]{32}", name) and info.st_size < 8:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                self._private(descriptor, directory=False)
                # A process can die before writing the expiry header. Never infer an earlier
                # deadline than the maximum admitted object lifetime after its staging write.
                return int(os.fstat(descriptor).st_mtime) + 86401
            finally:
                os.close(descriptor)
        return self._read(parent, name, MAX_OBJECT_BYTES, expired=True)[0]

    def inventory(self, request_id: str) -> tuple[str, ...]:
        """Bounded exact-request inventory for expiry/erasure workers, including orphan bodies."""
        page = self.inventory_page(request_id, 25000)
        require(page.complete, "private inventory bound")
        return page.keys

    def inventory_page(self, request_id: str, limit: int = 1000) -> InventoryPage:
        """A bounded traversal page; incomplete pages never certify an erasure inventory."""
        require(type(limit) is int and 1 <= limit <= 25000, "private inventory page bound")
        try:
            require(str(UUID(request_id)) == request_id, "private request inventory binding")
        except (ValueError, TypeError, AttributeError):
            raise ArchiveRefusalError("private request inventory binding") from None
        results: list[str] = []
        truncated = False

        def visit(parent: int, prefix: str, depth: int) -> None:
            nonlocal truncated
            require(depth <= 6, "private inventory depth")
            with os.scandir(parent) as entries:
                for entry in entries:
                    if truncated:
                        return
                    require(
                        PART.fullmatch(entry.name) is not None and not entry.is_symlink(),
                        "private inventory entry",
                    )
                    key = prefix + "/" + entry.name
                    descriptor = os.open(
                        entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent
                    )
                    try:
                        directory = stat.S_ISDIR(os.fstat(descriptor).st_mode)
                        self._private(descriptor, directory=directory)
                        if directory:
                            visit(descriptor, key, depth + 1)
                        else:
                            if len(results) == limit:
                                truncated = True
                                return
                            results.append(key)
                    finally:
                        os.close(descriptor)

        # _parent opens the exact request directory; a dummy final name is never read.
        with self._parent(f"privacy/{request_id}/inventory.bin") as (parent, _):
            visit(parent, f"privacy/{request_id}", 2)
        return InventoryPage(tuple(sorted(results)), not truncated)

    def collect_expired_page(self, request_id: str, limit: int = 1000) -> CollectionPage:
        """Progress past an oversized orphan set; callers repeat and verify final absence.

        Live objects remain held. This result never declares the whole request erased merely
        because one traversal page was removed. A cutoff worker independently proves absence.
        """
        page = self.inventory_page(request_id, limit)
        removed = 0
        for key in page.keys:
            with self._parent(key) as (parent, name):
                if self.clock() >= self._deadline(parent, name):
                    os.unlink(name, dir_fd=parent)
                    os.fsync(parent)
                    removed += 1
        return CollectionPage(len(page.keys), removed, page.complete)

    def collect_request(self, request_id: str) -> int:
        """Collect expired objects only; a live member aborts before any removal."""
        keys = self.inventory(request_id)
        for key in keys:
            with self._parent(key) as (parent, name):
                deadline = self._deadline(parent, name)
                require(self.clock() >= deadline, "private object still live", 409)
        return sum(self.collect(key) for key in keys)

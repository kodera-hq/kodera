"""Offline operator FinOps resource attribution & provider invoice reconciliation command.

Respects the open-core boundary (`GOVERNANCE.md` §1): loads `ee.billing.finops` dynamically via
`importlib` with zero static `ee` imports inside `apps/server/`, and refuses execution outside
`KODERA_EDITION=enterprise`.
"""

from __future__ import annotations

import contextlib
import errno
import importlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError, CommandParser

from core.api.edition import _ensure_ee_importable

MAX_FINOPS_INPUT_BYTES = 4 * 1024 * 1024
_DARWIN_ROOT_ALIASES: dict[str, tuple[str, ...]] = {
    "var": ("private", "var"),
    "tmp": ("private", "tmp"),
    "etc": ("private", "etc"),
}


def _open_regular_file_nofollow_fd(path: Path) -> int:
    raw_str = os.fspath(path)
    if not raw_str or any(part == ".." for part in Path(raw_str).parts):
        raise CommandError("FinOps input path refuses parent-directory traversal")
    abs_path = Path(raw_str) if os.path.isabs(raw_str) else Path(os.getcwd()) / raw_str
    parts = [part for part in str(abs_path).split(os.sep) if part and part != "."]
    if not parts:
        raise CommandError("FinOps input path must be a regular file")

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    dir_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | nofollow
    try:
        dir_fd = os.open(os.sep, dir_flags)
    except OSError:
        raise CommandError("FinOps input root directory could not be opened") from None

    try:
        if sys.platform == "darwin" and parts[0] in _DARWIN_ROOT_ALIASES:
            alias_target = _DARWIN_ROOT_ALIASES[parts[0]]
            try:
                link_val = os.readlink(parts[0], dir_fd=dir_fd).rstrip("/")
            except OSError:
                link_val = ""
            if link_val == "/".join(alias_target):
                parts = [*alias_target, *parts[1:]]

        for comp in parts[:-1]:
            try:
                next_fd = os.open(comp, dir_flags, dir_fd=dir_fd)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
                    raise CommandError("FinOps input path refuses symbolic links") from None
                with contextlib.suppress(OSError):
                    if stat.S_ISLNK(os.stat(comp, dir_fd=dir_fd, follow_symlinks=False).st_mode):
                        raise CommandError("FinOps input path refuses symbolic links") from None
                raise CommandError("FinOps input file does not exist or is unreadable") from None
            os.close(dir_fd)
            dir_fd = next_fd

        leaf = parts[-1]
        try:
            file_fd = os.open(leaf, os.O_RDONLY | nofollow, dir_fd=dir_fd)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
                raise CommandError("FinOps input path refuses symbolic links") from None
            with contextlib.suppress(OSError):
                if stat.S_ISLNK(os.stat(leaf, dir_fd=dir_fd, follow_symlinks=False).st_mode):
                    raise CommandError("FinOps input path refuses symbolic links") from None
            raise CommandError("FinOps input file does not exist or is unreadable") from None
        return file_fd
    finally:
        with contextlib.suppress(OSError):
            os.close(dir_fd)


def _read_regular_json_nofollow(path: Path) -> dict[str, Any]:
    fd = _open_regular_file_nofollow_fd(path)
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise CommandError("FinOps input path must be a regular file")
        if fst.st_size > MAX_FINOPS_INPUT_BYTES:
            raise CommandError("FinOps input file exceeds 4 MiB safety limit")
        chunks: list[bytes] = []
        remaining = MAX_FINOPS_INPUT_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw_bytes = b"".join(chunks)
        if len(raw_bytes) > MAX_FINOPS_INPUT_BYTES:
            raise CommandError("FinOps input file exceeds 4 MiB safety limit")
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)

    def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in pairs:
            if key in out:
                raise ValueError("duplicate JSON key")
            out[key] = value
        return out

    def _reject_constant(_token: str) -> Any:
        raise ValueError("invalid JSON constant")

    try:
        parsed = json.loads(
            raw_bytes.decode("utf-8"),
            object_pairs_hook=_unique_pairs,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, ValueError):
        raise CommandError("FinOps input file is not valid strict JSON") from None
    if not isinstance(parsed, dict):
        raise CommandError("FinOps input file must contain a top-level JSON object")
    return parsed


class Command(BaseCommand):
    help = "Reconcile per-tenant FinOps infrastructure attribution against a provider invoice."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--input",
            type=Path,
            required=True,
            help="Path to sanitized FinOps metering and provider invoice JSON file.",
        )
        parser.add_argument(
            "--fail-below-margin-floor",
            action="store_true",
            help="Exit nonzero after emitting report when any tenant falls below 4400 bps.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        edition_env = str(
            os.environ.get("KODERA_EDITION") or getattr(settings, "KODERA_EDITION", "community")
        )
        _ensure_ee_importable()
        try:
            ee_billing = importlib.import_module("ee.billing")
            ee_finops = importlib.import_module("ee.billing.finops")
        except ModuleNotFoundError:
            raise CommandError(
                "Enterprise FinOps module is unavailable in Community builds"
            ) from None

        try:
            ee_billing.require_enterprise_edition({"KODERA_EDITION": edition_env})
        except PermissionError:
            raise CommandError(
                "FinOps attribution reconciliation requires KODERA_EDITION=enterprise"
            ) from None

        payload = _read_regular_json_nofollow(options["input"])
        try:
            report = ee_finops.reconcile_finops_payload(payload)
        except (ValueError, TypeError) as err:
            code = getattr(err, "code", type(err).__name__)
            raise CommandError(f"FinOps attribution refused: {code}") from None

        report_dict = report.to_dict()
        self.stdout.write(json.dumps(report_dict, sort_keys=True))
        if options.get("fail_below_margin_floor") and report.flagged_organisation_ids:
            raise CommandError(
                f"FinOps gross-margin floor review required: flagged={len(report.flagged_organisation_ids)}"
            )

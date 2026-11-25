#!/usr/bin/env python3
"""Deterministically partition `apps/server/tests` across N parallel CI shards.

Directories carrying whole-directory pytest session invariants (`tests/first_slice`
and `tests/job_queue`) stay intact as single shard units so their `conftest.py`
population checks see every scenario/acceptance row in one run. All remaining
`test_*.py` / `*_test.py` modules are greedily balanced by file byte size in a
deterministic order.

    uv run python scripts/ci/select_pytest_shard.py --shard 0 --total 4
    uv run python scripts/ci/select_pytest_shard.py --selftest
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[2]
ATOMIC_SUITES = ("tests/first_slice", "tests/job_queue")


def is_test_module(path: Path) -> bool:
    name = path.name
    return path.is_file() and (
        (name.startswith("test_") and name.endswith(".py"))
        or (name.endswith("_test.py") and name != "conftest.py")
    )


def discover_test_modules(tests_root: Path) -> list[Path]:
    return sorted(p for p in tests_root.rglob("*.py") if is_test_module(p))


def build_units(server_root: Path) -> list[tuple[str, int, tuple[str, ...]]]:
    tests_root = server_root / "tests"
    if not tests_root.is_dir():
        raise RuntimeError(f"tests directory missing under {server_root}")

    all_modules = discover_test_modules(tests_root)
    atomic_prefixes = {suite: server_root / suite for suite in ATOMIC_SUITES}
    grouped: dict[str, list[Path]] = {suite: [] for suite in ATOMIC_SUITES}
    singles: list[Path] = []

    for mod in all_modules:
        matched_suite: str | None = None
        for suite, prefix in atomic_prefixes.items():
            if mod.is_relative_to(prefix):
                matched_suite = suite
                break
        if matched_suite is not None:
            grouped[matched_suite].append(mod)
        else:
            singles.append(mod)

    units: list[tuple[str, int, tuple[str, ...]]] = []
    for suite in ATOMIC_SUITES:
        members = grouped[suite]
        if members:
            weight = sum(m.stat().st_size for m in members)
            rel_members = tuple(sorted(m.relative_to(server_root).as_posix() for m in members))
            units.append((suite, weight, rel_members))

    for mod in singles:
        rel = mod.relative_to(server_root).as_posix()
        units.append((rel, mod.stat().st_size, (rel,)))

    return sorted(units, key=lambda item: (-item[1], item[0]))


def partition(server_root: Path, total: int) -> list[list[str]]:
    if total < 1:
        raise ValueError("total shards must be >= 1")
    units = build_units(server_root)
    if len(units) < total:
        raise ValueError(f"cannot split {len(units)} test units across {total} non-empty shards")

    loads = [0] * total
    shards: list[list[str]] = [[] for _ in range(total)]
    for target, weight, _members in units:
        idx = min(range(total), key=lambda i: (loads[i], i))
        shards[idx].append(target)
        loads[idx] += weight
    return [sorted(shard) for shard in shards]


def expand_target(server_root: Path, target: str) -> set[str]:
    candidate = server_root / target
    if candidate.is_dir():
        return {m.relative_to(server_root).as_posix() for m in discover_test_modules(candidate)}
    if is_test_module(candidate):
        return {candidate.relative_to(server_root).as_posix()}
    raise RuntimeError(f"shard target {target!r} is neither a test directory nor a test module")


def selftest(server_root: Path, total: int = 4) -> None:
    expected = {
        m.relative_to(server_root).as_posix() for m in discover_test_modules(server_root / "tests")
    }
    if not expected:
        sys.exit("select_pytest_shard selftest: discovered zero test modules")

    first = partition(server_root, total)
    second = partition(server_root, total)
    if first != second:
        sys.exit("select_pytest_shard selftest: partition is not deterministic")

    seen: set[str] = set()
    for idx, shard in enumerate(first):
        if not shard:
            sys.exit(f"select_pytest_shard selftest: shard {idx} is empty")
        expanded: set[str] = set()
        for target in shard:
            expanded |= expand_target(server_root, target)
        overlap = seen & expanded
        if overlap:
            sys.exit(
                f"select_pytest_shard selftest: shard {idx} overlaps prior shards on {sorted(overlap)[:5]}"
            )
        seen |= expanded

    missing = expected - seen
    extra = seen - expected
    if missing or extra:
        sys.exit(
            f"select_pytest_shard selftest: coverage mismatch missing={sorted(missing)[:5]} extra={sorted(extra)[:5]}"
        )

    for suite in ATOMIC_SUITES:
        holders = [idx for idx, shard in enumerate(first) if suite in shard]
        if len(holders) != 1:
            sys.exit(
                f"select_pytest_shard selftest: atomic suite {suite} must appear in exactly 1 shard, got {holders}"
            )

    try:
        partition(server_root, 0)
    except ValueError:
        pass
    else:
        sys.exit("select_pytest_shard selftest: total=0 was not refused")

    print(
        f"OK: {len(expected)} test modules partitioned across {total} disjoint shards with zero omissions"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=SERVER_ROOT)
    parser.add_argument("--shard", type=int, default=None)
    parser.add_argument("--total", type=int, default=4)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    if args.selftest:
        selftest(root, total=args.total)
        return 0

    if args.shard is None or args.total < 1 or not (0 <= args.shard < args.total):
        sys.exit(f"select_pytest_shard: --shard must be in 0..{args.total - 1} (got {args.shard})")

    shards = partition(root, args.total)
    for target in shards[args.shard]:
        print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

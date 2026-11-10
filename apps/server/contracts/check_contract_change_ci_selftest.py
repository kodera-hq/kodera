"""Prove the contract change gate is run against the right commits with the right labels.

Each case runs `check_contract_change_ci.py` through its real code path, in the environment of
one GitHub event, against a throwaway Git repository whose commits stand in for a push. `gh` is a
stand-in that answers from a script, and the gate is a stand-in that records the arguments it was
given and exits as the case says. Each case asserts the exit status, the gate's recorded
arguments (or that the gate never ran), a message, and every call made to `gh`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PR_HEAD, ZERO = "d" * 40, "0" * 40
REPOSITORY = "kodera-hq/kodera"
MAIN_BASE = ["--target", "refs/remotes/origin/main"]
STUB_GH = """import json
import os
import sys
from pathlib import Path

state = Path(os.environ["STUB_GH_STATE"])
responses = json.loads(os.environ["STUB_GH_RESPONSES"])
calls = json.loads(state.read_text()) if state.exists() else []
calls.append(sys.argv[1:])
state.write_text(json.dumps(calls))
if not responses:
    sys.exit(97)
response = responses[min(len(calls), len(responses)) - 1]
sys.stdout.write(response.get("stdout", ""))
sys.exit(response.get("exit", 0))
"""
STUB_GATE = """import json
import os
import sys
from pathlib import Path

Path(os.environ["STUB_GATE_ARGV"]).write_text(json.dumps(sys.argv[1:]))
print("stub gate ran")
sys.exit(int(os.environ["STUB_GATE_EXIT"]))
"""


class FixtureError(Exception):
    """The throwaway repository could not be built."""


@dataclass(frozen=True)
class History:
    first: str
    changed: str
    unchanged: str


@dataclass(frozen=True)
class Case:
    env: dict[str, str]
    exit: int
    expect: tuple[str, ...]
    gate: list[str] | None = None
    responses: tuple[dict[str, Any], ...] = ()
    calls: int = 0
    gate_exit: int = 0


def build_history(root: Path) -> History:
    """Three commits: a contract, the contract changed, then only a note changed."""
    git = shutil.which("git")
    if git is None:
        raise FixtureError("git is not on PATH")
    env = dict(
        os.environ,
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_AUTHOR_NAME="self-test",
        GIT_AUTHOR_EMAIL="self-test@example.invalid",
        GIT_COMMITTER_NAME="self-test",
        GIT_COMMITTER_EMAIL="self-test@example.invalid",
    )

    def run(*args: str) -> str:
        result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
            [git, "-C", str(root), *args], capture_output=True, text=True, env=env, check=False
        )
        if result.returncode != 0:
            raise FixtureError(f"git {args[0]} failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def commit(message: str, files: dict[str, str]) -> str:
        for name, text in files.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(text, encoding="utf-8")
        run("add", "--all")
        run("commit", "--quiet", "--no-verify", "-m", message)
        return run("rev-parse", "HEAD")

    root.mkdir()
    run("init", "--quiet")
    first = commit("first", {"apps/server/contracts/probe.openapi.yaml": "v: 1\n", "notes.txt": "one\n"})
    changed = commit("contract changed", {"apps/server/contracts/probe.openapi.yaml": "v: 2\n"})
    unchanged = commit("note changed", {"notes.txt": "two\n"})
    return History(first, changed, unchanged)


def merged(sha: str, number: int, labels: list[str]) -> dict[str, Any]:
    pull = {"number": number, "merge_commit_sha": sha, "labels": [{"name": n} for n in labels]}
    return {"stdout": json.dumps([pull])}


NO_PULL_REQUEST: dict[str, Any] = {"stdout": "[]"}


def push(head: str, before: str, **extra: str) -> dict[str, str]:
    return {
        "EVENT_NAME": "push",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": head,
        "EVENT_BEFORE": before,
        "GITHUB_REPOSITORY": REPOSITORY,
        **extra,
    }


def pull_request(**extra: str) -> dict[str, str]:
    return {
        "EVENT_NAME": "pull_request",
        "GITHUB_REF": "refs/pull/7/merge",
        "GITHUB_SHA": "c" * 40,
        "BASE_REF": "main",
        "PR_HEAD_SHA": PR_HEAD,
        "PR_LABELS": "[]",
        "GITHUB_REPOSITORY": REPOSITORY,
        **extra,
    }


CASES: dict[str, Callable[[History], Case]] = {
    "pull-request": lambda h: Case(
        pull_request(PR_LABELS='["contract:breaking", "dependencies"]'),
        0,
        ("pull request into main", "stub gate ran"),
        ["--head", PR_HEAD, *MAIN_BASE, "--label=contract:breaking", "--label=dependencies"],
    ),
    "pull-request-into-a-branch": lambda h: Case(
        pull_request(BASE_REF="feat/stack"),
        0,
        ("pull request into feat/stack",),
        ["--head", PR_HEAD, "--target", "refs/remotes/origin/feat/stack"],
    ),
    "pull-request-labels-unreadable": lambda h: Case(
        pull_request(PR_LABELS="not json"),
        2,
        ("labels in the event are not a JSON list of names",),
    ),
    "gate-exit-status": lambda h: Case(
        pull_request(), 1, ("stub gate ran",), ["--head", PR_HEAD, *MAIN_BASE], gate_exit=1
    ),
    "dispatch-on-main": lambda h: Case(
        {
            "EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_SHA": h.changed,
            "EVENT_BEFORE": "",
            "GITHUB_REPOSITORY": REPOSITORY,
        },
        0,
        ("workflow_dispatch: compared with its merge-base with main",),
        ["--head", h.changed, *MAIN_BASE],
    ),
    "push-to-another-branch": lambda h: Case(
        push(h.changed, h.first, GITHUB_REF="refs/heads/feat/x"),
        0,
        ("push: compared with its merge-base with main",),
        ["--head", h.changed, *MAIN_BASE],
    ),
    "push-compares-with-before": lambda h: Case(
        push(h.changed, h.first),
        0,
        ("compared with the commit before the push", "pull request #9"),
        ["--head", h.changed, "--base", h.first, "--label=contract:breaking"],
        (merged(h.changed, 9, ["contract:breaking"]),),
        1,
    ),
    "push-creating-main": lambda h: Case(
        push(h.changed, ZERO),
        0,
        ("compared with the first parent",),
        ["--head", h.changed, "--parent"],
        (merged(h.changed, 9, []),),
        1,
    ),
    "push-without-contract-change": lambda h: Case(
        push(h.unchanged, h.changed),
        0,
        ("no contract file differs",),
        ["--head", h.unchanged, "--base", h.changed],
    ),
    "push-pull-request-appears-late": lambda h: Case(
        push(h.changed, h.first),
        0,
        ("pull request #9",),
        ["--head", h.changed, "--base", h.first, "--label=contract:breaking"],
        (NO_PULL_REQUEST, NO_PULL_REQUEST, merged(h.changed, 9, ["contract:breaking"])),
        3,
    ),
    "push-without-pull-request": lambda h: Case(
        push(h.changed, h.first),
        2,
        (
            "no pull request was merged as this commit after 4 attempt(s)",
            "fails closed",
            "Re-run this job once GitHub lists the pull request",
        ),
        None,
        (NO_PULL_REQUEST,),
        4,
    ),
    "push-api-failure": lambda h: Case(
        push(h.changed, h.first),
        2,
        ("gh api exited 1 after 4 attempt(s)", "fails closed"),
        None,
        ({"exit": 1},),
        4,
    ),
    "push-other-pull-request-ignored": lambda h: Case(
        push(h.changed, h.first),
        2,
        ("no pull request was merged as this commit", "fails closed"),
        None,
        (merged(h.first, 3, ["contract:breaking"]),),
        4,
    ),
    "event-missing": lambda h: Case({}, 2, ("EVENT_NAME is not set",)),
}


def verify(
    script: Path, repo: Path, history: History, directory: Path, name: str, show: bool
) -> list[str]:
    case = CASES[name](history)
    state, argv = directory / f"{name}.calls", directory / f"{name}.argv"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "STUB_GH_STATE": str(state),
        "STUB_GH_RESPONSES": json.dumps(list(case.responses)),
        "STUB_GATE_ARGV": str(argv),
        "STUB_GATE_EXIT": str(case.gate_exit),
        **case.env,
    }
    command = [sys.executable, str(script), "--repo", str(repo), "--delay", "0"]
    command += ["--gh", str(directory / "gh"), "--gate", str(directory / "gate.py")]
    result = subprocess.run(  # noqa: S603 - fixed interpreter and script, no shell
        command, capture_output=True, text=True, check=False, timeout=120, env=env
    )
    output = result.stdout + result.stderr
    recorded = json.loads(argv.read_text()) if argv.exists() else None
    calls = json.loads(state.read_text()) if state.exists() else []
    pulls_call = ["api", f"repos/{REPOSITORY}/commits/{case.env.get('GITHUB_SHA')}/pulls"]
    problems = []
    if "Traceback" in output:
        problems.append("the script crashed")
    if result.returncode != case.exit:
        problems.append(f"expected exit {case.exit}, got {result.returncode}")
    if recorded != case.gate:
        problems.append(f"expected gate arguments {case.gate}, got {recorded}")
    problems += [f"missing {needle!r}" for needle in case.expect if needle not in output]
    if len(calls) != case.calls:
        problems.append(f"expected {case.calls} gh call(s), got {len(calls)}")
    if any(call != pulls_call for call in calls):
        problems.append(f"unexpected gh call(s) {calls}")
    if problems:
        print(f"FAIL {name}: {'; '.join(problems)}")
        print("\n".join(f"    | {line}" for line in output.splitlines()))
    else:
        print(f"PASS {name}: exit {result.returncode}")
        if show:
            print("\n".join(f"    | {line}" for line in output.splitlines()))
    return problems


def install(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prove how the contract change gate is run.")
    parser.add_argument("--case", action="append", default=[], help="run only this case")
    parser.add_argument("--list", action="store_true", help="print every case name")
    parser.add_argument("--show-output", action="store_true", help="print passing output too")
    parser.add_argument("--script", type=Path, default=HERE / "check_contract_change_ci.py")
    arguments = parser.parse_args()
    if arguments.list:
        print("\n".join(CASES))
        return 0
    selected = arguments.case or list(CASES)
    unknown = [name for name in selected if name not in CASES]
    if unknown:
        print(f"FIXTURE: unknown case(s): {', '.join(unknown)}")
        return 2
    if not arguments.script.is_file():
        print(f"FIXTURE: {arguments.script} is missing")
        return 2
    failed = ran = 0
    with tempfile.TemporaryDirectory(prefix="contract-change-ci-selftest-") as name:
        directory = Path(name)
        try:
            history = build_history(directory / "repo")
        except FixtureError as error:
            print(f"FIXTURE: {error}")
            return 2
        install(directory / "gh_stub.py", STUB_GH)
        install(directory / "gate.py", STUB_GATE)
        install(
            directory / "gh",
            f'#!/bin/sh\nexec "{sys.executable}" "{directory / "gh_stub.py"}" "$@"\n',
        )
        for case_name in selected:
            problems = verify(
                arguments.script,
                directory / "repo",
                history,
                directory,
                case_name,
                arguments.show_output,
            )
            failed += bool(problems)
            ran += 1
    if ran != len(selected) or ran == 0:
        print(f"FIXTURE: ran {ran} of {len(selected)} selected case(s)")
        return 2
    if failed:
        print(f"contract change CI self-test FAILED: {failed} of {ran} case(s)")
        return 1
    print(f"contract change CI self-test passed: {ran} case(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

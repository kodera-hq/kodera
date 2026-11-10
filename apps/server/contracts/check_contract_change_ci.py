"""Choose the commits and labels for the contract change gate from a GitHub event, and run it.

- A push to `main` is compared with the commit before the push, or with the pushed commit's first
  parent when the push created `main`. When a contract file differs between the two, its labels
  are those of the pull request merged as the pushed commit, and when they cannot be read after
  retries the gate fails closed. When no contract file differs, no label can matter and none is
  read, so a push no pull request produced is not refused for want of one.
- A pull request is compared with the merge-base of its head and its target branch, with the
  labels in its event.
- Any other event, a manual run on `main` included, is compared with the merge-base of the commit
  and `main`, with no labels. Only a push to `main` is judged against the commit before it: a
  manual run judged against its own parent passes a head whose breaking change sits one commit
  lower.

Exit status is the gate's own, or 2 when the event or the labels cannot be read.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = "refs/heads/main"
ZERO = "0" * 40
COMMIT = re.compile(r"[0-9a-f]{40}")
CONTRACTS = "apps/server/contracts/*.openapi.yaml"
DEFAULT_ATTEMPTS = 4
DEFAULT_DELAY = 5.0
COULD_NOT_LOOK = 2


class PlanError(Exception):
    """The event, or the labels it implies, cannot be read."""


@dataclass(frozen=True)
class Plan:
    head: str
    base: tuple[str, ...]
    labels: tuple[str, ...]
    how: str


def required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "")
    if not value:
        raise PlanError(f"{name} is not set")
    return value


def event_labels(raw: str) -> tuple[str, ...]:
    try:
        names = json.loads(raw)
    except ValueError:
        names = None
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        raise PlanError("the pull request's labels in the event are not a JSON list of names")
    return tuple(names)


def pull_request_merged_as(stdout: str, sha: str) -> tuple[int, tuple[str, ...]] | str:
    """Return (number, labels) of the pull request merged as sha, or why there is none."""
    try:
        pulls = json.loads(stdout)
    except ValueError:
        return "the API answered with something that is not JSON"
    if not isinstance(pulls, list):
        return "the API answered with something that is not a list"
    for pull in pulls:
        if isinstance(pull, dict) and pull.get("merge_commit_sha") == sha:
            labels = pull.get("labels")
            if not isinstance(labels, list):
                return "the merged pull request carries no label list"
            number = pull.get("number")
            names = [label.get("name") for label in labels if isinstance(label, dict)]
            return (
                number if isinstance(number, int) else 0,
                tuple(name for name in names if isinstance(name, str)),
            )
    return "no pull request was merged as this commit"


def merged_labels(
    gh: str,
    repository: str,
    sha: str,
    attempts: int,
    delay: float,
    sleep: Callable[[float], None],
) -> tuple[str, ...]:
    reason = "no attempt was made"
    for attempt in range(1, attempts + 1):
        try:
            result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
                [gh, "api", f"repos/{repository}/commits/{sha}/pulls"],
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )
        except OSError as error:
            reason = f"cannot run gh: {error.strerror}"
        else:
            if result.returncode != 0:
                reason = f"gh api exited {result.returncode}"
            else:
                found = pull_request_merged_as(result.stdout, sha)
                if isinstance(found, str):
                    reason = found
                else:
                    number, names = found
                    print(f"labels read from pull request #{number}, merged as {sha[:12]}")
                    return names
        if attempt < attempts:
            sleep(delay * 2 ** (attempt - 1))
    message = (
        f"{reason} after {attempts} attempt(s); the labels of the pull request cannot be read, "
        f"so the gate fails closed. Re-run this job once GitHub lists the pull request for "
        f"{sha[:12]}."
    )
    raise PlanError(message)


def contracts_differ(repo: Path, base: str, head: str) -> bool:
    """Whether any contract file differs between two commits. When git cannot tell, assume so."""
    git = shutil.which("git")
    if git is None:
        print("git is not on PATH, so the labels are read as if a contract changed")
        return True
    result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
        [git, "-C", str(repo), "diff", "--quiet", base, head, "--", CONTRACTS],
        capture_output=True,
        check=False,
        timeout=120,
    )
    if result.returncode == 0:
        return False
    if result.returncode != 1:
        print(
            f"git diff exited {result.returncode}, so the labels are read as if a contract changed"
        )
    return True


def plan(
    env: Mapping[str, str],
    repo: Path,
    gh: str,
    attempts: int,
    delay: float,
    sleep: Callable[[float], None],
) -> Plan:
    event = required(env, "EVENT_NAME")
    ref = env.get("GITHUB_REF", "")
    if event == "push" and ref == MAIN:
        head = required(env, "GITHUB_SHA")
        before = env.get("EVENT_BEFORE", "")
        if before and before != ZERO:
            if COMMIT.fullmatch(before) is None:
                raise PlanError("EVENT_BEFORE is not a commit id")
            base: tuple[str, ...] = ("--base", before)
            compared = before
            how = "push to main: compared with the commit before the push"
        else:
            base = ("--parent",)
            compared = f"{head}^"
            how = "push that created main: compared with the first parent"
        if contracts_differ(repo, compared, head):
            repository = required(env, "GITHUB_REPOSITORY")
            labels = merged_labels(gh, repository, head, attempts, delay, sleep)
        else:
            print(
                f"no contract file differs between {compared[:12]} and {head[:12]}; no labels read"
            )
            labels = ()
        return Plan(head, base, labels, how)
    if event == "pull_request":
        target = required(env, "BASE_REF")
        return Plan(
            required(env, "PR_HEAD_SHA"),
            ("--target", f"refs/remotes/origin/{target}"),
            event_labels(env.get("PR_LABELS", "")),
            f"pull request into {target}: compared with the merge-base of its head and target",
        )
    return Plan(
        required(env, "GITHUB_SHA"),
        ("--target", "refs/remotes/origin/main"),
        (),
        f"{event}: compared with its merge-base with main, no labels",
    )


def gate_command(gate: Path, chosen: Plan) -> list[str]:
    command = [sys.executable, str(gate), "--head", chosen.head, *chosen.base]
    command += [f"--label={label}" for label in chosen.labels]
    return command


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the contract change gate for a GitHub event.")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--gh", default="gh")
    parser.add_argument("--attempts", type=int, default=DEFAULT_ATTEMPTS)
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
        help="seconds before the first retry; each later wait doubles",
    )
    parser.add_argument("--gate", type=Path, default=HERE / "check_contract_change.py")
    arguments = parser.parse_args()
    try:
        chosen = plan(
            os.environ,
            arguments.repo,
            arguments.gh,
            arguments.attempts,
            arguments.delay,
            time.sleep,
        )
    except PlanError as error:
        print(f"::error::{error}")
        return COULD_NOT_LOOK
    print(chosen.how)
    result = subprocess.run(gate_command(arguments.gate, chosen), check=False)  # noqa: S603
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())

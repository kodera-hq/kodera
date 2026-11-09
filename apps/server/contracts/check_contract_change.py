"""Classify every contract change between two commits and hold it to the version policy.

The version policy (`check-version-policy.sh`) decides whether a version bump fits a
classification, and it takes that classification on trust. This gate supplies it. oasdiff
compares the contract at the base commit with the contract at the head commit, using the
severity overrides as they are at the base commit, and this gate adds what oasdiff does not
read: a change to `servers`, or to an operation's `x-kodera-authz` or `x-kodera-scope`. The
most severe finding decides whether the change is breaking, additive or a patch. The policy
then runs with that classification and the pull request's labels.

The caller chooses the base commit one of three ways:

- `--target REV`: the merge-base of REV and the head, so a change that landed on the target
  after the branch was cut is never read as the branch's change;
- `--base REV`: exactly REV, the commit before a push;
- `--parent`: the head's first parent.

Every `contracts/*.openapi.yaml` present at either commit is checked. A contract only at the
head is added, and passes once it parses under the policy. A contract only at the base is
deleted, and is refused: every client of it breaks, and no version bump can say so.

Exit status: 0 when every contract passes, 1 when any contract violates the policy or was
deleted, 2 when the gate could not look. Could-not-look is never reported as clean.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

DESCRIPTION = "Classify every contract change between two commits and hold it to the policy."
HERE = Path(__file__).resolve().parent
WORKFLOW = HERE.parent / ".github" / "workflows" / "ci.yml"
CONTRACT_DIR = "contracts"
CONTRACT_SUFFIX = ".openapi.yaml"
SEVERITY_PATH = f"{CONTRACT_DIR}/oasdiff-severity-levels.txt"
BREAKING_LABEL = "contract:breaking"
# oasdiff's JSON changelog reports a finding's level as 3 (ERR), 2 (WARN) or 1 (INFO).
LEVEL_NAMES = {3: "ERR", 2: "WARN", 1: "INFO"}
ERR = 3
INFO = 1
# WARN means oasdiff cannot tell whether a client breaks. The README counts anything a
# client can break on as breaking, so WARN is breaking here.
BREAKING_LEVEL = 2
LISTED_FINDINGS = 40
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
PATH_PARAMETER = re.compile(r"\{[^}/]*\}")
# Who may call an operation and with which scope. A change to either can refuse a client that
# was allowed before, and oasdiff reads neither.
OPERATION_EXTENSIONS = ("x-kodera-authz", "x-kodera-scope")
PASSED, VIOLATION, COULD_NOT_LOOK = 0, 1, 2
# Both are safe loaders; the C one is only faster.
LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class CouldNotLookError(Exception):
    """The gate could not read something it needs; never the same as finding nothing."""


@dataclass(frozen=True)
class Finding:
    check: str
    level: int
    operation: str
    path: str
    text: str

    def line(self) -> str:
        where = " ".join(part for part in (self.operation, self.path) if part)
        location = f"  {where}" if where else ""
        return f"  {LEVEL_NAMES[self.level]:<4} {self.check}{location}: {self.text}"


class Git:
    def __init__(self, repo: Path) -> None:
        executable = shutil.which("git")
        if executable is None:
            raise CouldNotLookError("git is not on PATH")
        self.executable = executable
        self.repo = repo

    def __call__(self, *args: str) -> bytes:
        result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
            [self.executable, "-C", str(self.repo), *args],
            capture_output=True,
            check=False,
            timeout=120,
        )
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
            reason = detail[0] if detail else "no message"
            raise CouldNotLookError(f"git {args[0]} failed with exit {result.returncode}: {reason}")
        return result.stdout

    def commit(self, revision: str) -> str:
        return (
            self("rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}")
            .decode()
            .strip()
        )

    def blob(self, commit: str, path: str) -> str | None:
        listing = self("ls-tree", "-z", "--full-tree", commit, "--", path).rstrip(b"\0")
        if not listing:
            return None
        meta, _, _ = listing.partition(b"\t")
        _, kind, blob = meta.decode().split(" ")
        if kind != "blob":
            raise CouldNotLookError(f"{path} is a {kind} at {commit[:12]}, not a file")
        return blob


def revisions(
    git: Git, head_revision: str, target: str | None, base_revision: str | None
) -> tuple[str, str, str]:
    """Return (base, head, how the base was chosen)."""
    head = git.commit(head_revision)
    if target is not None:
        tip = git.commit(target)
        base = git("merge-base", tip, head).decode().strip()
        return base, head, f"merge-base of {target} and the head"
    if base_revision is not None:
        return git.commit(base_revision), head, f"the given base {base_revision}"
    parents = git("rev-list", "--parents", "-n", "1", head).decode().split()[1:]
    if not parents:
        raise CouldNotLookError("the head commit has no parent to compare with")
    return parents[0], head, "first parent of the head"


def contracts_at(git: Git, commit: str) -> dict[str, str]:
    """Map every contracts/*.openapi.yaml at a commit to its blob id."""
    found: dict[str, str] = {}
    listing = git("ls-tree", "-z", "--full-tree", commit, "--", f"{CONTRACT_DIR}/")
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        meta, _, raw_path = entry.partition(b"\t")
        _, kind, blob = meta.decode().split(" ")
        path = PurePosixPath(raw_path.decode("utf-8"))
        if path.parent.as_posix() != CONTRACT_DIR or not path.name.endswith(CONTRACT_SUFFIX):
            continue
        if kind != "blob":
            raise CouldNotLookError(f"{path} is a {kind} at {commit[:12]}, not a file")
        found[path.as_posix()] = blob
    return found


def materialise(git: Git, blob: str, directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    target.write_bytes(git("cat-file", "blob", blob))
    return target


def severity_levels(git: Git, base_commit: str, shipped: Path, workspace: Path) -> tuple[Path, str]:
    """Return the severity overrides as they are at the base commit, and where they came from.

    A pull request is judged by the rules it is merging into, never by rules it edits itself.
    """
    blob = git.blob(base_commit, SEVERITY_PATH)
    if blob is None:
        return shipped, f"{SEVERITY_PATH} is not at the base, so the copy beside the gate is used"
    file = materialise(git, blob, workspace / "severity", PurePosixPath(SEVERITY_PATH).name)
    return file, f"{SEVERITY_PATH} as it is at the base"


def parsed(path: str, file: Path) -> tuple[object, str, str]:
    """Return (document, canonical JSON, info.version)."""
    try:
        document = yaml.load(file.read_text(encoding="utf-8"), Loader=LOADER)  # noqa: S506 - safe loader
        canonical = json.dumps(document, sort_keys=True, allow_nan=False)
    except (UnicodeError, yaml.YAMLError, ValueError, TypeError, RecursionError) as error:
        raise CouldNotLookError(f"{path}: cannot parse the document to compare it") from error
    info = document.get("info") if isinstance(document, dict) else None
    version = info.get("version") if isinstance(info, dict) else None
    return document, canonical, str(version)


def as_json(value: object) -> str:
    return json.dumps(value, sort_keys=True)


def as_set_json(value: object) -> str:
    """Canonical JSON in which every list is a set: order and repeated entries do not count.

    A role or scope listed twice grants what it grants once, and the order of a list of roles
    grants nothing, so only an entry added or removed changes who may call.
    """

    def normal(node: object) -> object:
        if isinstance(node, dict):
            return {key: normal(item) for key, item in node.items()}
        if isinstance(node, list):
            return sorted({as_json(normal(item)) for item in node})
        return node

    return as_json(normal(value))


def without_descriptions(node: object) -> object:
    """The node with every `description` key removed, at any depth."""
    if isinstance(node, dict):
        return {
            key: without_descriptions(item) for key, item in node.items() if key != "description"
        }
    if isinstance(node, list):
        return [without_descriptions(item) for item in node]
    return node


def normalised_path(path: str) -> str:
    """The path with every parameter name blanked, so `/o/{id}` and `/o/{organisation_id}` match."""
    return PATH_PARAMETER.sub("{}", path)


def paths_by_shape(document: dict[str, Any]) -> dict[str, tuple[str, dict[str, Any]]]:
    """Each path item keyed by its normalised path, so a renamed parameter hides no operation."""
    paths = document.get("paths")
    shapes: dict[str, tuple[str, dict[str, Any]]] = {}
    if not isinstance(paths, dict):
        return shapes
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        shape = normalised_path(str(path))
        if shape in shapes:
            raise CouldNotLookError(
                f"paths {shapes[shape][0]} and {path} differ only in parameter names"
            )
        shapes[shape] = (str(path), item)
    return shapes


def security_scheme_findings(base: dict[str, Any], head: dict[str, Any]) -> list[Finding]:
    """How a caller authenticates: a changed or removed scheme can refuse every client using it."""

    def schemes(document: dict[str, Any]) -> dict[str, Any]:
        components = document.get("components")
        found = components.get("securitySchemes") if isinstance(components, dict) else None
        return found if isinstance(found, dict) else {}

    before, after = schemes(base), schemes(head)
    findings = []
    for name in sorted(set(before) | set(after)):
        where = f"components/securitySchemes/{name}"
        before_scheme = as_json(without_descriptions(before.get(name)))
        after_scheme = as_json(without_descriptions(after.get(name)))
        if name not in after:
            findings.append(Finding("security-scheme-removed", ERR, "", where, "removed"))
        elif name not in before:
            findings.append(Finding("security-scheme-added", INFO, "", where, "added"))
        elif before_scheme != after_scheme:
            findings.append(
                Finding("security-scheme-changed", ERR, "", where, "changed beyond its description")
            )
    return findings


def rule_findings(base: object, head: object) -> list[Finding]:
    """Findings for what oasdiff does not read: where the API is served, who may call an
    operation, and how a caller authenticates."""
    if not isinstance(base, dict) or not isinstance(head, dict):
        return []
    findings = security_scheme_findings(base, head)
    if as_json(base.get("servers")) != as_json(head.get("servers")):
        findings.append(Finding("servers-changed", ERR, "", "", "the document's servers changed"))
    base_shapes, head_shapes = paths_by_shape(base), paths_by_shape(head)
    for shape in sorted(set(base_shapes) & set(head_shapes)):
        base_item = base_shapes[shape][1]
        path, head_item = head_shapes[shape]
        if as_json(base_item.get("servers")) != as_json(head_item.get("servers")):
            findings.append(Finding("servers-changed", ERR, "", path, "the path's servers changed"))
        for method in METHODS:
            base_operation, head_operation = base_item.get(method), head_item.get(method)
            if not isinstance(base_operation, dict) or not isinstance(head_operation, dict):
                continue
            operation = method.upper()
            before_servers = as_json(base_operation.get("servers"))
            if before_servers != as_json(head_operation.get("servers")):
                findings.append(
                    Finding(
                        "servers-changed", ERR, operation, path, "the operation's servers changed"
                    )
                )
            for extension in OPERATION_EXTENSIONS:
                before, after = base_operation.get(extension), head_operation.get(extension)
                if as_set_json(before) != as_set_json(after):
                    findings.append(
                        Finding(
                            f"{extension}-changed",
                            ERR,
                            operation,
                            path,
                            f"{extension} changed from {as_json(before)} to {as_json(after)}",
                        )
                    )
    return findings


def changelog(oasdiff: str, severity: Path, base: Path, head: Path) -> list[Finding]:
    try:
        result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
            [
                oasdiff,
                "changelog",
                str(base),
                str(head),
                "--format",
                "json",
                "--severity-levels",
                str(severity),
                "--allow-external-refs=false",
            ],
            capture_output=True,
            check=False,
            timeout=300,
        )
    except OSError as error:
        raise CouldNotLookError(f"cannot run oasdiff at {oasdiff}: {error.strerror}") from error
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        reason = detail[0] if detail else "no message"
        raise CouldNotLookError(f"oasdiff exited {result.returncode}: {reason}")
    try:
        items = json.loads(result.stdout)
    except ValueError as error:
        raise CouldNotLookError("oasdiff did not print a JSON changelog") from error
    if not isinstance(items, list):
        raise CouldNotLookError("oasdiff printed a changelog that is not a list")
    findings = []
    for item in items:
        level = item.get("level") if isinstance(item, dict) else None
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or isinstance(level, bool)
            or level not in LEVEL_NAMES
        ):
            raise CouldNotLookError("oasdiff printed a changelog entry this gate cannot read")
        findings.append(
            Finding(
                item["id"],
                level,
                str(item.get("operation") or ""),
                str(item.get("path") or ""),
                str(item.get("text") or ""),
            )
        )
    return findings


def classify(findings: list[Finding]) -> str:
    if any(finding.level >= BREAKING_LEVEL for finding in findings):
        return "breaking"
    if findings:
        return "additive"
    return "patch"


def version_policy(
    policy: Path, base: Path, head: Path, change: str, labels: list[str]
) -> tuple[bool, str]:
    """Return (passed, the policy's own verdict line)."""
    bash = shutil.which("bash")
    if bash is None:
        raise CouldNotLookError("bash is not on PATH")
    arguments = [bash, str(policy), "--base", str(base), "--candidate", str(head)]
    arguments.append(f"--change={change}")
    arguments.extend(f"--label={label}" for label in labels)
    result = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
        arguments,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
        env=dict(os.environ, PYTHON=sys.executable),
    )
    lines = (result.stdout + result.stderr).strip().splitlines()
    verdicts = [line for line in lines if line.startswith(("PASS:", "POLICY:"))]
    if result.returncode == 0 and verdicts and verdicts[0].startswith("PASS:"):
        return True, verdicts[0]
    if result.returncode == 1 and verdicts and verdicts[0].startswith("POLICY:"):
        return False, verdicts[0]
    reason = lines[-1] if lines else "no output"
    raise CouldNotLookError(
        f"the version policy exited {result.returncode} without a verdict: {reason}"
    )


def check_contract(
    git: Git,
    arguments: argparse.Namespace,
    severity: Path,
    labels: list[str],
    path: str,
    base_blob: str | None,
    head_blob: str | None,
    workspace: Path,
) -> int:
    name = PurePosixPath(path).name
    if head_blob is None:
        print(f"{path}: deleted")
        print(
            f"::error file={path}::{path} was deleted. Removing a contract breaks every client "
            "of it and no version bump can say so; this gate refuses it."
        )
        return VIOLATION
    if base_blob == head_blob:
        print(f"{path}: unchanged (same file)")
        return PASSED
    head_file = materialise(git, head_blob, workspace / "head", name)
    if base_blob is None:
        _, _, version = parsed(path, head_file)
        passed, verdict = version_policy(arguments.policy, head_file, head_file, "unchanged", [])
        print(f"{path}: added, version {version}; there is no base, so nothing in it can break")
        print(f"  {verdict}")
        return PASSED if passed else VIOLATION
    base_file = materialise(git, base_blob, workspace / "base", name)
    base_document, base_canonical, base_version = parsed(path, base_file)
    head_document, head_canonical, head_version = parsed(path, head_file)
    findings: list[Finding] = []
    if base_canonical == head_canonical:
        change = "unchanged"
        print(f"{path}: unchanged (formatting only; the parsed documents are equal)")
    else:
        findings = rule_findings(base_document, head_document)
        findings += changelog(arguments.oasdiff, severity, base_file, head_file)
        change = classify(findings)
        breaking = sum(1 for finding in findings if finding.level >= BREAKING_LEVEL)
        print(
            f"{path}: modified, version {base_version} -> {head_version}, classified {change} "
            f"({breaking} finding(s) at WARN or ERR, {len(findings) - breaking} at INFO)"
        )
        for finding in sorted(findings, key=lambda finding: -finding.level)[:LISTED_FINDINGS]:
            print(finding.line())
        if len(findings) > LISTED_FINDINGS:
            print(f"  ... and {len(findings) - LISTED_FINDINGS} more")
    passed, verdict = version_policy(arguments.policy, base_file, head_file, change, labels)
    print(f"  {verdict}")
    if passed:
        return PASSED
    checks = sorted({finding.check for finding in findings if finding.level >= BREAKING_LEVEL})
    named = f" ({', '.join(checks)})" if checks else ""
    print(
        f"::error file={path}::{change} change{named} without what the version policy "
        f"requires: {verdict.removeprefix('POLICY: ')}"
    )
    return VIOLATION


def pinned_oasdiff_version(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    try:
        workflow = yaml.load(WORKFLOW.read_text(encoding="utf-8"), Loader=LOADER)  # noqa: S506 - safe loader
        pinned = workflow["env"]["OASDIFF_VERSION"]
    except (OSError, yaml.YAMLError, KeyError, TypeError):
        return None
    return pinned if isinstance(pinned, str) else None


def oasdiff_problem(oasdiff: str, pinned: str | None) -> str | None:
    """Why this oasdiff cannot be used, or None. The classification is defined for one version."""
    if pinned is None:
        return (
            "the pinned oasdiff version is unknown: set OASDIFF_VERSION or pass --oasdiff-version"
        )
    try:
        probe = subprocess.run(  # noqa: S603 - fixed executable, arguments never reach a shell
            [oasdiff, "--version"], capture_output=True, text=True, check=False, timeout=60
        )
    except OSError as error:
        return f"cannot run oasdiff at {oasdiff}: {error.strerror}"
    if probe.returncode != 0:
        return f"cannot run oasdiff at {oasdiff}: --version exited {probe.returncode}"
    reported = probe.stdout.strip()
    if reported != f"oasdiff version {pinned}":
        return (
            f"oasdiff at {oasdiff} reports {reported!r}, not the pinned version {pinned}; "
            "the classification is defined only for the pinned version"
        )
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--head", required=True, help="the commit whose contracts are checked")
    base = parser.add_mutually_exclusive_group(required=True)
    base.add_argument("--target", help="compare with the merge-base of this and the head")
    base.add_argument("--base", dest="base_revision", help="compare with exactly this commit")
    base.add_argument("--parent", action="store_true", help="compare with the first parent")
    parser.add_argument("--label", action="append", default=[], help="a label on the pull request")
    parser.add_argument("--oasdiff", default=os.environ.get("OASDIFF", "oasdiff"))
    parser.add_argument("--oasdiff-version", default=os.environ.get("OASDIFF_VERSION"))
    parser.add_argument("--policy", type=Path, default=HERE / "check-version-policy.sh")
    parser.add_argument(
        "--severity-levels",
        type=Path,
        default=HERE / "oasdiff-severity-levels.txt",
        help="used only when the base commit has no severity levels file",
    )
    arguments = parser.parse_args()
    labels = sorted(set(arguments.label))

    problem = oasdiff_problem(arguments.oasdiff, pinned_oasdiff_version(arguments.oasdiff_version))
    if problem is not None:
        print(f"::error::{problem}")
        return COULD_NOT_LOOK
    for required in (arguments.policy, arguments.severity_levels):
        if not required.is_file():
            print(f"::error::{required} is missing")
            return COULD_NOT_LOOK

    with tempfile.TemporaryDirectory(prefix="contract-change-") as directory:
        workspace = Path(directory)
        try:
            git = Git(arguments.repo)
            base_commit, head_commit, how = revisions(
                git, arguments.head, arguments.target, arguments.base_revision
            )
            at_base = contracts_at(git, base_commit)
            at_head = contracts_at(git, head_commit)
            severity, source = severity_levels(
                git, base_commit, arguments.severity_levels, workspace
            )
        except CouldNotLookError as error:
            print(f"::error::{error}")
            return COULD_NOT_LOOK
        if base_commit == head_commit:
            print(f"base and head are both {head_commit[:12]} ({how})")
            print("::notice::no contract comparison performed: base equals head")
            return PASSED
        print(f"base {base_commit[:12]} ({how}), head {head_commit[:12]}")
        print(f"labels: {', '.join(labels) if labels else '(none)'}")
        print(f"severity levels: {source}")
        paths = sorted(set(at_base) | set(at_head))
        if not paths:
            print(
                f"::error::no {CONTRACT_DIR}/*{CONTRACT_SUFFIX} at either commit; nothing was checked"
            )
            return COULD_NOT_LOOK

        outcome = PASSED
        for index, path in enumerate(paths):
            try:
                result = check_contract(
                    git,
                    arguments,
                    severity,
                    labels,
                    path,
                    at_base.get(path),
                    at_head.get(path),
                    workspace / str(index),
                )
            except CouldNotLookError as error:
                print(f"{path}: could not be checked")
                print(f"::error file={path}::{error}")
                result = COULD_NOT_LOOK
            outcome = max(outcome, result)

    if outcome == PASSED:
        print(f"contract change gate passed: {len(paths)} contract(s) checked")
    elif outcome == VIOLATION:
        print(
            f"contract change gate failed. A breaking change needs the `{BREAKING_LABEL}` label "
            "and, while info.version is 0.y.z, at least a minor increase (a major increase from "
            "1.0.0); an additive change needs at least a minor increase; any other change to "
            "the document needs a greater version."
        )
    else:
        print("contract change gate could not check every contract, so it does not pass")
    return outcome


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate .github/workflows/publish-images.yml and prove negative mutations fail."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKFLOW = ROOT / ".github" / "workflows" / "publish-images.yml"

EXPECTED_PINNED_ACTIONS = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069",
    "docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550",
    "docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83",
}

USES_LINE_RE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)")
PINNED_ACTION_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")


# Every image the workflow must publish: (Dockerfile, build target or None, image name).
# The operator image is the API Dockerfile's `dependencies` stage, exactly what Fleet's
# lab seed builds (`docker build --target dependencies`); the worker has its own Dockerfile.
EXPECTED_BUILDS = {
    ("apps/server/Dockerfile", None, "kodera-core"),
    ("apps/server/Dockerfile", "dependencies", "kodera-core-operator-deps"),
    ("apps/server/Dockerfile.worker", None, "kodera-core-worker"),
}
STEP_SPLIT_RE = re.compile(r"(?m)^      - (?=name:|uses:)")
IMAGE_TAG_RE = re.compile(
    r"tags:\s*ghcr\.io/\$\{\{ github\.repository_owner \}\}/([a-z0-9-]+):\$\{\{ github\.sha \}\}"
)


def check_build_steps(text: str, root: Path) -> list[str]:
    """Each publish step must match EXPECTED_BUILDS and name a Dockerfile (and stage) that exists."""
    errors: list[str] = []
    found: set[tuple[str, str | None, str]] = set()
    for block in STEP_SPLIT_RE.split(text):
        if "docker/build-push-action@" not in block:
            continue
        context = re.search(r"(?m)^\s*context:\s*(\S+)\s*$", block)
        dockerfile = re.search(r"(?m)^\s*file:\s*(\S+)\s*$", block)
        target = re.search(r"(?m)^\s*target:\s*(\S+)\s*$", block)
        image = IMAGE_TAG_RE.search(block)
        if not (context and dockerfile and image) or context.group(1) != "apps/server":
            errors.append("every build step must set context 'apps/server', a file and a commit-SHA tag")
            continue
        file_name = dockerfile.group(1)
        stage = target.group(1) if target else None
        found.add((file_name, stage, image.group(1)))
        path = root / file_name
        if not path.is_file():
            errors.append(f"build file '{file_name}' does not exist in the repository")
            continue
        if stage is not None and not re.search(
            r"(?im)^FROM\s+\S+\s+AS\s+" + re.escape(stage) + r"\s*$",
            path.read_text(encoding="utf-8"),
        ):
            errors.append(f"build target '{stage}' is not a stage of '{file_name}'")
    for missing in sorted(EXPECTED_BUILDS - found, key=str):
        errors.append(f"missing docker build {missing[0]} target={missing[1]} image={missing[2]}")
    for extra in sorted(found - EXPECTED_BUILDS, key=str):
        errors.append(f"unexpected docker build {extra[0]} target={extra[1]} image={extra[2]}")
    return errors


def check_workflow_text(text: str, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    lines = text.splitlines()
    if "    if: github.ref == 'refs/heads/main'" not in text:
        errors.append("image publication must be gated to refs/heads/main")

    if not lines or lines[0] != "name: Publish images":
        errors.append("workflow must start with exact line 'name: Publish images'")

    if "pull_request_target" in text:
        errors.append("forbidden trigger 'pull_request_target' present")

    if not re.search(r"(?m)^  push:\s*$", text) or "branches: [main]" not in text:
        errors.append("workflow must trigger on push to branches: [main]")

    if '"apps/server/**"' not in text or '".github/workflows/publish-images.yml"' not in text:
        errors.append("push trigger must watch 'apps/server/**' and '.github/workflows/publish-images.yml'")

    if not re.search(r"(?m)^  workflow_dispatch:\s*$", text):
        errors.append("workflow must support workflow_dispatch")

    if not re.search(r"(?m)^permissions:\n  contents: read\s*$", text):
        errors.append("top-level permissions must be exactly 'contents: read'")

    if not re.search(
        r"(?m)^    permissions:\n      contents: read\n      packages: write\s*$",
        text,
    ):
        errors.append("job permissions must declare 'contents: read' and 'packages: write'")

    if "write-all" in text or "contents: write" in text:
        errors.append("excessive write permissions detected")

    seen_actions: set[str] = set()
    checkout_indices: list[int] = []
    for idx, raw_line in enumerate(lines, start=1):
        code = raw_line.split("#", 1)[0]
        match = USES_LINE_RE.match(code)
        if not match:
            continue
        action_ref = match.group(1).strip()
        seen_actions.add(action_ref)
        if not PINNED_ACTION_RE.match(action_ref):
            errors.append(f"line {idx}: unpinned or non-40-hex action reference '{action_ref}'")
        if action_ref.startswith("actions/checkout@"):
            checkout_indices.append(idx - 1)

    missing_actions = EXPECTED_PINNED_ACTIONS - seen_actions
    if missing_actions:
        errors.append(f"missing expected SHA-pinned actions: {sorted(missing_actions)}")

    if not checkout_indices:
        errors.append("workflow must include actions/checkout")
    for idx in checkout_indices:
        window = "\n".join(lines[idx : idx + 5])
        if "persist-credentials: false" not in window:
            errors.append("actions/checkout step must set 'persist-credentials: false'")

    errors.extend(check_build_steps(text, root))

    if ":latest" in text:
        errors.append("mutable ':latest' tag is forbidden")

    revision_labels = re.findall(
        r"org\.opencontainers\.image\.revision=\$\{\{\s*github\.sha\s*\}\}",
        text,
    )
    if len(revision_labels) < 3:
        errors.append(
            "all three image builds must set label 'org.opencontainers.image.revision=${{ github.sha }}'"
        )

    if "$GITHUB_STEP_SUMMARY" not in text:
        errors.append("workflow must record digest summary to $GITHUB_STEP_SUMMARY")

    if (
        "kodera-core@${API_DIGEST}" not in text
        or "kodera-core-operator-deps@${OPERATOR_DIGEST}" not in text
        or "kodera-core-worker@${WORKER_DIGEST}" not in text
        or "sha256:*)" not in text
    ):
        errors.append(
            "step summary must verify sha256 digests and write api and operator @sha256: lines"
        )

    return errors


def run_selftest(baseline: str) -> int:
    baseline_errors = check_workflow_text(baseline)
    if baseline_errors:
        for err in baseline_errors:
            print(f"[FAIL] baseline workflow invalid: {err}", file=sys.stderr)
        return 1

    mutations: list[tuple[str, Callable[[str], str], str]] = [
        (
            "wrong workflow name",
            lambda s: s.replace("name: Publish images", "name: Publish image", 1),
            "workflow must start with exact line 'name: Publish images'",
        ),
        (
            "forbidden pull_request_target trigger",
            lambda s: s.replace("  workflow_dispatch:", "  pull_request_target:", 1),
            "forbidden trigger 'pull_request_target' present",
        ),
        (
            "unpinned tag on docker/build-push-action",
            lambda s: s.replace(
                "docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83",
                "docker/build-push-action@v6",
                1,
            ),
            "unpinned or non-40-hex action reference",
        ),
        (
            "manual publication from an untrusted branch",
            lambda s: s.replace("    if: github.ref == 'refs/heads/main'\n", ""),
            "image publication must be gated to refs/heads/main",
        ),
        (
            "missing persist-credentials: false on checkout",
            lambda s: s.replace("persist-credentials: false", "persist-credentials: true", 1),
            "actions/checkout step must set 'persist-credentials: false'",
        ),
        (
            "operator build points at a Dockerfile that does not exist",
            lambda s: s.replace(
                "file: apps/server/Dockerfile\n          target: dependencies",
                "file: apps/server/Dockerfile.operator-deps\n          target: dependencies",
                1,
            ),
            "build file 'apps/server/Dockerfile.operator-deps' does not exist",
        ),
        (
            "operator build names a stage the Dockerfile lacks",
            lambda s: s.replace("target: dependencies", "target: operator", 1),
            "build target 'operator' is not a stage of 'apps/server/Dockerfile'",
        ),
        (
            "operator build loses its target and duplicates the API image",
            lambda s: s.replace("          target: dependencies\n", "", 1),
            "missing docker build apps/server/Dockerfile target=dependencies",
        ),
        (
            "worker image build removed",
            lambda s: s.replace(
                "file: apps/server/Dockerfile.worker", "file: apps/server/Dockerfile", 1
            ),
            "missing docker build apps/server/Dockerfile.worker",
        ),
        (
            "missing revision OCI label on one image",
            lambda s: s.replace(
                "org.opencontainers.image.revision=${{ github.sha }}",
                "org.opencontainers.image.title=kodera-core",
                1,
            ),
            "org.opencontainers.image.revision=${{ github.sha }}",
        ),
        (
            "mutable latest tag",
            lambda s: s.replace(
                "kodera-core:${{ github.sha }}",
                "kodera-core:latest",
                1,
            ),
            "mutable ':latest' tag is forbidden",
        ),
        (
            "missing GITHUB_STEP_SUMMARY output",
            lambda s: s.replace("$GITHUB_STEP_SUMMARY", "/dev/null", 1),
            "workflow must record digest summary to $GITHUB_STEP_SUMMARY",
        ),
    ]

    for label, mutate, expected_substring in mutations:
        mutated = mutate(baseline)
        if mutated == baseline:
            print(f"[FAIL] selftest mutation '{label}' produced no change", file=sys.stderr)
            return 1
        errs = check_workflow_text(mutated)
        if not any(expected_substring in e for e in errs):
            print(
                f"[FAIL] selftest mutation '{label}' did not trigger '{expected_substring}' (got {errs})",
                file=sys.stderr,
            )
            return 1

    print(
        f"OK: publish-images.yml valid and {len(mutations)} negative selftest mutations refused."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workflow",
        type=Path,
        default=DEFAULT_WORKFLOW,
        help="Path to publish-images.yml workflow file",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="Run negative mutation self-tests after checking the workflow",
    )
    args = parser.parse_args()

    if not args.workflow.is_file():
        print(f"[FAIL] workflow file not found: {args.workflow}", file=sys.stderr)
        return 1

    text = args.workflow.read_text(encoding="utf-8")
    if args.selftest:
        return run_selftest(text)

    errors = check_workflow_text(text)
    if errors:
        for err in errors:
            print(f"[FAIL] {err}", file=sys.stderr)
        return 1

    print(f"OK: {args.workflow} passed all publish-images workflow checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

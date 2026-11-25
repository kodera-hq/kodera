#!/usr/bin/env python3
"""Refuse a committed .env file, an unpinned GitHub Action, or an unpinned workflow image.

Parses workflow and composite action YAML documents structurally (covering quoted keys,
flow mappings, job-level reusable workflows, step-level actions, job `container` images,
and `services.*.image` entries). Every external action/workflow `uses` must pin a full
40-hex commit SHA (`owner/repo[/path]@<40 hex>`); local `./path` references carry no `@ref`;
every `container` or `services.*.image` reference must pin a `@sha256:<64 hex>` digest.

    python3 scripts/ci/check-workflow-pins.py [--root DIR]
    python3 scripts/ci/check-workflow-pins.py --selftest
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

PINNED_USES = re.compile(r"^[^\s@#]+@[0-9a-f]{40}$")
LOCAL_USES = re.compile(r"^\./[^\s@#]+$")
PINNED_IMAGE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")


def tracked(root: Path) -> list[str]:
    listing = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        check=True,
    )
    return [name for name in listing.stdout.decode().split("\0") if name]


def workflow_files(root: Path, tracked_files: list[str]) -> list[Path]:
    seen = set((root / ".github/workflows").glob("*.y*ml"))
    if (root / ".github/actions").exists():
        seen.update((root / ".github/actions").rglob("*.y*ml"))
    for name in tracked_files:
        p = root / name
        if p.name in {"action.yml", "action.yaml"} and p.is_file():
            seen.add(p)
    return sorted(seen)


def _check_uses(
    value: object, rel: Path, location: str, root: Path, found: list[str]
) -> None:
    if not isinstance(value, str):
        found.append(f"Unpinned GitHub Action in {rel} ({location}): {value!r}")
        return
    if value.startswith("docker://"):
        _check_image(value.removeprefix("docker://"), rel, location, found)
        return
    if LOCAL_USES.match(value):
        local_rel = value.removeprefix("./")
        target = root / local_rel
        if local_rel.startswith(".github/workflows/"):
            if not target.is_file():
                found.append(f"Missing local workflow in {rel} ({location}): {value!r}")
        elif not (
            (target / "action.yml").is_file() or (target / "action.yaml").is_file()
        ):
            found.append(f"Missing local composite action in {rel} ({location}): {value!r}")
        return
    if not PINNED_USES.match(value):
        found.append(f"Unpinned GitHub Action in {rel} ({location}): {value!r}")


def _check_image(value: object, rel: Path, location: str, found: list[str]) -> None:
    if not isinstance(value, str) or not PINNED_IMAGE.match(value):
        found.append(f"Unpinned container image in {rel} ({location}): {value!r}")


def failures(root: Path) -> list[str]:
    tracked_files = tracked(root)
    found = [
        f"Forbidden .env file tracked: {name}"
        for name in tracked_files
        if Path(name).name.startswith(".env") and Path(name).name != ".env.example"
    ]
    for workflow in workflow_files(root, tracked_files):
        rel = workflow.relative_to(root)
        try:
            doc = yaml.safe_load(workflow.read_text("utf-8"))
        except yaml.YAMLError as err:
            found.append(f"Malformed workflow YAML in {rel}: {err}")
            continue
        if not isinstance(doc, dict):
            found.append(f"Workflow YAML root is not a mapping in {rel}")
            continue

        runs = doc.get("runs")
        if isinstance(runs, dict):
            if runs.get("using") == "docker" and "image" in runs:
                raw_img = runs["image"]
                if isinstance(raw_img, str) and raw_img.startswith("docker://"):
                    _check_image(
                        raw_img.removeprefix("docker://"), rel, "runs.image", found
                    )
                elif not (isinstance(raw_img, str) and raw_img in {"Dockerfile", "./Dockerfile"}):
                    _check_image(raw_img, rel, "runs.image", found)
            if isinstance(runs.get("steps"), list):
                for idx, step in enumerate(runs["steps"]):
                    if isinstance(step, dict) and "uses" in step:
                        _check_uses(step["uses"], rel, f"runs.steps[{idx}].uses", root, found)

        jobs = doc.get("jobs")
        if isinstance(jobs, dict):
            for job_id, job in jobs.items():
                if not isinstance(job, dict):
                    continue
                if "uses" in job:
                    _check_uses(job["uses"], rel, f"jobs.{job_id}.uses", root, found)
                if "container" in job and job["container"] is not None:
                    container = job["container"]
                    img = container.get("image") if isinstance(container, dict) else container
                    _check_image(img, rel, f"jobs.{job_id}.container", found)
                services = job.get("services")
                if isinstance(services, dict):
                    for svc_id, svc in services.items():
                        if isinstance(svc, dict) and "image" in svc:
                            _check_image(
                                svc["image"], rel, f"jobs.{job_id}.services.{svc_id}.image", found
                            )
                steps = job.get("steps")
                if isinstance(steps, list):
                    for idx, step in enumerate(steps):
                        if isinstance(step, dict) and "uses" in step:
                            _check_uses(
                                step["uses"], rel, f"jobs.{job_id}.steps[{idx}].uses", root, found
                            )
    return found


def check(root: Path) -> int:
    found = failures(root)
    for failure in found:
        print(f"[FAIL] {failure}", file=sys.stderr)
    if found:
        return 1
    print("All workflows and images SHA-pinned or local, and zero .env files tracked.")
    return 0


SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"
IMG_DIGEST = "dd2bf3ce2dc83a81674cf7f217fcfd8a5009a4b325dda5b843bfee82a06cff6f"
CLEAN = f"""jobs:
  build:
    services:
      postgres:
        image: postgres:16.16@sha256:{IMG_DIGEST}
    steps:
      - uses: actions/checkout@{SHA} # v7.0.1
  call:
    uses: ./.github/workflows/other.yml
"""
CASES = {
    "clean": (CLEAN, None, None),
    "tag pin": (CLEAN.replace(f"@{SHA}", "@v7"), None, "Unpinned GitHub Action"),
    "branch pin": (CLEAN.replace(f"@{SHA}", "@main"), None, "Unpinned GitHub Action"),
    "short sha": (CLEAN.replace(f"@{SHA}", f"@{SHA[:12]}"), None, "Unpinned GitHub Action"),
    "sha with suffix": (CLEAN.replace(f"@{SHA}", f"@{SHA}x"), None, "Unpinned GitHub Action"),
    "no ref": (CLEAN.replace(f"@{SHA}", ""), None, "Unpinned GitHub Action"),
    "quoted uses key": (
        'jobs:\n  build:\n    steps:\n      - "uses": actions/checkout@v4\n',
        None,
        "Unpinned GitHub Action",
    ),
    "flow mapping uses": (
        "jobs:\n  build:\n    steps:\n      - { uses: actions/checkout@v4 }\n",
        None,
        "Unpinned GitHub Action",
    ),
    "unpinned service image": (
        CLEAN.replace(f"@sha256:{IMG_DIGEST}", ""),
        None,
        "Unpinned container image",
    ),
    "unpinned job container": (
        "jobs:\n  build:\n    container: node:22-alpine\n    steps:\n      - run: true\n",
        None,
        "Unpinned container image",
    ),
    "local with ref": (
        CLEAN.replace("other.yml", "other.yml@main"),
        None,
        "Unpinned GitHub Action",
    ),
    "remote reusable workflow by tag": (
        CLEAN.replace("./.github/workflows/other.yml", "acme/ci/.github/workflows/x.yml@v1"),
        None,
        "Unpinned GitHub Action",
    ),
    "tracked .env": (CLEAN, ".env", "Forbidden .env file tracked"),
    "tracked .env.staging": (CLEAN, "deploy/.env.staging", "Forbidden .env file tracked"),
    "tracked .env.example": (CLEAN, "deploy/.env.example", None),
    "unpinned composite outside .github/actions": (
        CLEAN,
        ("tools/custom-action/action.yml", "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n"),
        "Unpinned GitHub Action",
    ),
    "unpinned docker action runs.image": (
        CLEAN,
        (".github/actions/docker-act/action.yml", "runs:\n  using: docker\n  image: docker://alpine:3.20\n"),
        "Unpinned container image",
    ),
}


def selftest() -> int:
    caught = 0
    for name, (text, extra, marker) in CASES.items():
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/workflows/ci.yml").write_text(text)
            (root / ".github/workflows/other.yml").write_text("jobs:\n  noop:\n    steps:\n      - run: true\n")
            if isinstance(extra, tuple):
                rel_path, extra_body = extra
                (root / rel_path).parent.mkdir(parents=True, exist_ok=True)
                (root / rel_path).write_text(extra_body)
            elif extra:
                (root / extra).parent.mkdir(parents=True, exist_ok=True)
                (root / extra).write_text("K=v\n")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "-A", "-f"], check=True)
            found = failures(root)
            if marker is None:
                if found:
                    print(
                        f"selftest FAIL [{name}]: expected clean, got {found}",
                        file=sys.stderr,
                    )
                    return 1
            else:
                if len(found) != 1 or marker not in found[0]:
                    print(
                        f"selftest FAIL [{name}]: expected one '{marker}', got {found}",
                        file=sys.stderr,
                    )
                    return 1
                caught += 1
            print(f"  ok  {name}")
    print(
        f"check-workflow-pins selftest: {len(CASES)} cases, {caught} refusals each by its own message"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=Path(__file__).resolve().parents[2], type=Path)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    return selftest() if args.selftest else check(args.root)


if __name__ == "__main__":
    sys.exit(main())

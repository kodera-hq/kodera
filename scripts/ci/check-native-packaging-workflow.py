#!/usr/bin/env python3
"""Refuse a native package workflow that can bypass or misbind artifact verification."""

from __future__ import annotations

import argparse
import copy
import io
import re
import shlex
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import yaml

DEFAULT = Path(__file__).resolve().parents[2] / ".github/workflows/native-package-gate.yml"
COMMAND = [
    "python3",
    "scripts/ci/check-native-packaging.py",
    "--first",
    "candidate/first/package.zip",
    "--second",
    "candidate/second/package.zip",
    "--sbom",
    "candidate/sbom.cdx.json",
    "--evidence",
    "candidate/evidence.json",
    "--toolchain",
    "candidate/toolchain-lock.json",
    "--revision",
    "$EXPECTED_REVISION",
    "--target",
    "$PACKAGE_TARGET",
]


class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        result = {}
        for key, value in node.value:
            name = self.construct_object(key, deep=deep)
            if name in result:
                raise ValueError("duplicate workflow key")
            result[name] = self.construct_object(value, deep=deep)
        return result


def problems(doc):
    errors = []

    def expect(condition, marker):
        if not condition:
            errors.append(marker)

    if not isinstance(doc, dict):
        return ["native package workflow must be an object"]
    expect(
        set(doc) <= {"name", "on", True, "permissions", "jobs"},
        "unexpected native workflow root field",
    )
    triggers = doc.get("on", doc.get(True))
    expect(
        isinstance(triggers, dict) and set(triggers) == {"workflow_call"},
        "native gate must be reusable only",
    )
    call = triggers.get("workflow_call") if isinstance(triggers, dict) else None
    expected_inputs = {
        "bundle-name": {"required": True, "type": "string"},
        "target": {"required": True, "type": "string"},
    }
    inputs = call.get("inputs") if isinstance(call, dict) else None
    expect(
        isinstance(call, dict) and set(call) == {"inputs"},
        "native gate must not inherit secrets or extra inputs",
    )
    expect(
        isinstance(inputs, dict)
        and set(inputs) == set(expected_inputs)
        and all(
            isinstance(inputs[key], dict)
            and {k: v for k, v in inputs[key].items() if k != "description"} == expected_inputs[key]
            for key in expected_inputs
        ),
        "native gate inputs must be required strings",
    )
    expect(
        doc.get("permissions") == {"contents": "read", "actions": "read"},
        "native gate permissions must remain read-only",
    )
    jobs = doc.get("jobs")
    expect(
        isinstance(jobs, dict) and set(jobs) == {"verify"},
        "native gate requires exactly one verification job",
    )
    job = jobs.get("verify") if isinstance(jobs, dict) else None
    if not isinstance(job, dict):
        return errors + ["native verification job is missing"]
    expect(
        set(job) == {"name", "runs-on", "timeout-minutes", "steps"}
        and job.get("runs-on") == "ubuntu-latest"
        and job.get("timeout-minutes") == 10,
        "native verification job cannot skip, soften or widen its execution",
    )
    steps = job.get("steps")
    if (
        not isinstance(steps, list)
        or len(steps) != 3
        or not all(isinstance(step, dict) for step in steps)
    ):
        return errors + [
            "native gate requires checkout, current-run download and mandatory verification"
        ]
    checkout, download, verify = steps
    expect(
        set(checkout) == {"uses", "with"}
        and isinstance(checkout.get("uses"), str)
        and re.fullmatch(r"actions/checkout@[0-9a-f]{40}", checkout["uses"])
        and checkout.get("with") == {"ref": "${{ github.sha }}", "persist-credentials": False},
        "native gate must check out its exact caller revision without credentials",
    )
    expect(
        set(download) == {"uses", "with"}
        and isinstance(download.get("uses"), str)
        and re.fullmatch(r"actions/download-artifact@[0-9a-f]{40}", download["uses"])
        and download.get("with") == {"name": "${{ inputs.bundle-name }}", "path": "candidate"},
        "native gate must download one current-run artifact into its fixed directory",
    )
    try:
        command = shlex.split(str(verify.get("run", "")).replace("\\\n", ""))
    except ValueError:
        command = []
    expect(
        set(verify) == {"name", "env", "run"}
        and verify.get("env")
        == {"EXPECTED_REVISION": "${{ github.sha }}", "PACKAGE_TARGET": "${{ inputs.target }}"}
        and command == COMMAND,
        "native gate must run the unmasked verifier with fixed evidence paths and trusted revision",
    )
    return errors


def check(path):
    try:
        document = yaml.load(path.read_text(), Loader=UniqueLoader)
        errors = problems(document)
    except (OSError, UnicodeError, yaml.YAMLError, ValueError, TypeError, RecursionError):
        errors = ["native workflow YAML is unreadable or ambiguous"]
    for error in errors:
        print("native workflow refused: " + error, file=sys.stderr)
    if not errors:
        print("native package workflow binds current-run candidates to its exact revision")
    return int(bool(errors))


def selftest(path):
    baseline = yaml.load(path.read_text(), Loader=UniqueLoader)
    assert not problems(baseline), problems(baseline)
    trigger_key = "on" if "on" in baseline else True
    mutations = [
        ("publish trigger", lambda d: d.__setitem__(trigger_key, {"push": None}), "reusable only"),
        (
            "write permissions",
            lambda d: d["permissions"].__setitem__("contents", "write"),
            "read-only",
        ),
        (
            "inherited secret input",
            lambda d: d[trigger_key]["workflow_call"].__setitem__("secrets", "inherit"),
            "inherit secrets",
        ),
        (
            "optional bundle",
            lambda d: d[trigger_key]["workflow_call"]["inputs"]["bundle-name"].__setitem__(
                "required", False
            ),
            "required strings",
        ),
        ("skip job", lambda d: d["jobs"]["verify"].__setitem__("if", "false"), "cannot skip"),
        (
            "soften job",
            lambda d: d["jobs"]["verify"].__setitem__("continue-on-error", True),
            "cannot skip",
        ),
        ("remove verifier", lambda d: d["jobs"]["verify"]["steps"].pop(), "mandatory verification"),
        (
            "mutable checkout",
            lambda d: d["jobs"]["verify"]["steps"][0]["with"].__setitem__("ref", "main"),
            "exact caller revision",
        ),
        (
            "tag-pinned download",
            lambda d: d["jobs"]["verify"]["steps"][1].__setitem__(
                "uses", "actions/download-artifact@v7"
            ),
            "current-run artifact",
        ),
        (
            "cross-run download",
            lambda d: d["jobs"]["verify"]["steps"][1]["with"].__setitem__("run-id", 123),
            "current-run artifact",
        ),
        (
            "wildcard download",
            lambda d: d["jobs"]["verify"]["steps"][1]["with"].__setitem__("pattern", "*"),
            "current-run artifact",
        ),
        (
            "wrong expected revision",
            lambda d: d["jobs"]["verify"]["steps"][2]["env"].__setitem__(
                "EXPECTED_REVISION", "main"
            ),
            "trusted revision",
        ),
        (
            "mask failure",
            lambda d: d["jobs"]["verify"]["steps"][2].__setitem__(
                "run", d["jobs"]["verify"]["steps"][2]["run"] + " || true"
            ),
            "unmasked verifier",
        ),
        (
            "shell input interpolation",
            lambda d: d["jobs"]["verify"]["steps"][2].__setitem__(
                "run",
                d["jobs"]["verify"]["steps"][2]["run"].replace(
                    "$PACKAGE_TARGET", "${{ inputs.target }}"
                ),
            ),
            "unmasked verifier",
        ),
    ]
    for name, mutate, marker in mutations:
        document = copy.deepcopy(baseline)
        mutate(document)
        with tempfile.TemporaryDirectory(prefix="native-workflow-mutation-") as scratch:
            fixture = Path(scratch) / "workflow.yml"
            fixture.write_text(yaml.safe_dump(document))
            output, error = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(error):
                status = check(fixture)
            assert status == 1 and marker in error.getvalue() and output.getvalue() == "", name
        print("  ok refused:", name, "(", marker, ")")
    print(f"native workflow self-test passed: {len(mutations)} named mutations")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow", type=Path, default=DEFAULT)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    return selftest(args.workflow) if args.selftest else check(args.workflow)


if __name__ == "__main__":
    sys.exit(main())

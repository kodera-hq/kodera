#!/usr/bin/env python3
"""Refuse a CI wiring in which a job can fail without turning `ci-ok` red.

Branch protection requires `ci-ok` alone (with the security workflow), so a
job outside its `needs`, a `ci-ok` that does not run after a failure, or an
area workflow that also triggers on its own (and so is never aggregated) would
let a red job merge. This reads the workflows as YAML, never as text.

    python3 scripts/ci/check-ci-aggregate.py [--root DIR]
    python3 scripts/ci/check-ci-aggregate.py --selftest
"""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ".github/workflows"
ORCHESTRATOR = "ci.yml"
AGGREGATE = "ci-ok"
# The plan's outputs must match these areas (scripts/ci/ci-plan.py AREAS).
AREAS = {"server", "web", "rust", "mobile"}


def triggers(doc: dict) -> dict:
    # PyYAML reads the bare key `on` as the boolean True.
    value = doc.get("on", doc.get(True))
    if isinstance(value, str):
        return {value: None}
    if isinstance(value, list):
        return dict.fromkeys(value)
    return value or {}


def check(orchestrator: dict, area_docs: dict[str, dict]) -> list[str]:
    problems: list[str] = []
    jobs: dict = orchestrator.get("jobs") or {}
    ok = jobs.get(AGGREGATE)
    if ok is None:
        return [f"`{AGGREGATE}` job is missing from {ORCHESTRATOR}"]
    if str(ok.get("if", "")).replace(" ", "") not in ("always()", "${{always()}}"):
        problems.append(f"`{AGGREGATE}` must run `if: always()`, or a failure upstream skips it")
    needs = ok.get("needs") or []
    needs = [needs] if isinstance(needs, str) else list(needs)
    for name in jobs:
        if name != AGGREGATE and name not in needs:
            problems.append(f"job `{name}` is not in `{AGGREGATE}` needs")
    steps = ok.get("steps") or []
    script = "\n".join(str(step.get("run", "")) for step in steps)
    for needle in ('"success", "skipped"', "sys.exit"):
        if needle not in script:
            problems.append(f"`{AGGREGATE}` no longer judges every result ({needle!r} missing)")
    if "toJSON(needs)" not in str((steps[0] if steps else {}).get("env", {})):
        problems.append(f"`{AGGREGATE}` does not read the results of its needs")
    pull_request = triggers(orchestrator).get("pull_request") or {}
    if "synchronize" not in (pull_request.get("types") or []):
        problems.append(f"{ORCHESTRATOR} must run on every push to a pull request")

    for event in ("labeled", "unlabeled"):
        if event not in (pull_request.get("types") or []):
            problems.append(f"{ORCHESTRATOR} must rerun label-sensitive gates on {event}")

    plan = jobs.get("plan") or {}
    native_proofs = [
        "python3 scripts/ci/check-native-packaging.selftest.py",
        '"$RUNNER_TEMP/ci-tools/bin/python" scripts/ci/check-native-packaging-workflow.py --selftest',
        '"$RUNNER_TEMP/ci-tools/bin/python" scripts/ci/check-native-packaging-workflow.py',
    ]
    if not any(
        set(step) == {"name", "run"}
        and [line.strip() for line in str(step.get("run", "")).splitlines() if line.strip()] == native_proofs
        for step in plan.get("steps", [])
    ):
        problems.append("native packaging and workflow refusal proofs must be mandatory in plan")
    outputs = set((plan.get("outputs") or {}).keys())
    if outputs != AREAS:
        problems.append(f"plan outputs {sorted(outputs)} differ from the areas {sorted(AREAS)}")

    called: set[str] = set()
    for name, job in jobs.items():
        uses = job.get("uses")
        if uses is None:
            continue
        target = str(uses).removeprefix(f"./{WORKFLOWS}/")
        called.add(target)
        if target not in area_docs:
            problems.append(f"job `{name}` calls {uses}, which does not exist")
        condition = str(job.get("if", ""))
        if "needs.plan.outputs." not in condition:
            problems.append(f"job `{name}` is not gated by the plan")
    for filename, doc in sorted(area_docs.items()):
        if filename not in called:
            problems.append(f"{filename} is a CI area that {ORCHESTRATOR} never calls")
        on = triggers(doc)
        if set(on) != {"workflow_call"}:
            problems.append(
                f"{filename} must trigger only on workflow_call (has {sorted(map(str, on))}): "
                "run on its own, it is never aggregated"
            )
    http_job = ((area_docs.get("ci-server.yml") or {}).get("jobs") or {}).get("http-image-acceptance")
    if not isinstance(http_job, dict):
        problems.append("server HTTP image acceptance job is missing")
    else:
        if "if" in http_job or http_job.get("continue-on-error", False) is not False:
            problems.append("server HTTP image acceptance must be mandatory")
        required = [
            "uv run python dev/accept_production_http.py",
            "uv run python dev/accept_bootstrap_http.py",
        ]
        if not any(
            step.get("working-directory") == "apps/server"
            and "if" not in step
            and step.get("continue-on-error", False) is False
            and [line.strip() for line in str(step.get("run", "")).splitlines() if line.strip()] == required
            for step in http_job.get("steps", [])
        ):
            problems.append("server HTTP image acceptance must run both unmasked proofs")
    coldstart = ((area_docs.get("ci-server.yml") or {}).get("jobs") or {}).get("community-coldstart")
    if not isinstance(coldstart, dict):
        problems.append("Community cold-start acceptance job is missing")
    else:
        if "if" in coldstart or coldstart.get("continue-on-error", False) is not False:
            problems.append("Community cold-start acceptance must be mandatory")
        required = {
            "uv run --no-project --python 3.12 python -m unittest discover -s deploy/community -p test_coldstart_acceptance.py",
            "uv run --no-project --python 3.12 python deploy/community/accept_coldstart.py",
        }
        admitted = {step.get("run") for step in coldstart.get("steps", [])
                    if "if" not in step and step.get("continue-on-error", False) is False}
        if not required <= admitted:
            problems.append("Community cold-start acceptance requires both unmasked controller proofs")
    return problems


def load(root: Path) -> tuple[dict, dict[str, dict]]:
    folder = root / WORKFLOWS
    orchestrator = yaml.safe_load((folder / ORCHESTRATOR).read_text())
    areas = {p.name: yaml.safe_load(p.read_text()) for p in sorted(folder.glob("ci-*.yml"))}
    if not areas:
        sys.exit(f"check-ci-aggregate: no {WORKFLOWS}/ci-*.yml found: could not look")
    return orchestrator, areas


def selftest(root: Path) -> None:
    base_orch, base_areas = load(root)
    if check(base_orch, base_areas):
        sys.exit("check-ci-aggregate selftest: the unmodified tree must pass first")

    def drop_need(o, a):
        o["jobs"][AGGREGATE]["needs"].remove("web")

    def drop_always(o, a):
        o["jobs"][AGGREGATE].pop("if")

    def add_job(o, a):
        o["jobs"]["extra"] = {"runs-on": "ubuntu-latest", "steps": []}

    def area_push(o, a):
        a["ci-web.yml"]["on"] = {"workflow_call": None, "pull_request": None}
        a["ci-web.yml"].pop(True, None)

    def uncalled(o, a):
        o["jobs"].pop("mobile")
        o["jobs"][AGGREGATE]["needs"].remove("mobile")

    def missing_target(o, a):
        o["jobs"]["web"]["uses"] = "./.github/workflows/ci-webz.yml"

    def ungated(o, a):
        o["jobs"]["server"].pop("if")

    def lax_judge(o, a):
        o["jobs"][AGGREGATE]["steps"][0]["run"] = "echo ok"

    def plan_output(o, a):
        o["jobs"]["plan"]["outputs"].pop("rust")

    def no_sync(o, a):
        triggers(o)["pull_request"]["types"] = ["opened"]

    def no_label(o, a):
        triggers(o)["pull_request"]["types"].remove("labeled")

    def no_unlabel(o, a):
        triggers(o)["pull_request"]["types"].remove("unlabeled")

    def missing_http_job(o, a):
        a["ci-server.yml"]["jobs"].pop("http-image-acceptance")

    def missing_bootstrap_proof(o, a):
        a["ci-server.yml"]["jobs"]["http-image-acceptance"]["steps"][-1]["run"] = "uv run python dev/accept_production_http.py"

    def soft_http_failure(o, a):
        a["ci-server.yml"]["jobs"]["http-image-acceptance"]["continue-on-error"] = True

    def skipped_http_job(o, a):
        a["ci-server.yml"]["jobs"]["http-image-acceptance"]["if"] = "false"

    def missing_coldstart(o, a):
        a["ci-server.yml"]["jobs"].pop("community-coldstart")

    def soft_coldstart(o, a):
        a["ci-server.yml"]["jobs"]["community-coldstart"]["continue-on-error"] = True

    def skipped_coldstart(o, a):
        a["ci-server.yml"]["jobs"]["community-coldstart"]["if"] = "false"

    def masked_coldstart(o, a):
        a["ci-server.yml"]["jobs"]["community-coldstart"]["steps"][-1]["run"] += " || true"

    def native_proof_step(o):
        return next(step for step in o["jobs"]["plan"]["steps"]
                    if "check-native-packaging.selftest.py" in str(step.get("run", "")))

    def missing_native_proof(o, a):
        step = native_proof_step(o)
        step["run"] = step["run"].replace("python3 scripts/ci/check-native-packaging.selftest.py", "echo omitted")

    def masked_native_proof(o, a):
        step = native_proof_step(o)
        step["run"] = step["run"].replace("python3 scripts/ci/check-native-packaging.selftest.py", "python3 scripts/ci/check-native-packaging.selftest.py || true")

    def skipped_native_proof(o, a):
        native_proof_step(o)["if"] = "false"

    cases = [
        (missing_coldstart, "Community cold-start acceptance job is missing"),
        (soft_coldstart, "Community cold-start acceptance must be mandatory"),
        (skipped_coldstart, "Community cold-start acceptance must be mandatory"),
        (masked_coldstart, "Community cold-start acceptance requires both unmasked controller proofs"),
        (missing_native_proof, "native packaging and workflow refusal proofs must be mandatory"),
        (masked_native_proof, "native packaging and workflow refusal proofs must be mandatory"),
        (skipped_native_proof, "native packaging and workflow refusal proofs must be mandatory"),
        (missing_http_job, "server HTTP image acceptance job is missing"),
        (missing_bootstrap_proof, "server HTTP image acceptance must run both unmasked proofs"),
        (soft_http_failure, "server HTTP image acceptance must be mandatory"),
        (skipped_http_job, "server HTTP image acceptance must be mandatory"),
        (drop_need, "job `web` is not in `ci-ok` needs"),
        (drop_always, "must run `if: always()`"),
        (add_job, "job `extra` is not in `ci-ok` needs"),
        (area_push, "ci-web.yml must trigger only on workflow_call"),
        (uncalled, "ci-mobile.yml is a CI area that ci.yml never calls"),
        (missing_target, "calls ./.github/workflows/ci-webz.yml, which does not exist"),
        (ungated, "job `server` is not gated by the plan"),
        (lax_judge, "no longer judges every result"),
        (plan_output, "plan outputs"),
        (no_sync, "must run on every push to a pull request"),
        (no_label, "must rerun label-sensitive gates on labeled"),
        (no_unlabel, "must rerun label-sensitive gates on unlabeled"),
    ]
    failed = []
    for mutate, expected in cases:
        orch, areas = copy.deepcopy(base_orch), copy.deepcopy(base_areas)
        mutate(orch, areas)
        problems = check(orch, areas)
        if not any(expected in p for p in problems):
            failed.append(f"{mutate.__name__}: expected {expected!r}, got {problems}")
    if failed:
        sys.exit("check-ci-aggregate selftest FAILED:\n  " + "\n  ".join(failed))
    print(f"OK: check-ci-aggregate refused {len(cases)} mutations, each by its own message")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest(args.root)
        return
    problems = check(*load(args.root))
    if problems:
        sys.exit("check-ci-aggregate:\n  " + "\n  ".join(problems))
    print("OK: every CI job is aggregated by ci-ok, and every area runs only through ci.yml")


if __name__ == "__main__":
    main()

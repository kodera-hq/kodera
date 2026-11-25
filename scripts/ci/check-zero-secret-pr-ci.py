#!/usr/bin/env python3
"""Enforce zero custom context credentials on pull_request, merge_group, ci.yml, and composite actions.

Also verifies that root CONTRIBUTING.md carries `Status: Active`, zero calendar
dates, and zero IPv4 literals.

    python3 scripts/ci/check-zero-secret-pr-ci.py
    python3 scripts/ci/check-zero-secret-pr-ci.py --selftest
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
TRUSTED_ONLY_EVENTS = {"push", "workflow_dispatch", "workflow_call"}
READ_ONLY_PERMISSION_LEVELS = {"read", "none"}
PERMITTED_CI_REF_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\bsecrets\s*\.\s*github_token\b(?!\s*[\.\[A-Za-z0-9_])",
    re.IGNORECASE,
)
CONTEXT_IDENT_RE = re.compile(r"(?<![A-Za-z0-9_.])\bsecrets\b", re.IGNORECASE)
CONTEXT_DOT_RE = re.compile(r"\bsecrets\s*\.\s*[A-Za-z_][A-Za-z0-9_]*", re.IGNORECASE)
CONTEXT_INDEX_RE = re.compile(r"\bsecrets\s*\[\s*['\"]?[^'\"\]]*['\"]?\s*\]", re.IGNORECASE)
CONTEXT_JSON_RE = re.compile(r"\btoJSON\s*\([\s(]*secrets[\s)]*\)", re.IGNORECASE)
CALENDAR_DATE_RE = re.compile(r"\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b")
IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")

VIOLATION_DESCRIPTIONS: dict[str, str] = {
    "dot_ref": "disallowed repository context property reference",
    "index_ref": "disallowed bracketed repository context lookup",
    "json_dump": "disallowed serialized repository context dump",
    "bare_ctx": "disallowed bare repository context expression",
}


def workflow_triggers(doc: dict) -> set[str]:
    on_block = doc.get("on") if "on" in doc else doc.get(True)
    if isinstance(on_block, str):
        return {on_block}
    if isinstance(on_block, list):
        return {str(item) for item in on_block}
    if isinstance(on_block, dict):
        return {str(entry) for entry in on_block.keys()}
    return set()


def strip_single_quoted_literals(expr: str) -> str:
    """Strip GitHub Actions single-quoted `'...'` literals (supporting `''` escapes)."""
    out: list[str] = []
    idx = 0
    n = len(expr)
    while idx < n:
        ch = expr[idx]
        if ch == "'":
            out.append("''")
            idx += 1
            closed = False
            while idx < n:
                if expr[idx] == "'":
                    if idx + 1 < n and expr[idx + 1] == "'":
                        idx += 2
                        continue
                    idx += 1
                    closed = True
                    break
                idx += 1
            if not closed:
                return expr
            continue
        out.append(ch)
        idx += 1
    return "".join(out)


def extract_gha_expressions(text: str, *, is_if_condition: bool = False) -> list[tuple[str, str]]:
    """Return `(raw_expr, stripped_expr)` pairs for every `${{ ... }}` block (plus bare `if:`)."""
    results: list[tuple[str, str]] = []
    idx = 0
    n = len(text)
    saw_delim = False
    while idx < n:
        start = text.find("${{", idx)
        if start == -1:
            break
        saw_delim = True
        pos = start + 3
        in_quote = False
        closed = False
        while pos < n:
            ch = text[pos]
            if in_quote:
                if ch == "'":
                    if pos + 1 < n and text[pos + 1] == "'":
                        pos += 2
                        continue
                    in_quote = False
                pos += 1
                continue
            if ch == "'":
                in_quote = True
                pos += 1
                continue
            if ch == "}" and pos + 1 < n and text[pos + 1] == "}":
                raw_expr = text[start + 3 : pos]
                results.append((raw_expr.strip(), strip_single_quoted_literals(raw_expr)))
                idx = pos + 2
                closed = True
                break
            pos += 1
        if not closed:
            raw_expr = text[start + 3 :]
            results.append((raw_expr.strip(), raw_expr))
            break
    if is_if_condition and not saw_delim and text.strip():
        results.append((text.strip(), strip_single_quoted_literals(text)))
    return results


def collect_yaml_string_nodes(
    node: object, *, field_name: str = "", trail: str = "root"
) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []
    if isinstance(node, str):
        out.append((node, field_name == "if", trail))
    elif isinstance(node, dict):
        for map_entry, val in node.items():
            entry_name = str(map_entry) if isinstance(map_entry, str) else ""
            sub_trail = f"{trail}.{entry_name}" if entry_name else trail
            if isinstance(map_entry, str):
                out.append((map_entry, False, sub_trail))
            out.extend(collect_yaml_string_nodes(val, field_name=entry_name, trail=sub_trail))
    elif isinstance(node, list):
        for idx, item in enumerate(node):
            out.extend(
                collect_yaml_string_nodes(item, field_name=field_name, trail=f"{trail}[{idx}]")
            )
    return out


def classify_expr_kind(raw_expr: str, sanitized: str) -> str:
    if CONTEXT_DOT_RE.search(sanitized):
        return "dot_ref"
    if CONTEXT_INDEX_RE.search(raw_expr):
        return "index_ref"
    if CONTEXT_JSON_RE.search(sanitized):
        return "json_dump"
    return "bare_ctx"


def find_forbidden_expr_kinds(doc: dict) -> list[tuple[str, str]]:
    """Return `(yaml_trail, violation_kind)` pairs without capturing raw expression values."""
    found_refs: list[tuple[str, str]] = []
    for text, is_if, trail in collect_yaml_string_nodes(doc):
        if "${{" not in text and not is_if:
            continue
        for raw_expr, stripped_expr in extract_gha_expressions(text, is_if_condition=is_if):
            sanitized = PERMITTED_CI_REF_RE.sub("__PERMITTED_CI_REF__", stripped_expr)
            if CONTEXT_IDENT_RE.search(sanitized):
                kind = classify_expr_kind(raw_expr, sanitized)
                pair = (trail, kind)
                if pair not in found_refs:
                    found_refs.append(pair)
    return found_refs


def resolve_isolated_workflows(docs_by_name: dict[str, dict]) -> set[str]:
    protected: set[str] = set()
    for wf_name, doc in docs_by_name.items():
        if wf_name == "ci.yml" or bool(workflow_triggers(doc) - TRUSTED_ONLY_EVENTS):
            protected.add(wf_name)
    changed = True
    while changed:
        changed = False
        for wf_name in list(protected):
            jobs = (docs_by_name.get(wf_name) or {}).get("jobs") or {}
            if not isinstance(jobs, dict):
                continue
            for job in jobs.values():
                if not isinstance(job, dict):
                    continue
                uses = str(job.get("uses", "")).strip()
                callee = ""
                prefix = "./.github/workflows/"
                if uses.startswith(prefix):
                    callee = uses[len(prefix) :].split("@", 1)[0]
                elif "/.github/workflows/" in uses:
                    repo_prefix, rest = uses.split("/.github/workflows/", 1)
                    if repo_prefix in {"kodera-hq/kodera", "${{ github.repository }}"}:
                        callee = rest.split("@", 1)[0]
                if callee and callee in docs_by_name and callee not in protected:
                    protected.add(callee)
                    changed = True
    return protected


def check_composite_actions(root: Path) -> list[str]:
    diagnostics: list[str] = []
    skipped = {".git", "node_modules", ".venv", "target"}
    for action_file in sorted(root.rglob("action.y*ml")):
        if not action_file.is_file() or any(part in skipped for part in action_file.relative_to(root).parts):
            continue
        rel = action_file.relative_to(root).as_posix()
        doc = yaml.safe_load(action_file.read_text(encoding="utf-8")) or {}
        if not isinstance(doc, dict):
            continue
        for trail, kind in find_forbidden_expr_kinds(doc):
            desc = VIOLATION_DESCRIPTIONS[kind]
            diagnostics.append(
                f"composite action `{rel}` at `{trail}` contains {desc} (untrusted PR CI policy)"
            )
    return diagnostics


def check_repo(root: Path) -> list[str]:
    diagnostics: list[str] = []
    workflows_dir = root / ".github/workflows"
    if not workflows_dir.is_dir():
        return ["missing workflows directory `.github/workflows`"]
    files = sorted(workflows_dir.glob("*.y*ml"))
    if not files:
        return ["no workflow files found under `.github/workflows`"]

    docs_by_name: dict[str, dict] = {}
    for wf in files:
        docs_by_name[wf.name] = yaml.safe_load(wf.read_text(encoding="utf-8")) or {}

    for wf in files:
        doc = docs_by_name[wf.name]
        if "pull_request_target" in workflow_triggers(doc):
            diagnostics.append(
                f"workflow `{wf.name}` must never use `pull_request_target` (untrusted PR CI policy)"
            )

    protected = resolve_isolated_workflows(docs_by_name)
    for wf in files:
        if wf.name not in protected:
            continue
        doc = docs_by_name[wf.name]
        on_block = doc.get("on") if "on" in doc else doc.get(True)
        if isinstance(on_block, dict):
            wf_call = on_block.get("workflow_call")
            if isinstance(wf_call, dict) and wf_call.get("secrets"):
                diagnostics.append(
                    f"workflow `{wf.name}` is invoked on pull_request/merge_group CI and must not declare `workflow_call` context inputs"
                )
        top_perms = doc.get("permissions")
        if not isinstance(top_perms, dict) or not top_perms:
            diagnostics.append(
                f"workflow `{wf.name}` must declare an explicit read-only top-level `permissions` mapping"
            )
        else:
            for scope_name, level in top_perms.items():
                if str(scope_name) == "id-token" and str(level) != "none":
                    diagnostics.append(
                        f"workflow `{wf.name}` must not grant `id-token` permission on PR-reachable CI"
                    )
                elif str(level) not in READ_ONLY_PERMISSION_LEVELS:
                    diagnostics.append(
                        f"workflow `{wf.name}` top-level permission `{scope_name}: {level}` must be read-only"
                    )
        for trail, kind in find_forbidden_expr_kinds(doc):
            desc = VIOLATION_DESCRIPTIONS[kind]
            diagnostics.append(
                f"workflow `{wf.name}` at `{trail}` contains {desc} (untrusted PR CI policy)"
            )
        jobs = doc.get("jobs") or {}
        if isinstance(jobs, dict):
            for job_id, job in jobs.items():
                if not isinstance(job, dict):
                    continue
                if "permissions" in job:
                    job_perms = job.get("permissions")
                    if not isinstance(job_perms, dict):
                        diagnostics.append(
                            f"workflow `{wf.name}` job `{job_id}` permissions must be an explicit read-only mapping"
                        )
                    else:
                        for scope_name, level in job_perms.items():
                            if str(scope_name) == "id-token" and str(level) != "none":
                                diagnostics.append(
                                    f"workflow `{wf.name}` job `{job_id}` must not grant `id-token` permission on PR-reachable CI"
                                )
                            elif str(level) not in READ_ONLY_PERMISSION_LEVELS:
                                diagnostics.append(
                                    f"workflow `{wf.name}` job `{job_id}` permission `{scope_name}: {level}` must be read-only"
                                )
                inherited_cfg = job.get("secrets")
                if inherited_cfg == "inherit":
                    diagnostics.append(
                        f"workflow `{wf.name}` job `{job_id}` must never inherit caller context on pull_request/merge_group CI"
                    )
                elif isinstance(inherited_cfg, dict) and inherited_cfg:
                    diagnostics.append(
                        f"workflow `{wf.name}` job `{job_id}` must not pass custom context mappings on pull_request/merge_group CI"
                    )

    diagnostics.extend(check_composite_actions(root))

    contributing = root / "CONTRIBUTING.md"
    if not contributing.is_file():
        diagnostics.append("missing root `CONTRIBUTING.md`")
    else:
        text = contributing.read_text(encoding="utf-8")
        if "Status: Active" not in text:
            diagnostics.append("`CONTRIBUTING.md` must carry `Status: Active`")
        if CALENDAR_DATE_RE.search(text):
            diagnostics.append("`CONTRIBUTING.md` must not contain calendar dates")
        if IPV4_RE.search(text):
            diagnostics.append("`CONTRIBUTING.md` must not contain IPv4 literals")

    return diagnostics


def run_selftest() -> int:
    baseline = check_repo(REPO_ROOT)
    if baseline:
        for item in baseline:
            print(f"FAIL baseline: {item}", file=sys.stderr)
        return 1

    # Verify benign single-quoted `'...secrets...'` literal and default GITHUB_TOKEN are allowed.
    benign_doc = {
        "on": {"pull_request": {}},
        "jobs": {
            "ok": {
                "if": "${{ 'secrets and }} in literal''s text' != '' }}",
                "steps": [{"env": {"GH_REF": "${{ secrets.GITHUB_TOKEN }}"}}],
            }
        },
    }
    if find_forbidden_expr_kinds(benign_doc):
        print(
            "FAIL selftest: benign quoted literal or permitted CI reference was rejected",
            file=sys.stderr,
        )
        return 1

    def mutate_ci_custom_prop(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  leak-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.SCW_PROBE_VAR }}\n",
            encoding="utf-8",
        )

    def mutate_ci_vault_prop(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  vault-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.VAULT_PROBE_VAR }}\n",
            encoding="utf-8",
        )

    def mutate_ci_bracket_lookup(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  bracket-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets['AGE_PROBE_VAR'] }}\n",
            encoding="utf-8",
        )

    def mutate_ci_tojson_dump(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  tojson-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo '${{ toJSON(secrets) }}'\n",
            encoding="utf-8",
        )

    def mutate_ci_bare_context(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  bare-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          DUMP: ${{ secrets }}\n        run: true\n",
            encoding="utf-8",
        )

    def mutate_ci_grouped_tojson_dump(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  grouped-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          DUMP: ${{ toJSON((secrets)) }}\n        run: true\n",
            encoding="utf-8",
        )

    def mutate_pull_request_target(tree: Path) -> None:
        (tree / ".github/workflows/prt-probe.yml").write_text(
            "name: PRT Probe\non:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
            encoding="utf-8",
        )

    def mutate_composite_action_prop(tree: Path) -> None:
        act = tree / ".github/actions/leak/action.yml"
        act.parent.mkdir(parents=True, exist_ok=True)
        act.write_text(
            "name: Leak Action\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ${{ secrets.COMPOSITE_PROBE_VAR }}\n",
            encoding="utf-8",
        )

    def mutate_merge_group_prop(tree: Path) -> None:
        (tree / ".github/workflows/merge-queue-probe.yml").write_text(
            "name: Merge Queue Probe\non:\n  merge_group:\npermissions:\n  contents: read\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.MERGE_PROBE_VAR }}\n",
            encoding="utf-8",
        )

    def mutate_callee_prop(tree: Path) -> None:
        p = tree / ".github/workflows/ci-server.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n      - name: Leak\n        run: echo ${{ secrets.CALLEE_PROBE_VAR }}\n",
            encoding="utf-8",
        )

    def mutate_context_inherit(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8").replace(
                "uses: ./.github/workflows/ci-server.yml\n",
                "uses: ./.github/workflows/ci-server.yml\n    secrets: inherit\n",
                1,
            ),
            encoding="utf-8",
        )

    def mutate_workflow_call_declares_input(tree: Path) -> None:
        p = tree / ".github/workflows/ci-server.yml"
        p.write_text(
            p.read_text(encoding="utf-8").replace(
                "  workflow_call:\n",
                "  workflow_call:\n    secrets:\n      DEPLOY_PROBE:\n        required: false\n",
                1,
            ),
            encoding="utf-8",
        )

    def mutate_contributing_ipv4(tree: Path) -> None:
        p = tree / "CONTRIBUTING.md"
        p.write_text(p.read_text(encoding="utf-8") + "\nHost: 192.0.2.10\n", encoding="utf-8")

    def mutate_contributing_date(tree: Path) -> None:
        p = tree / "CONTRIBUTING.md"
        p.write_text(p.read_text(encoding="utf-8") + "\nUpdated: 2026-11-24\n", encoding="utf-8")

    def mutate_workflow_run_secret(tree: Path) -> None:
        (tree / ".github/workflows/wf-run-probe.yml").write_text(
            "name: WF Run Probe\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: read\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.WF_RUN_SECRET }}\n",
            encoding="utf-8",
        )

    def mutate_issue_comment_write_perm(tree: Path) -> None:
        (tree / ".github/workflows/comment-probe.yml").write_text(
            "name: Comment Probe\non:\n  issue_comment:\npermissions:\n  contents: write\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
            encoding="utf-8",
        )

    def mutate_pr_id_token_perm(tree: Path) -> None:
        (tree / ".github/workflows/oidc-probe.yml").write_text(
            "name: OIDC Probe\non:\n  pull_request_review:\npermissions:\n  contents: read\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - run: true\n",
            encoding="utf-8",
        )

    def mutate_same_repo_full_name_callee(tree: Path) -> None:
        (tree / ".github/workflows/callee-full.yml").write_text(
            "name: Callee Full\non:\n  workflow_call:\npermissions:\n  contents: read\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.CALLEE_SECRET }}\n",
            encoding="utf-8",
        )
        (tree / ".github/workflows/caller-full.yml").write_text(
            "name: Caller Full\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  call:\n    uses: kodera-hq/kodera/.github/workflows/callee-full.yml@a857fd3300000000000000000000000000000000\n",
            encoding="utf-8",
        )

    cases = [
        (
            "workflow_pr_references_custom_prop",
            mutate_ci_custom_prop,
            "workflow `ci.yml` at `root.jobs.leak-probe.steps[0].run` contains disallowed repository context property reference",
        ),
        (
            "workflow_pr_references_vault_prop",
            mutate_ci_vault_prop,
            "workflow `ci.yml` at `root.jobs.vault-probe.steps[0].run` contains disallowed repository context property reference",
        ),
        (
            "workflow_pr_bracket_lookup",
            mutate_ci_bracket_lookup,
            "workflow `ci.yml` at `root.jobs.bracket-probe.steps[0].run` contains disallowed bracketed repository context lookup",
        ),
        (
            "workflow_pr_tojson_dump",
            mutate_ci_tojson_dump,
            "workflow `ci.yml` at `root.jobs.tojson-probe.steps[0].run` contains disallowed serialized repository context dump",
        ),
        (
            "workflow_pr_bare_context",
            mutate_ci_bare_context,
            "workflow `ci.yml` at `root.jobs.bare-probe.steps[0].env.DUMP` contains disallowed bare repository context expression",
        ),
        (
            "workflow_pr_grouped_tojson_dump",
            mutate_ci_grouped_tojson_dump,
            "workflow `ci.yml` at `root.jobs.grouped-probe.steps[0].env.DUMP` contains disallowed serialized repository context dump",
        ),
        (
            "workflow_uses_pull_request_target",
            mutate_pull_request_target,
            "must never use `pull_request_target`",
        ),
        (
            "composite_action_references_prop",
            mutate_composite_action_prop,
            "composite action `.github/actions/leak/action.yml` at `root.runs.steps[0].run` contains disallowed repository context property reference",
        ),
        (
            "workflow_merge_group_references_custom_prop",
            mutate_merge_group_prop,
            "workflow `merge-queue-probe.yml` at `root.jobs.probe.steps[0].run` contains disallowed repository context property reference",
        ),
        (
            "workflow_called_by_ci_references_custom_prop",
            mutate_callee_prop,
            "workflow `ci-server.yml` at `root.jobs.",
        ),
        (
            "workflow_pr_sets_context_inherit",
            mutate_context_inherit,
            "must never inherit caller context",
        ),
        (
            "workflow_call_declares_context_input",
            mutate_workflow_call_declares_input,
            "must not declare `workflow_call` context inputs",
        ),
        (
            "contributing_contains_ipv4_literal",
            mutate_contributing_ipv4,
            "must not contain IPv4 literals",
        ),
        (
            "contributing_contains_calendar_date",
            mutate_contributing_date,
            "must not contain calendar dates",
        ),
        (
            "workflow_run_references_secret",
            mutate_workflow_run_secret,
            "workflow `wf-run-probe.yml` at `root.jobs.probe.steps[0].run` contains disallowed repository context property reference",
        ),
        (
            "issue_comment_grants_write_permission",
            mutate_issue_comment_write_perm,
            "top-level permission `contents: write` must be read-only",
        ),
        (
            "pr_review_grants_id_token_permission",
            mutate_pr_id_token_perm,
            "must not grant `id-token` permission on PR-reachable CI",
        ),
        (
            "same_repo_full_name_callee_references_secret",
            mutate_same_repo_full_name_callee,
            "workflow `callee-full.yml` at `root.jobs.probe.steps[0].run` contains disallowed repository context property reference",
        ),
    ]

    script_path = Path(__file__).resolve()
    for name, mutator, expected_msg in cases:
        with tempfile.TemporaryDirectory(prefix="kodera-ci-isolation-") as tmp:
            tree = Path(tmp)
            shutil.copytree(REPO_ROOT / ".github/workflows", tree / ".github/workflows")
            if (REPO_ROOT / ".github/actions").is_dir():
                shutil.copytree(REPO_ROOT / ".github/actions", tree / ".github/actions")
            shutil.copyfile(REPO_ROOT / "CONTRIBUTING.md", tree / "CONTRIBUTING.md")
            mutator(tree)
            proc = subprocess.run(
                [sys.executable, str(script_path), "--root", str(tree)],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 1 or expected_msg not in proc.stderr:
                print(
                    f"FAIL selftest `{name}`: expected rc=1 with `{expected_msg}`, got rc={proc.returncode}",
                    file=sys.stderr,
                )
                return 1
            print(f"ok   selftest `{name}` refused as expected")

    print(f"PASS check-zero-secret-pr-ci selftest ({len(cases)} refusal mutations)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()

    diagnostics = check_repo(args.root.resolve())
    if diagnostics:
        for item in diagnostics:
            print(f"ERROR: {item}", file=sys.stderr)
        return 1
    print("OK: zero-secret PR/merge_group CI policy and CONTRIBUTING.md verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())

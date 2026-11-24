#!/usr/bin/env python3
"""Enforce zero custom secrets on pull_request, merge_group, ci.yml, and local composite actions.

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
PR_ZERO_SECRET_EVENTS = {"pull_request", "pull_request_target", "merge_group"}
ALLOWED_GITHUB_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\bsecrets\s*\.\s*github_token\b(?!\s*[\.\[A-Za-z0-9_])",
    re.IGNORECASE,
)
ANY_SECRETS_IDENT_RE = re.compile(r"(?<![A-Za-z0-9_.])\bsecrets\b", re.IGNORECASE)
SECRET_DOT_REF_RE = re.compile(r"\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)
SECRET_INDEX_REF_RE = re.compile(r"\bsecrets\s*\[\s*['\"]?([^'\"\]]*)['\"]?\s*\]", re.IGNORECASE)
SECRET_TOJSON_RE = re.compile(r"\btoJSON\s*\([\s(]*secrets[\s)]*\)", re.IGNORECASE)
CALENDAR_DATE_RE = re.compile(r"\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b")
IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")


def workflow_triggers(doc: dict) -> set[str]:
    on_block = doc.get("on") if "on" in doc else doc.get(True)
    if isinstance(on_block, str):
        return {on_block}
    if isinstance(on_block, list):
        return {str(item) for item in on_block}
    if isinstance(on_block, dict):
        return {str(k) for k in on_block.keys()}
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
                # Unclosed quote: preserve raw remainder fail-closed.
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


def collect_yaml_string_nodes(node, *, key_name: str = "") -> list[tuple[str, bool]]:
    out: list[tuple[str, bool]] = []
    if isinstance(node, str):
        out.append((node, key_name == "if"))
    elif isinstance(node, dict):
        for k, v in node.items():
            k_str = str(k) if isinstance(k, str) else ""
            if isinstance(k, str):
                out.append((k, False))
            out.extend(collect_yaml_string_nodes(v, key_name=k_str))
    elif isinstance(node, list):
        for item in node:
            out.extend(collect_yaml_string_nodes(item, key_name=key_name))
    return out


def describe_secret_violation(raw_expr: str, sanitized: str) -> str:
    m_dot = SECRET_DOT_REF_RE.search(sanitized)
    if m_dot:
        return f"secrets.{m_dot.group(1)}"
    m_idx = SECRET_INDEX_REF_RE.search(raw_expr)
    if m_idx:
        return f"secrets[{m_idx.group(1).strip()!r}]"
    m_json = SECRET_TOJSON_RE.search(sanitized)
    if m_json:
        return re.sub(r"\s+", "", m_json.group(0))
    return raw_expr if raw_expr else "secrets"


def find_forbidden_secret_refs(doc: dict) -> list[str]:
    found: list[str] = []
    for text, is_if in collect_yaml_string_nodes(doc):
        if "${{" not in text and not is_if:
            continue
        for raw_expr, stripped_expr in extract_gha_expressions(text, is_if_condition=is_if):
            sanitized = ALLOWED_GITHUB_TOKEN_RE.sub("__ALLOWED_GITHUB_TOKEN__", stripped_expr)
            if ANY_SECRETS_IDENT_RE.search(sanitized):
                label = describe_secret_violation(raw_expr, sanitized)
                if label not in found:
                    found.append(label)
    return found


def resolve_zero_secret_workflows(docs_by_name: dict[str, dict]) -> set[str]:
    protected: set[str] = set()
    for wf_name, doc in docs_by_name.items():
        if wf_name == "ci.yml" or (workflow_triggers(doc) & PR_ZERO_SECRET_EVENTS):
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
                prefix = "./.github/workflows/"
                if uses.startswith(prefix):
                    callee = uses[len(prefix) :].split("@", 1)[0]
                    if callee in docs_by_name and callee not in protected:
                        protected.add(callee)
                        changed = True
    return protected


def check_composite_actions(root: Path) -> list[str]:
    problems: list[str] = []
    actions_dir = root / ".github/actions"
    if not actions_dir.exists():
        return problems
    for action_file in sorted(actions_dir.rglob("action.y*ml")):
        if not action_file.is_file():
            continue
        rel = action_file.relative_to(root).as_posix()
        doc = yaml.safe_load(action_file.read_text(encoding="utf-8")) or {}
        if not isinstance(doc, dict):
            continue
        for bad_ref in find_forbidden_secret_refs(doc):
            problems.append(
                f"composite action `{rel}` must never reference `{bad_ref}` (zero-secret PR CI policy; only `secrets.GITHUB_TOKEN` is permitted)"
            )
    return problems


def check_repo(root: Path) -> list[str]:
    problems: list[str] = []
    workflows_dir = root / ".github/workflows"
    if not workflows_dir.is_dir():
        return [f"missing workflows directory `{workflows_dir}`"]
    files = sorted(workflows_dir.glob("*.y*ml"))
    if not files:
        return ["no workflow files found under `.github/workflows`"]

    docs_by_name: dict[str, dict] = {}
    for wf in files:
        docs_by_name[wf.name] = yaml.safe_load(wf.read_text(encoding="utf-8")) or {}

    for wf in files:
        doc = docs_by_name[wf.name]
        if "pull_request_target" in workflow_triggers(doc):
            problems.append(
                f"workflow `{wf.name}` must never use `pull_request_target` (zero-secret PR CI policy)"
            )

    protected = resolve_zero_secret_workflows(docs_by_name)
    for wf in files:
        if wf.name not in protected:
            continue
        doc = docs_by_name[wf.name]
        on_block = doc.get("on") if "on" in doc else doc.get(True)
        if isinstance(on_block, dict):
            wf_call = on_block.get("workflow_call")
            if isinstance(wf_call, dict) and wf_call.get("secrets"):
                problems.append(
                    f"workflow `{wf.name}` is invoked on pull_request/merge_group CI and must not declare `workflow_call.secrets`"
                )
        for bad_ref in find_forbidden_secret_refs(doc):
            problems.append(
                f"workflow `{wf.name}` runs on pull_request/merge_group CI and must never reference `{bad_ref}` (zero-secret PR CI policy; only `secrets.GITHUB_TOKEN` is permitted)"
            )
        jobs = doc.get("jobs") or {}
        if isinstance(jobs, dict):
            for job_id, job in jobs.items():
                if not isinstance(job, dict):
                    continue
                job_secrets = job.get("secrets")
                if job_secrets == "inherit":
                    problems.append(
                        f"workflow `{wf.name}` job `{job_id}` must never set `secrets: inherit` on pull_request/merge_group CI"
                    )
                elif isinstance(job_secrets, dict) and job_secrets:
                    problems.append(
                        f"workflow `{wf.name}` job `{job_id}` must not pass custom `secrets:` mappings on pull_request/merge_group CI"
                    )

    problems.extend(check_composite_actions(root))

    contributing = root / "CONTRIBUTING.md"
    if not contributing.is_file():
        problems.append("missing root `CONTRIBUTING.md`")
    else:
        text = contributing.read_text(encoding="utf-8")
        if "Status: Active" not in text:
            problems.append("`CONTRIBUTING.md` must carry `Status: Active`")
        dates = CALENDAR_DATE_RE.findall(text)
        if dates:
            problems.append(f"`CONTRIBUTING.md` must not contain calendar dates (found `{dates[0]}`)")
        ips = IPV4_RE.findall(text)
        if ips:
            problems.append(f"`CONTRIBUTING.md` must not contain IPv4 literals (found `{ips[0]}`)")

    return problems


def run_selftest() -> int:
    baseline = check_repo(REPO_ROOT)
    if baseline:
        for p in baseline:
            print(f"FAIL baseline: {p}", file=sys.stderr)
        return 1

    # Verify benign single-quoted `'...secrets...'` literal and `secrets.GITHUB_TOKEN` are allowed.
    benign_doc = {
        "on": {"pull_request": {}},
        "jobs": {
            "ok": {
                "if": "${{ 'secrets and }} in literal''s text' != '' }}",
                "steps": [{"env": {"TOK": "${{ secrets.GITHUB_TOKEN }}"}}],
            }
        },
    }
    if find_forbidden_secret_refs(benign_doc):
        print(
            "FAIL selftest: benign quoted literal or secrets.GITHUB_TOKEN was rejected",
            file=sys.stderr,
        )
        return 1

    def mutate_ci_custom_secret(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  leak-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.SCW_SECRET_KEY }}\n",
            encoding="utf-8",
        )

    def mutate_ci_kojovault_secret(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  vault-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.KOJOVAULT_TOKEN }}\n",
            encoding="utf-8",
        )

    def mutate_ci_bracket_secret(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  bracket-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets['AGE_SECRET_KEY'] }}\n",
            encoding="utf-8",
        )

    def mutate_ci_tojson_secrets(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  tojson-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo '${{ toJSON(secrets) }}'\n",
            encoding="utf-8",
        )

    def mutate_ci_bare_secrets_context(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n  bare-probe:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          DUMP: ${{ secrets }}\n        run: true\n",
            encoding="utf-8",
        )

    def mutate_ci_grouped_tojson_secrets(tree: Path) -> None:
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

    def mutate_composite_action_secret(tree: Path) -> None:
        act = tree / ".github/actions/leak/action.yml"
        act.parent.mkdir(parents=True, exist_ok=True)
        act.write_text(
            "name: Leak Action\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ${{ secrets.LEAKED_COMPOSITE_SECRET }}\n",
            encoding="utf-8",
        )

    def mutate_merge_group_secret(tree: Path) -> None:
        (tree / ".github/workflows/merge-queue-probe.yml").write_text(
            "name: Merge Queue Probe\non:\n  merge_group:\npermissions:\n  contents: read\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.KODERA_DEPLOY_TOKEN }}\n",
            encoding="utf-8",
        )

    def mutate_callee_secret(tree: Path) -> None:
        p = tree / ".github/workflows/ci-server.yml"
        p.write_text(
            p.read_text(encoding="utf-8")
            + "\n      - name: Leak\n        run: echo ${{ secrets.CUSTOM_API_KEY }}\n",
            encoding="utf-8",
        )

    def mutate_secrets_inherit(tree: Path) -> None:
        p = tree / ".github/workflows/ci.yml"
        p.write_text(
            p.read_text(encoding="utf-8").replace(
                "uses: ./.github/workflows/ci-server.yml\n",
                "uses: ./.github/workflows/ci-server.yml\n    secrets: inherit\n",
                1,
            ),
            encoding="utf-8",
        )

    def mutate_workflow_call_declares_secret(tree: Path) -> None:
        p = tree / ".github/workflows/ci-server.yml"
        p.write_text(
            p.read_text(encoding="utf-8").replace(
                "  workflow_call:\n",
                "  workflow_call:\n    secrets:\n      DEPLOY_KEY:\n        required: false\n",
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

    cases = [
        (
            "workflow_pr_references_custom_secret",
            mutate_ci_custom_secret,
            "must never reference `secrets.SCW_SECRET_KEY`",
        ),
        (
            "workflow_pr_references_kojovault_secret",
            mutate_ci_kojovault_secret,
            "must never reference `secrets.KOJOVAULT_TOKEN`",
        ),
        (
            "workflow_pr_bracket_secret_ref",
            mutate_ci_bracket_secret,
            "must never reference `secrets['AGE_SECRET_KEY']`",
        ),
        (
            "workflow_pr_tojson_secrets",
            mutate_ci_tojson_secrets,
            "must never reference `toJSON(secrets)`",
        ),
        (
            "workflow_pr_bare_secrets_context",
            mutate_ci_bare_secrets_context,
            "must never reference `secrets`",
        ),
        (
            "workflow_pr_grouped_tojson_secrets",
            mutate_ci_grouped_tojson_secrets,
            "must never reference `toJSON((secrets))`",
        ),
        (
            "workflow_uses_pull_request_target",
            mutate_pull_request_target,
            "must never use `pull_request_target`",
        ),
        (
            "composite_action_references_secret",
            mutate_composite_action_secret,
            "composite action `.github/actions/leak/action.yml` must never reference `secrets.LEAKED_COMPOSITE_SECRET`",
        ),
        (
            "workflow_merge_group_references_custom_secret",
            mutate_merge_group_secret,
            "must never reference `secrets.KODERA_DEPLOY_TOKEN`",
        ),
        (
            "workflow_called_by_ci_references_custom_secret",
            mutate_callee_secret,
            "must never reference `secrets.CUSTOM_API_KEY`",
        ),
        (
            "workflow_pr_sets_secrets_inherit",
            mutate_secrets_inherit,
            "must never set `secrets: inherit`",
        ),
        (
            "workflow_call_declares_secret_input",
            mutate_workflow_call_declares_secret,
            "must not declare `workflow_call.secrets`",
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
    ]

    script_path = Path(__file__).resolve()
    for name, mutator, expected_msg in cases:
        with tempfile.TemporaryDirectory(prefix="kodera-zero-secret-ci-") as tmp:
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
                    f"FAIL selftest `{name}`: expected rc=1 with `{expected_msg}`, got rc={proc.returncode}, stderr={proc.stderr!r}",
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

    problems = check_repo(args.root.resolve())
    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        return 1
    print("OK: zero-secret PR/merge_group CI policy and CONTRIBUTING.md verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())

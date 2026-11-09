"""Isolated semantic counterexamples for the admitted organisation read."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = (
    (
        "issuer-path-scope",
        "apps/orgs/detail_services.py",
        "if target_id != identity.organisation_id:",
        "if False and target_id != identity.organisation_id:",
        "tests/test_organisation_detail.py::test_issuer_bound_multi_org_isolation",
        "AssertionError: issuer-path scope was bypassed",
    ),
    (
        "current-grant",
        "apps/orgs/detail_services.py",
        "if not has_current_read_grant(",
        "if False and not has_current_read_grant(",
        "tests/test_organisation_detail.py::test_unknown_subject_and_missing_grant",
        "AssertionError: missing grant was accepted",
    ),
    (
        "field-whitelist",
        "apps/orgs/api/detail_serializers.py",
        '"slug": detail.slug,',
        '"slug": detail.slug, "country": "FR",',
        "tests/test_organisation_detail.py::test_required_projection_and_roles[org_member]",
        "AssertionError: organisation projection leaked or invented fields",
    ),
    (
        "etag-timestamp",
        "apps/orgs/api/detail_serializers.py",
        'authoritative = {**fields, "updated_at": _timestamp(detail.updated_at)}',
        "authoritative = fields",
        "tests/test_organisation_detail.py::test_etag_authoritative_timestamp_and_conditionals",
        "AssertionError: ETag omitted authoritative update timestamp",
    ),
    (
        "conditional-before-authority",
        "apps/orgs/api/detail.py",
        "                detail = read_organisation(verified=verified, target_id=organisation_id)",
        '                if request.headers.get("If-None-Match"):\n                    return HttpResponse(status=304)\n                detail = read_organisation(verified=verified, target_id=organisation_id)',
        "tests/test_organisation_detail.py::test_current_authority_before_conditional[member-removed-403]",
        "AssertionError: conditional response bypassed current authority",
    ),
    (
        "coherent-snapshot",
        "apps/orgs/detail_services.py",
        "ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "ISOLATION LEVEL READ COMMITTED READ ONLY",
        "tests/test_organisation_detail_transactions.py::test_coherent_snapshot_across_revocation_and_data_change",
        "AssertionError: organisation projection mixed database snapshots",
    ),
    (
        "read-only-transaction",
        "apps/orgs/detail_services.py",
        "ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "ISOLATION LEVEL REPEATABLE READ READ WRITE",
        "tests/test_organisation_detail_transactions.py::test_revocation_before_snapshot_denies",
        "AssertionError: organisation transaction permits writes",
    ),
)


def run_mutations(environment: dict[str, str], report: Path) -> None:
    results = []
    for name, module, old, new, node, diagnostic in CASES:
        original = (ROOT / module).read_text()
        if original.count(old) != 1:
            raise RuntimeError(f"{name}: exact mutation target is missing or ambiguous")
        with tempfile.TemporaryDirectory(prefix="organisation-detail-mutation-") as temporary:
            target = Path(temporary)
            for directory in ("apps", "core", "config", "services", "tests"):
                shutil.copytree(
                    ROOT / directory,
                    target / directory,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
            shutil.copyfile(ROOT / "pyproject.toml", target / "pyproject.toml")
            shutil.copyfile(ROOT / "manage.py", target / "manage.py")
            outputs = {}
            for phase in ("baseline", "mutant"):
                if phase == "mutant":
                    (target / module).write_text(original.replace(old, new))
                if phase == "mutant":
                    compile((target / module).read_text(), module, "exec")
                log = report.with_name(report.stem + f"-{name}-{phase}.log")
                metadata = log.with_suffix(".xml")
                result = subprocess.run(  # noqa: S603
                    [
                        sys.executable,
                        "-m",
                        "pytest",
                        "-q",
                        "-o",
                        "junit_family=xunit1",
                        "--junitxml",
                        str(metadata),
                        node,
                    ],
                    cwd=target,
                    env={**environment, "PYTHONPATH": str(target)},
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
                log.write_text(result.stdout + result.stderr)
                outputs[phase] = str(log)
                if phase == "baseline":
                    if result.returncode != 0 or "1 passed" not in result.stdout:
                        raise RuntimeError(f"{name}: exact semantic baseline failed; see {log}")
                else:
                    failures = [
                        line for line in result.stdout.splitlines() if line.startswith("FAILED ")
                    ]
                    if (
                        result.returncode != 1
                        or len(failures) != 1
                        or not failures[0].split(" - ")[0].endswith(node)
                        or not re.search(
                            r"^E\s+" + re.escape(diagnostic) + r"$", result.stdout, re.M
                        )
                        or "1 failed" not in result.stdout
                    ):
                        raise RuntimeError(
                            f"{name}: intended semantic refusal not measured; see {log}"
                        )
            results.append(
                {
                    "case": name,
                    "node": node,
                    "diagnostic": diagnostic,
                    "source_sha256": hashlib.sha256(original.encode()).hexdigest(),
                    "mutant_sha256": hashlib.sha256((target / module).read_bytes()).hexdigest(),
                    "logs": outputs,
                    "caught": True,
                }
            )
            report.write_text(json.dumps(results, indent=2) + "\n")
            print(f"PASS organisation mutation {name}: {diagnostic}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    arguments = parser.parse_args()
    run_mutations(dict(os.environ), arguments.report.resolve())

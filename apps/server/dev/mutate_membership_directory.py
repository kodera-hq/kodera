"""Isolated semantic counterexamples for the admitted membership directory."""

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
        "apps/orgs/membership_services.py",
        "if target_id != identity.organisation_id:",
        "if False and target_id != identity.organisation_id:",
        "tests/test_membership_directory_http.py::test_issuer_bound_target",
        "AssertionError: directory target escaped current issuer",
    ),
    (
        "billing-role",
        "apps/orgs/membership_services.py",
        'if role not in {"org_owner", "org_admin", "org_member"}:',
        'if role not in {"org_owner", "org_admin", "org_member", "org_billing"}:',
        "tests/test_membership_directory_http.py::test_billing_denied",
        "AssertionError: billing caller gained directory access",
    ),
    (
        "current-grant",
        "apps/orgs/membership_services.py",
        "if not has_current_read_grant(",
        "if False and not has_current_read_grant(",
        "tests/test_membership_directory_http.py::test_revoked_grant",
        "AssertionError: revoked directory grant was accepted",
    ),
    (
        "excluded-population",
        "apps/orgs/membership_selectors.py",
        'state__in=("invited", "active", "suspended"),',
        'state__in=("invited", "active", "suspended", "removed"),',
        "tests/test_membership_directory_http.py::test_projection_population_and_no_writes[org_member]",
        "AssertionError: directory included an excluded relationship",
    ),
    (
        "unavailable-facts",
        "apps/orgs/api/membership_serializers.py",
        '"email": person.email,',
        '"email": person.email, "mfa_enrolled": False,',
        "tests/test_membership_directory_http.py::test_projection_population_and_no_writes[org_member]",
        "AssertionError: directory invented an unavailable fact",
    ),
    (
        "cursor-integrity",
        "apps/orgs/membership_pagination.py",
        "if not hmac.compare_digest(signature, hmac.digest(key, DOMAIN + payload, hashlib.sha256)):",
        "if False and not hmac.compare_digest(signature, hmac.digest(key, DOMAIN + payload, "
        "hashlib.sha256)):",
        "tests/test_membership_directory_pagination.py::test_invalid_cursor_integrity",
        "AssertionError: directory accepted invalid cursor integrity",
    ),
    (
        "cursor-binding",
        "apps/orgs/membership_pagination.py",
        "if version != 1 or binding != expected:",
        "if version != 1:",
        "tests/test_membership_directory_pagination.py::test_cursor_binding[limit]",
        "AssertionError: directory accepted a rebound cursor",
    ),
    (
        "conditional-before-authority",
        "apps/orgs/api/memberships.py",
        "                page = read_directory(",
        '                if request.headers.get("If-None-Match"):\n'
        "                    return HttpResponse(status=304)\n"
        "                page = read_directory(",
        "tests/test_membership_directory_http.py::test_conditional_current_authority",
        "AssertionError: directory conditional bypassed current authority",
    ),
    (
        "coherent-snapshot",
        "apps/orgs/membership_services.py",
        "ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "ISOLATION LEVEL READ COMMITTED READ ONLY",
        "tests/test_membership_directory_transactions.py::test_coherent_snapshot_across_revocation_and_data_change",
        "AssertionError: directory mixed authority and projection snapshots",
    ),
    (
        "read-only-transaction",
        "apps/orgs/membership_services.py",
        "ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "ISOLATION LEVEL REPEATABLE READ READ WRITE",
        "tests/test_membership_directory_transactions.py::test_revocation_before_snapshot_denies",
        "AssertionError: directory transaction permits writes",
    ),
)


def run_mutations(environment: dict[str, str], report: Path) -> None:
    results = []
    for name, module, old, new, node, diagnostic in CASES:
        original = (ROOT / module).read_text()
        if original.count(old) != 1:
            raise RuntimeError(f"{name}: exact mutation target is missing or ambiguous")
        with tempfile.TemporaryDirectory(prefix="membership-directory-mutation-") as temporary:
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
            if (ROOT / module).read_text() != original:
                raise RuntimeError(f"{name}: original source changed during isolated execution")
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
            print(f"PASS directory mutation {name}: {diagnostic}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    arguments = parser.parse_args()
    run_mutations(dict(os.environ), arguments.report.resolve())

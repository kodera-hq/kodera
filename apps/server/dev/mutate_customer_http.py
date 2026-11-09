"""Five fixed HTTP authority weakenings against the real route and migrated PostgreSQL."""

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = (
    (
        "issuer-subject",
        "apps/identity/selectors.py",
        "            issuer=issuer,\n",
        "",
        "tests/test_customer_http.py::test_ar05_exact_issuer_and_subject_select_distinct_people",
        "AssertionError: issuer-specific identities were confused",
    ),
    (
        "token-role",
        "apps/identity/api/views.py",
        """                content = serialize_customer(
                    read_customer(
                        verified=verified,
                        lane=lane,
                        console_client_id=settings.KODERA_CONSOLE_CLIENT_ID,
                    )
                )""",
        """                content = serialize_customer(
                    read_customer(
                        verified=verified,
                        lane=lane,
                        console_client_id=settings.KODERA_CONSOLE_CLIENT_ID,
                    )
                )
                import jwt
                claims = jwt.decode(_bearer(request), options={"verify_signature": False})
                projection = json.loads(content)
                projection["organisations"][0]["role"] = claims["realm_access"]["roles"][0]
                content = json.dumps(projection).encode()""",
        "tests/test_customer_http.py::test_ar06_role_email_and_staff_claims_never_override_persistence",
        "AssertionError: token role became customer authority",
    ),
    (
        "current-membership",
        "apps/orgs/selectors.py",
        "        state=Membership.State.ACTIVE,\n",
        "",
        "tests/test_customer_http.py::test_ar07_committed_membership_revocation_denies_same_token[removed]",
        "AssertionError: customer denial returned the wrong HTTP status",
    ),
    (
        "identity-eligibility",
        "apps/identity/selectors.py",
        "            subject=subject,\n            enabled=True,",
        "            subject=subject,",
        "tests/test_customer_http.py::test_ar09_disabled_or_deleted_person_identity_denies[disable-current]",
        "AssertionError: customer denial returned the wrong HTTP status",
    ),
    (
        "conditional-before-authority",
        "apps/identity/api/views.py",
        """                content = serialize_customer(
                    read_customer(
                        verified=verified,
                        lane=lane,
                        console_client_id=settings.KODERA_CONSOLE_CLIENT_ID,
                    )
                )""",
        """                if request.headers.get("If-None-Match"):
                    return HttpResponse(status=304, headers={
                        "ETag": request.headers["If-None-Match"],
                        "Cache-Control": "no-store", "X-Request-Id": request_id,
                    })
                content = serialize_customer(
                    read_customer(
                        verified=verified,
                        lane=lane,
                        console_client_id=settings.KODERA_CONSOLE_CLIENT_ID,
                    )
                )""",
        "tests/test_customer_http.py::test_ar15_conditional_requests_never_skip_current_authority[exact]",
        "AssertionError: conditional response resurrected revoked authority",
    ),
)


def run_mutations(environment: dict[str, str], report: Path) -> None:
    results = []
    for name, module, old, new, node, diagnostic in CASES:
        original = (ROOT / module).read_text()
        if original.count(old) != 1:
            raise RuntimeError(f"{name}: exact mutation target is missing or ambiguous")
        with tempfile.TemporaryDirectory(prefix="customer-http-mutation-") as temporary:
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
            print(f"PASS HTTP mutation {name}: {diagnostic}", flush=True)

"""Four fixed semantic weakenings against actual migrated PostgreSQL tables."""

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = Path("apps/orgs/migrations/0002_integrity.py")
CASES = (
    (
        "owner-write",
        "UPDATE orgs_organisation SET owner_guard_revision=owner_guard_revision+1 WHERE id=org_id;",
        "PERFORM 1 FROM orgs_organisation WHERE id=org_id FOR UPDATE;",
        "tests/test_customer_persistence_concurrency.py::test_competing_owner_removals_preserve_a_committed_owner[REPEATABLE READ]",
        "AssertionError: both competing owner removals committed",
    ),
    (
        "reservation-final",
        "IF NOT FOUND OR held_slug IS DISTINCT FROM org_slug OR (org_state IN ('active','suspended') AND held_state<>'permanent') THEN",
        "IF FALSE THEN",
        "tests/test_customer_persistence_models.py::test_active_organisation_requires_both_final_partners[reservation]",
        "Failed: DID NOT RAISE IntegrityError",
    ),
    (
        "identity-binding",
        "ALTER TABLE identity_identity ADD CONSTRAINT identity_organisation_binding_fk FOREIGN KEY (organisation_id,issuer,realm) REFERENCES orgs_organisation(id,issuer,realm) ON DELETE RESTRICT;",
        "-- Composite relationship deliberately removed in isolated acceptance.",
        "tests/test_customer_persistence_models.py::test_identity_requires_actual_composite_organisation_binding",
        "Failed: DID NOT RAISE IntegrityError",
    ),
    (
        "reservation-write",
        "CREATE TRIGGER c_customer_touch_reservation_guard BEFORE INSERT OR UPDATE ON orgs_slugreservation FOR EACH ROW EXECUTE FUNCTION customer_touch_owner_guard();",
        "-- Reservation serialization deliberately removed in isolated acceptance.",
        "tests/test_customer_persistence_concurrency.py::test_activation_and_reservation_retirement_cannot_both_commit",
        "AssertionError: activation and reservation retirement both committed",
    ),
)


def run_mutations(environment: dict[str, str], report: Path) -> None:
    original = (ROOT / MIGRATION).read_text()
    results = []
    for name, old, new, node, diagnostic in CASES:
        if original.count(old) != 1:
            raise RuntimeError(f"{name}: exact mutation target is missing or ambiguous")
        with tempfile.TemporaryDirectory(prefix="customer-schema-mutation-") as temporary:
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
                    (target / MIGRATION).write_text(original.replace(old, new))
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
                    "mutant_sha256": hashlib.sha256((target / MIGRATION).read_bytes()).hexdigest(),
                    "logs": outputs,
                    "caught": True,
                }
            )
            report.write_text(json.dumps(results, indent=2) + "\n")
            print(f"PASS schema mutation {name}: {diagnostic}", flush=True)

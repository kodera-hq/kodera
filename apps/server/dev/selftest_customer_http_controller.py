#!/usr/bin/env python3
"""Prove selected controller boundaries refuse weakenings without services."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = (
    (
        "startup-message",
        "and f'permission denied for database \"{database}\"' in str(error)",
        "and True",
        "test_nonpermission_startup_failure_refuses[wrong-password]",
        "DID NOT RAISE",
    ),
    (
        "startup-scope",
        'database not in ("identity", "postgres")',
        "False",
        "test_startup_refusal_scope_is_finite[kodera_server]",
        "DID NOT RAISE",
    ),
    (
        "startup-code",
        '"exception_category": "database-error" if explicit_code else "operational-error",\n        "sqlstate": error.sqlstate,',
        '"exception_category": "database-error" if explicit_code else "operational-error",\n        "sqlstate": "42501",',
        "test_startup_denial_preserves_actual_missing_sqlstate[identity]",
        "assert observed ==",
    ),
    (
        "database-create-query",
        "SELECT has_database_privilege(%s,current_database(),'CREATE')",
        "SELECT has_database_privilege(%s,current_database(),'TEMP')",
        "test_catalogue_queries_measure_each_privilege_dimension[database-database_create-True]",
        "assert facts[field] == expected",
    ),
    (
        "table-grant-query",
        "SELECT has_table_privilege(%s,%s,'SELECT WITH GRANT OPTION')",
        "SELECT has_table_privilege(%s,%s,'SELECT')",
        "test_catalogue_queries_measure_each_privilege_dimension[table-table_select_grant_options-expected2]",
        "assert facts[field] == expected",
    ),
    (
        "column-grant-query",
        "SELECT has_column_privilege(%s,%s,%s,'SELECT WITH GRANT OPTION')",
        "SELECT has_column_privilege(%s,%s,%s,'SELECT')",
        "test_catalogue_queries_measure_each_privilege_dimension[column-column_select_grant_options-expected3]",
        "assert facts[field] == expected",
    ),
    (
        "database-create-check",
        "for key, value in expected.items()",
        'for key, value in expected.items() if key != "database_create"',
        "test_catalogue_queries_measure_each_privilege_dimension[database-database_create-True]",
        "DID NOT RAISE",
    ),
    (
        "table-grant-check",
        "for key, value in expected.items()",
        'for key, value in expected.items() if key != "table_select_grant_options"',
        "test_catalogue_queries_measure_each_privilege_dimension[table-table_select_grant_options-expected2]",
        "DID NOT RAISE",
    ),
    (
        "column-grant-check",
        "for key, value in expected.items()",
        'for key, value in expected.items() if key != "column_select_grant_options"',
        "test_catalogue_queries_measure_each_privilege_dimension[column-column_select_grant_options-expected3]",
        "DID NOT RAISE",
    ),
    (
        "schema-probe",
        '            "CREATE SCHEMA forbidden_probe",\n',
        "",
        "test_reader_qualification_binds_schema_probe_and_startup_classifier",
        "assert len(probes) == 37",
    ),
    (
        "function-default-scope",
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        "test_new_function_defaults_remove_global_public_execute",
        "new functions retain global PUBLIC EXECUTE",
    ),
    (
        "optional-tmpfs",
        '"tmpfs": host.get("Tmpfs", {}),',
        '"tmpfs": host["Tmpfs"],',
        "test_resource_observation_preserves_optional_tmpfs[absent]",
        "KeyError",
    ),
    (
        "tcp-readiness",
        '            "-h",\n            "127.0.0.1",\n            "-p",\n            "5432",',
        "",
        "test_database_readiness_requires_explicit_tcp",
        "assert args ==",
    ),
    (
        "diagnostic-privacy",
        "    return details\n\n\ndef report_failure",
        '    details["unsafe"] = str(error)\n    return details\n\n\ndef report_failure',
        "test_database_failure_diagnostic_never_reflects_exception_text",
        "assert observed ==",
    ),
    (
        "child-bytecode",
        '} | {"PYTHONDONTWRITEBYTECODE": "1"}',
        "}",
        "test_child_environment_preserves_bytecode_suppression_without_bulk_forwarding",
        "KeyError",
    ),
    (
        "database-connect-scope",
        "for key, value in expected.items()",
        'for key, value in expected.items() if key != "connectable_databases"',
        "test_database_catalogue_refuses_extra_connectable_database[reader]",
        "DID NOT RAISE",
    ),
    (
        "provider-connect-scope",
        "for key, value in expected.items()",
        'for key, value in expected.items() if key != "provider_connectable_databases"',
        "test_database_catalogue_refuses_extra_connectable_database[provider]",
        "DID NOT RAISE",
    ),
    (
        "readonly-code",
        'if error.sqlstate == "42501":',
        'if error.sqlstate in {"42501", "25006"}:',
        "test_other_database_outcomes_do_not_prove_reader_privilege[25006]",
        "DID NOT RAISE",
    ),
    (
        "role-capability",
        '"rolsuper": False,',
        '"rolsuper": True,',
        "test_reader_catalogue_refuses_extra_authority_or_incomplete_evidence[rolsuper-True]",
        "DID NOT RAISE",
    ),
    (
        "column-grant",
        "for key, value in expected.items()",
        'for key, value in expected.items() if key != "other_column_privileges"',
        "test_reader_catalogue_refuses_extra_authority_or_incomplete_evidence[other_column_privileges-value10]",
        "DID NOT RAISE",
    ),
    (
        "environment",
        '"DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1",',
        '"DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1", "POSTGRES_PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),',
        "test_api_environment_contains_only_reader_and_public_inputs",
        "Extra items",
    ),
    (
        "private-lifetime",
        "finally:\n        path.unlink()",
        "finally:\n        pass",
        "test_private_input_is_removed_after_probe_failure",
        "assert not path.exists()",
    ),
    (
        "outage-status",
        "valid = status == 500",
        "valid = status in {500, 401}",
        "test_me_outage_requires_actual_http_500[401]",
        "DID NOT RAISE",
    ),
    (
        "pause-cleanup",
        'docker("unpause", reference)\n\n\ndef require_image_sources',
        "pass\n\n\ndef require_image_sources",
        "test_pause_always_unpauses_after_failed_probe",
        "assert calls ==",
    ),
    (
        "source-content",
        'or facts["sentinel_found"] is not False',
        "or False",
        "test_image_source_observation_refuses_missing_or_leaked_source[sentinel_found-True]",
        "DID NOT RAISE",
    ),
    (
        "readonly-root",
        'host["ReadonlyRootfs"] is True',
        "True",
        "test_api_runtime_refuses_missing_hardening[ReadonlyRootfs-False]",
        "DID NOT RAISE",
    ),
    (
        "api-variable-name",
        "key.startswith(forbidden_prefixes)",
        "False",
        "test_actual_api_environment_refuses_forbidden_names_even_empty[SCW_SECRET_KEY]",
        "DID NOT RAISE",
    ),
    (
        "sql-timeout",
        'PG_OPTIONS = "-c lock_timeout=5000 -c statement_timeout=30000"',
        'PG_OPTIONS = "-c lock_timeout=0 -c statement_timeout=0"',
        "test_reader_sql_has_finite_lock_and_statement_timeouts",
        'assert seen[0]["options"]',
    ),
)


def main() -> None:
    original = (ROOT / "dev/accept_customer_http.py").read_text()
    for name, old, new, node, assertion in CASES:
        if old not in original:
            raise RuntimeError(f"{name}: mutation target missing")
        with tempfile.TemporaryDirectory(prefix="customer-http-mutation-") as temporary:
            target = Path(temporary)
            (target / "dev").mkdir()
            (target / "tests").mkdir()
            for name_in_repo in (
                "dev/accept_customer_http.py",
                "dev/accept_runtime.py",
                "dev/__init__.py",
                "tests/test_customer_http_controller.py",
            ):
                shutil.copyfile(ROOT / name_in_repo, target / name_in_repo)
            environment = {
                "PATH": os.defpath,
                "PYTHONPATH": str(ROOT),
                "DJANGO_SETTINGS_MODULE": "config.settings.dev",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            for phase in ("baseline", "mutant"):
                if phase == "mutant":
                    (target / "dev/accept_customer_http.py").write_text(
                        original.replace(old, new, 1)
                    )
                result = subprocess.run(  # noqa: S603
                    [
                        sys.executable,
                        "-m",
                        "pytest",
                        "-q",
                        str(target / "tests/test_customer_http_controller.py") + "::" + node,
                    ],
                    cwd=target,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                if phase == "baseline":
                    if result.returncode != 0 or "1 passed" not in result.stdout:
                        raise RuntimeError(f"{name}: exact controller baseline failed")
                else:
                    failures = [
                        line for line in result.stdout.splitlines() if line.startswith("FAILED ")
                    ]
                    if (
                        result.returncode != 1
                        or len(failures) != 1
                        or not failures[0].split(" - ")[0].endswith("::" + node)
                        or assertion not in result.stdout
                        or "1 failed" not in result.stdout
                    ):
                        raise RuntimeError(
                            f"{name}: exact controller refusal assertion not observed"
                        )
            print(f"PASS pure controller mutation {name}: {node}")


if __name__ == "__main__":
    main()

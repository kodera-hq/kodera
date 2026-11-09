"""Closed bootstrap controller mutations; no local services or image builds."""

import hashlib
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def controller():
    from dev import accept_bootstrap_http

    return accept_bootstrap_http


def test_baseline_controller_is_preserved():
    assert (
        hashlib.sha256((ROOT / "dev/accept_production_http.py").read_bytes()).hexdigest()
        == "87ded33470693974d4ed71988f6d9c0b9677175976f539549abaff545d21876c"
    )


def test_exact_private_free_role_and_lock_columns():
    c = controller()
    assert c.BOOTSTRAP_UPDATE_COLUMNS == {
        "identity_user": ("id",),
        "identity_identity": ("id",),
        "identity_staffrole": ("id",),
        "orgs_ownerclaim": ("state", "revoked_at"),
    }
    assert "realm" in c.BOOTSTRAP_SELECT_COLUMNS["identity_identity"]
    for table, column in (
        ("orgs_organisationintake", "sealed_contact"),
        ("orgs_ownerclaim", "token_hash"),
        ("orgs_ownerclaim", "delivery_id"),
        ("jobs_job", "desired_spec_hash"),
    ):
        assert column not in c.BOOTSTRAP_SELECT_COLUMNS[table]
    assert "orgs_membership" not in c.BOOTSTRAP_SELECT_COLUMNS
    assert set(c.BOOTSTRAP_INSERT_COLUMNS) == {"audit_auditevent"}


@pytest.mark.parametrize(
    "field",
    [
        "attributes_safe",
        "owns_nothing",
        "database_safe",
        "schema_safe",
        "functions_safe",
        "sequences_safe",
        "no_table_grants",
        "public_trigger_execute",
    ],
)
def test_catalog_false_and_missing_policy_refuse(field):
    c = controller()
    good = c.expected_policy()
    c.bootstrap_policy(good)
    changed = deepcopy(good)
    changed[field] = False
    with pytest.raises(AssertionError, match="bootstrap role policy refused"):
        c.bootstrap_policy(changed)
    del changed[field]
    with pytest.raises(AssertionError, match="bootstrap role policy refused"):
        c.bootstrap_policy(changed)


@pytest.mark.parametrize(
    "privilege,table,column",
    [
        ("select", "orgs_membership", "id"),
        ("select", "orgs_ownerclaim", "token_hash"),
        ("update", "identity_user", "enabled"),
        ("insert", "orgs_ownerclaim", "id"),
    ],
)
def test_extra_catalog_privilege_refuses(privilege, table, column):
    c = controller()
    changed = c.expected_policy()
    changed[privilege].append([table, column])
    with pytest.raises(AssertionError, match="bootstrap role policy refused"):
        c.bootstrap_policy(changed)


@pytest.mark.parametrize("table", ["identity_user", "identity_identity", "identity_staffrole"])
def test_missing_actual_authority_lock_column_refuses(table):
    c = controller()
    changed = c.expected_policy()
    changed["update"].remove([table, "id"])
    with pytest.raises(AssertionError, match="bootstrap role policy refused"):
        c.bootstrap_policy(changed)


@pytest.mark.parametrize("value", [1, "true", None])
def test_policy_boolean_is_strict(value):
    c = controller()
    changed = c.expected_policy()
    changed["functions_safe"] = value
    with pytest.raises(AssertionError, match="bootstrap role policy refused"):
        c.bootstrap_policy(changed)


@pytest.mark.parametrize("state", ["consumed", "revoked", "expired"])
def test_terminal_or_duplicate_audit_mutations_refuse(state):
    c = controller()
    c.claim_proof(state, state, 1, 1)
    with pytest.raises(AssertionError, match="bootstrap claim proof refused"):
        c.claim_proof(state, "issued", 1, 1)
    with pytest.raises(AssertionError, match="bootstrap claim proof refused"):
        c.claim_proof(state, state, 1, 2)


def test_private_response_and_raw_diagnostic_refuse():
    c = controller()
    c.public_bytes(b'{"claim":{"state":"issued"}}', ("synthetic-secret",))
    with pytest.raises(AssertionError, match="bootstrap private material refused"):
        c.public_bytes(b'"synthetic-secret"', ("synthetic-secret",))


def test_cleanup_daemon_error_never_proves_absence(monkeypatch):
    import subprocess

    c = controller()
    monkeypatch.setattr(
        c,
        "docker",
        lambda *a, **k: (_ for _ in ()).throw(subprocess.CalledProcessError(1, "docker")),
    )
    with pytest.raises(subprocess.CalledProcessError):
        c.absent("container", "owned-test")


def test_wrong_owned_resource_is_never_removed(monkeypatch):
    import json
    from types import SimpleNamespace

    c = controller()
    called = []

    def fake(*args, **kwargs):
        called.append(args)
        return SimpleNamespace(
            returncode=0, stdout=json.dumps([{"Config": {"Labels": {c.LABEL: "other"}}}])
        )

    monkeypatch.setattr(c, "docker", fake)
    with pytest.raises(AssertionError, match="bootstrap resource owner mismatch"):
        c.remove("container", "foreign")
    assert len(called) == 1


def test_hosted_admission_refuses_before_commands(monkeypatch):
    c = controller()
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(c, "docker", lambda *a, **k: pytest.fail("Docker before hosted admission"))
    with pytest.raises(AssertionError, match="hosted-only bootstrap qualification"):
        c.qualify_bootstrap_http()


def test_actual_controller_entrypoint_refuses_locally_before_services():
    import os
    import subprocess
    import sys

    result = subprocess.run(  # noqa: S603 - fixed checked-in controller; no services admitted
        [sys.executable, str(ROOT / "dev/accept_bootstrap_http.py")],
        cwd=ROOT,
        env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == "Bootstrap qualification refused during admission\n"


def test_actual_controller_outbox_relation_matches_installed_model():
    import ast

    from apps.outbox.models import OutboxMessage

    source = ast.parse((ROOT / "dev/accept_bootstrap_http.py").read_text())
    statements = [
        node.value
        for node in ast.walk(source)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value.startswith("SELECT count(*) FROM outbox")
    ]
    assert statements == ["SELECT count(*) FROM " + OutboxMessage._meta.db_table]  # noqa: S608 - model metadata compared, never executed


@pytest.mark.parametrize(
    "path",
    [
        "apps/orgs/claim_delivery.py",
        "apps/orgs/claim_confirmation.py",
        "apps/identity/owner_binding.py",
    ],
)
def test_actual_image_private_module_restoration_refuses(tmp_path, path):
    c = controller()
    # The image's whole outbox is the realm access enqueue (MEMBERSHIP_LIFECYCLE.md §6.1.1).
    (tmp_path / "apps/outbox").mkdir(parents=True, exist_ok=True)
    for name in ("__init__.py", "realm_enqueue.py"):
        (tmp_path / "apps/outbox" / name).write_text("synthetic served module")
    c.image_source_boundary(tmp_path)
    restored = tmp_path / path
    restored.parent.mkdir(parents=True, exist_ok=True)
    restored.write_text("pass\n")
    with pytest.raises(AssertionError, match="bootstrap image source boundary refused"):
        c.image_source_boundary(tmp_path)


def test_actual_seed_confirmation_actor_expression_is_recorder_staff():
    import ast
    import inspect
    from types import SimpleNamespace

    c = controller()
    tree = ast.parse(inspect.getsource(c.seed_bootstrap_fixture))
    call = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "record_owner_event"
    )
    actor = next(keyword.value for keyword in call.keywords if keyword.arg == "actor_id")
    expression = ast.Expression(actor)
    value = eval(  # noqa: S307 - owned AST; no external input
        compile(expression, "<actual-seed-actor>", "eval"),
        {"__builtins__": {}},
        {
            "state": "consumed",
            "identity": SimpleNamespace(id="customer"),
            "staff": {
                "recorder": SimpleNamespace(id="recorder"),
                "operator": SimpleNamespace(id="operator"),
            },
        },
    )
    assert value == "recorder"


REVIEWED_SELECT = {
    "identity_user": ("id", "enabled", "deleted_at"),
    "identity_identity": (
        "id",
        "user_id",
        "organisation_id",
        "issuer",
        "subject",
        "enabled",
        "deleted_at",
        "realm",
    ),
    "identity_staffrole": ("id", "identity_id", "role", "revoked_at"),
    "orgs_organisation": ("id", "slug", "state", "realm", "updated_at", "issuer", "deleted_at"),
    "orgs_organisationintake": (
        "id",
        "organisation_id",
        "instruction_ref",
        "created_at",
        "intended_owner_email_masked",
        "bootstrap_job_id",
    ),
    "orgs_ownerbinding": ("id", "organisation_id", "identity_id", "issuer", "recorded_at"),
    "orgs_ownerclaim": (
        "id",
        "organisation_id",
        "state",
        "issued_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "membership_id",
    ),
    "orgs_realmreadiness": ("organisation_id", "job_id", "issuer", "realm", "revoked_at"),
    "jobs_job": ("id", "status", "organisation_id", "kind", "created_at"),
    "audit_auditevent": ("occurred_at", "metadata"),
}


REVIEWED_UPDATE = {
    "identity_user": ("id",),
    "identity_identity": ("id",),
    "identity_staffrole": ("id",),
    "orgs_ownerclaim": ("state", "revoked_at"),
}


REVIEWED_INSERT = {
    "audit_auditevent": (
        "id",
        "occurred_at",
        "actor_type",
        "actor_id",
        "actor_label",
        "organisation_id",
        "action",
        "target_urn",
        "before",
        "after",
        "request_id",
        "job_id",
        "source_ip_trunc",
        "retention_class",
        "metadata",
    )
}


def test_independent_complete_source_derived_privilege_ledger():
    c = controller()
    assert c.BOOTSTRAP_SELECT_COLUMNS == REVIEWED_SELECT
    assert c.BOOTSTRAP_UPDATE_COLUMNS == REVIEWED_UPDATE
    assert c.BOOTSTRAP_INSERT_COLUMNS == REVIEWED_INSERT


@pytest.mark.parametrize(
    "privilege,table,column",
    [
        ("select", "identity_identity", "email"),
        ("update", "identity_user", "enabled"),
        ("insert", "orgs_ownerclaim", "id"),
    ],
)
def test_paired_installer_manifest_and_grant_widening_refuses(
    monkeypatch, privilege, table, column
):
    c = controller()
    name = "BOOTSTRAP_" + privilege.upper() + "_COLUMNS"
    changed = deepcopy(getattr(c, name))
    changed[table] = (*changed.get(table, ()), column)
    monkeypatch.setattr(c, name, changed)
    actual = c.expected_policy()
    actual[privilege] = sorted(
        [
            [relation, attribute]
            for relation, attributes in changed.items()
            for attribute in attributes
        ]
    )
    with pytest.raises(AssertionError, match="bootstrap role policy refused"):
        c.bootstrap_policy(actual)


@pytest.mark.parametrize(
    "material",
    [
        "owner@boot-past.synthetic.test",
        "$argon2id$v=19$random-stored-verifier",
        "actual-sealed-contact",
    ],
)
def test_seed_bound_private_material_leak_refuses(material):
    c = controller()
    world = {
        "_privacy": {
            "raw_contacts": ["owner@boot-past.synthetic.test"],
            "sealed_contacts": ["actual-sealed-contact"],
            "verifiers": ["$argon2id$v=19$random-stored-verifier"],
        }
    }
    secrets = c.private_material(world)
    with pytest.raises(AssertionError, match="bootstrap private material refused"):
        c.public_bytes(material.encode(), secrets)


def test_missing_seed_privacy_evidence_refuses():
    c = controller()
    with pytest.raises(AssertionError, match="bootstrap seed privacy refused"):
        c.private_material({})


@pytest.mark.parametrize("field", ["before", "after"])
def test_full_audit_row_private_field_refuses(field):
    import json

    c = controller()
    world = {
        "_privacy": {
            "raw_contacts": ["owner@boot-past.synthetic.test"],
            "sealed_contacts": ["actual-sealed-contact"],
            "verifiers": ["$argon2id$v=19$random-stored-verifier"],
        }
    }
    with pytest.raises(AssertionError, match="bootstrap private material refused"):
        c.public_bytes(
            json.dumps({field: {"raw_contact": "owner@boot-past.synthetic.test"}}).encode(),
            c.private_material(world),
        )


def test_closed_actual_database_failure_hides_arbitrary_values():
    from types import SimpleNamespace

    c = controller()
    error = RuntimeError("private-token-raw-query")
    error.__cause__ = RuntimeError("private-contact@example.test")
    error.__cause__.sqlstate = "23514"
    error.__cause__.diag = SimpleNamespace(constraint_name="owner_claim_initial_issued")
    assert c.closed_postgresql_failure(
        "tests/test_bootstrap_http_fixture.py::test_actual_scoped_role_expiry_trigger_permission_experiment[private-param]",
        "setup",
        error,
    ) == {
        "case": "expiry-trigger",
        "stage": "setup",
        "category": "database",
        "sqlstate": "23514",
        "constraint": "owner_claim_initial_issued",
    }


def test_unknown_database_failure_never_echoes_message_type_or_constraint():
    from types import SimpleNamespace

    c = controller()
    error = RuntimeError("private-token-raw-query")
    error.sqlstate = "secret"
    error.diag = SimpleNamespace(constraint_name="private-verifier")
    result = c.closed_postgresql_failure("arbitrary-private-node", "private-stage", error)
    assert result == {
        "case": "unknown",
        "stage": "unknown",
        "category": "unexpected",
        "sqlstate": "unknown",
        "constraint": "unknown",
    }
    assert "private" not in str(result)


def test_actual_pytest_diagnostic_hook_records_closed_driver_fields():
    from types import SimpleNamespace

    c = controller()
    proof = c.postgresql_plugin()
    error = RuntimeError("private-stderr")
    error.sqlstate = "42501"
    proof.pytest_runtest_makereport(
        SimpleNamespace(
            nodeid="tests/test_bootstrap_http_fixture.py::test_actual_semantic_authority_columns_deny[private-param]"
        ),
        SimpleNamespace(when="call", excinfo=SimpleNamespace(value=error)),
    )
    assert proof.failures == [
        {
            "case": "semantic-columns",
            "stage": "call",
            "category": "database",
            "sqlstate": "42501",
            "constraint": "unknown",
        }
    ]


def test_successful_actual_pytest_hook_emits_no_failure():
    from types import SimpleNamespace

    c = controller()
    proof = c.postgresql_plugin()
    proof.pytest_runtest_makereport(
        SimpleNamespace(nodeid="arbitrary-private-node"), SimpleNamespace(when="call", excinfo=None)
    )
    assert proof.failures == []


def test_forwarded_diagnostic_packet_refuses_private_or_extra_fields():
    c = controller()
    good = {
        "case": "expiry-trigger",
        "stage": "call",
        "category": "database",
        "sqlstate": "42501",
        "constraint": "unknown",
    }
    c.closed_diagnostics([good])
    for field in good:
        bad = {**good, field: "private-query-token"}
        with pytest.raises(AssertionError, match="bootstrap diagnostic fields refused"):
            c.closed_diagnostics([bad])
    with pytest.raises(AssertionError, match="bootstrap diagnostic fields refused"):
        c.closed_diagnostics([{**good, "raw": "private-query-token"}])


@pytest.mark.parametrize(
    "packet",
    [
        '[{"case":"private-sentinel"}]',
        '[{"case":"expiry-trigger","stage":"call","category":"database","sqlstate":"42501","constraint":"unknown","raw":"private-sentinel"}]',
    ],
)
def test_actual_operator_fixture_never_forwards_unapproved_stdout(monkeypatch, capsys, packet):
    from types import SimpleNamespace

    c = controller()
    outputs = iter(
        [
            SimpleNamespace(stdout="", stderr="", returncode=0),
            SimpleNamespace(
                stdout="KODERA_BOOTSTRAP_DIAGNOSTIC " + packet,
                stderr="private-stderr",
                returncode=1,
            ),
        ]
    )
    monkeypatch.setattr(c.serving, "command", lambda *args, **kwargs: next(outputs))
    with pytest.raises(AssertionError, match="bootstrap diagnostic fields refused"):
        c.operator_fixture(6543)
    assert "private-sentinel" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "payload",
    ["not-json", "{}", "[]", "[null]", "[{}]", "[{}]" + "\nKODERA_BOOTSTRAP_DIAGNOSTIC [{}]"],
)
def test_actual_operator_fixture_refuses_malformed_or_multiple_diagnostics(
    monkeypatch, capsys, payload
):
    from types import SimpleNamespace

    c = controller()
    outputs = iter(
        [
            SimpleNamespace(stdout="", stderr="", returncode=0),
            SimpleNamespace(
                stdout="KODERA_BOOTSTRAP_DIAGNOSTIC " + payload,
                stderr="private-stderr",
                returncode=1,
            ),
        ]
    )
    monkeypatch.setattr(c.serving, "command", lambda *args, **kwargs: next(outputs))
    with pytest.raises(AssertionError, match="bootstrap diagnostic (fields|bounds) refused"):
        c.operator_fixture(6543)
    assert capsys.readouterr().out == ""


def test_closed_diagnostic_bounds_and_nonstring_fields():
    c = controller()
    good = {
        "case": "expiry-trigger",
        "stage": "call",
        "category": "database",
        "sqlstate": "42501",
        "constraint": "unknown",
    }
    with pytest.raises(AssertionError, match="bootstrap diagnostic bounds refused"):
        c.closed_diagnostics([good] * 94)
    for field in good:
        for value in (None, [], {}, 4, True):
            with pytest.raises(AssertionError, match="bootstrap diagnostic fields refused"):
                c.closed_diagnostics([{**good, field: value}])


def test_actual_pytest_run_delivers_closed_failure_without_services(tmp_path):
    import json
    import os
    import subprocess
    import sys

    source = tmp_path / "test_closed_hook.py"
    source.write_text("""
def test_actual_semantic_authority_columns_deny():
    error = RuntimeError("private-query-token")
    error.sqlstate = "42501"
    raise error
""")
    program = """
import json,pytest,sys
from dev.accept_bootstrap_http import postgresql_plugin
proof=postgresql_plugin()
status=pytest.main([sys.argv[1],'-c','/dev/null','-q'],plugins=[proof])
print('CLOSED_HOOK '+json.dumps(proof.failures))
raise SystemExit(status)
"""
    result = subprocess.run(  # noqa: S603 - fixed owned synthetic pytest, no services or inherited credentials
        [sys.executable, "-c", program, str(source)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        },
    )
    assert result.returncode == 1
    lines = [
        line.removeprefix("CLOSED_HOOK ")
        for line in result.stdout.splitlines()
        if line.startswith("CLOSED_HOOK ")
    ]
    assert len(lines) == 1
    assert json.loads(lines[0]) == [
        {
            "case": "semantic-columns",
            "stage": "call",
            "category": "database",
            "sqlstate": "42501",
            "constraint": "unknown",
        }
    ]
    assert "private-query-token" not in lines[0]


def test_actual_operator_fixture_refuses_oversized_diagnostic(monkeypatch, capsys):
    from types import SimpleNamespace

    c = controller()
    outputs = iter(
        [
            SimpleNamespace(stdout="", stderr="", returncode=0),
            SimpleNamespace(
                stdout="KODERA_BOOTSTRAP_DIAGNOSTIC "
                + " " * 32769
                + '[{"case":"expiry-trigger","stage":"call","category":"database","sqlstate":"42501","constraint":"unknown"}]',
                stderr="",
                returncode=1,
            ),
        ]
    )
    monkeypatch.setattr(c.serving, "command", lambda *args, **kwargs: next(outputs))
    with pytest.raises(AssertionError, match="bootstrap diagnostic bounds refused"):
        c.operator_fixture(6543)
    assert capsys.readouterr().out == ""


def test_actual_job_seed_supplies_every_required_model_field():
    import ast
    import inspect

    from apps.jobs.models import Job

    c = controller()
    tree = ast.parse(inspect.getsource(c.seed_bootstrap_fixture))
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "create"
        and ast.unparse(node.func.value) == "Job.objects"
    ]
    assert len(calls) == 1
    keywords = {keyword.arg: keyword.value for keyword in calls[0].keywords}
    required = {
        field.name
        for field in Job._meta.concrete_fields
        if not field.null and not field.has_default() and not field.has_db_default()
    }
    assert required <= set(keywords), "actual job seed omits required model field"
    assert ast.literal_eval(keywords["max_attempts"]) == 1
    reverted = set(keywords) - {"max_attempts"}
    assert not required <= reverted


def test_actual_sequence_catalog_function_is_kind_guarded():
    c = controller()

    class CapturedSequenceError(Exception):
        pass

    class Cursor:
        statement = ""
        queries = 0

        def execute(self, statement, parameters=None):
            self.queries += 1
            if "has_sequence_privilege" in statement:
                self.statement = statement
                raise CapturedSequenceError

        def fetchone(self):
            return (42, True) if self.queries == 1 else (True,)

    cursor = Cursor()
    with pytest.raises(CapturedSequenceError):
        c.assert_bootstrap_role_policy(cursor, "synthetic_bootstrap_control", "synthetic_database")
    statement = cursor.statement
    guard = "CASE WHEN c.relkind='S' THEN has_sequence_privilege(%s,c.oid,'USAGE,SELECT,UPDATE') ELSE false END"

    def accepts_kind_guard(query):
        return guard in query and query.count("has_sequence_privilege") == 1

    assert accepts_kind_guard(statement), "sequence privilege function lacks guaranteed kind guard"
    assert "n.nspname !~ '^pg_' AND n.nspname!='information_schema'" in statement
    reverted = statement.replace(
        guard, "c.relkind='S' AND has_sequence_privilege(%s,c.oid,'USAGE,SELECT,UPDATE')"
    )
    assert not accepts_kind_guard(reverted)
    expected = "SELECT NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname!='information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(%s,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)"
    assert statement == expected
    narrowed = statement.replace(
        "n.nspname !~ '^pg_' AND n.nspname!='information_schema'", "n.nspname='public'"
    )
    assert narrowed != expected


def test_actual_authority_blocker_connect_preserves_existing_private_credential(
    monkeypatch, capsys
):
    from types import SimpleNamespace

    import psycopg

    c = controller()
    credential = "synthetic-existing-private-credential"
    connection = SimpleNamespace(
        info=SimpleNamespace(
            dsn="host=127.0.0.1 dbname=synthetic_database user=synthetic_admin", password=credential
        )
    )

    class CapturedConnectError(Exception):
        pass

    def connect(dsn, **kwargs):
        assert dsn == connection.info.dsn
        supplied = kwargs.get("password") == credential
        assert supplied, "blocker connection omitted existing credential"
        raise CapturedConnectError

    monkeypatch.setattr(psycopg, "connect", connect)
    with pytest.raises(CapturedConnectError):
        c.authority_race(
            connection,
            None,
            6543,
            "/synthetic",
            "private-token",
            "UPDATE synthetic SET enabled=false WHERE id=%s",
            "synthetic-target",
            commit=False,
            expected=200,
        )
    assert capsys.readouterr().out == ""

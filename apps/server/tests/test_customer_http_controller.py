"""Controller preparation: pure boundaries, never claimed as database/image proof."""

import importlib
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[1]


def controller_module():
    assert (ROOT / "dev/accept_customer_http.py").is_file(), (
        "customer HTTP runtime controller is absent"
    )
    return importlib.import_module("dev.accept_customer_http")


def test_controller_is_present():
    controller_module()


class ProbeConnection:
    def __init__(self, sqlstate, read_only="off"):
        self.sqlstate = sqlstate
        self.read_only = read_only
        self.commands = []

    def execute(self, statement):
        text = str(statement)
        self.commands.append(text)
        if text == "SHOW transaction_read_only":
            return SimpleNamespace(fetchone=lambda: (self.read_only,))
        if text == "SYNTHETIC_FIXED_PROBE":
            if self.sqlstate:
                raise psycopg.errors.lookup(self.sqlstate)("synthetic database refusal")
        return None


def test_only_read_write_insufficient_privilege_passes():
    module = controller_module()
    client = ProbeConnection("42501")
    module.run_reader_probe(client, "SYNTHETIC_FIXED_PROBE")
    assert client.commands == [
        "BEGIN READ WRITE",
        "SHOW transaction_read_only",
        "SYNTHETIC_FIXED_PROBE",
        "ROLLBACK",
    ]


@pytest.mark.parametrize(
    "sqlstate", [None, "25006", "23514", "23503", "42601", "08006", "57014", "55P03"]
)
def test_other_database_outcomes_do_not_prove_reader_privilege(sqlstate):
    module = controller_module()
    client = ProbeConnection(sqlstate)
    with pytest.raises(
        module.ControllerError, match="reader privilege refusal was not demonstrated"
    ):
        module.run_reader_probe(client, "SYNTHETIC_FIXED_PROBE")
    assert client.commands[-1] == "ROLLBACK"


def test_read_only_transaction_is_not_a_privilege_test():
    module = controller_module()
    client = ProbeConnection("42501", read_only="on")
    with pytest.raises(module.ControllerError, match="reader probe is not READ WRITE"):
        module.run_reader_probe(client, "SYNTHETIC_FIXED_PROBE")
    assert "SYNTHETIC_FIXED_PROBE" not in client.commands
    assert client.commands[-1] == "ROLLBACK"


def catalogue():
    return {
        "rolcanlogin": True,
        "rolsuper": False,
        "rolcreatedb": False,
        "rolcreaterole": False,
        "rolreplication": False,
        "rolbypassrls": False,
        "rolinherit": False,
        "memberships": [],
        "owned_objects": [],
        "select_tables": [
            "identity_user",
            "identity_identity",
            "orgs_organisation",
            "orgs_membership",
            "orgs_slugreservation",
        ],
        "other_table_privileges": [],
        "other_column_privileges": [],
        "schema_create": False,
        "database_create": False,
        "table_select_grant_options": [],
        "column_select_grant_options": [],
        "database_temp": False,
        "application_execute": [],
        "identity_connect": False,
        "connectable_databases": ["kodera_server"],
        "provider_connectable_databases": ["identity"],
    }


def test_exact_reader_catalogue_control():
    controller_module().require_reader_catalogue(catalogue())


@pytest.mark.parametrize(
    "key,value",
    [
        ("rolsuper", True),
        ("rolcreatedb", True),
        ("rolcreaterole", True),
        ("rolreplication", True),
        ("rolbypassrls", True),
        ("rolinherit", True),
        ("memberships", ["provider"]),
        ("owned_objects", ["table"]),
        ("select_tables", ["identity_user"]),
        ("other_table_privileges", ["INSERT"]),
        ("other_column_privileges", ["identity_user.email:UPDATE"]),
        ("schema_create", True),
        ("database_temp", True),
        ("application_execute", ["fixture_function"]),
        ("identity_connect", True),
        ("rolsuper", 0),
        ("database_create", True),
        ("table_select_grant_options", ["identity_user"]),
        ("column_select_grant_options", [("identity_user", 1)]),
    ],
)
def test_reader_catalogue_refuses_extra_authority_or_incomplete_evidence(key, value):
    module = controller_module()
    facts = catalogue()
    facts[key] = value
    with pytest.raises(module.ControllerError, match="reader catalogue is not least privilege"):
        module.require_reader_catalogue(facts)


def test_reader_catalogue_missing_fact_refuses():
    module = controller_module()
    facts = catalogue()
    del facts["rolsuper"]
    with pytest.raises(module.ControllerError, match="reader catalogue is not least privilege"):
        module.require_reader_catalogue(facts)


def test_api_environment_contains_only_reader_and_public_inputs(monkeypatch):
    module = controller_module()
    monkeypatch.setenv("POSTGRES_PASSWORD", "synthetic-owner-never-forward")
    monkeypatch.setenv("KEYCLOAK_ADMIN_PASSWORD", "synthetic-provider-never-forward")
    monkeypatch.setenv("SCW_SECRET_KEY", "synthetic-infrastructure-never-forward")
    result = module.api_environment("synthetic-reader-only", "[]")
    assert set(result) == {
        "DATABASE_URL",
        "DJANGO_SETTINGS_MODULE",
        "DJANGO_ALLOWED_HOSTS",
        "KODERA_AUTH_TRUST",
    }
    assert result["DJANGO_SETTINGS_MODULE"] == "config.settings.e2e"
    assert result["KODERA_AUTH_TRUST"] == "[]"
    assert (
        result["DATABASE_URL"]
        == "postgres://customer_api_reader:synthetic-reader-only@db:5432/kodera_server"
    )
    assert all("never-forward" not in value for value in result.values())


def payload():
    return {
        "api_port": 18431,
        "access_token": "synthetic-access",
        "id_token": "synthetic-id",
        "refresh_token": "synthetic-refresh",
        "wrong_audience": "synthetic-wrong",
        "expected_me": {"id": "synthetic-person"},
    }


def test_private_input_is_bounded_regular_private_and_removed(tmp_path):
    module = controller_module()
    with module.private_image_input(tmp_path, payload()) as path:
        assert path.parent == tmp_path and path.is_file() and not path.is_symlink()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert path.stat().st_uid == os.getuid()
        assert json.loads(path.read_text()) == payload()
    assert not path.exists()


def test_private_input_is_removed_after_probe_failure(tmp_path):
    module = controller_module()
    with (
        pytest.raises(RuntimeError, match="synthetic probe failure"),
        module.private_image_input(tmp_path, payload()) as path,
    ):
        raise RuntimeError("synthetic probe failure")
    assert not path.exists()


@pytest.mark.parametrize(
    "change", ["oversized-token", "oversized-total", "extra-field", "boolean-port"]
)
def test_private_input_refuses_unsafe_shape_without_retaining_file(tmp_path, change):
    module = controller_module()
    value = payload()
    if change == "oversized-token":
        value["access_token"] = "x" * 16385
    elif change == "oversized-total":
        value["expected_me"] = {"name": "x" * 65536}
    elif change == "extra-field":
        value["owner_password"] = "synthetic-never-forward"
    else:
        value["api_port"] = True
    with pytest.raises(module.ControllerError, match="owned HTTP image input refused"):
        with module.private_image_input(tmp_path, value):
            pytest.fail("invalid owned image input was accepted")
    assert list(tmp_path.iterdir()) == []


def test_private_input_refuses_symlinked_directory(tmp_path):
    module = controller_module()
    directory = tmp_path / "actual"
    directory.mkdir(mode=0o700)
    link = tmp_path / "linked"
    link.symlink_to(directory, target_is_directory=True)
    with pytest.raises(module.ControllerError, match="owned HTTP image input refused"):
        with module.private_image_input(link, payload()):
            pytest.fail("symlinked input directory was admitted")
    assert list(directory.iterdir()) == []


def test_private_input_refuses_nonprivate_directory(tmp_path):
    module = controller_module()
    tmp_path.chmod(0o755)
    with pytest.raises(module.ControllerError, match="owned HTTP image input refused"):
        with module.private_image_input(tmp_path, payload()):
            pytest.fail("nonprivate input directory was admitted")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("status", [200, 401, 403, 503])
def test_me_outage_requires_actual_http_500(status):
    module = controller_module()
    with pytest.raises(module.ControllerError, match="database outage response refused"):
        module.require_outage_response(status, outage_body(), outage_headers())


def test_me_outage_http500_control():
    controller_module().require_outage_response(500, outage_body(), outage_headers())


@pytest.mark.parametrize(
    "body,headers",
    [
        ({}, {"cache-control": "no-store"}),
        ({"status": 500, "detail": "database password"}, {"cache-control": "no-store"}),
        ({"status": 500}, {}),
    ],
)
def test_me_outage_body_or_cache_failure_refuses(body, headers):
    module = controller_module()
    with pytest.raises(module.ControllerError, match="database outage response refused"):
        module.require_outage_response(500, body, headers)


def test_http_timeout_is_not_reclassified_as_outage(monkeypatch):
    module = controller_module()

    def unavailable(*args, **kwargs):
        raise TimeoutError("synthetic timeout")

    monkeypatch.setattr(module, "HTTPConnection", unavailable)
    with pytest.raises(module.ControllerError, match="owned HTTP request failed"):
        module.http_request(18431, "/api/v1/me", "synthetic-token")


def test_recovery_preserves_api_process_and_projection():
    module = controller_module()
    state = {"Id": "owned-id", "State": {"StartedAt": "original", "Running": True}}
    module.require_recovery(state, state, {"id": "original"}, {"id": "original"})


@pytest.mark.parametrize("change", ["id", "started", "stopped", "projection"])
def test_recovery_refuses_restarted_api_or_changed_projection(change):
    module = controller_module()
    before = {"Id": "owned-id", "State": {"StartedAt": "original", "Running": True}}
    after = {"Id": "owned-id", "State": {"StartedAt": "original", "Running": True}}
    actual = {"id": "original"}
    if change == "id":
        after["Id"] = "replacement"
    elif change == "started":
        after["State"]["StartedAt"] = "replacement"
    elif change == "stopped":
        after["State"]["Running"] = False
    else:
        actual["id"] = "replacement"
    with pytest.raises(module.ControllerError, match="same persisted API recovery refused"):
        module.require_recovery(before, after, {"id": "original"}, actual)


def test_pause_always_unpauses_after_failed_probe(monkeypatch):
    module = controller_module()
    calls = []
    monkeypatch.setattr(
        module, "require_owned", lambda kind, ref, owner: calls.append(("owned", ref))
    )
    monkeypatch.setattr(module, "docker", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(RuntimeError, match="probe failed"):
        with module.paused_database("owned-db", "owner"):
            raise RuntimeError("probe failed")
    assert calls == [
        ("owned", "owned-db"),
        ("pause", "owned-db"),
        ("owned", "owned-db"),
        ("unpause", "owned-db"),
    ]


def test_pause_refuses_foreign_owner_without_mutation(monkeypatch):
    module = controller_module()
    calls = []

    def refuse(*args):
        raise module.ControllerError("unowned resource")

    monkeypatch.setattr(module, "require_owned", refuse)
    monkeypatch.setattr(module, "docker", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(module.ControllerError, match="unowned resource"):
        with module.paused_database("foreign-db", "owner"):
            pytest.fail("foreign resource paused")
    assert calls == []


def test_image_source_observation_control():
    controller_module().require_image_sources(
        {"required_present": True, "forbidden_paths": [], "sentinel_found": False}
    )


@pytest.mark.parametrize(
    "change,value",
    [
        ("required_present", False),
        ("forbidden_paths", ["apps/private.env"]),
        ("sentinel_found", True),
        ("sentinel_found", None),
    ],
)
def test_image_source_observation_refuses_missing_or_leaked_source(change, value):
    module = controller_module()
    facts = {"required_present": True, "forbidden_paths": [], "sentinel_found": False}
    facts[change] = value
    with pytest.raises(module.ControllerError, match="customer image source boundary refused"):
        module.require_image_sources(facts)


def test_cleanup_attempts_all_resources_after_first_removal_failure(monkeypatch):
    module = controller_module()
    calls = []

    def command(*args, **kwargs):
        calls.append(args)
        if args[:3] == ("container", "rm", "-f") and args[-1] == "api":
            raise RuntimeError("synthetic first removal failure")
        if args[:2] == ("ps", "-aq") and "name=" in args[-1]:
            return SimpleNamespace(stdout="owned-id")
        return SimpleNamespace(stdout="")

    monkeypatch.setattr(module, "docker", command)
    monkeypatch.setattr(module, "require_owned", lambda *args: {"State": {"Paused": True}})
    with pytest.raises(module.ControllerError, match="cleanup could not be verified"):
        module.cleanup("owner", ["db", "api"], "network", "image")
    assert ("unpause", "api") in calls
    assert ("unpause", "db") in calls
    assert ("container", "rm", "-f", "db") in calls
    assert ("network", "ls", "-q", "--filter", "label=kodera.customer-http=owner") in calls


def test_cleanup_daemon_uncertainty_is_not_absence(monkeypatch):
    module = controller_module()

    def unavailable(*args, **kwargs):
        raise RuntimeError("synthetic daemon unavailable")

    monkeypatch.setattr(module, "docker", unavailable)
    with pytest.raises(module.ControllerError, match="cleanup could not be verified"):
        module.cleanup("owner", ["db"], "network", "image")


def test_installed_sentinels_cover_actual_source_bytes(tmp_path):
    module = controller_module()
    module.install_source_sentinels(tmp_path)
    for name in module.FORBIDDEN_IMAGE_FILES:
        assert (tmp_path / name).read_text() == "SYNTHETIC_CUSTOMER_HTTP_EXCLUDED_SOURCE"
    assert "apps/identity/private.py" in module.FORBIDDEN_IMAGE_FILES
    assert "services/private.py" in module.FORBIDDEN_IMAGE_FILES
    assert "apps/identity/migrations/0001_initial.py" in module.FORBIDDEN_IMAGE_FILES


def outage_body():
    return {
        "status": 500,
        "type": "https://kodera.io/problems/internal-error",
        "title": "Internal error",
        "request_id": "request-123",
    }


def outage_headers():
    return {"cache-control": "no-store", "x-request-id": "request-123"}


@pytest.mark.parametrize("change", ["missing-type", "missing-id", "mismatched-id", "unsafe-id"])
def test_outage_requires_complete_matching_safe_problem(change):
    module = controller_module()
    body, headers = outage_body(), outage_headers()
    if change == "missing-type":
        del body["type"]
    elif change == "missing-id":
        del body["request_id"]
    elif change == "mismatched-id":
        headers["x-request-id"] = "another-123"
    else:
        body["request_id"] = headers["x-request-id"] = "bad\nrequest"
    with pytest.raises(module.ControllerError, match="database outage response refused"):
        module.require_outage_response(500, body, headers)


def api_runtime_fixture():
    return {
        "HostConfig": {
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges:true"],
            "Tmpfs": {"/tmp": "rw,noexec,nosuid,size=64m"},  # noqa: S108 - container-local bounded tmpfs, never a host directory
        },
        "Config": {
            "Env": [
                key + "=" + value
                for key, value in controller_module().api_environment("reader", "[]").items()
            ]
        },
    }


def test_api_runtime_hardening_and_environment_control():
    module = controller_module()
    args = module.api_runtime_arguments()
    assert "--read-only" in args
    assert args[args.index("--tmpfs") + 1] == "/tmp:rw,noexec,nosuid,size=64m"  # noqa: S108 - container-local bounded tmpfs, never a host directory
    assert args[args.index("--cap-drop") + 1] == "ALL"
    assert args[args.index("--security-opt") + 1] == "no-new-privileges:true"
    module.require_api_runtime(
        api_runtime_fixture(), module.api_environment("reader", "[]"), ["synthetic-owner"]
    )


@pytest.mark.parametrize(
    "key,value",
    [
        ("ReadonlyRootfs", False),
        ("CapDrop", []),
        ("SecurityOpt", []),
        ("Tmpfs", {"/tmp": "size=1g"}),  # noqa: S108 - container-local bounded tmpfs, never a host directory
    ],
)
def test_api_runtime_refuses_missing_hardening(key, value):
    module = controller_module()
    details = api_runtime_fixture()
    details["HostConfig"][key] = value
    with pytest.raises(module.ControllerError, match="API runtime boundary refused"):
        module.require_api_runtime(details, module.api_environment("reader", "[]"), [])


@pytest.mark.parametrize(
    "name",
    [
        "SCW_SECRET_KEY",
        "KC_DB_PASSWORD",
        "POSTGRES_PASSWORD",
        "KEYCLOAK_ADMIN",
        "SOPS_AGE_KEY_FILE",
    ],
)
def test_actual_api_environment_refuses_forbidden_names_even_empty(name):
    module = controller_module()
    details = api_runtime_fixture()
    details["Config"]["Env"].append(name + "=")
    with pytest.raises(module.ControllerError, match="API runtime boundary refused"):
        module.require_api_runtime(details, module.api_environment("reader", "[]"), [])


def test_reader_sql_has_finite_lock_and_statement_timeouts(monkeypatch):
    module = controller_module()
    seen = []

    def stop_after_capture(**arguments):
        seen.append(arguments)
        raise RuntimeError("captured without connecting")

    monkeypatch.setattr(module.psycopg, "connect", stop_after_capture)
    with pytest.raises(RuntimeError, match="captured without connecting"):
        module.qualify_reader(18431, "synthetic-reader")
    assert seen[0]["options"] == "-c lock_timeout=5000 -c statement_timeout=30000"


def test_new_function_defaults_remove_global_public_execute():
    """Bind provisioning to the actual PostgreSQL paired-control result."""
    statements = []

    class CaptureProvisioning:
        def execute(self, statement):
            if isinstance(statement, str):
                statements.append(statement)
                if statement.startswith("CREATE FUNCTION reader_later_function"):
                    raise RuntimeError("captured before function creation")

    with pytest.raises(RuntimeError, match="captured before function creation"):
        controller_module().provision_reader(CaptureProvisioning(), "synthetic-reader")
    assert "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC" in statements[:-1], (
        "new functions retain global PUBLIC EXECUTE"
    )


@pytest.mark.parametrize("role", ["reader", "provider"])
def test_database_catalogue_refuses_extra_connectable_database(role):
    module = controller_module()
    facts = catalogue()
    key = "connectable_databases" if role == "reader" else "provider_connectable_databases"
    facts[key].append("postgres")
    with pytest.raises(module.ControllerError, match="reader catalogue is not least privilege"):
        module.require_reader_catalogue(facts)


def test_fixed_phase_emits_only_its_closed_name(capsys):
    module = controller_module()
    assert module.phase("database-login-setup") == "database-login-setup"
    assert json.loads(capsys.readouterr().out) == {"phase": "database-login-setup"}


def test_unknown_phase_refuses_without_reflection(capsys):
    module = controller_module()
    with pytest.raises(module.ControllerError, match="unknown controller phase"):
        module.phase("sensitive-phase-sentinel")
    assert "sensitive-phase-sentinel" not in capsys.readouterr().out


def test_database_failure_diagnostic_never_reflects_exception_text():
    module = controller_module()
    error = psycopg.errors.InsufficientPrivilege("sensitive-database-sentinel")
    observed = module.failure_details("database-login-setup", error)
    assert observed == {
        "phase": "database-login-setup",
        "category": "database-error",
        "sqlstate": "42501",
    }
    assert "sensitive-database-sentinel" not in json.dumps(observed)


def test_subprocess_failure_diagnostic_never_reflects_arguments_or_output():
    import subprocess

    module = controller_module()
    error = subprocess.CalledProcessError(
        125,
        ["/usr/local/bin/docker", "run", "-e", "SECRET=sensitive-command-sentinel"],
        output="sensitive-output-sentinel",
        stderr="sensitive-error-sentinel",
    )
    observed = module.failure_details("provider-start", error)
    assert observed == {
        "phase": "provider-start",
        "category": "subprocess-failure",
        "docker_subcommand": "run",
        "returncode": 125,
    }
    assert "sentinel" not in json.dumps(observed)


def test_unknown_failure_values_are_not_reflected():
    module = controller_module()
    assert module.failure_details(
        "sensitive-stage-sentinel", ValueError("sensitive-error-sentinel")
    ) == {"phase": "unknown", "category": "value-error"}


def test_child_environment_preserves_bytecode_suppression_without_bulk_forwarding(monkeypatch):
    module = controller_module()
    monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "0")
    monkeypatch.setenv("SCW_SECRET_KEY", "sensitive-environment-sentinel")
    value = module.child_environment()
    assert value["PYTHONDONTWRITEBYTECODE"] == "1"
    assert "SCW_SECRET_KEY" not in value


def test_database_readiness_requires_explicit_tcp(monkeypatch):
    module = controller_module()
    calls = []

    def command(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(module, "docker", command)
    assert module.database_tcp_ready("owned-db") is True
    args, kwargs = calls[0]
    assert args == (
        "exec",
        "owned-db",
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "fixture_owner",
        "-d",
        "kodera_server",
    )
    assert kwargs == {"check": False, "timeout": 3}


def test_diagnostic_failure_stays_failing_and_still_cleans_up(monkeypatch, capsys):
    import subprocess

    module = controller_module()
    cleaned = []
    monkeypatch.setattr(module, "disk_reserve", lambda: None)
    monkeypatch.setattr(module, "cleanup", lambda *args: cleaned.append(True))

    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(
            125,
            ["docker", "inspect", "sensitive-command-sentinel"],
            stderr="sensitive-error-sentinel",
        )

    monkeypatch.setattr(module, "docker", fail)
    with pytest.raises(module.ControllerError, match="owned customer HTTP qualification failed"):
        module.main()
    output = capsys.readouterr().out
    assert "sentinel" not in output
    events = [json.loads(line) for line in output.splitlines()]
    assert events == [
        {"phase": "preflight"},
        {
            "failure": {
                "phase": "preflight",
                "category": "subprocess-failure",
                "docker_subcommand": "inspect",
                "returncode": 125,
            }
        },
        {"phase": "cleanup"},
    ]
    assert cleaned == [True]


def provider_resource_details():
    return {
        "Image": "synthetic-image",
        "HostConfig": {"Memory": 1024**3, "MemorySwap": 1024**3, "NanoCpus": 1000000000},
        "Mounts": [],
        "NetworkSettings": {"Ports": {}},
    }


@pytest.mark.parametrize("shape", ["absent", "empty", "configured"])
def test_resource_observation_preserves_optional_tmpfs(shape, monkeypatch, capsys):
    module = controller_module()
    details = provider_resource_details()
    expected = {}
    if shape == "empty":
        details["HostConfig"]["Tmpfs"] = {}
    elif shape == "configured":
        expected = {"/tmp": "rw,noexec,nosuid,size=64m"}  # noqa: S108 - container metadata only; no host path is accessed
        details["HostConfig"]["Tmpfs"] = expected
    monkeypatch.setattr(module, "require_owned", lambda *args: details)
    module.resource_evidence("synthetic-provider", 1024**3, "synthetic-owner")
    assert json.loads(capsys.readouterr().out)["tmpfs"] == expected


@pytest.mark.parametrize("field", ["Memory", "MemorySwap", "NanoCpus"])
def test_optional_metadata_does_not_relax_resource_caps(field, monkeypatch):
    module = controller_module()
    details = provider_resource_details()
    details["HostConfig"][field] += 1
    monkeypatch.setattr(module, "require_owned", lambda *args: details)
    with pytest.raises(module.ControllerError, match="owned resource limits differ"):
        module.resource_evidence("synthetic-provider", 1024**3, "synthetic-owner")


def test_optional_metadata_does_not_relax_volume_refusal(monkeypatch):
    module = controller_module()
    details = provider_resource_details()
    details["Mounts"] = [{"Type": "volume"}]
    monkeypatch.setattr(module, "require_owned", lambda *args: details)
    with pytest.raises(module.ControllerError, match="unexpectedly retain a volume"):
        module.resource_evidence("synthetic-provider", 1024**3, "synthetic-owner")


def startup_classifier():
    classifier = getattr(controller_module(), "startup_connect_refusal", None)
    assert callable(classifier), "startup refusal classifier is absent"
    return classifier


@pytest.mark.parametrize("database", ["identity", "postgres"])
def test_startup_denial_preserves_actual_missing_sqlstate(database):
    error = psycopg.OperationalError(
        f'connection failed: permission denied for database "{database}" sensitive-sentinel'
    )
    observed = startup_classifier()(error, database)
    assert observed == {
        "probe": "CONNECT " + database,
        "semantic_denial": "startup-permission-denied",
        "exception_category": "operational-error",
        "sqlstate": None,
    }
    assert "sensitive-sentinel" not in json.dumps(observed)


def test_explicit_startup_permission_code_is_retained():
    observed = startup_classifier()(
        psycopg.errors.InsufficientPrivilege("sensitive-sentinel"), "identity"
    )
    assert observed == {
        "probe": "CONNECT identity",
        "semantic_denial": "startup-permission-denied",
        "exception_category": "database-error",
        "sqlstate": "42501",
    }


@pytest.mark.parametrize(
    "kind",
    [
        "wrong-password",
        "missing-database",
        "timeout",
        "wrong-target",
        "other-type",
        "contradictory-code",
    ],
)
def test_nonpermission_startup_failure_refuses(kind):
    message = 'permission denied for database "identity"'
    if kind == "wrong-password":
        error = psycopg.OperationalError("password authentication failed sensitive-sentinel")
    elif kind == "missing-database":
        error = psycopg.OperationalError("database does not exist sensitive-sentinel")
    elif kind == "timeout":
        error = psycopg.errors.ConnectionTimeout(message)
    elif kind == "wrong-target":
        error = psycopg.OperationalError('permission denied for database "postgres"')
    elif kind == "other-type":
        error = RuntimeError(message)
    else:
        error = psycopg.OperationalError(message)
        error.sqlstate = "28P01"
    module = controller_module()
    with pytest.raises(
        module.ControllerError, match="reader database CONNECT refusal was not demonstrated"
    ):
        startup_classifier()(error, "identity")


@pytest.mark.parametrize("database", ["kodera_server", "unknown", 'identity" sensitive-sentinel'])
def test_startup_refusal_scope_is_finite(database):
    module = controller_module()
    error = psycopg.errors.InsufficientPrivilege("sensitive-sentinel")
    with pytest.raises(
        module.ControllerError, match="reader database CONNECT refusal was not demonstrated"
    ):
        startup_classifier()(error, database)


class CatalogueQueryFixture:
    """Offline mapping only; actual ACL counterexamples are separate evidence."""

    def __init__(self, dimension=None):
        self.dimension = dimension

    def execute(self, statement, parameters=()):
        query = str(statement)
        one, rows = None, []
        if query.startswith("SELECT rolcanlogin"):
            one = (True, False, False, False, False, False, False)
        elif query.startswith(("SELECT rolname", "SELECT 'relation'", "SELECT p.proname")):
            pass
        elif query.startswith("SELECT c.oid"):
            rows = list(enumerate(sorted(controller_module().TABLES), 1))
        elif query.startswith("SELECT attnum"):
            rows = [(1,)]
        elif query.startswith("SELECT has_table_privilege"):
            if "'SELECT WITH GRANT OPTION'" in query:
                one = (self.dimension == "table" and parameters[1] == 2,)
            elif "'SELECT'" in query:
                one = (True,)
            else:
                one = (False,)
        elif query.startswith("SELECT has_column_privilege"):
            one = (
                "'SELECT WITH GRANT OPTION'" in query
                and self.dimension == "column"
                and parameters[1] == 2,
            )
        elif query.startswith("SELECT has_schema_privilege"):
            one = (False,)
        elif query.startswith("SELECT has_database_privilege"):
            one = ("'CREATE'" in query and self.dimension == "database",)
        elif query.startswith("SELECT datname"):
            rows = [("kodera_server" if parameters[0] == "customer_api_reader" else "identity",)]
        else:
            raise AssertionError("unrecognized catalogue query in mapping fixture")
        return SimpleNamespace(fetchone=lambda: one, fetchall=lambda: rows)


@pytest.mark.parametrize(
    "dimension,field,expected",
    [
        (None, None, None),
        ("database", "database_create", True),
        ("table", "table_select_grant_options", ["identity_user"]),
        ("column", "column_select_grant_options", [("identity_user", 1)]),
    ],
)
def test_catalogue_queries_measure_each_privilege_dimension(dimension, field, expected):
    module = controller_module()
    facts = module.reader_catalogue(CatalogueQueryFixture(dimension))
    if dimension is None:
        module.require_reader_catalogue(facts)
    else:
        assert facts[field] == expected
        with pytest.raises(module.ControllerError, match="reader catalogue is not least privilege"):
            module.require_reader_catalogue(facts)


def test_reader_qualification_binds_schema_probe_and_startup_classifier(monkeypatch):
    """Inspect invocation order; this fixture is not runtime authority proof."""
    module = controller_module()
    probes, events = [], []

    class Reader:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, _statement):
            events.append("positive-select")
            return SimpleNamespace(fetchone=lambda: (1,))

    def connect(**arguments):
        if arguments["dbname"] == "kodera_server":
            return Reader()
        events.append("startup-" + arguments["dbname"])
        raise psycopg.OperationalError(f'permission denied for database "{arguments["dbname"]}"')

    monkeypatch.setattr(module.psycopg, "connect", connect)
    monkeypatch.setattr(
        module, "run_reader_probe", lambda _connection, _statement, label=None: probes.append(label)
    )
    module.qualify_reader(18431, "synthetic-reader")
    assert len(probes) == 37 and "CREATE SCHEMA forbidden_probe" in probes
    assert events == ["positive-select"] * 5 + ["startup-identity", "startup-postgres"]


def test_directory_and_inherited_detail_image_inventory():
    required = set(controller_module().REQUIRED_IMAGE_FILES)
    assert {
        "apps/orgs/detail_selectors.py",
        "apps/orgs/detail_services.py",
        "apps/orgs/api/__init__.py",
        "apps/orgs/api/detail.py",
        "apps/orgs/api/detail_permissions.py",
        "apps/orgs/api/detail_serializers.py",
        "apps/orgs/membership_selectors.py",
        "apps/orgs/membership_services.py",
        "apps/orgs/membership_pagination.py",
        "apps/orgs/api/memberships.py",
        "apps/orgs/api/membership_permissions.py",
        "apps/orgs/api/membership_serializers.py",
        "apps/orgs/membership_lifecycle.py",
        "apps/orgs/member_set_hooks.py",
        "apps/orgs/api/membership_detail.py",
        "apps/orgs/notice_contacts.py",
        "apps/orgs/api/notice_contacts.py",
        "apps/orgs/api/notice_contact_permissions.py",
    } <= required, "customer image inventory omits a routed module"


def test_disk_floor_is_five_gib(monkeypatch):
    from types import SimpleNamespace

    module = controller_module()
    # Literal bytes: the value is pinned as well as the comparison.
    monkeypatch.setattr("shutil.disk_usage", lambda _: SimpleNamespace(free=5_368_709_120))
    module.disk_reserve()
    monkeypatch.setattr("shutil.disk_usage", lambda _: SimpleNamespace(free=5_368_709_119))
    with pytest.raises(module.ControllerError, match="5 GiB disk reserve required"):
        module.disk_reserve()


@pytest.mark.parametrize(
    "counts",
    [
        {},
        {"identity_user": 26},
        {
            key: 0
            for key in (
                "identity_user",
                "identity_identity",
                "orgs_organisation",
                "orgs_membership",
                "orgs_slugreservation",
            )
        },
    ],
)
def test_reader_fixture_count_extension_cannot_remove_a_table_or_accept_empty(counts):
    module = controller_module()
    with pytest.raises(module.ControllerError, match="reader fixture counts refused"):
        module.qualify_reader(1, "unused", expected_counts=counts)


def test_unknown_scenario_refuses_before_docker(monkeypatch):
    module = controller_module()
    monkeypatch.setattr(
        module, "docker", lambda *a, **k: pytest.fail("unknown scenario reached Docker")
    )
    with pytest.raises(module.ControllerError, match="unknown customer image scenario"):
        module.main(object())


def test_cleanup_refuses_replaced_id_and_still_removes_other_owned_resources(monkeypatch):
    module = controller_module()
    calls = []

    def command(*args, **kwargs):
        calls.append(args)
        if args[:2] == ("ps", "-aq") and "name=" in args[-1]:
            return SimpleNamespace(stdout="present")
        return SimpleNamespace(stdout="")

    def inspect(kind, name, owner):
        return {"Id": "replacement" if name == "api" else "expected-db", "State": {"Paused": False}}

    monkeypatch.setattr(module, "docker", command)
    monkeypatch.setattr(module, "require_owned", inspect)
    with pytest.raises(module.ControllerError, match="cleanup could not be verified"):
        module.cleanup(
            "owner",
            ["db", "api"],
            "network",
            "image",
            expected_ids={("container", "db"): "expected-db", ("container", "api"): "expected-api"},
        )
    assert ("container", "rm", "-f", "api") not in calls
    assert ("container", "rm", "-f", "expected-db") in calls


def test_database_pause_uses_verified_id_and_refuses_replacement(monkeypatch):
    module = controller_module()
    calls = []
    monkeypatch.setattr(module, "docker", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(module, "require_owned", lambda *args: {"Id": "expected-db"})
    with module.paused_database("name", "owner", expected_id="expected-db"):
        pass
    assert calls == [("pause", "expected-db"), ("unpause", "expected-db")]
    calls.clear()
    monkeypatch.setattr(module, "require_owned", lambda *args: {"Id": "replacement"})
    with pytest.raises(module.ControllerError, match="database resource identity differs"):
        with module.paused_database("name", "owner", expected_id="expected-db"):
            pytest.fail("replacement paused")
    assert not calls

"""Fail-closed deployment inputs and the fixed serving/image boundary."""

import importlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured

ROOT = Path(__file__).resolve().parents[1]


def inputs():
    return {
        "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
        "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
        "DATABASE_URL": "postgresql://synthetic:synthetic-pass@db:5432/kodera_server",
    }


def parser():
    assert (ROOT / "config/deploy_environment.py").is_file(), "deploy input parser missing"
    return importlib.import_module("config.deploy_environment").deployment


def test_deployment_requires_explicit_inputs_without_secret_defaults():
    parse = parser()
    for key in inputs():
        values = inputs()
        del values[key]
        with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
            parse(values)
    parsed = parse(inputs())
    assert parsed["ALLOWED_HOSTS"] == ["api.synthetic.test"]
    assert parsed["DATABASES"]["default"]["HOST"] == "db"
    assert parsed["DATABASES"]["default"]["CONN_MAX_AGE"] == 0


@pytest.mark.parametrize("value", ["", "short", "x" * 70, "unsafe\n" * 20])
def test_deployment_refuses_weak_secret(value):
    with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
        parser()({**inputs(), "DJANGO_SECRET_KEY": value})


@pytest.mark.parametrize(
    "value",
    [
        "*",
        ".synthetic.test",
        "https://api.synthetic.test",
        "api.synthetic.test:443",
        "",
        "API.synthetic.test",
        "api.synthetic.test,",
        "user@api.synthetic.test",
    ],
)
def test_deployment_refuses_ambiguous_hosts(value):
    with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
        parser()({**inputs(), "DJANGO_ALLOWED_HOSTS": value})


@pytest.mark.parametrize(
    "value",
    [
        "",
        "sqlite:///tmp/db",
        "postgresql://db/core",
        "postgresql://a:b@db:0/core",
        "postgresql://a:b@db/core?sslmode=disable",
        "postgresql://a:b@db/core#unsafe",
        "postgresql://a:b@db/",
    ],
)
def test_deployment_refuses_ambiguous_database(value):
    with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
        parser()({**inputs(), "DATABASE_URL": value})


@pytest.mark.parametrize(
    "key",
    [
        "SCW_SECRET_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "SSH_PRIVATE_KEY",
        "KEYCLOAK_ADMIN_PASSWORD",
        "SOPS_AGE_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ],
)
@pytest.mark.parametrize("value", ["", "synthetic-private-sentinel"])
def test_deployment_refuses_infrastructure_even_empty_and_redacts(key, value):
    with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused") as caught:
        parser()({**inputs(), key: value})
    assert "synthetic-private-sentinel" not in str(caught.value)


@pytest.mark.parametrize(
    "key,value",
    [
        ("DJANGO_DEBUG", "1"),
        ("DJANGO_SETTINGS_MODULE", "config.settings.e2e"),
        ("GUNICORN_CMD_ARGS", "--reload"),
        ("FORWARDED_ALLOW_IPS", "*"),
    ],
)
def test_deployment_refuses_unreviewed_process_overrides(key, value):
    with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
        parser()({**inputs(), key: value})


def test_fixed_wsgi_has_no_local_profile_fallback():
    path = ROOT / "config/deploy_wsgi.py"
    assert path.is_file(), "fixed deployment WSGI entrypoint missing"
    assert '"config.settings.deploy"' in path.read_text()
    docker = (ROOT / "Dockerfile").read_text()
    command = json.loads(next(line[4:] for line in docker.splitlines() if line.startswith("CMD ")))
    assert command == [
        "gunicorn",
        "--config",
        "config/gunicorn.py",
        "config.deploy_wsgi:application",
    ], "production command is not fixed Gunicorn"


@pytest.mark.parametrize("discovery_key", [None, "malformed", "Y" * 43 + "="])
def test_deployment_profile_starts_without_database_access_or_local_settings(discovery_key):
    assert (ROOT / "config/settings/deploy.py").is_file(), "deployment settings missing"
    program = """
import django, json, os, sys
from django.conf import settings
django.setup()
from django.urls import get_resolver
get_resolver().url_patterns
assert settings.KODERA_DISCOVERY_HMAC_KEY == os.environ.get('KODERA_DISCOVERY_HMAC_KEY')
assert settings.DEBUG is False
assert settings.SECURE_PROXY_SSL_HEADER is None
assert not settings.KODERA_LOOPBACK_ISSUERS
assert 'config.settings.dev' not in sys.modules
assert 'config.settings.persistence' not in sys.modules
assert 'config.settings.e2e' not in sys.modules
assert 'apps.outbox' not in settings.INSTALLED_APPS
print(json.dumps({'loaded': True}))
"""
    result = subprocess.run(  # noqa: S603 - fixed isolated probe
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
            **inputs(),
            **({"KODERA_DISCOVERY_HMAC_KEY": discovery_key} if discovery_key is not None else {}),
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"loaded": True}


def test_input_guards_refuse_exact_source_mutations():
    source = (ROOT / "config/deploy_environment.py").read_text()
    cases = [
        (
            "name not in NONCREDENTIAL_METADATA_NAMES",
            "False and name not in NONCREDENTIAL_METADATA_NAMES",
            # A banned name the credential-shape rule does not also refuse, so only the list can.
            {**inputs(), "SCW_DEFAULT_ORGANIZATION_ID": ""},
        ),
        ("len(secret) <= 512", "len(secret) <= 512", {**inputs(), "DJANGO_SECRET_KEY": "x" * 70}),
        (
            "not all(HOST.fullmatch(h) for h in hosts)",
            "False",
            {**inputs(), "DJANGO_ALLOWED_HOSTS": "*"},
        ),
    ]
    for before, after, value in cases:
        if before == after:
            before, after = "len(set(secret)) < 8", "False"
        assert source.count(before) == 1, "mutation anchor moved"
        namespace = {"__name__": "production_guard_mutant"}
        exec(compile(source.replace(before, after), "<production-guard-mutant>", "exec"), namespace)  # noqa: S102 - owned source mutation only
        assert namespace["deployment"](value), "guard mutation was not exercised"
        # The unmodified guard must refuse the same weakening's input.
        with pytest.raises(ImproperlyConfigured, match="Deployment configuration refused"):
            parser()(value)


def test_production_image_excludes_test_and_operator_settings():
    from test_development_boundary import assert_image_boundary, image_files

    files = image_files(ROOT)
    forbidden = ("test.py", "e2e.py", "e2e_operator.py", "job_queue.py")
    for name in forbidden:
        assert "config/settings/" + name not in files
        rules = (ROOT / ".dockerignore").read_text().splitlines()
        rules.remove("config/settings/" + name)
        with pytest.raises(AssertionError, match="image carries"):
            assert_image_boundary(rules)


FAULT_PROBE = """
import django, json, sys, threading
django.setup()
from django.conf import settings
from core import faults
from apps.orgs.api import intake
refused = []
for point, spec in faults.POINTS.items():
    barrier = None
    if spec.mode == "hold":
        barrier = type("Barrier", (), {})()
        barrier.reached, barrier.released = threading.Event(), threading.Event()
    try:
        faults.arm(point, hold=barrier)
    except faults.FaultPointsRefused as error:
        refused.append(str(error).startswith("fault points are refused"))
    else:
        refused.append(False)
print(json.dumps({
    "refused": refused,
    "inert": [faults.reach(site) is None for site in faults.SITES],
    "permitted": hasattr(settings, "FAULT_POINTS_PERMITTED"),
    "test_machinery": sorted(n for n in sys.modules if n.startswith("django.test")),
}))
"""


def test_the_deployment_profile_ships_the_fault_points_inert_and_refuses_every_arm():
    from test_development_boundary import image_files

    from core import faults

    assert "core/faults.py" in image_files(ROOT), "the intake's fault-point module is not imaged"
    result = subprocess.run(  # noqa: S603 - fixed isolated probe
        [sys.executable, "-c", FAULT_PROBE],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
            **inputs(),
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "refused": [True] * len(faults.POINTS),
        "inert": [True] * len(faults.SITES),
        "permitted": False,
        "test_machinery": [],
    }, "the deployment profile armed a fault point, or carries the test permission or machinery"


def test_hosted_controller_ownership_and_resource_guards_have_mutations():
    from copy import deepcopy

    from dev.accept_production_http import LABEL, OWNER, owned, require, resources

    details = {
        "Config": {"Labels": {LABEL: OWNER}},
        "HostConfig": {
            "Memory": 512,
            "MemorySwap": 512,
            "NanoCpus": 1_000_000_000,
            "Privileged": False,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges"],
        },
        "Mounts": [{"Type": "tmpfs"}],
    }
    owned(details, "container")
    resources(details, 512)
    with pytest.raises(AssertionError):
        require(False, "control refused")
    changed = deepcopy(details)
    changed["Config"]["Labels"][LABEL] = "unrelated"
    with pytest.raises(AssertionError, match="owner mismatch"):
        owned(changed, "container")
    for key, value in [
        ("Memory", 0),
        ("MemorySwap", -1),
        ("NanoCpus", 0),
        ("Privileged", True),
        ("CapDrop", []),
        ("SecurityOpt", []),
    ]:
        changed = deepcopy(details)
        changed["HostConfig"][key] = value
        with pytest.raises(AssertionError):
            resources(changed, 512)
    changed = deepcopy(details)
    changed["Mounts"] = [{"Type": "volume"}]
    with pytest.raises(AssertionError):
        resources(changed, 512)


def test_reverted_server_default_is_a_named_refusal():
    from dev.accept_production_http import production_command

    source = (ROOT / "Dockerfile").read_text()
    command = json.loads(next(line[4:] for line in source.splitlines() if line.startswith("CMD ")))
    production_command(command)
    original = next(line for line in source.splitlines() if line.startswith("CMD "))
    mutant = source.replace(original, 'CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]')
    command = json.loads(next(line[4:] for line in mutant.splitlines() if line.startswith("CMD ")))
    with pytest.raises(AssertionError, match="fixed Gunicorn"):
        production_command(command)


def test_deployment_issuer_boundary_rejects_real_loopback_snapshot():
    import time

    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="synthetic", alg="RS256", use="sig", key_ops=["verify"])
    trust = json.dumps(
        [
            {
                "lane": "customer",
                "issuer": "http://127.0.0.1/realms/alpha",
                "generation": "synthetic",
                "expires_at": int(time.time()) + 600,
                "public_jwks": {"keys": [public]},
            }
        ]
    )
    result = subprocess.run(  # noqa: S603 - fixed settings import; synthetic public snapshot
        [sys.executable, "-c", "import config.settings.deploy"],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
            **inputs(),
            "KODERA_AUTH_TRUST": trust,
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode != 0
    assert "plain-http or loopback issuer" in result.stderr
    assert inputs()["DJANGO_SECRET_KEY"] not in result.stderr


def test_hosted_admission_refuses_without_allocating_resources(monkeypatch):
    from types import SimpleNamespace

    from dev import accept_production_http as qualification

    def allocated(*args, **kwargs):
        raise AssertionError("resource allocation reached before admission")

    monkeypatch.setattr(qualification, "docker", allocated)
    monkeypatch.setattr(qualification, "source_hashes", allocated)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    with pytest.raises(AssertionError, match="hosted-only qualification"):
        qualification.run()
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    # Literal bytes, not RESERVE: the value is pinned as well as the comparison (5 GiB).
    monkeypatch.setattr(
        qualification.shutil, "disk_usage", lambda _: SimpleNamespace(free=5_368_709_119)
    )
    with pytest.raises(AssertionError, match="5 GiB disk reserve required"):
        qualification.run()
    monkeypatch.setattr(
        qualification.shutil, "disk_usage", lambda _: SimpleNamespace(free=5_368_709_120)
    )
    # Positive admission reaches the tracked-source proof, before allocating Docker resources.
    with pytest.raises(AssertionError, match="resource allocation reached before admission"):
        qualification.run()


def test_cleanup_cannot_treat_daemon_failure_as_verified_absence(monkeypatch):
    from subprocess import CalledProcessError
    from types import SimpleNamespace

    from dev import accept_production_http as qualification

    def unavailable(*args, **kwargs):
        if "inspect" in args:
            return SimpleNamespace(returncode=1, stdout="")
        raise CalledProcessError(1, ["docker", "container", "ls"])

    monkeypatch.setattr(qualification, "docker", unavailable)
    with pytest.raises(CalledProcessError):
        qualification.remove("container", "owned-synthetic")

    def present(*args, **kwargs):
        return SimpleNamespace(
            returncode=1 if "inspect" in args else 0,
            stdout="" if "inspect" in args else '{"Names":"owned-synthetic"}\n',
        )

    monkeypatch.setattr(qualification, "docker", present)
    with pytest.raises(AssertionError, match="owned resource remains"):
        qualification.remove("container", "owned-synthetic")
    monkeypatch.setattr(
        qualification, "docker", lambda *a, **kw: SimpleNamespace(returncode=0, stdout="")
    )
    qualification.absent("container", "owned-synthetic")


def test_same_process_proof_refuses_worker_replacement_under_unchanged_master():
    from dev.accept_production_http import same_process

    original = {"workers": 2, "uid": 10001, "worker_ids": ["2", "3"]}
    same_process(10, 10, original, original)
    replacement = {**original, "worker_ids": ["2", "4"]}
    with pytest.raises(AssertionError, match="workers were replaced"):
        same_process(10, 10, original, replacement)
    with pytest.raises(AssertionError, match="master was replaced"):
        same_process(10, 11, original, original)


def test_actual_legacy_controller_builds_explicit_e2e_overlay(tmp_path):
    from test_development_boundary import image_files

    from dev import accept_customer_http as legacy

    assert "config/settings/e2e.py" not in image_files(ROOT)
    build = tmp_path / "qualification"
    build.mkdir()
    assert hasattr(legacy, "qualification_build_context"), (
        "actual legacy controller overlay missing"
    )
    import ast
    import inspect

    calls = [
        node
        for node in ast.walk(ast.parse(inspect.getsource(legacy.main)))
        if isinstance(node, ast.Call)
    ]
    assert any(
        isinstance(node.func, ast.Name) and node.func.id == "qualification_build_context"
        for node in calls
    ), "actual controller no longer builds its explicit overlay"
    legacy.qualification_build_context(build)
    assert (build / "config/settings/e2e.py").read_bytes() == (
        ROOT / "config/settings/e2e.py"
    ).read_bytes()
    assert "config/settings/e2e.py" in image_files(build)
    assert "config/settings/e2e_operator.py" not in image_files(build)
    assert "config/settings/job_queue.py" not in image_files(build)
    assert "config/settings/e2e.py" not in image_files(ROOT)


def test_actual_legacy_overlay_refuses_production_e2e_widening(tmp_path, monkeypatch):
    from dev import accept_customer_http as legacy

    source = tmp_path / "source"
    source.mkdir()
    for name in ("Dockerfile", ".dockerignore", "pyproject.toml", "uv.lock", "manage.py"):
        (source / name).write_bytes((ROOT / name).read_bytes())
    for name in ("config", "core", "apps", "services"):
        (source / name).mkdir(exist_ok=True)
    ignore = source / ".dockerignore"
    ignore.write_text(ignore.read_text().replace("config/settings/e2e.py\n", ""))
    monkeypatch.setattr(legacy, "ROOT", source)
    build = tmp_path / "build"
    build.mkdir()
    with pytest.raises(legacy.ControllerError, match="production e2e exclusion is missing"):
        legacy.qualification_build_context(build)


def dockerfile_sources(dockerfile):
    """The local sources of every COPY, read independently of the controller's own parser."""
    sources = []
    for line in dockerfile.read_text().splitlines():
        words = line.split()
        if words[:1] != ["COPY"] or any(word.startswith("--from=") for word in words):
            continue
        sources.extend(word.rstrip("/") for word in words[1:-1])
    return sources


def test_actual_legacy_overlay_carries_every_dockerfile_copy_root(tmp_path):
    from dev import accept_customer_http as legacy

    sources = dockerfile_sources(ROOT / "Dockerfile")
    # The roots the image needs beyond the first slice's four; a vacuous read would miss them.
    assert {"tenant_agent", "room_access", "config", "manage.py"} <= set(sources)
    build = tmp_path / "qualification"
    build.mkdir()
    legacy.qualification_build_context(build)
    missing = [name for name in sources if not (build / name).exists()]
    assert missing == [], f"COPY roots absent from the qualification context: {missing}"
    for name in sources:
        if (ROOT / name).is_dir():
            assert (build / name / "__init__.py").read_bytes() == (
                ROOT / name / "__init__.py"
            ).read_bytes()


def test_actual_legacy_overlay_follows_a_new_copy_root(tmp_path, monkeypatch):
    from dev import accept_customer_http as legacy

    source = tmp_path / "source"
    source.mkdir()
    (source / "Dockerfile").write_text(
        "FROM scratch AS runtime\nCOPY --from=elsewhere /x /x\nCOPY manage.py ./\n"
        "COPY added_root/ ./added_root/\n"
    )
    (source / ".dockerignore").write_text("**\nconfig/settings/e2e.py\n")
    for name in ("pyproject.toml", "uv.lock", "manage.py"):
        (source / name).write_text("synthetic\n")
    (source / "added_root").mkdir()
    (source / "added_root/__init__.py").write_text("ADDED = True\n")
    monkeypatch.setattr(legacy, "ROOT", source)
    build = tmp_path / "build"
    build.mkdir()
    legacy.qualification_build_context(build)
    assert (build / "added_root/__init__.py").read_text() == "ADDED = True\n"
    assert not (build / "elsewhere").exists() and not (build / "x").exists()


def shape_fixture(tmp_path, monkeypatch, dockerfile):
    from dev import accept_customer_http as legacy

    source = tmp_path / "source"
    source.mkdir()
    (source / "Dockerfile").write_text(dockerfile)
    (source / ".dockerignore").write_text("**\nconfig/settings/e2e.py\n")
    for name in ("manage.py", "pyproject.toml"):
        (source / name).write_text("synthetic\n")
    monkeypatch.setattr(legacy, "ROOT", source)
    build = tmp_path / "build"
    build.mkdir()
    return legacy, build


@pytest.mark.parametrize(
    "lines",
    [
        ['COPY ["manage.py", "./"]'],
        ["COPY manage.py \\", "    ./"],
        ["COPY manage.py pyproject.toml\\", "    ./x/"],
        ["COPY added_*/ ./"],
        ["ADD manage.py ./"],
        ["COPY --link manage.py ./"],
        ["COPY ../outside ./"],
        ["COPY added_root/../manage.py ./"],
    ],
    ids=[
        "json-form",
        "continuation",
        "attached-continuation",
        "glob",
        "add",
        "flag",
        "parent",
        "embedded-parent",
    ],
)
def test_actual_legacy_overlay_refuses_a_copy_shape_it_cannot_read(tmp_path, monkeypatch, lines):
    # A readable COPY sits next to the bad line: the refusal is the bad line's own, never the
    # empty-sources one, so skipping the bad line would let this pass silently.
    dockerfile = "\n".join(["FROM scratch AS runtime", "COPY manage.py ./", *lines, ""])
    legacy, build = shape_fixture(tmp_path, monkeypatch, dockerfile)
    with pytest.raises(
        legacy.ControllerError, match=re.escape("not understood: " + lines[0].strip())
    ):
        legacy.qualification_build_context(build)
    assert list(build.iterdir()) == []


def test_actual_legacy_overlay_refuses_a_dockerfile_with_no_copy_from_the_context(
    tmp_path, monkeypatch
):
    legacy, build = shape_fixture(
        tmp_path, monkeypatch, "FROM scratch AS runtime\nCOPY --from=elsewhere /x /x\n"
    )
    with pytest.raises(legacy.ControllerError, match="no COPY from the context"):
        legacy.qualification_build_context(build)
    assert list(build.iterdir()) == []


def test_actual_legacy_overlay_refuses_an_already_admitted_overlay(tmp_path, monkeypatch):
    from dev import accept_customer_http as legacy

    source = tmp_path / "source"
    source.mkdir()
    for name in ("Dockerfile", ".dockerignore", "pyproject.toml", "uv.lock", "manage.py"):
        (source / name).write_bytes((ROOT / name).read_bytes())
    ignore = source / ".dockerignore"
    # The production exclusion is still there, but a later line re-admits the overlay.
    ignore.write_text(ignore.read_text() + "!config/settings/e2e.py\n")
    monkeypatch.setattr(legacy, "ROOT", source)
    build = tmp_path / "build"
    build.mkdir()
    with pytest.raises(legacy.ControllerError, match="production context already admits"):
        legacy.qualification_build_context(build)
    assert list(build.iterdir()) == []


def test_owned_published_port_refuses_missing_or_external_mapping():
    from dev import accept_production_http as qualification

    assert hasattr(qualification, "published_port"), "owned loopback port-shape guard missing"
    good = {
        "NetworkSettings": {"Ports": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "12345"}]}}
    }
    assert qualification.published_port(good, "5432/tcp") == 12345
    for entries in (
        None,
        [],
        [{"HostIp": "0.0.0.0", "HostPort": "12345"}],  # noqa: S104 - refused synthetic binding
        [{"HostIp": "127.0.0.1", "HostPort": "0"}],
        [{"HostIp": "127.0.0.1", "HostPort": "invalid"}],
    ):
        with pytest.raises(AssertionError, match="owned loopback published port refused"):
            qualification.published_port(
                {"NetworkSettings": {"Ports": {"5432/tcp": entries}}}, "5432/tcp"
            )


def test_operator_fixture_has_a_callable_actual_seed_path():
    from dev import accept_production_http as qualification

    assert hasattr(qualification, "seed_fixture"), "actual transaction-safe fixture seed missing"


def test_synthetic_reader_policy_refuses_extra_authority_and_missing_evidence():
    from dev.accept_production_http import reader_policy

    good = dict.fromkeys(
        [
            "attributes_safe",
            "owns_nothing",
            "database_readonly",
            "schema_readonly",
            "exact_select_tables",
            "no_table_writes",
            "default_readonly",
        ],
        True,
    )
    reader_policy(good)
    for key in good:
        with pytest.raises(AssertionError, match="synthetic reader authority refused"):
            reader_policy({**good, key: False})
        with pytest.raises(AssertionError, match="synthetic reader authority refused"):
            reader_policy({k: v for k, v in good.items() if k != key})
    with pytest.raises(AssertionError, match="synthetic reader authority refused"):
        reader_policy({**good, "owns_nothing": 1})


def test_http_diagnostic_phases_identify_closed_predicates_without_values():
    import ast

    tree = ast.parse((ROOT / "dev/accept_production_http.py").read_text())
    phases = {
        node.value.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "PHASE" for target in node.targets)
        and isinstance(node.value, ast.Constant)
    }
    required = {
        "http-readiness",
        "http-process-boundary",
        "http-live",
        "http-anonymous",
        "http-signed-customer-read",
        "http-unknown-host",
        "http-database-outage-ready",
        "http-database-outage-live",
        "http-database-recovery-ready",
        "http-database-recovery-process",
        "http-database-recovery-customer-read",
        "http-log-secrecy",
        "graceful-shutdown",
    }
    assert required <= phases, "closed HTTP predicate phases missing"
    assert "http-runtime-proof" not in phases


def test_readiness_refusal_emits_only_closed_status_booleans(monkeypatch, capsys):
    from dev import accept_production_http as qualification

    monkeypatch.setattr(qualification, "request", lambda *a, **k: (503, b"unpublished-response"))
    monkeypatch.setattr(qualification.time, "sleep", lambda *_: None)
    with pytest.raises(AssertionError, match="owned API readiness did not become true"):
        qualification.wait_ready(12345)
    output = capsys.readouterr().out
    assert "unpublished-response" not in output
    proof = json.loads(output)
    assert proof["http_readiness_codes"]["unavailable"] is True
    assert all(type(value) is bool for value in proof["http_readiness_codes"].values())


def test_readiness_log_diagnostic_refuses_foreign_owner_before_logs(monkeypatch):
    from dev import accept_production_http as qualification

    monkeypatch.setattr(qualification, "inspect", lambda *_: {"Config": {"Labels": {}}})
    monkeypatch.setattr(qualification, "docker", lambda *_a, **_k: pytest.fail("foreign logs read"))
    with pytest.raises(AssertionError, match="resource owner mismatch"):
        qualification.owned_runtime_diagnostics("foreign")


def test_readiness_startup_diagnostic_never_emits_captured_log_values(monkeypatch, capsys):
    from types import SimpleNamespace

    from dev import accept_production_http as qualification

    monkeypatch.setattr(
        qualification,
        "inspect",
        lambda *_: {
            "Config": {"Labels": {qualification.LABEL: qualification.OWNER}},
            "State": {"Running": False, "Status": "exited", "OOMKilled": False},
        },
    )

    def logs(*arguments, **options):
        assert arguments == ("logs", "--tail", "100", "owned"), (
            "owned diagnostic log read unbounded"
        )
        return SimpleNamespace(
            stdout="private-unpublished-text ModuleNotFoundError private-secret",
            stderr="Worker failed to boot",
        )

    monkeypatch.setattr(qualification, "docker", logs)
    qualification.owned_runtime_diagnostics("owned")
    output = capsys.readouterr().out
    assert "private-unpublished-text" not in output and "private-secret" not in output
    proof = json.loads(output)
    assert proof["runtime_startup_codes"]["missing_module"] is True
    assert proof["runtime_startup_codes"]["worker_boot_failure"] is True
    assert proof["runtime_exited"] is True
    assert all(type(value) is bool for value in proof["runtime_startup_codes"].values())


def test_actual_pinned_gunicorn_accepts_source_and_disables_forwarder_headers(monkeypatch):
    import runpy

    import gunicorn
    from gunicorn.config import Config

    assert gunicorn.__version__ == "26.2.0"
    monkeypatch.setattr(os, "environ", inputs())
    source = runpy.run_path(str(ROOT / "config/gunicorn.py"))
    actual = Config()
    for key, value in source.items():
        if key in actual.settings:
            actual.set(key, value)
    assert actual.forwarder_headers == []
    assert actual.forwarded_allow_ips == []
    assert actual.secure_scheme_headers == {}
    assert actual.proxy_protocol == "off"
    with pytest.raises(TypeError, match="Not a string"):
        actual.set("forwarder_headers", [])


def test_nonempty_forwarder_mutation_refuses_actual_effective_trust(monkeypatch, tmp_path):
    import runpy

    from gunicorn.config import Config

    monkeypatch.setattr(os, "environ", inputs())

    def acceptance(path):
        actual = Config()
        for key, value in runpy.run_path(str(path)).items():
            if key in actual.settings:
                actual.set(key, value)
        assert actual.forwarder_headers == [], "empty forwarder header trust required"

    path = ROOT / "config/gunicorn.py"
    acceptance(path)
    original = path.read_text()
    assert original.count('forwarder_headers = ""') == 1
    mutant = tmp_path / "gunicorn-mutated.py"
    mutant.write_text(
        original.replace('forwarder_headers = ""', 'forwarder_headers = "SCRIPT_NAME"')
    )
    with pytest.raises(AssertionError, match="empty forwarder header trust required"):
        acceptance(mutant)

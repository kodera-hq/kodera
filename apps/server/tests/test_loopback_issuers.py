"""Only the isolated test and local end-to-end profiles trust a plain-http or loopback issuer.

The local fixtures' identity providers are loopback ones, and their keys are derived from public
labels (dev/e2e/make_trust.py), so anyone can sign their tokens. A trust configuration that admitted
one of their issuers in a deployable profile would admit forged tokens. `config.environment`
refuses such an issuer at start unless the selected settings module is one of LOOPBACK_PROFILES,
`config.settings.test`, `config.settings.e2e` and `config.settings.e2e_operator`; `config.settings.customer_http`, the
image's API profile, and `config.settings.job_queue`, the operator commands', refuse it.
"""

import ast
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from django.core.exceptions import ImproperlyConfigured
from test_workspace_test_profiles import assert_loopback_startup, loopback_startup

from config.environment import LOOPBACK_PROFILES, auth_trust, is_loopback_host, loopback_profile
from dev.e2e import make_trust

ROOT = Path(__file__).resolve().parents[1]
TRUST_REFUSED = (
    "KODERA_AUTH_TRUST admits a plain-http or loopback issuer, which only a local profile may trust"
)
STAFF_REFUSED = (
    "KODERA_STAFF_ISSUER is a plain-http or loopback issuer, which only a local profile may trust"
)
DEPLOYED = "https://auth.kodera.io/realms/kodera-staff"
# The live end-to-end fixture's own trust and staff issuer, as dev/e2e/compose.yaml passes them.
FIXTURE_TRUST = make_trust.trust_json(make_trust.DEFAULT_KEYCLOAK_ORIGIN)
FIXTURE_STAFF = make_trust.issuer(make_trust.DEFAULT_KEYCLOAK_ORIGIN, make_trust.STAFF_REALM)
_KEY: list[dict] = []


def trust(*entries):
    if not _KEY:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
        public.update(kid="loopback-issuer-fixture", alg="RS256", use="sig", key_ops=["verify"])
        _KEY.append(public)
    return json.dumps(
        [
            {
                "lane": lane,
                "issuer": issuer,
                "generation": "loopback-issuer-fixture",
                "expires_at": int(time.time()) + 3600,
                "public_jwks": {"keys": [_KEY[0]]},
            }
            for lane, issuer in entries
        ]
    )


# Every spelling of the machine itself, each a case of its own: (id, host as written in a URL).
LOOPBACK_SPELLINGS = [
    ("localhost", "localhost"),
    ("localhost-upper", "LocalHost"),
    ("localhost-trailing-dot", "localhost."),
    ("under-localhost", "keycloak.localhost"),
    ("localhost-localdomain", "localhost.localdomain"),
    ("ip6-localhost", "ip6-localhost"),
    ("ip6-loopback", "ip6-loopback"),
    ("ipv4-loopback", "127.0.0.1"),
    ("ipv4-loopback-net", "127.255.0.9"),
    ("ipv4-short", "127.1"),
    ("ipv4-decimal", "2130706433"),
    ("ipv4-hex", "0x7f000001"),
    ("ipv4-octal", "0177.0.0.1"),
    ("ipv4-zero", "0"),
    ("ipv4-unspecified", "0.0.0.0"),  # noqa: S104 - a host name under test, not a bind address
    ("ipv6-loopback", "[::1]"),
    ("ipv6-unspecified", "[::]"),
    ("ipv6-mapped", "[::ffff:127.0.0.1]"),
    ("ipv6-compatible", "[::127.0.0.1]"),
    ("full-width-localhost", "ｌｏｃａｌｈｏｓｔ"),
    ("full-width-ipv4", "１２７.０.０.１"),
]
OTHER_HOSTS = [
    ("public-name", "auth.kodera.io"),
    ("localhost-prefix", "localhost.kodera.io"),
    ("localhost-suffix", "notlocalhost"),
    ("ipv4-public", "128.0.0.1"),
    ("ipv4-private", "10.0.0.1"),
    ("ipv4-short-public", "128.1"),
    ("ipv6-other", "[::2]"),
]


def bare(host: str) -> str:
    return host.removeprefix("[").removesuffix("]")


@pytest.mark.parametrize("host", [pytest.param(host, id=name) for name, host in LOOPBACK_SPELLINGS])
def test_a_host_naming_the_machine_itself_is_loopback(host):
    assert is_loopback_host(bare(host)) is True


@pytest.mark.parametrize("host", [pytest.param(host, id=name) for name, host in OTHER_HOSTS])
def test_any_other_host_is_not_loopback(host):
    assert is_loopback_host(bare(host)) is False


@pytest.mark.parametrize("host", [pytest.param(host, id=name) for name, host in LOOPBACK_SPELLINGS])
def test_each_loopback_spelling_of_an_issuer_is_refused(host):
    issuer = f"https://{host}/realms/acme-sa"
    environment = {"KODERA_AUTH_TRUST": trust(("staff", DEPLOYED), ("customer", issuer))}
    assert len(auth_trust(environment, loopback_issuers=True)) == 2
    with pytest.raises(ImproperlyConfigured) as refused:
        auth_trust(environment)
    assert str(refused.value) == TRUST_REFUSED


@pytest.mark.parametrize(
    "issuer",
    [
        "http://auth.kodera.io/realms/acme-sa",
        "http://127.0.0.1:8080/realms/acme-sa",
        "not a url",
        "https://[::1/realms/acme-sa",
    ],
)
def test_a_plain_http_or_unparseable_issuer_is_refused(issuer):
    environment = {"KODERA_AUTH_TRUST": trust(("staff", DEPLOYED), ("customer", issuer))}
    with pytest.raises(ImproperlyConfigured) as refused:
        auth_trust(environment)
    assert str(refused.value) == TRUST_REFUSED


def test_https_issuers_of_other_hosts_are_admitted():
    environment = {
        "KODERA_AUTH_TRUST": trust(
            ("staff", DEPLOYED), ("customer", "https://auth.kodera.io/realms/acme-sa")
        )
    }
    assert [entry.lane for entry in auth_trust(environment)] == ["staff", "customer"]
    assert auth_trust({}) == () and auth_trust({"KODERA_AUTH_TRUST": ""}) == ()


# The start of a real profile, in a fresh interpreter.

PROGRAM = (
    "import django; django.setup(); from django.conf import settings; "
    "print('started', getattr(settings, 'KODERA_LOOPBACK_ISSUERS', None), "
    "len(getattr(settings, 'KODERA_AUTH_TRUST', ())), "
    "getattr(settings, 'KODERA_STAFF_ISSUER', None))"
)


# The worker's profile loads only in a process that entered the worker's boundary (worker/boot.py).
WORKER_SETTINGS = "config.settings.deploy_worker"
WORKER_BOOT = "import worker.boot; worker.boot.enter(); "


def start(settings_module, environment, *, path=()):
    program = WORKER_BOOT + PROGRAM if settings_module == WORKER_SETTINGS else PROGRAM
    return subprocess.run(  # noqa: S603 - a fixed interpreter and a fixed program
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.defpath,
            "PYTHONPATH": os.pathsep.join([str(ROOT), *map(str, path)]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": settings_module,
            "DATABASE_URL": "postgres://u:p@127.0.0.1:5432/kodera_server",
            **(
                {
                    "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                    "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
                }
                if settings_module in {"config.settings.deploy", "config.settings.deploy_operator"}
                else {}
            ),
            **environment,
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def refusal(result) -> str:
    assert result.returncode != 0 and "started" not in result.stdout, result.stdout
    return result.stderr.strip().splitlines()[-1]


def test_the_image_api_profile_refuses_the_fixture_trust():
    refused = start("config.settings.customer_http", {"KODERA_AUTH_TRUST": FIXTURE_TRUST})
    assert refusal(refused) == f"django.core.exceptions.ImproperlyConfigured: {TRUST_REFUSED}"


@pytest.mark.parametrize(
    "profile",
    ["config.settings.customer_http", "config.settings.job_queue", "config.settings.deploy"],
)
def test_a_deployable_profile_refuses_the_fixture_staff_issuer(profile):
    environment = {"KODERA_AUTH_TRUST": FIXTURE_TRUST, "KODERA_STAFF_ISSUER": FIXTURE_STAFF}
    if profile == "config.settings.deploy":
        # Deployment validates trust first; isolate the independent staff issuer guard.
        environment["KODERA_AUTH_TRUST"] = trust(("staff", DEPLOYED))
    assert refusal(start(profile, environment)) == (
        f"django.core.exceptions.ImproperlyConfigured: {STAFF_REFUSED}"
    )


@pytest.mark.parametrize("profile", ["config.settings.e2e", "config.settings.e2e_operator"])
def test_the_end_to_end_profiles_admit_the_fixture(profile):
    environment = {"KODERA_AUTH_TRUST": FIXTURE_TRUST, "KODERA_STAFF_ISSUER": FIXTURE_STAFF}
    started = start(profile, environment)
    assert started.returncode == 0, started.stderr[-2000:]
    assert started.stdout.split() == ["started", "True", "2", FIXTURE_STAFF]


@pytest.mark.parametrize("base", ["e2e", "e2e_operator"])
def test_a_profile_built_on_an_end_to_end_profile_refuses_to_load(tmp_path, base):
    (tmp_path / "built_on_e2e_fixture.py").write_text(f"from config.settings.{base} import *\n")
    refused = start("built_on_e2e_fixture", {}, path=[tmp_path])
    assert refusal(refused) == (
        "django.core.exceptions.ImproperlyConfigured: "
        f"config.settings.{base} loads only as the selected settings module"
    )


def settings_modules() -> list[str]:
    return sorted(
        "config.settings." + path.stem
        for path in (ROOT / "config/settings").glob("*.py")
        if path.stem != "__init__"
    )


def test_only_the_end_to_end_profiles_admit_loopback_issuers():
    # Every settings module, started on its own with no identity input: the permission is True in
    # exactly the isolated test and two end-to-end profiles, and absent or False elsewhere.
    admitting = set()
    for module in settings_modules():
        started = start(module, {})
        assert started.returncode == 0, f"{module}: {started.stderr[-2000:]}"
        if started.stdout.split()[1] == "True":
            admitting.add(module)
    assert (
        admitting
        == LOOPBACK_PROFILES
        == {
            "config.settings.test",
            "config.settings.e2e",
            "config.settings.e2e_operator",
        }
    )


def permission_assignments(root):
    # Only persistence derives permission from the selected profile; the deploy profiles deny it.
    assigned = {}
    for path in sorted((root / "config").rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            targets = (
                node.targets
                if isinstance(node, ast.Assign)
                else [node.target]
                if isinstance(node, (ast.AnnAssign, ast.AugAssign))
                else []
            )
            for target in targets:
                if isinstance(target, ast.Name) and target.id == "KODERA_LOOPBACK_ISSUERS":
                    assigned.setdefault(path.relative_to(root).as_posix(), []).append(
                        ast.unparse(node.value)
                    )
    return assigned


def assert_permission_assignments(root):
    assert permission_assignments(root) == {
        "config/settings/persistence.py": ["loopback_profile(os.environ)"],
        "config/settings/deploy.py": ["False"],
        "config/settings/deploy_operator.py": ["False"],
        "config/settings/deploy_worker.py": ["False"],
    }, "loopback permission assignment differs from the closed profile policy"


def test_the_permission_is_assigned_once_from_the_selected_profile():
    assert_permission_assignments(ROOT)


def test_deployment_loopback_permission_mutations_refuse(tmp_path):
    config = tmp_path / "config/settings"
    config.mkdir(parents=True)
    (config / "persistence.py").write_text((ROOT / "config/settings/persistence.py").read_text())
    (config / "deploy_operator.py").write_text(
        (ROOT / "config/settings/deploy_operator.py").read_text()
    )
    (config / "deploy_worker.py").write_text(
        (ROOT / "config/settings/deploy_worker.py").read_text()
    )
    path = config / "deploy.py"
    original = (ROOT / "config/settings/deploy.py").read_text()
    path.write_text(original)
    assert_permission_assignments(tmp_path)
    assert original.count("KODERA_LOOPBACK_ISSUERS = False") == 1
    path.write_text(
        original.replace("KODERA_LOOPBACK_ISSUERS = False", "KODERA_LOOPBACK_ISSUERS = True")
    )
    with pytest.raises(AssertionError, match="closed profile policy"):
        assert_permission_assignments(tmp_path)
    path.write_text(
        original + "\nKODERA_LOOPBACK_ISSUERS = True\nKODERA_LOOPBACK_ISSUERS = False\n"
    )
    with pytest.raises(AssertionError, match="closed profile policy"):
        assert_permission_assignments(tmp_path)
    path.write_text(original)
    (config / "extra.py").write_text("KODERA_LOOPBACK_ISSUERS = True\n")
    with pytest.raises(AssertionError, match="closed profile policy"):
        assert_permission_assignments(tmp_path)


@pytest.mark.parametrize(
    "selector",
    [
        "config.settings.customer_http",
        "config.settings.job_queue",
        "config.settings.deploy",
        "config.settings.deploy_operator",
        "config.settings.deploy_worker",
        "config.settings.workspace_metadata_test",
        "config.settings.test.py",
        "config.settings.test ",
        " config.settings.test",
        "config.settings.Test",
        "test",
        "",
    ],
)
def test_loopback_startup_permission_requires_the_exact_test_selector(selector):
    assert loopback_profile({"DJANGO_SETTINGS_MODULE": selector}) is False


@pytest.mark.parametrize(
    "profile",
    ["config.settings.customer_http", "config.settings.job_queue", "config.settings.deploy"],
)
def test_loopback_startup_deployable_profiles_still_refuse_pinned_trust(profile):
    assert_loopback_startup_deployed_refusal(loopback_startup(profile))


def assert_loopback_startup_deployed_refusal(result):
    assert result.returncode != 0, "LoopbackStartupDeployableProfileAdmitted"
    assert not result.stdout
    assert result.stderr.strip().splitlines()[-1] == (
        f"django.core.exceptions.ImproperlyConfigured: {TRUST_REFUSED}"
    )


def loopback_startup_policy(path):
    source = path.read_text()
    assignments = [
        node
        for node in ast.parse(source).body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "LOOPBACK_PROFILES"
            for target in node.targets
        )
    ]
    assert len(assignments) == 1
    value = assignments[0].value
    assert isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
    assert value.func.id == "frozenset" and len(value.args) == 1 and not value.keywords
    profiles = ast.literal_eval(value.args[0])
    assert isinstance(profiles, set)
    return source, value, profiles


def assert_loopback_startup_profile_inventory(profiles):
    assert profiles == {
        "config.settings.test",
        "config.settings.e2e",
        "config.settings.e2e_operator",
    }, "LoopbackStartupProfileInventory"


@pytest.mark.parametrize("mutation", ["remove-test", "add-customer-http"])
def test_loopback_startup_policy_mutations_are_observed_in_real_startup(tmp_path, mutation):
    root = tmp_path / "profile-mutation"
    shutil.copytree(
        ROOT / "config", root / "config", ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
    )
    path = root / "config/environment.py"
    original, value, profiles = loopback_startup_policy(path)
    assert_loopback_startup_profile_inventory(profiles)
    assert_loopback_startup(loopback_startup(root=root))
    assert_loopback_startup_deployed_refusal(
        loopback_startup("config.settings.customer_http", root=root)
    )
    if mutation == "remove-test":
        profiles.remove("config.settings.test")
    else:
        profiles.add("config.settings.customer_http")
    lines = original.splitlines(keepends=True)
    start = sum(map(len, lines[: value.lineno - 1])) + value.col_offset
    end = sum(map(len, lines[: value.end_lineno - 1])) + value.end_col_offset
    replacement = "frozenset({" + ", ".join(repr(profile) for profile in sorted(profiles)) + "})"
    try:
        path.write_text(original[:start] + replacement + original[end:])
        _, _, actual = loopback_startup_policy(path)
        with pytest.raises(AssertionError, match="LoopbackStartupProfileInventory"):
            assert_loopback_startup_profile_inventory(actual)
        if mutation == "remove-test":
            result = loopback_startup(root=root)
            assert result.returncode != 0 and not result.stdout
            assert result.stderr.strip().splitlines()[-1] == (
                f"django.core.exceptions.ImproperlyConfigured: {TRUST_REFUSED}"
            )
            with pytest.raises(AssertionError, match="LoopbackStartupTrustRefused"):
                assert_loopback_startup(result)
            assert_loopback_startup_deployed_refusal(
                loopback_startup("config.settings.customer_http", root=root)
            )
        else:
            result = loopback_startup("config.settings.customer_http", root=root)
            assert result.returncode == 0, result.stdout + result.stderr
            report = json.loads(result.stdout)
            assert report["profile"] == "config.settings.customer_http"
            assert report["loopback_issuers"] is True and len(report["trust"]) == 2
            with pytest.raises(AssertionError, match="LoopbackStartupDeployableProfileAdmitted"):
                assert_loopback_startup_deployed_refusal(result)
    finally:
        path.write_text(original)
    assert path.read_text() == original
    assert_loopback_startup(loopback_startup(root=root))
    assert_loopback_startup_deployed_refusal(
        loopback_startup("config.settings.customer_http", root=root)
    )


@pytest.mark.parametrize("mode", ["test", "live"])
def test_deploy_admits_stripe_restricted_key_with_signed_reconciliation_webhook(mode):
    result = start(
        "config.settings.deploy",
        {
            "KODERA_STRIPE_SECRET_KEY": "rk_" + mode + "_" + "synthetic0123456789",
            "KODERA_STRIPE_WEBHOOK_SECRET": "whsec_" + "synthetic",
        },
    )
    assert result.returncode == 0, result.stderr


def test_deploy_without_payments_still_starts():
    result = start("config.settings.deploy", {})
    assert result.returncode == 0, result.stderr

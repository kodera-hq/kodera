"""ADR-0003: the API process holds no infrastructure credential (SETTINGS_AND_SECRETS.md §2-§4).

A credential could reach the API by four channels, and each is closed here and proven closable:

- **environment**: every name of the one banned list, config/environment.py's
  INFRASTRUCTURE_PREFIXES and INFRASTRUCTURE_NAMES, stops the deployable API profile at start, and
  no other module restates the list;
- **setting**: a walk over every setting of the API's profiles finds no secret-shaped name but
  the closed allowlist below, each entry with the §2 row that admits it;
- **mount**: compose's `api` service mounts nothing and is given no secret or config file, and the API image
  declares no secret mount or volume;
- **import**: no module the API's entrypoints reach imports `worker.credentials`, an SSH, cloud or
  ACME client; and outside worker/ only the W5 one-shot realm delivery imports the credentials.

Each channel has a planted-credential mutation that must fail the channel's check by its message.
A known limit of the import channel: an import built at run time (`importlib.import_module`,
`__import__` with a computed name) is not an edge this graph sees, and is not refused.
No database and no network: profiles start in child interpreters with synthetic inputs.
"""

from __future__ import annotations

import ast
import copy
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml

from config import environment
from dev.image_context import image_tree

ROOT = Path(__file__).resolve().parents[2]
API_PROFILES = ("config.settings.deploy", "config.settings.customer_http")
DEPLOY_INPUTS = {
    "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
    "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
    "DATABASE_URL": "postgresql://synthetic:synthetic-pass@private-db.test/core",
    # Stripe is refused at deployment startup until reconciliation is routed.
    # The settings names still exist and are included in the walk below.
}
REFUSED = "django.core.exceptions.ImproperlyConfigured: Deployment configuration refused"


def start(
    profile: str, extra: Mapping[str, str], program: str, root: Path = ROOT
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - a fixed interpreter and owned programs
        [sys.executable, "-B", "-c", "import django; django.setup()\n" + program],
        cwd=root,
        env={
            "PATH": os.environ.get("PATH", os.defpath),
            "PYTHONPATH": str(root),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": profile,
            **(DEPLOY_INPUTS if profile == "config.settings.deploy" else {}),
            **extra,
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


# ---------------------------------------------------------------------- environment ----


# The acceptance cases, restated as literals from SETTINGS_AND_SECRETS.md §3 and the OpenTofu state
# backends, never read back from config/environment.py: a name the implementation forgot is a name
# these cases still try.
BANNED = (
    "SCW_SECRET_KEY",
    "SCW_ACCESS_KEY",
    "SCW_DEFAULT_ORGANIZATION_ID",
    "KEYCLOAK_ADMIN",
    "KEYCLOAK_ADMIN_PASSWORD",
    "KEYCLOAK_CLIENT_SECRET",
    "KC_BOOTSTRAP_ADMIN_PASSWORD",
    "SSH_PRIVATE_KEY",
    "SSH_CA_KEY",
    "ANSIBLE_PRIVATE_KEY_FILE",
    "SOPS_AGE_KEY",
    "SOPS_AGE_KEY_FILE",
    "AGE_IDENTITY",
    "TF_TOKEN_app_terraform_io",
    "TF_VAR_scw_secret_key",
    "TF_HTTP_USERNAME",
    "TF_HTTP_PASSWORD",
    "TF_CLI_CONFIG_FILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "ARM_CLIENT_SECRET",
    "ARM_ACCESS_KEY",
    "GOOGLE_CREDENTIALS",
    "GOOGLE_BACKEND_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CONSUL_HTTP_TOKEN",
    "CONSUL_HTTP_AUTH",
    "PG_CONN_STR",
)


def environment_refusals(root: Path, names: Iterable[str]) -> list[str]:
    """Each banned name the deployable API profile starts with, rather than refusing at start."""
    found = []
    for name in names:
        result = start(
            "config.settings.deploy",
            {name: "synthetic-private-sentinel"},
            "print('started')",
            root,
        )
        last = result.stderr.strip().splitlines()[-1:] or [""]
        if result.returncode == 0 or last[0] != REFUSED:
            found.append(f"the API starts with {name} in its environment")
        if "synthetic-private-sentinel" in result.stdout + result.stderr:
            found.append(f"the API's refusal of {name} discloses its value")
    return found


def test_the_banned_list_is_the_one_settings_and_secrets_names():
    # §3: Scaleway, Keycloak admin, SSH and Ansible keys, age and SOPS identities, OpenTofu tokens.
    for required in ("SCW_", "SSH_", "AGE_", "SOPS_", "TF_", "GOOGLE_", "CONSUL_HTTP_"):
        assert required in environment.INFRASTRUCTURE_PREFIXES
    for required in ("KEYCLOAK_ADMIN", "ANSIBLE_PRIVATE_KEY_FILE", "PG_CONN_STR"):
        assert required in environment.INFRASTRUCTURE_NAMES


def test_every_banned_name_stops_the_api_at_start():
    assert environment_refusals(ROOT, BANNED) == []


# Credentials under names no list could enumerate: a vault token, DNS-zone write tokens (§3), a
# forge token. A literal list again, independent of config/environment.py's shape rule.
UNLISTED_CREDENTIALS = (
    "ANSIBLE_VAULT_PASSWORD_FILE",
    "VAULT_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "GANDI_API_KEY",
    "GANDI_PAT",
    "OVH_APPLICATION_SECRET",
    "HCLOUD_TOKEN",
    "GITHUB_TOKEN",
    "DEPLOY_PRIVATE_KEY",
    "REGISTRY_PASSWORD",
)


# Names that select a credential file or helper rather than hold one. A literal list again.
CREDENTIAL_FILE_SELECTORS = (
    "KUBECONFIG",
    "PGPASSFILE",
    "PGSERVICEFILE",
    "PGSSLKEY",
    "PGSSLCERT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "NETRC",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GNUPGHOME",
    "CLOUDSDK_CONFIG",
)


def test_a_credential_file_selector_stops_the_api_at_start():
    assert environment_refusals(ROOT, CREDENTIAL_FILE_SELECTORS) == []


def test_a_credential_under_an_unlisted_name_stops_the_api_at_start():
    assert environment_refusals(ROOT, UNLISTED_CREDENTIALS) == []


def test_the_admitted_secret_names_still_start_the_api():
    started = start(
        "config.settings.deploy",
        {
            "KODERA_DISCOVERY_HMAC_KEY": "synthetic",
            # Admitted by name only; the base image sets a public fingerprint here.
            "GPG_KEY": "synthetic",
        },
        "print('started')",
    )
    assert started.returncode == 0 and started.stdout.strip() == "started", started.stderr[-2000:]


def test_the_environment_check_fails_without_the_name_shape_rule(tmp_path):
    image_tree(ROOT, tmp_path)
    module = tmp_path / "config" / "deploy_environment.py"
    text = module.read_text()
    rule = "    if unadmitted_secret_names(environment):\n        refuse()\n"
    assert text.count(rule) == 1, "the mutation no longer finds the rule it removes"
    module.write_text(text.replace(rule, ""))
    assert environment_refusals(tmp_path, ["VAULT_TOKEN"]) == [
        "the API starts with VAULT_TOKEN in its environment"
    ]


def test_the_environment_check_fails_when_an_entry_leaves_the_banned_list(tmp_path):
    image_tree(ROOT, tmp_path)
    module = tmp_path / "config" / "environment.py"
    text = module.read_text()
    assert text.count('    "TF_",\n') == 1, "the mutation no longer finds the entry it removes"
    module.write_text(text.replace('    "TF_",\n', ""))
    # A TF_ name the shape rule does not catch: OpenTofu's CLI configuration holds its tokens.
    assert environment_refusals(tmp_path, ["TF_CLI_CONFIG_FILE"]) == [
        "the API starts with TF_CLI_CONFIG_FILE in its environment"
    ]


def restated_lists(root: Path) -> list[str]:
    """Modules other than config/environment.py that spell a banned entry as a string literal."""
    entries = set(environment.INFRASTRUCTURE_PREFIXES) | set(environment.INFRASTRUCTURE_NAMES)
    found = []
    for top in ("config", "core", "apps", "services", "worker"):
        for path in sorted((root / top).rglob("*.py")):
            relative = path.relative_to(root).as_posix()
            if relative == "config/environment.py" or "/migrations/" in relative:
                continue
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.Constant) and node.value in entries:
                    found.append(f"{relative}:{node.lineno} restates the banned entry {node.value}")
    return found


def test_the_banned_list_is_one_constant():
    assert restated_lists(ROOT) == []
    import config.deploy_environment as deploy_environment

    assert deploy_environment.INFRASTRUCTURE_PREFIXES is environment.INFRASTRUCTURE_PREFIXES
    assert deploy_environment.INFRASTRUCTURE_NAMES is environment.INFRASTRUCTURE_NAMES


def test_the_one_constant_check_fails_on_a_restated_list(tmp_path):
    for top in ("config", "core", "apps", "services", "worker"):
        (tmp_path / top).mkdir()
    (tmp_path / "apps" / "guard.py").write_text('BANNED = ("SCW_", "KEYCLOAK_ADMIN")\n')
    assert restated_lists(tmp_path) == [
        "apps/guard.py:1 restates the banned entry SCW_",
        "apps/guard.py:1 restates the banned entry KEYCLOAK_ADMIN",
    ]


# -------------------------------------------------------------------------- setting ----

SECRET_SHAPED = re.compile(r"KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE|CERT")
# Every secret-shaped setting an API profile may hold, and the §2 row that admits it.
ALLOWED_SECRETS = {
    "SECRET_KEY": "the application signing key",
    "KODERA_CONTACT_SEAL_KEY": "an application secret: the key contacts are sealed with",
    "KODERA_MEMBERSHIP_CURSOR_KEY": "an application secret: the membership cursors' key",
    "KODERA_DISCOVERY_HMAC_KEY": "an application secret: realm discovery's HMAC key",
    # tests/test_billing_restricted_key.py proves the refusal of a full secret key.
    "KODERA_STRIPE_SECRET_KEY": (
        "the billing provider's restricted key, Checkout Sessions only: the `rk_` check in "
        "apps/billing/configuration.py refuses any other key"
    ),
    "KODERA_STRIPE_WEBHOOK_SECRET": "the billing provider's webhook signing secret",
}
# Inside a setting's value: a key or field shaped like a credential, and the one §2 admits there.
ALLOWED_NESTED = {"DATABASES['default']['PASSWORD']": "the API's own database, §2's first row"}
# The child walks every value the profile sets, through mappings, sequences, sets and dataclasses,
# and reports paths only, never a value: the keys shaped like a credential, and the strings shaped
# like one whatever the name above them says.
SETTINGS_DUMP = r"""
import dataclasses, datetime, decimal, json, pathlib, re
from collections.abc import Mapping
from django.conf import settings
from django.utils.functional import Promise

KEY = re.compile(r"(?i)secret|passw(or)?d|token|credential|private_key|client_secret|api_?key")
# Leaves that carry no string to read; anything else the walk does not know fails closed.
LEAVES = (type(None), bool, int, float, complex, decimal.Decimal, datetime.date,
          datetime.time, datetime.timedelta, pathlib.PurePath)
DEPTH = 12
SHAPES = {
    "a private key": re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    "a full Stripe secret key": re.compile(r"\bsk_(live|test)_[A-Za-z0-9]{8,}"),
    "a Scaleway access key": re.compile(r"\bSCW[A-Z0-9]{17}\b"),
}
keys, shaped, unreadable = [], [], []


def walk(path, value, depth=0):
    if depth > DEPTH:
        unreadable.append([path, "nested deeper than the walk reads"])
        return
    if isinstance(value, Promise):
        value = str(value)  # a lazy string is read as the string it becomes
    if isinstance(value, Mapping):
        for key, item in value.items():
            inner = f"{path}[{key!r}]"
            if isinstance(key, str) and KEY.search(key):
                keys.append(inner)
            walk(inner, item, depth + 1)
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            walk(f"{path}[{index}]", item, depth + 1)
    elif isinstance(value, (set, frozenset)):
        for item in value:
            walk(f"{path}[*]", item, depth + 1)
    elif dataclasses.is_dataclass(value) and not isinstance(value, type):
        for field in dataclasses.fields(value):
            inner = f"{path}.{field.name}"
            if KEY.search(field.name):
                keys.append(inner)
            walk(inner, getattr(value, field.name), depth + 1)
    elif isinstance(value, (str, bytes)):
        text = value if isinstance(value, str) else value.decode("latin-1")
        shaped.extend([path, label] for label, shape in SHAPES.items() if shape.search(text))
    elif not isinstance(value, LEAVES):
        unreadable.append([path, f"a {type(value).__name__} the walk cannot read"])


# The settings the profile itself sets, not Django's defaults.
names = sorted(n for n in dir(settings) if n.isupper() and settings.is_overridden(n))
for name in names:
    walk(name, getattr(settings, name))
databases = {alias: sorted(d) for alias, d in settings.DATABASES.items()}
print(json.dumps({"names": names, "keys": sorted(set(keys)), "shaped": shaped,
                  "unreadable": unreadable,
                  "databases": databases, "apps": list(settings.INSTALLED_APPS)}))
"""


def profile_settings(profile: str, root: Path = ROOT) -> dict[str, Any]:
    result = start(profile, {}, SETTINGS_DUMP, root)
    assert result.returncode == 0, f"{profile}: {result.stderr[-2000:]}"
    report: dict[str, Any] = json.loads(result.stdout.strip().splitlines()[-1])
    return report


def setting_refusals(profile: str, report: Mapping[str, Any]) -> list[str]:
    refusals = [
        f"{profile} holds {name}, a secret-shaped setting SETTINGS_AND_SECRETS §2 does not admit"
        for name in report["names"]
        if SECRET_SHAPED.search(name) and name not in ALLOWED_SECRETS
    ]
    refusals += [
        f"{profile} holds {path}, a credential-shaped key SETTINGS_AND_SECRETS §2 does not admit"
        for path in report["keys"]
        if path not in ALLOWED_NESTED
    ]
    refusals += [
        f"{profile} holds {path}, a value shaped like {label}" for path, label in report["shaped"]
    ]
    # Fail closed: what the walk cannot read, or cannot reach, it cannot clear.
    refusals += [
        f"{profile} holds {path}, {why}, so cannot clear" for path, why in report["unreadable"]
    ]
    return refusals


@pytest.mark.parametrize("profile", API_PROFILES)
def test_every_secret_shaped_api_setting_is_one_section_2_admits(profile):
    report = profile_settings(profile)
    assert {"SECRET_KEY", "KODERA_CONTACT_SEAL_KEY"} <= set(report["names"]), "the walk saw nothing"
    if profile == "config.settings.deploy":
        assert "KODERA_STRIPE_SECRET_KEY" in report["names"]
    assert setting_refusals(profile, report) == []
    assert "DATABASES['default']['PASSWORD']" in report["keys"], "the nested walk saw nothing"
    # The database's own password is §2's first row: its own database, and only that one.
    assert list(report["databases"]) == ["default"]


def test_the_restricted_key_entry_names_a_check_that_exists():
    source = (ROOT / "apps/billing/configuration.py").read_text(encoding="utf-8")
    assert source.count('RESTRICTED_KEY = re.compile(r"rk_(live|test)_[A-Za-z0-9]+")') == 1
    entry = ALLOWED_SECRETS["KODERA_STRIPE_SECRET_KEY"]
    assert "`rk_` check in apps/billing/configuration.py" in entry


def test_the_setting_walk_fails_on_a_planted_credential_setting(tmp_path):
    image_tree(ROOT, tmp_path)
    profile = tmp_path / "config" / "settings" / "deploy.py"
    profile.write_text(profile.read_text() + '\nKODERA_SCALEWAY_SECRET_KEY = "planted"\n')
    report = profile_settings("config.settings.deploy", tmp_path)
    assert setting_refusals("config.settings.deploy", report) == [
        "config.settings.deploy holds KODERA_SCALEWAY_SECRET_KEY, a secret-shaped setting "
        "SETTINGS_AND_SECRETS §2 does not admit"
    ]


# ---------------------------------------------------------------------------- mount ----


def mount_refusals(compose: Mapping[str, Any], dockerfile: str) -> list[str]:
    api = (compose.get("services") or {}).get("api") or {}
    refusals = []
    if api.get("volumes"):
        refusals.append("compose's api service mounts a volume")
    if api.get("secrets"):
        refusals.append("compose's api service is given a secret")
    if api.get("env_file"):
        refusals.append("compose's api service reads an environment file")
    # A config is a file mounted into the container (at /run/secrets/... as easily as anywhere).
    if api.get("configs"):
        refusals.append("compose's api service is given a config file")
    if re.search(r"--mount=type=secret|^VOLUME\b", dockerfile, re.MULTILINE):
        refusals.append("the API image declares a secret mount or a volume")
    return refusals


COMPOSE = yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")


def test_the_api_service_has_no_secret_mount():
    assert mount_refusals(COMPOSE, DOCKERFILE) == []


@pytest.mark.parametrize(
    ("plant", "message"),
    [
        (
            lambda c: c["services"]["api"].update(volumes=["./secrets:/run/secrets:ro"]),
            "compose's api service mounts a volume",
        ),
        (
            lambda c: c["services"]["api"].update(secrets=["scw_secret_key"]),
            "compose's api service is given a secret",
        ),
        (
            lambda c: c["services"]["api"].update(env_file=["infra.env"]),
            "compose's api service reads an environment file",
        ),
        (
            lambda c: (
                c.setdefault("configs", {}).update({"realm": {"file": "./realm-secret"}}),
                c["services"]["api"].update(
                    configs=[{"source": "realm", "target": "/run/secrets/customer-realm"}]
                ),
            ),
            "compose's api service is given a config file",
        ),
        (
            lambda c: c["services"]["api"].update(configs=["realm"]),
            "compose's api service is given a config file",
        ),
    ],
)
def test_the_mount_check_fails_on_a_planted_mount(plant, message):
    compose = copy.deepcopy(COMPOSE)
    plant(compose)
    assert mount_refusals(compose, DOCKERFILE) == [message]
    planted = DOCKERFILE.replace("USER 10001", "RUN --mount=type=secret,id=scw true\nUSER 10001")
    assert mount_refusals(COMPOSE, planted) == ["the API image declares a secret mount or a volume"]


# --------------------------------------------------------------------------- import ----

FIRST_PARTY = ("config", "core", "apps", "services", "worker", "tenant_agent", "room_access")
CREDENTIALS = "worker.credentials"
# Client libraries the API must never reach (SETTINGS_AND_SECRETS §3, item 4).
BANNED_CLIENTS = ("paramiko", "asyncssh", "fabric", "boto3", "botocore", "scaleway", "acme", "hvac")
# Outside worker/: lane decision W5 keeps the realm delivery an external one-shot command until the
# scheduler lands, and its admin client loads the realm credential through worker/credentials/.
CREDENTIAL_IMPORTERS = {
    "apps/outbox/realm/keycloak.py",
    "apps/orgs/management/commands/run_realm_deliveries.py",
}


def module_path(root: Path, name: str) -> Path | None:
    base = root.joinpath(*name.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


def imports_of(root: Path, name: str, path: Path) -> set[str]:
    """Every module `name` imports, at any depth of its body, with the packages above each."""
    package = name if path.name == "__init__.py" else name.rpartition(".")[0]
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                base = ".".join(parts[: len(parts) - node.level + 1])
                target = f"{base}.{node.module}" if node.module else base
            else:
                target = node.module or ""
            found.add(target)
            found.update(f"{target}.{alias.name}" for alias in node.names)
    expanded: set[str] = set()
    for module in found:
        parts = module.split(".")
        expanded.update(".".join(parts[:depth]) for depth in range(1, len(parts) + 1))
    return expanded


def reachable(root: Path, roots: Iterable[str]) -> dict[str, str]:
    """Each module reachable from `roots`, mapped to the module that first imported it."""
    seen: dict[str, str] = {name: "" for name in roots}
    queue = list(seen)
    while queue:
        name = queue.pop()
        if name.split(".")[0] not in FIRST_PARTY:
            continue
        path = module_path(root, name)
        if path is None:
            continue
        for imported in imports_of(root, name, path):
            if imported not in seen:
                seen[imported] = name
                queue.append(imported)
    return seen


def app_roots(entries: Iterable[str], root: Path = ROOT) -> list[str]:
    """The modules Django loads for each INSTALLED_APPS entry, written as a module or as an
    AppConfig path; a first-party entry that resolves to no module fails, rather than dropping."""
    roots: set[str] = set()
    for entry in entries:
        if entry.split(".")[0] not in FIRST_PARTY:
            continue
        parent, _, last = entry.rpartition(".")
        if module_path(root, entry):
            package = entry
        elif last[:1].isupper() and module_path(root, parent):
            package = parent.removesuffix(".apps")  # an AppConfig path: <app>.apps.<Config>
        else:
            raise AssertionError(f"INSTALLED_APPS entry {entry} yields no import root")
        candidates = {package, f"{package}.apps", f"{package}.models"}
        roots |= {name for name in candidates if module_path(root, name)}
    return sorted(roots)


def api_roots(root: Path = ROOT) -> list[str]:
    """The API image's entrypoints — the WSGI server, and the tenant agent and room-access
    processes it also ships — its profiles, and every module Django loads for its applications."""
    roots = {"config.deploy_wsgi", "config.wsgi", "config.customer_urls", "config.urls"}
    roots |= {"config.gunicorn", "tenant_agent.__main__", "room_access.__main__", *API_PROFILES}
    for profile in API_PROFILES:
        roots |= set(app_roots(profile_settings(profile)["apps"], root))
    return sorted(r for r in roots if module_path(root, r))


def import_refusals(root: Path, roots: Iterable[str]) -> list[str]:
    graph = reachable(root, roots)
    refusals = []
    for module, importer in sorted(graph.items()):
        top = module.split(".")[0]
        if importer.startswith(CREDENTIALS) or importer.split(".")[0] in BANNED_CLIENTS:
            continue  # what a refused module imports in turn is not a second edge
        if module == CREDENTIALS or module.startswith(CREDENTIALS + "."):
            refusals.append(f"the API reaches {module} through {importer}")
        elif top in BANNED_CLIENTS:
            refusals.append(f"the API reaches the client library {top} through {importer}")
    return refusals


API_ROOTS = api_roots()


def test_no_api_module_reaches_the_credentials_or_an_infrastructure_client():
    assert "config.customer_urls" in API_ROOTS and "apps.billing.models" in API_ROOTS
    assert import_refusals(ROOT, API_ROOTS) == []


def test_every_first_party_application_yields_a_root():
    # Written as a module or as an AppConfig path, a first-party entry is never silently dropped.
    assert app_roots(["apps.billing", "apps.legal.apps.LegalConfig"]) == [
        "apps.billing",
        "apps.billing.apps",
        "apps.billing.models",
        "apps.legal",
        "apps.legal.apps",
        "apps.legal.models",
    ]
    with pytest.raises(AssertionError, match="apps.nowhere yields no import root"):
        app_roots(["apps.nowhere"])
    for profile in API_PROFILES:
        app_roots(profile_settings(profile)["apps"])


def test_the_image_s_other_processes_are_roots():
    # The tenant agent and the room-access service ship in the API image (Dockerfile).
    assert {"tenant_agent.__main__", "room_access.__main__"} <= set(API_ROOTS)


def test_the_import_check_fails_on_a_planted_credential_import(tmp_path):
    for top in FIRST_PARTY:
        shutil.copytree(ROOT / top, tmp_path / top, ignore=shutil.ignore_patterns("__pycache__"))
    views = tmp_path / "apps" / "identity" / "api" / "views.py"
    views.write_text(views.read_text() + "\n\ndef planted():\n    import worker.credentials\n")
    billing = tmp_path / "apps" / "billing" / "services.py"
    billing.write_text(billing.read_text() + "\nimport paramiko\n")
    assert import_refusals(tmp_path, API_ROOTS) == [
        "the API reaches the client library paramiko through apps.billing.services",
        "the API reaches worker.credentials through apps.identity.api.views",
    ]


def credential_importers(root: Path) -> list[str]:
    found = []
    for top in FIRST_PARTY:
        for path in sorted((root / top).rglob("*.py")):
            relative = path.relative_to(root).as_posix()
            if relative.startswith("worker/"):
                continue
            name = ".".join(path.relative_to(root).with_suffix("").parts)
            if any(m.startswith(CREDENTIALS) for m in imports_of(root, name, path)):
                found.append(relative)
    return found


def test_only_the_worker_and_the_w5_one_shot_import_the_credentials():
    assert set(credential_importers(ROOT)) == CREDENTIAL_IMPORTERS


def test_the_importer_check_fails_on_a_planted_importer(tmp_path):
    for top in FIRST_PARTY:
        shutil.copytree(ROOT / top, tmp_path / top, ignore=shutil.ignore_patterns("__pycache__"))
    (tmp_path / "apps" / "orgs" / "planted.py").write_text(
        "from worker.credentials import DirectoryCredentialSource\n"
    )
    assert set(credential_importers(tmp_path)) - CREDENTIAL_IMPORTERS == {"apps/orgs/planted.py"}


# ----------------------------------------------------------- setting, nested and by value ----


@pytest.mark.parametrize(
    ("planted", "message"),
    [
        (
            'KODERA_REALM = {"client_secret": "planted"}',
            "config.settings.deploy holds KODERA_REALM['client_secret'], a credential-shaped "
            "key SETTINGS_AND_SECRETS §2 does not admit",
        ),
        (
            'KODERA_PROVIDERS = [{"name": "dns", "options": {"api_token": "planted"}}]',
            "config.settings.deploy holds KODERA_PROVIDERS[0]['options']['api_token'], a "
            "credential-shaped key SETTINGS_AND_SECRETS §2 does not admit",
        ),
        (
            'KODERA_BRANDING = {"logo": "-----BEGIN RSA " + "PRIVATE KEY-----\\nplanted"}',
            "config.settings.deploy holds KODERA_BRANDING['logo'], a value shaped like a "
            "private key",
        ),
        (
            'KODERA_LABEL = "sk_" + "live_" + "Planted0123456789abcdef"',
            "config.settings.deploy holds KODERA_LABEL, a value shaped like a full Stripe "
            "secret key",
        ),
        (
            'KODERA_DNS = {"api_key": "planted"}',
            "config.settings.deploy holds KODERA_DNS['api_key'], a credential-shaped key "
            "SETTINGS_AND_SECRETS §2 does not admit",
        ),
        (
            "from types import MappingProxyType as _Proxy\n"
            'KODERA_REALM = _Proxy({"client_secret": "planted"})',
            "config.settings.deploy holds KODERA_REALM['client_secret'], a credential-shaped "
            "key SETTINGS_AND_SECRETS §2 does not admit",
        ),
        (
            "from django.utils.functional import lazy as _lazy\n"
            'KODERA_BANNER = _lazy(lambda: "-----BEGIN EC " + "PRIVATE KEY-----", str)()',
            "config.settings.deploy holds KODERA_BANNER, a value shaped like a private key",
        ),
        (
            "class _Opaque:\n    pass\n\n\nKODERA_OPAQUE = {'inner': _Opaque()}",
            "config.settings.deploy holds KODERA_OPAQUE['inner'], a _Opaque the walk cannot "
            "read, so cannot clear",
        ),
        (
            "KODERA_DEEP = [[[[[[[[[[[[[[[[['planted']]]]]]]]]]]]]]]]]",
            "config.settings.deploy holds KODERA_DEEP"
            + "[0]" * 13
            + ", nested deeper than the walk reads, so cannot clear",
        ),
        (
            'KODERA_NOTES = ("SCW" + "ABCDEFGHJKMNPQRST",)',
            "config.settings.deploy holds KODERA_NOTES[0], a value shaped like a Scaleway "
            "access key",
        ),
    ],
)
def test_the_setting_walk_fails_on_a_planted_nested_or_valued_credential(
    tmp_path, planted, message
):
    image_tree(ROOT, tmp_path)
    profile = tmp_path / "config" / "settings" / "deploy.py"
    profile.write_text(profile.read_text() + "\n" + planted + "\n")
    report = profile_settings("config.settings.deploy", tmp_path)
    assert setting_refusals("config.settings.deploy", report) == [message]


def test_the_name_shape_rule_reads_key_as_a_word_not_a_substring():
    from config.environment import unadmitted_secret_names

    # KEYCLOAK_* origins and the like carry no credential; refusing them would only train an
    # operator to strip the rule.
    assert (
        unadmitted_secret_names({"KEYCLOAK_ORIGIN": "", "E2E_KEYCLOAK_PORT": "", "MONKEY": ""})
        == []
    )
    assert unadmitted_secret_names(
        {"GANDI_API_KEY": "", "CLOUDFLARE_APIKEY": "", "SIGNING_KEYS": "", "OVH_KEY_ID": ""}
    ) == ["CLOUDFLARE_APIKEY", "GANDI_API_KEY", "OVH_KEY_ID", "SIGNING_KEYS"]

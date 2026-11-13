#!/usr/bin/env python3
"""Validate deploy/community self-host stack invariants and ADR-0003 secret isolation.

Both topologies are checked: `single` (docker-compose.yml, Caddyfile) and `split`
(docker-compose.yml with docker-compose.split.yml, Caddyfile.split).

With --preflight ENV_FILE it also checks an operator's own .env before `docker compose up`:
every key of .env.example is set, no CHANGE_ME_ placeholder is left, and KODERA_AUTH_TRUST
names at least one https issuer. It reports key names only, never a value.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import copy
import json
import os
import re
import stat
import sys
import tempfile
import types
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COMPOSE = ROOT / "deploy" / "community" / "docker-compose.yml"
DEFAULT_ENV_EXAMPLE = ROOT / "deploy" / "community" / ".env.example"
DEFAULT_CADDYFILE = ROOT / "deploy" / "community" / "Caddyfile"
DEFAULT_SPLIT_COMPOSE = ROOT / "deploy" / "community" / "docker-compose.split.yml"
DEFAULT_SPLIT_CADDYFILE = ROOT / "deploy" / "community" / "Caddyfile.split"

COMPOSE_VAR_RE = re.compile(r"\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}")
ENV_LINE_RE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")

SECRET_SHAPED_NAME_RE = re.compile(
    r"(?:^|_)(?:API)?KEYS?(?:_|$)|APIKEY|SECRET|PASSW(?:OR)?D|TOKEN|CREDENTIAL|PRIVATE"
    r"|(?:^|_)PAT(?:_|$)"
)

ADMITTED_SERVER_SECRET_NAMES = frozenset(
    {
        "DJANGO_SECRET_KEY",
        "KODERA_CONTACT_SEAL_KEY",
        "KODERA_OUTBOX_SEAL_KEY",
        "KODERA_MEMBERSHIP_CURSOR_KEY",
        "KODERA_DISCOVERY_HMAC_KEY",
        "KODERA_COLLAB_TICKET_KEY",
    }
)

ISOLATED_ROOM_ACCESS_SECRETS = (
    "LIVEKIT_API_SECRET",
    "LIVEKIT_API_KEY",
    "ROOM_ACCESS_MATRIX_TOKEN",
)

EXPECTED_PUBLIC_ENV_DEFAULTS = {
    "KODERA_DOMAIN": "chat.example.org",
    "KODERA_ACME_EMAIL": "ops@example.org",
    "KODERA_OIDC_PROVIDER_ORIGIN": "https://id.example.org",
    "POSTGRES_USER": "kodera",
    "POSTGRES_DB": "kodera_server",
}

REQUIRED_SECRET_ENV_KEYS = (
    "POSTGRES_PASSWORD",
    "KODERA_COLLAB_DATABASE_PASSWORD",
    "SYNAPSE_POSTGRES_PASSWORD",
    "DJANGO_SECRET_KEY",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_DISCOVERY_HMAC_KEY",
    "KODERA_COLLAB_TICKET_KEY",
    "ROOM_ACCESS_MATRIX_TOKEN",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
)

HEALTHCHECK_REQUIRED_SERVICES = ("db", "valkey", "server", "synapse", "synapse-db", "yjs-collab")

# Public configuration that has no usable default: the operator's own identity provider.
REQUIRED_PLACEHOLDER_KEYS = (
    "KODERA_AUTH_TRUST", "KODERA_DEFAULT_COMMUNITY_ISSUER", "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID",
)
COMMUNITY_KEYS = (
    "KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "KODERA_DEFAULT_COMMUNITY_ISSUER",
    "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID",
)
# Environment variable names only; credential values are never kept in these constants.
AGENT_ENV_NAMES = ("KODERA_AGENT_TOKEN", "KODERA_SYNAPSE_TOKEN")
SYNAPSE_OIDC_ENV_NAME = "KODERA_SYNAPSE_OIDC_CLIENT_SECRET"
SYNAPSE_OIDC_ISSUER_ENV_NAME = "KODERA_SYNAPSE_OIDC_ISSUER"
SYNAPSE_DB_ENV_NAME = "SYNAPSE_POSTGRES_PASSWORD"
FEDERATION_ENV_NAME = "KODERA_MATRIX_FEDERATION_ALLOWLIST"
# `single` (the default) serves the web client and every backend on KODERA_DOMAIN. `split` serves
# the web client from its own static origin, https://<KODERA_DOMAIN>, and the backends on
# api.<KODERA_MATRIX_DOMAIN>, matrix.<KODERA_DOMAIN> and livekit.<KODERA_DOMAIN> (README.md,
# "Topologies"). The Compose override `docker-compose.split.yml` selects the second.
TOPOLOGY_ENV_NAME = "KODERA_TOPOLOGY"
COMPOSE_TOPOLOGY_ENV_NAME = "KODERA_COMPOSE_TOPOLOGY"
TOPOLOGIES = ("single", "split")
# The media ports LiveKit publishes, and the firewall must open: the reviewed livekit.yaml values.
LIVEKIT_PUBLISHED_PORTS = ('- "7881:7881"', '- "50000-50200:50000-50200/udp"')

# What Caddy may route from the internet, per upstream. Anything else is refused: the agent API
# (`/agent/*`) and Matrix federation, key and admin routes are not internet-facing by default.
ALLOWED_PUBLIC_ROUTES: dict[str, frozenset[str]] = {
    "server:8000": frozenset({"/api/*", "/health/*"}),
    "yjs-collab:8098": frozenset({"/documents/collab"}),
    "room-access:8095": frozenset({"/_kodera/rooms/token"}),
    "synapse:8008": frozenset({"/_matrix/client/*", "/_matrix/media/*", "/_synapse/client/*"}),
    "livekit:7880": frozenset({"/rtc", "/rtc/*"}),
}
CATCH_ALL_UPSTREAM = "web:8080"
COMPOSE_DEFAULT_RE = re.compile(r"(?=\$\{([A-Z][A-Z0-9_]*):-([^}$]*))")
PUBLIC_SERVER_NAME_RE = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}")
SECRET_LOOKING_VALUE_RES = (
    re.compile(r"[0-9a-fA-F]{32,}"),
    re.compile(r"(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\..*"),
    re.compile(r".*-----BEGIN [A-Z ]*PRIVATE KEY-----.*", re.DOTALL),
)


def looks_like_secret(value: str) -> bool:
    """A committed default shaped like key material: long hex, a mixed 40+ character token,
    a JWT or a private key block. Placeholders, hostnames and short labels are not."""
    value = value.strip().strip("'\"")
    return any(pattern.fullmatch(value) for pattern in SECRET_LOOKING_VALUE_RES)

# A pulled image is pinned by tag and digest, so `docker compose pull` cannot drift.
PINNED_IMAGE_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$")
MEM_LIMIT_RE = re.compile(r"^[1-9][0-9]*[kmg]$")


@dataclass
class ServiceSpec:
    name: str
    raw_lines: list[str] = field(default_factory=list)
    restart: str | None = None
    image: str | None = None
    mem_limit: str | None = None
    dockerfile: str | None = None
    environment: dict[str, str] = field(default_factory=dict)
    depends_on_conditions: dict[str, str] = field(default_factory=dict)
    has_healthcheck: bool = False
    healthcheck_test: str | None = None


def parse_compose_services(compose_text: str) -> dict[str, ServiceSpec]:
    services: dict[str, ServiceSpec] = {}
    in_services = False
    current_service: ServiceSpec | None = None
    current_section: str | None = None
    current_dep: str | None = None

    for raw_line in compose_text.splitlines():
        code = raw_line.split("#", 1)[0].rstrip()
        if not code.strip():
            continue

        indent = len(code) - len(code.lstrip(" "))
        stripped = code.strip()

        if indent == 0:
            in_services = stripped == "services:"
            current_service = None
            current_section = None
            current_dep = None
            continue

        if not in_services:
            continue

        if indent == 2 and stripped.endswith(":"):
            svc_name = stripped[:-1].strip()
            current_service = ServiceSpec(name=svc_name)
            services[svc_name] = current_service
            current_section = None
            current_dep = None
            continue

        if current_service is None:
            continue

        current_service.raw_lines.append(code)

        if indent == 4:
            current_dep = None
            if ":" in stripped:
                key, val = stripped.split(":", 1)
                key = key.strip()
                val = val.strip()
                if not val:
                    current_section = key
                    if key == "healthcheck":
                        current_service.has_healthcheck = True
                else:
                    current_section = None
                    if key == "restart":
                        current_service.restart = val
                    elif key == "image":
                        current_service.image = val
                    elif key == "mem_limit":
                        current_service.mem_limit = val
            continue

        if indent == 6 and current_section:
            if current_section == "environment" and ":" in stripped:
                k, v = stripped.split(":", 1)
                current_service.environment[k.strip()] = v.strip()
            elif current_section == "build" and ":" in stripped:
                k, v = stripped.split(":", 1)
                if k.strip() == "dockerfile":
                    current_service.dockerfile = v.strip()
            elif current_section == "depends_on" and stripped.endswith(":"):
                current_dep = stripped[:-1].strip()
            elif current_section == "healthcheck" and ":" in stripped:
                k, v = stripped.split(":", 1)
                if k.strip() == "test" and v.strip():
                    current_service.healthcheck_test = v.strip()
            continue

        if indent == 8 and current_section == "depends_on" and current_dep:
            if ":" in stripped:
                k, v = stripped.split(":", 1)
                if k.strip() == "condition":
                    current_service.depends_on_conditions[current_dep] = v.strip()

    return services


def section_entries(service: ServiceSpec, section: str) -> list[str]:
    """The list entries of one block section of a service, as written (`- "7881:7881"`)."""
    entries: list[str] = []
    inside = False
    for line in service.raw_lines:
        indent = len(line) - len(line.lstrip(" "))
        if indent == 4:
            inside = line.strip() == section + ":"
        elif inside and indent == 6 and line.strip().startswith("- "):
            entries.append(line.strip())
    return entries


def parse_env_example(env_text: str) -> tuple[dict[str, str], list[str]]:
    env_map: dict[str, str] = {}
    errors: list[str] = []
    for idx, raw_line in enumerate(env_text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = ENV_LINE_RE.match(line)
        if not match:
            errors.append(f".env.example line {idx}: malformed assignment '{line}'")
            continue
        key, value = match.group(1), match.group(2).strip()
        if key in env_map:
            errors.append(f".env.example line {idx}: duplicate variable '{key}'")
        env_map[key] = value
    return env_map, errors


def check_community_deploy(
    compose_text: str,
    env_text: str,
    caddyfile_text: str,
) -> list[str]:
    errors: list[str] = []

    env_map, env_parse_errors = parse_env_example(env_text)
    errors.extend(env_parse_errors)

    # 1. Every variable referenced in docker-compose.yml is documented in .env.example,
    #    public defaults match SelfHostDeploymentPlan, and secrets use CHANGE_ME_ placeholders.
    referenced_vars = sorted(set(COMPOSE_VAR_RE.findall(compose_text)))
    if not referenced_vars:
        errors.append("no environment variables found in docker-compose.yml")

    for var in referenced_vars:
        if var not in env_map:
            errors.append(f"missing variable in .env.example: {var}")

    for pub_key, expected_val in EXPECTED_PUBLIC_ENV_DEFAULTS.items():
        actual_val = env_map.get(pub_key)
        if actual_val != expected_val:
            errors.append(
                f"public config key {pub_key} in .env.example must be '{expected_val}' (got '{actual_val}')"
            )
    if env_map.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG") != "community":
        errors.append(".env.example must opt into the canonical community workspace")

    for sec_key in REQUIRED_SECRET_ENV_KEYS:
        if sec_key not in env_map:
            errors.append(f"missing required secret key in .env.example: {sec_key}")

    for key in REQUIRED_PLACEHOLDER_KEYS:
        value = env_map.get(key, "")
        if not value.startswith("CHANGE_ME_") or len(value) <= len("CHANGE_ME_"):
            errors.append(
                f"{key} in .env.example must be a CHANGE_ME_ placeholder: it has no usable default"
            )

    for key, value in env_map.items():
        is_secret_key = key in REQUIRED_SECRET_ENV_KEYS or bool(
            SECRET_SHAPED_NAME_RE.search(key.upper())
        )
        if is_secret_key:
            if not value.startswith("CHANGE_ME_") or len(value) <= len("CHANGE_ME_"):
                errors.append(
                    f"non-placeholder secret value in .env.example for {key} (must start with CHANGE_ME_)"
                )

    # 1b. No committed default is shaped like key material, whatever its variable is called.
    for key, value in env_map.items():
        if not value.startswith("CHANGE_ME_") and looks_like_secret(value):
            errors.append(f"secret-looking default in .env.example for {key}")
    for name, default in COMPOSE_DEFAULT_RE.findall(compose_text):
        if default and (SECRET_SHAPED_NAME_RE.search(name) or looks_like_secret(default)):
            errors.append(f"secret default in docker-compose.yml for {name}: use ${{{name}:?...}} or an empty default")

    # 1c. Federation is closed unless the operator opens it: the template ships no allowlist.
    if env_map.get(FEDERATION_ENV_NAME, "missing") != "":
        errors.append(
            f"federation must be closed by default: {FEDERATION_ENV_NAME} must be empty in .env.example"
        )
    if env_map.get(SYNAPSE_OIDC_ISSUER_ENV_NAME, "missing") != "":
        errors.append(f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} must be empty in .env.example: it has no usable default")

    services = parse_compose_services(compose_text)
    for svc in services.values():
        for env_key, env_value in svc.environment.items():
            if SECRET_SHAPED_NAME_RE.search(env_key.upper()) and "${" not in env_value:
                errors.append(
                    f"literal secret in docker-compose.yml: service '{svc.name}' sets {env_key} without a variable"
                )
    for required_service in (
        "caddy",
        "db",
        "valkey",
        "migrate",
        "server",
        "yjs-collab",
        "web",
        "room-access",
        "synapse",
        "synapse-db",
        "livekit",
    ):
        if required_service not in services:
            errors.append(f"missing required service '{required_service}' in docker-compose.yml")

    # 2. ADR-0003 secret isolation on server and migrate
    for core_svc_name in ("server", "migrate"):
        svc = services.get(core_svc_name)
        if svc is None:
            continue
        raw_block = "\n".join(svc.raw_lines)
        for forbidden in (*ISOLATED_ROOM_ACCESS_SECRETS, *AGENT_ENV_NAMES, SYNAPSE_OIDC_ENV_NAME, SYNAPSE_DB_ENV_NAME):
            if forbidden in svc.environment or forbidden in raw_block:
                errors.append(
                    f"ADR-0003 isolation violation: forbidden secret '{forbidden}' in service '{core_svc_name}'"
                )
        for env_key in svc.environment:
            if (
                SECRET_SHAPED_NAME_RE.search(env_key.upper())
                and env_key not in ADMITTED_SERVER_SECRET_NAMES
            ):
                errors.append(
                    f"ADR-0003 unadmitted secret key '{env_key}' in service '{core_svc_name}'"
                )

    room_access = services.get("room-access")
    if room_access is not None:
        for isolated_key in ISOLATED_ROOM_ACCESS_SECRETS:
            if isolated_key not in room_access.environment:
                errors.append(
                    f"service 'room-access' must consume isolated secret '{isolated_key}'"
                )

    agent = services.get("tenant-agent")
    if agent is None:
        errors.append("missing required service 'tenant-agent'")
    else:
        block = "\n".join(agent.raw_lines)
        for guard in ('profiles: [community-governance]', 'command: ["python", "-m", "tenant_agent", "run"]', '- agent_state:/state'):
            if guard not in block:
                errors.append("tenant-agent missing runtime guard: " + guard)
        if agent.environment.get("KODERA_APPS") != "matrix":
            errors.append("tenant-agent must use Matrix-only reconciliation")
        for key in AGENT_ENV_NAMES:
            if agent.environment.get(key) != "${" + key + ":-}":
                errors.append("tenant-agent must consume isolated " + key)
        if "docker.sock" in block:
            errors.append("tenant-agent Matrix profile must not mount the Docker socket")
        for dependency, condition in (("server", "service_healthy"), ("synapse", "service_healthy"), ("agent-state-init", "service_completed_successfully")):
            if agent.depends_on_conditions.get(dependency) != condition:
                errors.append("tenant-agent must wait for " + dependency)

    # 3. Migration isolation: migrate uses Dockerfile.migrator with restart: "no"
    #    and server depends_on migrate with condition: service_completed_successfully
    migrate_svc = services.get("migrate")
    if migrate_svc is not None:
        block = "\n".join(migrate_svc.raw_lines)
        if "python manage.py bootstrap_community_workspace --settings config.settings.deploy" not in block:
            errors.append("service 'migrate' must bootstrap the canonical Community workspace")
        if 'if [ -n "$$KODERA_DEFAULT_COMMUNITY_ORG_SLUG" ]; then' not in block:
            errors.append("service 'migrate' must guard Community bootstrap with the configured slug")
        for key in COMMUNITY_KEYS:
            if migrate_svc.environment.get(key) != "${" + key + ":-}":
                errors.append(f"service 'migrate' must consume {key}")
        if "${KODERA_AUTH_TRUST:?" not in migrate_svc.environment.get("KODERA_AUTH_TRUST", ""):
            errors.append("service 'migrate' must require public trust for Community bootstrap")
        if migrate_svc.dockerfile != "Dockerfile.migrator":
            errors.append(
                f"service 'migrate' must build from 'Dockerfile.migrator' (got '{migrate_svc.dockerfile}')"
            )
        if migrate_svc.restart != '"no"':
            errors.append(
                f"service 'migrate' must set restart: \"no\" (got '{migrate_svc.restart}')"
            )

    server_svc = services.get("server")
    if server_svc is not None:
        for key in COMMUNITY_KEYS[:2]:
            if server_svc.environment.get(key) != "${" + key + ":-}":
                errors.append(f"service 'server' must consume {key}")
        migrate_cond = server_svc.depends_on_conditions.get("migrate")
        if migrate_cond != "service_completed_successfully":
            errors.append(
                "service 'server' must depend on 'migrate' with condition 'service_completed_successfully'"
            )

        # 4. Community mode invariants on server
        if server_svc.environment.get("KODERA_EDITION") != "community":
            errors.append("service 'server' must set KODERA_EDITION to 'community'")
        if server_svc.environment.get("KODERA_BILLING_ENABLED") != '"false"':
            errors.append('service \'server\' must set KODERA_BILLING_ENABLED to \'"false"\'')

    native = services.get("yjs-collab")
    if native is not None:
        expected = {
            "DATABASE_URL": "postgresql://kodera_collab:${KODERA_COLLAB_DATABASE_PASSWORD:?Set the isolated collaboration database password}@db:5432/${POSTGRES_DB:-kodera_server}",
            "KODERA_COLLAB_TICKET_KEY": "${KODERA_COLLAB_TICKET_KEY:?Set the application collaboration key}",
            "KODERA_COLLAB_ALLOWED_ORIGINS": "https://${KODERA_DOMAIN:-chat.example.org}",
        }
        if native.environment != expected:
            errors.append("yjs-collab must hold only its reviewed database and application settings")
        if native.dockerfile != "Dockerfile" or "context: ../../apps/server/yjs_collab" not in "\n".join(native.raw_lines):
            errors.append("yjs-collab must build its reviewed isolated native runtime")
        if native.depends_on_conditions.get("migrate") != "service_completed_successfully":
            errors.append("yjs-collab must wait for completed migrations")
        if section_entries(native, "volumes"):
            errors.append("yjs-collab must not mount files or credential directories")
    migrator = services.get("migrate")
    if migrator is not None:
        if migrator.environment.get("KODERA_COLLAB_DATABASE_URL") != "postgresql://kodera_collab:${KODERA_COLLAB_DATABASE_PASSWORD:?Set the isolated collaboration database password}@db:5432/${POSTGRES_DB:-kodera_server}" or "python manage.py configure_collab_role --settings config.settings.deploy &&" not in "\n".join(migrator.raw_lines):
            errors.append("migrate must provision the isolated collaboration login")
    if server_svc is not None:
        expected = {
            "KODERA_COLLAB_TICKET_KEY": "${KODERA_COLLAB_TICKET_KEY:?Set the application collaboration key}",
            "KODERA_COLLAB_ENGINE_URL": "http://yjs-collab:8098/internal/transform",
            "KODERA_COLLAB_PUBLIC_URL": "wss://${KODERA_DOMAIN:-chat.example.org}/documents/collab",
        }
        for name, value in expected.items():
            if server_svc.environment.get(name) != value:
                errors.append("server must set reviewed collaboration setting " + name)
        if server_svc.depends_on_conditions.get("yjs-collab") != "service_healthy":
            errors.append("server must wait for healthy yjs-collab")

    if migrate_svc is not None:
        if migrate_svc.environment.get("KODERA_BILLING_ENABLED") != '"false"':
            errors.append('service \'migrate\' must set KODERA_BILLING_ENABLED to \'"false"\'')

    # 4b. Every pulled image is pinned by digest; every service has a memory limit.
    for svc in services.values():
        if svc.dockerfile is None and svc.image is None:
            errors.append(f"service '{svc.name}' has neither an image nor a build")
        if svc.image is not None and not PINNED_IMAGE_RE.match(svc.image):
            errors.append(
                f"service '{svc.name}' image must be pinned as name:tag@sha256:<digest> (got '{svc.image}')"
            )
        if svc.mem_limit is None or not MEM_LIMIT_RE.match(svc.mem_limit):
            errors.append(f"service '{svc.name}' must set mem_limit (got '{svc.mem_limit}')")

    # 4c. Sign-in: the stack runs no identity provider. The server trusts the issuers of
    #     KODERA_AUTH_TRUST and the web client signs in at KODERA_OIDC_PROVIDER_ORIGIN.
    if server_svc is not None and "${KODERA_AUTH_TRUST:?" not in server_svc.environment.get(
        "KODERA_AUTH_TRUST", ""
    ):
        errors.append("service 'server' must require KODERA_AUTH_TRUST (${KODERA_AUTH_TRUST:?...})")
    web_svc = services.get("web")
    if web_svc is not None:
        web_block = "\n".join(web_svc.raw_lines)
        if "VITE_KEYCLOAK_URL: ${KODERA_OIDC_PROVIDER_ORIGIN:?" not in web_block:
            errors.append("service 'web' must build VITE_KEYCLOAK_URL from KODERA_OIDC_PROVIDER_ORIGIN")
        if "VITE_MATRIX_DOMAIN: ${KODERA_MATRIX_DOMAIN:?" not in web_block:
            errors.append("service 'web' must build VITE_MATRIX_DOMAIN from the tenant base domain")
        if not re.search(
            r'"--provider-origin"\n\s*- "\$\{KODERA_OIDC_PROVIDER_ORIGIN:\?', web_block
        ):
            errors.append("service 'web' must pass --provider-origin from KODERA_OIDC_PROVIDER_ORIGIN")

    # The module is installed exclusively from the local, read-only tree on every start.
    synapse = services.get("synapse")
    if synapse is not None:
        for key in (*COMMUNITY_KEYS[:2], SYNAPSE_OIDC_ENV_NAME):
            if synapse.environment.get(key) != "${" + key + ":-}":
                errors.append("service 'synapse' must consume " + key)
        block = "\n".join(synapse.raw_lines)
        for guard in (
            "../../packages/synapse-policy:/opt/kodera-policy:ro",
            "python -m pip install --no-index --no-deps --no-build-isolation --target /tmp/kodera-policy /tmp/kodera-policy-src",
            "PYTHONPATH: /tmp/kodera-policy",
            "./configure_synapse.py:/opt/community/configure_synapse.py:ro",
            "python /opt/community/configure_synapse.py /data/homeserver.yaml",
        ):
            if guard not in block:
                errors.append("service 'synapse' missing room-policy guard: " + guard)

        # Synapse runs on its own PostgreSQL, never on SQLite and never on the server's database.
        if synapse.depends_on_conditions.get("synapse-db") != "service_healthy":
            errors.append("Synapse must run on PostgreSQL: service 'synapse' must wait for a healthy 'synapse-db'")
        if not synapse.environment.get("PGPASSWORD", "").startswith("${" + SYNAPSE_DB_ENV_NAME + ":?"):
            errors.append(f"Synapse must run on PostgreSQL: service 'synapse' must read PGPASSWORD from {SYNAPSE_DB_ENV_NAME}")
        if "DATABASE_URL" in block or "${POSTGRES_PASSWORD" in block:
            errors.append("Synapse must run on PostgreSQL: service 'synapse' must not hold the server's database credential")
        if synapse.environment.get(FEDERATION_ENV_NAME) != "${" + FEDERATION_ENV_NAME + ":-}":
            errors.append(f"federation must be closed by default: service 'synapse' must consume {FEDERATION_ENV_NAME} with an empty default")
        if synapse.environment.get(SYNAPSE_OIDC_ISSUER_ENV_NAME) != "${" + SYNAPSE_OIDC_ISSUER_ENV_NAME + ":-}":
            errors.append("service 'synapse' must consume " + SYNAPSE_OIDC_ISSUER_ENV_NAME)
    synapse_db = services.get("synapse-db")
    if synapse_db is not None:
        if not (synapse_db.image or "").startswith("postgres:"):
            errors.append("Synapse must run on PostgreSQL: service 'synapse-db' must be a postgres image")
        if not synapse_db.environment.get("POSTGRES_PASSWORD", "").startswith("${" + SYNAPSE_DB_ENV_NAME + ":?"):
            errors.append(f"Synapse must run on PostgreSQL: service 'synapse-db' must require {SYNAPSE_DB_ENV_NAME}")
        initdb = synapse_db.environment.get("POSTGRES_INITDB_ARGS", "")
        if "--lc-collate=C" not in initdb or "--lc-ctype=C" not in initdb:
            errors.append("Synapse must run on PostgreSQL: service 'synapse-db' must initialise the C collation Synapse requires")
    errors.extend(compose_structure_errors(compose_text))
    if "8448" in compose_text:
        errors.append("federation must be closed by default: docker-compose.yml must not publish the federation port 8448")

    # 5. Healthcheck coverage on db, valkey, server, synapse and its database
    for hc_service_name in HEALTHCHECK_REQUIRED_SERVICES:
        svc = services.get(hc_service_name)
        if svc is not None and (not svc.has_healthcheck or not svc.healthcheck_test):
            errors.append(f"service '{hc_service_name}' must define a healthcheck block")

    # 6. Public config parity with SelfHostDeploymentPlan on caddy + Caddyfile
    caddy_svc = services.get("caddy")
    if caddy_svc is not None:
        for pub_key in ("KODERA_DOMAIN", "KODERA_ACME_EMAIL"):
            if pub_key not in caddy_svc.environment or pub_key not in caddy_svc.environment[pub_key]:
                errors.append(f"service 'caddy' must consume public config key '{pub_key}'")

    if "{$KODERA_DOMAIN}" not in caddyfile_text:
        errors.append("Caddyfile must reference '{$KODERA_DOMAIN}'")
    if "{$KODERA_ACME_EMAIL}" not in caddyfile_text:
        errors.append("Caddyfile must reference '{$KODERA_ACME_EMAIL}'")
    if "reverse_proxy room-access:8095" not in caddyfile_text:
        errors.append("Caddyfile must proxy room-access token endpoint to 'room-access:8095'")
    if "reverse_proxy server:8000" not in caddyfile_text:
        errors.append("Caddyfile must proxy API routes to 'server:8000'")
    errors.extend(check_caddy_routes(caddyfile_text))

    # 7. Both topologies run from this file. Nothing may wait for the web client, which the split
    #    topology does not start, and Synapse learns which Compose files actually run.
    if caddy_svc is not None and "web" in caddy_svc.depends_on_conditions:
        errors.append("service 'caddy' must not wait for 'web': the split topology does not start the web client")
    if synapse is not None:
        if synapse.environment.get(TOPOLOGY_ENV_NAME) != "${" + TOPOLOGY_ENV_NAME + ":-single}":
            errors.append(f"service 'synapse' must consume {TOPOLOGY_ENV_NAME} with the default 'single'")
        if synapse.environment.get(COMPOSE_TOPOLOGY_ENV_NAME) != "single":
            errors.append(f"service 'synapse' must set {COMPOSE_TOPOLOGY_ENV_NAME}: single, which only docker-compose.split.yml changes")
    if env_map.get(TOPOLOGY_ENV_NAME) != "single":
        errors.append(f".env.example must default {TOPOLOGY_ENV_NAME} to 'single'")
    livekit = services.get("livekit")
    if livekit is not None and section_entries(livekit, "ports") != list(LIVEKIT_PUBLISHED_PORTS):
        errors.append(
            "service 'livekit' must publish exactly the media ports of livekit.yaml: "
            + ", ".join(entry[2:].strip('"') for entry in LIVEKIT_PUBLISHED_PORTS)
        )

    return errors


# What docker-compose.split.yml may change, per service and key: the Caddyfile Caddy reads and the
# base domain it names, the web client left unstarted, the console origin the API admits, the
# signalling origin room-access hands out, and the topology Synapse is told it runs in.
SPLIT_WEB_PROFILE = "profiles: [single-origin-web]"
SPLIT_OVERRIDE_KEYS: dict[str, frozenset[str]] = {
    "caddy": frozenset({"volumes", "environment"}),
    "web": frozenset({"profiles"}),
    "server": frozenset({"environment"}),
    "yjs-collab": frozenset({"environment"}),
    "room-access": frozenset({"environment"}),
    "synapse": frozenset({"environment"}),
}
SPLIT_OVERRIDE_ENVIRONMENT: dict[str, dict[str, str]] = {
    "caddy": {"KODERA_MATRIX_DOMAIN": "${KODERA_MATRIX_DOMAIN:?"},
    "server": {
        "KODERA_CONSOLE_ORIGINS": "https://${KODERA_DOMAIN:?",
        "KODERA_COLLAB_PUBLIC_URL": "wss://api.${KODERA_MATRIX_DOMAIN:?",
    },
    "yjs-collab": {"KODERA_COLLAB_ALLOWED_ORIGINS": "https://${KODERA_DOMAIN:?"},
    "room-access": {"LIVEKIT_WS_URL": "wss://livekit.${KODERA_DOMAIN:?"},
    "synapse": {COMPOSE_TOPOLOGY_ENV_NAME: "split"},
}
SPLIT_CADDY_MOUNT = "- ./Caddyfile.split:/etc/caddy/Caddyfile:ro"


def check_split_topology(override_text: str, split_caddyfile_text: str, env_text: str) -> list[str]:
    """docker-compose.split.yml and Caddyfile.split: the split topology changes only what it must."""
    errors = compose_structure_errors(override_text, "docker-compose.split.yml")
    env_map, _ = parse_env_example(env_text)
    for var in sorted(set(COMPOSE_VAR_RE.findall(override_text))):
        if var not in env_map:
            errors.append(f"missing variable in .env.example: {var} (docker-compose.split.yml)")
    for name, default in COMPOSE_DEFAULT_RE.findall(override_text):
        if default and (SECRET_SHAPED_NAME_RE.search(name) or looks_like_secret(default)):
            errors.append(f"secret default in docker-compose.split.yml for {name}")
    services = parse_compose_services(override_text)
    for name, service in services.items():
        allowed = SPLIT_OVERRIDE_KEYS.get(name)
        if allowed is None:
            errors.append(f"docker-compose.split.yml changes an unreviewed service '{name}'")
            continue
        keys = {line.strip().split(":", 1)[0] for line in service.raw_lines if len(line) - len(line.lstrip(" ")) == 4}
        for key in sorted(keys - allowed):
            errors.append(f"docker-compose.split.yml changes an unreviewed key '{key}' of service '{name}'")
        expected = SPLIT_OVERRIDE_ENVIRONMENT.get(name, {})
        for key, value in service.environment.items():
            if key not in expected:
                errors.append(f"docker-compose.split.yml sets an unreviewed variable {key} on service '{name}'")
            elif not value.startswith(expected[key]):
                errors.append(f"docker-compose.split.yml must set {key} on service '{name}' to {expected[key]}...")
        for key in expected:
            if key not in service.environment:
                errors.append(f"docker-compose.split.yml must set {key} on service '{name}'")
    for name in SPLIT_OVERRIDE_KEYS:
        if name not in services:
            errors.append(f"docker-compose.split.yml must change service '{name}'")
    caddy = services.get("caddy")
    if caddy is not None and section_entries(caddy, "volumes") != [SPLIT_CADDY_MOUNT]:
        errors.append("docker-compose.split.yml must mount Caddyfile.split as Caddy's only configuration")
    web = services.get("web")
    if web is not None and [line.strip() for line in web.raw_lines] != [SPLIT_WEB_PROFILE]:
        errors.append(
            "docker-compose.split.yml must leave the web client unstarted "
            f"('{SPLIT_WEB_PROFILE}'): the split topology serves it from its own static origin"
        )
    server = services.get("server")
    if server is not None:
        for forbidden in (*ISOLATED_ROOM_ACCESS_SECRETS, *AGENT_ENV_NAMES, SYNAPSE_OIDC_ENV_NAME, SYNAPSE_DB_ENV_NAME):
            if forbidden in "\n".join(server.raw_lines):
                errors.append(f"ADR-0003 isolation violation: forbidden secret '{forbidden}' in service 'server' (docker-compose.split.yml)")
    errors.extend(check_split_caddy_routes(split_caddyfile_text))
    return list(dict.fromkeys(errors))


CLIENT_ADDRESS_OVERRIDE = "header_up X-Forwarded-For {remote_host}"
STRIPPED_CLIENT_HEADERS = ("header_up -X-Real-IP", "header_up -Forwarded")
PUBLISHING_SERVICES = frozenset({"caddy", "livekit"})

# The Compose file is read without a YAML library (this script runs with the system Python, on
# CI and on an operator's host), so it is held to the one shape the reader understands: block
# mappings, two-space indentation, reviewed keys. Anything else is refused, never skipped.
REVIEWED_TOP_LEVEL_KEYS = frozenset({"services", "volumes"})
REVIEWED_SERVICE_KEYS = frozenset({
    "mem_limit", "image", "build", "restart", "ports", "environment", "volumes", "depends_on",
    "healthcheck", "command", "entrypoint", "profiles", "user",
})
BLOCK_ONLY_SERVICE_KEYS = frozenset({"build", "environment", "volumes", "depends_on", "healthcheck", "ports"})
REVIEWED_BIND_MOUNTS = frozenset({
    "./Caddyfile:/etc/caddy/Caddyfile:ro",
    "./Caddyfile.split:/etc/caddy/Caddyfile:ro",
    "./livekit.yaml:/etc/livekit.yaml:ro",
    "./configure_synapse.py:/opt/community/configure_synapse.py:ro",
    "../../packages/synapse-policy:/opt/kodera-policy:ro",
})
REVIEWED_BUILD_LINES = frozenset({
    "context: ../../apps/server", "context: ../../apps/server/yjs_collab", "context: ../..",
    "dockerfile: Dockerfile", "dockerfile: Dockerfile.migrator", "dockerfile: apps/web/Dockerfile",
    "args:",
})
# livekit.yaml holds no credential (the keys arrive in LIVEKIT_KEYS) and opens no room on demand.
# It is a static file, so the gate holds its reviewed text and compares byte for byte: a setting
# cannot move under another parent, change indentation, repeat or gain a neighbour unseen.
# Changing the file means changing this text in the same commit.
REVIEWED_LIVEKIT_YAML = """\
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true
room:
  auto_create: false
  empty_timeout: 30
logging:
  level: info
"""
YAML_INDIRECTION_RE = re.compile(r"(?:^|[\s\[{,])[&*][A-Za-z_][\w.-]*(?=$|[\s,\]}])|(?:^|[\s{,-])[\"']?<<[\"']?\s*:")
YAML_BLOCK_SCALAR_RE = re.compile(r"(?::|-)\s*[|>][+-]?\d?$")


def compose_structure_errors(compose_text: str, file_name: str = "docker-compose.yml") -> list[str]:
    """Refuse every Compose construct the line reader cannot follow, and every service key that
    was not reviewed. A host port or host networking is judged on the key, whatever its quoting
    or form; anchors, aliases and merge keys are refused outright."""
    errors: list[str] = []
    top: str | None = None
    service: str | None = None
    section: str | None = None
    awaiting_first_key = False
    seen_services: set[str] = set()
    scalar_indent: int | None = None

    def where(number: int) -> str:
        return f"{file_name} line {number}"

    for number, raw in enumerate(compose_text.splitlines(), start=1):
        leading = raw[: len(raw) - len(raw.lstrip())]
        if scalar_indent is not None:
            if not raw.strip() or len(leading) > scalar_indent:
                continue
            scalar_indent = None
        code = raw.split("#", 1)[0].rstrip()
        if not code.strip():
            continue
        if "\t" in leading:
            errors.append(f"{where(number)}: tab indentation is refused")
            continue
        indent = len(leading)
        stripped = code.strip()
        if YAML_INDIRECTION_RE.search(stripped):
            errors.append(f"{where(number)}: YAML anchors, aliases and merge keys are refused: the gate cannot follow them")
        if indent % 2:
            errors.append(f"{where(number)}: indentation must be a multiple of two spaces")
            continue
        if YAML_BLOCK_SCALAR_RE.search(stripped):
            scalar_indent = indent
        if indent == 0:
            key = stripped[:-1].strip("\"'") if stripped.endswith(":") else stripped
            if not stripped.endswith(":") or key not in REVIEWED_TOP_LEVEL_KEYS:
                errors.append(f"{where(number)}: unreviewed top-level key '{key.split(':', 1)[0]}'")
                top = None
            else:
                top = key
            service = section = None
            continue
        if top == "volumes":
            if indent != 2 or not re.fullmatch(r"[a-z][a-z0-9_]*:", stripped):
                errors.append(f"{where(number)}: a named volume is declared as 'name:' and nothing else")
            continue
        if top != "services":
            continue
        if indent == 2:
            found = re.fullmatch(r"([a-z0-9][a-z0-9-]*):", stripped)
            section = None
            if not found:
                errors.append(f"{where(number)}: unsupported service definition: a service is declared as 'name:' with its keys below")
                service = None
                continue
            service = found.group(1)
            if service in seen_services:
                errors.append(f"{where(number)}: service '{service}' is defined twice")
            seen_services.add(service)
            awaiting_first_key = True
            continue
        if service is None:
            continue
        if awaiting_first_key and indent != 4:
            errors.append(f"{where(number)}: service '{service}' must indent its keys by four spaces")
        awaiting_first_key = False
        if indent == 4:
            found = re.fullmatch(r"""(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1\s*:(?:\s+(.*))?""", stripped)
            if not found:
                errors.append(f"{where(number)}: unreadable key in service '{service}'")
                section = None
                continue
            key, value = found.group(2), found.group(3) or ""
            section = key
            if key == "network_mode":
                errors.append(f"service '{service}' must not publish a port: network_mode is refused, every service stays on the stack's own network")
            elif key not in REVIEWED_SERVICE_KEYS:
                errors.append(f"service '{service}' uses an unreviewed key '{key}'")
            elif key == "ports" and service not in PUBLISHING_SERVICES:
                errors.append(
                    f"service '{service}' must not publish a port: it is reached through Caddy only"
                    + (", and its listener believes the address Caddy forwards" if service == "synapse" else "")
                )
            if value.startswith("{") or (key in BLOCK_ONLY_SERVICE_KEYS and value and not (key == "ports" and service not in PUBLISHING_SERVICES)):
                errors.append(f"service '{service}' must write '{key}' in block form, one entry per line")
            continue
        if indent == 6 and section == "build":
            if stripped not in REVIEWED_BUILD_LINES:
                errors.append(f"service '{service}' builds from an unreviewed context or Dockerfile")
        elif indent == 6 and section == "environment":
            if not re.fullmatch(r"[A-Z][A-Z0-9_]*:(?:\s.*)?", stripped):
                errors.append(f"{where(number)}: service '{service}' environment must be a mapping of NAME: value")
        elif indent == 6 and section == "volumes":
            found = re.fullmatch(r"- (\S+)", stripped)
            if not found:
                errors.append(f"{where(number)}: service '{service}' volumes must be short 'source:target' entries")
            elif not re.fullmatch(r"[a-z][a-z0-9_]*:/[A-Za-z0-9._/-]+", found.group(1)) and found.group(1) not in REVIEWED_BIND_MOUNTS:
                errors.append(f"service '{service}' has an unreviewed bind mount (only the reviewed read-only mounts are admitted)")
        elif indent == 6 and section == "ports":
            if not re.fullmatch(r"""- ["']?[0-9][0-9:/a-z-]*["']?""", stripped):
                errors.append(f"{where(number)}: service '{service}' ports must be short 'host:container' entries")
    return errors


def check_livekit_config(livekit_text: str) -> list[str]:
    """livekit.yaml is exactly its reviewed text. Any difference is refused, and named by the
    first line that differs: the setting found there and the one the reviewed file holds."""
    if livekit_text == REVIEWED_LIVEKIT_YAML:
        return []

    def setting(line: str | None) -> str:
        if line is None:
            return "nothing"
        return "'" + line.split(":", 1)[0].strip() + "' indented by " + str(len(line) - len(line.lstrip(" ")))

    found, reviewed = livekit_text.split("\n"), REVIEWED_LIVEKIT_YAML.split("\n")
    for number in range(max(len(found), len(reviewed))):
        here = found[number] if number < len(found) else None
        there = reviewed[number] if number < len(reviewed) else None
        if here != there:
            return [
                f"livekit.yaml differs from its reviewed text at line {number + 1}: "
                f"found {setting(here)}, the reviewed file holds {setting(there)}"
                + (" (same setting, another value or spacing)" if here is not None and there is not None and setting(here) == setting(there) else "")
            ]
    return ["livekit.yaml differs from its reviewed text"]


@dataclass
class CaddyBlock:
    header: str
    lines: list[str] = field(default_factory=list)
    blocks: list["CaddyBlock"] = field(default_factory=list)


def parse_caddyfile(caddyfile_text: str) -> tuple[CaddyBlock, list[str]]:
    """The Caddyfile as nested blocks: a line ending in `{` opens one, a lone `}` closes it."""
    root = CaddyBlock(header="")
    stack = [root]
    errors: list[str] = []
    for raw in caddyfile_text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line == "}":
            if len(stack) == 1:
                errors.append("Caddyfile closes a block that was never opened")
            else:
                stack.pop()
            continue
        if line.endswith("{"):
            block = CaddyBlock(header=line[:-1].strip())
            stack[-1].blocks.append(block)
            stack.append(block)
        else:
            stack[-1].lines.append(line)
    if len(stack) != 1:
        errors.append("Caddyfile leaves a block open")
    return root, errors


REVIEWED_CADDY_GLOBAL_OPTIONS = ("email {$KODERA_ACME_EMAIL}",)
REVIEWED_CADDY_SNIPPETS = {"client_address": (CLIENT_ADDRESS_OVERRIDE, *STRIPPED_CLIENT_HEADERS)}
REVIEWED_CADDY_SITE = "{$KODERA_DOMAIN}"
REVIEWED_CADDY_SITE_LINES = frozenset({"encode zstd gzip"})
REVIEWED_CADDY_RESPONSE_HEADERS = (
    'Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"',
    'X-Content-Type-Options "nosniff"',
    'X-Frame-Options "DENY"',
    'Referrer-Policy "strict-origin-when-cross-origin"',
)
REVIEWED_CADDY_REWRITES = {"rewrite * /token": "room-access:8095"}
SINGLE_CADDY_SITES: dict[str, frozenset[str]] = {REVIEWED_CADDY_SITE: frozenset(ALLOWED_PUBLIC_ROUTES)}
# Split topology (README.md, "Topologies"): the web client is served from its own static origin,
# https://{$KODERA_DOMAIN}, and the stack publishes one origin per backend. Each upstream belongs to
# exactly one of them, so the Core API is never reachable on the Matrix origin and so on.
SPLIT_API_SITE = "api.{$KODERA_MATRIX_DOMAIN}"
SPLIT_MATRIX_SITE = "matrix.{$KODERA_DOMAIN}"
SPLIT_LIVEKIT_SITE = "livekit.{$KODERA_DOMAIN}"
SPLIT_CADDY_SITES: dict[str, frozenset[str]] = {
    SPLIT_API_SITE: frozenset({"server:8000", "yjs-collab:8098"}),
    SPLIT_MATRIX_SITE: frozenset({"synapse:8008", "room-access:8095"}),
    SPLIT_LIVEKIT_SITE: frozenset({"livekit:7880"}),
}
# Synapse answers every origin with `Access-Control-Allow-Origin: *`. On its own origin that grant
# is replaced by the one console origin; the API and room-access already grant exact origins only.
SPLIT_SYNAPSE_CORS = 'header_down Access-Control-Allow-Origin "https://{$KODERA_DOMAIN}"'
SPLIT_PROXY_OPTIONS: dict[tuple[str, str], tuple[str, ...]] = {
    (SPLIT_MATRIX_SITE, "synapse:8008"): (SPLIT_SYNAPSE_CORS,),
}


def _directive(line: str) -> str:
    """The first word of a line: errors name the directive, never the rest of the line."""
    return line.split()[0] if line.split() else ""


def check_caddy_routes(caddyfile_text: str) -> list[str]:
    """The single-origin Caddyfile: one site block, the web client as its catch-all."""
    return _check_caddy(caddyfile_text, label="Caddyfile", site_upstreams=SINGLE_CADDY_SITES, catch_all=CATCH_ALL_UPSTREAM)


def check_split_caddy_routes(caddyfile_text: str) -> list[str]:
    """The split-origin Caddyfile: one site block per public backend origin, no web client, and
    an explicit `respond 404` for everything a site does not route (README.md, "Topologies")."""
    return _check_caddy(caddyfile_text, label="Caddyfile.split", site_upstreams=SPLIT_CADDY_SITES, catch_all=None,
                        proxy_options=SPLIT_PROXY_OPTIONS)


def _check_caddy(
    caddyfile_text: str,
    *,
    label: str,
    site_upstreams: dict[str, frozenset[str]],
    catch_all: str | None,
    proxy_options: dict[tuple[str, str], tuple[str, ...]] | None = None,
) -> list[str]:
    """Hold a Caddyfile to its reviewed shape, and refuse everything else by name.

    One global options block, the `client_address` snippet, and exactly the reviewed site blocks.
    In each, every `handle` uses a named path matcher of that same block, and proxies one
    upstream reviewed for that site with X-Forwarded-For overwritten by the peer address. A
    handle without a matcher proxies to `catch_all`, or, when there is none, answers 404. The
    agent API and Matrix federation, key and admin routes are refused; so are `trusted_proxies`,
    an `import` of anything but a snippet of this file, and any directive that was not reviewed:
    the gate does not skip what it does not understand.
    """
    root, errors = parse_caddyfile(caddyfile_text)
    code = "\n".join(line for line in caddyfile_text.splitlines() if not line.strip().startswith("#"))
    if "trusted_proxies" in code:
        errors.append(
            f"{label} must not declare trusted_proxies: no proxy sits in front of Caddy, "
            "so a forwarded client address is never believed"
        )
    snippets = {
        block.header[1:-1]: block
        for block in root.blocks
        if block.header.startswith("(") and block.header.endswith(")")
    }

    def refuse_import(line: str) -> None:
        argument = line.split(None, 1)[1] if len(line.split(None, 1)) > 1 else ""
        errors.append(
            f"{label} import '{argument}' is not a snippet defined in this file: "
            "directives pulled from another file are never checked"
        )

    def walk(block: CaddyBlock) -> list[CaddyBlock]:
        return [block] + [found for child in block.blocks for found in walk(child)]

    for block in walk(root):
        for line in block.lines:
            if _directive(line) == "import" and line.split()[1:] not in ([name] for name in snippets):
                refuse_import(line)

    for line in root.lines:
        errors.append(f"{label} has an unreviewed directive outside every block: '{_directive(line)}'")
    sites: list[CaddyBlock] = []
    for position, block in enumerate(root.blocks):
        if block.header == "":
            if position != 0 or block.blocks or tuple(block.lines) != REVIEWED_CADDY_GLOBAL_OPTIONS:
                errors.append(f"{label} global options differ from the reviewed ones (the ACME contact only)")
        elif block.header.startswith("("):
            name = block.header[1:-1] if block.header.endswith(")") else block.header
            if block.blocks or sorted(block.lines) != sorted(REVIEWED_CADDY_SNIPPETS.get(name, ("",))):
                errors.append(f"{label} snippet '{name}' differs from the reviewed one")
        else:
            sites.append(block)
    if [site.header for site in sites] != list(site_upstreams):
        if len(site_upstreams) == 1:
            errors.append(f"{label} must hold exactly one site block, for {next(iter(site_upstreams))} (found {len(sites)})")
        else:
            errors.append(
                f"{label} must hold exactly the site blocks {', '.join(site_upstreams)}, in that order "
                f"(found {', '.join(site.header for site in sites) or 'none'})"
            )
    proxy_options = proxy_options or {}

    proxied = 0
    for site in sites:
        # Matchers belong to their site block: one block never answers for another.
        matchers: dict[str, list[str]] = {}
        answers_unrouted = False
        for line in site.lines:
            if line.startswith("@"):
                found = re.fullmatch(r"@([a-z_]+)[ \t]+path[ \t]+(\S.*)", line)
                if not found:
                    errors.append(f"{label} matcher '{_directive(line)}' must be a single-line path matcher")
                elif found.group(1) in matchers:
                    errors.append(f"{label} defines the matcher '@{found.group(1)}' twice in one site block")
                else:
                    matchers[found.group(1)] = found.group(2).split()
            elif _directive(line) == "import":
                errors.append(f"{label} imports a snippet outside a reverse_proxy block, where it was not reviewed")
            elif line not in REVIEWED_CADDY_SITE_LINES:
                errors.append(f"{label} has an unreviewed directive in a site block: '{_directive(line)}'")
        for block in site.blocks:
            if block.header == "header":
                if block.blocks or tuple(block.lines) != REVIEWED_CADDY_RESPONSE_HEADERS:
                    errors.append(f"{label} response headers differ from the reviewed set")
                continue
            if block.header.startswith("@"):
                errors.append(f"{label} matcher '{_directive(block.header)}' must be a single-line path matcher")
                continue
            handle = re.fullmatch(r"handle(?:[ \t]+@([a-z_]+))?", block.header)
            if not handle:
                errors.append(f"{label} has an unreviewed block in a site block: '{_directive(block.header)}'")
                # Still count what it proxies, so that the route is reported as unreviewed too.
            matcher = handle.group(1) if handle else None
            if handle and matcher is None and block.lines == ["respond 404"] and not block.blocks:
                answers_unrouted = True
            upstreams: list[tuple[str, list[str]]] = []
            for line in block.lines:
                if _directive(line) == "reverse_proxy":
                    upstreams.extend((upstream, []) for upstream in line.split()[1:])
                elif _directive(line) == "import":
                    errors.append(f"{label} imports a snippet outside a reverse_proxy block, where it was not reviewed")
                elif line not in ("respond 404", *REVIEWED_CADDY_REWRITES):
                    errors.append(f"{label} has an unreviewed directive in a handle: '{_directive(line)}'")
            for child in block.blocks:
                words = child.header.split()
                if words[:1] != ["reverse_proxy"] or len(words) != 2 or child.blocks:
                    errors.append(f"{label} has an unreviewed block in a handle: '{_directive(child.header)}'")
                    upstreams.extend((upstream, []) for upstream in words[1:] if words[:1] == ["reverse_proxy"])
                    continue
                directives: list[str] = []
                reviewed_options = proxy_options.get((site.header, words[1]), ())
                for line in child.lines:
                    if _directive(line) == "import":
                        name = line.split()[1:]
                        directives.extend(snippets[name[0]].lines if len(name) == 1 and name[0] in snippets else [])
                    elif line in (CLIENT_ADDRESS_OVERRIDE, *STRIPPED_CLIENT_HEADERS) or re.match(r"header_up[ \t]+[+-]?X-Forwarded-For\b", line, re.IGNORECASE):
                        directives.append(line)
                    elif line in reviewed_options:
                        directives.append(line)
                    else:
                        errors.append(f"{label} has an unreviewed reverse_proxy option for '{words[1]}': '{' '.join(line.split()[:2])}'")
                for option in reviewed_options:
                    if option not in directives:
                        errors.append(f"{label} must set the reviewed reverse_proxy option for '{words[1]}': '{option}'")
                upstreams.append((words[1], directives))
            for rewrite, only_for in REVIEWED_CADDY_REWRITES.items():
                if rewrite in block.lines and [upstream for upstream, _ in upstreams] != [only_for]:
                    errors.append(f"{label} rewrites a path in a handle that is not the reviewed one ('{rewrite}' is for {only_for} only)")
            for upstream, directives in upstreams:
                proxied += 1
                forwarded = [line for line in directives if re.match(r"header_up[ \t]+[+-]?X-Forwarded-For\b", line, re.IGNORECASE)]
                if forwarded != [CLIENT_ADDRESS_OVERRIDE]:
                    errors.append(
                        f"{label} must overwrite X-Forwarded-For with the peer address for '{upstream}' "
                        f"(exactly '{CLIENT_ADDRESS_OVERRIDE}'): a client-supplied value must never reach an upstream"
                    )
                for stripped in STRIPPED_CLIENT_HEADERS:
                    if stripped not in directives:
                        errors.append(f"{label} must drop the client-supplied header for '{upstream}': '{stripped}'")
                if handle and matcher is None:
                    if catch_all is None:
                        errors.append(f"{label} catch-all must answer 404, never proxy (got '{upstream}')")
                    elif upstream != catch_all:
                        errors.append(f"{label} catch-all must proxy to '{catch_all}' only (got '{upstream}')")
                    continue
                if upstream not in site_upstreams.get(site.header, frozenset()) and upstream in ALLOWED_PUBLIC_ROUTES:
                    errors.append(f"{label} site '{site.header}' proxies to '{upstream}', which is not reviewed for that site")
                allowed = ALLOWED_PUBLIC_ROUTES.get(upstream)
                if allowed is None:
                    errors.append(f"{label} proxies '{block.header}' to an unreviewed upstream '{upstream}'")
                    continue
                if matcher not in matchers:
                    errors.append(f"{label} handle '{block.header}' has no path matcher in its own site block")
                    continue
                for path in matchers[matcher]:
                    if path in allowed:
                        continue
                    if upstream == "server:8000" and path.startswith("/agent"):
                        errors.append(f"{label} must not expose the agent API to the internet (got '{path}')")
                    elif upstream == "synapse:8008":
                        errors.append(
                            f"federation must be closed by default: {label} must route only the Matrix client API, "
                            f"never federation, key or admin routes (got '{path}')"
                        )
                    else:
                        errors.append(f"{label} exposes an unreviewed route to '{upstream}': '{path}'")
        if catch_all is None and not answers_unrouted:
            errors.append(
                f"{label} site '{site.header}' must answer 404 for every path it does not route "
                "(a 'handle' block holding 'respond 404' only)"
            )
    if proxied != len(re.findall(r"(?m)^[ \t]*reverse_proxy[ \t]", code)):
        errors.append(f"{label} has a reverse_proxy outside a reviewed handle block")
    return list(dict.fromkeys(errors))


def check_synapse_policy_source(source: str) -> list[str]:
    required = (
        'MODULE = "kodera_synapse_policy.KoderaPolicy"',
        '"room_access_user_id": f"@kodera-rooms:{server}"',
        '"agent_user_id": f"@kodera-agent:{server}"',
        'version("kodera-synapse-policy") != "0.1.5"',
        'yaml.safe_dump(configure(document, os.environ)',
        '"pkce_method": "always"',
        '"allow_existing_users": False',
        '"localpart_template": "{{ user.sub | lower }}"',
    )
    return ["Synapse configuration missing policy guard: " + guard for guard in required if guard not in source]


SYNTHETIC_CREDENTIAL = "synthetic-issued-token-for-test-only"
# The loosest rate limits the profile admits: (per_second, burst_count). They are Synapse's
# documented defaults, except rc_login.address (see deploy/community/configure_synapse.py and
# README.md, "Images and limits"). A stricter value passes; a looser one is refused.
RATE_LIMIT_CEILINGS: dict[tuple[str, ...], tuple[float, int]] = {
    ("rc_message",): (0.2, 10),
    ("rc_registration",): (0.17, 3),
    ("rc_login", "address"): (0.17, 20),
    ("rc_login", "account"): (0.003, 5),
    ("rc_login", "failed_attempts"): (0.17, 3),
    ("rc_joins", "local"): (0.1, 10),
    ("rc_joins", "remote"): (0.01, 10),
    ("rc_invites", "per_room"): (0.3, 10),
    ("rc_invites", "per_user"): (0.003, 5),
    ("rc_invites", "per_issuer"): (0.3, 10),
}
PILOT_SETTINGS = {
    "refreshable_access_token_lifetime": "5m",
    "refresh_token_lifetime": "24h",
    "forget_rooms_on_leave": True,
    "enable_authenticated_media": True,
    "encryption_enabled_by_default_for_room_type": "off",
    "require_auth_for_profile_requests": True,
    "allow_public_rooms_over_federation": False,
    "allow_public_rooms_without_auth": False,
}


def _generated_homeserver() -> dict:
    """What the Synapse image generates on a fresh volume: SQLite and an open federation listener."""
    return {
        "server_name": "chat.example.org",
        "listeners": [
            {
                "port": 8008, "tls": False, "type": "http", "x_forwarded": False,
                "resources": [{"names": ["client", "federation"], "compress": False}],
            },
            # An operator's own listener, which Caddy does not front.
            {"port": 9000, "tls": False, "type": "http", "x_forwarded": True, "resources": [{"names": ["client"]}]},
        ],
        "database": {"name": "sqlite3", "args": {"database": "/data/homeserver.db"}},
        "trusted_key_servers": [{"server_name": "matrix.org"}],
        "modules": [{"module": "operator.module"}],
    }


def _refuses(call: Callable[[], object], kind: type[Exception] = ValueError) -> bool:
    try:
        call()
    except kind:
        return True
    return False


def check_synapse_config(source: str) -> list[str]:
    """Run deploy/community/configure_synapse.py on a freshly generated homeserver and refuse a
    result that is not the hardened one. It judges what Synapse would read, not the source text."""
    module = types.ModuleType("community_configure_synapse")
    try:
        exec(compile(source, "configure_synapse.py", "exec"), module.__dict__)  # noqa: S102 - the repository's own file
        configure = module.configure
        closed = configure(_generated_homeserver(), {})
    except Exception as error:  # noqa: BLE001 - any failure to evaluate is a refusal
        return [f"configure_synapse.py could not be evaluated: {type(error).__name__}"]
    errors: list[str] = []

    def guarded(label: str, call: Callable[[], list[str]]) -> None:
        try:
            errors.extend(call())
        except Exception as error:  # noqa: BLE001
            errors.append(f"{label}: configure_synapse.py failed with {type(error).__name__}")

    def listener_names(document: dict) -> list[str]:
        return [name for listener in document.get("listeners", []) for resource in listener.get("resources", []) for name in resource.get("names", [])]

    def database() -> list[str]:
        found = closed.get("database") or {}
        args = found.get("args") or {}
        problems = []
        if found.get("name") != "psycopg2" or args.get("host") != "synapse-db":
            problems.append("Synapse must run on PostgreSQL, not SQLite")
        if any(key in args for key in ("password", "passfile")):
            problems.append("Synapse must run on PostgreSQL: its database password stays out of homeserver.yaml")
        unported = {"database": {"name": "sqlite3", "args": {"database": "/data/homeserver.db"}}}
        refuse = getattr(module, "refuse_unported_sqlite", None)
        if refuse is None or not _refuses(lambda: refuse(unported, exists=lambda _path: True), RuntimeError):
            problems.append("Synapse must refuse to abandon an existing SQLite database")
        elif _refuses(lambda: refuse(unported, exists=lambda _path: False), RuntimeError) or _refuses(
            lambda: refuse(closed, exists=lambda _path: True), RuntimeError
        ):
            problems.append("Synapse must start on a fresh volume and on an already ported one")
        return problems

    def federation() -> list[str]:
        problems = []
        if closed.get("federation_domain_whitelist") != [] or "federation" in listener_names(closed) or closed.get("trusted_key_servers") != []:
            problems.append("Synapse federation must be closed by default (empty whitelist, no federation listener, no key server)")
        opened = configure(_generated_homeserver(), {FEDERATION_ENV_NAME: "b.example.org, a.example.org"})
        if opened.get("federation_domain_whitelist") != ["a.example.org", "b.example.org"] or "federation" not in listener_names(opened):
            problems.append("Synapse federation opt-in must be the operator's explicit allowlist")
        for unsafe in ("*", "localhost", "partner.internal", "a.example.org,*"):
            if not _refuses(lambda unsafe=unsafe: configure(_generated_homeserver(), {FEDERATION_ENV_NAME: unsafe})):
                problems.append("Synapse federation allowlist must refuse a wildcard or private server name")
                break
        return problems

    def policy() -> list[str]:
        wanted = {"module": "kodera_synapse_policy.KoderaPolicy", "config": {
            "agent_user_id": "@kodera-agent:chat.example.org",
            "room_access_user_id": "@kodera-rooms:chat.example.org",
        }}
        modules = closed.get("modules") or []
        if modules.count(wanted) != 1 or {"module": "operator.module"} not in modules:
            return ["Synapse room-policy module is missing or misconfigured"]
        return []

    def rate_limits() -> list[str]:
        problems = []
        for path, (max_per_second, max_burst) in RATE_LIMIT_CEILINGS.items():
            limit: object = closed
            for key in path:
                limit = limit.get(key) if isinstance(limit, dict) else None
            per_second = limit.get("per_second") if isinstance(limit, dict) else None
            burst = limit.get("burst_count") if isinstance(limit, dict) else None
            if (
                not isinstance(per_second, (int, float)) or isinstance(per_second, bool) or per_second <= 0
                or not isinstance(burst, int) or isinstance(burst, bool) or burst < 1
            ):
                problems.append("Synapse rate limits must be set: " + ".".join(path))
            elif per_second > max_per_second or burst > max_burst:
                problems.append(
                    "Synapse rate limits must not be looser than the reviewed ceiling: "
                    + ".".join(path) + f" (at most {max_per_second} per second, burst {max_burst})"
                )
        fronted_port = getattr(module, "PROXIED_LISTENER_PORT", None)
        if f"synapse:{fronted_port}" not in ALLOWED_PUBLIC_ROUTES:
            problems.append("Synapse must name the listener Caddy fronts (PROXIED_LISTENER_PORT is not Caddy's upstream)")
        for listener in closed.get("listeners", []):
            fronted = listener.get("port") == fronted_port
            if fronted and listener.get("x_forwarded") is not True:
                problems.append("Synapse rate limits must see each client: the listener Caddy fronts must set x_forwarded")
            if not fronted and listener.get("x_forwarded") is not False:
                problems.append(
                    "Synapse must believe a forwarded address only on the listener Caddy fronts "
                    f"(x_forwarded is set on port {listener.get('port')})"
                )
        return problems

    def accounts() -> list[str]:
        problems = []
        if closed.get("enable_registration") is not False or (closed.get("password_config") or {}).get("enabled") is not False:
            problems.append("Synapse must keep open registration and password sign-in off")
        if "oidc_providers" in closed:
            problems.append("Synapse must not invent an identity provider when none is configured")
        for key, value in PILOT_SETTINGS.items():
            if closed.get(key) != value:
                problems.append(f"Synapse must keep the documented setting {key}")
        if configure(copy.deepcopy(closed), {}) != closed:
            problems.append("Synapse configuration must be idempotent across restarts")
        return problems

    def sign_in() -> list[str]:
        problems = []
        cases = (
            ("kodera", {SYNAPSE_OIDC_ISSUER_ENV_NAME: "https://id.example.org/realms/studio", SYNAPSE_OIDC_ENV_NAME: SYNTHETIC_CREDENTIAL},
             "https://id.example.org/realms/studio"),
            ("community", {COMMUNITY_KEYS[0]: "community", COMMUNITY_KEYS[1]: "https://id.example.org/realms/community",
                           SYNAPSE_OIDC_ENV_NAME: SYNTHETIC_CREDENTIAL}, "https://id.example.org/realms/community"),
        )
        for idp_id, environment, issuer in cases:
            signed = configure(_generated_homeserver(), environment)
            providers = signed.get("oidc_providers") or []
            provider = providers[0] if len(providers) == 1 else {}
            mapping = (provider.get("user_mapping_provider") or {}).get("config") or {}
            if (
                provider.get("idp_id") != idp_id or provider.get("issuer") != issuer or provider.get("client_id") != "synapse"
                or provider.get("client_secret") != SYNTHETIC_CREDENTIAL or provider.get("pkce_method") != "always"
                or provider.get("allow_existing_users") is not False or provider.get("backchannel_logout_enabled") is not True
                or mapping.get("localpart_template") != "{{ user.sub | lower }}" or mapping.get("subject_template") != "{{ user.sub }}"
            ):
                problems.append(f"Synapse OIDC sign-in is not wired as documented ({idp_id}: client synapse, PKCE, subject localpart)")
            if (signed.get("sso") or {}).get("client_whitelist") != ["https://chat.example.org/"] or signed.get("public_baseurl") != "https://chat.example.org/":
                problems.append(f"Synapse OIDC sign-in must return to the web origin with a trailing slash only ({idp_id})")
            if (signed.get("password_config") or {}).get("enabled") is not False or signed.get("enable_registration") is not False:
                problems.append(f"Synapse OIDC sign-in must keep password sign-in and registration off ({idp_id})")
            if configure(copy.deepcopy(signed), environment) != signed:
                problems.append(f"Synapse OIDC configuration must be idempotent across restarts ({idp_id})")
            unrelated = dict(_generated_homeserver(), oidc_providers=[{"idp_id": "unrelated"}])
            if not _refuses(lambda unrelated=unrelated, environment=environment: configure(unrelated, environment)):
                problems.append(f"Synapse OIDC sign-in must not silently replace an unrelated identity provider ({idp_id})")
        generic, community = cases[0][1], cases[1][1]
        unsafe = (
            dict(generic, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: "http://id.example.org/realms/studio"}),
            dict(generic, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: "https://id.internal/realms/studio"}),
            dict(generic, **{SYNAPSE_OIDC_ENV_NAME: ""}),
            dict(generic, **{SYNAPSE_OIDC_ENV_NAME: "CHANGE_ME_ISSUED_SYNAPSE_CLIENT_SECRET"}),
            dict(generic, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: ""}),
            dict(community, **{COMMUNITY_KEYS[1]: "http://id.example.org/realms/community"}),
            dict(community, **{SYNAPSE_OIDC_ENV_NAME: ""}),
            dict(community, **{COMMUNITY_KEYS[0]: "other"}),
            dict(community, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: "https://id.example.org/realms/studio"}),
        )
        if not all(_refuses(lambda environment=environment: configure(_generated_homeserver(), environment)) for environment in unsafe):
            problems.append("Synapse OIDC sign-in accepts an unsafe issuer or a missing client credential")
        return problems

    def topologies() -> list[str]:
        problems = []
        split = {TOPOLOGY_ENV_NAME: "split", COMPOSE_TOPOLOGY_ENV_NAME: "split"}
        plain = configure(_generated_homeserver(), split)
        if plain.get("public_baseurl") != "https://matrix.chat.example.org/" or plain.get("server_name") != "chat.example.org":
            problems.append("Synapse split topology must publish its client API at https://matrix.<server_name>/")
        community = {COMMUNITY_KEYS[0]: "community", COMMUNITY_KEYS[1]: "https://id.example.org/realms/community",
                     SYNAPSE_OIDC_ENV_NAME: SYNTHETIC_CREDENTIAL, **split}
        signed = configure(_generated_homeserver(), community)
        if signed.get("public_baseurl") != "https://matrix.chat.example.org/":
            problems.append("Synapse split topology must publish its client API at https://matrix.<server_name>/")
        if (signed.get("sso") or {}).get("client_whitelist") != ["https://chat.example.org/"]:
            problems.append("Synapse split sign-in must return the login token to the web origin https://<server_name>/ only")
        if configure(copy.deepcopy(signed), community) != signed:
            problems.append("Synapse split configuration must be idempotent across restarts")
        if configure(copy.deepcopy(plain), {}).get("public_baseurl") == "https://matrix.chat.example.org/":
            problems.append("Synapse must drop the split public base URL when the stack returns to the single topology")
        mismatched = (
            {TOPOLOGY_ENV_NAME: "split"}, {COMPOSE_TOPOLOGY_ENV_NAME: "split"},
            {TOPOLOGY_ENV_NAME: "split", COMPOSE_TOPOLOGY_ENV_NAME: "single"},
            {TOPOLOGY_ENV_NAME: "both", COMPOSE_TOPOLOGY_ENV_NAME: "both"},
            {TOPOLOGY_ENV_NAME: "Split", COMPOSE_TOPOLOGY_ENV_NAME: "Split"},
        )
        if not all(_refuses(lambda environment=environment: configure(_generated_homeserver(), environment)) for environment in mismatched):
            problems.append("Synapse must refuse a topology the Compose files do not run")
        return problems

    for label, call in (
        ("database", database), ("federation", federation), ("room policy", policy),
        ("rate limits", rate_limits), ("accounts", accounts), ("sign-in", sign_in),
        ("topologies", topologies),
    ):
        guarded(label, call)
    return errors


# packages/create-kodera ships a copy of this stack's Compose assets. The copy is derived, never
# edited: the only difference admitted is the path of the source checkout, because a generated
# directory sits outside it. `packages/create-kodera/sync-assets.mjs` holds the same manifest.
SCAFFOLDER_DIR = ROOT / "packages" / "create-kodera"
SCAFFOLDER_MANIFEST: dict = {
    "source": "deploy/community",
    "files": [".env.example", "Caddyfile", "configure_synapse.py", "docker-compose.yml", "livekit.yaml"],
    "rewrites": {
        "docker-compose.yml": [["../..", "${KODERA_SOURCE_DIR:?Set the Community source checkout}"]],
    },
}


def derive_scaffolder_asset(name: str, source: str) -> str:
    for old, new in SCAFFOLDER_MANIFEST["rewrites"].get(name, []):
        source = source.replace(old, new)
    return source


def check_scaffolder_parity(manifest: object, sources: dict[str, str], assets: dict[str, str]) -> list[str]:
    """Every way packages/create-kodera/assets differs from deploy/community, by name."""
    errors: list[str] = []
    if manifest != SCAFFOLDER_MANIFEST:
        errors.append("packages/create-kodera/assets.manifest.json is not the reviewed manifest")
    for name in SCAFFOLDER_MANIFEST["files"]:
        if name not in sources:
            errors.append(f"deploy/community/{name} is missing")
        elif name not in assets:
            errors.append(f"create-kodera asset is missing: {name}")
        elif assets[name] != derive_scaffolder_asset(name, sources[name]):
            errors.append(f"create-kodera asset drifted from deploy/community: {name}")
    for name in sorted(assets):
        if name not in SCAFFOLDER_MANIFEST["files"]:
            errors.append(f"create-kodera asset has no source in deploy/community: {name}")
    return errors


def path_problem(path: Path, root: Path = ROOT) -> str | None:
    """Why a path may not be read, or None. A file is read only when it is a regular file whose
    real path is the root's real path joined with its relative path: no component of the path,
    the last one or any directory above it, may be a symbolic link. A path outside `root` is
    the caller's own (an operator checking a copy); its directory is then taken as the root.
    """
    absolute = Path(os.path.abspath(path))
    base = Path(os.path.abspath(root))
    try:
        relative = absolute.relative_to(base)
    except ValueError:
        base, relative = absolute.parent, Path(absolute.name)
    try:
        mode = os.lstat(absolute).st_mode
    except OSError:
        return "missing"
    if stat.S_ISLNK(mode):
        return "a symbolic link"
    if os.path.realpath(absolute) != os.path.join(os.path.realpath(base), relative):
        return "reached through a symbolic link"
    if not stat.S_ISREG(mode) and not stat.S_ISDIR(mode):
        return "not a regular file"
    return None


def read_regular_file(path: Path, root: Path = ROOT) -> str | None:
    """The text of a regular file inside `root`, or None. No symbolic link is followed, in the
    file's own name or in any directory leading to it: a link could make the gate read, and
    quote in its messages, a file outside the repository."""
    if path_problem(path, root) is not None:
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        return None
    with os.fdopen(descriptor, "rb") as stream:
        try:
            return stream.read().decode("utf-8")
        except UnicodeDecodeError:
            return None


def read_scaffolder_state(root: Path = ROOT) -> tuple[object, dict[str, str], dict[str, str], list[str]]:
    """The manifest, the sources, the assets, and every entry that is not a regular file reached
    without a symbolic link."""
    refused: list[str] = []

    def texts(paths: list[Path], label: str) -> dict[str, str]:
        found: dict[str, str] = {}
        for path in paths:
            problem = path_problem(path, root)
            if problem == "missing":
                continue
            if problem is not None:
                refused.append(f"{label} is {problem}, which the gate does not follow: {path.name}")
                continue
            text = read_regular_file(path, root)
            if text is None:
                refused.append(f"{label} is not a regular UTF-8 file: {path.name}")
            else:
                found[path.name] = text
        return found

    scaffolder = root / "packages" / "create-kodera"
    manifest = None
    manifest_problem = path_problem(scaffolder / "assets.manifest.json", root)
    if manifest_problem not in (None, "missing"):
        refused.append(f"create-kodera manifest is {manifest_problem}, which the gate does not follow: assets.manifest.json")
    else:
        manifest_text = read_regular_file(scaffolder / "assets.manifest.json", root)
        try:
            manifest = json.loads(manifest_text) if manifest_text is not None else None
        except ValueError:
            manifest = None
    sources = texts([root / "deploy" / "community" / name for name in SCAFFOLDER_MANIFEST["files"]], "deploy/community file")
    assets_dir = scaffolder / "assets"
    directory_problem = path_problem(assets_dir, root)
    if directory_problem is not None:
        # The directory is not listed at all: a listing through a link names files elsewhere.
        refused.append(f"create-kodera assets directory is {directory_problem}, which the gate does not follow")
        return manifest, sources, {}, refused
    assets = texts(sorted(assets_dir.iterdir()) if assets_dir.is_dir() else [], "create-kodera asset")
    return manifest, sources, assets, refused


def run_scaffolder_selftest() -> int:
    manifest, sources, assets, refused = read_scaffolder_state()
    baseline = refused + check_scaffolder_parity(manifest, sources, assets)
    if baseline:
        for error in baseline:
            print(f"[FAIL] baseline scaffolder parity invalid: {error}", file=sys.stderr)
        return 1
    widened = copy.deepcopy(SCAFFOLDER_MANIFEST)
    widened["rewrites"]["Caddyfile"] = [["/api/* /health/*", "/api/* /health/* /agent/*"]]
    cases: list[tuple[str, object, dict[str, str], str]] = [
        ("the scaffolder routes the agent API again", manifest,
         dict(assets, Caddyfile=assets["Caddyfile"].replace("/api/* /health/*", "/api/* /health/* /agent/*")),
         "create-kodera asset drifted from deploy/community: Caddyfile"),
        ("the scaffolder keeps Synapse on SQLite", manifest,
         {**assets, "docker-compose.yml": assets["docker-compose.yml"].replace("  synapse-db:\n", "  synapse-cache:\n")},
         "create-kodera asset drifted from deploy/community: docker-compose.yml"),
        ("the scaffolder edits the Synapse configuration", manifest,
         {**assets, "configure_synapse.py": assets["configure_synapse.py"].replace('"psycopg2"', '"sqlite3"')},
         "create-kodera asset drifted from deploy/community: configure_synapse.py"),
        ("the scaffolder ships a default secret", manifest,
         {**assets, ".env.example": assets[".env.example"].replace("SYNAPSE_POSTGRES_PASSWORD=CHANGE_ME_", "SYNAPSE_POSTGRES_PASSWORD=synapse_")},
         "create-kodera asset drifted from deploy/community: .env.example"),
        ("an asset is deleted", manifest, {name: text for name, text in assets.items() if name != "livekit.yaml"},
         "create-kodera asset is missing: livekit.yaml"),
        ("an asset has no source", manifest, {**assets, "override.yml": "services: {}\n"},
         "create-kodera asset has no source in deploy/community: override.yml"),
        ("the manifest hides a difference", widened, assets,
         "packages/create-kodera/assets.manifest.json is not the reviewed manifest"),
        ("the manifest is unreadable", None, assets,
         "packages/create-kodera/assets.manifest.json is not the reviewed manifest"),
    ]
    for label, case_manifest, case_assets, expected in cases:
        if case_manifest == manifest and case_assets == assets:
            print(f"[FAIL] scaffolder mutation '{label}' produced no change", file=sys.stderr)
            return 1
        if expected not in check_scaffolder_parity(case_manifest, sources, case_assets):
            print(f"[FAIL] scaffolder mutation '{label}' did not trigger '{expected}'", file=sys.stderr)
            return 1
    # A symbolic link is refused by name, wherever it sits on the path, and nothing it leads to
    # is read or quoted: not the last component, and not a directory above it.
    marker = "OUTSIDE-FILE-CONTENT-MUST-NOT-BE-READ"
    link_cases = 0
    with tempfile.TemporaryDirectory(prefix="community-deploy-selftest-") as tmp:
        outside = Path(tmp) / "outside.txt"
        outside.write_text(f"@api path /agent/* {marker}\n", encoding="utf-8")

        def populate(base: Path, poisoned: bool) -> None:
            """A valid tree, or the same tree outside the repository carrying the marker."""
            (base / "deploy" / "community").mkdir(parents=True)
            (base / "packages" / "create-kodera" / "assets").mkdir(parents=True)
            (base / "packages" / "create-kodera" / "assets.manifest.json").write_text(json.dumps(SCAFFOLDER_MANIFEST), encoding="utf-8")
            for name, text in sources.items():
                text = text + (f"\n# {marker}\n" if poisoned else "")
                (base / "deploy" / "community" / name).write_text(text, encoding="utf-8")
                (base / "packages" / "create-kodera" / "assets" / name).write_text(derive_scaffolder_asset(name, text), encoding="utf-8")

        elsewhere = Path(tmp) / "elsewhere"
        populate(elsewhere, poisoned=True)

        def judged(fixture: Path) -> tuple[list[str], str]:
            state = read_scaffolder_state(fixture)
            return state[3] + check_scaffolder_parity(*state[:3]), json.dumps(state[0]) + "".join(state[1].values()) + "".join(state[2].values())

        fixture = Path(tmp) / "repository"
        populate(fixture, poisoned=False)
        if judged(fixture)[0]:
            print("[FAIL] scaffolder fixture must pass before a link is planted", file=sys.stderr)
            return 1
        # The elsewhere tree is self-consistent: a gate that followed a linked directory into it
        # would find matching assets and pass. It must refuse the link instead.
        if judged(elsewhere)[0]:
            print("[FAIL] the outside tree must be valid on its own, or the link cases prove nothing", file=sys.stderr)
            return 1
        planted: tuple[tuple[str, str, str], ...] = (
            ("packages/create-kodera/assets/Caddyfile", "file", "create-kodera asset is a symbolic link, which the gate does not follow: Caddyfile"),
            ("deploy/community/Caddyfile", "file", "deploy/community file is a symbolic link, which the gate does not follow: Caddyfile"),
            ("packages/create-kodera/assets.manifest.json", "file", "create-kodera manifest is a symbolic link, which the gate does not follow: assets.manifest.json"),
            ("packages/create-kodera/assets", "directory", "create-kodera assets directory is a symbolic link, which the gate does not follow"),
            ("deploy/community", "directory", "deploy/community file is reached through a symbolic link, which the gate does not follow: Caddyfile"),
            ("deploy", "directory", "deploy/community file is reached through a symbolic link, which the gate does not follow: docker-compose.yml"),
            ("packages/create-kodera", "directory", "create-kodera assets directory is reached through a symbolic link, which the gate does not follow"),
            ("packages", "directory", "create-kodera manifest is reached through a symbolic link, which the gate does not follow: assets.manifest.json"),
        )
        for relative, kind, expected in planted:
            link = fixture / relative
            aside = fixture / (relative.replace("/", "_") + ".aside")
            link.rename(aside)
            link.symlink_to(outside if kind == "file" else elsewhere / relative, target_is_directory=kind == "directory")
            got, loaded = judged(fixture)
            link.unlink()
            aside.rename(link)
            if expected not in got or any(marker in error for error in got) or marker in loaded:
                print(f"[FAIL] a symbolic link at {relative} was followed or not refused by name: {expected} (got {got})", file=sys.stderr)
                return 1
            link_cases += 1
        if judged(fixture)[0]:
            print("[FAIL] scaffolder fixture must pass again once every link is removed", file=sys.stderr)
            return 1
        if read_regular_file(outside) is None or read_regular_file(fixture / "deploy", fixture) is not None:
            print("[FAIL] read_regular_file must read a regular file and nothing else", file=sys.stderr)
            return 1
        direct = (
            ("link-to-outside", "link-to-outside", outside, False),
            ("linked-directory", "linked-directory/deploy/community/Caddyfile", elsewhere, True),
        )
        for name, read_as, target, is_directory in direct:
            (fixture / name).symlink_to(target, target_is_directory=is_directory)
            if read_regular_file(fixture / read_as, fixture) is not None or path_problem(fixture / read_as, fixture) is None:
                print(f"[FAIL] read_regular_file followed a symbolic link: {read_as}", file=sys.stderr)
                return 1
            link_cases += 1
    print(f"OK: create-kodera assets match deploy/community, {len(cases)} drift mutations and {link_cases} symbolic links refused by name.")
    return 0


def _deployable_issuer(issuer: object) -> bool:
    if not isinstance(issuer, str) or not issuer.startswith("https://"):
        return False
    host = issuer[len("https://") :].split("/", 1)[0].split(":", 1)[0].lower()
    return host not in {"", "localhost", "127.0.0.1", "::1", "[::1]"}


def _base64url_32_bytes(value: str) -> bool:
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}=?", value):
        return False
    try:
        return len(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))) == 32
    except (binascii.Error, ValueError):
        return False


def preflight_env(env_example_text: str, env_text: str) -> list[str]:
    """Check an operator's .env against .env.example. Names keys, never values."""
    example, _ = parse_env_example(env_example_text)
    actual, parse_errors = parse_env_example(env_text)
    community_enabled = bool(actual.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "").strip("'\""))
    errors = [err.replace(".env.example", ".env").split(":", 1)[0] + ": malformed or duplicate" for err in parse_errors]
    synapse_issuer = actual.get(SYNAPSE_OIDC_ISSUER_ENV_NAME, "").strip("'\"")
    synapse_secret = actual.get(SYNAPSE_OIDC_ENV_NAME, "").strip("'\"")
    for key in example:
        if key in ("KODERA_STAFF_ISSUER", FEDERATION_ENV_NAME, SYNAPSE_OIDC_ISSUER_ENV_NAME, TOPOLOGY_ENV_NAME) and not actual.get(key, "").strip("'\""):
            continue  # An .env written before the topology setting existed runs the single topology.
        if key == SYNAPSE_OIDC_ENV_NAME and not community_enabled and synapse_issuer:
            pass  # An isolated self-host may sign members in to Synapse with its own realm.
        elif key in (*COMMUNITY_KEYS, *AGENT_ENV_NAMES, SYNAPSE_OIDC_ENV_NAME) and not community_enabled:
            if actual.get(key, "").strip("'\""):
                errors.append(
                    f"{SYNAPSE_OIDC_ENV_NAME} requires {SYNAPSE_OIDC_ISSUER_ENV_NAME} or the canonical Community workspace"
                    if key == SYNAPSE_OIDC_ENV_NAME
                    else "Community issuer and owner require KODERA_DEFAULT_COMMUNITY_ORG_SLUG"
                )
            continue
        value = actual.get(key, "").strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if not value:
            errors.append(f"{key} is not set")
        elif "CHANGE_ME_" in value:
            errors.append(f"{key} still holds a CHANGE_ME_ placeholder")
        elif "BASE64URL_32" in example.get(key, "") and not _base64url_32_bytes(value):
            # The collaboration server and the seal keys refuse to start on any other length.
            errors.append(f"{key} must be 32 random bytes in URL-safe base64")
        elif key == "KODERA_AUTH_TRUST":
            try:
                entries = json.loads(value)
            except ValueError:
                errors.append("KODERA_AUTH_TRUST is not a JSON list")
                continue
            if not isinstance(entries, list) or not entries:
                errors.append("KODERA_AUTH_TRUST must list at least one issuer")
                continue
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict) or entry.get("lane") not in {"customer", "staff"}:
                    errors.append(f"KODERA_AUTH_TRUST entry {index} has no customer or staff lane")
                elif not _deployable_issuer(entry.get("issuer")):
                    errors.append(f"KODERA_AUTH_TRUST entry {index} issuer is not a public https URL")
        elif key == "KODERA_OIDC_PROVIDER_ORIGIN" and not _deployable_issuer(value):
            errors.append("KODERA_OIDC_PROVIDER_ORIGIN is not a public https origin")
        elif key == FEDERATION_ENV_NAME and not all(
            PUBLIC_SERVER_NAME_RE.fullmatch(name.strip())
            and not name.strip().endswith((".local", ".localhost", ".internal"))
            for name in value.split(",")
        ):
            errors.append(f"{FEDERATION_ENV_NAME} must list public server names, comma-separated, with no wildcard")
    if synapse_issuer:
        try:
            trust_entries = json.loads(actual.get("KODERA_AUTH_TRUST", "").strip("'\""))
            trusted = isinstance(trust_entries, list) and any(
                isinstance(entry, dict) and entry.get("lane") == "customer" and entry.get("issuer") == synapse_issuer
                for entry in trust_entries
            )
        except ValueError:
            trusted = False
        if not _deployable_issuer(synapse_issuer) or not trusted:
            errors.append(f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} must be a public https issuer admitted on the customer trust lane")
        if not synapse_secret:
            errors.append(f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} requires the issued {SYNAPSE_OIDC_ENV_NAME}")
        if community_enabled and synapse_issuer != actual.get(COMMUNITY_KEYS[1], "").strip("'\""):
            errors.append(f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} must be empty or the canonical Community issuer")
    if community_enabled:
        slug = actual.get(COMMUNITY_KEYS[0], "").strip("'\"")
        issuer = actual.get(COMMUNITY_KEYS[1], "").strip("'\"")
        if slug != "community":
            errors.append("KODERA_DEFAULT_COMMUNITY_ORG_SLUG must be community")
        if actual.get("KODERA_DOMAIN", "").strip("'\"") != "community." + actual.get("KODERA_MATRIX_DOMAIN", "").strip("'\""):
            errors.append("KODERA_DOMAIN must match community.KODERA_MATRIX_DOMAIN")
        if not _deployable_issuer(issuer) or not issuer.endswith("/realms/community"):
            errors.append("KODERA_DEFAULT_COMMUNITY_ISSUER must name the public Community realm")
        try:
            uuid.UUID(actual.get(COMMUNITY_KEYS[2], "").strip("'\""))
        except ValueError:
            errors.append("KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID must be an existing user UUID")
        try:
            trust = json.loads(actual.get("KODERA_AUTH_TRUST", "").strip("'\""))
            admitted = isinstance(trust, list) and any(
                isinstance(entry, dict) and entry.get("lane") == "customer" and entry.get("issuer") == issuer
                for entry in trust
            )
        except ValueError:
            admitted = False
        if not admitted:
            errors.append("KODERA_DEFAULT_COMMUNITY_ISSUER must be admitted on the customer trust lane")
    topology = actual.get(TOPOLOGY_ENV_NAME, "").strip("'\"") or "single"
    if topology not in TOPOLOGIES:
        errors.append(f"{TOPOLOGY_ENV_NAME} must be single or split")
    elif topology == "split":
        base = actual.get("KODERA_MATRIX_DOMAIN", "").strip("'\"")
        host = actual.get("KODERA_DOMAIN", "").strip("'\"")
        if not base or not host.endswith("." + base):
            errors.append("KODERA_DOMAIN must be a subdomain of KODERA_MATRIX_DOMAIN in the split topology")
        if actual.get("DJANGO_ALLOWED_HOSTS", "").strip("'\"") != f"api.{base},127.0.0.1":
            errors.append("DJANGO_ALLOWED_HOSTS must be api.<KODERA_MATRIX_DOMAIN>,127.0.0.1 in the split topology")
    staff = actual.get("KODERA_STAFF_ISSUER", "").strip("'\"")
    if staff:
        try:
            entries = json.loads(actual.get("KODERA_AUTH_TRUST", "").strip("'\""))
            admitted_staff = isinstance(entries, list) and any(
                isinstance(entry, dict) and entry.get("lane") == "staff" and entry.get("issuer") == staff
                for entry in entries
            )
        except ValueError:
            admitted_staff = False
        if not _deployable_issuer(staff) or not staff.endswith("/realms/kodera-staff") or not admitted_staff:
            errors.append("KODERA_STAFF_ISSUER must name the exact trusted staff realm")
    return errors


MutationFn = Callable[[str, str, str], tuple[str, str, str]]


def run_selftest(compose_text: str, env_text: str, caddyfile_text: str) -> int:
    baseline_errors = check_community_deploy(compose_text, env_text, caddyfile_text)
    if baseline_errors:
        for err in baseline_errors:
            print(f"[FAIL] baseline community deploy invalid: {err}", file=sys.stderr)
        return 1

    mutations: list[tuple[str, MutationFn, str]] = [
        (
            "Caddy waits for the web client the split topology does not start",
            lambda c, e, cf: (c.replace("    depends_on:\n      server:\n        condition: service_healthy\n      room-access:",
                                        "    depends_on:\n      web:\n        condition: service_started\n      server:\n        condition: service_healthy\n      room-access:", 1), e, cf),
            "service 'caddy' must not wait for 'web': the split topology does not start the web client",
        ),
        (
            "the LiveKit media range is narrower than the firewall range",
            lambda c, e, cf: (c.replace('"50000-50200:50000-50200/udp"', '"50000-50060:50000-50060/udp"', 1), e, cf),
            "service 'livekit' must publish exactly the media ports of livekit.yaml: 7881:7881, 50000-50200:50000-50200/udp",
        ),
        (
            "LiveKit publishes its signalling port around Caddy",
            lambda c, e, cf: (c.replace('      - "7881:7881"\n', '      - "7881:7881"\n      - "7880:7880"\n', 1), e, cf),
            "service 'livekit' must publish exactly the media ports of livekit.yaml",
        ),
        (
            "LiveKit drops its TCP media fallback",
            lambda c, e, cf: (c.replace('      - "7881:7881"\n', '', 1), e, cf),
            "service 'livekit' must publish exactly the media ports of livekit.yaml",
        ),
        (
            "Synapse is not told which Compose files run",
            lambda c, e, cf: (c.replace(f"      {COMPOSE_TOPOLOGY_ENV_NAME}: single\n", "", 1), e, cf),
            f"service 'synapse' must set {COMPOSE_TOPOLOGY_ENV_NAME}: single",
        ),
        (
            "the base Compose file claims the split topology",
            lambda c, e, cf: (c.replace(f"      {COMPOSE_TOPOLOGY_ENV_NAME}: single\n", f"      {COMPOSE_TOPOLOGY_ENV_NAME}: split\n", 1), e, cf),
            f"service 'synapse' must set {COMPOSE_TOPOLOGY_ENV_NAME}: single",
        ),
        (
            "Synapse ignores the operator's topology",
            lambda c, e, cf: (c.replace(f"      {TOPOLOGY_ENV_NAME}: ${{{TOPOLOGY_ENV_NAME}:-single}}\n", "", 1), e, cf),
            f"service 'synapse' must consume {TOPOLOGY_ENV_NAME} with the default 'single'",
        ),
        (
            "the template defaults to the split topology",
            lambda c, e, cf: (c, e.replace(f"{TOPOLOGY_ENV_NAME}=single", f"{TOPOLOGY_ENV_NAME}=split", 1), cf),
            f".env.example must default {TOPOLOGY_ENV_NAME} to 'single'",
        ),
        (
            "leak LIVEKIT_API_SECRET into server environment",
            lambda c, e, cf: (
                c.replace(
                    "      KODERA_EDITION: community\n",
                    "      KODERA_EDITION: community\n      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}\n",
                    1,
                ),
                e,
                cf,
            ),
            "ADR-0003 isolation violation: forbidden secret 'LIVEKIT_API_SECRET' in service 'server'",
        ),
        (
            "leak ROOM_ACCESS_MATRIX_TOKEN into migrate environment",
            lambda c, e, cf: (
                c.replace(
                    "      KODERA_BILLING_ENABLED: \"false\"\n",
                    "      KODERA_BILLING_ENABLED: \"false\"\n      ROOM_ACCESS_MATRIX_TOKEN: ${ROOM_ACCESS_MATRIX_TOKEN}\n",
                    1,
                ),
                e,
                cf,
            ),
            "ADR-0003 isolation violation: forbidden secret 'ROOM_ACCESS_MATRIX_TOKEN' in service 'migrate'",
        ),
        (
            "remove KODERA_BILLING_ENABLED false on server",
            lambda c, e, cf: (
                c.replace(
                    '      KODERA_EDITION: community\n      KODERA_BILLING_ENABLED: "false"',
                    '      KODERA_EDITION: community\n      KODERA_BILLING_ENABLED: "true"',
                    1,
                ),
                e,
                cf,
            ),
            'service \'server\' must set KODERA_BILLING_ENABLED to \'"false"\'',
        ),
        (
            "change KODERA_EDITION on server to enterprise",
            lambda c, e, cf: (
                c.replace(
                    "      KODERA_EDITION: community",
                    "      KODERA_EDITION: enterprise",
                    1,
                ),
                e,
                cf,
            ),
            "service 'server' must set KODERA_EDITION to 'community'",
        ),
        (
            "weaken server dependency on migrate completion",
            lambda c, e, cf: (
                c.replace(
                    "      migrate:\n        condition: service_completed_successfully",
                    "      migrate:\n        condition: service_started",
                    1,
                ),
                e,
                cf,
            ),
            "service 'server' must depend on 'migrate' with condition 'service_completed_successfully'",
        ),
        (
            "change migrate restart policy from no",
            lambda c, e, cf: (
                c.replace(
                    '    restart: "no"',
                    "    restart: always",
                    1,
                ),
                e,
                cf,
            ),
            'service \'migrate\' must set restart: "no"',
        ),
        (
            "change migrate dockerfile from Dockerfile.migrator",
            lambda c, e, cf: (
                c.replace(
                    "      dockerfile: Dockerfile.migrator",
                    "      dockerfile: Dockerfile",
                    1,
                ),
                e,
                cf,
            ),
            "service 'migrate' must build from 'Dockerfile.migrator'",
        ),
        (
            "remove healthcheck from server",
            lambda c, e, cf: (
                c.replace(
                    "    healthcheck:\n      test: [\"CMD-SHELL\", \"python -c \\\"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/live')\\\"\"]",
                    "    # healthcheck removed",
                    1,
                ),
                e,
                cf,
            ),
            "service 'server' must define a healthcheck block",
        ),
        (
            "remove required variable from .env.example",
            lambda c, e, cf: (
                c,
                re.sub(r"(?m)^KODERA_CONTACT_SEAL_KEY=.*\n?", "", e, count=1),
                cf,
            ),
            "missing variable in .env.example: KODERA_CONTACT_SEAL_KEY",
        ),
        (
            "non-placeholder secret in .env.example",
            lambda c, e, cf: (
                c,
                re.sub(
                    r"(?m)^DJANGO_SECRET_KEY=.*$",
                    "DJANGO_SECRET_KEY=real_production_secret_key_value_not_placeholder",
                    e,
                    count=1,
                ),
                cf,
            ),
            "non-placeholder secret value in .env.example for DJANGO_SECRET_KEY",
        ),
        (
            "remove KODERA_DOMAIN from caddy service",
            lambda c, e, cf: (
                c.replace(
                    "      KODERA_DOMAIN: ${KODERA_DOMAIN:-chat.example.org}\n",
                    "",
                    1,
                ),
                e,
                cf,
            ),
            "service 'caddy' must consume public config key 'KODERA_DOMAIN'",
        ),
        (
            "unpin the synapse image digest",
            lambda c, e, cf: (re.sub(r"(image: matrixdotorg/synapse:[^@\s]+)@sha256:[0-9a-f]{64}", r"\1", c, count=1), e, cf),
            "service 'synapse' image must be pinned as name:tag@sha256:<digest>",
        ),
        (
            "drop the memory limit of livekit",
            lambda c, e, cf: (re.sub(r"(?m)^(  livekit:\n(?:    .*\n|      .*\n)*?)    mem_limit: [^\n]*\n", r"\1", c, count=1), e, cf),
            "service 'livekit' must set mem_limit",
        ),
        (
            "server stops requiring KODERA_AUTH_TRUST",
            lambda c, e, cf: (re.sub(r"(?m)^      KODERA_AUTH_TRUST: .*\n", "", c), e, cf),
            "service 'server' must require KODERA_AUTH_TRUST",
        ),
        (
            "web signs in at the stack's own domain",
            lambda c, e, cf: (
                c.replace(
                    "VITE_KEYCLOAK_URL: ${KODERA_OIDC_PROVIDER_ORIGIN:?",
                    "VITE_KEYCLOAK_URL: https://${KODERA_DOMAIN:-chat.example.org}  # ${KODERA_OIDC_PROVIDER_ORIGIN:?",
                    1,
                ),
                e,
                cf,
            ),
            "service 'web' must build VITE_KEYCLOAK_URL from KODERA_OIDC_PROVIDER_ORIGIN",
        ),
        (
            "KODERA_AUTH_TRUST gets a default in .env.example",
            lambda c, e, cf: (c, re.sub(r"(?m)^KODERA_AUTH_TRUST=.*$", "KODERA_AUTH_TRUST=[]", e, count=1), cf),
            "KODERA_AUTH_TRUST in .env.example must be a CHANGE_ME_ placeholder",
        ),
    ]

    # The gate refuses what it cannot follow. Each construct below would otherwise get past a
    # reader that matches lines: a different quoting, an inline form, an indirection, another file.
    synapse_head = "  synapse:\n    mem_limit: 1g\n"
    server_edition = "      KODERA_EDITION: community\n"
    site_open = "{$KODERA_DOMAIN} {\n"
    api_matcher = "\t@api path /api/* /health/*\n"
    api_proxy = "\t\treverse_proxy server:8000 {\n\t\t\timport client_address\n\t\t}\n"
    shadow_site = (
        "admin.example.org {\n\t@api path /agent/*\n\thandle @api {\n"
        "\t\treverse_proxy server:8000 {\n\t\t\timport client_address\n\t\t}\n\t}\n}\n\n"
    )

    def compose_case(label: str, old: str, new: str, expected: str) -> tuple[str, MutationFn, str]:
        return (label, lambda c, e, cf: (c.replace(old, new, 1), e, cf), expected)

    def caddy_case(label: str, old: str, new: str, expected: str) -> tuple[str, MutationFn, str]:
        return (label, lambda c, e, cf: (c, e, cf.replace(old, new, 1)), expected)

    mutations += [
        compose_case("host networking, quoted", synapse_head, synapse_head + '    network_mode: "host"\n',
                     "service 'synapse' must not publish a port: network_mode is refused"),
        compose_case("host networking through another service", synapse_head, synapse_head + "    network_mode: service:caddy\n",
                     "service 'synapse' must not publish a port: network_mode is refused"),
        compose_case("a port published in inline form", synapse_head, synapse_head + '    ports: ["8008:8008"]\n',
                     "service 'synapse' must not publish a port: it is reached through Caddy only, and its listener believes"),
        compose_case("a port published under a quoted key", synapse_head, synapse_head + '    "ports":\n      - "8008:8008"\n',
                     "service 'synapse' must not publish a port: it is reached through Caddy only, and its listener believes"),
        (
            "a port published through a merge key",
            lambda c, e, cf: (
                c.replace("services:\n", 'x-published: &published\n  ports:\n    - "8008:8008"\n\nservices:\n', 1)
                .replace(synapse_head, synapse_head + "    <<: *published\n", 1), e, cf,
            ),
            "YAML anchors, aliases and merge keys are refused",
        ),
        compose_case("an alias without a merge key", server_edition, server_edition + "      KODERA_EXTRA: *shared\n",
                     "YAML anchors, aliases and merge keys are refused"),
        compose_case("an anchor on a service", "\n  server:\n    mem_limit", "\n  server: &api\n    mem_limit", "YAML anchors, aliases and merge keys are refused"),
        compose_case("an unreviewed extension field", "services:\n", 'x-defaults:\n  restart: always\n\nservices:\n',
                     "unreviewed top-level key 'x-defaults'"),
        compose_case("another Compose file is included", "services:\n", "include:\n  - extra.yml\n\nservices:\n",
                     "unreviewed top-level key 'include'"),
        compose_case("secrets loaded from a file into the API", "  server:\n    mem_limit: 768m\n", "  server:\n    mem_limit: 768m\n    env_file: .env\n",
                     "service 'server' uses an unreviewed key 'env_file'"),
        compose_case("a service extends another file", synapse_head, synapse_head + "    extends:\n      file: extra.yml\n      service: synapse\n",
                     "service 'synapse' uses an unreviewed key 'extends'"),
        compose_case("a privileged service", synapse_head, synapse_head + "    privileged: true\n",
                     "service 'synapse' uses an unreviewed key 'privileged'"),
        compose_case("a service written in flow form", "\n" + synapse_head, '\n  extra: {image: "postgres:17", ports: ["5432:5432"]}\n\n' + synapse_head,
                     "unsupported service definition"),
        compose_case("an environment written in flow form", "    environment:\n" + server_edition, "    environment: {KODERA_EDITION: community}\n",
                     "service 'server' must write 'environment' in block form"),
        compose_case("an environment written as a list", server_edition, server_edition + "      - EXTRA_TOKEN=${EXTRA_TOKEN}\n",
                     "environment must be a mapping of NAME: value"),
        compose_case("a key hidden by odd indentation", synapse_head, synapse_head + '     ports:\n       - "8008:8008"\n',
                     "indentation must be a multiple of two spaces"),
        compose_case("a service whose keys sit one level too deep", "\n" + synapse_head, '\n  extra:\n      image: postgres:17\n      ports:\n        - "5432:5432"\n\n' + synapse_head,
                     "service 'extra' must indent its keys by four spaces"),
        compose_case("a service defined twice", "\n  livekit:\n    mem_limit", '\n  synapse:\n    image: example/other:1\n\n  livekit:\n    mem_limit',
                     "service 'synapse' is defined twice"),
        compose_case("the Docker socket mounted into Synapse", "      - synapse_data:/data\n", "      - synapse_data:/data\n      - /var/run/docker.sock:/var/run/docker.sock\n",
                     "service 'synapse' has an unreviewed bind mount"),
        compose_case("a reviewed mount made writable", "/opt/kodera-policy:ro\n", "/opt/kodera-policy\n",
                     "service 'synapse' has an unreviewed bind mount"),
        compose_case("a volume in long form", "      - synapse_data:/data\n", "      - type: bind\n        source: /\n        target: /host\n",
                     "volumes must be short 'source:target' entries"),
        compose_case("tab indentation", synapse_head, synapse_head + "\tports:\n", "tab indentation is refused"),
        compose_case("an image built from somewhere else", "      context: ../..\n", "      context: https://example.org/other.git\n",
                     "service 'web' builds from an unreviewed context or Dockerfile"),
        compose_case("the API built from another Dockerfile", "      dockerfile: Dockerfile\n    restart: unless-stopped\n    environment:\n      KODERA_EDITION", "      dockerfile: Dockerfile.debug\n    restart: unless-stopped\n    environment:\n      KODERA_EDITION",
                     "service 'server' builds from an unreviewed context or Dockerfile"),
        caddy_case("a second site block shadows a matcher name and exposes the agent API", site_open, shadow_site + site_open,
                   "Caddyfile must not expose the agent API to the internet (got '/agent/*')"),
        caddy_case("a second site block", site_open, shadow_site + site_open, "Caddyfile must hold exactly one site block"),
        caddy_case("a matcher defined twice in one site block", api_matcher, api_matcher + "\t@api path /agent/*\n",
                   "Caddyfile defines the matcher '@api' twice in one site block"),
        caddy_case("a matcher in block form", api_matcher, "\t@api {\n\t\tpath /api/* /health/* /agent/*\n\t}\n",
                   "Caddyfile matcher '@api' must be a single-line path matcher"),
        caddy_case("a matcher that is not a path matcher", api_matcher, "\t@api not path /nothing\n",
                   "Caddyfile matcher '@api' must be a single-line path matcher"),
        caddy_case("a handle with an inline path", "\thandle @api {\n", "\thandle /agent/* {\n",
                   "Caddyfile has an unreviewed block in a site block: 'handle'"),
        caddy_case("directives imported from another file", site_open, site_open + "\timport extra.caddy\n",
                   "Caddyfile import 'extra.caddy' is not a snippet defined in this file"),
        caddy_case("site blocks imported from a directory", site_open, "import sites/*\n\n" + site_open,
                   "Caddyfile import 'sites/*' is not a snippet defined in this file"),
        caddy_case("an unknown snippet imported into an upstream", api_proxy, api_proxy.replace("import client_address", "import client_address\n\t\t\timport upstream_options"),
                   "Caddyfile import 'upstream_options' is not a snippet defined in this file"),
        caddy_case("a file imported inside a handle", "\thandle @api {\n", "\thandle @api {\n\t\timport /etc/caddy/extra\n",
                   "Caddyfile import '/etc/caddy/extra' is not a snippet defined in this file"),
        caddy_case("a snippet imported where it was not reviewed", site_open, site_open + "\timport client_address\n",
                   "Caddyfile imports a snippet outside a reverse_proxy block"),
        caddy_case("an allowed path rewritten onto the agent API", "\thandle @api {\n", "\thandle @api {\n\t\trewrite * /agent/v1/commands\n",
                   "Caddyfile has an unreviewed directive in a handle: 'rewrite'"),
        caddy_case("the reviewed rewrite moved to the API", "\thandle @api {\n", "\thandle @api {\n\t\trewrite * /token\n",
                   "Caddyfile rewrites a path in a handle that is not the reviewed one"),
        caddy_case("a prefix-stripping handle", "\thandle @api {\n" + api_proxy + "\t}\n", "\thandle_path /internal/* {\n" + api_proxy + "\t}\n",
                   "Caddyfile has an unreviewed block in a site block: 'handle_path'"),
        caddy_case("an upstream option that was not reviewed", api_proxy,
                   api_proxy.replace("import client_address", "import client_address\n\t\t\theader_up Host internal.example.org"),
                   "Caddyfile has an unreviewed reverse_proxy option for 'server:8000': 'header_up Host'"),
        caddy_case("the snippet gains a directive", "\theader_up -Forwarded\n", "\theader_up -Forwarded\n\theader_up X-Internal-Token secret\n",
                   "Caddyfile snippet 'client_address' differs from the reviewed one"),
        caddy_case("a security response header is dropped", '\t\tX-Frame-Options "DENY"\n', "",
                   "Caddyfile response headers differ from the reviewed set"),
        caddy_case("Caddy's admin API is opened", "\temail {$KODERA_ACME_EMAIL}\n", "\temail {$KODERA_ACME_EMAIL}\n\tadmin 0.0.0.0:2019\n",
                   "Caddyfile global options differ from the reviewed ones"),
        caddy_case("a directive outside every block", site_open, "debug\n\n" + site_open,
                   "Caddyfile has an unreviewed directive outside every block: 'debug'"),
        caddy_case("an unreviewed directive in the site block", "\tencode zstd gzip\n", "\tencode zstd gzip\n\tfile_server browse\n",
                   "Caddyfile has an unreviewed directive in a site block: 'file_server'"),
        caddy_case("a block left open", "\t\trespond 404\n\t}\n\n\t@api", "\t\trespond 404\n\n\t@api",
                   "Caddyfile leaves a block open"),
    ]

    for guard in (
        "../../packages/synapse-policy:/opt/kodera-policy:ro",
        "--no-index --no-deps --no-build-isolation",
        "PYTHONPATH: /tmp/kodera-policy",
        "python /opt/community/configure_synapse.py /data/homeserver.yaml",
    ):
        mutations.append((
            "remove Synapse policy guard " + guard,
            lambda c, e, cf, guard=guard: (c.replace(guard, "removed-policy-guard", 1), e, cf),
            "missing room-policy guard",
        ))

    for guard in (
        "python manage.py bootstrap_community_workspace --settings config.settings.deploy",
        'if [ -n "$$KODERA_DEFAULT_COMMUNITY_ORG_SLUG" ]; then',
    ):
        mutations.append((
            "remove canonical bootstrap guard " + guard,
            lambda c, e, cf, guard=guard: (c.replace(guard, "removed-bootstrap-guard", 1), e, cf),
            "service 'migrate' must",
        ))
    for key in COMMUNITY_KEYS:
        mutations.append((
            "remove Community bootstrap setting " + key,
            lambda c, e, cf, key=key: (c.replace("      " + key + ": ${" + key + ":-}\n", "", 1), e, cf),
            "service 'migrate' must consume " + key,
        ))
    for key in AGENT_ENV_NAMES:
        mutations.append((
            "leak isolated agent credential " + key,
            lambda c, e, cf, key=key: (c.replace("      KODERA_EDITION: community\n", "      KODERA_EDITION: community\n      " + key + ": ${" + key + "}\n", 1), e, cf),
            "ADR-0003 isolation violation: forbidden secret",
        ))
    mutations.append((
        "agent reconciliation mode removed",
        lambda c, e, cf: (c.replace("KODERA_APPS: matrix", "KODERA_APPS: docs,meet", 1), e, cf),
        "tenant-agent must use Matrix-only reconciliation",
    ))

    # Hardening invariants. Each mutation is refused by the name of the invariant it breaks.
    synthetic_hex = "0123456789abcdef" * 4
    synapse_db_password = "${" + SYNAPSE_DB_ENV_NAME + ":?Set " + SYNAPSE_DB_ENV_NAME + " in .env}"
    mutations += [
        (
            "Synapse falls back to SQLite: its database dependency is removed",
            lambda c, e, cf: (c.replace("    depends_on:\n      synapse-db:\n        condition: service_healthy\n", "", 1), e, cf),
            "Synapse must run on PostgreSQL: service 'synapse' must wait for a healthy 'synapse-db'",
        ),
        (
            "Synapse falls back to SQLite: its database credential is removed",
            lambda c, e, cf: (c.replace("      PGPASSWORD: " + synapse_db_password + "\n", "", 1), e, cf),
            "Synapse must run on PostgreSQL: service 'synapse' must read PGPASSWORD",
        ),
        (
            "Synapse falls back to SQLite: its database service is removed",
            lambda c, e, cf: (c.replace("  synapse-db:\n", "  synapse-cache:\n", 1), e, cf),
            "missing required service 'synapse-db'",
        ),
        (
            "Synapse shares the server's database credential",
            lambda c, e, cf: (c.replace("      PGPASSWORD: " + synapse_db_password, "      PGPASSWORD: ${POSTGRES_PASSWORD:?shared}", 1), e, cf),
            "Synapse must run on PostgreSQL: service 'synapse' must not hold the server's database credential",
        ),
        (
            "Synapse's database loses the C collation",
            lambda c, e, cf: (c.replace(" --lc-collate=C --lc-ctype=C", "", 1), e, cf),
            "Synapse must run on PostgreSQL: service 'synapse-db' must initialise the C collation",
        ),
        (
            "Synapse's database credential reaches the API",
            lambda c, e, cf: (c.replace("      KODERA_EDITION: community\n", "      KODERA_EDITION: community\n      PGPASSWORD: ${" + SYNAPSE_DB_ENV_NAME + "}\n", 1), e, cf),
            f"ADR-0003 isolation violation: forbidden secret '{SYNAPSE_DB_ENV_NAME}' in service 'server'",
        ),
        (
            "federation is open by default: the template ships an allowlist",
            lambda c, e, cf: (c, re.sub(r"(?m)^" + FEDERATION_ENV_NAME + r"=.*$", FEDERATION_ENV_NAME + "=matrix.org", e, count=1), cf),
            "federation must be closed by default: " + FEDERATION_ENV_NAME + " must be empty in .env.example",
        ),
        (
            "federation is open by default: compose defaults the allowlist",
            lambda c, e, cf: (c.replace("${" + FEDERATION_ENV_NAME + ":-}", "${" + FEDERATION_ENV_NAME + ":-matrix.org}", 1), e, cf),
            "federation must be closed by default: service 'synapse' must consume " + FEDERATION_ENV_NAME,
        ),
        (
            "federation is open by default: Caddy routes every Matrix path",
            lambda c, e, cf: (c, e, cf.replace("/_matrix/client/* /_matrix/media/*", "/_matrix/*", 1)),
            "federation must be closed by default: Caddyfile must route only the Matrix client API",
        ),
        (
            "federation is open by default: Caddy routes the federation API",
            lambda c, e, cf: (c, e, cf.replace("/_synapse/client/*\n", "/_synapse/client/* /_matrix/federation/* /_matrix/key/*\n", 1)),
            "never federation, key or admin routes (got '/_matrix/federation/*')",
        ),
        (
            "the Synapse admin API is routed to the internet",
            lambda c, e, cf: (c, e, cf.replace("/_synapse/client/*\n", "/_synapse/client/* /_synapse/admin/*\n", 1)),
            "never federation, key or admin routes (got '/_synapse/admin/*')",
        ),
        (
            "federation is open by default: the federation port is published",
            lambda c, e, cf: (c.replace('      - "7881:7881"\n', '      - "7881:7881"\n      - "8448:8448"\n', 1), e, cf),
            "docker-compose.yml must not publish the federation port 8448",
        ),
        (
            "the agent API is exposed again",
            lambda c, e, cf: (c, e, cf.replace("@api path /api/* /health/*", "@api path /api/* /health/* /agent/*", 1)),
            "Caddyfile must not expose the agent API to the internet (got '/agent/*')",
        ),
        (
            "the agent API is exposed through its own handle",
            lambda c, e, cf: (c, e, cf.replace("\t\trespond 404\n\t}\n\n\t@api", "\t\treverse_proxy server:8000\n\t}\n\n\t@api", 1)),
            "Caddyfile must not expose the agent API to the internet (got '/agent')",
        ),
        (
            "the client address override is removed from the Synapse upstream",
            lambda c, e, cf: (c, e, cf.replace("reverse_proxy synapse:8008 {\n\t\t\timport client_address\n\t\t}", "reverse_proxy synapse:8008", 1)),
            "Caddyfile must overwrite X-Forwarded-For with the peer address for 'synapse:8008'",
        ),
        (
            "the client address override is removed from every upstream",
            lambda c, e, cf: (c, e, cf.replace("\theader_up X-Forwarded-For {remote_host}\n", "", 1)),
            "Caddyfile must overwrite X-Forwarded-For with the peer address for 'server:8000'",
        ),
        (
            "the client's own X-Forwarded-For is passed on",
            lambda c, e, cf: (c, e, cf.replace("header_up X-Forwarded-For {remote_host}", "header_up X-Forwarded-For {header.X-Forwarded-For}", 1)),
            "Caddyfile must overwrite X-Forwarded-For with the peer address for 'synapse:8008'",
        ),
        (
            "the client's X-Forwarded-For is appended to the override",
            lambda c, e, cf: (c, e, cf.replace("\theader_up X-Forwarded-For {remote_host}\n", "\theader_up X-Forwarded-For {remote_host}\n\theader_up +X-Forwarded-For {header.X-Forwarded-For}\n", 1)),
            "Caddyfile must overwrite X-Forwarded-For with the peer address for 'synapse:8008'",
        ),
        (
            "a forged X-Real-IP reaches an upstream",
            lambda c, e, cf: (c, e, cf.replace("\theader_up -X-Real-IP\n", "", 1)),
            "Caddyfile must drop the client-supplied header for 'synapse:8008': 'header_up -X-Real-IP'",
        ),
        (
            "trusted_proxies believes every address",
            lambda c, e, cf: (c, e, cf.replace("\temail {$KODERA_ACME_EMAIL}\n", "\temail {$KODERA_ACME_EMAIL}\n\tservers {\n\t\ttrusted_proxies static 0.0.0.0/0\n\t}\n", 1)),
            "Caddyfile must not declare trusted_proxies",
        ),
        (
            "trusted_proxies believes a private range",
            lambda c, e, cf: (c, e, cf.replace("\temail {$KODERA_ACME_EMAIL}\n", "\temail {$KODERA_ACME_EMAIL}\n\tservers {\n\t\ttrusted_proxies static private_ranges\n\t}\n", 1)),
            "Caddyfile must not declare trusted_proxies",
        ),
        (
            "trusted_proxies is set on one upstream",
            lambda c, e, cf: (c, e, cf.replace("\theader_up -Forwarded\n", "\theader_up -Forwarded\n\ttrusted_proxies 10.0.0.0/8\n", 1)),
            "Caddyfile must not declare trusted_proxies",
        ),
        (
            "the Synapse port is published on the host",
            lambda c, e, cf: (c.replace("      PYTHONPATH: /tmp/kodera-policy\n", "      PYTHONPATH: /tmp/kodera-policy\n    ports:\n      - \"8008:8008\"\n", 1), e, cf),
            "service 'synapse' must not publish a port: it is reached through Caddy only, and its listener believes the address Caddy forwards",
        ),
        (
            "Synapse joins the host network",
            lambda c, e, cf: (c.replace("  synapse:\n    mem_limit: 1g\n", "  synapse:\n    mem_limit: 1g\n    network_mode: host\n", 1), e, cf),
            "service 'synapse' must not publish a port",
        ),
        (
            "the API port is published on the host",
            lambda c, e, cf: (c.replace("      KODERA_EDITION: community\n", "      KODERA_EDITION: community\n    ports:\n      - \"8000:8000\"\n", 1), e, cf),
            "service 'server' must not publish a port",
        ),
        (
            "an unreviewed route reaches the API",
            lambda c, e, cf: (c, e, cf.replace("@api path /api/* /health/*", "@api path /api/* /health/* /admin/*", 1)),
            "Caddyfile exposes an unreviewed route to 'server:8000': '/admin/*'",
        ),
        (
            "the catch-all proxies to the API",
            lambda c, e, cf: (c, e, cf.replace("reverse_proxy web:8080", "reverse_proxy server:8000", 1)),
            "Caddyfile catch-all must proxy to 'web:8080' only",
        ),
        (
            "a secret-looking default under an innocent name",
            lambda c, e, cf: (c, re.sub(r"(?m)^KODERA_OIDC_CLIENT_ID=.*$", "KODERA_OIDC_CLIENT_ID=" + synthetic_hex, e, count=1), cf),
            "secret-looking default in .env.example for KODERA_OIDC_CLIENT_ID",
        ),
        (
            "a secret default in the compose file",
            lambda c, e, cf: (c.replace("      POSTGRES_PASSWORD: " + synapse_db_password, "      POSTGRES_PASSWORD: ${" + SYNAPSE_DB_ENV_NAME + ":-synapse}", 1), e, cf),
            f"secret default in docker-compose.yml for {SYNAPSE_DB_ENV_NAME}",
        ),
        (
            "a literal secret in the compose file",
            lambda c, e, cf: (c.replace("      POSTGRES_PASSWORD: " + synapse_db_password, "      POSTGRES_PASSWORD: synapse", 1), e, cf),
            "literal secret in docker-compose.yml: service 'synapse-db' sets POSTGRES_PASSWORD",
        ),
        (
            "the Synapse database password becomes a readable default",
            lambda c, e, cf: (c, re.sub(r"(?m)^" + SYNAPSE_DB_ENV_NAME + r"=.*$", SYNAPSE_DB_ENV_NAME + "=synapse", e, count=1), cf),
            f"non-placeholder secret value in .env.example for {SYNAPSE_DB_ENV_NAME}",
        ),
    ]

    preflight_cases: list[tuple[str, Callable[[str], str], str]] = [
        ("a placeholder is left", lambda env: env, "DJANGO_SECRET_KEY still holds a CHANGE_ME_ placeholder"),
        ("a key is missing", lambda env: re.sub(r"(?m)^LIVEKIT_API_SECRET=.*\n?", "", env), "LIVEKIT_API_SECRET is not set"),
        ("the trust is not JSON", lambda env: re.sub(r"(?m)^KODERA_AUTH_TRUST=.*$", "KODERA_AUTH_TRUST=keycloak", env), "KODERA_AUTH_TRUST is not a JSON list"),
        ("the trust is empty", lambda env: re.sub(r"(?m)^KODERA_AUTH_TRUST=.*$", "KODERA_AUTH_TRUST='[]'", env), "KODERA_AUTH_TRUST must list at least one issuer"),
        (
            "the issuer is loopback",
            lambda env: env.replace("https://id.example.net/realms/acme", "http://localhost:8080/realms/acme"),
            "KODERA_AUTH_TRUST entry 0 issuer is not a public https URL",
        ),
        (
            "the collaboration key is hex, not 32 bytes of base64url",
            lambda env: re.sub(r"(?m)^KODERA_COLLAB_TICKET_KEY=.*$", "KODERA_COLLAB_TICKET_KEY=" + "ab" * 32, env),
            "KODERA_COLLAB_TICKET_KEY must be 32 random bytes in URL-safe base64",
        ),
        (
            "a seal key is too short",
            lambda env: re.sub(r"(?m)^KODERA_CONTACT_SEAL_KEY=.*$", "KODERA_CONTACT_SEAL_KEY=" + base64.urlsafe_b64encode(bytes(16)).decode(), env),
            "KODERA_CONTACT_SEAL_KEY must be 32 random bytes in URL-safe base64",
        ),
        (
            "the provider origin is plain http",
            lambda env: re.sub(r"(?m)^KODERA_OIDC_PROVIDER_ORIGIN=.*$", "KODERA_OIDC_PROVIDER_ORIGIN=http://id.example.net", env),
            "KODERA_OIDC_PROVIDER_ORIGIN is not a public https origin",
        ),
    ]
    trust = '[{"lane":"customer","issuer":"https://id.example.net/realms/acme","generation":"g1","expires_at":4102444800,"public_jwks":{"keys":[]}}]'
    filled = "\n".join(
        f"{key}='{trust}'" if key == "KODERA_AUTH_TRUST"
        else f"{key}=https://id.example.net" if key == "KODERA_OIDC_PROVIDER_ORIGIN"
        else f"{key}=" if key in ("KODERA_STAFF_ISSUER", FEDERATION_ENV_NAME, SYNAPSE_OIDC_ISSUER_ENV_NAME)
        else f"{key}=single" if key == TOPOLOGY_ENV_NAME
        else f"{key}=" if key in (*COMMUNITY_KEYS, *AGENT_ENV_NAMES, SYNAPSE_OIDC_ENV_NAME)
        else f"{key}={base64.urlsafe_b64encode(bytes([i]) * 32).decode()}" if "BASE64URL_32" in value
        else f"{key}=filled-value-{i}"
        for i, (key, value) in enumerate(parse_env_example(env_text)[0].items())
    ) + "\n"
    if preflight_env(env_text, filled):
        print(f"[FAIL] preflight refuses a complete .env: {preflight_env(env_text, filled)}", file=sys.stderr)
        return 1
    for label, mutate, expected in preflight_cases:
        source = env_text if label == "a placeholder is left" else filled
        got = preflight_env(env_text, mutate(source))
        if expected not in got:
            print(f"[FAIL] preflight case '{label}' did not report the expected error", file=sys.stderr)
            return 1
        if any("filled-value" in err or "example.net" in err for err in got):
            print(f"[FAIL] preflight case '{label}' printed a value", file=sys.stderr)
            return 1

    # Topologies: an .env that predates the setting runs `single`; `split` needs the API host.
    def setting(env: str, key: str, value: str) -> str:
        return re.sub(r"(?m)^" + key + r"=.*$", key + "=" + value, env)

    split_env = setting(setting(setting(setting(filled, TOPOLOGY_ENV_NAME, "split"), "KODERA_DOMAIN", "chat.example.net"),
                                "KODERA_MATRIX_DOMAIN", "example.net"), "DJANGO_ALLOWED_HOSTS", "api.example.net,127.0.0.1")
    topology_accepted = (
        ("an .env written before topologies existed", re.sub(r"(?m)^" + TOPOLOGY_ENV_NAME + r"=.*\n?", "", filled)),
        ("an empty topology", setting(filled, TOPOLOGY_ENV_NAME, "")),
        ("the split topology with its API host", split_env),
    )
    topology_refused = (
        ("an unknown topology", setting(filled, TOPOLOGY_ENV_NAME, "both"), f"{TOPOLOGY_ENV_NAME} must be single or split"),
        ("a topology in another case", setting(filled, TOPOLOGY_ENV_NAME, "Split"), f"{TOPOLOGY_ENV_NAME} must be single or split"),
        ("split with the single-origin allowed hosts", setting(split_env, "DJANGO_ALLOWED_HOSTS", "chat.example.net,127.0.0.1"),
         "DJANGO_ALLOWED_HOSTS must be api.<KODERA_MATRIX_DOMAIN>,127.0.0.1 in the split topology"),
        ("split admitting a wildcard host", setting(split_env, "DJANGO_ALLOWED_HOSTS", "*"),
         "DJANGO_ALLOWED_HOSTS must be api.<KODERA_MATRIX_DOMAIN>,127.0.0.1 in the split topology"),
        ("split with a web origin outside the base domain", setting(split_env, "KODERA_DOMAIN", "chat.example.com"),
         "KODERA_DOMAIN must be a subdomain of KODERA_MATRIX_DOMAIN in the split topology"),
        ("split with the web origin on the base domain itself", setting(split_env, "KODERA_DOMAIN", "example.net"),
         "KODERA_DOMAIN must be a subdomain of KODERA_MATRIX_DOMAIN in the split topology"),
    )
    for label, env in topology_accepted:
        if preflight_env(env_text, env):
            print(f"[FAIL] preflight refuses {label}: {preflight_env(env_text, env)}", file=sys.stderr)
            return 1
    for label, env, expected in topology_refused:
        got = preflight_env(env_text, env)
        if expected not in got or any(re.search(r"\bexample\.(?:net|com)\b", err) for err in got):
            print(f"[FAIL] preflight case '{label}' did not report '{expected}' without a value (got {got})", file=sys.stderr)
            return 1
    preflight_cases += [(label, lambda env: env, expected) for label, _env, expected in topology_refused]

    canonical = filled.replace("KODERA_DEFAULT_COMMUNITY_ORG_SLUG=\n", "KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community\n")
    canonical = canonical.replace("KODERA_DEFAULT_COMMUNITY_ISSUER=\n", "KODERA_DEFAULT_COMMUNITY_ISSUER=https://id.example.net/realms/community\n")
    canonical = canonical.replace("KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID=\n", "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID=00000000-0000-4000-8000-000000000001\n")
    canonical = canonical.replace("https://id.example.net/realms/acme", "https://id.example.net/realms/community")
    canonical = re.sub(r"(?m)^KODERA_DOMAIN=.*$", "KODERA_DOMAIN=community.example.net", canonical)
    canonical = re.sub(r"(?m)^KODERA_MATRIX_DOMAIN=.*$", "KODERA_MATRIX_DOMAIN=example.net", canonical)
    for key in (*AGENT_ENV_NAMES, SYNAPSE_OIDC_ENV_NAME):
        canonical = canonical.replace(key + "=\n", key + "=synthetic-issued-token-for-test-only\n")
    if preflight_env(env_text, canonical):
        print("[FAIL] canonical Community preflight refused valid public configuration", file=sys.stderr)
        return 1
    community_mutations = [
        ("wrong base domain", canonical.replace("KODERA_MATRIX_DOMAIN=example.net", "KODERA_MATRIX_DOMAIN=community.example.net"), "KODERA_DOMAIN must match"),
        ("missing owner", canonical.replace("00000000-0000-4000-8000-000000000001", ""), "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID"),
        ("wrong slug", canonical.replace("ORG_SLUG=community", "ORG_SLUG=wrong"), "KODERA_DEFAULT_COMMUNITY_ORG_SLUG"),
        ("foreign issuer", canonical.replace("ISSUER=https://id.example.net/realms/community", "ISSUER=https://other.example.net/realms/community"), "customer trust lane"),
        ("wrong trust lane", canonical.replace('"lane":"customer"', '"lane":"staff"'), "customer trust lane"),
    ]
    for label, value, expected in community_mutations:
        if not any(expected in error for error in preflight_env(env_text, value)):
            print("[FAIL] Community preflight mutation survived: " + label, file=sys.stderr)
            return 1

    # Matrix sign-in and federation settings: the refusals first, then what is accepted.
    def with_values(source: str, **values: str) -> str:
        for key, value in values.items():
            source = re.sub(r"(?m)^" + key + r"=.*$", lambda _match, key=key, value=value: key + "=" + value, source)
        return source

    generic_issuer = "https://id.example.net/realms/acme"
    signed_in = with_values(filled, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: generic_issuer, SYNAPSE_OIDC_ENV_NAME: SYNTHETIC_CREDENTIAL})
    hardening_refusals = [
        ("Synapse client secret without an issuer", with_values(filled, **{SYNAPSE_OIDC_ENV_NAME: SYNTHETIC_CREDENTIAL}),
         f"{SYNAPSE_OIDC_ENV_NAME} requires {SYNAPSE_OIDC_ISSUER_ENV_NAME}"),
        ("Synapse issuer without its client secret", with_values(filled, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: generic_issuer}),
         f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} requires the issued {SYNAPSE_OIDC_ENV_NAME}"),
        ("Synapse issuer outside the trust registry", with_values(signed_in, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: "https://other.example.net/realms/acme"}),
         f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} must be a public https issuer admitted on the customer trust lane"),
        ("Synapse issuer on the staff lane only", signed_in.replace('"lane":"customer"', '"lane":"staff"'),
         f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} must be a public https issuer admitted on the customer trust lane"),
        ("Synapse client secret left as a placeholder", with_values(signed_in, **{SYNAPSE_OIDC_ENV_NAME: "CHANGE_ME_ISSUED_SYNAPSE_CLIENT_SECRET"}),
         f"{SYNAPSE_OIDC_ENV_NAME} still holds a CHANGE_ME_ placeholder"),
        ("Community with a second Synapse issuer", with_values(canonical, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: generic_issuer}),
         f"{SYNAPSE_OIDC_ISSUER_ENV_NAME} must be empty or the canonical Community issuer"),
        ("federation opened to every server", with_values(filled, **{FEDERATION_ENV_NAME: "*"}),
         f"{FEDERATION_ENV_NAME} must list public server names"),
        ("federation opened to a private name", with_values(filled, **{FEDERATION_ENV_NAME: "partner.example.net,synapse.internal"}),
         f"{FEDERATION_ENV_NAME} must list public server names"),
    ]
    for label, value, expected in hardening_refusals:
        got = preflight_env(env_text, value)
        if not any(expected in error for error in got):
            print(f"[FAIL] preflight hardening case '{label}' did not report '{expected}' (got {got})", file=sys.stderr)
            return 1
        if any(re.search(r"example\.net", error) or SYNTHETIC_CREDENTIAL in error for error in got):
            print(f"[FAIL] preflight hardening case '{label}' printed a value", file=sys.stderr)
            return 1
    hardening_accepted = [
        ("isolated self-host with Matrix sign-in", signed_in),
        ("federation opened to named servers", with_values(filled, **{FEDERATION_ENV_NAME: "partner.example.net,other.example.net"})),
        ("Community naming its own issuer for Synapse", with_values(canonical, **{SYNAPSE_OIDC_ISSUER_ENV_NAME: "https://id.example.net/realms/community"})),
    ]
    for label, value in hardening_accepted:
        if preflight_env(env_text, value):
            print(f"[FAIL] preflight refused '{label}': {preflight_env(env_text, value)}", file=sys.stderr)
            return 1

    for label, mutate, expected_substring in mutations:
        m_compose, m_env, m_caddy = mutate(compose_text, env_text, caddyfile_text)
        if (m_compose, m_env, m_caddy) == (compose_text, env_text, caddyfile_text):
            print(f"[FAIL] selftest mutation '{label}' produced no change", file=sys.stderr)
            return 1
        errs = check_community_deploy(m_compose, m_env, m_caddy)
        if not any(expected_substring in err for err in errs):
            print(
                f"[FAIL] selftest mutation '{label}' did not trigger '{expected_substring}' (got {errs})",
                file=sys.stderr,
            )
            return 1

    print(
        f"OK: deploy/community stack valid, {len(mutations)} negative selftest mutations refused, "
        f"{len(preflight_cases) + len(community_mutations) + len(hardening_refusals) + len(hardening_accepted)} preflight cases reported."
    )
    return 0


# Each entry breaks one hardening invariant in configure_synapse.py; the behavioural check must
# then name that invariant. (label, text to replace, replacement, expected refusal)
SYNAPSE_CONFIG_MUTATIONS: tuple[tuple[str, str, str, str], ...] = (
    ("Synapse stays on SQLite", 'document["database"] = {"name": "psycopg2"', 'document["database_unused"] = {"name": "psycopg2"',
     "Synapse must run on PostgreSQL, not SQLite"),
    ("the database password is written to the configuration", '"host": DATABASE_HOST,', '"host": DATABASE_HOST, "password": "synapse",',
     "its database password stays out of homeserver.yaml"),
    ("an existing SQLite database is abandoned", 'if database.get("name") == "sqlite3" and', 'if database.get("name") == "never" and',
     "Synapse must refuse to abandon an existing SQLite database"),
    ("federation is open by default: no whitelist", 'document["federation_domain_whitelist"] = allowlist', 'document.pop("federation_domain_whitelist", None)',
     "Synapse federation must be closed by default"),
    ("federation is open by default: the listener stays", 'if name != "federation"]', 'if name]',
     "Synapse federation must be closed by default"),
    ("federation is open by default: the notary stays", 'document["trusted_key_servers"] = []', 'document.setdefault("trusted_key_servers", [])',
     "Synapse federation must be closed by default"),
    ("the federation allowlist accepts a wildcard", 'if not re.fullmatch(PUBLIC_DOMAIN, name) or name.endswith(PRIVATE_SUFFIXES):', 'if False:',
     "Synapse federation allowlist must refuse a wildcard or private server name"),
    ("the room-policy module is missing", '    modules.append({"module": MODULE, "config": {', '    dict({"module": MODULE, "config": {',
     "Synapse room-policy module is missing or misconfigured"),
    ("the room-access account is not named to the policy", '"room_access_user_id": f"@kodera-rooms:{server}",', '',
     "Synapse room-policy module is missing or misconfigured"),
    ("message rate limit removed", '    "rc_message": {"per_second": 0.2, "burst_count": 10},\n', '',
     "Synapse rate limits must be set: rc_message"),
    ("login rate limit loosened to a test value", '"address": {"per_second": 0.17, "burst_count": 20}', '"address": {"per_second": 50, "burst_count": 100}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_login.address"),
    ("per-address login limit loosened past the reviewed value", '"address": {"per_second": 0.17, "burst_count": 20}', '"address": {"per_second": 0.5, "burst_count": 50}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_login.address"),
    ("per-account login limit loosened past Synapse's default", '"account": {"per_second": 0.003, "burst_count": 5}', '"account": {"per_second": 0.1, "burst_count": 20}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_login.account"),
    ("failed-attempt limit loosened past Synapse's default", '"failed_attempts": {"per_second": 0.17, "burst_count": 3}', '"failed_attempts": {"per_second": 0.17, "burst_count": 4}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_login.failed_attempts"),
    ("registration limit loosened past Synapse's default", '"rc_registration": {"per_second": 0.17, "burst_count": 3}', '"rc_registration": {"per_second": 0.18, "burst_count": 3}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_registration"),
    ("message limit loosened past Synapse's default", '"rc_message": {"per_second": 0.2, "burst_count": 10}', '"rc_message": {"per_second": 0.2, "burst_count": 11}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_message"),
    ("invite limit loosened past Synapse's default", '"per_user": {"per_second": 0.003, "burst_count": 5}', '"per_user": {"per_second": 0.3, "burst_count": 5}',
     "Synapse rate limits must not be looser than the reviewed ceiling: rc_invites.per_user"),
    ("a zero rate is not a limit", '"remote": {"per_second": 0.01, "burst_count": 10}', '"remote": {"per_second": 0, "burst_count": 10}',
     "Synapse rate limits must be set: rc_joins.remote"),
    ("rate limits are never written", "        document[key] = copy.deepcopy(value)", "        pass",
     "Synapse rate limits must be set: rc_invites.per_user"),
    ("rate limits see the proxy, not the client", 'listener["x_forwarded"] = listener.get("port") == PROXIED_LISTENER_PORT', 'listener["x_forwarded"] = False',
     "Synapse rate limits must see each client: the listener Caddy fronts must set x_forwarded"),
    ("every listener believes a forwarded address", 'listener["x_forwarded"] = listener.get("port") == PROXIED_LISTENER_PORT', 'listener["x_forwarded"] = True',
     "Synapse must believe a forwarded address only on the listener Caddy fronts (x_forwarded is set on port 9000)"),
    ("an unfronted listener keeps believing a forwarded address", 'listener["x_forwarded"] = listener.get("port") == PROXIED_LISTENER_PORT', 'listener["x_forwarded"] = listener.get("x_forwarded") or listener.get("port") == PROXIED_LISTENER_PORT',
     "Synapse must believe a forwarded address only on the listener Caddy fronts (x_forwarded is set on port 9000)"),
    ("the trusted listener is not the one Caddy fronts", 'PROXIED_LISTENER_PORT = 8008', 'PROXIED_LISTENER_PORT = 9000',
     "Synapse must name the listener Caddy fronts"),
    ("password sign-in stays on", 'document["password_config"] = {"enabled": False}', 'document["password_config"] = {"enabled": True}',
     "Synapse must keep open registration and password sign-in off"),
    ("open registration", 'document["enable_registration"] = False', 'document["enable_registration"] = True',
     "Synapse must keep open registration and password sign-in off"),
    ("tokens never expire", 'document["refreshable_access_token_lifetime"] = "5m"', 'pass',
     "Synapse must keep the documented setting refreshable_access_token_lifetime"),
    ("room encryption by default", 'document["encryption_enabled_by_default_for_room_type"] = "off"', 'document["encryption_enabled_by_default_for_room_type"] = "all"',
     "Synapse must keep the documented setting encryption_enabled_by_default_for_room_type"),
    ("PKCE is optional", '"pkce_method": "always"', '"pkce_method": "never"',
     "Synapse OIDC sign-in is not wired as documented"),
    ("the Matrix ID comes from a mutable claim", '"localpart_template": "{{ user.sub | lower }}"', '"localpart_template": "{{ user.preferred_username }}"',
     "Synapse OIDC sign-in is not wired as documented"),
    ("the login token goes to a look-alike origin", 'client_whitelist=[f"https://{server}/"]', 'client_whitelist=[f"https://{server}"]',
     "Synapse OIDC sign-in must return to the web origin with a trailing slash only"),
    ("a plain-http issuer is accepted", 'r"https://" + PUBLIC_DOMAIN + r"(?:/[A-Za-z0-9._~/-]{0,512})?", issuer', 'r"https?://" + PUBLIC_DOMAIN + r"(?:/[A-Za-z0-9._~/-]{0,512})?", issuer',
     "Synapse OIDC sign-in accepts an unsafe issuer or a missing client credential"),
    ("an unrelated identity provider is replaced", 'raise ValueError("Synapse sign-in refuses to replace an unrelated identity provider")', 'pass',
     "Synapse OIDC sign-in must not silently replace an unrelated identity provider (kodera)"),
    ("the split client API is published on the web origin", 'split_baseurl = f"https://matrix.{server}/"', 'split_baseurl = f"https://{server}/"',
     "Synapse split topology must publish its client API at https://matrix.<server_name>/"),
    ("split sign-in returns the login token to the Matrix origin", 'client_whitelist=[f"https://{server}/"]', 'client_whitelist=[split_baseurl if split else f"https://{server}/"]',
     "Synapse split sign-in must return the login token to the web origin https://<server_name>/ only"),
    ("a topology the Compose files do not run is accepted", '    if chosen != running:', '    if False:',
     "Synapse must refuse a topology the Compose files do not run"),
    ("an unknown topology is accepted", '    if chosen not in TOPOLOGIES or running not in TOPOLOGIES:', '    if False:',
     "Synapse must refuse a topology the Compose files do not run"),
    ("the split base URL survives a return to single", '        del document["public_baseurl"]', '        pass',
     "Synapse must drop the split public base URL when the stack returns to the single topology"),
)


SplitMutation = tuple[str, str, Callable[[str], str], str]


def _first(old: str, new: str) -> Callable[[str], str]:
    return lambda text: text.replace(old, new, 1)


def _last(old: str, new: str) -> Callable[[str], str]:
    return lambda text: new.join(text.rsplit(old, 1))


# (label, file mutated: "override" or "caddy", mutation, expected refusal)
SPLIT_MUTATIONS: tuple[SplitMutation, ...] = (
    ("the API origin routes the agent API", "caddy", _first("@api path /api/* /health/*", "@api path /api/* /health/* /agent/*"),
     "Caddyfile.split must not expose the agent API to the internet (got '/agent/*')"),
    ("the Matrix origin routes federation", "caddy", _first("/_synapse/client/*", "/_synapse/client/* /_matrix/federation/*"),
     "federation must be closed by default: Caddyfile.split must route only the Matrix client API, never federation, key or admin routes (got '/_matrix/federation/*')"),
    ("the Matrix origin routes the key API", "caddy", _first("/_synapse/client/*", "/_synapse/client/* /_matrix/key/*"),
     "(got '/_matrix/key/*')"),
    ("the Matrix origin answers server discovery", "caddy", _first("/_synapse/client/*", "/_synapse/client/* /.well-known/matrix/server"),
     "(got '/.well-known/matrix/server')"),
    ("the Matrix origin routes the admin API", "caddy", _first("/_synapse/client/*", "/_synapse/client/* /_synapse/admin/*"),
     "(got '/_synapse/admin/*')"),
    ("Synapse keeps granting every origin", "caddy", _first("\t\t\t" + SPLIT_SYNAPSE_CORS + "\n", ""),
     f"Caddyfile.split must set the reviewed reverse_proxy option for 'synapse:8008': '{SPLIT_SYNAPSE_CORS}'"),
    ("Synapse grants a wildcard origin", "caddy", _first(SPLIT_SYNAPSE_CORS, 'header_down Access-Control-Allow-Origin "*"'),
     "Caddyfile.split has an unreviewed reverse_proxy option for 'synapse:8008': 'header_down Access-Control-Allow-Origin'"),
    ("the API is answered on the signalling origin", "caddy", _first("reverse_proxy livekit:7880 {", "reverse_proxy server:8000 {"),
     "Caddyfile.split site 'livekit.{$KODERA_DOMAIN}' proxies to 'server:8000', which is not reviewed for that site"),
    ("room-access is answered on the API origin", "caddy", _first("@api path /api/* /health/*", "@api path /_kodera/rooms/token"),
     "Caddyfile.split exposes an unreviewed route to 'server:8000': '/_kodera/rooms/token'"),
    ("an unrouted API path falls through to the web client", "caddy",
     _first("\thandle {\n\t\trespond 404\n\t}", "\thandle {\n\t\treverse_proxy web:8080 {\n\t\t\timport client_address\n\t\t}\n\t}"),
     "Caddyfile.split catch-all must answer 404, never proxy (got 'web:8080')"),
    ("the signalling origin answers unrouted paths", "caddy", _last("\n\thandle {\n\t\trespond 404\n\t}", ""),
     "Caddyfile.split site 'livekit.{$KODERA_DOMAIN}' must answer 404 for every path it does not route"),
    ("a client-supplied address reaches the API", "caddy", _first("\t\t\timport client_address\n", ""),
     "Caddyfile.split must overwrite X-Forwarded-For with the peer address for 'server:8000'"),
    ("the stack serves the web origin too", "caddy", _last("}\n", "}\n\n{$KODERA_DOMAIN} {\n\thandle {\n\t\trespond 404\n\t}\n}\n"),
     "Caddyfile.split must hold exactly the site blocks api.{$KODERA_MATRIX_DOMAIN}, matrix.{$KODERA_DOMAIN}, livekit.{$KODERA_DOMAIN}, in that order"),
    ("a forwarded address is believed", "caddy", _first("\temail {$KODERA_ACME_EMAIL}\n", "\temail {$KODERA_ACME_EMAIL}\n\tservers {\n\t\ttrusted_proxies static private_ranges\n\t}\n"),
     "Caddyfile.split must not declare trusted_proxies"),
    ("the web client is started", "override", _first("  web:\n    profiles: [single-origin-web]\n", ""),
     "docker-compose.split.yml must change service 'web'"),
    ("the web client joins the default profile", "override", _first("profiles: [single-origin-web]", "profiles: [default]"),
     "docker-compose.split.yml must leave the web client unstarted"),
    ("Caddy keeps the single-origin Caddyfile", "override", _first("./Caddyfile.split:/etc/caddy/Caddyfile:ro", "./Caddyfile:/etc/caddy/Caddyfile:ro"),
     "docker-compose.split.yml must mount Caddyfile.split as Caddy's only configuration"),
    ("Caddy cannot name the API origin", "override", _first("      KODERA_MATRIX_DOMAIN: ", "      KODERA_MATRIX_DOMAIN_UNUSED: "),
     "docker-compose.split.yml must set KODERA_MATRIX_DOMAIN on service 'caddy'"),
    ("the API admits every origin", "override", _first("KODERA_CONSOLE_ORIGINS: https://${KODERA_DOMAIN:?", "KODERA_CONSOLE_ORIGINS: '*'${KODERA_DOMAIN:?"),
     "docker-compose.split.yml must set KODERA_CONSOLE_ORIGINS on service 'server' to https://${KODERA_DOMAIN:?..."),
    ("room-access hands out the single-origin signalling URL", "override", _first("wss://livekit.${KODERA_DOMAIN", "wss://${KODERA_DOMAIN"),
     "docker-compose.split.yml must set LIVEKIT_WS_URL on service 'room-access' to wss://livekit.${KODERA_DOMAIN:?..."),
    ("Synapse is not told it runs split", "override", _first(f"      {COMPOSE_TOPOLOGY_ENV_NAME}: split\n", ""),
     f"docker-compose.split.yml must set {COMPOSE_TOPOLOGY_ENV_NAME} on service 'synapse'"),
    ("a LiveKit secret reaches the server", "override",
     _first("      KODERA_CONSOLE_ORIGINS:", "      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET:?Set it}\n      KODERA_CONSOLE_ORIGINS:"),
     "ADR-0003 isolation violation: forbidden secret 'LIVEKIT_API_SECRET' in service 'server' (docker-compose.split.yml)"),
    ("Synapse is published around Caddy", "override", _first("  synapse:\n", '  synapse:\n    ports:\n      - "8008:8008"\n'),
     "service 'synapse' must not publish a port"),
    ("an unreviewed service is changed", "override", lambda text: text + "  db:\n    mem_limit: 4g\n",
     "docker-compose.split.yml changes an unreviewed service 'db'"),
    ("the server image is replaced", "override", _first("  server:\n", "  server:\n    image: example.org/server:latest\n"),
     "docker-compose.split.yml changes an unreviewed key 'image' of service 'server'"),
    ("an undocumented variable is read", "override", _first("wss://livekit.${KODERA_DOMAIN", "wss://livekit.${KODERA_SIGNALLING_HOST:?x}${KODERA_DOMAIN"),
     "missing variable in .env.example: KODERA_SIGNALLING_HOST (docker-compose.split.yml)"),
)


def run_collaboration_selftest(compose: str, env: str, caddy: str, split: str, split_caddy: str) -> int:
    """Native process isolation and exact-route checks must refuse named mutations."""
    key_line = "      KODERA_COLLAB_TICKET_KEY: ${KODERA_COLLAB_TICKET_KEY:?Set the application collaboration key}"
    cases = [
        ("native database owner restored", compose.replace("postgresql://kodera_collab:${KODERA_COLLAB_DATABASE_PASSWORD:?Set the isolated collaboration database password}@db:5432/${POSTGRES_DB:-kodera_server}", "postgresql://${POSTGRES_USER:-kodera}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-kodera_server}"), env, caddy,
         "yjs-collab must hold only its reviewed database and application settings"),
        ("native login provisioning skipped", compose.replace("python manage.py configure_collab_role --settings config.settings.deploy &&", "true &&"), env, caddy,
         "migrate must provision the isolated collaboration login"),
        ("native database password undocumented", compose, re.sub(r"(?m)^KODERA_COLLAB_DATABASE_PASSWORD=.*\n?", "", env), caddy,
         "missing required secret key in .env.example: KODERA_COLLAB_DATABASE_PASSWORD"),
        ("Core application key missing", compose.replace(key_line + "\n", "", 1), env, caddy,
         "server must set reviewed collaboration setting KODERA_COLLAB_TICKET_KEY"),
        ("Core transformer pointed elsewhere", compose.replace("http://yjs-collab:8098/internal/transform", "http://example.org/transform"), env, caddy,
         "server must set reviewed collaboration setting KODERA_COLLAB_ENGINE_URL"),
        ("native application key missing", compose.rsplit(key_line + "\n", 1)[0] + compose.rsplit(key_line + "\n", 1)[1], env, caddy,
         "yjs-collab must hold only its reviewed database and application settings"),
        ("native provider credential", compose.replace("      KODERA_COLLAB_ALLOWED_ORIGINS:", "      AWS_ACCESS_KEY_ID: CHANGE_ME_PROVIDER\n      KODERA_COLLAB_ALLOWED_ORIGINS:"), env, caddy,
         "yjs-collab must hold only its reviewed database and application settings"),
        ("native origin wildcard", compose.replace("KODERA_COLLAB_ALLOWED_ORIGINS: https://${KODERA_DOMAIN:-chat.example.org}", "KODERA_COLLAB_ALLOWED_ORIGINS: '*'"), env, caddy,
         "yjs-collab must hold only its reviewed database and application settings"),
        ("native migrations not awaited", compose.replace("      migrate:\n        condition: service_completed_successfully", "      migrate:\n        condition: service_started"), env, caddy,
         "yjs-collab must wait for completed migrations"),
        ("native build context changed", compose.replace("context: ../../apps/server/yjs_collab", "context: ../.."), env, caddy,
         "yjs-collab must build its reviewed isolated native runtime"),
        ("native credential directory mounted", compose.replace("  yjs-collab:\n    mem_limit", "  yjs-collab:\n    volumes:\n      - ./Caddyfile:/etc/caddy/Caddyfile:ro\n    mem_limit"), env, caddy,
         "yjs-collab must not mount files or credential directories"),
        ("application key undocumented", compose, re.sub(r"(?m)^KODERA_COLLAB_TICKET_KEY=.*\n?", "", env), caddy,
         "missing required secret key in .env.example: KODERA_COLLAB_TICKET_KEY"),
        ("private transformer published", compose, env, caddy.replace("@documents path /documents/collab", "@documents path /documents/collab /internal/transform"),
         "exposes an unreviewed route to 'yjs-collab:8098': '/internal/transform'"),
        ("wildcard native document route", compose, env, caddy.replace("@documents path /documents/collab", "@documents path /documents/*"),
         "exposes an unreviewed route to 'yjs-collab:8098': '/documents/*'"),
    ]
    for label, changed, example, route, expected in cases:
        if (changed, example, route) == (compose, env, caddy):
            print("[FAIL] native mutation produced no change: " + label, file=sys.stderr)
            return 1
        got = check_community_deploy(changed, example, route)
        if not any(expected in error for error in got):
            print(f"[FAIL] native mutation '{label}' did not report '{expected}' (got {got})", file=sys.stderr)
            return 1
    changed = split_caddy.replace("@documents path /documents/collab", "@documents path /internal/transform")
    if not any("exposes an unreviewed route to 'yjs-collab:8098': '/internal/transform'" in error for error in check_split_topology(split, changed, env)):
        print("[FAIL] split native transformer route escaped", file=sys.stderr)
        return 1
    print(f"OK: native collaboration baseline valid, {len(cases) + 1} isolation and route mutations refused by name.")
    return 0


def run_split_selftest(override_text: str, split_caddyfile_text: str, env_text: str) -> int:
    baseline = check_split_topology(override_text, split_caddyfile_text, env_text)
    if baseline:
        for error in baseline:
            print(f"[FAIL] baseline split topology invalid: {error}", file=sys.stderr)
        return 1
    for label, target, mutate, expected in SPLIT_MUTATIONS:
        override, caddy = (mutate(override_text), split_caddyfile_text) if target == "override" else (override_text, mutate(split_caddyfile_text))
        if (override, caddy) == (override_text, split_caddyfile_text):
            print(f"[FAIL] split mutation '{label}' produced no change", file=sys.stderr)
            return 1
        errors = check_split_topology(override, caddy, env_text)
        if not any(expected in error for error in errors):
            print(f"[FAIL] split mutation '{label}' did not trigger '{expected}' (got {errors})", file=sys.stderr)
            return 1
    print(f"OK: split topology valid, {len(SPLIT_MUTATIONS)} override and Caddyfile.split mutations refused by name.")
    return 0


def run_synapse_config_selftest(source: str) -> int:
    baseline = check_synapse_config(source)
    if baseline:
        for error in baseline:
            print(f"[FAIL] baseline Synapse configuration invalid: {error}", file=sys.stderr)
        return 1
    for label, old, new, expected in SYNAPSE_CONFIG_MUTATIONS:
        if source.count(old) != 1:
            print(f"[FAIL] Synapse configuration mutation '{label}' does not apply exactly once", file=sys.stderr)
            return 1
        errors = check_synapse_config(source.replace(old, new))
        if not any(expected in error for error in errors):
            print(f"[FAIL] Synapse configuration mutation '{label}' did not trigger '{expected}' (got {errors})", file=sys.stderr)
            return 1
    print(f"OK: Synapse configuration hardened, {len(SYNAPSE_CONFIG_MUTATIONS)} configuration mutations refused by name.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--compose",
        type=Path,
        default=DEFAULT_COMPOSE,
        help="Path to deploy/community/docker-compose.yml",
    )
    parser.add_argument(
        "--env-example",
        type=Path,
        default=DEFAULT_ENV_EXAMPLE,
        help="Path to deploy/community/.env.example",
    )
    parser.add_argument(
        "--caddyfile",
        type=Path,
        default=DEFAULT_CADDYFILE,
        help="Path to deploy/community/Caddyfile",
    )
    parser.add_argument(
        "--preflight",
        type=Path,
        metavar="ENV_FILE",
        help="Also check an operator's .env against .env.example before `docker compose up`",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="Run negative mutation self-tests after checking baseline files",
    )
    args = parser.parse_args()

    texts: dict[str, str] = {}
    for path, label in (
        (args.compose, "docker-compose.yml"),
        (args.env_example, ".env.example"),
        (args.caddyfile, "Caddyfile"),
        (ROOT / "deploy/community/configure_synapse.py", "configure_synapse.py"),
        (ROOT / "deploy/community/livekit.yaml", "livekit.yaml"),
        (DEFAULT_SPLIT_COMPOSE, "docker-compose.split.yml"),
        (DEFAULT_SPLIT_CADDYFILE, "Caddyfile.split"),
    ):
        problem = path_problem(path)
        text = read_regular_file(path) if problem is None else None
        if text is None:
            reason = f"is {problem}, which the gate does not follow" if problem not in (None, "missing") else "is not a readable regular UTF-8 file"
            print(f"[FAIL] {label} {reason}: {path}", file=sys.stderr)
            return 1
        texts[label] = text

    compose_text = texts["docker-compose.yml"]
    env_text = texts[".env.example"]
    caddyfile_text = texts["Caddyfile"]
    policy_source = texts["configure_synapse.py"]
    livekit_text = texts["livekit.yaml"]
    source_errors = check_synapse_policy_source(policy_source) + check_synapse_config(policy_source) + check_livekit_config(livekit_text)
    if source_errors:
        for error in source_errors:
            print("[FAIL] " + error, file=sys.stderr)
        return 1
    if args.selftest:
        for guard in ('kodera_synapse_policy.KoderaPolicy', 'room_access_user_id', '0.1.5'):
            if not check_synapse_policy_source(policy_source.replace(guard, "removed")):
                print("[FAIL] Synapse policy source mutation escaped", file=sys.stderr)
                return 1
        livekit_mutations = (
            ("an API key written into the file", "port: 7880\n", "port: 7880\nkeys:\n  devkey: devsecret\n",
             "livekit.yaml differs from its reviewed text at line 2: found 'keys' indented by 0, the reviewed file holds 'rtc' indented by 0"),
            ("rooms created on demand", "auto_create: false", "auto_create: true",
             "at line 8: found 'auto_create' indented by 2, the reviewed file holds 'auto_create' indented by 2 (same setting, another value or spacing)"),
            ("a webhook to an unreviewed receiver", "logging:\n", "webhook:\n  urls: [https://example.org/hook]\nlogging:\n",
             "at line 10: found 'webhook' indented by 0"),
            ("the media port range widened", "port_range_end: 50200", "port_range_end: 65535",
             "at line 5: found 'port_range_end' indented by 2, the reviewed file holds 'port_range_end' indented by 2 (same setting"),
            ("a reviewed setting removed", "  use_external_ip: true\n", "",
             "at line 6: found 'room' indented by 0, the reviewed file holds 'use_external_ip' indented by 2"),
            ("a setting repeated further down", "logging:\n", "port: 7880\nlogging:\n",
             "at line 10: found 'port' indented by 0, the reviewed file holds 'logging' indented by 0"),
            ("a reviewed setting moved under another parent", "  use_external_ip: true\nroom:\n  auto_create: false\n", "  use_external_ip: true\n  auto_create: false\nroom:\n",
             "at line 7: found 'auto_create' indented by 2, the reviewed file holds 'room' indented by 0"),
            ("a reviewed child placed under the wrong parent", "logging:\n  level: info\n", "logging:\n  level: info\n  tcp_port: 7881\n",
             "at line 12: found 'tcp_port' indented by 2, the reviewed file holds '' indented by 0"),
            ("a reviewed key duplicated in place", "  auto_create: false\n", "  auto_create: false\n  auto_create: false\n",
             "at line 9: found 'auto_create' indented by 2, the reviewed file holds 'empty_timeout' indented by 2"),
            ("a reviewed line at the wrong indentation", "  auto_create: false\n", "auto_create: false\n",
             "at line 8: found 'auto_create' indented by 0, the reviewed file holds 'auto_create' indented by 2"),
            ("a reviewed line nested one level deeper", "  level: info\n", "    level: info\n",
             "at line 11: found 'level' indented by 4, the reviewed file holds 'level' indented by 2"),
            ("a comment that hides a setting from a casual reader", "room:\n", "room: # keys: {devkey: devsecret}\n",
             "at line 7: found 'room' indented by 0, the reviewed file holds 'room' indented by 0 (same setting"),
            ("a trailing document", "  level: info\n", "  level: info\n---\nkeys:\n  devkey: devsecret\n",
             "at line 12: found '---' indented by 0"),
        )
        for label, old, new, expected in livekit_mutations:
            if old not in livekit_text or not any(expected in error for error in check_livekit_config(livekit_text.replace(old, new, 1))):
                print(f"[FAIL] livekit.yaml mutation '{label}' did not trigger '{expected}'", file=sys.stderr)
                return 1
        print(f"OK: livekit.yaml is its reviewed text byte for byte, {len(livekit_mutations)} mutations refused by name.")
        return (
            run_synapse_config_selftest(policy_source)
            or run_scaffolder_selftest()
            or run_split_selftest(texts["docker-compose.split.yml"], texts["Caddyfile.split"], env_text)
            or run_collaboration_selftest(compose_text, env_text, caddyfile_text, texts["docker-compose.split.yml"], texts["Caddyfile.split"])
            or run_selftest(compose_text, env_text, caddyfile_text)
        )

    errors = check_community_deploy(compose_text, env_text, caddyfile_text)
    errors += check_split_topology(texts["docker-compose.split.yml"], texts["Caddyfile.split"], env_text)
    scaffolder_state = read_scaffolder_state()
    errors += scaffolder_state[3] + check_scaffolder_parity(*scaffolder_state[:3])
    if args.preflight is not None:
        if not args.preflight.is_file():
            print(f"[FAIL] .env not found: {args.preflight}", file=sys.stderr)
            return 1
        try:
            operator_env = args.preflight.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            print("[FAIL] .env is not UTF-8 text", file=sys.stderr)
            return 1
        errors += [f".env: {err}" for err in preflight_env(env_text, operator_env)]
    if errors:
        for err in errors:
            print(f"[FAIL] {err}", file=sys.stderr)
        return 1

    print("OK: deploy/community passed all compose, .env.example, Caddyfile, split topology, LiveKit, Synapse and scaffolder parity checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

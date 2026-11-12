#!/usr/bin/env python3
"""Validate deploy/community self-host stack invariants and ADR-0003 secret isolation.

With --preflight ENV_FILE it also checks an operator's own .env before `docker compose up`:
every key of .env.example is set, no CHANGE_ME_ placeholder is left, and KODERA_AUTH_TRUST
names at least one https issuer. It reports key names only, never a value.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
import types
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COMPOSE = ROOT / "deploy" / "community" / "docker-compose.yml"
DEFAULT_ENV_EXAMPLE = ROOT / "deploy" / "community" / ".env.example"
DEFAULT_CADDYFILE = ROOT / "deploy" / "community" / "Caddyfile"

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
    "SYNAPSE_POSTGRES_PASSWORD",
    "DJANGO_SECRET_KEY",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_DISCOVERY_HMAC_KEY",
    "ROOM_ACCESS_MATRIX_TOKEN",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
)

HEALTHCHECK_REQUIRED_SERVICES = ("db", "valkey", "server", "synapse", "synapse-db")

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

# What Caddy may route from the internet, per upstream. Anything else is refused: the agent API
# (`/agent/*`) and Matrix federation, key and admin routes are not internet-facing by default.
ALLOWED_PUBLIC_ROUTES: dict[str, frozenset[str]] = {
    "server:8000": frozenset({"/api/*", "/health/*"}),
    "room-access:8095": frozenset({"/_kodera/rooms/token"}),
    "synapse:8008": frozenset({"/_matrix/client/*", "/_matrix/media/*", "/_synapse/client/*"}),
    "livekit:7880": frozenset({"/rtc", "/rtc/*"}),
}
CATCH_ALL_UPSTREAM = "web:8080"
CADDY_MATCHER_RE = re.compile(r"(?m)^[ \t]*@([a-z_]+)[ \t]+path[ \t]+(.+?)[ \t]*$")
CADDY_HANDLE_RE = re.compile(r"(?ms)^[ \t]*handle(?:[ \t]+@([a-z_]+))?[ \t]*\{\n(.*?)^[ \t]*\}")
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

    return errors


def check_caddy_routes(caddyfile_text: str) -> list[str]:
    """Every route Caddy proxies is on the reviewed list. The agent API and Matrix federation,
    key and admin routes are refused by name."""
    errors: list[str] = []
    code = "\n".join(line for line in caddyfile_text.splitlines() if not line.strip().startswith("#"))
    matchers = {name: paths.split() for name, paths in CADDY_MATCHER_RE.findall(code)}
    proxied = 0
    for matcher, body in CADDY_HANDLE_RE.findall(code):
        upstreams = re.findall(r"reverse_proxy[ \t]+(\S+)", body)
        proxied += len(upstreams)
        for upstream in upstreams:
            if not matcher:
                if upstream != CATCH_ALL_UPSTREAM:
                    errors.append(f"Caddyfile catch-all must proxy to '{CATCH_ALL_UPSTREAM}' only (got '{upstream}')")
                continue
            allowed = ALLOWED_PUBLIC_ROUTES.get(upstream)
            if allowed is None:
                errors.append(f"Caddyfile proxies '@{matcher}' to an unreviewed upstream '{upstream}'")
                continue
            if matcher not in matchers:
                errors.append(f"Caddyfile handle '@{matcher}' has no path matcher")
                continue
            for path in matchers[matcher]:
                if path in allowed:
                    continue
                if upstream == "server:8000" and path.startswith("/agent"):
                    errors.append(f"Caddyfile must not expose the agent API to the internet (got '{path}')")
                elif upstream == "synapse:8008":
                    errors.append(
                        "federation must be closed by default: Caddyfile must route only the Matrix client API, "
                        f"never federation, key or admin routes (got '{path}')"
                    )
                else:
                    errors.append(f"Caddyfile exposes an unreviewed route to '{upstream}': '{path}'")
    if proxied != len(re.findall(r"reverse_proxy[ \t]", code)):
        errors.append("Caddyfile has a reverse_proxy outside a reviewed handle block")
    return errors


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
RATE_LIMIT_PATHS = (
    ("rc_message",), ("rc_registration",),
    ("rc_login", "address"), ("rc_login", "account"), ("rc_login", "failed_attempts"),
    ("rc_joins", "local"), ("rc_joins", "remote"),
    ("rc_invites", "per_room"), ("rc_invites", "per_user"), ("rc_invites", "per_issuer"),
)
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
        "listeners": [{
            "port": 8008, "tls": False, "type": "http", "x_forwarded": False,
            "resources": [{"names": ["client", "federation"], "compress": False}],
        }],
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
        for path in RATE_LIMIT_PATHS:
            limit: object = closed
            for key in path:
                limit = limit.get(key) if isinstance(limit, dict) else None
            per_second = limit.get("per_second") if isinstance(limit, dict) else None
            burst = limit.get("burst_count") if isinstance(limit, dict) else None
            if (
                not isinstance(per_second, (int, float)) or isinstance(per_second, bool) or not 0 < per_second <= 1
                or not isinstance(burst, int) or isinstance(burst, bool) or not 1 <= burst <= 50
            ):
                problems.append("Synapse rate limits must be set: " + ".".join(path))
        if not all(listener.get("x_forwarded") is True for listener in closed.get("listeners", [])):
            problems.append("Synapse rate limits must see each client: the listener must set x_forwarded")
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

    for label, call in (
        ("database", database), ("federation", federation), ("room policy", policy),
        ("rate limits", rate_limits), ("accounts", accounts), ("sign-in", sign_in),
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


def read_scaffolder_state() -> tuple[object, dict[str, str], dict[str, str]]:
    def texts(paths: list[Path]) -> dict[str, str]:
        return {path.name: path.read_text(encoding="utf-8") for path in paths if path.is_file()}

    try:
        manifest: object = json.loads((SCAFFOLDER_DIR / "assets.manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = None
    sources = texts([ROOT / "deploy" / "community" / name for name in SCAFFOLDER_MANIFEST["files"]])
    assets_dir = SCAFFOLDER_DIR / "assets"
    return manifest, sources, texts(sorted(assets_dir.iterdir()) if assets_dir.is_dir() else [])


def run_scaffolder_selftest() -> int:
    manifest, sources, assets = read_scaffolder_state()
    baseline = check_scaffolder_parity(manifest, sources, assets)
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
    print(f"OK: create-kodera assets match deploy/community, {len(cases)} drift mutations refused by name.")
    return 0


def _deployable_issuer(issuer: object) -> bool:
    if not isinstance(issuer, str) or not issuer.startswith("https://"):
        return False
    host = issuer[len("https://") :].split("/", 1)[0].split(":", 1)[0].lower()
    return host not in {"", "localhost", "127.0.0.1", "::1", "[::1]"}


def preflight_env(env_example_text: str, env_text: str) -> list[str]:
    """Check an operator's .env against .env.example. Names keys, never values."""
    example, _ = parse_env_example(env_example_text)
    actual, parse_errors = parse_env_example(env_text)
    community_enabled = bool(actual.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "").strip("'\""))
    errors = [err.replace(".env.example", ".env").split(":", 1)[0] + ": malformed or duplicate" for err in parse_errors]
    synapse_issuer = actual.get(SYNAPSE_OIDC_ISSUER_ENV_NAME, "").strip("'\"")
    synapse_secret = actual.get(SYNAPSE_OIDC_ENV_NAME, "").strip("'\"")
    for key in example:
        if key in ("KODERA_STAFF_ISSUER", FEDERATION_ENV_NAME, SYNAPSE_OIDC_ISSUER_ENV_NAME) and not actual.get(key, "").strip("'\""):
            continue
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
        else f"{key}=" if key in (*COMMUNITY_KEYS, *AGENT_ENV_NAMES, SYNAPSE_OIDC_ENV_NAME)
        else f"{key}=filled-value-{i}"
        for i, key in enumerate(parse_env_example(env_text)[0])
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
        if any("example.net" in error or SYNTHETIC_CREDENTIAL in error for error in got):
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
    ("login rate limit loosened to a test value", '"address": {"per_second": 0.5, "burst_count": 50}', '"address": {"per_second": 50, "burst_count": 100}',
     "Synapse rate limits must be set: rc_login.address"),
    ("rate limits are never written", "        document[key] = copy.deepcopy(value)", "        pass",
     "Synapse rate limits must be set: rc_invites.per_user"),
    ("rate limits see the proxy, not the client", 'listener["x_forwarded"] = True', 'listener["x_forwarded"] = False',
     "Synapse rate limits must see each client"),
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
)


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

    for path, label in (
        (args.compose, "docker-compose.yml"),
        (args.env_example, ".env.example"),
        (args.caddyfile, "Caddyfile"),
    ):
        if not path.is_file():
            print(f"[FAIL] {label} not found: {path}", file=sys.stderr)
            return 1

    compose_text = args.compose.read_text(encoding="utf-8")
    env_text = args.env_example.read_text(encoding="utf-8")
    caddyfile_text = args.caddyfile.read_text(encoding="utf-8")

    policy_source = (ROOT / "deploy/community/configure_synapse.py").read_text(encoding="utf-8")
    source_errors = check_synapse_policy_source(policy_source) + check_synapse_config(policy_source)
    if source_errors:
        for error in source_errors:
            print("[FAIL] " + error, file=sys.stderr)
        return 1
    if args.selftest:
        for guard in ('kodera_synapse_policy.KoderaPolicy', 'room_access_user_id', '0.1.5'):
            if not check_synapse_policy_source(policy_source.replace(guard, "removed")):
                print("[FAIL] Synapse policy source mutation escaped", file=sys.stderr)
                return 1
        return (
            run_synapse_config_selftest(policy_source)
            or run_scaffolder_selftest()
            or run_selftest(compose_text, env_text, caddyfile_text)
        )

    errors = check_community_deploy(compose_text, env_text, caddyfile_text)
    errors += check_scaffolder_parity(*read_scaffolder_state())
    if args.preflight is not None:
        if not args.preflight.is_file():
            print(f"[FAIL] .env not found: {args.preflight}", file=sys.stderr)
            return 1
        errors += [f".env: {err}" for err in preflight_env(env_text, args.preflight.read_text(encoding="utf-8"))]
    if errors:
        for err in errors:
            print(f"[FAIL] {err}", file=sys.stderr)
        return 1

    print("OK: deploy/community passed all compose, .env.example, Caddyfile, Synapse and scaffolder parity checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

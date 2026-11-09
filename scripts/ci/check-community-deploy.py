#!/usr/bin/env python3
"""Validate deploy/community self-host stack invariants and ADR-0003 secret isolation.

With --preflight ENV_FILE it also checks an operator's own .env before `docker compose up`:
every key of .env.example is set, no CHANGE_ME_ placeholder is left, and KODERA_AUTH_TRUST
names at least one https issuer. It reports key names only, never a value.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
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
    "DJANGO_SECRET_KEY",
    "KODERA_CONTACT_SEAL_KEY",
    "KODERA_OUTBOX_SEAL_KEY",
    "KODERA_MEMBERSHIP_CURSOR_KEY",
    "KODERA_DISCOVERY_HMAC_KEY",
    "ROOM_ACCESS_MATRIX_TOKEN",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
)

HEALTHCHECK_REQUIRED_SERVICES = ("db", "valkey", "server", "synapse")

# Public configuration that has no usable default: the operator's own identity provider.
REQUIRED_PLACEHOLDER_KEYS = ("KODERA_AUTH_TRUST",)

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

    services = parse_compose_services(compose_text)
    for required_service in (
        "caddy",
        "db",
        "valkey",
        "migrate",
        "server",
        "web",
        "room-access",
        "synapse",
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
        for forbidden in ISOLATED_ROOM_ACCESS_SECRETS:
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

    # 3. Migration isolation: migrate uses Dockerfile.migrator with restart: "no"
    #    and server depends_on migrate with condition: service_completed_successfully
    migrate_svc = services.get("migrate")
    if migrate_svc is not None:
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
        if not re.search(
            r'"--provider-origin"\n\s*- "\$\{KODERA_OIDC_PROVIDER_ORIGIN:\?', web_block
        ):
            errors.append("service 'web' must pass --provider-origin from KODERA_OIDC_PROVIDER_ORIGIN")

    # The module is installed exclusively from the local, read-only tree on every start.
    synapse = services.get("synapse")
    if synapse is not None:
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

    # 5. Healthcheck coverage on db, valkey, server, synapse
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

    return errors


def check_synapse_policy_source(source: str) -> list[str]:
    required = (
        'MODULE = "kodera_synapse_policy.KoderaPolicy"',
        '"room_access_user_id": f"@kodera-rooms:{server}"',
        '"agent_user_id": f"@kodera-agent:{server}"',
        'version("kodera-synapse-policy") != "0.1.4"',
        'yaml.safe_dump(configure(document)',
    )
    return ["Synapse configuration missing policy guard: " + guard for guard in required if guard not in source]


def _deployable_issuer(issuer: object) -> bool:
    if not isinstance(issuer, str) or not issuer.startswith("https://"):
        return False
    host = issuer[len("https://") :].split("/", 1)[0].split(":", 1)[0].lower()
    return host not in {"", "localhost", "127.0.0.1", "::1", "[::1]"}


def preflight_env(env_example_text: str, env_text: str) -> list[str]:
    """Check an operator's .env against .env.example. Names keys, never values."""
    example, _ = parse_env_example(env_example_text)
    actual, parse_errors = parse_env_example(env_text)
    errors = [err.replace(".env.example", ".env").split(":", 1)[0] + ": malformed or duplicate" for err in parse_errors]
    for key in example:
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
            lambda c, e, cf: (re.sub(r"(?m)^      KODERA_AUTH_TRUST: .*\n", "", c, count=1), e, cf),
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
            print(f"[FAIL] preflight case '{label}' did not report '{expected}' (got {got})", file=sys.stderr)
            return 1
        if any("filled-value" in err or "example.net" in err for err in got):
            print(f"[FAIL] preflight case '{label}' printed a value: {got}", file=sys.stderr)
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
        f"{len(preflight_cases)} preflight cases reported."
    )
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
    source_errors = check_synapse_policy_source(policy_source)
    if source_errors:
        for error in source_errors:
            print("[FAIL] " + error, file=sys.stderr)
        return 1
    if args.selftest:
        for guard in ('kodera_synapse_policy.KoderaPolicy', 'room_access_user_id', '0.1.4'):
            if not check_synapse_policy_source(policy_source.replace(guard, "removed")):
                print("[FAIL] Synapse policy source mutation escaped", file=sys.stderr)
                return 1
        return run_selftest(compose_text, env_text, caddyfile_text)

    errors = check_community_deploy(compose_text, env_text, caddyfile_text)
    if args.preflight is not None:
        if not args.preflight.is_file():
            print(f"[FAIL] .env not found: {args.preflight}", file=sys.stderr)
            return 1
        errors += [f".env: {err}" for err in preflight_env(env_text, args.preflight.read_text(encoding="utf-8"))]
    if errors:
        for err in errors:
            print(f"[FAIL] {err}", file=sys.stderr)
        return 1

    print("OK: deploy/community passed all compose, .env.example, and Caddyfile checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

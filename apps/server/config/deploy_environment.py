"""Explicit redacted deployment inputs; no local/default infrastructure authority."""

import ipaddress
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import environ
from django.core.exceptions import ImproperlyConfigured

from config.environment import (
    INFRASTRUCTURE_NAMES,
    INFRASTRUCTURE_PREFIXES,
    NONCREDENTIAL_METADATA_NAMES,
    unadmitted_secret_names,
)

HOST = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z"
)

# The worker's connection, on top of the API's budget: a renewal blocked on a half-open TCP
# connection, where no server timeout fires, ends on the client's own clock. Keepalive probes after
# 5 s idle, 3 of them 2 s apart, and 10 s for unacknowledged data (worker/runner.py,
# database_budget_refusals, holds the sum to the lease).
WORKER_CONNECTION = {
    "keepalives": 1,
    "keepalives_idle": 5,
    "keepalives_interval": 2,
    "keepalives_count": 3,
    "tcp_user_timeout": 10000,
}


def refuse() -> None:
    raise ImproperlyConfigured("Deployment configuration refused")


def deployment(environment: Mapping[str, str]) -> dict[str, Any]:
    """The API's fixed deployment entry; never admits the operator selector."""
    return _deployment(environment, "config.settings.deploy")


def operator_deployment(environment: Mapping[str, str]) -> dict[str, Any]:
    """Separate command-only entry; no environment-selected settings fallback."""
    return _deployment(environment, "config.settings.deploy_operator")


def worker_deployment(environment: Mapping[str, str]) -> dict[str, Any]:
    """The worker's fixed entry: the same refusals and a database; it serves no HTTP, so it reads
    no host and no signing key."""
    _refuse_unsafe(environment, "config.settings.deploy_worker")
    database = _database(environment)
    database["OPTIONS"] = {**database["OPTIONS"], **WORKER_CONNECTION}
    return {"DATABASES": {"default": database}}


def _deployment(environment: Mapping[str, str], profile: str) -> dict[str, Any]:
    """No values or caller-supplied names are reflected into refusal diagnostics."""
    _refuse_unsafe(environment, profile)
    secret = environment.get("DJANGO_SECRET_KEY", "")
    if not 50 <= len(secret) <= 512 or len(set(secret)) < 8 or any(c.isspace() for c in secret):
        refuse()
    raw_hosts = environment.get("DJANGO_ALLOWED_HOSTS", "")
    hosts = raw_hosts.split(",")
    if (
        len(hosts) > 16
        or len(set(hosts)) != len(hosts)
        or not all(HOST.fullmatch(h) for h in hosts)
    ):
        refuse()
    # Explicit literals are useful for a private deployment; wildcard/suffix syntax is not.
    for host in hosts:
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            continue
        if address.is_unspecified:
            refuse()
    return {
        "SECRET_KEY": secret,
        "ALLOWED_HOSTS": hosts,
        "DATABASES": {"default": _database(environment)},
    }


def _refuse_unsafe(environment: Mapping[str, str], profile: str) -> None:
    """The refusals every deployed profile shares: no infrastructure credential name, no debug,
    no other selector, no server option and no fault control from the environment."""
    if any(
        name not in NONCREDENTIAL_METADATA_NAMES
        and (name.startswith(INFRASTRUCTURE_PREFIXES) or name in INFRASTRUCTURE_NAMES)
        for name in environment
    ):
        refuse()
    if unadmitted_secret_names(environment):
        refuse()
    if environment.get("DJANGO_DEBUG", "0") not in {"0", "false"}:
        refuse()
    if environment.get("DJANGO_SETTINGS_MODULE", profile) != profile:
        refuse()
    if any(name in environment for name in ("GUNICORN_CMD_ARGS", "FORWARDED_ALLOW_IPS")):
        refuse()
    # core/faults.py's out-of-process control is the test profile's alone: a deployed profile
    # refuses every name of it, whatever it holds.
    if any(name.startswith("KODERA_FAULT_") for name in environment):
        refuse()


def _database(environment: Mapping[str, str]) -> dict[str, Any]:
    url = environment.get("DATABASE_URL", "")
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or not parsed.hostname
            or not parsed.username
            or not parsed.password
            or not parsed.path.strip("/")
            or "/" in parsed.path[1:]
            or parsed.query
            or parsed.fragment
            or not 0 < (parsed.port or 5432) <= 65535
            or parsed.port == 0
        ):
            refuse()
        database = environ.Env.db_url_config(url)
    except (ValueError, TypeError):
        refuse()
        raise AssertionError("unreachable") from None
    database["CONN_MAX_AGE"] = 0
    database["OPTIONS"] = {"connect_timeout": 2, "options": "-c statement_timeout=2000"}
    return database

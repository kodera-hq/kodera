"""Refuse unsafe inputs before constructing local database settings."""

import ipaddress
import json
import re
import socket
import unicodedata
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import environ
from django.core.exceptions import ImproperlyConfigured

if TYPE_CHECKING:
    from services.identity.trusted_issuers import TrustedIssuer

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "api.localhost"}
# The one banned list of docs/dev/SETTINGS_AND_SECRETS.md §3 (ADR-0003): every API, operator and
# worker profile refuses these names at start. Core never reads a TF_ variable, so OpenTofu's whole
# prefix is refused (tokens, variables, the http backend's credentials); and so are the credentials
# of the state backends OpenTofu could use: AWS_ and SCW_ (s3), ARM_ (azurerm), GOOGLE_ (gcs),
# CONSUL_HTTP_ (consul) and PG_CONN_STR (pg).
INFRASTRUCTURE_PREFIXES = (
    "SCW_",
    "AWS_",
    "ARM_",
    "AZURE_",
    "SSH_",
    "AGE_",
    "SOPS_",
    "TF_",
    "GOOGLE_",
    "CONSUL_HTTP_",
)
# Installed CLI extension location, never read or used by this API.
NONCREDENTIAL_METADATA_NAMES = {"AZURE_EXTENSION_DIR"}
INFRASTRUCTURE_NAMES = {
    "ANSIBLE_PRIVATE_KEY_FILE",
    "KEYCLOAK_ADMIN",
    "KEYCLOAK_ADMIN_PASSWORD",
    "KEYCLOAK_CLIENT_SECRET",
    "KC_BOOTSTRAP_ADMIN_PASSWORD",
    "PG_CONN_STR",
}

# A deployed profile also refuses the names that select a credential file or a credential helper
# rather than hold one: an inherited selector keeps a readable credential within reach. Core reads
# none of them; its database credential is DATABASE_URL.
CREDENTIAL_FILE_SELECTORS = frozenset(
    {
        "KUBECONFIG",  # a cluster's credentials (kubectl, client libraries)
        "PGPASSFILE",  # libpq: a password file
        "PGSERVICEFILE",  # libpq: service definitions, passwords included
        "PGSSLKEY",  # libpq: a client certificate's private key
        "PGSSLCERT",  # libpq: the client certificate that key authenticates
        "DOCKER_CONFIG",  # the Docker CLI's directory, registry credentials included
        "DOCKER_CERT_PATH",  # the Docker daemon's client certificate and key
        "NETRC",  # machine logins and passwords (curl, requests)
        "GIT_ASKPASS",  # a program that answers Git's credential prompts
        "SSH_ASKPASS",  # the same for SSH (SSH_ is refused already)
        "GNUPGHOME",  # a GnuPG home, private keys included
        "CLOUDSDK_CONFIG",  # the Google Cloud SDK's directory, credentials included
    }
)
# PGSSLROOTCERT is left out: it names whom libpq trusts, not a credential.

# A deployed profile also refuses any environment name shaped like a credential that no list above
# names (a vault token, a DNS provider's API token, a forge token): the lists cannot enumerate every
# provider, the shape can. Admitted are only the secrets SETTINGS_AND_SECRETS.md §2 lets a Core
# process hold, each read by name, and the base image's public signing-key fingerprint.
# KEY counts as a word (`_KEY`, `KEYS_`, `APIKEY`), not a substring: KEYCLOAK_* names an origin.
SECRET_SHAPED_NAME = re.compile(
    r"(?:^|_)(?:API)?KEYS?(?:_|$)|APIKEY|SECRET|PASSW(?:OR)?D|TOKEN|CREDENTIAL|PRIVATE"
    r"|(?:^|_)PAT(?:_|$)"
)
ADMITTED_SECRET_NAMES = frozenset(
    {
        "DJANGO_SECRET_KEY",  # the application signing key
        "KODERA_NOTIFICATION_SEAL_KEY",  # sealed per-device application data
        "KODERA_PUSH_VAPID_PUBLIC_KEY",  # public P-256 discovery point
        "KODERA_CONTACT_SEAL_KEY",  # application secrets
        "KODERA_OUTBOX_SEAL_KEY",
        "KODERA_MEMBERSHIP_CURSOR_KEY",
        "KODERA_DISCOVERY_HMAC_KEY",
        "KODERA_STRIPE_SECRET_KEY",  # a restricted key, apps/billing/configuration.py
        "KODERA_STRIPE_WEBHOOK_SECRET",
        "KODERA_MAIL_SMTP_PASSWORD",  # transactional mail, the operator's sender
        "KODERA_REALM_WORKER_SECRET_DIR",  # a path to per-realm secrets, never a secret
        "GPG_KEY",  # python image: the fingerprint of CPython's release signing key
    }
)


def unadmitted_secret_names(environment: Mapping[str, str]) -> list[str]:
    """The environment names a deployed profile refuses beyond the banned list: the known
    credential-file selectors, and names shaped like a credential that are not admitted. It
    refuses the known credential names and shapes; it does not claim to exclude every credential.
    Names only, never a value."""
    return sorted(
        name
        for name in environment
        if name in CREDENTIAL_FILE_SELECTORS
        or (SECRET_SHAPED_NAME.search(name.upper()) and name not in ADMITTED_SECRET_NAMES)
    )


CONSOLE_CLIENT_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")


def console_client_id(environment: Mapping[str, str]) -> str | None:
    """The exact Console OAuth client identifier, with no fallback or normalization."""
    name = "KODERA_CONSOLE_CLIENT_ID"
    if name not in environment:
        return None
    value = environment[name]
    if CONSOLE_CLIENT_ID.fullmatch(value) is None:
        raise ImproperlyConfigured(
            "KODERA_CONSOLE_CLIENT_ID must be 1 to 128 ASCII letters, digits, dot, underscore, colon or hyphen"
        )
    return value


ALLOWED_OIDC_CLIENT_IDS_DEFAULT = "console,kodera-ios,kodera-android"


def allowed_oidc_client_ids(
    environment: Mapping[str, str], *, local_profile: bool = False
) -> tuple[str, ...]:
    """The OAuth clients whose tokens the customer lane admits, as the `azp` claim: the
    comma-separated KODERA_ALLOWED_OIDC_CLIENT_IDS (unset: the web console and the two native
    apps, ALLOWED_OIDC_CLIENT_IDS_DEFAULT), with KODERA_CONSOLE_CLIENT_ID added when it is set.
    Each entry is an exact client identifier, no normalization. A list that resolves to no client
    would refuse every customer token, so it stops the process unless the profile is a local one
    (`local_profile`, True only in the profiles of LOOPBACK_PROFILES). No value is reflected into
    a refusal."""
    raw = environment.get("KODERA_ALLOWED_OIDC_CLIENT_IDS", ALLOWED_OIDC_CLIENT_IDS_DEFAULT)
    clients = [entry.strip() for entry in raw.split(",") if entry.strip()]
    if any(CONSOLE_CLIENT_ID.fullmatch(client) is None for client in clients):
        raise ImproperlyConfigured(
            "KODERA_ALLOWED_OIDC_CLIENT_IDS is a comma-separated list of client identifiers, each "
            "1 to 128 ASCII letters, digits, dot, underscore, colon or hyphen"
        )
    console = console_client_id(environment)
    if console is not None:
        clients.append(console)
    if not clients and not local_profile:
        raise ImproperlyConfigured(
            "KODERA_ALLOWED_OIDC_CLIENT_IDS names no client, so every customer token would be "
            "refused; only a local profile may run with none"
        )
    return tuple(dict.fromkeys(clients))


def local_database(environment: Mapping[str, str]) -> dict[str, Any]:
    """Local/test only: known credentials fail even when declared empty."""
    refused = sorted(
        key if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key) else "<nonconventional name>"
        for key in environment
        if key not in NONCREDENTIAL_METADATA_NAMES
        and (key.startswith(INFRASTRUCTURE_PREFIXES) or key in INFRASTRUCTURE_NAMES)
    )
    if refused:
        raise ImproperlyConfigured(
            "API refuses infrastructure configuration: " + ", ".join(refused)
        )
    if environment.get("DJANGO_DEBUG", "0").lower() not in {"0", "false"}:
        raise ImproperlyConfigured("Unsafe local configuration: debug must be disabled")
    hosts = environment.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if not hosts or any(host not in LOCAL_HOSTS for host in hosts):
        raise ImproperlyConfigured("Unsafe local configuration: only local hosts are allowed")
    url = environment.get("DATABASE_URL", "postgres://kodera:kodera@localhost:5432/kodera_server")
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or parsed.hostname not in {"localhost", "127.0.0.1", "::1", "db"}
            or not parsed.username
            or not parsed.password
            or parsed.path != "/kodera_server"
            or parsed.query
            or parsed.fragment
            or not 0 < (5432 if parsed.port is None else parsed.port) <= 65535
        ):
            raise ValueError("unsupported local database")
        database = environ.Env.db_url_config(url)
    except ValueError:
        raise ImproperlyConfigured(
            "Unsafe local configuration: local PostgreSQL is required"
        ) from None
    database["CONN_MAX_AGE"] = 0
    database["OPTIONS"] = {"connect_timeout": 2, "options": "-c statement_timeout=2000"}
    return database


LEGAL_TEXT_HOST = re.compile(r"(?=.{1,253}\Z)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")


def legal_text_origin(environment: Mapping[str, str]) -> str | None:
    """The public origin Core's legal texts are read at, from KODERA_LEGAL_TEXT_ORIGIN.

    The permanent URL of an accepted text is this origin and the text's route
    (`getLegalDocumentText`), so it ends up in order confirmations: `https`, an ASCII DNS name
    (no IP literal), an optional port, nothing else. Unset or empty, no URL is given; anything
    else stops the process."""
    value = environment.get("KODERA_LEGAL_TEXT_ORIGIN", "").strip()
    if not value:
        return None
    refused = ImproperlyConfigured(
        "KODERA_LEGAL_TEXT_ORIGIN is https://<dns name>[:port], with no path, query or user"
    )
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise refused from None
    host = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or parsed.netloc.lower() != (host if port is None else f"{host}:{port}")
        or not LEGAL_TEXT_HOST.match(host)
        or (port is not None and not 1 <= port <= 65535)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise refused
    return f"https://{host}" + ("" if port is None else f":{port}")


def intake_admitted(environment: Mapping[str, str]) -> bool:
    """Whether this database admits the staff intake, from KODERA_INTAKE_ADMITTED.

    docs/specs/FIRST_OWNER_BOOTSTRAP.md §3.8: no organisation row on a live database before that
    database's ADR-0015 cutover is declared final. Unset, empty or `0`, the intake is refused; `1`
    admits it, and is set only by whoever declared the cutover final (or on a disposable database).
    Anything else is refused at start."""
    value = environment.get("KODERA_INTAKE_ADMITTED", "")
    if value in {"", "0"}:
        return False
    if value == "1":
        return True
    raise ImproperlyConfigured("KODERA_INTAKE_ADMITTED must be 1, 0 or unset")


def billing_enabled(environment: Mapping[str, str]) -> bool:
    """Whether Core bills, from KODERA_BILLING_ENABLED (docs/specs/QUICK_WORKSPACE.md §2).

    Unset or empty is `true`, today's behaviour, so a deployment stops billing only when someone
    sets `false`. With `false`, nothing that charges runs (placeOrder, createPaymentLink,
    settle_complimentary_order) and an owner creates a workspace in one step (createTenant).
    Anything other than `true`, `false` or empty is refused at start."""
    value = environment.get("KODERA_BILLING_ENABLED", "")
    if value in {"", "true"}:
        return True
    if value == "false":
        return False
    raise ImproperlyConfigured("KODERA_BILLING_ENABLED must be true, false or unset")


STAFF_REALM_SUFFIX = "/realms/kodera-staff"


# The settings modules that may trust a plain-http or loopback issuer, selected by
# DJANGO_SETTINGS_MODULE: the isolated test profile and the local end-to-end stack's API and
# operator commands (dev/e2e/compose.yaml). Every other profile, the deployable customer_http and
# job_queue among them, refuses one at start. The base profiles read the permission while they are
# imported, before a profile built on them could set it, so it is the selected module that decides.
LOOPBACK_PROFILES = frozenset(
    {"config.settings.test", "config.settings.e2e", "config.settings.e2e_operator"}
)


def loopback_profile(environment: Mapping[str, str]) -> bool:
    """Whether the selected settings module is one of LOOPBACK_PROFILES."""
    return environment.get("DJANGO_SETTINGS_MODULE") in LOOPBACK_PROFILES


# Names a resolver maps to the machine itself, besides `localhost` and the names under it.
LOOPBACK_NAMES = frozenset({"localhost.localdomain", "ip6-localhost", "ip6-loopback"})


def _ipv4(host: str) -> ipaddress.IPv4Address | None:
    """The IPv4 address a resolver reads `host` as, shorthand included: `127.1`, `2130706433`,
    `0x7f000001`, `0177.0.0.1` and `0` are all addresses to `inet_aton`, and to a resolver."""
    try:
        return ipaddress.IPv4Address(socket.inet_aton(host))
    except (OSError, ValueError, UnicodeError):
        return None


def is_loopback_host(hostname: str) -> bool:
    """A host that names the machine the process runs on, wherever that is: `localhost`, a name
    under `.localhost`, a resolver's other names for it, or a loopback or unspecified address in
    any spelling a resolver accepts — IPv4 shorthand, an IPv4-mapped or IPv4-compatible IPv6
    address, or compatibility characters such as full-width digits and letters (NFKC)."""
    host = unicodedata.normalize("NFKC", hostname).lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost") or host in LOOPBACK_NAMES:
        return True
    address: ipaddress.IPv4Address | ipaddress.IPv6Address | None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = _ipv4(host)
    if address is None:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        elif address.packed[:12] == bytes(12) and int(address) > 1:
            # IPv4-compatible (deprecated, RFC 4291 §2.5.5.1): ::127.0.0.1 carries 127.0.0.1.
            address = ipaddress.IPv4Address(address.packed[12:])
    return address.is_loopback or address.is_unspecified


def _deployable_issuer(issuer: str) -> bool:
    """An `https` issuer whose host is not the machine itself."""
    try:
        parsed = urlsplit(issuer)
        hostname = parsed.hostname
    except ValueError:
        return False
    return parsed.scheme == "https" and bool(hostname) and not is_loopback_host(hostname or "")


def auth_trust(
    environment: Mapping[str, str], *, loopback_issuers: bool = False
) -> "tuple[TrustedIssuer, ...]":
    """KODERA_AUTH_TRUST, parsed once at start. Every issuer must be an `https` URL of a host
    that is not the machine itself: a plain-`http` or loopback issuer is refused at start, unless
    the profile admits loopback issuers (`KODERA_LOOPBACK_ISSUERS`, True only in the profiles of
    LOOPBACK_PROFILES). The local fixtures' keys are derived from public labels, so a
    deployed trust that admitted one of their issuers would admit tokens anyone can sign.
    Every customer-lane issuer admits only the clients of `allowed_oidc_client_ids` as `azp`."""
    # Imported here: config.settings.dev imports this module and installs no identity code.
    from services.identity.trusted_issuers import load_trust

    trusted = load_trust(
        environment.get("KODERA_AUTH_TRUST"),
        allowed_azp=allowed_oidc_client_ids(environment, local_profile=loopback_issuers),
    )
    if not loopback_issuers and not all(
        _deployable_issuer(entry.snapshot.issuer) for entry in trusted
    ):
        raise ImproperlyConfigured(
            "KODERA_AUTH_TRUST admits a plain-http or loopback issuer, "
            "which only a local profile may trust"
        )
    return trusted


def staff_issuer(environment: Mapping[str, str], *, loopback_issuers: bool = False) -> str | None:
    """The one staff issuer, from KODERA_STAFF_ISSUER: an issuer of the staff realm `kodera-staff`,
    admitted on the `staff` lane of KODERA_AUTH_TRUST (docs/specs/STAFF_IDENTITY.md §1). Absent or
    empty, there is none and no staff identity can be granted a role or resolved. Anything else is
    refused at start. A plain-`http` or loopback issuer is refused too, unless the profile admits
    loopback issuers, and then `http` is admitted on a loopback host only (`auth_trust`)."""
    value = environment.get("KODERA_STAFF_ISSUER", "")
    if value == "":
        return None
    parsed = urlsplit(value)
    if (
        len(value) > 2048
        or parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.query
        or parsed.fragment
        or not parsed.path.endswith(STAFF_REALM_SUFFIX)
        or (parsed.scheme == "http" and parsed.hostname not in LOCAL_HOSTS)
    ):
        raise ImproperlyConfigured(
            "KODERA_STAFF_ISSUER must be one issuer URL of the staff realm `kodera-staff`"
        )
    if not loopback_issuers and not _deployable_issuer(value):
        raise ImproperlyConfigured(
            "KODERA_STAFF_ISSUER is a plain-http or loopback issuer, "
            "which only a local profile may trust"
        )
    trusted = auth_trust(environment, loopback_issuers=loopback_issuers)
    if not any(entry.lane == "staff" and entry.snapshot.issuer == value for entry in trusted):
        raise ImproperlyConfigured(
            "KODERA_STAFF_ISSUER is not on the staff lane of KODERA_AUTH_TRUST"
        )
    return value


TENANT_APP_CODES = frozenset({"visio", "docs", "drive", "messaging", "grist"})
# The template's host: `{slug}` once, as a whole label or its prefix, then ASCII DNS labels.
TENANT_APP_HOST = re.compile(
    r"(?=.{1,253}\Z)\{slug\}(?:-[a-z0-9-]{0,40}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\Z"
)


def tenant_app_urls(environment: Mapping[str, str]) -> dict[str, str]:
    """Each application's default URL template, from KODERA_TENANT_APP_URLS: a JSON object of
    app code to `https://{slug}.<dns name>`, where `{slug}` is the tenant's slug (the contract's
    `Tenant.default_urls`). Unset or empty, no tenant has a URL; anything malformed stops the
    process."""
    value = environment.get("KODERA_TENANT_APP_URLS", "").strip()
    if not value:
        return {}
    refused = ImproperlyConfigured(
        "KODERA_TENANT_APP_URLS is a JSON object of app code to https://{slug}.<dns name>"
    )
    try:
        parsed = json.loads(value)
    except ValueError:
        raise refused from None
    if not isinstance(parsed, dict):
        raise refused
    urls: dict[str, str] = {}
    for code, template in parsed.items():
        if code not in TENANT_APP_CODES or not isinstance(template, str):
            raise refused
        if not template.startswith("https://"):
            raise refused
        if not TENANT_APP_HOST.match(template.removeprefix("https://")):
            raise refused
        urls[code] = template
    return urls


TRUSTED_EDGE_MAX = 8


def trusted_edge(
    environment: Mapping[str, str],
) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    """The operator's edge proxies whose `X-Forwarded-For` Core believes, from
    KODERA_TRUSTED_EDGE_ADDRESSES (docs/specs/TRUSTED_EDGE.md): a comma-separated list of at most
    8 addresses or networks, each no wider than an IPv4 /24 or an IPv6 /120, with no host bits set:
    an edge is one or a few proxies, never a whole container network.
    Unset or empty, no edge is trusted and the client is the direct peer; anything else stops the
    process. No value is reflected into the refusal."""
    value = environment.get("KODERA_TRUSTED_EDGE_ADDRESSES", "").strip()
    if not value:
        return ()
    refused = ImproperlyConfigured(
        "KODERA_TRUSTED_EDGE_ADDRESSES is at most 8 comma-separated addresses or networks, "
        "each no wider than IPv4 /24 or IPv6 /120"
    )
    entries = value.split(",")
    if len(entries) > TRUSTED_EDGE_MAX:
        raise refused
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for entry in entries:
        try:
            network = ipaddress.ip_network(entry.strip(), strict=True)
        except ValueError:
            raise refused from None
        if network.prefixlen < (24 if network.version == 4 else 120):
            raise refused
        # A peer is compared as IPv4 once unmapped, so a mapped network could never match.
        if isinstance(network, ipaddress.IPv6Network) and network.network_address.ipv4_mapped:
            raise refused
        if network in networks:
            raise refused
        networks.append(network)
    return tuple(networks)


MUTATION_RATE_DEFAULT = 60
MUTATION_RATE_MAX = 6000


def mutation_rate_per_minute(environment: Mapping[str, str]) -> int:
    """How many writes one principal may send per rolling minute, from
    KODERA_MUTATION_RATE_PER_MINUTE (docs/specs/ABUSE_AND_ORIGIN_CONTROLS.md §2): a decimal
    integer from 1 to 6000. Unset or empty, the documented 60 (docs/api/CONVENTIONS.md §11).
    Nothing turns the bucket off: 0, a negative number and anything that is not a number stop the
    process. No value is reflected into the refusal."""
    value = environment.get("KODERA_MUTATION_RATE_PER_MINUTE", "").strip()
    if not value:
        return MUTATION_RATE_DEFAULT
    if re.fullmatch(r"[1-9][0-9]{0,3}", value) is None or int(value) > MUTATION_RATE_MAX:
        raise ImproperlyConfigured(
            "KODERA_MUTATION_RATE_PER_MINUTE is an integer from 1 to 6000; it cannot be disabled"
        )
    return int(value)

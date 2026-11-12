"""Install the mandatory Community Synapse configuration on fresh and existing volumes.

Every start rewrites the settings this stack relies on (Core ADR-0018): the room-policy
module, PostgreSQL, a closed federation, rate limits, refreshable tokens, OIDC-only
sign-in and the public base URL of the topology (README.md, "Topologies"). `scripts/ci/check-community-deploy.py` runs `configure` and refuses a change that
drops one of them.
"""

import copy
import sys
import os
import re
import tempfile
from importlib.metadata import version
from pathlib import Path


MODULE = "kodera_synapse_policy.KoderaPolicy"
DATABASE_HOST = "synapse-db"
# The one listener Caddy proxies to (`reverse_proxy synapse:8008`). Only this listener believes
# X-Forwarded-For, and Caddy overwrites that header with the peer address it accepted.
PROXIED_LISTENER_PORT = 8008
PUBLIC_DOMAIN = r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}"
PRIVATE_SUFFIXES = (".local", ".localhost", ".internal")
# Synapse's documented defaults, written out so that a later Synapse default cannot loosen them,
# with one exception: `rc_login.address`. The default (5 sign-ins, then one per 5.5 minutes per
# address) would lock out a team that shares one office address, and the web client signs in again
# on every reload. Password sign-in is off, so the only login an address can attempt is a
# single-use token Synapse itself issued after the identity provider authenticated the member:
# 20 sign-ins, then one every 6 seconds, leaves nothing to guess. Failed attempts and per-account
# sign-ins keep the default. `scripts/ci/check-community-deploy.py` refuses any looser value.
RATE_LIMITS = {
    "rc_message": {"per_second": 0.2, "burst_count": 10},
    "rc_registration": {"per_second": 0.17, "burst_count": 3},
    "rc_login": {
        "address": {"per_second": 0.17, "burst_count": 20},
        "account": {"per_second": 0.003, "burst_count": 5},
        "failed_attempts": {"per_second": 0.17, "burst_count": 3},
    },
    "rc_joins": {
        "local": {"per_second": 0.1, "burst_count": 10},
        "remote": {"per_second": 0.01, "burst_count": 10},
    },
    "rc_invites": {
        "per_room": {"per_second": 0.3, "burst_count": 10},
        "per_user": {"per_second": 0.003, "burst_count": 5},
        "per_issuer": {"per_second": 0.3, "burst_count": 10},
    },
}


TOPOLOGIES = ("single", "split")


def topology(environment):
    """`single` or `split`: the operator's setting, which must be what the running Compose files say."""
    chosen = environment.get("KODERA_TOPOLOGY") or "single"
    running = environment.get("KODERA_COMPOSE_TOPOLOGY") or "single"
    if chosen not in TOPOLOGIES or running not in TOPOLOGIES:
        raise ValueError("KODERA_TOPOLOGY must be single or split")
    if chosen != running:
        raise ValueError(
            "KODERA_TOPOLOGY does not match the Compose files: the split topology runs with docker-compose.split.yml"
        )
    return chosen


def federation_allowlist(environment):
    """The servers federation is opened to. Empty, the default, keeps federation closed."""
    names = [name.strip() for name in environment.get("KODERA_MATRIX_FEDERATION_ALLOWLIST", "").split(",")]
    names = sorted({name for name in names if name})
    for name in names:
        if not re.fullmatch(PUBLIC_DOMAIN, name) or name.endswith(PRIVATE_SUFFIXES):
            raise ValueError("KODERA_MATRIX_FEDERATION_ALLOWLIST must list public server names")
    return names


def oidc_issuer(environment):
    """The realm members sign in to Synapse with, or None when no sign-in is configured."""
    community = environment.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "")
    issuer = environment.get("KODERA_SYNAPSE_OIDC_ISSUER", "")
    secret = environment.get("KODERA_SYNAPSE_OIDC_CLIENT_SECRET", "")
    if community:
        canonical = environment.get("KODERA_DEFAULT_COMMUNITY_ISSUER", "")
        if community != "community" or not re.fullmatch(
            r"https://" + PUBLIC_DOMAIN + r"/realms/community", canonical
        ) or any(canonical.endswith(suffix + "/realms/community") for suffix in PRIVATE_SUFFIXES) or not secret or secret.startswith("CHANGE_ME_"):
            raise ValueError("Community Synapse requires canonical issuer and issued OIDC client credential")
        if issuer and issuer != canonical:
            raise ValueError("Community Synapse signs in at the canonical Community issuer only")
        return canonical
    if not issuer and not secret:
        return None
    if not re.fullmatch(r"https://" + PUBLIC_DOMAIN + r"(?:/[A-Za-z0-9._~/-]{0,512})?", issuer) or any(
        issuer.split("/")[2].endswith(suffix) for suffix in PRIVATE_SUFFIXES
    ) or not secret or secret.startswith("CHANGE_ME_"):
        raise ValueError("Synapse sign-in requires a public https issuer and its issued client credential")
    return issuer


def refuse_unported_sqlite(document, exists=os.path.exists):
    """An existing SQLite homeserver is never silently replaced by an empty PostgreSQL one."""
    database = document.get("database") or {}
    path = (database.get("args") or {}).get("database")
    if database.get("name") == "sqlite3" and isinstance(path, str) and exists(path):
        raise RuntimeError(
            "An existing SQLite Synapse database was found. Port it to PostgreSQL first "
            "(README.md, \"Synapse database\"); the stack no longer runs Synapse on SQLite."
        )


def configure(document, environment=None):
    environment = environment or {}
    server = document["server_name"]
    community = bool(environment.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG"))
    split = topology(environment) == "split"
    issuer = oidc_issuer(environment)
    allowlist = federation_allowlist(environment)

    document.setdefault("presence", {})["enabled"] = True
    modules = document.setdefault("modules", [])
    modules[:] = [item for item in modules if item.get("module") != MODULE]
    modules.append({"module": MODULE, "config": {
        "agent_user_id": f"@kodera-agent:{server}",
        "room_access_user_id": f"@kodera-rooms:{server}",
    }})

    # PostgreSQL only. The password is read by libpq from PGPASSWORD, never written here.
    document["database"] = {"name": "psycopg2", "args": {
        "user": "synapse", "database": "synapse", "host": DATABASE_HOST, "cp_min": 2, "cp_max": 10,
    }}

    # Federation is closed unless the operator lists the servers it is opened to.
    document["federation_domain_whitelist"] = allowlist
    document["allow_public_rooms_over_federation"] = False
    document["allow_public_rooms_without_auth"] = False
    if not allowlist:
        document["trusted_key_servers"] = []
        document["suppress_key_server_warning"] = True
    for listener in document.get("listeners") or []:
        if listener.get("type", "http") != "http":
            continue
        # Per-address rate limits must see each client, not the proxy, so the listener Caddy
        # targets reads X-Forwarded-For, which Caddy overwrites. No other listener may: a
        # listener reached without Caddy would believe whatever the caller sent.
        listener["x_forwarded"] = listener.get("port") == PROXIED_LISTENER_PORT
        for resource in listener.get("resources") or []:
            names = [name for name in resource.get("names") or [] if name != "federation"]
            resource["names"] = names + ["federation"] if allowlist else names

    for key, value in RATE_LIMITS.items():
        document[key] = copy.deepcopy(value)

    # Accounts come from the operator's identity provider only (Core ADR-0018).
    document["enable_registration"] = False
    document["password_config"] = {"enabled": False}
    # The web client keeps tokens in memory and refuses one that never expires.
    document["refreshable_access_token_lifetime"] = "5m"
    document["refresh_token_lifetime"] = "24h"
    document["forget_rooms_on_leave"] = True
    document["enable_authenticated_media"] = True
    document["encryption_enabled_by_default_for_room_type"] = "off"
    document["require_auth_for_profile_requests"] = True

    # The split topology publishes the client API on its own origin; the web client, where the
    # login token returns, stays at https://<server_name>/. A return to single drops that URL.
    split_baseurl = f"https://matrix.{server}/"
    if split:
        document["public_baseurl"] = split_baseurl
    elif document.get("public_baseurl") == split_baseurl:
        del document["public_baseurl"]

    if community and any(provider.get("idp_id") != "community" for provider in document.get("oidc_providers", [])):
        raise ValueError("Community Synapse requires one canonical identity provider")
    if issuer is not None:
        idp_id = "community" if community else "kodera"
        if any(provider.get("idp_id") != idp_id for provider in document.get("oidc_providers", [])):
            raise ValueError("Synapse sign-in refuses to replace an unrelated identity provider")
        document["public_baseurl"] = split_baseurl if split else f"https://{server}/"
        document["oidc_providers"] = [{
            "idp_id": idp_id, "idp_name": "Kodera Community" if community else "Kodera",
            "issuer": issuer, "client_id": "synapse",
            "client_secret": environment["KODERA_SYNAPSE_OIDC_CLIENT_SECRET"],
            "scopes": ["openid", "profile", "email"], "pkce_method": "always",
            "allow_existing_users": False, "backchannel_logout_enabled": True,
            "user_mapping_provider": {"config": {
                "subject_template": "{{ user.sub }}", "localpart_template": "{{ user.sub | lower }}",
                "confirm_localpart": False,
            }},
        }]
        # Synapse matches by prefix: without the trailing slash a look-alike origin gets the token.
        document["sso"] = dict(document.get("sso") or {}, client_whitelist=[f"https://{server}/"])
    return document


if __name__ == "__main__":
    import yaml

    if version("kodera-synapse-policy") != "0.1.5":
        raise RuntimeError("Community requires room-policy version 0.1.5")
    if not os.environ.get("PGPASSWORD") or os.environ["PGPASSWORD"].startswith("CHANGE_ME_"):
        raise RuntimeError("Synapse requires the PostgreSQL credential of its own database")
    config = Path(sys.argv[1])
    document = yaml.safe_load(config.read_text())
    refuse_unported_sqlite(document)
    # A unique mode-0600 file prevents a readable secret window or a stale symlink.
    with tempfile.NamedTemporaryFile("w", dir=config.parent, prefix=config.name + ".policy.", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(yaml.safe_dump(configure(document, os.environ), sort_keys=False))
            stream.flush()
            original = config.stat()
            temporary.chmod(0o600)
            if (temporary.stat().st_uid, temporary.stat().st_gid) != (original.st_uid, original.st_gid):
                os.chown(temporary, original.st_uid, original.st_gid)
            temporary.replace(config)
        finally:
            temporary.unlink(missing_ok=True)

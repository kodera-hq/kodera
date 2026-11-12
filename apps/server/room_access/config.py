"""room-access settings, read once from its environment. Secrets stay in that environment."""

import re
from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(Exception):
    pass


# An origin CORS may name: `https://host[:port]`, or plain http on the machine itself, which is how
# a local stack serves the Console. Lower case, no path, no query, no wildcard.
_HTTPS_ORIGIN = re.compile(r"https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?")
_LOOPBACK_ORIGIN = re.compile(r"http://(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?")


def _origins(value: str) -> frozenset[str]:
    """The exact origins the token listener answers CORS to. Each entry is a whole origin: `*`,
    `null`, a pattern, a path or an upper-case host is refused at start, since an entry that can
    never equal a browser's `Origin` header is a mistake, and a wildcard is never an origin."""
    entries = [entry.strip() for entry in value.split(",") if entry.strip()]
    if not entries or any(
        _HTTPS_ORIGIN.fullmatch(entry) is None and _LOOPBACK_ORIGIN.fullmatch(entry) is None
        for entry in entries
    ):
        raise ConfigError(
            "ROOM_ACCESS_ALLOWED_ORIGINS is a comma-separated list of exact origins, "
            "https://host[:port] each, never a wildcard"
        )
    return frozenset(entries)


def _grants_per_minute(value: str) -> int:
    if re.fullmatch(r"[1-9][0-9]{0,2}", value) is None or int(value) > 600:
        raise ConfigError("ROOM_ACCESS_GRANTS_PER_MINUTE is an integer from 1 to 600")
    return int(value)


def _matrix_user(value: str) -> str:
    local, _, server = value.partition(":")
    if not local.startswith("@") or len(local) < 2 or not server or any(c.isspace() for c in value):
        raise ConfigError("ROOM_ACCESS_AGENT_USER must be a full Matrix user ID, @name:server")
    return value


@dataclass(frozen=True)
class Config:
    synapse_url: str
    matrix_token: str  # room-access's own account: reads membership, writes occupancy only
    livekit_url: str  # the server API, on the VM's network
    livekit_ws_url: str  # what browsers connect to, behind the edge
    livekit_key: str
    livekit_secret: str
    allowed_origins: frozenset[str]
    # The tenant agent's account: the only sender whose room policy counts, and the only inviter
    # this service accepts.
    agent_user: str
    api_bind: str = "127.0.0.1"
    api_port: int = 8095
    webhook_bind: str = "127.0.0.1"
    webhook_port: int = 8096
    reconcile_s: float = 2.0
    token_ttl_s: int = 600
    # One identity's token requests per rolling minute (room_access/server.py GrantLimiter).
    grants_per_minute: int = 30

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Config":
        def need(name: str) -> str:
            value = env.get(name, "")
            if not value:
                raise ConfigError(f"{name} is required")
            return value

        return cls(
            synapse_url=need("ROOM_ACCESS_SYNAPSE_URL").rstrip("/"),
            matrix_token=need("ROOM_ACCESS_MATRIX_TOKEN"),
            livekit_url=need("LIVEKIT_URL").rstrip("/"),
            livekit_ws_url=need("LIVEKIT_WS_URL"),
            livekit_key=need("LIVEKIT_API_KEY"),
            livekit_secret=need("LIVEKIT_API_SECRET"),
            allowed_origins=_origins(need("ROOM_ACCESS_ALLOWED_ORIGINS")),
            agent_user=_matrix_user(need("ROOM_ACCESS_AGENT_USER")),
            api_bind=env.get("ROOM_ACCESS_API_BIND", "127.0.0.1"),
            api_port=int(env.get("ROOM_ACCESS_API_PORT", "8095")),
            webhook_bind=env.get("ROOM_ACCESS_WEBHOOK_BIND", "127.0.0.1"),
            webhook_port=int(env.get("ROOM_ACCESS_WEBHOOK_PORT", "8096")),
            reconcile_s=float(env.get("ROOM_ACCESS_RECONCILE_S", "2")),
            token_ttl_s=int(env.get("ROOM_ACCESS_TOKEN_TTL_S", "600")),
            grants_per_minute=_grants_per_minute(env.get("ROOM_ACCESS_GRANTS_PER_MINUTE", "30")),
        )

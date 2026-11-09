"""room-access settings, read once from its environment. Secrets stay in that environment."""

from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(Exception):
    pass


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
            allowed_origins=frozenset(
                o.strip() for o in need("ROOM_ACCESS_ALLOWED_ORIGINS").split(",") if o.strip()
            ),
            agent_user=_matrix_user(need("ROOM_ACCESS_AGENT_USER")),
            api_bind=env.get("ROOM_ACCESS_API_BIND", "127.0.0.1"),
            api_port=int(env.get("ROOM_ACCESS_API_PORT", "8095")),
            webhook_bind=env.get("ROOM_ACCESS_WEBHOOK_BIND", "127.0.0.1"),
            webhook_port=int(env.get("ROOM_ACCESS_WEBHOOK_PORT", "8096")),
            reconcile_s=float(env.get("ROOM_ACCESS_RECONCILE_S", "2")),
            token_ttl_s=int(env.get("ROOM_ACCESS_TOKEN_TTL_S", "600")),
        )

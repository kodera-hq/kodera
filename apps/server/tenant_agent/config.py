"""The agent's settings, read once from its environment. Secrets stay in that environment."""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


class ConfigError(Exception):
    pass


# The La Suite apps whose accounts the agent converges, named as the tenant record's `apps` names
# them (deployment profiles): `meet` is the app Kodera sells as Visio.
APPS = frozenset({"docs", "meet"})


@dataclass(frozen=True)
class Config:
    core_url: str
    token: str
    state_dir: Path
    compose_project: str
    livekit_url: str
    livekit_key: str
    livekit_secret: str
    # The apps this tenant runs: an engine it does not run is never asked, so its absence does
    # not fail every member set.
    apps: frozenset[str] = APPS
    docs_service: str = "docs-backend"
    meet_service: str = "meet-backend"
    docker_socket: str = "/var/run/docker.sock"
    webhook_port: int = 8090
    # The VM's internal address LiveKit reaches the agent on; never a public interface.
    webhook_bind: str = "0.0.0.0"  # noqa: S104 - overridden per VM by KODERA_WEBHOOK_BIND
    # Espace (ADR-0018): the VM's Synapse and the agent's server-administrator token. Without
    # them the agent does not take channel sets, and the member set skips Synapse.
    synapse_url: str = ""
    synapse_token: str = ""
    matrix_server_name: str = ""
    room_access_user: str = ""

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Config":
        def need(name: str) -> str:
            value = env.get(name, "")
            if not value:
                raise ConfigError(f"{name} is required")
            return value

        apps = frozenset(
            a.strip() for a in env.get("KODERA_APPS", "docs,meet").split(",") if a.strip()
        )
        if not apps:
            # No engine would be asked: without Synapse, every member set would succeed having
            # revoked nothing.
            raise ConfigError("KODERA_APPS names no app")
        if not apps <= APPS:
            raise ConfigError(f"KODERA_APPS names unknown apps: {sorted(apps - APPS)}")

        return cls(
            apps=apps,
            core_url=need("KODERA_CORE_URL").rstrip("/"),
            token=need("KODERA_AGENT_TOKEN"),
            state_dir=Path(need("KODERA_AGENT_STATE_DIR")),
            compose_project=need("KODERA_COMPOSE_PROJECT"),
            livekit_url=need("LIVEKIT_URL").rstrip("/"),
            livekit_key=need("LIVEKIT_API_KEY"),
            livekit_secret=need("LIVEKIT_API_SECRET"),
            docs_service=env.get("KODERA_DOCS_SERVICE", "docs-backend"),
            meet_service=env.get("KODERA_MEET_SERVICE", "meet-backend"),
            docker_socket=env.get("DOCKER_SOCKET", "/var/run/docker.sock"),
            webhook_port=int(env.get("KODERA_WEBHOOK_PORT", "8090")),
            webhook_bind=env.get("KODERA_WEBHOOK_BIND", "0.0.0.0"),  # noqa: S104
            synapse_url=env.get("KODERA_SYNAPSE_URL", "").rstrip("/"),
            synapse_token=env.get("KODERA_SYNAPSE_TOKEN", ""),
            matrix_server_name=env.get("KODERA_MATRIX_SERVER_NAME", ""),
            room_access_user=env.get("KODERA_ROOM_ACCESS_USER", ""),
        )

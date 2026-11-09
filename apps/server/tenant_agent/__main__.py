"""`python -m tenant_agent run` (the loop, the LiveKit webhook, the 15-minute re-application, the
5-minute guard sweep and the 30-second join of members who signed in), `once` (one poll, for cron)
or `reapply` (after a restore)."""

import logging
import os
import secrets
import sys
import threading
import time

from .agent import Agent
from .channels import Channels
from .config import APPS, Config, ConfigError
from .core_api import CoreApi, CoreUnavailableError
from .docker_exec import DockerExec, ExecError
from .engines import Docs, LiveKit, Meet
from .guard import RosterGuard
from .handlers import Handlers
from .state import State
from .synapse import Synapse
from .webhook import make_server

REAPPLY_S = 15 * 60  # ADR-0016: the set in force is re-applied every 15 minutes
SWEEP_S = 5 * 60  # and the roster guard sweeps every 5 minutes, webhook delivery being best effort
# A member's Synapse account exists only after their first sign-in to Espace, so the application
# that names them cannot join them yet. While anyone waits, the agent checks this often whether
# they have signed in, and joins them then: their channels open within a minute of first opening
# Espace, not at the next re-application.
JOIN_RETRY_S = 30


def refuse_unlisted_apps(runner: DockerExec, config: Config) -> None:
    """An app the tenant runs but KODERA_APPS omits would keep its accounts through every
    revocation while each member set reports success. Its container is enough to refuse."""
    services = {"docs": config.docs_service, "meet": config.meet_service}
    try:
        unlisted = sorted(a for a in APPS - config.apps if runner.exists(services[a]))
    except ExecError as exc:
        raise ConfigError(f"cannot check which apps the tenant runs: {exc}") from exc
    if unlisted:
        raise ConfigError(f"the tenant runs {unlisted}, which KODERA_APPS does not list")


def build(config: Config) -> tuple[Agent, RosterGuard, CoreApi]:
    runner = DockerExec(config.docker_socket, config.compose_project)
    refuse_unlisted_apps(runner, config)
    state = State(config.state_dir)
    meet = Meet(runner, config.meet_service) if "meet" in config.apps else None
    docs = Docs(runner, config.docs_service) if "docs" in config.apps else None
    livekit = LiveKit(config.livekit_url, config.livekit_key, config.livekit_secret)
    synapse = (
        Synapse(
            config.synapse_url,
            config.synapse_token,
            config.matrix_server_name,
            config.room_access_user or None,
        )
        if config.synapse_url and config.synapse_token and config.matrix_server_name
        else None
    )
    guard = RosterGuard(livekit, meet, state, synapse)
    channels = Channels(synapse, livekit, state) if synapse is not None else None
    handlers = Handlers(docs, meet, guard, state, synapse, channels)
    api = CoreApi(config.core_url, config.token, boot_id=secrets.token_hex(8))
    state.prune()
    return Agent(api, handlers, state), guard, api


class Periodic:
    """The loop's timed work, one tick at a time. A failure is logged and retried at its next
    tick; it never holds back the other work."""

    def __init__(self, agent: Agent, guard: RosterGuard, now: float) -> None:
        self._agent, self._guard = agent, guard
        self.next_reapply = self.next_sweep = self.next_join = now

    def run(self, now: float) -> None:
        log = logging.getLogger("tenant_agent")
        try:
            if now >= self.next_reapply:
                self.next_reapply, self.next_sweep = now + REAPPLY_S, now + SWEEP_S
                self.next_join = now + JOIN_RETRY_S
                self._agent.reapply()
            elif now >= self.next_sweep:
                self.next_sweep = now + SWEEP_S
                self._guard.enforce()
        except Exception:  # noqa: BLE001 - the loop must outlive any one bad pass
            log.exception("periodic convergence failed, retried at the next tick")
        try:
            if now >= self.next_join and self._agent.waiting:
                self.next_join = now + JOIN_RETRY_S
                self._agent.join_waiting()
        except Exception:  # noqa: BLE001 - as above
            log.exception("joining members who signed in failed, retried at the next tick")

    def sleep_s(self, poll_after_s: float) -> float:
        """Core's poll hint, cut to the join check's period while a member is waiting."""
        return min(poll_after_s, JOIN_RETRY_S) if self._agent.waiting else poll_after_s


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    mode = argv[1] if len(argv) > 1 else "run"
    try:
        config = Config.from_env(os.environ)
    except ConfigError as exc:
        print(f"tenant_agent: {exc}", file=sys.stderr)
        return 2
    try:
        agent, guard, api = build(config)
    except ConfigError as exc:
        print(f"tenant_agent: {exc}", file=sys.stderr)
        return 2
    if mode == "once":
        agent.poll_once()
        return 0
    if mode == "reapply":
        outcome = agent.reapply()
        return 0 if outcome is None or outcome.status == "succeeded" else 1
    if mode != "run":
        print("usage: python -m tenant_agent [run|once|reapply]", file=sys.stderr)
        return 2
    server = make_server(
        config.webhook_bind, config.webhook_port, guard, config.livekit_key, config.livekit_secret
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log = logging.getLogger("tenant_agent")
    periodic = Periodic(agent, guard, time.monotonic())
    while True:
        reported = 0
        try:
            reported = agent.poll_once(wait_s=0)
        except CoreUnavailableError:
            log.warning("core unavailable, retrying", exc_info=True)
        except Exception:  # noqa: BLE001 - the loop must outlive any one bad command
            log.exception("the command loop failed; it continues at the next tick")
        periodic.run(time.monotonic())
        if not reported:
            # Core answers at once (no long poll): wait for its hint before asking again.
            time.sleep(periodic.sleep_s(api.poll_after_s))


if __name__ == "__main__":
    sys.exit(main(sys.argv))

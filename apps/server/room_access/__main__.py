"""`python -m room_access`: the token and webhook listeners, and the reconciliation pass."""

import logging
import os
import sys
import threading
import time

from .clients import CoreAuthority, LiveKit, Matrix
from .config import Config, ConfigError
from .server import GrantLimiter, make_token_server, make_webhook_server
from .service import Service


def build_service(
    config: Config,
    *,
    matrix: Matrix | None = None,
    livekit: LiveKit | None = None,
) -> Service:
    """Construct the production `room_access` `Service` with authoritative confidential E2EE verification."""
    livekit_client = livekit or LiveKit(
        config.livekit_url, config.livekit_key, config.livekit_secret
    )
    matrix_client = matrix or Matrix(config.synapse_url, config.matrix_token)
    return Service(
        matrix_client,
        livekit_client,
        config.livekit_ws_url,
        config.agent_user,
        config.token_ttl_s,
        ai_users=config.ai_users,
        e2ee_room_ready=matrix_client.confidential_room_ready_checker(config.agent_user),
        authority=CoreAuthority(config.core_authority_origin, config.core_authority_token)
        if config.core_authority_origin
        else None,
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        config = Config.from_env(os.environ)
    except ConfigError as exc:
        print(f"room_access: {exc}", file=sys.stderr)
        return 2
    livekit = LiveKit(config.livekit_url, config.livekit_key, config.livekit_secret)
    matrix = Matrix(config.synapse_url, config.matrix_token)
    service = build_service(config, matrix=matrix, livekit=livekit)
    for server in (
        make_token_server(
            config.api_bind,
            config.api_port,
            service,
            config.allowed_origins,
            limiter=GrantLimiter(config.grants_per_minute),
        ),
        make_webhook_server(
            config.webhook_bind,
            config.webhook_port,
            livekit,
            service.on_webhook,
            matrix=matrix,
            agent_user=config.agent_user,
        ),
    ):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        service.reconcile_once()
        time.sleep(config.reconcile_s)


if __name__ == "__main__":
    sys.exit(main())

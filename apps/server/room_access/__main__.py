"""`python -m room_access`: the token and webhook listeners, and the reconciliation pass."""

import logging
import os
import sys
import threading
import time

from .clients import LiveKit, Matrix
from .config import Config, ConfigError
from .server import GrantLimiter, make_token_server, make_webhook_server
from .service import Service


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        config = Config.from_env(os.environ)
    except ConfigError as exc:
        print(f"room_access: {exc}", file=sys.stderr)
        return 2
    livekit = LiveKit(config.livekit_url, config.livekit_key, config.livekit_secret)
    service = Service(
        Matrix(config.synapse_url, config.matrix_token),
        livekit,
        config.livekit_ws_url,
        config.agent_user,
        config.token_ttl_s,
    )
    for server in (
        make_token_server(
            config.api_bind,
            config.api_port,
            service,
            config.allowed_origins,
            limiter=GrantLimiter(config.grants_per_minute),
        ),
        make_webhook_server(config.webhook_bind, config.webhook_port, livekit, service.on_webhook),
    ):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        service.reconcile_once()
        time.sleep(config.reconcile_s)


if __name__ == "__main__":
    sys.exit(main())

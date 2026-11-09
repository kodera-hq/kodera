#!/usr/bin/env bash
# Every Compose invocation uses only the generated fixture configuration.
set -euo pipefail
CORE_SRC=$(cd "${CORE_SRC:-$(dirname "$0")/../../../../../server}" && pwd)
export CORE_SRC COMPOSE_DISABLE_ENV_FILE=1
cd "$(dirname "$0")/.."
exec docker compose --env-file .runtime/config -f compose.yaml "$@"

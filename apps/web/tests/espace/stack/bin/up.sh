#!/usr/bin/env bash
# Start the real test stack with private, generated throwaway configuration.
set -euo pipefail
# Resolve before cd, including a caller's relative override.
CORE_SRC=$(cd "${CORE_SRC:-$(dirname "$0")/../../../../../server}" && pwd)
export CORE_SRC COMPOSE_DISABLE_ENV_FILE=1
cd "$(dirname "$0")/.."
test -f "$CORE_SRC/room_access/__main__.py" || { echo "CORE_SRC has no room_access/: $CORE_SRC" >&2; exit 1; }
umask 077
mkdir -p .runtime
# Keep this stack's database password when restarting it. Never inspect a developer environment.
touch .runtime/config
while IFS= read -r line; do
  case "$line" in
    '#'* | '') continue ;;
  esac
  name="${line%%=*}"
  grep -q "^${name}=" .runtime/config && continue
  case "$line" in
    *=CHANGE_ME) printf '%s=%s\n' "$name" "$(openssl rand -hex 24)" ;;
    *) printf '%s\n' "$line" ;;
  esac >> .runtime/config
done < env.example
bash bin/compose.sh up -d --wait
node bin/audio-accounts.mjs
bash bin/compose.sh --profile audio up -d --wait

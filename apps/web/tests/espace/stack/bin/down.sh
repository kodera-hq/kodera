#!/usr/bin/env bash
# Stop only this stack and delete its volumes and generated configuration.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .runtime/config ]; then
  bash bin/compose.sh --profile audio down --volumes --remove-orphans
  rm -rf .runtime .agent-state
fi

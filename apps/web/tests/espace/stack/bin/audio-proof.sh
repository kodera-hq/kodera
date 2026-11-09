#!/usr/bin/env bash
# One local/CI entry point owns startup, the focused real-service proof and teardown.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
cleanup() { bash tests/espace/stack/bin/down.sh; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
started=$SECONDS
bash tests/espace/stack/bin/up.sh
npx --no-install playwright test -c playwright.espace.config.ts tests/espace/audio/two-browsers.spec.ts -g 'automated two-person audio proof'
printf 'MEASURED audio stack startup and focused command: %s seconds\n' "$((SECONDS - started))"

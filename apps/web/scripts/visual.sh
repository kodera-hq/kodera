#!/usr/bin/env bash
# Runs the visual suite in the deterministic Linux container renderer
# (docs/dev/TESTING.md §7). Arguments pass through to Playwright:
#   npm run test:visual -- --update-snapshots
# node_modules is a container-only volume so host macOS binaries are untouched.
set -euo pipefail
REPO_ROOT="$(cd "$PWD/../.." && pwd)"
IMAGE='mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
exec docker run --rm --platform linux/amd64 --ipc=host \
  -v "$REPO_ROOT":/work -v /work/node_modules -w /work/apps/web "$IMAGE" \
  bash -c 'npm ci --ignore-scripts && npx playwright test -c playwright.visual.config.ts "$@"' bash "$@"

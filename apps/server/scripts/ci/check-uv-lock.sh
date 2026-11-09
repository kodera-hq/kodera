#!/usr/bin/env bash
# Fail when uv.lock no longer satisfies pyproject.toml.
#
# Every CI job installs with `uv sync --group dev`, which resolves again and
# silently repairs a stale lock in the runner. The Dockerfile installs with
# `uv sync --locked`, which refuses one. So a change to pyproject.toml without
# the matching lock (a Dependabot bump, a hand edit) kept CI green while the
# image could no longer be built from `main` (#113).
#
# Not `--offline`: a lock that disagrees with the manifest makes uv resolve
# again before it can say so, and with an empty cache an offline resolution
# fails with "No solution found" instead of naming the stale lock.
#
# The check runs with the uv release the Dockerfile pins, not the one CI
# happens to install. setup-uv installs the latest release, and an older uv
# can refuse a lock written by a newer one: a gate run with the latest uv
# could pass a lock the image's uv rejects. Reading the pin from the
# Dockerfile keeps the two in step through every Dependabot bump.
#
# Usage: check-uv-lock.sh [project-dir]   (default: the repository root)
#        The directory must hold pyproject.toml, uv.lock and the Dockerfile.
set -euo pipefail

usage="usage: check-uv-lock.sh [project-dir]"
if [ $# -gt 1 ] || [[ "${1:-}" == -* ]]; then
  echo "$usage" >&2
  exit 2
fi

dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

pin=$(sed -nE 's|^FROM ghcr\.io/astral-sh/uv:([0-9]+\.[0-9]+\.[0-9]+)[@ ].*|\1|p' "$dir/Dockerfile" 2>/dev/null || true)
if [ "$(printf '%s\n' "$pin" | grep -c .)" -ne 1 ]; then
  echo "cannot find exactly one uv version pinned in $dir/Dockerfile (FROM ghcr.io/astral-sh/uv:X.Y.Z)" >&2
  exit 1
fi

pinned_uv=(uvx --from "uv==$pin" uv)
# stderr apart: uvx reports its download there, and only stdout names the
# release that actually ran.
ran=$("${pinned_uv[@]}" --version) || { echo "cannot run uv $pin" >&2; exit 1; }
echo "checking with $ran, the release the Dockerfile pins"

if ! out=$("${pinned_uv[@]}" lock --check --project "$dir" 2>&1); then
  printf '%s\n' "$out"
  echo "uv.lock does not match pyproject.toml: run \`uv lock\` and commit uv.lock." >&2
  exit 1
fi
printf '%s\n' "$out"
echo "uv.lock matches pyproject.toml."

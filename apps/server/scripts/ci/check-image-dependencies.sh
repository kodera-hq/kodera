#!/usr/bin/env bash
# Fail when the image's `dependencies` stage does not build.
#
# check-uv-lock.sh proves uv.lock satisfies pyproject.toml with the uv release
# the Dockerfile's tag names, installed from PyPI. The image runs something
# else: the `/uv` that the Dockerfile's DIGEST selects, running
# `uv sync --locked --no-dev --python python3.12` on the image's platform. So a
# lock whose artifact hashes no longer match, an install that fails on that
# platform, or an image that cannot be pulled kept CI green while the image
# could not be built (#120). Building the stage runs exactly what the image runs.
#
# Docker resolves `FROM image:tag@sha256:...` by the digest alone and ignores
# the tag: a tag edited without its digest still builds. check-uv-lock.sh would
# then check with one uv while the image ships another. So the `uv` the BUILT
# stage puts on its PATH is asked its version and compared with the tag.
# Asking the `uv` stage instead would not prove that `COPY --from=` took the
# binary from there.
#
# This catches drift between the tag, the digest and the stage's binary. It
# does not defend against a Dockerfile written to run another uv during the
# build and hide it afterwards (a PATH changed and restored, a custom SHELL):
# no check from outside the build can, and review of the Dockerfile covers it.
#
# Usage: check-image-dependencies.sh [context-dir]   (default: the repository root)
#        The directory must hold the Dockerfile, pyproject.toml and uv.lock.
set -euo pipefail

usage="usage: check-image-dependencies.sh [context-dir]"
if [ $# -gt 1 ] || [[ "${1:-}" == -* ]]; then
  echo "$usage" >&2
  exit 2
fi

dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Stricter than check-uv-lock.sh on purpose. A tag without a digest has
# nothing to compare and leaves the image on a mutable reference. And the line
# read must be the stage named `uv`, the one built and asked below: reading a
# reference from any other stage would compare one image's tag with another
# image's binary.
pin=$(sed -nE 's|^FROM ghcr\.io/astral-sh/uv:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+uv[[:space:]]*$|\1|p' "$dir/Dockerfile" 2>/dev/null || true)
if [ "$(printf '%s\n' "$pin" | grep -c .)" -ne 1 ]; then
  echo "cannot find exactly one digest-pinned uv stage in $dir/Dockerfile (FROM ghcr.io/astral-sh/uv:X.Y.Z@sha256:<64 hex> AS uv)" >&2
  exit 1
fi

iid=$(mktemp)
trap 'rm -f "$iid"' EXIT

if ! out=$(docker build --progress=plain --iidfile "$iid" --target dependencies "$dir" 2>&1); then
  printf '%s\n' "$out"
  echo "the image's dependencies stage does not build: see the build output above." >&2
  exit 1
fi

ran=$(docker run --rm --entrypoint uv "$(cat "$iid")" --version) \
  || { echo "cannot run uv in the image's dependencies stage" >&2; exit 1; }
if [[ "$ran" != "uv $pin "* ]]; then
  echo "the Dockerfile tags uv $pin, but the dependencies stage runs $ran: update the tag and the digest together" >&2
  exit 1
fi
echo "the image's dependencies stage builds with $ran, the release its uv tag names."

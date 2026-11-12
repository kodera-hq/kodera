#!/usr/bin/env bash
# Hold every workspace copy of a contract to the bytes of the canonical one.
#
# packages/api-contract/ is the source. apps/server/contracts/ is what the
# contract change gate and the server tests read; apps/web/contracts/ is what
# the console generates its client and its mocks from. A copy that drifts by
# one byte gives one of them a contract nobody published, and each still
# passes its own checks against its own copy.
#
# Every file is compared, and every difference is named, before the script
# exits: a run that stopped at the first one would hide a second drifted copy.
# A missing file is a failure, never a skipped comparison.
#
# Usage: check-contract-parity.sh [repository-root]   (default: this checkout)
# Exit status: 0 when every copy is byte-identical, 1 when any differs or is
# missing, 2 when the arguments are wrong.
set -uo pipefail

usage="usage: check-contract-parity.sh [repository-root]"
if [ $# -gt 1 ] || [[ "${1:-}" == -* ]]; then
  echo "$usage" >&2
  exit 2
fi

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
canonical="packages/api-contract"
copies=("apps/server/contracts" "apps/web/contracts")
contracts=("core-api.openapi.yaml" "agent-api.openapi.yaml")

failed=0
compared=0
for name in "${contracts[@]}"; do
  if [ ! -f "$root/$canonical/$name" ]; then
    echo "PARITY: $canonical/$name is missing" >&2
    failed=1
    continue
  fi
  for copy in "${copies[@]}"; do
    if [ ! -f "$root/$copy/$name" ]; then
      echo "PARITY: $copy/$name is missing" >&2
      failed=1
    elif ! cmp -s "$root/$canonical/$name" "$root/$copy/$name"; then
      echo "PARITY: $copy/$name differs from $canonical/$name" >&2
      failed=1
    else
      compared=$((compared + 1))
    fi
  done
done

if [ "$failed" -ne 0 ]; then
  echo "contract parity FAILED: copy $canonical/ over the named file, never the other way round" >&2
  exit 1
fi
echo "contract parity passed: $compared copies byte-identical to $canonical/"

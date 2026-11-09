#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uv_command="${UV:-uv}"
"$uv_command" run python "$script_dir/check_contract_change_ci_selftest.py" "$@"

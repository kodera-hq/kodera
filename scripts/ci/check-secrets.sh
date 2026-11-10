#!/usr/bin/env bash
# A synthetic private key must be detected before a clean history can be trusted.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
openssl genrsa -traditional -out "$work/probe.key" 2048 2>/dev/null
set +e
gitleaks dir --no-banner --redact --exit-code 1 --report-format json \
  --report-path "$work/probe.json" "$work" > "$work/probe.log" 2>&1
status=$?
set -e
test "$status" -eq 1
python3 - "$work/probe.json" <<'CHECK'
import json, sys
rows = json.load(open(sys.argv[1]))
assert any(row["RuleID"] == "private-key" for row in rows), "RSA probe did not reach the private-key rule"
CHECK
gitleaks git --no-banner --redact --exit-code 1 --log-opts="--all" \
  --gitleaks-ignore-path "$root/.gitleaksignore" "$root"

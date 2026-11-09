#!/usr/bin/env bash
# Proves the contract lint probe can fail.
#
# The probe's job is to notice when the ruleset stops catching a stripped 400,
# and to notice it *by rule name*: a ruleset that exits 1 for some other reason
# is not catching the stripped 400 either. A probe that passes against a
# ruleset without the rule, or against one that fails for a different rule, is
# the decoration it exists to replace. So this runs the probe against
# `recommended` alone and expects the exit-code complaint; against
# `recommended` plus an unrelated error-severity rule and expects the
# rule-name complaint; against the repository ruleset and expects the success
# line; and against the repository ruleset under the variables the GitHub
# runner sets, where redocly colours its output even into a pipe, and expects
# the same success line. The last case is the runner's environment, not the
# author's shell, and it is the one that would have caught the first red run.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
probe="$here/prove-contract-lint-fails.sh"
repo_ruleset="$here/../../contracts/lint/redocly.yaml"

[ -x "$probe" ] || { echo "self-test FAILED: $probe is missing or not executable" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/contract-lint-probe-selftest.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# expect <want exit> <label> <config> <line the output must carry> [VAR=value ...]
# Extra arguments are placed in the probe's environment for that run only.
expect() {
  local want="$1" label="$2" config="$3" line="$4" got=0 out
  shift 4
  out="$(env "$@" CONTRACT_LINT_CONFIG="$config" "$probe" 2>&1)" || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "self-test FAILED: '$label' expected exit $want, got $got" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  if ! grep -qF "$line" <<<"$out"; then
    echo "self-test FAILED: '$label' exited $got without saying: $line" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '  ok  %-20s exit %s, says: %s\n' "$label" "$got" "$line"
}

echo "prove-contract-lint-fails self-test"

# No rule for the stripped 400: the lint passes and the probe must say so.
printf 'extends:\n  - recommended\n' > "$work/weakened.yaml"
expect 1 "weakened ruleset" "$work/weakened.yaml" \
  "probe FAILED: 'stripped-400-on-list' expected exit 1 from redocly, got 0"

# The lint fails, but for a rule that has nothing to do with the stripped 400
# (the contract's servers use example.com, which is a warning under
# `recommended`). An exit-code-only probe reports this as caught; the probe
# must name the rule it wanted and did not get.
printf 'extends:\n  - recommended\nrules:\n  no-server-example.com: error\n' > "$work/other-rule.yaml"
expect 1 "different rule" "$work/other-rule.yaml" \
  "probe FAILED: 'stripped-400-on-list' exited 1, but not from the rule/operation-with-parameters-declares-400 rule"

expect 0 "repository ruleset" "$repo_ruleset" \
  "contract lint probe: 4/4 mutations caught, each by the rule that names it"

# The GitHub runner sets both variables and redocly then colours its output
# even when captured; the rule name must still be matched.
expect 0 "runner environment" "$repo_ruleset" \
  "contract lint probe: 4/4 mutations caught, each by the rule that names it" \
  CI=true GITHUB_ACTIONS=true

echo "prove-contract-lint-fails self-test: 4/4 passed"

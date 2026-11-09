#!/usr/bin/env bash
# Proves the contract lint can fail, for the reasons the ruleset states.
#
# A linter nobody has watched fail is a decoration. Each case below writes a
# mutated copy of the contract outside the tree, lints it with the repository
# ruleset, and expects exit 1 *from the rule that names the mutation*: a
# missing binary or a broken config also exits non-zero, and that must not
# read as "the mutation was caught". The copies never touch contracts/, so the
# real lint step sees the committed files and nothing else.
#
# The cases that matter are the stripped 400s. Before the ruleset existed,
# deleting the '400' of a list operation lint-checked green, which is the
# gap the ruleset closes and the one this probe keeps closed.
#
# The rule name is matched on plain text. Redocly's colour library turns
# colour on whenever CI and GITHUB_ACTIONS are both set, captured pipe or
# not, and the name then arrives wrapped in escape sequences that a fixed
# string cannot match; the first run on the runner failed on exactly that.
# NO_COLOR is honoured by presence (FORCE_COLOR=0 forces colour *on*), so it
# is exported before any redocly call, and the captured output is stripped
# of escape sequences as well, so a library that stops honouring NO_COLOR
# does not put the probe back where it was.

set -euo pipefail

export NO_COLOR=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
lint_dir="$root/contracts/lint"
redocly="$lint_dir/node_modules/.bin/redocly"
config="${CONTRACT_LINT_CONFIG:-$lint_dir/redocly.yaml}"
contract="$root/contracts/core-api.openapi.yaml"

[ -x "$redocly" ] || { echo "probe FAILED: $redocly is missing; run 'npm ci --ignore-scripts' in contracts/lint" >&2; exit 1; }
[ -f "$config" ] || { echo "probe FAILED: ruleset $config is missing" >&2; exit 1; }
[ -f "$contract" ] || { echo "probe FAILED: $contract is missing" >&2; exit 1; }

# The binary that runs is the one the lockfile names, not whatever npx found.
locked="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/@redocly/cli"]["version"])' "$lint_dir/package-lock.json")"
installed="$("$redocly" --version)"
if [ "$installed" != "$locked" ]; then
  echo "probe FAILED: redocly $installed is installed but contracts/lint/package-lock.json pins $locked" >&2
  exit 1
fi
echo "contract lint probe: redocly $installed, the version contracts/lint/package-lock.json pins"

work="$(mktemp -d "${TMPDIR:-/tmp}/contract-lint-probe.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# mutate <case> <mode> [operationId]: writes $work/<case>.openapi.yaml, a copy
# of the contract with one thing broken or removed. Refuses to write a copy
# that is identical to the original.
mutate() {
  python3 - "$contract" "$work/$1.openapi.yaml" "$@" <<'PY'
import re
import sys

src, dst, case, mode = sys.argv[1:5]
text = open(src, encoding="utf-8").read()

if mode == "dangling-ref":
    needle = "'#/components/schemas/Problem'"
    if needle not in text:
        sys.exit(f"probe: {src} no longer references the Problem schema; pick another needle")
    broken = text.replace(needle, "'#/components/schemas/DoesNotExist'", 1)
    what = "the first $ref to Problem now points at DoesNotExist"
else:
    opid = sys.argv[5]
    lines = text.split("\n")
    starts = [i for i, line in enumerate(lines) if line == f"      operationId: {opid}"]
    if not starts:
        sys.exit(f"probe: {src} has no operation {opid}; pick another")
    start = starts[0]
    # An operation's lines sit at six spaces or deeper; the next shallower
    # non-blank line ends it. Response keys sit at eight spaces and a key's
    # continuation lines deeper still.
    end = next((i for i in range(start + 1, len(lines)) if lines[i] and not lines[i].startswith("      ")), len(lines))
    wanted = re.compile(r"^        '400':") if mode == "strip-400" else re.compile(r"^        '4\d\d':")
    keep, dropping, dropped = [], False, []
    for line in lines[start:end]:
        if wanted.match(line):
            dropping = True
            dropped.append(line.strip().split(":")[0].strip("'"))
            continue
        if dropping and line.startswith("         "):
            continue
        dropping = False
        keep.append(line)
    if not dropped:
        sys.exit(f"probe: {opid} declares nothing for {mode} to strip")
    broken = "\n".join(lines[:start] + keep + lines[end:])
    what = f"{opid} lost {', '.join(dropped)}"

if broken == text:
    sys.exit(f"probe: the {case} mutation changed nothing")
open(dst, "w", encoding="utf-8").write(broken)
print(f"  wrote   {case:<40} {what}")
PY
}

# strip_ansi: removes SGR escape sequences (ESC [ ... m) from stdin.
strip_ansi() {
  sed $'s/\x1b\\[[0-9;]*m//g'
}

# expect_caught <case> <rule>: the mutated copy fails the lint, by that rule.
expect_caught() {
  local case="$1" rule="$2" status=0 out
  # pipefail is set, so a non-zero exit from redocly survives the pipe.
  out="$("$redocly" lint --config "$config" "$work/$case.openapi.yaml" 2>&1 | strip_ansi)" || status=$?
  if [ "$status" -ne 1 ]; then
    echo "probe FAILED: '$case' expected exit 1 from redocly, got $status" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  if ! grep -qF "generated by the $rule rule." <<<"$out"; then
    echo "probe FAILED: '$case' exited 1, but not from the $rule rule" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '  caught  %-40s exit 1 from %s\n' "$case" "$rule"
}

mutate dangling-ref dangling-ref
expect_caught dangling-ref no-unresolved-refs

mutate stripped-400-on-list strip-400 listLegalDocuments
expect_caught stripped-400-on-list rule/operation-with-parameters-declares-400

mutate stripped-400-on-body strip-400 patchMe
expect_caught stripped-400-on-body rule/operation-with-request-body-declares-400

mutate stripped-every-4xx strip-4xx getMe
expect_caught stripped-every-4xx operation-4xx-response

echo "contract lint probe: 4/4 mutations caught, each by the rule that names it"

#!/usr/bin/env bash
# The expected messages quote identifiers in backticks, literally, as the check
# prints them; nothing in a single-quoted message is meant to expand.
# shellcheck disable=SC2016
# Prove check-advisories.py can fail, and fail for the reason it claims.
#
# Every case asserts the MESSAGE and the exact EXIT STATUS. The message because
# exit 1 is also what a typo in the script produces, so a suite reading only
# the status stays green once the check has quietly stopped checking; the
# status because that one bit is the whole of what CI consumes.
#
# The tools are stubbed rather than waited for. Each fixture directory carries
# a `bin/` with `uv`, `pip-audit` and `npm` stubs that print a canned report and
# exit with a chosen status, and the check runs from inside that directory: it
# audits the tree it is standing in and reads that tree's allowlist, so the
# fixture controls both halves of the judgement. The stubs also record the
# arguments they were given, so the clean case proves the gate asks for the
# dev group, the lockfile only, and an audit that resolves nothing.
#
# The libraries bundled in @redocly/cli are audited through the same `npm`
# stub: run from the fixture's contracts/lint it answers for the lockfile;
# run from anywhere else (the gate's throwaway lockfile directories,
# `bundled-1`, `bundled-2`) it answers from npm-<that directory>.out and
# keeps a copy of the lockfile it was handed, so a case can prove which
# name@version pairs went into which audit. The fixture's notices name four
# pairs: three packages, one of them at two versions, so two audits run.
#
# The real tree is not audited here: the CI step after this one does exactly
# that, with the real tools, and a finding on `main` would otherwise turn this
# proof red for a reason that is not about the proof.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
check="$here/scripts/ci/check-advisories.py"
work="$(mktemp -d "${TMPDIR:-/tmp}/check-advisories-selftest.XXXXXX")"
fails=0
cases=0

cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -r "$work"; }
trap cleanup EXIT

[ -f "$check" ] || {
  echo "check-advisories.selftest: FAIL: $check is missing" >&2
  exit 1
}

# --- canned reports ----------------------------------------------------------

lock() {
  cat <<'TOML'
version = 1
requires-python = "==3.12.*"

[[package]]
name = "probe-runtime"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "probe-devtool"
version = "2.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "probe-project"
version = "0.0.0"
source = { virtual = "." }
TOML
}

# The marker is real export output shape, and the stub below records whether
# the gate stripped it before handing the file to pip-audit.
export_ok() {
  printf '%s\n' 'probe-runtime==1.0.0' "probe-devtool==2.0.0 ; sys_platform == 'win32'"
}

pip_clean() {
  cat <<'JSON'
{"dependencies": [
  {"name": "probe-runtime", "version": "1.0.0", "vulns": []},
  {"name": "probe-devtool", "version": "2.0.0", "vulns": []}
], "fixes": []}
JSON
}

# A Python advisory against the dev-only package: the case this gate exists
# for, since a dev tool runs in CI with the repository's token.
pip_finding() {
  cat <<'JSON'
{"dependencies": [
  {"name": "probe-runtime", "version": "1.0.0", "vulns": []},
  {"name": "probe-devtool", "version": "2.0.0", "vulns": [
    {"id": "PYSEC-2099-1", "fix_versions": ["2.0.1"], "aliases": ["GHSA-q1q1-q2q2-q3q3"]}
  ]}
], "fixes": []}
JSON
}

# npm_report <severity> — one advisory against `probe-lib`, with
# `probe-consumer` vulnerable only through it: the shape npm actually emits.
npm_report() {
  local sev="$1" counts
  counts="\"info\": 0, \"low\": 0, \"moderate\": 0, \"high\": 0, \"critical\": 0"
  counts="${counts/\"$sev\": 0/\"$sev\": 2}"
  cat <<JSON
{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "probe-lib": {
      "name": "probe-lib", "severity": "$sev", "isDirect": false,
      "via": [{
        "source": 1105000, "name": "probe-lib", "dependency": "probe-lib",
        "title": "Prototype pollution in probe-lib",
        "url": "https://github.com/advisories/GHSA-p1p1-p2p2-p3p3",
        "severity": "$sev", "range": "<1.2.3"
      }],
      "effects": ["probe-consumer"], "range": "<1.2.3",
      "nodes": ["node_modules/probe-lib"], "fixAvailable": true
    },
    "probe-consumer": {
      "name": "probe-consumer", "severity": "$sev", "isDirect": true,
      "via": ["probe-lib"], "effects": [], "range": "*",
      "nodes": ["node_modules/probe-consumer"], "fixAvailable": true
    }
  },
  "metadata": {
    "vulnerabilities": { $counts, "total": 2 },
    "dependencies": { "prod": 1, "dev": 40, "optional": 0, "peer": 0, "peerOptional": 0, "total": 41 }
  }
}
JSON
}

npm_clean() {
  cat <<'JSON'
{
  "auditReportVersion": 2,
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": 0 },
    "dependencies": { "prod": 1, "dev": 40, "optional": 0, "peer": 0, "peerOptional": 0, "total": 41 }
  }
}
JSON
}

# The shape npm audit gives contracts/lint/package-lock.json from @redocly/cli
# 2.x on: one package, a dev dependency, nothing else in the tree.
npm_clean_one() {
  npm_clean | sed -e 's/"prod": 1, "dev": 40/"prod": 1, "dev": 1/' -e 's/"total": 41/"total": 1/'
}

# bundled_report <packages audited> [<severity> <package>] — the report for one
# throwaway lockfile of bundled libraries, clean or with one advisory.
bundled_report() {
  local total="$1" sev="${2:-}" pkg="${3:-}" counts
  counts="\"info\": 0, \"low\": 0, \"moderate\": 0, \"high\": 0, \"critical\": 0"
  if [ -z "$sev" ]; then
    cat <<JSON
{ "auditReportVersion": 2, "vulnerabilities": {},
  "metadata": { "vulnerabilities": { $counts, "total": 0 },
    "dependencies": { "prod": $((total + 1)), "dev": 0, "optional": 0, "peer": 0, "peerOptional": 0, "total": $total } } }
JSON
    return
  fi
  counts="${counts/\"$sev\": 0/\"$sev\": 1}"
  cat <<JSON
{ "auditReportVersion": 2,
  "vulnerabilities": {
    "$pkg": {
      "name": "$pkg", "severity": "$sev", "isDirect": true,
      "via": [{
        "source": 1106000, "name": "$pkg", "dependency": "$pkg",
        "title": "Credential leak in $pkg",
        "url": "https://github.com/advisories/GHSA-b1b1-b2b2-b3b3",
        "severity": "$sev", "range": ">=1.0.0 <3.0.0"
      }],
      "effects": [], "range": ">=1.0.0 <3.0.0",
      "nodes": ["node_modules/$pkg"], "fixAvailable": false
    }
  },
  "metadata": { "vulnerabilities": { $counts, "total": 1 },
    "dependencies": { "prod": $((total + 1)), "dev": 0, "optional": 0, "peer": 0, "peerOptional": 0, "total": $total } } }
JSON
}

# The notices file @redocly/cli ships, in the shape 2.59.0 writes it: a
# header, then sections, each a separator, a licence, `Packages:` and one
# indented name@version per line, then the licence text.
notices() {
  cat <<'TEXT'
Third-party software bundled in @redocly/cli

============================================================
MIT

Packages:
  probe-bundled@1.0.0 — Copyright (c) Probe
  @probe/scoped@2.0.0
  probe-twice@1.0.0

License text:
Permission is hereby granted, free of charge.

============================================================
ISC

Packages:
  probe-twice@2.0.0 — Copyright (c) Probe

License text:
Permission to use, copy, modify.
TEXT
}

# --- fixtures ----------------------------------------------------------------

# fixture <name> — a tree whose three tools are stubs printing <tool>.out and
# exiting <tool>.status, with every report clean and an empty allowlist. A case
# replaces whatever it is about.
fixture() {
  local dir="$work/$1" tool
  mkdir -p "$dir/bin" "$dir/contracts/lint"
  for tool in uv pip-audit npm; do
    cat > "$dir/bin/$tool" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$dir/$tool.argv"
if [ "$tool" = pip-audit ]; then
  while [ \$# -gt 0 ]; do
    if [ "\$1" = --requirement ]; then cp "\$2" "$dir/pip-audit.requirements"; fi
    shift
  done
fi
cat "$dir/$tool.out"
exit "\$(cat "$dir/$tool.status")"
STUB
    chmod +x "$dir/bin/$tool"
    echo 0 > "$dir/$tool.status"
  done
  # npm answers for the lockfile from contracts/lint, and for a throwaway
  # lockfile of bundled libraries from anywhere else.
  cat > "$dir/bin/npm" <<STUB
#!/usr/bin/env bash
here="\$(pwd -P)"
if [ "\$here" = "\$(cd "$dir/contracts/lint" && pwd -P)" ]; then
  as=npm
else
  as="npm-\$(basename "\$here")"
  cp package-lock.json "$dir/\$as.lock.json"
fi
printf '%s\n' "\$@" > "$dir/\$as.argv"
cat "$dir/\$as.out"
exit "\$(cat "$dir/\$as.status")"
STUB
  chmod +x "$dir/bin/npm"
  lock > "$dir/uv.lock"
  export_ok > "$dir/uv.out"
  pip_clean > "$dir/pip-audit.out"
  npm_clean > "$dir/npm.out"
  bundled_report 3 > "$dir/npm-bundled-1.out"
  bundled_report 1 > "$dir/npm-bundled-2.out"
  echo 0 > "$dir/npm-bundled-1.status"
  echo 0 > "$dir/npm-bundled-2.status"
  printf '{ "devDependencies": { "@redocly/cli": "9.9.9" } }\n' > "$dir/contracts/lint/package.json"
  printf '{ "lockfileVersion": 3, "packages": { "": {}, "node_modules/@redocly/cli": { "version": "9.9.9" } } }\n' \
    > "$dir/contracts/lint/package-lock.json"
  mkdir -p "$dir/contracts/lint/node_modules/@redocly/cli"
  printf '{ "name": "@redocly/cli", "version": "9.9.9" }\n' \
    > "$dir/contracts/lint/node_modules/@redocly/cli/package.json"
  notices > "$dir/contracts/lint/node_modules/@redocly/cli/THIRD_PARTY_NOTICES"
  # Shipped JavaScript that carries no library the notices omit.
  mkdir -p "$dir/contracts/lint/node_modules/@redocly/cli/lib/chunks"
  printf 'export const probe = 1;\n' > "$dir/contracts/lint/node_modules/@redocly/cli/lib/chunks/probe.js"
  printf '{ "advisories": [] }\n' > "$dir/advisory-allowlist.json"
}

# installed <fixture> — the fixture's installed @redocly/cli directory.
installed() { printf '%s' "$work/$1/contracts/lint/node_modules/@redocly/cli"; }

status() { echo "$2" > "$work/$1/$3.status"; }

run_case() {
  local dir="$work/$1"
  shift
  (cd "$dir" && env "PATH=$dir/bin:$PATH" python3 "$check" "$@" 2>&1)
}

# expect <name> <exit-status> <substring> <what it proves> [check arguments...]
expect() {
  local name="$1" want_rc="$2" want="$3" proves="$4" out rc
  shift 4
  cases=$((cases + 1))
  out=$(run_case "$name" "$@")
  rc=$?
  if [ "$rc" -ne "$want_rc" ]; then
    echo "FAIL [$name] expected exit $want_rc, got $rc — $proves"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
    return
  fi
  # A multi-line <substring> is several, each of which must be present.
  local line
  while IFS= read -r line; do
    if ! grep -qF -- "$line" <<< "$out"; then
      echo "FAIL [$name] exited $rc, but not for the stated reason — $proves"
      echo "  wanted the message to contain: $line"
      printf '%s\n' "$out" | sed 's/^/    /'
      fails=$((fails + 1))
      return
    fi
  done <<< "$want"
  printf '  ok  %-24s exit %s saying: %s\n' "$name" "$rc" "${want//$'\n'/ + }"
}

# entries <json objects...> — an allowlist holding exactly these entries.
entries() {
  local IFS=,
  printf '{ "advisories": [%s] }\n' "$*"
}

REASON='Accepted for the duration of the fixture: this entry is what a correctly bound exception looks like.'
NPM_BOUND="{\"ecosystem\": \"npm\", \"advisory\": \"GHSA-p1p1-p2p2-p3p3\", \"package\": \"probe-lib\", \"severity\": \"high\", \"range\": \"<1.2.3\", \"reason\": \"$REASON\"}"
PY_BOUND="{\"ecosystem\": \"pypi\", \"advisory\": \"PYSEC-2099-1\", \"package\": \"probe-devtool\", \"version\": \"2.0.0\", \"fix_versions\": [\"2.0.1\"], \"reason\": \"$REASON\"}"

echo "check-advisories self-test"
echo

# --- 1. a clean tree passes, having asked for the right things ---------------
# Without it every refusal below could come from a fixture broken before it was
# mutated. The recorded arguments bind the flags the gate's claims rest on.
fixture clean
expect clean 0 'OK — no blocking advisory is unaccounted for' \
  'a clean tree with an empty allowlist is accepted'
cases=$((cases + 1))
bound_ok=1
for want in uv:--frozen uv:--all-groups uv:--no-emit-project \
  pip-audit:--no-deps pip-audit:--disable-pip pip-audit:json \
  npm:--package-lock-only npm:--include=dev npm:--json \
  npm-bundled-1:--package-lock-only npm-bundled-1:--json \
  npm-bundled-2:--package-lock-only npm-bundled-2:--json; do
  grep -qxF -- "${want#*:}" "$work/clean/${want%%:*}.argv" 2>/dev/null || {
    echo "FAIL [arguments] ${want%%:*} was not given ${want#*:}"
    bound_ok=0
  }
done
if ! grep -qxF 'probe-devtool==2.0.0' "$work/clean/pip-audit.requirements" 2>/dev/null \
  || grep -qF ';' "$work/clean/pip-audit.requirements"; then
  echo "FAIL [arguments] pip-audit was not handed every pin with its marker stripped"
  bound_ok=0
fi
# Every bundled pair went into exactly one throwaway lockfile, the second
# version of probe-twice into the second.
if ! python3 - "$work/clean" <<'PY'
import json, sys
d = sys.argv[1]
def pins(n):
    lock = json.load(open(f"{d}/npm-bundled-{n}.lock.json"))
    return {k.removeprefix("node_modules/"): v["version"] for k, v in lock["packages"].items() if k}
assert pins(1) == {"probe-bundled": "1.0.0", "@probe/scoped": "2.0.0", "probe-twice": "1.0.0"}, pins(1)
assert pins(2) == {"probe-twice": "2.0.0"}, pins(2)
PY
then
  echo "FAIL [arguments] the bundled pairs were not split into the two lockfiles expected"
  bound_ok=0
fi
if [ "$bound_ok" -eq 1 ]; then
  printf '  ok  %-24s every tool was asked for the dev tree, the lock only, markers stripped; every bundled pair audited once\n' arguments
else
  fails=$((fails + 1))
fi

# --- 2. a blocking npm advisory nobody accounted for -------------------------
fixture npm-unlisted
npm_report high > "$work/npm-unlisted/npm.out"
status npm-unlisted 1 npm
expect npm-unlisted 1 'is `high` and is not in advisory-allowlist.json' \
  'a moderate-or-above npm advisory with no entry fails'

# --- 3. a Python advisory nobody accounted for -------------------------------
# pip-audit carries no severity, so there is no threshold to fall under.
fixture py-unlisted
pip_finding > "$work/py-unlisted/pip-audit.out"
status py-unlisted 1 pip-audit
expect py-unlisted 1 'carries no severity, so it blocks and is not in advisory-allowlist.json' \
  'an unrated Python advisory with no entry fails'

# --- 4-6. the npm entry moved under the excuse -------------------------------
fixture npm-moved-package
npm_report high > "$work/npm-moved-package/npm.out"
entries "${NPM_BOUND/\"probe-lib\"/\"some-other-lib\"}" > "$work/npm-moved-package/advisory-allowlist.json"
expect npm-moved-package 1 'was written for package `"some-other-lib"`, the audit now reports `"probe-lib"`' \
  'an excuse re-pointed at another package no longer describes the finding'

fixture npm-moved-severity
npm_report high > "$work/npm-moved-severity/npm.out"
entries "${NPM_BOUND/\"high\"/\"moderate\"}" > "$work/npm-moved-severity/advisory-allowlist.json"
expect npm-moved-severity 1 'was written for severity `"moderate"`, the audit now reports `"high"`' \
  'a raised severity must be decided again, not inherited'

fixture npm-moved-range
npm_report high > "$work/npm-moved-range/npm.out"
entries "${NPM_BOUND/<1.2.3/<1.0.0}" > "$work/npm-moved-range/advisory-allowlist.json"
expect npm-moved-range 1 'was written for range `"<1.0.0"`, the audit now reports `"<1.2.3"`' \
  'a widened or narrowed range is a different finding'

# --- 7-8. the Python entry moved under the excuse ----------------------------
fixture py-moved-version
pip_finding > "$work/py-moved-version/pip-audit.out"
entries "${PY_BOUND/\"2.0.0\"/\"1.9.0\"}" > "$work/py-moved-version/advisory-allowlist.json"
expect py-moved-version 1 'was written for version `"1.9.0"`, the audit now reports `"2.0.0"`' \
  'a lock bump that stays vulnerable is decided again'

fixture py-moved-fix
pip_finding > "$work/py-moved-fix/pip-audit.out"
entries "${PY_BOUND/\[\"2.0.1\"\]/[]}" > "$work/py-moved-fix/advisory-allowlist.json"
expect py-moved-fix 1 'was written for fix_versions `[]`, the audit now reports `["2.0.1"]`' \
  'a fix that appears after the excuse was written must be read, not inherited'

# --- 9. an exception with no written reason ----------------------------------
fixture no-reason
pip_finding > "$work/no-reason/pip-audit.out"
entries "${PY_BOUND/"$REASON"/   }" > "$work/no-reason/advisory-allowlist.json"
expect no-reason 1 'carries no reason' 'an exception without a written reason is a silent one'

# --- 10. an npm advisory that dropped below the threshold --------------------
# Refused before a single bound field is read: the entry is correctly bound at
# `high` and still fails, because it is to be deleted rather than re-bound.
fixture no-longer-blocking
npm_report low > "$work/no-longer-blocking/npm.out"
entries "$NPM_BOUND" > "$work/no-longer-blocking/advisory-allowlist.json"
expect no-longer-blocking 1 'blocks nothing — delete the entry' \
  'an entry cannot outlive the problem it describes'

# --- 11. a stale entry -------------------------------------------------------
fixture stale
entries "$PY_BOUND" > "$work/stale/advisory-allowlist.json"
expect stale 1 'Stale entries in advisory-allowlist.json' \
  'an excuse that matches no live finding fails'

# --- 12-13. unreadable reports -----------------------------------------------
fixture py-unreadable
printf 'Traceback (most recent call last):\nrequests.exceptions.ConnectionError: osv.dev\n' \
  > "$work/py-unreadable/pip-audit.out"
status py-unreadable 1 pip-audit
expect py-unreadable 1 'pip-audit produced no readable JSON' \
  'an unreadable Python report is not read as a clean tree'

fixture npm-unreadable
printf 'npm error code E401\nnpm error 401 Unauthorized\n' > "$work/npm-unreadable/npm.out"
status npm-unreadable 1 npm
expect npm-unreadable 1 'npm audit produced no readable JSON' \
  'an unreadable npm report is not read as a clean tree'

# --- 14-16. empty reports ----------------------------------------------------
fixture py-empty
printf '{"dependencies": [], "fixes": []}\n' > "$work/py-empty/pip-audit.out"
expect py-empty 1 'pip-audit audited no package at all' 'an empty Python report is not a clean one'

fixture npm-empty
npm_clean | sed 's/"total": 41/"total": 0/' > "$work/npm-empty/npm.out"
expect npm-empty 1 'npm audit audited no package at all' 'an empty npm report is not a clean one'

fixture npm-no-counts
printf '{ "auditReportVersion": 2, "vulnerabilities": {} }\n' > "$work/npm-no-counts/npm.out"
expect npm-no-counts 1 'An absent count is not a count of zero' \
  'a missing metadata block refuses rather than tallying zero'

# --- 17-20. the tools failed -------------------------------------------------
fixture py-exit-over-nothing
status py-exit-over-nothing 1 pip-audit
expect py-exit-over-nothing 1 'pip-audit exited 1 over a report that lists no advisory' \
  'a failed Python run does not pass as an empty one'

fixture npm-exit-over-nothing
status npm-exit-over-nothing 1 npm
expect npm-exit-over-nothing 1 'npm audit exited 1 over a report that lists no advisory' \
  'a failed npm run does not pass as an empty one'

fixture py-absent
expect py-absent 1 'could not run pip-audit at all' \
  'a missing auditor is not an audit that found nothing' \
  --pip-audit "$work/py-absent/bin/no-such-pip-audit"

fixture uv-fails
printf 'error: Unable to find lockfile\n' > "$work/uv-fails/uv.out"
status uv-fails 2 uv
expect uv-fails 1 'uv export exited 2' 'an export that failed audits nothing'

# --- 21-23. the audit saw less than the lock ---------------------------------
# The gate's whole decision is that a dev-only finding blocks; each of these
# would satisfy it vacuously.
fixture export-without-dev
printf 'probe-runtime==1.0.0\n' > "$work/export-without-dev/uv.out"
expect export-without-dev 1 'uv export did not list 1 package(s) uv.lock pins (probe-devtool)' \
  'an export without the dev group is refused'

fixture py-partial
printf '{"dependencies": [{"name": "probe-runtime", "version": "1.0.0", "vulns": []}], "fixes": []}\n' \
  > "$work/py-partial/pip-audit.out"
expect py-partial 1 'pip-audit did not report on 1 of the 2 exported package(s)' \
  'a package pip-audit dropped is not a package with no advisory'

fixture py-skipped
printf '%s\n' '{"dependencies": [{"name": "probe-runtime", "version": "1.0.0", "vulns": []},' \
  '{"name": "probe-devtool", "skip_reason": "could not be audited"}], "fixes": []}' \
  > "$work/py-skipped/pip-audit.out"
expect py-skipped 1 'pip-audit skipped `probe-devtool`' 'a skipped package refuses'

fixture npm-dev-omitted
npm_clean | sed 's/"dev": 40/"dev": 0/' > "$work/npm-dev-omitted/npm.out"
expect npm-dev-omitted 1 'dev was omitted from the audit' \
  'a dev-blind npm audit cannot prove a decision about dev findings'

# --- 24. an npm advisory with nothing to bind an entry to --------------------
fixture npm-unidentified
npm_report high | sed -e '/"source": 1105000,/d' -e '/"url":/d' > "$work/npm-unidentified/npm.out"
status npm-unidentified 1 npm
expect npm-unidentified 1 'carrying neither a GHSA url nor a numeric `source`' \
  'a finding with no identifier cannot be bound and is not skipped'

# --- 24a-d. an npm report whose shape this gate no longer reads -------------
# Each of these once printed OK: the vulnerable packages were there, and the
# loop that reads advisories out of them found nothing it recognised.
fixture npm-via-renamed
npm_report high | sed 's/"via":/"advisories":/' > "$work/npm-via-renamed/npm.out"
status npm-via-renamed 1 npm
expect npm-via-renamed 1 'lists `probe-lib` as vulnerable but its entry carries no `via` list' \
  'a renamed field is a report this gate cannot read, not a clean one'

fixture npm-entry-not-object
cat > "$work/npm-entry-not-object/npm.out" <<'JSON'
{
  "auditReportVersion": 2,
  "vulnerabilities": { "probe-lib": "high" },
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 1, "critical": 0, "total": 1 },
    "dependencies": { "prod": 1, "dev": 40, "optional": 0, "peer": 0, "peerOptional": 0, "total": 41 }
  }
}
JSON
status npm-entry-not-object 1 npm
expect npm-entry-not-object 1 'lists `probe-lib` as vulnerable with an entry that is not an object' \
  'an entry that cannot be read is not skipped'

fixture npm-count-mismatch
npm_report high | sed 's/"total": 2/"total": 3/' > "$work/npm-count-mismatch/npm.out"
status npm-count-mismatch 1 npm
expect npm-count-mismatch 1 'lists 2 vulnerable package(s) in `vulnerabilities` but counts 3' \
  'a map and a count that disagree are not evidence of anything'

fixture npm-no-advisory-read
npm_report high | python3 -c '
import json, sys
report = json.load(sys.stdin)
report["vulnerabilities"]["probe-lib"]["via"] = ["probe-consumer"]
print(json.dumps(report))' > "$work/npm-no-advisory-read/npm.out"
status npm-no-advisory-read 1 npm
expect npm-no-advisory-read 1 'lists 2 vulnerable package(s) and this gate read no advisory' \
  'vulnerable packages with no readable advisory do not pass as clean'

# --- 25-28. the allowlist itself ---------------------------------------------
fixture bad-allowlist
printf '{ "advisories": [ , ] }\n' > "$work/bad-allowlist/advisory-allowlist.json"
expect bad-allowlist 1 'is not readable JSON' 'an unreadable allowlist is not an empty one'

fixture duplicate
pip_finding > "$work/duplicate/pip-audit.out"
entries "$PY_BOUND" "$PY_BOUND" > "$work/duplicate/advisory-allowlist.json"
expect duplicate 1 'names pypi PYSEC-2099-1 twice' 'one advisory, one entry'

fixture bad-ecosystem
entries "${PY_BOUND/\"pypi\"/\"cargo\"}" > "$work/bad-ecosystem/advisory-allowlist.json"
expect bad-ecosystem 1 'carries an entry for ecosystem `cargo`' 'an ecosystem nothing audits is refused'

fixture unbindable-field
pip_finding > "$work/unbindable-field/pip-audit.out"
entries "${PY_BOUND/\"version\"/\"severity\": \"high\", \"version\"}" \
  > "$work/unbindable-field/advisory-allowlist.json"
expect unbindable-field 1 'carries severity, which a pypi report cannot bind' \
  'a severity on a Python entry would read as a decision nothing checks'

# --- 29-30. what passes ------------------------------------------------------
# Without these the allowlist could be dead code, and every binding case above
# would still pass; and a gate refusing everything would pass case 2.
fixture bound
npm_report high > "$work/bound/npm.out"
status bound 1 npm
pip_finding > "$work/bound/pip-audit.out"
status bound 1 pip-audit
entries "$NPM_BOUND" "$PY_BOUND" > "$work/bound/advisory-allowlist.json"
expect bound 0 '2 advisories — 0 fail, 2 allowed, 0 below' \
  'an entry bound to the finding it names is accepted, in both ecosystems'

fixture below-threshold
npm_report low > "$work/below-threshold/npm.out"
status below-threshold 1 npm
expect below-threshold 0 'below the moderate threshold; reported, not blocking' \
  'a low npm advisory is printed and does not block'

# --- 31-49. the libraries bundled in @redocly/cli ----------------------------
# From 2.x the linter declares no npm dependency, so its lockfile shows one
# package; what it carries is read from its THIRD_PARTY_NOTICES and audited
# through throwaway lockfiles. Each case below is one way that half could
# report clean having looked at less than the bundle holds.

BUNDLED_BOUND="{\"ecosystem\": \"npm\", \"advisory\": \"GHSA-b1b1-b2b2-b3b3\", \"package\": \"probe-bundled\", \"severity\": \"high\", \"range\": \">=1.0.0 <3.0.0\", \"reason\": \"$REASON\"}"

# The lockfile audit in the shape 2.x really gives it: one dev package.
fixture lock-2x-shape
npm_clean_one > "$work/lock-2x-shape/npm.out"
expect lock-2x-shape 0 'npm audit: 1 packages from contracts/lint/package-lock.json (1 dev), 0 vulnerable
bundled: 3 packages (4 name@version pairs) from @redocly/cli 9.9.9'"'"'s THIRD_PARTY_NOTICES, 2 npm audit run(s), 0 advisories' \
  'a one-package dev lockfile with a clean bundle passes, and says what it scanned'

fixture bundled-unlisted
bundled_report 3 high probe-bundled > "$work/bundled-unlisted/npm-bundled-1.out"
status bundled-unlisted 1 npm-bundled-1
expect bundled-unlisted 1 'in: bundled in @redocly/cli 9.9.9 at 1.0.0
is `high` and is not in advisory-allowlist.json' \
  'a blocking advisory in a bundled library nobody accounted for fails'

fixture bundled-second-version
bundled_report 1 high probe-twice > "$work/bundled-second-version/npm-bundled-2.out"
status bundled-second-version 1 npm-bundled-2
expect bundled-second-version 1 'in: bundled in @redocly/cli 9.9.9 at 2.0.0
is `high` and is not in advisory-allowlist.json' \
  'the second copy of a library bundled twice is audited, at its own version'

fixture bundled-bound
bundled_report 3 high probe-bundled > "$work/bundled-bound/npm-bundled-1.out"
status bundled-bound 1 npm-bundled-1
entries "$BUNDLED_BOUND" > "$work/bundled-bound/advisory-allowlist.json"
expect bundled-bound 0 '1 advisory — 0 fail, 1 allowed, 0 below
in: bundled in @redocly/cli 9.9.9 at 1.0.0' \
  'a bundled advisory with a bound entry is accepted by the same allowlist'

fixture bundled-moved-range
bundled_report 3 high probe-bundled > "$work/bundled-moved-range/npm-bundled-1.out"
status bundled-moved-range 1 npm-bundled-1
entries "${BUNDLED_BOUND/<3.0.0/<2.0.0}" > "$work/bundled-moved-range/advisory-allowlist.json"
expect bundled-moved-range 1 'was written for range `">=1.0.0 <2.0.0"`, the audit now reports `">=1.0.0 <3.0.0"`' \
  'a bundled entry is bound the same way as a lockfile one'

fixture bundled-stale
entries "$BUNDLED_BOUND" > "$work/bundled-stale/advisory-allowlist.json"
expect bundled-stale 1 'Stale entries in advisory-allowlist.json
FAIL  npm GHSA-b1b1-b2b2-b3b3 — nothing reports it any more' \
  'an entry for a bundled advisory the bundle no longer carries fails'

fixture bundled-not-installed
rm -r "$(installed bundled-not-installed)"
expect bundled-not-installed 1 '@redocly/cli is not installed in contracts/lint (run `npm ci --ignore-scripts` there)' \
  'a linter that is not installed is a bundle nobody looked at, not a clean one'

fixture bundled-other-version
printf '{ "name": "@redocly/cli", "version": "9.9.8" }\n' > "$(installed bundled-other-version)/package.json"
expect bundled-other-version 1 'holds @redocly/cli 9.9.8 but the lockfile pins 9.9.9' \
  'notices from another version describe another bundle'

fixture bundled-unpinned
printf '{ "lockfileVersion": 3, "packages": { "": {} } }\n' > "$work/bundled-unpinned/contracts/lint/package-lock.json"
expect bundled-unpinned 1 'does not say which @redocly/cli it pins' \
  'a lockfile that pins no linter gives the bundle nothing to be checked against'

fixture bundled-no-notices
rm "$(installed bundled-no-notices)/THIRD_PARTY_NOTICES"
expect bundled-no-notices 1 '@redocly/cli 9.9.9 ships no readable THIRD_PARTY_NOTICES' \
  'a missing list of bundled libraries refuses'

fixture bundled-empty-file
: > "$(installed bundled-empty-file)/THIRD_PARTY_NOTICES"
expect bundled-empty-file 1 'THIRD_PARTY_NOTICES does not open with `Third-party software bundled in @redocly/cli`' \
  'an empty notices file is not a bundle with nothing in it'

fixture bundled-header-only
printf 'Third-party software bundled in @redocly/cli\n' > "$(installed bundled-header-only)/THIRD_PARTY_NOTICES"
expect bundled-header-only 1 'yielded 0 bundled package(s) from 0 `Packages:` block(s) in 0 section(s). An empty or partly read list is not a clean one.' \
  'a notices file listing nothing refuses'

fixture bundled-unreadable-line
notices | sed 's|  @probe/scoped@2.0.0|  @probe/scoped at 2.0.0|' > "$(installed bundled-unreadable-line)/THIRD_PARTY_NOTICES"
expect bundled-unreadable-line 1 'lists a line this gate cannot read as name@version: `@probe/scoped at 2.0.0`' \
  'a line the reader cannot parse is not skipped'

# The second section's heading is renamed: its package sits outside any
# `Packages:` block, so a reader that only counted pairs would pass it by.
fixture bundled-section-unread
notices | awk '/^Packages:$/ { n++; if (n == 2) { print "Package list:"; next } } { print }' \
  > "$(installed bundled-section-unread)/THIRD_PARTY_NOTICES"
expect bundled-section-unread 1 'yielded 3 bundled package(s) from 1 `Packages:` block(s) in 2 section(s)' \
  'a section whose heading the reader does not know is not a section with nothing in it'

fixture bundled-empty-block
notices | sed '/  probe-twice@2.0.0/d' > "$(installed bundled-empty-block)/THIRD_PARTY_NOTICES"
expect bundled-empty-block 1 'has a `Packages:` block naming no package' \
  'an empty package block refuses'

fixture bundled-query-failed
printf 'npm error code ECONNREFUSED\nnpm error audit endpoint unreachable\n' > "$work/bundled-query-failed/npm-bundled-1.out"
status bundled-query-failed 1 npm-bundled-1
expect bundled-query-failed 1 'npm audit of the libraries bundled in @redocly/cli 9.9.9 produced no readable JSON' \
  'a query that failed is not a bundle with no advisory'

fixture bundled-query-error
printf '{ "error": { "code": "ENOAUDIT", "summary": "Your configured registry does not support audit requests." } }\n' \
  > "$work/bundled-query-error/npm-bundled-1.out"
status bundled-query-error 1 npm-bundled-1
expect bundled-query-error 1 'npm audit of the libraries bundled in @redocly/cli 9.9.9 returned an error instead of a report (Your configured registry' \
  'a registry that answers with an error is not a clean answer'

fixture bundled-exit-over-nothing
status bundled-exit-over-nothing 1 npm-bundled-2
expect bundled-exit-over-nothing 1 'npm audit of the libraries bundled in @redocly/cli 9.9.9 exited 1 over a report that lists no advisory' \
  'a failed bundled run does not pass as an empty one'

fixture bundled-partial
bundled_report 2 > "$work/bundled-partial/npm-bundled-1.out"
expect bundled-partial 1 'audited 2 package(s) of the 3 written into throwaway lockfile 1' \
  'an audit that covered fewer bundled libraries than it was given refuses'

# --- 50-53. a library the notices omit while the shipped code carries it -----
# From 2.71.0 the notices drop DOMPurify, which Redoc 3's prebuilt bundles
# still compile in. The gate reads its version from the licence banner.

DOMPURIFY_BANNER='/*! @license DOMPurify 3.4.16 | (c) Cure53 and other contributors */ t.version="3.4.16"; DOMPurify.sanitize'

fixture bundled-banner
printf '%s\n' "$DOMPURIFY_BANNER" > "$(installed bundled-banner)/lib/chunks/redoc.standalone.js"
bundled_report 4 high dompurify > "$work/bundled-banner/npm-bundled-1.out"
status bundled-banner 1 npm-bundled-1
expect bundled-banner 1 'THIRD_PARTY_NOTICES and the licence banners of dompurify@3.4.16, which the notices omit, 2 npm audit run(s)
in: bundled in @redocly/cli 9.9.9 at 3.4.16
is `high` and is not in advisory-allowlist.json' \
  'a library the notices omit is audited at the version its licence banner states'

fixture bundled-banner-unreadable
printf 'DOMPurify.sanitize(html);\n' > "$(installed bundled-banner-unreadable)/lib/chunks/redoc.standalone.js"
expect bundled-banner-unreadable 1 '@redocly/cli 9.9.9 still carries dompurify code, but neither its THIRD_PARTY_NOTICES nor a licence banner this gate can read gives its version' \
  'a library still in the code at a version nobody can read is not an absent one'

# Listed by the notices, it needs no banner: the refusal above is about the
# notices omitting it, not about the code naming it.
fixture bundled-banner-listed
notices | sed 's|  @probe/scoped@2.0.0|  @probe/scoped@2.0.0\n  dompurify@3.4.16|' > "$(installed bundled-banner-listed)/THIRD_PARTY_NOTICES"
printf 'DOMPurify.sanitize(html);\n' > "$(installed bundled-banner-listed)/lib/chunks/redoc.standalone.js"
bundled_report 4 > "$work/bundled-banner-listed/npm-bundled-1.out"
expect bundled-banner-listed 0 'bundled: 4 packages (5 name@version pairs) from @redocly/cli 9.9.9'"'"'s THIRD_PARTY_NOTICES, 2 npm audit run(s), 0 advisories' \
  'a library the notices list is read from the notices, banner or not'

fixture bundled-no-code
rm -r "$work/bundled-no-code/contracts/lint/node_modules/@redocly/cli/lib"
expect bundled-no-code 1 '@redocly/cli 9.9.9 ships no JavaScript under lib/ or bin/' \
  'a package with no code to look in is not a bundle that omits nothing'

echo
if [ "$fails" -ne 0 ]; then
  echo "check-advisories.selftest: $fails of $cases case(s) failed"
  exit 1
fi
echo "check-advisories.selftest: $cases cases OK"

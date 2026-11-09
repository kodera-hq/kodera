#!/usr/bin/env bash
# Prove scripts/check-audit.mjs can fail, and fail for the reason it claims.
#
# A gate nobody has watched reject a bad input is a comment, not a gate. Every
# case below asserts the MESSAGE, not the exit code: exit 1 is also what a typo
# in the script produces, so a suite that only reads the code stays green once
# the check has quietly stopped checking.
#
# The advisories are stubbed rather than waited for. `npm audit` on this tree
# reports nothing today — which is the point of landing the gate now — so the
# cases that matter would otherwise be untestable until the day they were
# needed. Each fixture directory carries a `bin/npm` that prints a canned
# report and exits with a chosen status, and the check is run from inside that
# directory: it audits the tree it is standing in and reads that tree's
# allowlist, so the fixture controls both halves of the judgement.
#
# The last case runs against the real tree, with the real npm and the real
# allowlist. A gate that refuses everything is not a gate either.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
check="$here/scripts/check-audit.mjs"
work="$(mktemp -d "${TMPDIR:-/tmp}/check-audit-selftest.XXXXXX")"
fails=0
cases=0

cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -r "$work"; }
trap cleanup EXIT

[ -f "$check" ] || {
  echo "check-audit.selftest: FAIL: $check is missing" >&2
  exit 1
}

# fixture <name> <npm-exit-status> — a directory with a stub npm on its PATH
# that prints <name>/report.json, plus an empty allowlist the case may replace.
fixture() {
  local name="$1" status="$2" dir="$work/$1"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/npm" <<STUB
#!/usr/bin/env bash
cat "$dir/report.json"
exit $status
STUB
  chmod +x "$dir/bin/npm"
  printf '{ "advisories": [] }\n' > "$dir/npm-audit-allowlist.json"
  printf '{ "lockfileVersion": 3, "packages": { "node_modules/probe-lib": { "version": "1.2.0", "resolved": "https://registry.npmjs.org/probe-lib/-/probe-lib-1.2.0.tgz", "integrity": "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==" } } }\n' > "$dir/package-lock.json"
}

run_case() {
  local dir="$1"
  (cd "$dir" && env "PATH=$dir/bin:$PATH" node "$check" 2>&1)
}

# expect_fail_saying <name> <substring> <what it proves>
expect_fail_saying() {
  local name="$1" want="$2" proves="$3" out rc
  cases=$((cases + 1))
  out=$(run_case "$work/$name")
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "FAIL [$name] expected a refusal, got exit 0 — $proves"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
    return
  fi
  if ! grep -qF -- "$want" <<< "$out"; then
    echo "FAIL [$name] refused, but not for the stated reason — $proves"
    echo "  wanted the message to contain: $want"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
    return
  fi
  printf '  ok  %-22s refused saying: %s\n' "$name" "$want"
}

# expect_pass_saying <name> <substring> <what it proves>
expect_pass_saying() {
  local name="$1" want="$2" proves="$3" out rc
  cases=$((cases + 1))
  out=$(run_case "$work/$name")
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "FAIL [$name] expected acceptance, got exit $rc — $proves"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
    return
  fi
  if ! grep -qF -- "$want" <<< "$out"; then
    echo "FAIL [$name] accepted, but without saying what it accepted — $proves"
    echo "  wanted the message to contain: $want"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
    return
  fi
  printf '  ok  %-22s accepted saying: %s\n' "$name" "$want"
}

# A high advisory against `probe-lib`, with `probe-consumer` vulnerable only
# through it — the shape npm audit actually emits, where the second package
# carries a package NAME in `via` rather than an advisory. Two vulnerable
# packages, one advisory: the two counts this gate prints separately.
high_report() {
  cat <<'JSON'
{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "probe-lib": {
      "name": "probe-lib",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1105000,
          "name": "probe-lib",
          "dependency": "probe-lib",
          "title": "Prototype pollution in probe-lib",
          "url": "https://github.com/advisories/GHSA-p1p1-p2p2-p3p3",
          "severity": "high",
          "range": "<1.2.3"
        }
      ],
      "effects": ["probe-consumer"],
      "range": "<1.2.3",
      "nodes": ["node_modules/probe-lib"],
      "fixAvailable": true
    },
    "probe-consumer": {
      "name": "probe-consumer",
      "severity": "high",
      "isDirect": true,
      "via": ["probe-lib"],
      "effects": [],
      "range": "*",
      "nodes": ["node_modules/probe-consumer"],
      "fixAvailable": true
    }
  },
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 2, "critical": 0, "total": 2 },
    "dependencies": { "prod": 1, "dev": 40, "optional": 0, "peer": 0, "peerOptional": 0, "total": 41 }
  }
}
JSON
}

# The same advisory, reported at `low`: under the threshold, so it is printed
# and blocks nothing. Written out rather than sed-ed off the report above,
# which would leave two `"low"` keys in the counts and make the fixture read
# like a mistake.
low_report() {
  cat <<'JSON'
{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "probe-lib": {
      "name": "probe-lib",
      "severity": "low",
      "isDirect": false,
      "via": [
        {
          "source": 1105000,
          "name": "probe-lib",
          "dependency": "probe-lib",
          "title": "Prototype pollution in probe-lib",
          "url": "https://github.com/advisories/GHSA-p1p1-p2p2-p3p3",
          "severity": "low",
          "range": "<1.2.3"
        }
      ],
      "effects": ["probe-consumer"],
      "range": "<1.2.3",
      "nodes": ["node_modules/probe-lib"],
      "fixAvailable": true
    },
    "probe-consumer": {
      "name": "probe-consumer",
      "severity": "low",
      "isDirect": true,
      "via": ["probe-lib"],
      "effects": [],
      "range": "*",
      "nodes": ["node_modules/probe-consumer"],
      "fixAvailable": true
    }
  },
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 2, "moderate": 0, "high": 0, "critical": 0, "total": 2 },
    "dependencies": { "prod": 1, "dev": 40, "optional": 0, "peer": 0, "peerOptional": 0, "total": 41 }
  }
}
JSON
}

clean_report() {
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

# entry <advisory> <package> <severity> <range> <reason>
entry() {
  cat <<JSON
{
  "advisories": [
    {
      "advisory": "$1",
      "package": "$2",
      "severity": "$3",
      "range": "$4",
      "reason": "$5",
      "installed": [{ "path": "node_modules/$2", "version": "1.2.0", "resolved": "https://registry.npmjs.org/probe-lib/-/probe-lib-1.2.0.tgz", "integrity": "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==" }]
    }
  ]
}
JSON
}

BOUND='Accepted for the duration of the fixture: this entry is what a correctly bound exception looks like.'

echo "check-audit self-test"
echo

# --- 1. a blocking advisory nobody has accounted for -------------------------
# The case B-no-audit-gate is about: an advisory in the tree and a green main.
fixture unlisted 1
high_report > "$work/unlisted/report.json"
expect_fail_saying unlisted \
  'is not in npm-audit-allowlist.json' \
  'a moderate-or-above advisory with no entry must fail'

# --- 2. the entry names a package the advisory no longer does ----------------
fixture rebound-package 1
high_report > "$work/rebound-package/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'some-other-lib' 'high' '<1.2.3' "$BOUND" \
  > "$work/rebound-package/npm-audit-allowlist.json"
expect_fail_saying rebound-package \
  'was written for package `some-other-lib`' \
  'an excuse re-pointed at another package no longer describes the finding'

# --- 3. the severity moved under the excuse ----------------------------------
fixture rebound-severity 1
high_report > "$work/rebound-severity/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'moderate' '<1.2.3' "$BOUND" \
  > "$work/rebound-severity/npm-audit-allowlist.json"
expect_fail_saying rebound-severity \
  'was written at severity `moderate`' \
  'a raised severity must be decided again, not inherited'

# --- 4. the vulnerable range moved under the excuse --------------------------
fixture rebound-range 1
high_report > "$work/rebound-range/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.0.0' "$BOUND" \
  > "$work/rebound-range/npm-audit-allowlist.json"
expect_fail_saying rebound-range \
  'was written for range `<1.0.0`' \
  'a widened or narrowed range is a different finding'

# --- 5. an exception with no written reason ----------------------------------
fixture no-reason 1
high_report > "$work/no-reason/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.2.3' '   ' \
  > "$work/no-reason/npm-audit-allowlist.json"
expect_fail_saying no-reason \
  'carries no reason' \
  'an exception without a written reason is a silent one'

# --- 6. the advisory has dropped below the threshold -------------------------
# Refused before a single bound field is read: such an entry is to be deleted,
# not re-bound. The entry below is correctly bound at `high` and still fails.
fixture no-longer-blocking 1
low_report > "$work/no-longer-blocking/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.2.3' "$BOUND" \
  > "$work/no-longer-blocking/npm-audit-allowlist.json"
expect_fail_saying no-longer-blocking \
  'blocks nothing — delete the entry' \
  'an entry cannot outlive the problem it describes'

# --- 7. an orphan entry ------------------------------------------------------
# Nothing reports it any more. Left in place it is a stale excuse waiting to be
# matched against a finding nobody decided.
fixture orphan 0
clean_report > "$work/orphan/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.2.3' "$BOUND" \
  > "$work/orphan/npm-audit-allowlist.json"
expect_fail_saying orphan \
  'Stale entries in npm-audit-allowlist.json' \
  'an excuse that matches no live finding must fail'

# --- 8. audit output that is not JSON ----------------------------------------
# `npm audit` exits non-zero whenever it finds anything, so a check that
# branched on the exit code before parsing would read this as a finding.
fixture unreadable 1
printf 'npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n' \
  > "$work/unreadable/report.json"
expect_fail_saying unreadable \
  'npm audit produced no readable JSON' \
  'an unreadable report must not be read as a clean tree'

# --- 9. a report carrying no counts ------------------------------------------
fixture no-counts 0
printf '{ "auditReportVersion": 2, "vulnerabilities": {} }\n' > "$work/no-counts/report.json"
expect_fail_saying no-counts \
  'An absent count is not a count of zero' \
  'a missing metadata block must refuse rather than tally zero'

# --- 10. a non-zero exit over a report that lists nothing ---------------------
# Read after the parse, never instead of it: the report and the exit code
# disagree, so neither is evidence.
fixture exit-over-nothing 1
clean_report > "$work/exit-over-nothing/report.json"
expect_fail_saying exit-over-nothing \
  'over a report that lists no advisory at all' \
  'a failed run must not pass as an empty one'

# --- 11. an advisory with nothing to bind an entry to ------------------------
# No GHSA url and no numeric source. Skipping it is how a finding this gate
# cannot judge becomes a finding it passes over.
fixture unidentified 1
cat > "$work/unidentified/report.json" <<'JSON'
{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "probe-lib": {
      "name": "probe-lib",
      "severity": "high",
      "isDirect": true,
      "via": [{ "name": "probe-lib", "title": "Something", "severity": "high", "range": "<1.2.3" }],
      "effects": [],
      "range": "<1.2.3",
      "nodes": ["node_modules/probe-lib"],
      "fixAvailable": false
    }
  },
  "metadata": {
    "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 1, "critical": 0, "total": 1 },
    "dependencies": { "prod": 1, "dev": 40, "optional": 0, "peer": 0, "peerOptional": 0, "total": 41 }
  }
}
JSON
expect_fail_saying unidentified \
  'carrying neither a GHSA url nor a numeric `source`' \
  'a finding with no identifier cannot be bound and must not be skipped'

# --- 12. an allowlist that cannot be read ------------------------------------
fixture bad-allowlist 0
clean_report > "$work/bad-allowlist/report.json"
printf '{ "advisories": [ , ] }\n' > "$work/bad-allowlist/npm-audit-allowlist.json"
expect_fail_saying bad-allowlist \
  'is not readable JSON' \
  'an unreadable allowlist is not an empty allowlist'

# --- 13. an audit that never looked at the dev tree --------------------------
# The decision this gate implements is that a dev-only finding blocks. An
# `omit=dev` in an .npmrc would satisfy it vacuously.
fixture dev-omitted 0
clean_report | sed 's/"dev": 40/"dev": 0/' > "$work/dev-omitted/report.json"
printf '{ "devDependencies": { "vitest": "^4.0.0" } }\n' > "$work/dev-omitted/package.json"
expect_fail_saying dev-omitted \
  'dev was omitted from the audit' \
  'a dev-blind audit cannot prove a decision about dev findings'

# --- 14. below the threshold: reported, and not blocking ---------------------
# The threshold is at `moderate`. A gate that refused everything would pass
# case 1 while telling a reader nothing true.
fixture below-threshold 1
low_report > "$work/below-threshold/report.json"
expect_pass_saying below-threshold \
  'below the moderate threshold; reported, not blocking' \
  'a low advisory is printed and does not block'

# --- 15. a correctly bound exception is accepted -----------------------------
# Without this the allowlist could be dead code and cases 2-5 would still pass.
fixture bound 1
high_report > "$work/bound/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.2.3' "$BOUND" \
  > "$work/bound/npm-audit-allowlist.json"
expect_pass_saying bound \
  'ALLOWED' \
  'an entry bound to the finding it names is accepted'

# A valid exception may span several occurrences and repeated nodes. Union the
# complete set rather than accepting only the first or refusing duplicates.
fixture union-bound 1
high_report > "$work/union-bound/report.json"
entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.2.3' "$BOUND" \
  > "$work/union-bound/npm-audit-allowlist.json"
node --input-type=module - "$work/union-bound" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const report = read('report.json'), list = read('npm-audit-allowlist.json'), lock = read('package-lock.json')
const extra = 'node_modules/consumer/node_modules/probe-lib'
report.vulnerabilities['probe-copy'] = { ...structuredClone(report.vulnerabilities['probe-lib']), nodes: [extra, 'node_modules/probe-lib'] }
list.advisories[0].installed.unshift({ ...list.advisories[0].installed[0], path: extra })
lock.packages[extra] = { ...lock.packages['node_modules/probe-lib'] }
for (const [name, value] of [['report.json', report], ['npm-audit-allowlist.json', list], ['package-lock.json', lock]]) writeFileSync(join(dir, name), JSON.stringify(value))
JS
expect_pass_saying union-bound 'ALLOWED' 'complete repeated advisory node sets bind independently of order'

# Complete installed bindings: every mutation starts from the accepted bound fixture.
installed_case() {
  local name="$1" want="$2"
  fixture "$name" 1
  high_report > "$work/$name/report.json"
  entry 'GHSA-p1p1-p2p2-p3p3' 'probe-lib' 'high' '<1.2.3' "$BOUND" \
    > "$work/$name/npm-audit-allowlist.json"
  node --input-type=module - "$work/$name" "$name" <<'JS'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
const [dir, kind] = process.argv.slice(2)
const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const report = read('report.json'), list = read('npm-audit-allowlist.json'), lock = read('package-lock.json')
const finding = report.vulnerabilities['probe-lib'], excuse = list.advisories[0]
const extra = 'node_modules/consumer/node_modules/probe-lib'
if (kind === 'extra-modern' || kind === 'extra-path') {
  finding.nodes.push(extra); lock.packages[extra] = { version: kind === 'extra-modern' ? '10.2.6' : '1.2.0' }
} else if (kind === 'changed-version') lock.packages['node_modules/probe-lib'].version = '10.2.6'
else if (kind === 'missing-lock-node') delete lock.packages['node_modules/probe-lib']
else if (kind === 'changed-integrity') lock.packages['node_modules/probe-lib'].integrity = lock.packages['node_modules/probe-lib'].integrity.replace('Vgj', 'Agj')
else if (kind === 'changed-source') lock.packages['node_modules/probe-lib'].resolved = 'https://example.test/probe-lib.tgz'
else if (kind === 'missing-integrity') delete lock.packages['node_modules/probe-lib'].integrity
else if (kind === 'missing-source') delete lock.packages['node_modules/probe-lib'].resolved
else if (kind === 'declared-integrity-drift') excuse.installed[0].integrity = excuse.installed[0].integrity.replace('Vgj', 'Agj')
else if (kind === 'declared-source-drift') excuse.installed[0].resolved = 'https://example.test/probe-lib.tgz'
else if (kind === 'declared-missing-integrity') delete excuse.installed[0].integrity
else if (kind === 'declared-missing-source') delete excuse.installed[0].resolved
else if (kind === 'malformed-integrity') excuse.installed[0].integrity = 'sha512-invalid'
else if (kind === 'malformed-source') excuse.installed[0].resolved = 42
else if (kind === 'bad-reason') excuse.reason = 42
else if (kind === 'missing-version') delete lock.packages['node_modules/probe-lib'].version
else if (kind === 'unreadable-version') lock.packages['node_modules/probe-lib'].version = 'not-a-version'
else if (kind === 'missing-nodes') delete finding.nodes
else if (kind === 'empty-nodes') finding.nodes = []
else if (kind === 'bad-nodes') finding.nodes = [42]
else if (kind === 'no-installed') delete excuse.installed
else if (kind === 'empty-installed') excuse.installed = []
else if (kind === 'bad-installed') excuse.installed[0].path = '../probe-lib'
else if (kind === 'duplicate-installed') excuse.installed.push({ ...excuse.installed[0] })
else if (kind === 'extra-installed') excuse.installed.push({ ...excuse.installed[0], path: extra })
else if (kind === 'duplicate-extra' || kind === 'duplicate-missing' || kind === 'metadata-conflict') {
  const copy = structuredClone(finding)
  if (kind === 'duplicate-extra') { copy.nodes = [extra]; lock.packages[extra] = { version: '10.2.6' } }
  else if (kind === 'duplicate-missing') delete copy.nodes
  else copy.via[0].range = '<2.0.0'
  report.vulnerabilities['probe-copy'] = copy
} else if (!['bad-lock', 'missing-lock', 'missing-packages'].includes(kind)) throw new Error('unknown mutation: '+kind)
if (kind === 'missing-packages') delete lock.packages
for (const [name, value] of [['report.json', report], ['npm-audit-allowlist.json', list], ['package-lock.json', lock]]) writeFileSync(join(dir, name), JSON.stringify(value))
if (kind === 'bad-lock') writeFileSync(join(dir, 'package-lock.json'), '{ invalid')
if (kind === 'missing-lock') unlinkSync(join(dir, 'package-lock.json'))
JS
  expect_fail_saying "$name" "$want" 'a changed or unreadable installed set must not inherit an exception'
}
installed_case extra-modern 'installed node set differs'
installed_case extra-path 'installed node set differs'
installed_case changed-version 'installed version changed'
installed_case changed-integrity 'installed provenance changed'
installed_case changed-source 'installed provenance changed'
installed_case missing-integrity 'unreadable installed provenance'
installed_case missing-source 'unreadable installed provenance'
installed_case declared-integrity-drift 'installed provenance changed'
installed_case declared-source-drift 'installed provenance changed'
installed_case declared-missing-integrity 'malformed installed binding'
installed_case declared-missing-source 'malformed installed binding'
installed_case malformed-integrity 'malformed installed binding'
installed_case malformed-source 'malformed installed binding'
installed_case bad-reason 'carries no reason'
installed_case missing-lock-node 'absent from package-lock.json'
installed_case missing-version 'unreadable installed version'
installed_case unreadable-version 'unreadable installed version'
installed_case missing-nodes 'missing or unreadable installed nodes'
installed_case empty-nodes 'missing or unreadable installed nodes'
installed_case bad-nodes 'missing or unreadable installed nodes'
installed_case no-installed 'installed bindings must be a nonempty array'
installed_case empty-installed 'installed bindings must be a nonempty array'
installed_case bad-installed 'malformed installed binding'
installed_case duplicate-installed 'duplicate installed binding'
installed_case extra-installed 'installed node set differs'
installed_case duplicate-extra 'installed node set differs'
installed_case duplicate-missing 'missing or unreadable installed nodes'
installed_case metadata-conflict 'conflicting metadata'
installed_case bad-lock 'package-lock.json is not readable'
installed_case missing-lock 'package-lock.json is not readable'
installed_case missing-packages 'package-lock.json has no packages map'

# --- 16. the real tree, the real npm, the real allowlist ---------------------
cases=$((cases + 1))
if real=$(cd "$here" && node "$check" 2>&1); then
  if grep -qF -- 'OK — no advisory at `moderate` or above is unaccounted for' <<< "$real"; then
    printf '  ok  %-22s accepted the real tree: %s\n' "real-tree" \
      "$(grep -F 'npm audit:' <<< "$real")"
  else
    echo "FAIL [real-tree] accepted, but without reporting what it read"
    printf '%s\n' "$real" | sed 's/^/    /'
    fails=$((fails + 1))
  fi
else
  echo "FAIL [real-tree] the real tree was refused"
  printf '%s\n' "$real" | sed 's/^/    /'
  fails=$((fails + 1))
fi

echo
if [ $fails -ne 0 ]; then
  echo "check-audit.selftest: $fails of $cases case(s) failed"
  exit 1
fi
echo "check-audit.selftest: $cases cases OK"

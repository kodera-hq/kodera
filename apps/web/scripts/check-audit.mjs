// Fail CI when a dependency advisory sits in this tree unaccounted for.
//
// Until this landed, `.github/workflows/ci.yml` ran no advisory check of any
// kind. A high-severity advisory therefore sat on a green `main` until
// Dependabot happened to open a pull request about it: nothing in the pipeline
// distinguished "no vulnerability" from "nobody looked". Tracked as
// `B-no-audit-gate`.
//
// One threshold, one mechanism, no hidden tier
// --------------------------------------------
// Any advisory at `moderate` or above fails this job, whether the affected
// package is a production or a development dependency. A dev dependency runs
// in CI with repository credentials and on every engineer's machine, so a tier
// that quietly does not block is the same "green control asserting less than a
// reader believes" this repository is trying to eliminate. Below the threshold
// an advisory is printed and does not block; that is the threshold doing its
// job, not a second tier, and the printed row is how it stays visible.
//
// An exception is never silent. It is an entry in `npm-audit-allowlist.json`
// with a written reason, and the entry is BOUND to the finding: package,
// severity and vulnerable range, keyed by advisory identifier. If any bound
// field moves, the entry no longer describes the finding and this gate fails
// rather than inheriting the old excuse. An entry naming an advisory no longer
// reported fails too, so a stale excuse cannot sit in the file waiting to cover
// something else. That is the same shape `kodera-design-tokens` uses for
// `contrast-known-failures.json` (`bindingProblem` in its
// `scripts/check-contrast.mjs`), deliberately, so the two repositories teach
// one idea rather than two.
//
// The rule splits at the threshold and only one half fires on any row: an
// advisory that no longer blocks is refused before a single bound field is
// read, because such an entry is to be deleted rather than re-bound.
//
// Parse first, then decide
// ------------------------
// `npm audit` exits non-zero whenever it finds ANYTHING, so a branch on the
// exit code before the report is parsed reads "there is a moderate advisory",
// "there is an informational advisory" and "the registry was unreachable" as
// the same event. Everything below reads the JSON first and judges afterwards.
// `scripts/check-audit.selftest.sh` holds the cases that would catch a
// regression back to that: an unparseable report, a report with no counts, and
// a non-zero exit over a report listing nothing.
//
// Two shapes are read out of `npm audit --json` and they are NOT the same
// number, so both are printed:
//   `metadata.vulnerabilities` counts VULNERABLE PACKAGES, which includes every
//     package pulled in by another package's advisory;
//   the `via` objects are the ADVISORIES themselves, and they are what carries
//     an identifier, a severity and a vulnerable range — the only things an
//     allowlist entry can be bound to.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const THRESHOLD = 'moderate'
const ORDER = ['info', 'low', 'moderate', 'high', 'critical']
const BLOCKS_AT = ORDER.indexOf(THRESHOLD)

// The tree audited is the tree you are standing in, and so is the allowlist
// that excuses it. There is no environment override: a knob that re-points the
// allowlist is a knob that turns this gate off.
const ROOT = process.cwd()
const FILE = 'npm-audit-allowlist.json'
const ALLOWLIST = join(ROOT, FILE)

/** A GHSA identifier as it appears in the advisory URL npm reports. */
const GHSA = /\/advisories\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})/i

/** Stop, having established nothing. Distinct from a judged failure below. */
function refuse(message, detail) {
  if (detail) process.stderr.write(`${String(detail).slice(0, 4000)}\n`)
  process.stderr.write(`check-audit: ${message}\n`)
  process.exit(1)
}

// `--include=dev` is not a no-op even though dev is audited by default: it
// overrides an `omit=dev` set in an .npmrc or in NPM_CONFIG_OMIT, which would
// otherwise drop every dev advisory from the report and make this gate quietly
// agree with a decision nobody took.
const run = spawnSync('npm', ['audit', '--json', '--include=dev'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (run.error) {
  refuse(
    `could not run npm audit at all (${run.error.message}). This job cannot claim a tree is clean when it never read it.`
  )
}

let report
try {
  report = JSON.parse(run.stdout)
} catch {
  refuse(
    'npm audit produced no readable JSON, so the advisories in this tree cannot be established. Refusing rather than assuming the tree is clean.',
    [run.stdout, run.stderr].filter(Boolean).join('\n')
  )
}

if (report && report.error) {
  const summary = report.error.summary ?? report.error.code ?? 'no summary'
  refuse(
    `npm audit returned an error instead of a report (${summary}). An audit that did not complete is not an audit that found nothing.`,
    report.error.detail
  )
}

const counts = report?.metadata?.vulnerabilities
if (!counts || typeof counts.total !== 'number') {
  refuse(
    'npm audit returned JSON that carries no `metadata.vulnerabilities` counts. An absent count is not a count of zero.',
    run.stdout
  )
}

const vulnerable = report.vulnerabilities
if (!vulnerable || typeof vulnerable !== 'object') {
  refuse(
    'npm audit returned JSON that carries no `vulnerabilities` map, so no advisory can be read out of it.',
    run.stdout
  )
}

// --- The advisories ----------------------------------------------------------
// Keyed by identifier and package: an entry in the map above may be vulnerable
// only because something it depends on is, in which case its `via` holds that
// package's NAME rather than an advisory, and the advisory is read from the
// entry that actually carries it.
const findings = new Map()

for (const entry of Object.values(vulnerable)) {
  for (const via of entry.via ?? []) {
    if (typeof via === 'string') continue

    const ghsa = typeof via.url === 'string' ? (via.url.match(GHSA)?.[1] ?? null) : null
    const id = ghsa ?? (typeof via.source === 'number' ? String(via.source) : null)
    const name = via.name ?? entry.name

    // Not skipped. A finding with no identifier cannot be bound to an entry,
    // and a row this gate cannot judge must not be a row it passes over.
    if (!id) {
      refuse(
        `npm audit reports an advisory against \`${name}\` carrying neither a GHSA url nor a numeric \`source\`, so it cannot be bound to an ${FILE} entry. The report shape has changed; read it before trusting this gate again.`,
        JSON.stringify(via, null, 2)
      )
    }
    if (!ORDER.includes(via.severity)) {
      refuse(
        `npm audit reports advisory ${id} at severity \`${via.severity}\`, which is not one of ${ORDER.join(', ')}. An unrecognised severity cannot be compared against the ${THRESHOLD} threshold.`
      )
    }
    if (typeof via.range !== 'string') {
      refuse(
        `npm audit reports advisory ${id} with no vulnerable \`range\`, so an allowlist entry has nothing to be bound to.`
      )
    }

    const key = `${id}::${name}`
    if (!findings.has(key)) {
      findings.set(key, {
        id,
        package: name,
        severity: via.severity,
        range: via.range,
        title: via.title ?? '',
        nodes: new Set(),
        unreadableNodes: false,
      })
    }
    const finding = findings.get(key)
    if (finding.severity !== via.severity || finding.range !== via.range) {
      refuse(
        `npm audit reports conflicting metadata for ${id} against \`${name}\`; duplicate occurrences cannot inherit the first occurrence's exception.`
      )
    }
    // Union BEFORE deduplication. A second occurrence may carry the newly
    // vulnerable copy that invalidates an otherwise exact legacy exception.
    if (
      !Array.isArray(entry.nodes) ||
      entry.nodes.length === 0 ||
      entry.nodes.some((node) => !validNode(node, name))
    ) {
      finding.unreadableNodes = true
    } else {
      for (const node of entry.nodes) finding.nodes.add(node)
    }
  }
}

// A report that exits non-zero over nothing is a run that failed for a reason
// the report does not carry. Read AFTER the parse, never instead of it.
if (run.status !== 0 && findings.size === 0 && counts.total === 0) {
  refuse(
    `npm audit exited ${run.status} over a report that lists no advisory at all. The exit code and the report disagree, so neither is evidence this tree is clean.`,
    [run.stdout, run.stderr].filter(Boolean).join('\n')
  )
}

// The decision this gate implements is that a dev-only finding blocks. A run
// that audited no dev dependencies at all would satisfy it vacuously.
const declaredDev = existsSync(join(ROOT, 'package.json'))
  ? Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies ?? {})
      .length
  : 0
const auditedDev = report.metadata?.dependencies?.dev ?? 0
if (declaredDev > 0 && auditedDev === 0) {
  refuse(
    `package.json declares ${declaredDev} devDependencies and npm audit reported 0 development dependencies, so dev was omitted from the audit. This gate's whole decision is that a dev-only finding blocks; an audit that cannot see dev proves nothing.`
  )
}

// --- The allowlist -----------------------------------------------------------
let allowlist = { advisories: [] }
const hasAllowlist = existsSync(ALLOWLIST)
if (hasAllowlist) {
  try {
    allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'))
  } catch (error) {
    refuse(
      `${FILE} is not readable JSON (${error.message}). An allowlist that cannot be read is not an empty allowlist.`
    )
  }
  if (!Array.isArray(allowlist.advisories)) {
    refuse(`${FILE} carries no \`advisories\` array, so no exception in it can be read.`)
  }
}

const allowed = new Map()
for (const entry of allowlist.advisories ?? []) {
  if (typeof entry.advisory !== 'string' || !entry.advisory.trim()) {
    refuse(
      `${FILE} carries an entry with no \`advisory\` identifier, so nothing binds it to a finding.`,
      JSON.stringify(entry, null, 2)
    )
  }
  if (allowed.has(entry.advisory)) {
    refuse(
      `${FILE} names ${entry.advisory} twice. Two entries for one advisory means one of them is never read, and an unread excuse is a reason nobody reviewed.`
    )
  }
  allowed.set(entry.advisory, { ...entry, used: false })
}

/**
 * Why an allowlist entry does not describe the finding it names, or null when
 * it does. Every field an entry carries is checked, so the entry describes the
 * advisory as npm audit reports it today rather than as it stood when someone
 * wrote the excuse.
 *
 * Reached only for a finding that still blocks. One that has dropped below the
 * threshold is refused earlier, by the rule that an entry cannot outlive the
 * problem it describes; the two are one rule split at the threshold, not two
 * verdicts on the same row.
 */
function bindingProblem(excuse, finding) {
  if (typeof excuse.reason !== 'string' || !excuse.reason.trim()) {
    return `${FILE} entry carries no reason — an exception without a written reason is a silent one`
  }
  if (excuse.package !== finding.package) {
    return `${FILE} entry was written for package \`${excuse.package}\`, npm audit now reports \`${finding.package}\` — a different finding, not the one excused`
  }
  if (excuse.severity !== finding.severity) {
    return `${FILE} entry was written at severity \`${excuse.severity}\`, npm audit now reports \`${finding.severity}\` — decide the new severity, do not inherit the old reason`
  }
  if (excuse.range !== finding.range) {
    return `${FILE} entry was written for range \`${excuse.range}\`, npm audit now reports \`${finding.range}\` — the advisory moved under the excuse`
  }
  return installedProblem(excuse, finding)
}

function validNode(path, name) {
  return (
    typeof path === 'string' &&
    path.startsWith('node_modules/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..') &&
    (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
  )
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
function validProvenance(value) {
  if (
    !value ||
    typeof value.resolved !== 'string' ||
    typeof value.integrity !== 'string' ||
    !INTEGRITY.test(value.integrity)
  )
    return false
  try {
    const url = new URL(value.resolved)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

let installedLock
function installedProblem(excuse, finding) {
  if (!Array.isArray(excuse.installed) || excuse.installed.length === 0) {
    return 'installed bindings must be a nonempty array; a reason alone cannot excuse an unbounded dependency set'
  }
  const expected = new Map()
  for (const item of excuse.installed) {
    if (
      !item ||
      !validNode(item.path, finding.package) ||
      typeof item.version !== 'string' ||
      !VERSION.test(item.version) ||
      !validProvenance(item)
    ) {
      return 'malformed installed binding; require exact path, version, HTTPS resolved source and SHA-512 integrity'
    }
    if (expected.has(item.path)) return `duplicate installed binding for ${item.path}`
    expected.set(item.path, item)
  }
  if (finding.unreadableNodes || finding.nodes.size === 0)
    return 'missing or unreadable installed nodes in an advisory occurrence'
  if (
    expected.size !== finding.nodes.size ||
    [...finding.nodes].some((path) => !expected.has(path))
  ) {
    return `installed node set differs; expected ${[...expected.keys()].sort().join(', ')}, reported ${[...finding.nodes].sort().join(', ')}`
  }
  if (!installedLock) {
    try {
      const resolveLockfilePath = (root) => {
        const local = join(root, 'package-lock.json')
        if (existsSync(local)) return local
        const parentPkg = join(root, '..', '..', 'package.json')
        if (existsSync(parentPkg)) {
          const parsed = JSON.parse(readFileSync(parentPkg, 'utf8'))
          if (Array.isArray(parsed?.workspaces)) return join(root, '..', '..', 'package-lock.json')
        }
        return local
      }
      installedLock = JSON.parse(readFileSync(resolveLockfilePath(ROOT), 'utf8'))
    } catch (error) {
      return `package-lock.json is not readable (${error.message})`
    }
  }
  if (
    !installedLock?.packages ||
    typeof installedLock.packages !== 'object' ||
    Array.isArray(installedLock.packages)
  )
    return 'package-lock.json has no packages map'
  for (const [path, item] of expected) {
    if (!Object.hasOwn(installedLock.packages, path))
      return `${path} is absent from package-lock.json`
    const actual = installedLock.packages[path]
    if (typeof actual?.version !== 'string' || !VERSION.test(actual.version))
      return `unreadable installed version for ${path}`
    if (actual.version !== item.version)
      return `installed version changed for ${path}: expected ${item.version}, found ${actual.version}`
    if (!validProvenance(actual)) return `unreadable installed provenance for ${path}`
    if (actual.resolved !== item.resolved || actual.integrity !== item.integrity)
      return `installed provenance changed for ${path}; reassess the exact source bytes before allowing it`
  }
  return null
}

// --- The verdicts ------------------------------------------------------------
const rows = []
let problems = 0

const ordered = [...findings.values()].sort(
  (a, b) => ORDER.indexOf(b.severity) - ORDER.indexOf(a.severity) || a.id.localeCompare(b.id)
)

for (const finding of ordered) {
  const row = { ...finding, verdict: null, note: '' }
  const blocks = ORDER.indexOf(finding.severity) >= BLOCKS_AT
  const excuse = allowed.get(finding.id)

  if (!blocks) {
    row.verdict = 'BELOW'
    row.note = `below the ${THRESHOLD} threshold; reported, not blocking`
    if (excuse) {
      excuse.used = true
      row.verdict = 'FAIL'
      row.note = `listed in ${FILE}, but this advisory is \`${finding.severity}\` and blocks nothing — delete the entry`
      problems++
    }
    rows.push(row)
    continue
  }

  if (!excuse) {
    row.verdict = 'FAIL'
    row.note = `is \`${finding.severity}\` and is not in ${FILE}. Update the dependency, or add an entry with a written reason.`
    problems++
    rows.push(row)
    continue
  }

  excuse.used = true
  const problem = bindingProblem(excuse, finding)
  if (problem) {
    row.verdict = 'FAIL'
    row.note = problem
    problems++
  } else {
    row.verdict = 'ALLOWED'
    row.note = `${excuse.reason} Bound installed copies: ${excuse.installed.map((item) => `${item.path}@${item.version}`).join(', ')}.`
  }
  rows.push(row)
}

const orphans = [...allowed.values()].filter((entry) => !entry.used)

// --- Report ------------------------------------------------------------------
const w = (s, n) => String(s).padEnd(n)
const COL = { id: 22, pkg: 26, severity: 10, range: 22 }
const RULE = '='.repeat(110)

console.log(`Dependency advisory gate — npm audit --json, blocking at \`${THRESHOLD}\` and above`)
console.log(RULE)
const deps = report.metadata?.dependencies ?? {}
console.log(
  `tree: ${deps.prod ?? '?'} prod, ${deps.dev ?? '?'} dev, ${deps.optional ?? '?'} optional — ${deps.total ?? '?'} packages audited`
)
console.log(
  `npm audit: ${counts.total} vulnerable package(s) — ` +
    ORDER.map((s) => `${counts[s] ?? 0} ${s}`).join(', ')
)
console.log(`advisories read from those packages: ${findings.size}`)
console.log(
  hasAllowlist
    ? `${FILE}: ${allowed.size} entr${allowed.size === 1 ? 'y' : 'ies'}`
    : `${FILE}: absent — no advisory has an exception`
)

if (rows.length) {
  console.log('-'.repeat(110))
  console.log(
    `${w('advisory', COL.id)}${w('package', COL.pkg)}${w('severity', COL.severity)}${w('vulnerable range', COL.range)}verdict`
  )
  for (const row of rows) {
    console.log(
      `${w(row.id, COL.id)}${w(row.package, COL.pkg)}${w(row.severity, COL.severity)}${w(row.range, COL.range)}${row.verdict}`
    )
    if (row.note) console.log(`${' '.repeat(2)}↳ ${row.note}`)
  }
}

console.log(RULE)
const tally = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {})
console.log(
  `${rows.length} advisor${rows.length === 1 ? 'y' : 'ies'} — ` +
    ['FAIL', 'ALLOWED', 'BELOW'].map((v) => `${tally[v] ?? 0} ${v.toLowerCase()}`).join(', ')
)

if (orphans.length) {
  console.error(`\nStale entries in ${FILE} — no advisory in this audit carries that identifier:`)
  for (const orphan of orphans) {
    console.error(
      `  FAIL  ${orphan.advisory} — nothing reports it any more, so this excuse is waiting to cover a finding nobody decided. Delete it.`
    )
  }
}

if (problems || orphans.length) {
  console.error(
    `\n${problems + orphans.length} advisory problem(s). Nothing here passes by being quiet.`
  )
  process.exit(1)
}

console.log(
  `\nOK — no advisory at \`${THRESHOLD}\` or above is unaccounted for, and no entry in ${FILE} has outlived the finding it describes.`
)

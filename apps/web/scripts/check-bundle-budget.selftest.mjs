#!/usr/bin/env node
// Proves scripts/check-bundle-budget.mjs can actually fail, and fails for the reason under test
// rather than for any reason at all (docs/dev/TESTING.md, "Writing a test that can actually fail").
//
// Every case is a real build. The control is the tree as it is; each mutation is the same build
// with one fault injected into the module graph in memory (`--mutation`, nothing in the working
// tree is touched): a workspace-only vendor imported by the application entry, an entry or a
// deferred chunk made heavier than its budget, a message catalogue the entry must not carry, two
// chunks made to import each other.
// A case asserts the LINE THE GATE PRINTS. The exit code alone would be satisfied by a gate that
// refuses everything, so the control must pass, and must print none of the refusals.
//
// CI runs the gate with no `--report-only` flags (.github/workflows/ci-web.yml), enforcing every
// rule including `entry-size`. The cases here run the same way.
//
// The case count at the bottom is counted, not written down: a case that stops running stops
// being reported.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, 'check-bundle-budget.mjs')
const AS_IN_CI = []
const REFUSALS = [
  'ENTRY_OVER_BUDGET',
  'FORBIDDEN_ENTRY_VENDOR',
  'CHUNK_OVER_BUDGET',
  'ENTRY_CATALOGUE',
  'CHUNK_CYCLE',
  'ENTRY_REGRESSION',
]

let cases = 0

function run(args) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: join(HERE, '..'),
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

function expectRefusal(title, args, needle) {
  cases++
  const { status, output } = run(args)
  assert.equal(status, 1, `${title}: the gate did not fail\n${output}`)
  assert.ok(output.includes(needle), `${title}: the failure did not say "${needle}"\n${output}`)
  assert.ok(
    output.includes('check-bundle-budget: FAILED'),
    `${title}: no FAILED verdict\n${output}`
  )
  console.log(`ok - ${title}`)
}

// Control: the tree as it is passes every rule CI enforces, and trips none of the refusals the
// mutations below are expected to trip. Without it they could all be the gate refusing anything.
{
  cases++
  const { status, output } = run(AS_IN_CI)
  assert.equal(status, 0, `control: the gate refused the tree as it is\n${output}`)
  for (const refusal of REFUSALS) {
    assert.ok(!output.includes(refusal), `control: the gate printed ${refusal}\n${output}`)
  }
  assert.ok(!output.includes('NOT MET'), `control: printed NOT MET\n${output}`)
  assert.match(output, /entry JavaScript: \d+\.\d+ kB gzip in \d+ file\(s\)/, output)
  assert.match(
    output,
    /target \d+\.\d+ kB \(ceiling 180\.00 kB\): met, \d+\.\d+ kB to spare/,
    output
  )
  assert.ok(
    output.includes(
      'check-bundle-budget: OK — entry and deferred chunks are within budget, no forbidden vendor or catalogue in the entry, no chunk cycle'
    ),
    output
  )
  assert.match(output, /deferred chunks: \d+;/, output)
  console.log('ok - control: the tree as it is passes every rule')
}

// Each workspace-only vendor, imported by the application entry, is refused by name.
for (const [mutation, vendor] of [
  ['vendor-matrix', 'matrix-js-sdk'],
  ['vendor-livekit', 'livekit-client'],
  ['vendor-oidc', 'oidc-client-ts'],
]) {
  expectRefusal(
    `${vendor} imported by the entry is refused`,
    [...AS_IN_CI, '--mutation', mutation],
    `FORBIDDEN_ENTRY_VENDOR: ${vendor} is in the entry, in assets/`
  )
}

// A deferred chunk over its budget is refused, and named.
expectRefusal(
  'a deferred chunk over its budget is refused',
  [...AS_IN_CI, '--mutation', 'inflate-chunk'],
  'CHUNK_OVER_BUDGET: assets/'
)

// The whole catalogue, or another area's, in the entry is refused, and named.
expectRefusal(
  'the whole catalogue in the entry is refused',
  [...AS_IN_CI, '--mutation', 'whole-catalogue'],
  'ENTRY_CATALOGUE: src/i18n/fr.json is in the entry'
)
expectRefusal(
  "an area's catalogue in the entry is refused",
  [...AS_IN_CI, '--mutation', 'area-catalogue'],
  'ENTRY_CATALOGUE: src/i18n/catalogues/fr/people.json is in the entry'
)

// Two chunks that import each other are refused, and both are named.
expectRefusal(
  'chunks that import each other are refused',
  [...AS_IN_CI, '--mutation', 'chunk-cycle'],
  'CHUNK_CYCLE: these chunks import each other: assets/cycle-0'
)

// Both a large inflation past the 180 kB ceiling and a ~12 kB regression past `BUDGETS.entryGzip`
// fail the gate as CI runs it.
expectRefusal(
  'an entry over its ceiling is refused',
  [...AS_IN_CI, '--mutation', 'inflate-entry'],
  'ENTRY_OVER_BUDGET: the entry JavaScript is '
)
expectRefusal(
  'an entry growing past its tight budget is refused',
  [...AS_IN_CI, '--mutation', 'inflate-entry-slightly'],
  'ENTRY_OVER_BUDGET: the entry JavaScript is '
)

// `--report-only` still reports a held violation as NOT MET without claiming full budget compliance.
{
  cases++
  const { status, output } = run([
    '--report-only',
    'entry-size',
    '--mutation',
    'inflate-entry-slightly',
  ])
  assert.equal(status, 0, `report-only: failed when entry-size was held\n${output}`)
  assert.ok(
    output.includes('NOT MET (reported only, does not fail this run): ENTRY_OVER_BUDGET'),
    `report-only: the held rule was not reported as NOT MET\n${output}`
  )
  assert.ok(!output.includes('OK — entry and deferred chunks are within budget'), output)
  console.log('ok - a reported-only rule is printed as NOT MET without claiming full compliance')
}

// The regression limit cannot be made report-only: the request is refused before any build.
{
  cases++
  const { status, output } = run(['--report-only', 'entry-regression'])
  assert.equal(status, 1, `regression: the gate agreed to hold the limit\n${output}`)
  assert.ok(output.includes('"entry-regression" cannot be reported only'), output)
  assert.ok(!output.includes('entry JavaScript:'), `regression: a build ran anyway\n${output}`)
  console.log('ok - the regression limit cannot be reported only')
}

// A rule can only be held by its own name: a misspelt one stops the run before any build.
{
  cases++
  const { status, output } = run(['--report-only', 'entry'])
  assert.equal(status, 1, `unknown rule: the gate accepted it\n${output}`)
  assert.ok(output.includes('unknown rule "entry" for --report-only'), output)
  console.log('ok - an unknown rule name for --report-only is refused')
}

console.log(`check-bundle-budget.selftest: ${cases} cases, every mutation was caught by name.`)

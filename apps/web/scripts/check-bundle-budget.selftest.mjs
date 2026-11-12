#!/usr/bin/env node
// Proves scripts/check-bundle-budget.mjs can actually fail, and fails for the reason under test
// rather than for any reason at all (docs/dev/TESTING.md, "Writing a test that can actually fail").
//
// Every case is a real build. The control is the tree as it is; each mutation is the same build
// with one fault injected into the module graph in memory (`--mutation`, nothing in the working
// tree is touched): a workspace-only vendor imported by the application entry, an entry or a
// deferred chunk made heavier than its ceiling, a message catalogue the entry must not carry, two
// chunks made to import each other.
// A case asserts the LINE THE GATE PRINTS. The exit code alone would be satisfied by a gate that
// refuses everything, so the control must pass, and must print none of the refusals.
//
// The entry ceiling is not met yet, and CI runs the gate with `--report-only entry-size` (see the
// status note in the gate). The cases here run the same way, so that what they prove is what CI
// enforces, except the ones that are about the entry-size rule itself. What stops the entry
// growing meanwhile is its regression limit, which is always enforced: the cases on it prove that
// holding the target does not hold the limit, and that the limit cannot be held at all.
//
// The case count at the bottom is counted, not written down: a case that stops running stops
// being reported.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, 'check-bundle-budget.mjs')
const AS_IN_CI = ['--report-only', 'entry-size']
const REFUSALS = [
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
  assert.match(output, /entry JavaScript: \d+\.\d+ kB gzip in \d+ file\(s\)/, output)
  // Both lines, every run: the target, which is not met, and the limit, which is not the target.
  assert.match(output, /target 180\.00 kB \(ceiling 180\.00 kB\): NOT MET, over by /, output)
  assert.match(output, /regression limit \d+\.\d+ kB \(not the target\): held, /, output)
  assert.ok(
    output.includes('NOT MET (reported only, does not fail this run): ENTRY_OVER_BUDGET'),
    `control: the unmet target was not reported as NOT MET\n${output}`
  )
  assert.ok(!output.includes('OK — entry and deferred chunks are within budget'), output)
  assert.match(output, /deferred chunks: \d+;/, output)
  console.log('ok - control: the tree as it is passes the enforced rules')
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

// A deferred chunk over its ceiling is refused, and named.
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

// The entry-size rule is live at its ceiling: without `--report-only`, an entry made far heavier
// than the ceiling fails the run on that rule, whatever the tree measures today.
expectRefusal(
  'an entry over its budget is refused when the rule is enforced',
  ['--mutation', 'inflate-entry'],
  'ENTRY_OVER_BUDGET: the entry JavaScript is '
)

// The regression limit holds while the target is held: an entry a few kilobytes heavier — nowhere
// near the mutation above — fails the run as CI runs it, by the limit's own name, with the target
// still reported beside it as NOT MET.
{
  cases++
  const { status, output } = run([...AS_IN_CI, '--mutation', 'inflate-entry-slightly'])
  assert.equal(status, 1, `regression: a heavier entry passed while the target is held\n${output}`)
  assert.ok(
    output.includes('check-bundle-budget: ENTRY_REGRESSION: the entry JavaScript is '),
    `regression: the failure did not name the limit\n${output}`
  )
  assert.match(output, /regression limit \d+\.\d+ kB \(not the target\): EXCEEDED by /, output)
  assert.ok(
    output.includes('NOT MET (reported only, does not fail this run): ENTRY_OVER_BUDGET'),
    `regression: the target was no longer reported as NOT MET\n${output}`
  )
  assert.ok(output.includes('check-bundle-budget: FAILED — 1 violation(s)'), output)
  console.log(
    'ok - an entry past its regression limit is refused while the target is only reported'
  )
}

// The limit cannot be made report-only: the request is refused before any build.
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

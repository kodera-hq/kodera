#!/usr/bin/env node
// Proves scripts/check-lockfile-direction.mjs can actually fail, and fails for
// the reason under test rather than for any reason at all.
//
// Each case below builds a throwaway git repository — a base commit, a working
// tree standing in for the merge that would land, and a waiver file — breaks
// exactly one thing, runs the gate, and asserts the LINE THE GATE PRINTS. The
// exit code alone would be satisfied by a gate that refuses everything, so the
// first case is the control that refuses nothing, and several cases also assert
// a verdict the gate must NOT reach.
//
// The case count at the bottom is counted, not written down: a case that stops
// running stops being reported.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'check-lockfile-direction.mjs')

/** A lockfile whose `packages` map carries the given path -> version pairs. */
const lock = (versions) => ({
  name: 'fixture',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'fixture', version: '0.0.0' },
    ...Object.fromEntries(Object.entries(versions).map(([path, v]) => [path, { version: v }])),
  },
})

/** A manifest declaring the given name -> range pairs as dependencies. */
const manifest = (deps = {}) => ({ name: 'fixture', version: '0.0.0', dependencies: deps })

const REASON = 'Upstream 2.0.0 shipped a broken ESM build; 1.9.0 is the last release that loads.'
const DECISION = 'Delete this entry when upstream publishes a fixed 2.x and the pin moves forward.'

/** `id`, `kind`, `from`, `to` plus the two mandatory prose fields. */
const waiver = (over = {}) => ({
  id: 'node_modules/foo',
  kind: 'backwards',
  from: '2.0.0',
  to: '1.9.0',
  reason: REASON,
  decision: DECISION,
  ...over,
})

function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

/**
 * A repository holding `base` as a commit and `head` as the working tree — the
 * shape a `pull_request` checkout has, where the tree on disk is the merge that
 * would land and the base branch is reachable through git.
 *
 * A file given as a string is written verbatim (that is how a lockfile that is
 * not JSON gets in); given as `null` it is left out of that side entirely.
 */
function scratch({ base, head, waivers }) {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-direction-selftest-'))
  git(dir, 'init', '-q', '-b', 'chore/lockfile-direction-fixture')
  git(dir, 'config', 'user.email', 'selftest@example.invalid')
  git(dir, 'config', 'user.name', 'selftest')
  git(dir, 'config', 'commit.gpgsign', 'false')

  const put = (name, value) => {
    const path = join(dir, name)
    if (value === null) {
      try {
        unlinkSync(path)
      } catch {
        // Absent already, which is what `null` asks for.
      }
      return
    }
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  }

  put('package.json', base.manifest === undefined ? manifest() : base.manifest)
  put('package-lock.json', base.lock)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  const baseSha = git(dir, 'rev-parse', 'HEAD')

  put('package.json', head.manifest === undefined ? manifest() : head.manifest)
  put('package-lock.json', head.lock)
  if (waivers !== undefined) put('lockfile-known-downgrades.json', waivers)

  return { dir, baseSha }
}

function runGate(dir, baseSha) {
  const result = spawnSync(process.execPath, [GATE, '--root', dir, '--base', baseSha], {
    cwd: dir,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

// --- The cases ---------------------------------------------------------------
//
// `expect` is the exit status; `says` is one pattern or several, all of which
// must appear; `silent` is the verdict the gate must NOT reach on this fixture.

const CASES = [
  {
    name: 'a clean forward bump is accepted',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.1.0' }) },
    },
    expect: 0,
    says: /OK — no package moves backwards, and every major crossing is declared or decided/,
    silent: /FAIL/,
  },
  {
    name: 'a backwards move is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
    },
    expect: 1,
    says: /node_modules\/foo {2}2\.0\.0 -> 1\.9\.0: moves BACKWARDS and is not in lockfile-known-downgrades\.json/,
  },
  {
    name: 'a backwards move is not excused by package.json moving with it',
    fixture: {
      base: {
        lock: lock({ 'node_modules/foo': '2.0.0' }),
        manifest: manifest({ foo: '^2.0.0' }),
      },
      head: {
        lock: lock({ 'node_modules/foo': '1.9.0' }),
        manifest: manifest({ foo: '^1.9.0' }),
      },
    },
    expect: 1,
    says: [
      /node_modules\/foo {2}2\.0\.0 -> 1\.9\.0: moves BACKWARDS/,
      /a manifest range going backwards is the same regression one level up/,
    ],
    silent: /DECLARED/,
  },
  {
    name: 'a prerelease below its release is a backwards move',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '2.0.0-rc.1' }) },
    },
    expect: 1,
    says: /node_modules\/foo {2}2\.0\.0 -> 2\.0\.0-rc\.1: moves BACKWARDS/,
  },
  {
    name: 'a transitive major crossing that is not the subject is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/bar/node_modules/foo': '1.2.3' }) },
      head: { lock: lock({ 'node_modules/bar/node_modules/foo': '2.0.0' }) },
    },
    expect: 1,
    says: /node_modules\/bar\/node_modules\/foo {2}1\.2\.3 -> 2\.0\.0: crosses a MAJOR, and package\.json does not declare it/,
  },
  {
    name: 'a direct major crossing with an unchanged range is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.2.3' }), manifest: manifest({ foo: '*' }) },
      head: { lock: lock({ 'node_modules/foo': '2.0.0' }), manifest: manifest({ foo: '*' }) },
    },
    expect: 1,
    says: /node_modules\/foo {2}1\.2\.3 -> 2\.0\.0: crosses a MAJOR, and package\.json does not declare it/,
    silent: /DECLARED/,
  },
  {
    name: 'a major crossing package.json declares is accepted',
    fixture: {
      base: {
        lock: lock({ 'node_modules/typescript': '5.9.3' }),
        manifest: manifest({ typescript: '^5.9.3' }),
      },
      head: {
        lock: lock({ 'node_modules/typescript': '7.0.1' }),
        manifest: manifest({ typescript: '^7.0.1' }),
      },
    },
    expect: 0,
    says: [
      /node_modules\/typescript {2}5\.9\.3 -> 7\.0\.1: package\.json declares typescript at "\^7\.0\.1" — the crossing is the subject of this change/,
      /OK — no package moves backwards/,
    ],
    silent: /FAIL/,
  },
  {
    name: 'a range whose floor is not the new major does not declare the crossing',
    fixture: {
      base: {
        lock: lock({ 'node_modules/typescript': '5.9.3' }),
        manifest: manifest({ typescript: '^5.9.3' }),
      },
      head: {
        lock: lock({ 'node_modules/typescript': '7.0.1' }),
        manifest: manifest({ typescript: '^6.0.0' }),
      },
    },
    expect: 1,
    says: /node_modules\/typescript {2}5\.9\.3 -> 7\.0\.1: crosses a MAJOR, and package\.json does not declare it/,
  },
  {
    name: 'a declared downgrade is accepted through a bound waiver',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      waivers: { downgrades: [waiver()] },
    },
    expect: 0,
    says: [
      new RegExp(
        `node_modules/foo {2}2\\.0\\.0 -> 1\\.9\\.0: ${REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      ),
      /1 finding\(s\) — 1 allowed, 0 declared, 0 fail/,
    ],
    silent: /FAIL/,
  },
  {
    name: 'a waiver whose from no longer matches is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.1' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      waivers: { downgrades: [waiver()] },
    },
    expect: 1,
    says: /entry was written for from "2\.0\.0" but the lockfile now moves from "2\.0\.1" — a different move, not the one excused/,
    silent: /ALLOWED/,
  },
  {
    name: 'a waiver whose to no longer matches is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.8.0' }) },
      waivers: { downgrades: [waiver()] },
    },
    expect: 1,
    says: /entry was written for to "1\.9\.0" but the lockfile now moves to "1\.8\.0" — a different move, not the one excused/,
    silent: /ALLOWED/,
  },
  {
    name: 'a waiver written for the other kind of move is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      waivers: { downgrades: [waiver({ kind: 'major' })] },
    },
    expect: 1,
    says: /entry was written for a "major" move, the lockfile makes a "backwards" move — a different move, not the one excused/,
  },
  {
    name: 'a waiver with no reason is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      waivers: { downgrades: [waiver({ reason: '   ' })] },
    },
    expect: 1,
    says: /lockfile-known-downgrades\.json entry has no reason/,
  },
  {
    name: 'a waiver with no decision is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '2.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      waivers: { downgrades: [waiver({ decision: '' })] },
    },
    expect: 1,
    says: /lockfile-known-downgrades\.json entry has no decision/,
  },
  {
    name: 'a waiver on a move package.json already declares is refused',
    fixture: {
      base: {
        lock: lock({ 'node_modules/typescript': '5.9.3' }),
        manifest: manifest({ typescript: '^5.9.3' }),
      },
      head: {
        lock: lock({ 'node_modules/typescript': '7.0.1' }),
        manifest: manifest({ typescript: '^7.0.1' }),
      },
      waivers: {
        downgrades: [
          waiver({ id: 'node_modules/typescript', kind: 'major', from: '5.9.3', to: '7.0.1' }),
        ],
      },
    },
    expect: 1,
    says: /lockfile-known-downgrades\.json names this move, but package\.json declares it — delete the entry/,
  },
  {
    name: 'an orphan waiver is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.1.0' }) },
      waivers: { downgrades: [waiver({ id: 'node_modules/ghost' })] },
    },
    expect: 1,
    says: [
      /Stale entries in lockfile-known-downgrades\.json \(nothing in this change makes that move\)/,
      /FAIL {2}node_modules\/ghost {2}"2\.0\.0" -> "1\.9\.0"/,
    ],
  },
  {
    name: 'a waiver the base has already applied is spent, not stale',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      head: { lock: lock({ 'node_modules/foo': '1.9.0' }) },
      waivers: { downgrades: [waiver()] },
    },
    expect: 0,
    says: [
      /SPENT {2}node_modules\/foo {2}"2\.0\.0" -> "1\.9\.0": the base already sits at "1\.9\.0"/,
      /1 spent waiver\(s\)/,
    ],
    silent: /Stale entries/,
  },
  {
    name: 'a lockfile absent from the tree that would land is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
      head: { lock: null },
    },
    expect: 1,
    says: [
      /cannot read package-lock\.json in the working tree/,
      /FAILED before it could compare anything/,
    ],
  },
  {
    name: 'a lockfile absent from the base is refused',
    fixture: {
      base: { lock: null },
      head: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
    },
    expect: 1,
    says: /cannot read package-lock\.json at [0-9a-f]{7,}: /,
  },
  {
    name: 'a lockfile that is not readable JSON is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
      head: { lock: '{ "packages": ' },
    },
    expect: 1,
    says: /package-lock\.json at the working tree is not readable JSON/,
  },
  {
    name: 'a lockfile with no packages map is refused',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
      head: { lock: { name: 'fixture', lockfileVersion: 1, dependencies: {} } },
    },
    expect: 1,
    says: /package-lock\.json at the working tree has no `packages` map \(lockfileVersion 1\) — there are no per-path versions to compare/,
  },
  {
    name: 'a version that is not semver is refused rather than skipped',
    fixture: {
      base: { lock: lock({ 'node_modules/foo': '1.0.0' }) },
      head: { lock: lock({ 'node_modules/foo': 'latest' }) },
    },
    expect: 1,
    says: /node_modules\/foo {2}1\.0\.0 -> latest: version "1\.0\.0" -> "latest" is not a semver pair/,
  },
]

// --- Run ---------------------------------------------------------------------

let failed = 0
let ran = 0

for (const testCase of CASES) {
  const { dir, baseSha } = scratch(testCase.fixture)
  try {
    const { status, output } = runGate(dir, baseSha)
    ran++
    assert.equal(
      status,
      testCase.expect,
      `expected exit ${testCase.expect}, got ${status}:\n${output}`
    )
    for (const pattern of [testCase.says].flat()) {
      assert.match(
        output,
        pattern,
        `the gate ran, but did not say the thing under test:\n${output}`
      )
    }
    for (const pattern of [testCase.silent ?? []].flat()) {
      assert.doesNotMatch(
        output,
        pattern,
        `the gate also reached a verdict this case must not reach:\n${output}`
      )
    }
    console.log(`  ok    ${testCase.name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${testCase.name}\n        ${error.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Counted, never written down: a case removed from CASES stops being claimed.
const summary = `${ran} case(s) ran, ${failed} failed`
if (failed || ran !== CASES.length) {
  console.error(
    `\ncheck-lockfile-direction.selftest: FAILED — ${summary} of ${CASES.length} declared`
  )
  process.exit(1)
}
console.log(
  `\ncheck-lockfile-direction.selftest: OK — ${summary}. A backwards move, an undeclared major, ` +
    'every binding on a waiver, a stale entry and an unreadable lockfile are all caught, and the ' +
    'clean bump, the declared major and the spent waiver are all still accepted.'
)

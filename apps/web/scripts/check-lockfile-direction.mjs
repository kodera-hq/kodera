#!/usr/bin/env node
// Lockfile direction gate — reads package-lock.json in two trees and refuses a
// change that moves a package BACKWARDS, or across a MAJOR, without that being
// the declared subject of the change.
//
// Decision B-lockfile-downgrades: nothing in this organisation compared a
// regenerated lockfile against the one it replaces. A security bump once moved
// 14 transitive packages backwards and OpenTelemetry across a major, none of it
// declared and none of it visible in CI. Every other check here reads the tree
// as it stands; none of them reads which way it moved.
//
// The four ways a direction check lies, and what stops each here:
//
//   It compares the wrong pair of trees.  The subject is the tree that would
//     LAND, not the branch tip: on a `pull_request` event the checkout is the
//     merge of head into base, so `--head` defaults to the working tree and
//     `--base` to the base branch's tip. A verdict is bound to the base commit
//     it was measured against, and that commit is printed on every run.
//   A version it cannot read is passed over.  A path present in both trees
//     whose version does not parse as semver is a hard failure naming the path,
//     never a skipped row. A lockfile that is absent, unreadable, or carries no
//     `packages` map is a hard failure too. A suite of unmeasurable rows exits
//     0 on every lockfile.
//   A downgrade is "temporarily" tolerated and nobody remembers.  A backwards
//     move must be listed in lockfile-known-downgrades.json with a written
//     reason, and each entry is bound to the path, the kind of move, and both
//     versions — so an entry cannot silently cover a later, different move.
//   The excuse outlives the move.  An entry naming a path with no finding is a
//     stale exemption waiting to cover something else, and fails the gate,
//     unless the base tree already sits at the entry's `to` — the move it
//     describes has landed, and it is reported spent rather than stale.
//
// scripts/check-lockfile-direction.selftest.mjs mutates one thing per case and
// asserts the line the gate prints, not the exit code.

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const LOCKFILE = 'package-lock.json'
const MANIFEST = 'package.json'
const WAIVERS = 'lockfile-known-downgrades.json'

// --- Arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const cwd = process.cwd()
  let explicitRoot = false
  const args = { root: cwd, base: null, head: null, waivers: null }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) throw new Error(`unexpected argument "${flag}"`)
    const key = flag.slice(2)
    if (!(key in args)) throw new Error(`unknown option "${flag}"`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`option "${flag}" needs a value`)
    if (key === 'root') explicitRoot = true
    args[key] = value
  }
  if (!explicitRoot && !existsSync(join(args.root, LOCKFILE))) {
    const candidate = resolve(args.root, '..', '..')
    if (existsSync(join(candidate, LOCKFILE))) {
      if (args.waivers === null && existsSync(join(args.root, WAIVERS))) {
        args.waivers = join(args.root, WAIVERS)
      }
      args.root = candidate
    }
  }
  if (args.base === null) {
    args.base = process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : 'origin/main'
  }
  if (args.waivers === null) args.waivers = join(args.root, WAIVERS)
  return args
}

// --- Reading trees -----------------------------------------------------------

/** `git show <ref>:<path>`, or a hard error naming what could not be read. */
function gitShow(root, ref, path) {
  const result = spawnSync('git', ['-C', root, 'show', `${ref}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`cannot run git: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(
      `cannot read ${path} at ${ref}: ${(result.stderr || '').trim() || `git exited ${result.status}`}`
    )
  }
  return result.stdout
}

function readWorktree(root, path) {
  const full = join(root, path)
  if (!existsSync(full))
    throw new Error(`cannot read ${path} in the working tree: ${full} does not exist`)
  return readFileSync(full, 'utf8')
}

/** A named side of the comparison, with the text of both files it needs. */
function readSide(root, ref, label) {
  const read = (path) => (ref === null ? readWorktree(root, path) : gitShow(root, ref, path))
  return { label, ref, lockText: read(LOCKFILE), manifestText: read(MANIFEST) }
}

/**
 * The `packages` map of a lockfile, or a hard error. A lockfile with no
 * `packages` map is lockfileVersion 1, which records no versions per path at
 * all — there is nothing here to compare, and saying so is the only honest
 * verdict.
 */
function packagesOf(side) {
  let parsed
  try {
    parsed = JSON.parse(side.lockText)
  } catch (error) {
    throw new Error(`${LOCKFILE} at ${side.label} is not readable JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed.packages !== 'object' || parsed.packages === null) {
    throw new Error(
      `${LOCKFILE} at ${side.label} has no \`packages\` map (lockfileVersion ` +
        `${JSON.stringify(parsed?.lockfileVersion ?? null)}) — there are no per-path versions to compare`
    )
  }
  return { packages: parsed.packages, lockfileVersion: parsed.lockfileVersion ?? null }
}

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

/** name -> declared range, across every dependency field of a package.json. */
function rangesOf(side) {
  let parsed
  try {
    parsed = JSON.parse(side.manifestText)
  } catch (error) {
    throw new Error(`${MANIFEST} at ${side.label} is not readable JSON: ${error.message}`)
  }
  const ranges = new Map()
  for (const field of MANIFEST_FIELDS) {
    const block = parsed?.[field]
    if (!block || typeof block !== 'object') continue
    for (const [name, range] of Object.entries(block)) ranges.set(name, String(range))
  }
  return ranges
}

// --- Versions ----------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(value) {
  const match = SEMVER.exec(String(value))
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Semver precedence, prereleases included: -1, 0 or 1. */
function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  // A version with a prerelease has lower precedence than one without.
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1
    if (xNum !== yNum) return xNum ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * The major a range floors at, or null when it does not start at a number.
 * `^7.0.1` and `>=7 <8` and `7.x` all floor at 7; `github:owner/repo#sha` and
 * `*` floor nowhere, and a package pinned that way is never read as declaring
 * a major.
 */
function rangeFloorMajor(range) {
  const match = /^[\s^~>=<v]*(\d+)(?:\.|\s|$)/.exec(String(range))
  return match ? Number(match[1]) : null
}

// --- Findings ----------------------------------------------------------------

/**
 * Only a top-level `node_modules/<name>` entry can be the subject of a manifest
 * edit. A nested `node_modules/a/node_modules/b` is a transitive copy: no line
 * of package.json addresses it, so nothing there can declare it.
 */
function topLevelName(path) {
  return path.startsWith('node_modules/') &&
    !path.slice('node_modules/'.length).includes('node_modules/')
    ? path.slice('node_modules/'.length)
    : null
}

function compare(basePackages, headPackages, baseRanges, headRanges) {
  const findings = []
  const unreadable = []
  let added = 0
  let removed = 0

  for (const path of Object.keys(headPackages)) {
    // The root entry is the project itself, not a dependency it resolves.
    if (path === '') continue
    if (!(path in basePackages)) {
      added++
      continue
    }
  }
  for (const path of Object.keys(basePackages)) {
    if (path === '') continue
    if (!(path in headPackages)) removed++
  }

  for (const path of Object.keys(basePackages).sort()) {
    if (path === '' || !(path in headPackages)) continue
    const rawFrom = basePackages[path]?.version
    const rawTo = headPackages[path]?.version
    // An entry with no version on either side records nothing to compare (a
    // workspace link, for instance). One that has a version on one side only is
    // a shape this gate cannot read, and is reported rather than passed over.
    if (rawFrom === undefined && rawTo === undefined) continue
    const from = rawFrom === undefined ? null : parseVersion(rawFrom)
    const to = rawTo === undefined ? null : parseVersion(rawTo)
    if (from === null || to === null) {
      unreadable.push({
        path,
        from: rawFrom === undefined ? '(none)' : String(rawFrom),
        to: rawTo === undefined ? '(none)' : String(rawTo),
      })
      continue
    }
    const order = compareVersions(from, to)
    if (order === 0) continue

    const name = topLevelName(path)
    const declared =
      name !== null &&
      baseRanges.get(name) !== headRanges.get(name) &&
      headRanges.has(name) &&
      rangeFloorMajor(headRanges.get(name)) === to.major

    if (order > 0) {
      findings.push({
        path,
        kind: 'backwards',
        from: String(rawFrom),
        to: String(rawTo),
        crossesMajor: from.major !== to.major,
        declared: false,
        manifestMoved: name !== null && baseRanges.get(name) !== headRanges.get(name),
      })
      continue
    }
    if (from.major !== to.major) {
      findings.push({
        path,
        kind: 'major',
        from: String(rawFrom),
        to: String(rawTo),
        crossesMajor: true,
        declared,
        manifestMoved: name !== null && baseRanges.get(name) !== headRanges.get(name),
      })
    }
  }

  return { findings, unreadable, added, removed }
}

// --- Waivers -----------------------------------------------------------------

/**
 * Why an entry does not cover the finding it names, or null when it does.
 * Every field an entry carries is checked, so the entry describes the move as
 * the lockfile makes it today, not the move as it was when someone wrote the
 * excuse. There is no wildcard and no version range: a range would let one
 * ruling cover a move nobody decided on.
 */
function bindingProblem(waiver, finding) {
  if (!waiver.reason || !String(waiver.reason).trim()) return `${WAIVERS} entry has no reason`
  if (!waiver.decision || !String(waiver.decision).trim()) return `${WAIVERS} entry has no decision`
  if (waiver.kind !== finding.kind) {
    return (
      `${WAIVERS} entry was written for a ${JSON.stringify(waiver.kind ?? null)} move, ` +
      `the lockfile makes a ${JSON.stringify(finding.kind)} move — a different move, not the one excused`
    )
  }
  for (const [key, actual] of [
    ['from', finding.from],
    ['to', finding.to],
  ]) {
    if (String(waiver[key] ?? '') !== actual) {
      return (
        `${WAIVERS} entry was written for ${key} ${JSON.stringify(waiver[key] ?? null)} ` +
        `but the lockfile now moves ${key} ${JSON.stringify(actual)} — a different move, not the one excused`
      )
    }
  }
  return null
}

// --- Run ---------------------------------------------------------------------

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`::error::${error.message}`)
    return 2
  }

  let base
  let head
  let basePackages
  let headPackages
  let baseRanges
  let headRanges
  try {
    base = readSide(args.root, args.base, args.base)
    head = readSide(args.root, args.head, args.head === null ? 'the working tree' : args.head)
    basePackages = packagesOf(base)
    headPackages = packagesOf(head)
    baseRanges = rangesOf(base)
    headRanges = rangesOf(head)
  } catch (error) {
    // Not a skip. A comparison that cannot read one of its two trees is not
    // guarding anything, and a gate that shrugs at a missing lockfile is green
    // on the one change that deletes it.
    console.error(`::error::${error.message}`)
    console.error('Lockfile direction gate — FAILED before it could compare anything.')
    return 1
  }

  console.log('Lockfile direction gate — package-lock.json, base against the tree that would land')
  console.log('='.repeat(100))
  console.log(`base  ${base.label}`)
  console.log(`head  ${head.label}`)
  console.log(
    `lockfileVersion  ${JSON.stringify(basePackages.lockfileVersion)} -> ${JSON.stringify(headPackages.lockfileVersion)}`
  )

  const { findings, unreadable, added, removed } = compare(
    basePackages.packages,
    headPackages.packages,
    baseRanges,
    headRanges
  )

  const entryCount = (map) => Object.keys(map).filter((k) => k !== '').length
  console.log(
    `packages  ${entryCount(basePackages.packages)} -> ${entryCount(headPackages.packages)}   ` +
      `added ${added}  removed ${removed}`
  )

  let waivers = { downgrades: [] }
  if (existsSync(args.waivers)) {
    try {
      waivers = JSON.parse(readFileSync(args.waivers, 'utf8'))
    } catch (error) {
      console.error(`::error::${WAIVERS} is not readable JSON: ${error.message}`)
      return 1
    }
  }
  const declaredWaivers = Array.isArray(waivers.downgrades) ? waivers.downgrades : []
  const byPath = new Map(declaredWaivers.map((w) => [w.id, { ...w, used: false }]))

  const rows = []
  let problems = 0

  for (const row of unreadable) {
    rows.push({
      ...row,
      kind: 'unreadable',
      verdict: 'FAIL',
      note:
        `version ${JSON.stringify(row.from)} -> ${JSON.stringify(row.to)} is not a semver pair; ` +
        'a version this gate cannot read is a version it is not guarding',
    })
    problems++
  }

  for (const finding of findings) {
    const waiver = byPath.get(finding.path)
    if (waiver) waiver.used = true

    if (finding.kind === 'major' && finding.declared) {
      // The manifest names this package and its range moved to a floor inside
      // the new major: the crossing is what the change says it is.
      rows.push({
        ...finding,
        verdict: 'DECLARED',
        note: `package.json declares ${topLevelName(finding.path)} at ${JSON.stringify(headRanges.get(topLevelName(finding.path)))} — the crossing is the subject of this change`,
      })
      if (waiver) {
        rows[rows.length - 1].verdict = 'FAIL'
        rows[rows.length - 1].note =
          `${WAIVERS} names this move, but package.json declares it — delete the entry`
        problems++
      }
      continue
    }

    if (!waiver) {
      rows.push({
        ...finding,
        verdict: 'FAIL',
        note:
          finding.kind === 'backwards'
            ? 'moves BACKWARDS and is not in ' +
              WAIVERS +
              (finding.manifestMoved
                ? '. package.json moved with it, which declares nothing: a manifest range going backwards is the same regression one level up'
                : '')
            : 'crosses a MAJOR, and package.json does not declare it: nothing in this change says this crossing is its subject',
      })
      problems++
      continue
    }

    const problem = bindingProblem(waiver, finding)
    if (problem) {
      rows.push({ ...finding, verdict: 'FAIL', note: problem })
      problems++
    } else {
      rows.push({ ...finding, verdict: 'ALLOWED', note: waiver.reason })
    }
  }

  // An entry naming a path with no finding is a stale exemption waiting to
  // cover a different move — unless the base already sits at the version the
  // entry moves TO, in which case the move it describes has landed and the
  // entry is spent rather than stale.
  const stale = []
  const spent = []
  for (const waiver of byPath.values()) {
    if (waiver.used) continue
    const baseVersion = basePackages.packages[waiver.id]?.version
    if (baseVersion !== undefined && String(baseVersion) === String(waiver.to ?? ''))
      spent.push(waiver)
    else stale.push(waiver)
  }

  const w = (s, n) => String(s).padEnd(n)
  const COL = { path: 52, from: 14, to: 14, verdict: 10 }
  if (rows.length) {
    console.log('-'.repeat(100))
    console.log(
      `${w('package', COL.path)}${w('from', COL.from)}${w('to', COL.to)}${w('verdict', COL.verdict)}kind`
    )
    console.log('-'.repeat(100))
    for (const row of rows) {
      console.log(
        `${w(row.path, COL.path)}${w(row.from, COL.from)}${w(row.to, COL.to)}${w(row.verdict, COL.verdict)}${row.kind}`
      )
      console.log(`${' '.repeat(4)}↳ ${row.path}  ${row.from} -> ${row.to}: ${row.note}`)
    }
  }

  for (const waiver of spent) {
    console.log(
      `SPENT  ${waiver.id}  ${JSON.stringify(waiver.from)} -> ${JSON.stringify(waiver.to)}: the base already sits at ` +
        `${JSON.stringify(waiver.to)}, so this entry covers nothing here. It may be deleted.`
    )
  }

  console.log('='.repeat(100))
  const tally = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {})
  console.log(
    `${rows.length} finding(s) — ` +
      ['ALLOWED', 'DECLARED', 'FAIL'].map((v) => `${tally[v] ?? 0} ${v.toLowerCase()}`).join(', ') +
      `; ${spent.length} spent waiver(s)`
  )

  if (stale.length) {
    console.error(`\nStale entries in ${WAIVERS} (nothing in this change makes that move):`)
    for (const s of stale) {
      console.error(
        `  FAIL  ${s.id}  ${JSON.stringify(s.from ?? null)} -> ${JSON.stringify(s.to ?? null)}`
      )
    }
  }

  if (problems || stale.length) {
    console.error(
      `\n${problems + stale.length} lockfile direction problem(s). Regenerate the lockfile against ` +
        `${base.label}, or add the move to ${WAIVERS} with a reason and a decision. Nothing here passes by being quiet.`
    )
    return 1
  }

  console.log('\nOK — no package moves backwards, and every major crossing is declared or decided.')
  return 0
}

process.exit(main(process.argv.slice(2)))

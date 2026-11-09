// Runs the spec-test gate (docs/specs/README.md, "Acceptance-test convention") the same
// way `npm run spec:check` does, so a broken extraction pattern shows up in the `checks`
// job rather than only when someone remembers to run the script by hand.
//
// This does not repeat scripts/check-spec-tests.selftest.sh's mutation coverage — that
// self-test is what proves the gate can fail. This test proves the gate ran against the
// real specifications, printed a number, and that every spec `scripts/spec-gate.json`
// lists — the ones whose screen has merged — is fully covered by the suite.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `import.meta.dirname`, not `new URL(..., import.meta.url)`: under Vite's transform
// the latter resolves against a rewritten `/@fs/...` module id, not the file's real
// path on disk, and the child process below would be given a cwd that does not exist.
const root = join(import.meta.dirname, '..', '..')

describe('npm run spec:check', () => {
  it('reports the acceptance-test names it found against the real specifications', () => {
    const output = execFileSync('python3', ['scripts/check-spec-tests.py'], {
      cwd: root,
      encoding: 'utf8',
    })

    const overall = output.match(/overall: (\d+)\/(\d+)/)
    if (!overall) {
      throw new Error(`no "overall: n/total" line in the gate's output:\n${output}`)
    }

    const [, present, total] = overall
    // Not hard-coded to today's 89: the specifications will gain tests over time, and a
    // count that only ever goes up is not what this test is for. It is a sanity check
    // that the script ran to completion and both numbers parse — the floor built into
    // the script itself (--min-spec-files, --min-names) is what refuses a vacuous pass.
    expect(Number.isInteger(Number(present))).toBe(true)
    expect(Number.isInteger(Number(total))).toBe(true)
    expect(Number(total)).toBeGreaterThanOrEqual(80)
    expect(Number(present)).toBeGreaterThanOrEqual(0)
    expect(Number(present)).toBeLessThanOrEqual(Number(total))
  })

  it('gates every spec listed in scripts/spec-gate.json: present === total for each', () => {
    const allowlist = JSON.parse(readFileSync(join(root, 'scripts/spec-gate.json'), 'utf8')) as {
      requireAll: string[]
    }
    expect(Array.isArray(allowlist.requireAll)).toBe(true)

    const output = execFileSync('python3', ['scripts/check-spec-tests.py'], {
      cwd: root,
      encoding: 'utf8',
    })

    // The script's own view of the list must match the file's: a gate that read a
    // different list from the one this test reads would be checked against nothing.
    const gatedLine = output.match(/^gated: (.+)$/m)?.[1]
    expect(gatedLine).toBe(
      allowlist.requireAll.length === 0 ? 'none' : [...allowlist.requireAll].sort().join(', ')
    )

    // The script already exits 1 on a gated miss, which `execFileSync` throws on; this
    // is the same fact read from the per-file lines, so the failure names the spec.
    for (const spec of allowlist.requireAll) {
      const line = output.match(new RegExp(`^${spec.replace(/\./g, '\\.')}: (\\d+)/(\\d+)`, 'm'))
      if (!line) throw new Error(`no per-file line for ${spec} in the gate's output:\n${output}`)
      const [, specPresent, specTotal] = line
      expect(Number(specTotal)).toBeGreaterThan(0)
      expect(specPresent).toBe(specTotal)
    }
  })

  it('can fail: the self-test proves every guard fires on a mutated fixture', () => {
    const output = execFileSync('scripts/check-spec-tests.selftest.sh', {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(output).toContain('OK')
  }, 25_000)
})

// Regeneration is clean: running the generator again produces the bytes that are
// committed, to the byte.
//
// This is the gate against a hand-edit to generated code (docs/dev/API_CLIENT.md). A
// hand-edit survives exactly until the next `npm run api:generate`, and until then it
// makes the console's mocks and types describe an API nobody implements. It also
// catches a pull request that bumps the pinned contract and forgets to commit the
// output — the mocks would keep answering the previous contract's examples.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')
const out = mkdtempSync(join(tmpdir(), 'api-regen-'))

afterAll(() => {
  rmSync(out, { recursive: true, force: true })
})

const GENERATED = [
  'src/api/schema.d.ts',
  'src/api/generated/problems.ts',
  'src/mocks/generated/problems.ts',
  'src/mocks/generated/examples.ts',
  'src/mocks/generated/handlers.ts',
]

const regenerated = execFileSync('node', ['scripts/api/generate.ts', '--out', out], {
  cwd: root,
  encoding: 'utf8',
})

describe('npm run api:generate', () => {
  it('reports what it read from the pinned contract', () => {
    expect(regenerated).toContain('115 operations')
  })

  it.each(GENERATED)('regenerates %s byte for byte', (relative) => {
    const fresh = readFileSync(join(out, relative))
    const committed = readFileSync(join(root, relative))
    // Hashes rather than the contents: a 9 500-line diff in the failure output helps
    // nobody, and the fix is always the same — run the generator and commit the result.
    expect(createHash('sha256').update(fresh).digest('hex')).toBe(
      createHash('sha256').update(committed).digest('hex')
    )
  })

  it('marks every generated file as generated', () => {
    for (const relative of GENERATED) {
      expect(readFileSync(join(root, relative), 'utf8')).toContain(
        'GENERATED FILE — DO NOT EDIT. Regenerate with: npm run api:generate'
      )
    }
  })
})

describe('the generator can fail', () => {
  // This test runs the generator twice against mutated fixtures, which takes about six
  // seconds on a laptop; Vitest's default budget is five, so it timed out intermittently.
  it(
    'catches a missing example and a contract that does not match its lock',
    { timeout: 30_000 },
    () => {
      // The self-test runs the generator on deliberately broken fixtures. If it stops
      // catching them, the gate above is measuring nothing.
      const output = execFileSync('scripts/api/generate.selftest.sh', {
        cwd: root,
        encoding: 'utf8',
      })
      expect(output).toContain('both caught')
    }
  )
})

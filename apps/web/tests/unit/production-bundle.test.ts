// console PR #35 review at 75deb37: a production build (`VITE_AUTH_MODE=oidc
// VITE_ENABLE_MSW=0`) still shipped the mock identity provider's route, its
// `mock-authorization-code` literal, and the msw module itself — a
// runtime-only gate is not a bundle exclusion. `scripts/check-production-
// bundle.sh` (`npm run build:check`) is the proof that stays true.
//
// Round 3: the check and its self-test moved out of `npm test` and into
// their own CI job (`.github/workflows/ci.yml`, job `bundle`) — each one
// runs a real `vite build`, a cost this suite's jsdom-only loop shouldn't
// carry every run. What stays here is cheap: the wiring is real (the files
// exist, are executable, and `build:check` actually calls the script), so a
// CI edit that quietly points `bundle` at nothing, or a script deleted out
// from under it, fails fast in `npm test` rather than waiting for the next
// CI run to go green on skipped work.

import { accessSync, constants, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const CHECK = 'scripts/check-production-bundle.sh'
const SELFTEST = 'scripts/check-production-bundle.selftest.sh'

function isExecutable(relativePath: string): boolean {
  // `X_OK`, not just existence: a script that lost its executable bit in a
  // careless commit fails every CI run with "permission denied" — a check
  // that only asked "does the file exist" would stay green through that.
  try {
    accessSync(join(root, relativePath), constants.X_OK)
    return true
  } catch {
    return false
  }
}

describe('scripts/check-production-bundle.sh', () => {
  it('exists and is executable', () => {
    expect(isExecutable(CHECK)).toBe(true)
  })

  it('has an executable self-test', () => {
    expect(isExecutable(SELFTEST)).toBe(true)
  })

  it('is what `npm run build:check` actually invokes', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['build:check']).toContain(CHECK)
  })
})

// The messaging demo preview is excluded from a production build by the same
// build-time fold as the mock identity provider, and proved excluded by the
// same script. The proof itself is three string literals in a shell array,
// which nothing in the type system holds to the source they came from: rename
// the route, drop the marker attribute, reword the fixture sentence, and the
// grep quietly matches nothing while still reporting OK.
//
// So the pairing is asserted here, cheaply, in both directions — the source
// still contains each literal, and the check still names it. The expensive
// half (does an oidc build actually omit them, and can that fail) stays in
// CI's `bundle` job, where `scripts/check-production-bundle.selftest.sh`
// mutates a clean production build one marker at a time.
describe('the messaging demo preview markers the bundle check greps for', () => {
  const SOURCES: Record<string, string> = {
    '__demo-messaging': 'src/features/messaging/demo-route.tsx',
    'data-messaging-demo-surface': 'src/features/messaging/MessagingDemoSurface.tsx',
    'Coulage de la dalle R+2': 'src/features/messaging/demo-fixture.ts',
  }

  const check = readFileSync(join(root, CHECK), 'utf8')
  const selftest = readFileSync(join(root, SELFTEST), 'utf8')

  it.each(Object.entries(SOURCES))(
    'still exists in the source it was taken from: %s',
    (literal, file) => {
      expect(readFileSync(join(root, file), 'utf8')).toContain(literal)
    }
  )

  it.each(Object.keys(SOURCES))('is still named by the check itself: %s', (literal) => {
    expect(check).toContain(literal)
  })

  it.each(Object.keys(SOURCES))('is still mutated by the self-test: %s', (literal) => {
    expect(selftest).toContain(literal)
  })
})

describe('local workspace registry production isolation', () => {
  const marker = 'kodera.demo.local-workspaces'
  it('keeps the source marker paired with the bundle gate and its mutation proof', () => {
    expect(readFileSync(join(root, 'src/mocks/demo/localWorkspaces.ts'), 'utf8')).toContain(marker)
    expect(readFileSync(join(root, CHECK), 'utf8')).toContain(marker)
    expect(readFileSync(join(root, SELFTEST), 'utf8')).toContain(marker)
  })
})

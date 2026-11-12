// `npm run i18n:check` on the real tree, and the proof that each of its new checks bites on it:
// the real catalogues and the real route units with exactly one fault put in, in memory. The
// fixture-level proofs — every refusal, with its message — are the two shell self-tests, which
// this file also runs, so they are part of `npm test` and not only of a contributor's memory.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  checkNamespaceCatalogues,
  readNamespaceCatalogues,
  unionOf,
} from '../../../scripts/i18n/catalogues.ts'
import { checkRouteNamespaces } from '../../../scripts/i18n/route-namespaces.ts'
import {
  ENTRY_NAMESPACES,
  MESSAGE_NAMESPACES,
  ORGANISATION_NAMESPACES,
} from '../../../src/i18n/namespaces.ts'

const root = join(import.meta.dirname, '..', '..', '..')
const whole = (locale: 'fr' | 'en') =>
  JSON.parse(readFileSync(join(root, 'src', 'i18n', `${locale}.json`), 'utf8')) as Record<
    string,
    string
  >
const catalogues = () => readNamespaceCatalogues(join(root, 'src', 'i18n', 'catalogues'))
const routes = (entryNamespaces: readonly string[] = ENTRY_NAMESPACES) =>
  checkRouteNamespaces({
    srcDir: join(root, 'src'),
    entry: join(root, 'src', 'main.tsx'),
    namespaces: MESSAGE_NAMESPACES,
    entryNamespaces,
    namedLists: { ORGANISATION_NAMESPACES },
  })

describe('the namespace catalogues', () => {
  const input = () => ({
    catalogues: catalogues(),
    declared: MESSAGE_NAMESPACES,
    whole: { fr: whole('fr'), en: whole('en') },
  })

  it('are sound: same namespaces and keys in both locales, adding up to the whole catalogue', () => {
    expect(checkNamespaceCatalogues(input())).toEqual([])
    expect(unionOf(catalogues().fr)).toEqual(whole('fr'))
    expect(unionOf(catalogues().en)).toEqual(whole('en'))
  })

  it('refuse a key one locale has in a namespace and the other lacks', () => {
    const broken = input()
    delete broken.catalogues.en['people']?.['console.people.list.title']
    expect(checkNamespaceCatalogues(broken)).toContain(
      'key in fr/people.json is missing from en/people.json: console.people.list.title'
    )
  })

  it('refuse a namespace the runtime does not list, and one it lists that has no catalogue', () => {
    expect(
      checkNamespaceCatalogues({ ...input(), declared: [...MESSAGE_NAMESPACES, 'ghost'] })
    ).toContain(
      'namespace "ghost" is listed in MESSAGE_NAMESPACES (src/i18n/namespaces.ts) and has no catalogue'
    )
    expect(
      checkNamespaceCatalogues({
        ...input(),
        declared: MESSAGE_NAMESPACES.filter((namespace) => namespace !== 'people'),
      })
    ).toContain(
      'namespace "people" has catalogues and is not listed in MESSAGE_NAMESPACES (src/i18n/namespaces.ts)'
    )
  })

  it('refuse a whole catalogue the namespaces no longer add up to', () => {
    const broken = input()
    broken.whole.fr['console.common.only-in-the-whole-catalogue'] = 'x'
    expect(checkNamespaceCatalogues(broken)).toContain(
      'key in fr.json is in no fr namespace catalogue (run npm run i18n:generate): console.common.only-in-the-whole-catalogue'
    )
  })
})

describe('the namespaces of the routes', () => {
  it('are enough: no module reads a namespace that is not loaded where it is reachable', () => {
    const result = routes()
    expect(result.problems).toEqual([])
    // The entry, the organisation layout, its eleven areas, and the three gated top-level routes.
    expect(result.contexts.map((context) => context.name)).toEqual(
      expect.arrayContaining([
        'the application entry',
        'the "organisation" route unit',
        'the "people" route unit',
        'the "workspace" route unit',
      ])
    )
    expect(result.contexts.length).toBeGreaterThanOrEqual(13)
  })

  it('name nothing that no screen behind them reads', () => {
    expect(routes().contexts.filter((context) => context.unused.length > 0)).toEqual([])
  })

  it('refuse an entry that reads a namespace it does not carry', () => {
    // The sign-in screen is part of the entry; take its namespace away.
    const problems = routes(ENTRY_NAMESPACES.filter((namespace) => namespace !== 'login')).problems
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join('\n')).toMatch(
      /src\/features\/login\/LoginScreen\.tsx reads "console\.login\.[^"]+" and is reachable from the application entry, where the "login" namespace is not loaded/
    )
  })
})

describe('the self-tests of the i18n scripts', () => {
  it.each(['scripts/i18n/generate.selftest.sh', 'scripts/i18n/check-used-keys.selftest.sh'])(
    '%s passes: every refusal it stages is refused, by name',
    (script) => {
      const output = execFileSync('bash', [script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 110_000,
      })
      expect(output).toMatch(/^OK — /m)
    },
    120_000
  )
})

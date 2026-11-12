// The arithmetic of scripts/check-bundle-budget.mjs, on builds described by hand: which chunks are
// the entry, what each rule refuses and in what words, and that no budget can be set above its
// ceiling. The script's self-test (scripts/check-bundle-budget.selftest.mjs, run by CI) proves the
// same refusals on real builds; this proves the edges a real build does not happen to have.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_ENFORCED,
  BUDGETS,
  CEILINGS,
  ENTRY_REGRESSION_LIMITS,
  FORBIDDEN_ENTRY_VENDORS,
  RULES,
  budgetsFor,
  measure,
  triage,
  // @ts-expect-error: a Node script with no type declarations, imported for its exports.
} from '../../scripts/check-bundle-budget.mjs'

interface Chunk {
  fileName: string
  imports: string[]
  dynamicImports: string[]
  modules: string[]
  isEntry: boolean
  gzip: number
  bytes: number
}

interface Result {
  entryGzip: number
  entry: { fileName: string }[]
  deferredCount: number
  largestDeferred: { fileName: string; gzip: number } | undefined
  violations: string[]
}

const chunk = (fileName: string, overrides: Partial<Chunk> = {}): Chunk => ({
  fileName,
  imports: [],
  dynamicImports: [],
  modules: [`/repo/apps/web/src/${fileName}`],
  isEntry: false,
  gzip: 1_000,
  bytes: 3_000,
  ...overrides,
})

/** A bootstrap that imports the application dynamically, a shared chunk, and two lazy routes. */
function build(overrides: Record<string, Partial<Chunk>> = {}): {
  chunks: Chunk[]
  htmlScripts: string[]
  htmlPreloads: string[]
} {
  const chunks = [
    chunk('assets/index.js', { isEntry: true, dynamicImports: ['assets/main.js'] }),
    chunk('assets/main.js', {
      imports: ['assets/shared.js'],
      dynamicImports: ['assets/route-people.js', 'assets/route-workspace.js'],
      gzip: 100_000,
    }),
    chunk('assets/shared.js', { gzip: 40_000 }),
    chunk('assets/route-people.js', { imports: ['assets/shared.js'], gzip: 30_000 }),
    chunk('assets/route-workspace.js', { imports: ['assets/vendor-matrix.js'], gzip: 150_000 }),
    chunk('assets/vendor-matrix.js', {
      modules: ['/repo/node_modules/matrix-js-sdk/lib/matrix.js'],
      gzip: 170_000,
    }),
  ].map((entry) => ({ ...entry, ...overrides[entry.fileName] }))
  return { chunks, htmlScripts: ['assets/index.js'], htmlPreloads: [] }
}

/** Measured against the ceilings unless a test names its own budgets: the enforced budgets move
 * with the build, and what these fixtures weigh should not have to. */
const run = (
  input: ReturnType<typeof build>,
  budgets: { entryGzip: number; chunkGzip: number; entryRegressionGzip?: number } = { ...CEILINGS }
): Result => measure({ ...input, budgets }) as Result

describe('the limits', () => {
  it('are the product ceilings: 180 kB for the entry, 350 kB for any other chunk', () => {
    expect(CEILINGS).toEqual({ entryGzip: 180_000, chunkGzip: 350_000 })
  })

  it('enforce budgets at or below those ceilings, and use them when none is given', () => {
    expect(BUDGETS.entryGzip).toBeLessThanOrEqual(CEILINGS.entryGzip)
    expect(BUDGETS.chunkGzip).toBeLessThanOrEqual(CEILINGS.chunkGzip)
    const heavy = build({ 'assets/vendor-matrix.js': { gzip: BUDGETS.chunkGzip + 1 } })
    expect((measure(heavy) as Result).violations).toEqual([
      `CHUNK_OVER_BUDGET: assets/vendor-matrix.js is ${BUDGETS.chunkGzip + 1} bytes gzip, over the per-chunk budget of ${BUDGETS.chunkGzip}`,
    ])
  })

  it.each([
    ['the entry', { entryGzip: CEILINGS.entryGzip + 1, chunkGzip: 1 }],
    ['a chunk', { entryGzip: 1, chunkGzip: CEILINGS.chunkGzip + 1 }],
    ['nothing at all', { entryGzip: 0, chunkGzip: 1 }],
  ])('refuse to measure with a budget above its ceiling, or absent, for %s', (_name, budgets) => {
    expect(() => run(build(), budgets)).toThrow('at or below its ceiling')
  })

  it('name the three vendors the entry may not carry', () => {
    expect(FORBIDDEN_ENTRY_VENDORS).toEqual(['matrix-js-sdk', 'livekit-client', 'oidc-client-ts'])
  })
})

describe('the entry', () => {
  it('is the bootstrap, the application it imports, and their static imports', () => {
    const result = run(build())
    expect(result.entry.map((entry) => entry.fileName)).toEqual([
      'assets/index.js',
      'assets/main.js',
      'assets/shared.js',
    ])
    expect(result.entryGzip).toBe(1_000 + 100_000 + 40_000)
    expect(result.deferredCount).toBe(3)
    expect(result.largestDeferred).toEqual({ fileName: 'assets/vendor-matrix.js', gzip: 170_000 })
    expect(result.violations).toEqual([])
  })

  it('includes what index.html preloads, though nothing imports it', () => {
    const input = build()
    input.htmlPreloads.push('assets/route-people.js')
    expect(run(input).entry.map((entry) => entry.fileName)).toContain('assets/route-people.js')
  })

  it('passes at its budget and is refused one byte over it', () => {
    const budgets = { entryGzip: 141_000, chunkGzip: CEILINGS.chunkGzip }
    expect(run(build(), budgets).violations).toEqual([])
    expect(run(build({ 'assets/shared.js': { gzip: 40_001 } }), budgets).violations).toEqual([
      'ENTRY_OVER_BUDGET: the entry JavaScript is 141001 bytes gzip, over its budget of 141000',
    ])
  })

  it('refuses each forbidden vendor by name, with the chain of imports that brought it in', () => {
    for (const vendor of FORBIDDEN_ENTRY_VENDORS as string[]) {
      // The shared chunk, which the application imports, now imports the vendor's chunk.
      const input = build({
        'assets/shared.js': { imports: ['assets/vendor-matrix.js'] },
        'assets/vendor-matrix.js': {
          modules: [`/repo/node_modules/${vendor}/dist/index.js`],
          gzip: 10_000,
        },
      })
      expect(run(input).violations).toEqual([
        `FORBIDDEN_ENTRY_VENDOR: ${vendor} is in the entry, in assets/main.js -> assets/shared.js -> assets/vendor-matrix.js`,
      ])
    }
  })

  it('accepts those vendors behind a dynamic import, and a package that only resembles one', () => {
    const input = build({
      'assets/shared.js': {
        modules: [
          '/repo/node_modules/matrix-js-sdk-not/index.js',
          '/repo/node_modules/@scope/oidc-client-ts-helpers/index.js',
        ],
      },
    })
    expect(run(input).violations).toEqual([])
  })

  it('refuses the whole catalogue, another language, and another area, each by path', () => {
    const input = build({
      'assets/main.js': {
        imports: ['assets/shared.js'],
        dynamicImports: [],
        gzip: 100_000,
        modules: [
          '/repo/apps/web/src/i18n/catalogues/fr/common.json',
          '/repo/apps/web/src/i18n/catalogues/fr/shell.json',
          '/repo/apps/web/src/i18n/fr.json',
          '/repo/apps/web/src/i18n/catalogues/en/common.json',
          '/repo/apps/web/src/i18n/catalogues/fr/people.json',
        ],
      },
    })
    expect(run(input).violations).toEqual([
      'ENTRY_CATALOGUE: src/i18n/fr.json is in the entry, in assets/main.js',
      'ENTRY_CATALOGUE: src/i18n/catalogues/en/common.json is in the entry, in assets/main.js',
      'ENTRY_CATALOGUE: src/i18n/catalogues/fr/people.json is in the entry, in assets/main.js',
    ])
  })
})

// The entry does not meet its 180 kB target (the gate's status note says why), so a second,
// separate number stops it getting worse. These hold the two apart: the limit is never the
// target, never replaces it, and cannot be switched off the way the target's failure is.
describe('the entry regression limit', () => {
  // The fixture's entry weighs 141 000 bytes.
  const withLimit = (limit: number, target = 100_000) => ({
    entryGzip: target,
    chunkGzip: CEILINGS.chunkGzip,
    entryRegressionGzip: limit,
  })

  it('is a number per profile, a few kilobytes above what that profile measures', () => {
    expect(ENTRY_REGRESSION_LIMITS).toEqual({ production: 228_000, staging: 230_000 })
    expect(budgetsFor('production')).toEqual({ ...BUDGETS, entryRegressionGzip: 228_000 })
    expect(budgetsFor('staging')).toEqual({ ...BUDGETS, entryRegressionGzip: 230_000 })
    expect(() => budgetsFor('preview')).toThrow('unknown profile "preview"')
  })

  it('only ever goes down: raising one means changing this line, and saying why', () => {
    expect(ENTRY_REGRESSION_LIMITS.production).toBeLessThanOrEqual(228_000)
    expect(ENTRY_REGRESSION_LIMITS.staging).toBeLessThanOrEqual(230_000)
  })

  it('holds at the limit and is refused one byte over it, by its own name', () => {
    const regressions = (mainGzip: number) =>
      run(build({ 'assets/main.js': { gzip: mainGzip } }), withLimit(181_000, 180_000)).violations
    // 181 000 bytes: over the target, which says so, and exactly at the limit, which holds.
    expect(regressions(140_000)).toEqual([
      'ENTRY_OVER_BUDGET: the entry JavaScript is 181000 bytes gzip, over its budget of 180000',
    ])
    expect(regressions(140_001)).toEqual([
      'ENTRY_OVER_BUDGET: the entry JavaScript is 181001 bytes gzip, over its budget of 180000',
      'ENTRY_REGRESSION: the entry JavaScript is 181001 bytes gzip, over its regression limit of 181000 (the limit is not the target: the target is 180000)',
    ])
  })

  it('does not stand in for the target: an entry under the limit and over the target is still over the target', () => {
    expect(run(build(), withLimit(200_000)).violations).toEqual([
      'ENTRY_OVER_BUDGET: the entry JavaScript is 141000 bytes gzip, over its budget of 100000',
    ])
  })

  it('is reported beside the target, not instead of it, when both are passed', () => {
    const input = build({ 'assets/main.js': { gzip: 200_000 } })
    expect(run(input, withLimit(190_000, 180_000)).violations).toEqual([
      'ENTRY_OVER_BUDGET: the entry JavaScript is 241000 bytes gzip, over its budget of 180000',
      'ENTRY_REGRESSION: the entry JavaScript is 241000 bytes gzip, over its regression limit of 190000 (the limit is not the target: the target is 180000)',
    ])
  })

  it.each([CEILINGS.entryGzip, CEILINGS.entryGzip - 1, 0, 1.5])(
    'refuses to measure with a limit of %s: at or below the target, the target is what is enforced',
    (limit) => {
      expect(() => run(build(), withLimit(limit, 180_000))).toThrow(
        'must be a number of bytes above the entry ceiling (180000)'
      )
    }
  )

  it('is applied when no budgets are given, as the production profile has it', () => {
    const input = build({
      'assets/main.js': { gzip: 228_000 - 41_000 + 1 },
      'assets/vendor-matrix.js': { gzip: 1 },
    })
    expect((measure(input) as Result).violations).toEqual([
      'ENTRY_OVER_BUDGET: the entry JavaScript is 228001 bytes gzip, over its budget of 180000',
      'ENTRY_REGRESSION: the entry JavaScript is 228001 bytes gzip, over its regression limit of 228000 (the limit is not the target: the target is 180000)',
    ])
  })
})

describe('a deferred chunk', () => {
  it('passes at its budget and is refused one byte over it, by file name', () => {
    const budgets = { entryGzip: CEILINGS.entryGzip, chunkGzip: 170_000 }
    expect(run(build(), budgets).violations).toEqual([])
    expect(
      run(build({ 'assets/vendor-matrix.js': { gzip: 170_001 } }), budgets).violations
    ).toEqual([
      'CHUNK_OVER_BUDGET: assets/vendor-matrix.js is 170001 bytes gzip, over the per-chunk budget of 170000',
    ])
  })

  it('is judged on its own: an entry chunk over the per-chunk budget is the entry rule’s business', () => {
    const budgets = { entryGzip: CEILINGS.entryGzip, chunkGzip: 50_000 }
    const codes = run(build({ 'assets/vendor-matrix.js': { gzip: 1 } }), budgets).violations.map(
      (violation) => violation.split(' ')[1]
    )
    // main.js (100 kB) is over 50 kB and is not named; the two lazy routes are judged one by one.
    expect(codes).toEqual(['assets/route-workspace.js'])
  })
})

describe('chunks that import each other', () => {
  it('are refused as one cycle, every member named, whatever their size', () => {
    const input = build({
      'assets/route-workspace.js': { imports: ['assets/vendor-matrix.js'], gzip: 1 },
      'assets/vendor-matrix.js': {
        imports: ['assets/shared.js', 'assets/route-workspace.js'],
        gzip: 1,
      },
    })
    expect(run(input).violations).toEqual([
      'CHUNK_CYCLE: these chunks import each other: assets/route-workspace.js, assets/vendor-matrix.js',
    ])
  })

  it('are found through any number of chunks in between, and when a chunk imports itself', () => {
    const through = build({
      'assets/route-people.js': { imports: ['assets/route-workspace.js'] },
      'assets/route-workspace.js': { imports: ['assets/vendor-matrix.js'] },
      'assets/vendor-matrix.js': { imports: ['assets/route-people.js'] },
    })
    expect(run(through).violations).toEqual([
      'CHUNK_CYCLE: these chunks import each other: assets/route-people.js, assets/route-workspace.js, assets/vendor-matrix.js',
    ])
    const self = build({ 'assets/shared.js': { imports: ['assets/shared.js'] } })
    expect(run(self).violations).toEqual([
      'CHUNK_CYCLE: these chunks import each other: assets/shared.js',
    ])
  })

  it('are not seen in a diamond, where two chunks share a third', () => {
    const diamond = build({
      'assets/route-people.js': { imports: ['assets/shared.js', 'assets/vendor-matrix.js'] },
    })
    expect(run(diamond).violations).toEqual([])
  })

  it('are not a cycle when the way back is a dynamic import', () => {
    const lazy = build({
      'assets/vendor-matrix.js': { dynamicImports: ['assets/route-workspace.js'] },
    })
    expect(run(lazy).violations).toEqual([])
  })
})

describe('a malformed description', () => {
  it('is refused rather than measured as an empty entry', () => {
    expect(() => run({ ...build(), htmlScripts: [] })).toThrow('index.html names no script')
    expect(() => run({ ...build(), htmlScripts: ['assets/missing.js'] })).toThrow(
      'a script the build did not emit'
    )
    expect(() =>
      run(build({ 'assets/main.js': { imports: ['assets/gone.js'], dynamicImports: [] } }))
    ).toThrow('names a chunk it did not emit')
  })
})

describe('reported-only rules', () => {
  const violations = [
    'ENTRY_OVER_BUDGET: the entry JavaScript is 2 bytes gzip, over its budget of 1',
    'FORBIDDEN_ENTRY_VENDOR: matrix-js-sdk is in the entry, in assets/main.js',
  ]

  it('fail the run by default, every one of them', () => {
    expect(triage(violations, [])).toEqual({ failing: violations, reported: [] })
  })

  it('hold the one rule named and nothing else', () => {
    expect(triage(violations, ['entry-size'])).toEqual({
      failing: [violations[1]],
      reported: [violations[0]],
    })
  })

  it('refuse a name that is not a rule, so a misspelt hold cannot pass for none', () => {
    expect(() => triage(violations, ['entry'])).toThrow('unknown rule "entry" for --report-only')
    expect(Object.keys(RULES)).toEqual([
      'entry-size',
      'chunk-size',
      'entry-vendors',
      'entry-catalogues',
      'chunk-cycles',
      'entry-regression',
    ])
  })

  it('refuse to hold the regression limit, alone or beside the target', () => {
    const grown = [
      ...violations,
      'ENTRY_REGRESSION: the entry JavaScript is 3 bytes gzip, over its regression limit of 2',
    ]
    expect(ALWAYS_ENFORCED).toEqual(['entry-regression'])
    expect(() => triage(grown, ['entry-regression'])).toThrow(
      '"entry-regression" cannot be reported only'
    )
    expect(() => triage(grown, ['entry-size', 'entry-regression'])).toThrow(
      '"entry-regression" cannot be reported only'
    )
    // Holding the target leaves the limit failing.
    expect(triage(grown, ['entry-size']).failing).toEqual([grown[1], grown[2]])
  })
})

// The gate and its self-test each run real builds, so they are a CI step of their own and not part
// of this suite (as `scripts/check-production-bundle.sh` is). What stays here is cheap: that CI
// does call them, on both release profiles, and holds no rule but the one known not to be met.
describe('the CI wiring', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', '.github', 'workflows', 'ci-web.yml'),
    'utf8'
  )
  const runs = workflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node scripts/check-bundle-budget'))

  it('runs the self-test, then the gate on the production and the staging profile', () => {
    expect(runs).toEqual([
      'node scripts/check-bundle-budget.selftest.mjs',
      'node scripts/check-bundle-budget.mjs --report-only entry-size',
      'node scripts/check-bundle-budget.mjs --profile staging --report-only entry-size',
    ])
  })

  it('holds the entry-size rule and no other, the regression limit least of all', () => {
    const held = runs.flatMap((line) =>
      [...line.matchAll(/--report-only\s+(\S+)/g)].map(([, rule]) => rule)
    )
    expect(new Set(held)).toEqual(new Set(['entry-size']))
    expect(held).not.toContain('entry-regression')
    expect(Object.keys(RULES)).toContain('entry-size')
    // Nothing in the workflow may quieten the step either.
    expect(workflow).not.toMatch(/check-bundle-budget[^\n]*\|\|/)
    expect(workflow.slice(workflow.indexOf('Bundle budget'))).not.toMatch(/continue-on-error/)
  })
})

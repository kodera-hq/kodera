// The bundle budget: what a visitor downloads before the sign-in screen, and how large any one
// later download may be.
//
// It builds the console the way a release does (the production profile of
// `scripts/check-production-bundle.sh`), reads the emitted files back from disk, and fails when:
//
// 1. the entry JavaScript, gzip-compressed, is over its budget. The entry is everything the page
//    fetches whatever the address: the bootstrap `index.html` names, the application chunk the
//    bootstrap imports, every chunk either of them imports statically, and anything `index.html`
//    preloads;
// 2. any other JavaScript chunk is over its budget. Those are fetched on demand, a route at a
//    time, so the limit is on each one;
// 3. the entry carries a vendor that only a signed-in workspace needs: `matrix-js-sdk`,
//    `livekit-client` or `oidc-client-ts`;
// 4. the entry carries message catalogues other than the default language's entry namespaces
//    (`src/i18n/namespaces.ts`): the whole catalogue, another language, or another area's;
// 5. two chunks import each other, directly or through others. A browser runs the files of such
//    a cycle in an order no one chose, and a module can then read a binding of another before it
//    exists. The bundler never produces one on its own; a manual chunk group can
//    (`vite.config.ts`, `deferredVendorGroups`).
//
// The two ceilings are the product's and are not to be raised. The budgets below them are what
// the build measures today plus a little room, so growth is noticed when it happens; lower them
// when the build shrinks. A budget above its ceiling stops the script before it measures anything.
//
// Status of the entry ceiling: NOT MET. The entry measures about 225 kB (production profile)
// against 180 kB, down from 907 kB before the route tree was split. What is left is almost all
// libraries the sign-in screen itself runs — react-dom, the router, i18next, zod, react-hook-form
// and the query client are about 164 kB of it between them — so the remainder is not a matter of
// splitting. The rule stays at the ceiling: by default this script fails on it. CI runs it with
// `--report-only entry-size` (.github/workflows/ci-web.yml), which measures and prints the rule
// and does not fail the run on it, and with nothing else relaxed. Remove that flag the day the
// entry fits; do not move the number.
//
// Sizes are gzip level 9 of each emitted file, in bytes; 1 kB is 1000 bytes, as Vite reports it.
//
// Usage:
//   node scripts/check-bundle-budget.mjs [--profile production|staging] [--json <file>]
//     [--report-only <rule>]   rule: entry-size, chunk-size, entry-vendors, entry-catalogues or
//     chunk-cycles.
//     A reported-only rule is measured and printed as NOT MET, and does not fail the run. It
//     exists for a ceiling the build does not meet yet; see the status note above.
//   node scripts/check-bundle-budget.mjs --mutation <name>
//     For the self-test only (`scripts/check-bundle-budget.selftest.sh`): builds with one fault
//     injected into the module graph, in memory, so the check can be shown to fail. Nothing in the
//     working tree is touched. Names: `vendor-matrix`, `vendor-livekit`, `vendor-oidc`,
//     `inflate-entry`, `inflate-chunk`, `whole-catalogue`, `area-catalogue`, `chunk-cycle`.
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

// From the module's own path, not `new URL('..', import.meta.url)`: under jsdom, where the unit
// suite imports this file, `URL` is the page's and its result is not a file URL Node accepts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The product's limits. Never raised: a build that cannot meet one is reported, not accommodated. */
export const CEILINGS = Object.freeze({ entryGzip: 180_000, chunkGzip: 350_000 })
/**
 * What is enforced: today's measurement plus a little room, never above a ceiling.
 *
 * - `entryGzip`: the ceiling itself; the entry is above it (see the status note at the top).
 * - `chunkGzip`: the largest deferred chunk is `matrix-js-sdk` in its own file, at about 148 kB.
 */
export const BUDGETS = Object.freeze({ entryGzip: 180_000, chunkGzip: 160_000 })

/** The rules, by the name `--report-only` takes. A violation starts with its rule's code. */
export const RULES = Object.freeze({
  'entry-size': 'ENTRY_OVER_BUDGET',
  'chunk-size': 'CHUNK_OVER_BUDGET',
  'entry-vendors': 'FORBIDDEN_ENTRY_VENDOR',
  'entry-catalogues': 'ENTRY_CATALOGUE',
  'chunk-cycles': 'CHUNK_CYCLE',
})

export const FORBIDDEN_ENTRY_VENDORS = Object.freeze([
  'matrix-js-sdk',
  'livekit-client',
  'oidc-client-ts',
])

/** The default language's copy of the entry namespaces is the only catalogue the entry may hold. */
const ENTRY_CATALOGUE =
  /[\\/]src[\\/]i18n[\\/]catalogues[\\/]fr[\\/](common|invitation|login|shell)\.json$/
const ANY_CATALOGUE =
  /[\\/]src[\\/]i18n[\\/](?:(fr|en)\.json|catalogues[\\/](fr|en)[\\/]([a-z]+)\.json)$/

export class BudgetError extends Error {}

function packageOf(moduleId) {
  const match = /.*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(moduleId)
  return match?.[1]?.replace('\\', '/')
}

/** Every chunk reachable from `start` through static imports, `start` included, in visit order. */
function staticClosure(chunks, start) {
  const seen = new Map()
  const queue = start.map((name) => [name, undefined])
  while (queue.length > 0) {
    const [name, from] = queue.shift()
    if (seen.has(name)) continue
    const chunk = chunks.get(name)
    if (chunk === undefined)
      throw new BudgetError(`the build names a chunk it did not emit: ${name}`)
    seen.set(name, from)
    for (const imported of chunk.imports) queue.push([imported, name])
  }
  return seen
}

/**
 * The groups of chunks that import each other through static imports, each sorted by name:
 * the strongly connected components of the import graph that hold more than one chunk, or one
 * chunk that imports itself.
 */
function staticCycles(chunks) {
  const index = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const cycles = []
  const visit = (name) => {
    index.set(name, index.size)
    low.set(name, index.get(name))
    stack.push(name)
    onStack.add(name)
    for (const imported of chunks.get(name)?.imports ?? []) {
      if (!chunks.has(imported)) continue
      if (!index.has(imported)) {
        visit(imported)
        low.set(name, Math.min(low.get(name), low.get(imported)))
      } else if (onStack.has(imported)) {
        low.set(name, Math.min(low.get(name), index.get(imported)))
      }
    }
    if (low.get(name) !== index.get(name)) return
    const component = []
    for (let member = stack.pop(); ; member = stack.pop()) {
      onStack.delete(member)
      component.push(member)
      if (member === name) break
    }
    if (component.length > 1 || chunks.get(name).imports.includes(name)) {
      cycles.push(component.sort())
    }
  }
  for (const name of chunks.keys()) if (!index.has(name)) visit(name)
  return cycles.sort((left, right) => left[0].localeCompare(right[0]))
}

function chainTo(closure, name) {
  const chain = []
  for (let current = name; current !== undefined; current = closure.get(current)) {
    chain.unshift(current)
  }
  return chain.join(' -> ')
}

/**
 * The pure part: a description of an emitted build in, measurements and violations out.
 *
 * @param {{
 *   chunks: { fileName: string, imports: string[], dynamicImports: string[], modules: string[],
 *     isEntry: boolean, gzip: number, bytes: number }[],
 *   htmlScripts: string[], htmlPreloads: string[], budgets?: { entryGzip: number, chunkGzip: number }
 * }} input
 */
export function measure(input) {
  const budgets = input.budgets ?? BUDGETS
  for (const key of ['entryGzip', 'chunkGzip']) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] <= 0 || budgets[key] > CEILINGS[key]) {
      throw new BudgetError(
        `the ${key} budget (${budgets[key]}) must be a positive number of bytes at or below its ceiling (${CEILINGS[key]})`
      )
    }
  }
  const chunks = new Map(input.chunks.map((chunk) => [chunk.fileName, chunk]))
  if (chunks.size !== input.chunks.length) throw new BudgetError('two chunks share a file name')
  if (input.htmlScripts.length === 0) throw new BudgetError('index.html names no script')

  // The bootstrap is import-free by contract (`vite.config.ts`, `assertEntryBootstrapGraph`) and
  // reaches the application through one dynamic import; that application chunk is fetched on
  // every address, so it and its static imports are the entry as much as the bootstrap is.
  const roots = [...input.htmlScripts, ...input.htmlPreloads]
  for (const script of input.htmlScripts) {
    const chunk = chunks.get(script)
    if (chunk === undefined)
      throw new BudgetError(`index.html names a script the build did not emit: ${script}`)
    roots.push(...chunk.dynamicImports)
  }
  const closure = staticClosure(chunks, roots)
  const entry = [...closure.keys()].map((name) => chunks.get(name))
  const deferred = input.chunks.filter((chunk) => !closure.has(chunk.fileName))
  const entryGzip = entry.reduce((sum, chunk) => sum + chunk.gzip, 0)

  const violations = []
  if (entryGzip > budgets.entryGzip) {
    violations.push(
      `ENTRY_OVER_BUDGET: the entry JavaScript is ${entryGzip} bytes gzip, over its budget of ${budgets.entryGzip}`
    )
  }
  for (const chunk of deferred) {
    if (chunk.gzip > budgets.chunkGzip) {
      violations.push(
        `CHUNK_OVER_BUDGET: ${chunk.fileName} is ${chunk.gzip} bytes gzip, over the per-chunk budget of ${budgets.chunkGzip}`
      )
    }
  }
  for (const chunk of entry) {
    const vendors = new Set(chunk.modules.map(packageOf))
    for (const vendor of FORBIDDEN_ENTRY_VENDORS) {
      if (vendors.has(vendor)) {
        violations.push(
          `FORBIDDEN_ENTRY_VENDOR: ${vendor} is in the entry, in ${chainTo(closure, chunk.fileName)}`
        )
      }
    }
    for (const moduleId of chunk.modules) {
      if (ANY_CATALOGUE.test(moduleId) && !ENTRY_CATALOGUE.test(moduleId)) {
        violations.push(
          `ENTRY_CATALOGUE: ${moduleId.replace(/^.*[\\/]src[\\/]/, 'src/')} is in the entry, in ${chainTo(closure, chunk.fileName)}`
        )
      }
    }
  }
  for (const cycle of staticCycles(chunks)) {
    violations.push(`CHUNK_CYCLE: these chunks import each other: ${cycle.join(', ')}`)
  }
  const largestDeferred = deferred.reduce(
    (largest, chunk) => (largest === undefined || chunk.gzip > largest.gzip ? chunk : largest),
    undefined
  )
  return {
    budgets,
    entryGzip,
    entry: entry.map(({ fileName, gzip, bytes }) => ({ fileName, gzip, bytes })),
    deferredCount: deferred.length,
    largestDeferred:
      largestDeferred === undefined
        ? undefined
        : { fileName: largestDeferred.fileName, gzip: largestDeferred.gzip },
    deferred: deferred
      .map(({ fileName, gzip, bytes }) => ({ fileName, gzip, bytes }))
      .sort((left, right) => right.gzip - left.gzip),
    violations,
  }
}

/** Text no compressor shrinks much: what a mutation uses to make a chunk heavier by a known amount. */
function ballast(bytes) {
  let text = ''
  for (let block = 0; text.length < bytes; block++) {
    text += createHash('sha256').update(`bundle-budget-ballast-${block}`).digest('base64')
  }
  return text.slice(0, bytes)
}

const MAIN_MODULE = join(ROOT, 'src', 'main.tsx')
const ORGANISATION_MODULE = join(ROOT, 'src', 'app', 'org-route.tsx')
const BALLAST_ID = '\0bundle-budget-ballast'
/** Two modules that import each other, for the mutation that forces each into a file of its own. */
const CYCLE_IDS = ['\0bundle-budget-cycle-a', '\0bundle-budget-cycle-b']
const VIRTUAL_MODULES = {
  [CYCLE_IDS[0]]: `import { b } from ${JSON.stringify(CYCLE_IDS[1])}\nexport const a = () => b`,
  [CYCLE_IDS[1]]: `import { a } from ${JSON.stringify(CYCLE_IDS[0])}\nexport const b = () => a`,
}

/**
 * One injected fault each: `source` is imported by `into`, and kept observable so that no bundler
 * can shake it out. `groups` are manual chunk groups added to the build's own.
 */
const MUTATIONS = {
  'vendor-matrix': { into: MAIN_MODULE, source: 'matrix-js-sdk' },
  'vendor-livekit': { into: MAIN_MODULE, source: 'livekit-client' },
  'vendor-oidc': { into: MAIN_MODULE, source: 'oidc-client-ts' },
  'inflate-entry': { into: MAIN_MODULE, source: BALLAST_ID, ballast: 4 * CEILINGS.entryGzip },
  'inflate-chunk': {
    into: ORGANISATION_MODULE,
    source: BALLAST_ID,
    ballast: 4 * CEILINGS.chunkGzip,
  },
  'whole-catalogue': { into: MAIN_MODULE, source: join(ROOT, 'src', 'i18n', 'fr.json') },
  'area-catalogue': {
    into: MAIN_MODULE,
    source: join(ROOT, 'src', 'i18n', 'catalogues', 'fr', 'people.json'),
  },
  // What a careless manual chunk group does: two modules that need each other, each sent to a
  // file of its own.
  'chunk-cycle': {
    into: ORGANISATION_MODULE,
    source: CYCLE_IDS[0],
    groups: CYCLE_IDS.map((id, index) => ({
      name: `cycle-${index}`,
      test: (moduleId) => moduleId === id,
      priority: 100,
      includeDependenciesRecursively: false,
    })),
  },
}

function mutationPlugin(name) {
  const mutation = MUTATIONS[name]
  if (mutation === undefined) {
    throw new BudgetError(
      `unknown mutation "${name}"; one of: ${Object.keys(MUTATIONS).join(', ')}`
    )
  }
  let applied = false
  return {
    plugin: {
      name: 'bundle-budget-mutation',
      enforce: 'pre',
      resolveId(id) {
        return id === BALLAST_ID || Object.hasOwn(VIRTUAL_MODULES, id) ? id : undefined
      },
      load(id) {
        if (Object.hasOwn(VIRTUAL_MODULES, id)) return VIRTUAL_MODULES[id]
        return id === BALLAST_ID
          ? `export default ${JSON.stringify(ballast(mutation.ballast ?? 0))}`
          : undefined
      },
      transform(code, id) {
        if (id.split('?')[0] !== mutation.into) return undefined
        applied = true
        return {
          code:
            `import * as bundleBudgetMutation from ${JSON.stringify(mutation.source)}\n` +
            `globalThis.bundleBudgetMutation = bundleBudgetMutation\n${code}`,
          map: null,
        }
      },
    },
    groups: mutation.groups ?? [],
    assertApplied() {
      if (!applied) throw new BudgetError(`mutation "${name}" found no module to change`)
    },
  }
}

/** The environment of a release build, as `scripts/check-production-bundle.sh` sets it. */
function profileEnvironment(profile) {
  return {
    VITE_AUTH_MODE: 'oidc',
    VITE_ENABLE_MSW: '0',
    VITE_FIRST_OWNER_JOURNEY: profile === 'staging' ? '1' : '0',
    VITE_CORE_API_URL: 'http://localhost:8000/api/v1',
    VITE_KEYCLOAK_URL: 'http://localhost:8080',
    VITE_OIDC_CLIENT_ID: 'console',
    VITE_MATRIX_DOMAIN: 'kodera.invalid',
  }
}

/** Builds into `outDir` and describes what was emitted, sizes read back from the files on disk. */
export async function describeBuild({ outDir, profile = 'production', mutation }) {
  if (profile !== 'production' && profile !== 'staging') {
    throw new BudgetError(`unknown profile "${profile}"`)
  }
  const captured = []
  const mutant = mutation === undefined ? undefined : mutationPlugin(mutation)
  const previous = {}
  const environment = profileEnvironment(profile)
  for (const [key, value] of Object.entries(environment)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    await build({
      root: ROOT,
      configFile: join(ROOT, 'vite.config.ts'),
      mode: 'production',
      logLevel: 'error',
      build: {
        outDir,
        emptyOutDir: true,
        // Vite appends these to the groups of `vite.config.ts`; none unless a mutation asks.
        ...(mutant === undefined || mutant.groups.length === 0
          ? {}
          : { rolldownOptions: { output: { codeSplitting: { groups: mutant.groups } } } }),
      },
      plugins: [
        ...(mutant === undefined ? [] : [mutant.plugin]),
        {
          name: 'bundle-budget-capture',
          enforce: 'post',
          generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
              if (chunk.type !== 'chunk') continue
              captured.push({
                fileName: chunk.fileName,
                imports: [...chunk.imports],
                dynamicImports: [...chunk.dynamicImports],
                modules: Object.keys(chunk.modules),
                isEntry: chunk.isEntry,
              })
            }
          },
        },
      ],
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  mutant?.assertApplied()
  if (captured.length === 0) throw new BudgetError('the build emitted no JavaScript chunk')

  const chunks = []
  for (const chunk of captured) {
    const source = await readFile(join(outDir, chunk.fileName))
    chunks.push({ ...chunk, bytes: source.length, gzip: gzipSync(source, { level: 9 }).length })
  }
  const html = await readFile(join(outDir, 'index.html'), 'utf8')
  const assetOf = (tag) => /(?:src|href)="\/?([^"]+)"/.exec(tag)?.[1]
  const htmlScripts = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)]
    .map(([tag]) => assetOf(tag))
    .filter((name) => name !== undefined)
  const htmlPreloads = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/g)]
    .map(([tag]) => assetOf(tag))
    .filter((name) => name !== undefined)
  return { chunks, htmlScripts, htmlPreloads }
}

function kilobytes(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`
}

export function report(result, profile) {
  const lines = [
    `bundle budget (${profile})`,
    `  entry JavaScript: ${kilobytes(result.entryGzip)} gzip in ${result.entry.length} file(s); budget ${kilobytes(result.budgets.entryGzip)}, ceiling ${kilobytes(CEILINGS.entryGzip)}`,
    ...result.entry.map((chunk) => `    ${kilobytes(chunk.gzip).padStart(10)}  ${chunk.fileName}`),
    `  deferred chunks: ${result.deferredCount}; budget ${kilobytes(result.budgets.chunkGzip)} each, ceiling ${kilobytes(CEILINGS.chunkGzip)}`,
    ...result.deferred
      .slice(0, 8)
      .map((chunk) => `    ${kilobytes(chunk.gzip).padStart(10)}  ${chunk.fileName}`),
  ]
  return lines.join('\n')
}

/**
 * Splits violations into the ones that fail the run and the ones only reported, by rule name.
 * A rule can only be held by its own name: an unknown name is refused, so a misspelt one cannot
 * read as "nothing is held" while holding nothing or, worse, as a rule that does not exist.
 */
export function triage(violations, reportOnly) {
  for (const rule of reportOnly) {
    if (!Object.hasOwn(RULES, rule)) {
      throw new BudgetError(
        `unknown rule "${rule}" for --report-only; one of: ${Object.keys(RULES).join(', ')}`
      )
    }
  }
  const held = new Set(reportOnly.map((rule) => RULES[rule]))
  const codeOf = (violation) => violation.slice(0, violation.indexOf(':'))
  return {
    failing: violations.filter((violation) => !held.has(codeOf(violation))),
    reported: violations.filter((violation) => held.has(codeOf(violation))),
  }
}

async function main(argv) {
  const options = { profile: 'production', mutation: undefined, json: undefined }
  const reportOnly = []
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      !['--profile', '--mutation', '--json', '--report-only'].includes(flag) ||
      value === undefined
    ) {
      throw new BudgetError(
        'usage: node scripts/check-bundle-budget.mjs [--profile production|staging] [--json <file>] [--report-only <rule>] [--mutation <name>]'
      )
    }
    if (flag === '--report-only') reportOnly.push(value)
    else options[flag.slice(2)] = value
  }
  // Refuse a bad rule name before spending a build on it.
  triage([], reportOnly)
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-bundle-budget-'))
  try {
    const description = await describeBuild({
      outDir: join(temporary, 'dist'),
      profile: options.profile,
      mutation: options.mutation,
    })
    const result = measure(description)
    const { failing, reported } = triage(result.violations, reportOnly)
    console.log(report(result, options.profile))
    if (options.json !== undefined) {
      await writeFile(
        options.json,
        `${JSON.stringify({ profile: options.profile, ...result, failing, reported }, null, 2)}\n`
      )
    }
    for (const violation of reported) {
      console.error(
        `check-bundle-budget: NOT MET (reported only, does not fail this run): ${violation}`
      )
    }
    if (failing.length > 0) {
      for (const violation of failing) console.error(`check-bundle-budget: ${violation}`)
      console.error(`check-bundle-budget: FAILED — ${failing.length} violation(s)`)
      return 1
    }
    console.log(
      reported.length === 0
        ? 'check-bundle-budget: OK — entry and deferred chunks are within budget, no forbidden vendor or catalogue in the entry'
        : `check-bundle-budget: OK for the enforced rules — ${reported.length} reported-only rule(s) NOT MET, listed above`
    )
    return 0
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`check-bundle-budget: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

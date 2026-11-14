// Root-prefix, gate-only proof. Does not mount auth/envelope producer/claim/Order.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import assert from 'node:assert/strict'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test'
import ts from 'typescript'
import { SUPPORT_EMAIL } from '../../src/app/supportContact'
import { inspectBootstrapImports, mainArtifact, readBootstrapEntry } from './support/mainArtifact'

const root = fileURLToPath(new URL('../../dist', import.meta.url))
const script = fileURLToPath(new URL('../../server/static.mjs', import.meta.url))
// Root's specification-only key decision; no envelope writer is mounted here.
const envelopeKey = 'kodera.owner-claim.entry.v1'
const syntheticEnvelope = '{"synthetic":"not-a-live-invitation"}'
const foreignKey = 'kodera.synthetic.foreign-canary'
const foreignSession = 'synthetic-session-bytes-unchanged'
const foreignLocal = 'synthetic-local-bytes-unchanged'
const claim = '/claim/11111111-1111-4111-8111-111111111111/example'
const invitation = '/invitations/accept/11111111-1111-4111-8111-111111111111/example'
// Inside the contract's 32–256 bound, unlike the default probe fragment, and still carrying the
// marker the history inspection looks for.
const invitationFragment = 'synthetic-opaque-invitation-token-0123456789'
const ordinary = '/?entry-probe=preserved'
const keys = [
  'console.entry.recovery.title',
  'console.entry.recovery.body',
  'console.entry.recovery.restart',
  'console.entry.recovery.support',
] as const

let child: ChildProcess | undefined
let origin = ''
let stdout = ''
let stderr = ''
let overflow = false
let stopping = false
let unexpectedExit = false
let closed: Promise<void> | undefined
let entry = ''
interface SeenRequest {
  url: string
  path: string
  method: string
  type: string
}
type Coverage = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>

function exactInitialRequests(requests: SeenRequest[], path: string): void {
  expect(requests.filter((request) => request.type === 'document')).toEqual([
    { url: origin + path, path: new URL(path, origin).pathname, method: 'GET', type: 'document' },
  ])
  expect(
    requests.filter((request) => request.path === entry),
    'BOOTSTRAP_REQUEST_IDENTITY_COUNT'
  ).toEqual([{ url: origin + entry, path: entry, method: 'GET', type: 'script' }])
}

function heldRequests(requests: SeenRequest[], path: string, message: string): void {
  expect(requests, message).toEqual([
    { url: origin + path, path: new URL(path, origin).pathname, method: 'GET', type: 'document' },
    { url: origin + entry, path: entry, method: 'GET', type: 'script' },
  ])
}

async function boundedClose(timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('CLI_CLOSE_TIMEOUT')), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function observed(): void {
  expect(overflow, 'CLI_OUTPUT_OVERFLOW').toBe(false)
  expect(unexpectedExit, 'CLI_UNEXPECTED_EXIT').toBe(false)
}

async function stop(): Promise<void> {
  if (!stopping)
    unexpectedExit ||= child !== undefined && (child.exitCode !== null || child.signalCode !== null)
  stopping = true
  let failure: unknown
  let cleanupFailure: unknown
  try {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await boundedClose(2000)
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await boundedClose(1000)
      }
    } catch (cleanup) {
      cleanupFailure = cleanup
    }
  }
  if (failure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([failure, cleanupFailure], 'CLI SIGTERM and SIGKILL cleanup failed')
  if (cleanupFailure !== undefined) throw cleanupFailure
  if (failure !== undefined) throw failure
  observed()
  expect(stdout.trim().split('\n')).toHaveLength(1)
  expect(stderr).toBe('')
}

type Refusal =
  | { kind: 'length'; marker: string; received_length: number }
  | { kind: 'toBe'; actual: string; expected: string; pass: boolean }
  | { kind: 'error'; marker: string }

interface Fixture {
  id: string
  name: string
  origin: string
  entry: string
  files: { 'index.html': string; 'assets/entry.js': string; 'assets/main.js': string }
  expected_refusal: Refusal | null
}

const mainArtifactFixtures: readonly Fixture[] = [
  {
    id: 'F01',
    name: 'positive',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import(`./main.js`);\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: null,
  },
  {
    id: 'F02',
    name: 'cardinality-zero',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'export const noImport = 1;\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: {
      kind: 'length',
      marker: 'ONE_REAL_DYNAMIC_MAIN_TARGET',
      received_length: 0,
    },
  },
  {
    id: 'F03',
    name: 'cardinality-two',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import(`./main.js`); await import("./other.js");\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: {
      kind: 'length',
      marker: 'ONE_REAL_DYNAMIC_MAIN_TARGET',
      received_length: 2,
    },
  },
  {
    id: 'F04',
    name: 'foreign-origin',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import("https://foreign.invalid/main.js");\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: {
      kind: 'toBe',
      actual: 'https://foreign.invalid',
      expected: 'https://fixture.invalid',
      pass: false,
    },
  },
  {
    id: 'F05',
    name: 'query',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import("./main.js?q=1");\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: {
      kind: 'toBe',
      actual: '?q=1',
      expected: '',
      pass: false,
    },
  },
  {
    id: 'F06',
    name: 'fragment',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import("./main.js#fragment");\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: {
      kind: 'toBe',
      actual: '#fragment',
      expected: '',
      pass: false,
    },
  },
  {
    id: 'F07',
    name: 'self-target',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import("./entry.js");\n',
      'assets/main.js': 'export function boot() {}\n',
    },
    expected_refusal: {
      kind: 'toBe',
      actual: '/assets/entry.js',
      expected: '/assets/entry.js',
      pass: true,
    },
  },
  {
    id: 'F08',
    name: 'boot-unresolved',
    origin: 'https://fixture.invalid',
    entry: '/assets/entry.js',
    files: {
      'index.html': '<script type="module" src="/assets/entry.js"></script>\n',
      'assets/entry.js': 'await import(`./main.js`);\n',
      'assets/main.js': 'export const unrelated = 1;\n',
    },
    expected_refusal: {
      kind: 'error',
      marker: 'REAL_MAIN_BOOT_EXPORT_NOT_RESOLVED',
    },
  },
]

function assertIntendedRefusal(error: unknown, refusal: Refusal): void {
  assert(error instanceof Error, 'FIXTURE_REFUSAL_NOT_ERROR')
  const message = stripVTControlCharacters(error.message)
  if (refusal.kind === 'error') {
    assert.equal(message, refusal.marker, 'FIXTURE_WRONG_ERROR_MARKER')
    return
  }
  assert('matcherResult' in error, 'FIXTURE_FAILURE_NOT_EXISTING_EXPECT_ASSERTION')
  const result = error.matcherResult
  assert(typeof result === 'object' && result !== null, 'FIXTURE_MATCHER_RESULT_ABSENT')
  assert('pass' in result, 'FIXTURE_MATCHER_PASS_ABSENT')
  if (refusal.kind === 'length') {
    assert.equal(result.pass, false, 'FIXTURE_WRONG_LENGTH_MATCHER_POLARITY')
    assert(message.includes(refusal.marker), 'FIXTURE_CARDINALITY_MARKER_ABSENT')
    assert(message.includes('toHaveLength'), 'FIXTURE_WRONG_CARDINALITY_MATCHER')
    assert.match(
      message,
      new RegExp('Received length:\\s*' + refusal.received_length + '(?![0-9])')
    )
    return
  }
  assert('name' in result && 'actual' in result && 'expected' in result)
  assert.equal(result.name, 'toBe', 'FIXTURE_WRONG_EQUALITY_MATCHER')
  assert.equal(result.actual, refusal.actual, 'FIXTURE_WRONG_RECEIVED_VALUE')
  assert.equal(result.expected, refusal.expected, 'FIXTURE_WRONG_EXPECTED_VALUE')
  assert.equal(result.pass, refusal.pass, 'FIXTURE_WRONG_MATCHER_POLARITY')
}

// Finite controls call the same real resolver as both browser consumers.
// The sixteen inspector rows below retain their original separate pristine loop.
async function runEightMainArtifactFixtures(
  testInfo: TestInfo,
  ownedOutputParent: string
): Promise<{ rows: 8; pristineCalls: 8; resolverCalls: 16 }> {
  assert.equal(mainArtifactFixtures.length, 8)
  const pristine = mainArtifactFixtures[0]
  assert(pristine !== undefined && pristine.expected_refusal === null)
  await mkdir(ownedOutputParent, { recursive: true })
  let root: string | undefined
  let primary: unknown
  let primaryFailed = false
  const cleanupFailures: unknown[] = []
  try {
    const ownedRoot = await mkdtemp(join(ownedOutputParent, 'main-artifact-eight-'))
    root = ownedRoot
    let ordinal = 0
    const run = async (fixture: Fixture): Promise<void> => {
      // There is at most one active case directory; names never come from a URL.
      const current = join(ownedRoot, String(ordinal++))
      let rowPrimary: unknown
      let rowFailed = false
      let rowCleanup: unknown
      let rowCleanupFailed = false
      try {
        await mkdir(join(current, 'assets'), { recursive: true })
        const names = ['index.html', 'assets/entry.js', 'assets/main.js'] as const
        let bytes = 0
        for (const name of names) {
          const value = fixture.files[name]
          const size = Buffer.byteLength(value)
          assert(size <= 1024, 'FIXTURE_FILE_BYTE_CAP')
          bytes += size
          await writeFile(join(current, name), value, { flag: 'wx' })
        }
        assert(bytes <= 4096, 'FIXTURE_TOTAL_BYTE_CAP')
        let actual: Awaited<ReturnType<typeof mainArtifact>> | undefined
        let refusal: unknown
        let refused = false
        try {
          actual = await mainArtifact({
            distDirectory: pathToFileURL(current + '/'),
            entry: fixture.entry,
            origin: fixture.origin,
            testInfo,
          })
        } catch (error) {
          refusal = error
          refused = true
        }
        if (fixture.expected_refusal !== null) {
          assert(refused, 'FIXTURE_EXPECTED_REFUSAL_MISSING_' + fixture.id)
          assertIntendedRefusal(refusal, fixture.expected_refusal)
        } else {
          if (refused) throw refusal
          assert(actual !== undefined, 'FIXTURE_POSITIVE_RESULT_ABSENT')
          const main = fixture.files['assets/main.js']
          assert.equal(actual.path, '/assets/main.js')
          assert.equal(actual.bootStart, 0)
          assert.equal(actual.bootBodyStart, main.indexOf('{'))
          assert.equal(actual.bootEnd, main.indexOf('}') + 1)
          assert.equal(actual.mainByteLength, Buffer.byteLength(main))
          assert.equal(actual.mainSha256, createHash('sha256').update(main).digest('hex'))
        }
        // The resolver must not write fixtures. These are fixed-directory checks,
        // not a generic filesystem walk or a claim of filesystem isolation.
        assert.deepEqual((await readdir(current)).sort(), ['assets', 'index.html'])
        assert.deepEqual((await readdir(join(current, 'assets'))).sort(), ['entry.js', 'main.js'])
        for (const name of names) {
          assert((await lstat(join(current, name))).isFile())
          assert.equal(await readFile(join(current, name), 'utf8'), fixture.files[name])
        }
      } catch (error) {
        rowPrimary = error
        rowFailed = true
      } finally {
        try {
          await rm(current, { recursive: true, force: true })
        } catch (error) {
          rowCleanup = error
          rowCleanupFailed = true
        }
      }
      if (rowFailed && rowCleanupFailed)
        throw new AggregateError([rowPrimary, rowCleanup], 'FIXTURE_PRIMARY_AND_CLEANUP')
      if (rowFailed) throw rowPrimary
      if (rowCleanupFailed) throw rowCleanup
    }
    for (const fixture of mainArtifactFixtures) {
      await run(fixture)
      // Deliberately repeat F01 after F01 as well: eight pristine calls, not seven.
      await run(pristine)
    }
  } catch (error) {
    primary = error
    primaryFailed = true
  } finally {
    if (root !== undefined) {
      try {
        await rm(root, { recursive: true, force: true })
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
  }
  if (primaryFailed && cleanupFailures.length > 0)
    throw new AggregateError([primary, ...cleanupFailures], 'FIXTURES_PRIMARY_AND_CLEANUP')
  if (primaryFailed) throw primary
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, 'FIXTURES_CLEANUP_FAILED')
  return { rows: 8, pristineCalls: 8, resolverCalls: 16 }
}

test('bootstrap import collector accepts only static literals with finite refusal controls', async ({
  browserName: _browserName,
}, testInfo) => {
  const cases: ReadonlyArray<{
    name: string
    code: string
    targets?: readonly string[]
    rejected: boolean
  }> = [
    {
      name: 'single-quoted literal',
      code: "await import('./main-synthetic.js')",
      targets: ['./main-synthetic.js'],
      rejected: false,
    },
    {
      name: 'double-quoted literal',
      code: 'await import("./main-synthetic.js")',
      targets: ['./main-synthetic.js'],
      rejected: false,
    },
    {
      name: 'actual witnessed static backtick syntax',
      code: 'await import(`./main-9bIdm0GT.js`)',
      targets: ['./main-9bIdm0GT.js'],
      rejected: false,
    },
    {
      name: 'interpolated template',
      code: 'await import(`./${chunk}.js`)',
      rejected: true,
    },
    {
      name: 'identifier',
      code: 'await import(target)',
      rejected: true,
    },
    {
      name: 'concatenation',
      code: "await import('./' + chunk)",
      rejected: true,
    },
    {
      name: 'call expression',
      code: 'await import(resolvePath())',
      rejected: true,
    },
    {
      name: 'tagged template',
      code: 'await import(tag`./main.js`)',
      rejected: true,
    },
    {
      name: 'missing argument',
      code: 'await import()',
      rejected: true,
    },
    {
      name: 'extra import options argument',
      code: "await import('./main.js', { with: { type: 'json' } })",
      rejected: true,
    },
    {
      name: 'spread argument',
      code: 'await import(...targets)',
      rejected: true,
    },
    {
      name: 'parenthesized argument',
      code: "await import(('./main.js'))",
      rejected: true,
    },
    {
      name: 'acceptable target cannot hide dynamic call',
      code: "await import('./main.js'); await import(target)",
      rejected: true,
    },
    {
      name: 'no imports retains zero cardinality',
      code: 'const untouched = 1',
      targets: [],
      rejected: false,
    },
    {
      name: 'two static imports retain two cardinality for existing outer refusal',
      code: "await import('./one.js'); await import(`./two.js`)",
      targets: ['./one.js', './two.js'],
      rejected: false,
    },
    {
      name: 'duplicate identical targets preserve outer uniqueness refusal',
      code: "await import('./same.js'); await import(`./same.js`)",
      targets: ['./same.js', './same.js'],
      rejected: false,
    },
  ]
  const assertCase = (item: (typeof cases)[number]): void => {
    const ast = ts.createSourceFile(
      'synthetic-bootstrap.js',
      item.code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    const result = inspectBootstrapImports(ast)
    expect(result.rejected !== undefined, item.name).toBe(item.rejected)
    if (result.rejected !== undefined)
      expect(ts.isCallExpression(result.rejected), item.name).toBe(true)
    if (item.targets !== undefined) expect(result.targets, item.name).toEqual(item.targets)
  }
  const pristine = cases[2]
  if (pristine === undefined) throw Error('STATIC_TEMPLATE_PRISTINE_MISSING')
  for (const item of cases) {
    assertCase(item)
    assertCase(pristine)
  }
  expect(
    await runEightMainArtifactFixtures(testInfo, testInfo.outputPath('main-artifact-controls'))
  ).toEqual({ rows: 8, pristineCalls: 8, resolverCalls: 16 })
})

test.describe('Protected entry bootstrap foundation, real emitted build', () => {
  // Default serial-in-file execution, without serial-mode failure skipping.
  test.describe.configure({ mode: 'default', timeout: 20_000 })

  test.beforeAll(async () => {
    entry = await readBootstrapEntry(new URL('../../dist/', import.meta.url))
    child = spawn(
      process.execPath,
      [
        script,
        '--root',
        root,
        '--port',
        '0',
        '--prefix',
        '/',
        '--claim-path',
        '/claim',
        '--core-origin',
        'https://core.invalid',
        '--provider-origin',
        'https://identity.invalid',
        '--matrix-domain',
        'kodera.invalid',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1' },
      }
    )
    closed = new Promise((resolve) => {
      child?.once('close', () => {
        unexpectedExit ||= !stopping
        resolve()
      })
    })
    child.once('error', () => {
      unexpectedExit = true
    })
    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      stream?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > 16_384) {
          overflow = true
          child?.kill('SIGKILL')
          return
        }
        if (name === 'stdout') stdout += chunk.toString()
        else stderr += chunk.toString()
      })
    }
    try {
      await expect.poll(() => stdout.includes('\n') || unexpectedExit, { timeout: 5000 }).toBe(true)
      observed()
      const ready: unknown = JSON.parse(stdout.trim())
      expect(ready).toMatchObject({ host: '127.0.0.1' })
      if (
        typeof ready !== 'object' ||
        ready === null ||
        !('port' in ready) ||
        typeof ready.port !== 'number'
      ) {
        throw Error('CLI_READINESS_SHAPE')
      }
      origin = `http://127.0.0.1:${ready.port}`
    } catch (error) {
      try {
        await stop()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'CLI_SETUP_AND_CLEANUP', { cause: cleanup })
      }
      throw error
    }
  })

  test.afterAll(async () => {
    await stop()
  })

  test('emitted entry is self-contained and recovery text comes from the catalogue', async ({
    browser,
  }) => {
    const html = await readFile(new URL('../../dist/index.html', import.meta.url), 'utf8')
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      const shape = await page.evaluate((markup) => {
        const document = new DOMParser().parseFromString(markup, 'text/html')
        const scripts = Array.from(document.scripts)
        const template = document.querySelector<HTMLTemplateElement>('template#entry-recovery')
        return {
          scripts: scripts.map((script) => ({
            src: script.getAttribute('src'),
            type: script.type,
            inline: script.textContent?.trim(),
          })),
          eagerLinks: Array.from(document.querySelectorAll('link[rel]')).map((link) =>
            link.getAttribute('rel')
          ),
          otherActiveElements: document.querySelectorAll(
            'style,img,iframe,object,embed,video,audio,source,track,meta[http-equiv="refresh"]'
          ).length,
          inlineHandlers: Array.from(document.querySelectorAll('*')).flatMap((node) =>
            Array.from(node.attributes)
              .filter((attribute) => attribute.name.startsWith('on'))
              .map((attribute) => attribute.name)
          ),
          messages:
            template === null
              ? null
              : Object.fromEntries(
                  Array.from(template.content.querySelectorAll('[data-message-key]')).map(
                    (node) => [node.getAttribute('data-message-key'), node.textContent]
                  )
                ),
          activeRecovery:
            template?.content.querySelector(
              'script,style,link,img,iframe,button,a[href],[src],[onload],[onclick]'
            ) !== null,
        }
      }, html)
      expect(shape.scripts).toEqual([{ src: entry, type: 'module', inline: '' }])
      expect(shape.eagerLinks).toEqual([])
      expect(shape.otherActiveElements).toBe(0)
      expect(shape.inlineHandlers).toEqual([])
      expect(shape.activeRecovery).toBe(false)
      const catalogue: Record<string, string> = JSON.parse(
        await readFile(new URL('../../src/i18n/fr.json', import.meta.url), 'utf8')
      )
      for (const key of keys) {
        expect(catalogue[key]).toBeTruthy()
        expect(shape.messages?.[key]).toBe(catalogue[key]?.replaceAll('{{email}}', SUPPORT_EMAIL))
      }
      const emitted = await readFile(new URL(`../../dist${entry}`, import.meta.url), 'utf8')
      // Finite engineering bound, never an assertion that size alone proves no SDK.
      expect(Buffer.byteLength(emitted)).toBeLessThanOrEqual(16_384)
      const ast = ts.createSourceFile(
        'bootstrap.js',
        emitted,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
      )
      const forbidden: string[] = []
      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
        )
          forbidden.push('STATIC_IMPORT')
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          ts.isIdentifier(node.expression) &&
          ['eval', 'Function'].includes(node.expression.text)
        )
          forbidden.push('EVAL')
        ts.forEachChild(node, visit)
      }
      visit(ast)
      expect(forbidden).toEqual([])
    } finally {
      await context.close()
    }
  })

  // Initial existing-source red must reach EARLY_NON_BOOTSTRAP_FETCH with a real
  // current theme/app resource. No absent future module/template is required here.
  test('real resource requests wait for verified fragment removal', async ({ browser }) => {
    await probe(browser, 'native', 'native', claim, async (page, requests) => {
      const snapshot = await timing(page)
      const early = snapshot.resources.filter(
        (item) => snapshot.cleanedAt === null || item.start < snapshot.cleanedAt
      )
      expect(
        early.filter((item) => item.path !== entry),
        'EARLY_NON_BOOTSTRAP_FETCH'
      ).toEqual([])
      expect(early.filter((item) => item.path === entry)).toHaveLength(1)
      expect(snapshot.cleanedAt, 'NATIVE_FRAGMENT_REMOVAL_MISSING').not.toBeNull()
      expect(new URL(page.url()).hash).toBe('')
      heldRequests(requests, claim, 'PROTECTED_GATE_RELEASED_OTHER_WORK')
      await expect(
        page.locator('#root [data-message-key="console.entry.recovery.title"]')
      ).toBeVisible()
    })
  })

  for (const mode of ['noop', 'throw'] as const) {
    test(`URL cleanup ${mode} keeps app/SDK absent`, async ({ browser }) => {
      await probe(browser, mode, 'native', claim, async (page, requests) => {
        expect(new URL(page.url()).hash).toBe('#synthetic-opaque%2Fvalue')
        heldRequests(requests, claim, 'FAILED_URL_CLEANUP_RELEASED_WORK')
        await expect(
          page.locator('#root [data-message-key="console.entry.recovery.restart"]')
        ).toBeVisible()
        expect(await page.locator('#root a[href],#root button').count()).toBe(0)
      })
    })
  }

  // The protected callback serves in every build, since an invitation's sign-in returns there
  // (docs/specs/12-invitation-accept.md §3); a failed envelope deletion still stops it.
  for (const mode of ['native', 'noop', 'throw', 'read-throw'] as const) {
    test(`protected callback envelope deletion ${mode} releases the page only once deleted`, async ({
      browser,
    }) => {
      await probe(
        browser,
        'native',
        mode,
        '/auth/claim-callback',
        async (page, requests) => {
          if (mode === 'native')
            expect(
              requests.filter((request) => request.type === 'script' && request.path !== entry),
              'PROTECTED_CALLBACK_NOT_RELEASED'
            ).not.toEqual([])
          else
            heldRequests(requests, '/auth/claim-callback', 'PROTECTED_CALLBACK_RELEASED_OTHER_WORK')
          const storage = await page.evaluate(
            (key) => ({
              operations: document.documentElement.getAttribute('data-test-envelope-operations'),
              value: sessionStorage.getItem(key),
            }),
            envelopeKey
          )
          expect(storage.value).toBe(mode === 'native' ? null : syntheticEnvelope)
          expect(JSON.parse(storage.operations ?? '[]')).toEqual(
            mode === 'read-throw'
              ? ['read']
              : mode === 'throw'
                ? ['read', 'remove']
                : ['read', 'remove', 'read']
          )
          await expect(
            page.locator('#root [data-message-key="console.entry.recovery.body"]')
          ).toBeVisible()
        },
        { held: mode !== 'native' }
      )
    })
  }

  // docs/specs/12-invitation-accept.md §3: the invitation entry serves in every build, after the
  // same verified fragment removal as the claim's.
  test('invitation entry removes its fragment before any other request, then releases the page', async ({
    browser,
  }) => {
    await probe(
      browser,
      'native',
      'native',
      invitation,
      async (page, requests) => {
        const snapshot = await timing(page)
        expect(snapshot.cleanedAt, 'INVITATION_FRAGMENT_REMOVAL_MISSING').not.toBeNull()
        const early = snapshot.resources.filter(
          (item) => snapshot.cleanedAt === null || item.start < snapshot.cleanedAt
        )
        expect(
          early.filter((item) => item.path !== entry),
          'INVITATION_EARLY_RESOURCE'
        ).toEqual([])
        expect(new URL(page.url()).hash).toBe('')
        expect(
          requests.filter((request) => request.type === 'script' && request.path !== entry),
          'INVITATION_ENTRY_NOT_RELEASED'
        ).not.toEqual([])
      },
      { fragment: invitationFragment, held: false, foreignPaths: ['/api/v1/auth/discover'] }
    )
  })

  for (const [name, path, fragment] of [
    ['a token below the contract bound', invitation, 'synthetic-opaque-short'],
    [
      'a path without a canonical organisation id',
      '/invitations/accept/not-an-id/example',
      invitationFragment,
    ],
    ['a path with an extra segment', `${invitation}/more`, invitationFragment],
  ] as const) {
    test(`invitation entry with ${name} holds every other request`, async ({ browser }) => {
      await probe(
        browser,
        'native',
        'native',
        path,
        async (page, requests) => {
          expect(new URL(page.url()).hash).toBe('')
          heldRequests(requests, path, 'INVALID_INVITATION_RELEASED_WORK')
          await expect(
            page.locator('#root [data-message-key="console.entry.recovery.restart"]')
          ).toBeVisible()
        },
        { fragment, held: true }
      )
    })
  }

  test('ordinary callback never drains the claim envelope before failed URL cleanup', async ({
    browser,
  }) => {
    await probe(browser, 'noop', 'native', '/auth/callback', async (page, requests) => {
      heldRequests(requests, '/auth/callback', 'ORDINARY_CALLBACK_FAILED_GATE_RELEASED_WORK')
      const storage = await page.evaluate(
        (key) => ({
          operations: document.documentElement.getAttribute('data-test-envelope-operations'),
          value: sessionStorage.getItem(key),
        }),
        envelopeKey
      )
      expect(storage.operations).toBeNull()
      expect(storage.value).toBe(syntheticEnvelope)
    })
  })

  test('ordinary native cleanup requests and executes real main only after cleanup', async ({
    browser,
  }) => {
    const artifact = await mainArtifact({
      distDirectory: new URL('../../dist/', import.meta.url),
      entry,
      origin,
      testInfo: test.info(),
    })
    const main = artifact.path
    await probe(
      browser,
      'native',
      'native',
      ordinary,
      async (page, requests, coverage) => {
        const snapshot = await timing(page)
        expect(snapshot.cleanedAt, 'ORDINARY_NATIVE_CLEANUP_MISSING').not.toBeNull()
        const early = snapshot.resources.filter(
          (item) => snapshot.cleanedAt === null || item.start < snapshot.cleanedAt
        )
        expect(
          early.filter((item) => item.path !== entry),
          'ORDINARY_EARLY_RESOURCE'
        ).toEqual([])
        expect(
          requests.filter((request) => request.path === main),
          'REAL_MAIN_REQUEST_MISSING'
        ).toEqual([{ url: origin + main, path: main, method: 'GET', type: 'script' }])
        const mainTimings = snapshot.resources.filter((item) => item.path === main)
        expect(mainTimings).toHaveLength(1)
        if (snapshot.cleanedAt === null || mainTimings[0] === undefined)
          throw Error('MAIN_TIMING_UNAVAILABLE')
        expect(mainTimings[0].start, 'MAIN_FETCH_BEFORE_NATIVE_CLEANUP').toBeGreaterThanOrEqual(
          snapshot.cleanedAt
        )
        expect(new URL(page.url()).search, 'URL_CLEANUP_MUST_PRESERVE_QUERY').toBe(
          '?entry-probe=preserved'
        )
        const executed = coverage.filter((item) => item.url === origin + main)
        expect(executed, 'REAL_MAIN_EXECUTION_MISSING').toHaveLength(1)
        expect(
          executed[0]?.functions.some((fn) =>
            fn.ranges.some((range) => range.count > 0 && range.endOffset > range.startOffset)
          ),
          'REAL_MAIN_EXECUTION_COUNT'
        ).toBe(true)
        expect(
          executed[0]?.functions.some((fn) =>
            fn.ranges.some(
              (range) =>
                range.startOffset >= artifact.bootStart &&
                range.startOffset <= artifact.bootBodyStart &&
                range.endOffset === artifact.bootEnd &&
                range.count > 0
            )
          ),
          'REAL_MAIN_BOOT_NOT_CALLED'
        ).toBe(true)
      },
      { coverage: true }
    )
  })

  for (const mode of ['noop', 'throw'] as const) {
    test(`ordinary URL cleanup ${mode} cannot request or execute main`, async ({ browser }) => {
      const main = (
        await mainArtifact({
          distDirectory: new URL('../../dist/', import.meta.url),
          entry,
          origin,
          testInfo: test.info(),
        })
      ).path
      await probe(
        browser,
        mode,
        'native',
        ordinary,
        async (page, requests, coverage) => {
          expect(
            requests.filter((request) => request.path === main),
            'ORDINARY_FAILED_GATE_REQUESTED_MAIN'
          ).toEqual([])
          heldRequests(requests, ordinary, 'ORDINARY_FAILED_GATE_RELEASED_OTHER_WORK')
          expect(
            coverage.filter((item) => item.url === origin + main),
            'ORDINARY_FAILED_GATE_EXECUTED_MAIN'
          ).toEqual([])
          expect(new URL(page.url()).hash).toBe('#synthetic-opaque%2Fvalue')
          await expect(
            page.locator('#root [data-message-key="console.entry.recovery.body"]')
          ).toBeVisible()
        },
        { coverage: true }
      )
    })
  }

  test('exact bundled Vite polyfill fallback cannot fetch another precleanup resource', async ({
    browser,
  }) => {
    await probe(
      browser,
      'noop',
      'native',
      claim,
      async (page, requests) => {
        heldRequests(requests, claim, 'POLYFILL_FALLBACK_FETCHED_OTHER_WORK')
        expect(
          await page.locator('html').getAttribute('data-test-polyfill-probes'),
          'REAL_POLYFILL_FALLBACK_NOT_OBSERVED'
        ).not.toBeNull()
        expect(new URL(page.url()).hash).toBe('#synthetic-opaque%2Fvalue')
        await expect(
          page.locator('#root [data-message-key="console.entry.recovery.body"]')
        ).toBeVisible()
      },
      { polyfillFallback: true }
    )
  })
})

async function timing(
  page: Page
): Promise<{ cleanedAt: number | null; resources: { path: string; start: number }[] }> {
  return page.evaluate(() => {
    const marker = document.documentElement.getAttribute('data-test-cleaned-at')
    return {
      cleanedAt: marker === null ? null : Number(marker),
      resources: performance
        .getEntriesByType('resource')
        .map((item) => ({ path: new URL(item.name).pathname, start: item.startTime })),
    }
  })
}

async function probe(
  browser: Browser,
  urlMode: 'native' | 'noop' | 'throw',
  storageMode: 'native' | 'noop' | 'throw' | 'read-throw',
  path: string,
  assertion: (page: Page, requests: SeenRequest[], coverage: Coverage) => Promise<void>,
  options: {
    coverage?: boolean
    polyfillFallback?: boolean
    /** Replaces the default synthetic fragment. */
    fragment?: string
    /** Whether the gate holds every request but the document and the bootstrap; by default a
     * claim, the protected callback and any failed URL cleanup do. */
    held?: boolean
    /** Foreign paths the released application may request: aborted, but not a violation. */
    foreignPaths?: readonly string[]
  } = {}
): Promise<void> {
  let context: BrowserContext | undefined
  const requests: SeenRequest[] = []
  const unexpected: string[] = []
  let failure: unknown
  let cleanupFailure: unknown
  try {
    context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', async (route) => {
      const request = new URL(route.request().url())
      if (request.origin !== origin) {
        if (!options.foreignPaths?.includes(request.pathname))
          unexpected.push(request.origin + request.pathname)
        await route.abort('blockedbyclient')
        return
      }
      requests.push({
        url: request.href,
        path: request.pathname,
        method: route.request().method(),
        type: route.request().resourceType(),
      })
      await route.continue()
    })
    await context.addInitScript(
      ({
        urlMode,
        storageMode,
        envelopeKey,
        syntheticEnvelope,
        foreignKey,
        foreignSession,
        foreignLocal,
        path,
        polyfillFallback,
      }) => {
        sessionStorage.setItem(foreignKey, foreignSession)
        localStorage.setItem(foreignKey, foreignLocal)
        if (path === '/auth/claim-callback' || path === '/auth/callback')
          sessionStorage.setItem(envelopeKey, syntheticEnvelope)
        if (polyfillFallback) {
          const supports = DOMTokenList.prototype.supports
          let probes = 0
          DOMTokenList.prototype.supports = function (this: DOMTokenList, token: string) {
            if (token !== 'modulepreload') return supports.call(this, token)
            document.documentElement?.setAttribute('data-test-polyfill-probes', String(++probes))
            return false
          }
        }
        const replace = History.prototype.replaceState
        const publicHistoryState = { entryProbePublic: 'synthetic-nonsecret-history-state' }
        replace.call(history, publicHistoryState, '', location.href)
        let firstCleanup = true
        const inspectHistoryState = (): void => {
          const seen = new WeakSet<object>()
          let remaining = 256
          const inspect = (value: unknown): void => {
            if (--remaining < 0) {
              document.documentElement.setAttribute(
                'data-test-history-inspection-budget',
                'exceeded'
              )
              throw Error('HISTORY_STATE_INSPECTION_BUDGET')
            }
            if (typeof value === 'string') {
              if (value.includes('synthetic-opaque'))
                document.documentElement.setAttribute('data-test-history-opaque', 'present')
              return
            }
            if (value === null || typeof value !== 'object' || seen.has(value)) return
            seen.add(value)
            if (value instanceof Map) {
              value.forEach((entry: unknown, key: unknown) => {
                inspect(key)
                inspect(entry)
              })
            } else if (value instanceof Set) {
              value.forEach((entry: unknown) => inspect(entry))
            } else {
              for (const [key, descriptor] of Object.entries(
                Object.getOwnPropertyDescriptors(value)
              )) {
                inspect(key)
                if ('value' in descriptor) inspect(descriptor.value)
              }
            }
          }
          inspect(history.state)
        }
        History.prototype.replaceState = function (
          this: History,
          ...args: Parameters<History['replaceState']>
        ) {
          if (urlMode === 'throw') throw Error('SYNTHETIC_URL_DENIAL')
          if (urlMode === 'noop') return
          replace.apply(this, args)
          inspectHistoryState()
          if (location.hash === '') {
            document.documentElement.setAttribute('data-test-cleaned-at', String(performance.now()))
            if (firstCleanup) {
              firstCleanup = false
              const state: unknown = history.state
              const retained =
                state !== null &&
                typeof state === 'object' &&
                'entryProbePublic' in state &&
                state.entryProbePublic === publicHistoryState.entryProbePublic
              document.documentElement.setAttribute(
                'data-test-history-public-at-cleanup',
                String(retained)
              )
            }
          }
        }
        const operations: string[] = []
        const foreignViolations: string[] = []
        const violation = (kind: string): void => {
          foreignViolations.push(kind)
          document.documentElement?.setAttribute(
            'data-test-foreign-storage-violations',
            JSON.stringify(foreignViolations)
          )
        }
        const record = (operation: string): void => {
          operations.push(operation)
          document.documentElement?.setAttribute(
            'data-test-envelope-operations',
            JSON.stringify(operations)
          )
        }
        const get = Storage.prototype.getItem
        let readDenied = false
        Storage.prototype.getItem = function (this: Storage, key: string) {
          if (this === sessionStorage && key === envelopeKey) {
            record('read')
            if (storageMode === 'read-throw' && !readDenied) {
              readDenied = true
              throw Error('SYNTHETIC_STORAGE_READ_DENIAL')
            }
          }
          return get.call(this, key)
        }
        const remove = Storage.prototype.removeItem
        Storage.prototype.removeItem = function (this: Storage, key: string) {
          const claimDelete = this === sessionStorage && key === envelopeKey
          if (
            key === foreignKey ||
            (!claimDelete &&
              (path.startsWith('/claim/') ||
                path === '/auth/claim-callback' ||
                urlMode !== 'native' ||
                location.hash !== ''))
          )
            violation('foreign-remove')
          if (this === sessionStorage && key === envelopeKey) {
            record('remove')
            if (storageMode === 'throw') throw Error('SYNTHETIC_STORAGE_DENIAL')
            if (storageMode === 'noop') return
          }
          remove.call(this, key)
        }
        const clear = Storage.prototype.clear
        Storage.prototype.clear = function (this: Storage) {
          violation('clear')
          clear.call(this)
        }
        const set = Storage.prototype.setItem
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (
            key === foreignKey ||
            path.startsWith('/claim/') ||
            path === '/auth/claim-callback' ||
            urlMode !== 'native' ||
            location.hash !== ''
          )
            violation('unexpected-write')
          set.call(this, key, value)
        }
      },
      {
        urlMode,
        storageMode,
        envelopeKey,
        syntheticEnvelope,
        foreignKey,
        foreignSession,
        foreignLocal,
        path,
        polyfillFallback: options.polyfillFallback === true,
      }
    )
    const page = await context.newPage()
    if (options.coverage)
      await page.coverage.startJSCoverage({
        resetOnNavigation: true,
        reportAnonymousScripts: false,
      })
    const response = await page.goto(
      origin + path + '#' + (options.fragment ?? 'synthetic-opaque%2Fvalue'),
      {
        waitUntil: 'domcontentloaded',
        timeout: 8000,
      }
    )
    expect(response).not.toBeNull()
    expect(response?.headers()['referrer-policy']).toBe('no-referrer')
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'")
    await page.waitForLoadState('networkidle', { timeout: 8000 })
    const coverage = options.coverage ? await page.coverage.stopJSCoverage() : []
    await assertion(page, requests, coverage)
    exactInitialRequests(requests, path)
    const foreign = await page.evaluate(
      (key) => ({
        session: sessionStorage.getItem(key),
        local: localStorage.getItem(key),
        violations: document.documentElement.getAttribute('data-test-foreign-storage-violations'),
      }),
      foreignKey
    )
    expect(foreign, 'FOREIGN_STORAGE_CHANGED_OR_TOUCHED').toEqual({
      session: foreignSession,
      local: foreignLocal,
      violations: null,
    })
    // Future actual-source mutant: retain the captured fragment in replaceState data while
    // cleaning the URL. Ordinary native release must reach this dedicated assertion.
    expect(
      await page.getAttribute('html', 'data-test-history-inspection-budget'),
      'HISTORY_STATE_INSPECTION_INCOMPLETE'
    ).toBeNull()
    expect(
      await page.getAttribute('html', 'data-test-history-opaque'),
      'HISTORY_STATE_CONTAINS_OPAQUE_INVITATION'
    ).toBeNull()
    if (urlMode === 'native') {
      expect(
        await page.getAttribute('html', 'data-test-history-public-at-cleanup'),
        'NONSECRET_HISTORY_STATE_LOST_AT_CLEANUP'
      ).toBe('true')
    } else {
      expect(
        await page.evaluate(() => {
          const state: unknown = history.state
          return state !== null && typeof state === 'object' && 'entryProbePublic' in state
            ? state.entryProbePublic
            : null
        }),
        'NONSECRET_HISTORY_STATE_LOST_ON_FAILED_CLEANUP'
      ).toBe('synthetic-nonsecret-history-state')
    }
    expect(unexpected, 'UNEXPECTED_NETWORK_EFFECT').toEqual([])
    observed()
  } catch (error) {
    failure = error
  } finally {
    try {
      await context?.close()
    } catch (cleanup) {
      cleanupFailure = cleanup
    }
  }
  if (failure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError(
      [failure, cleanupFailure],
      'Browser probe and owned context cleanup failed'
    )
  if (cleanupFailure !== undefined) throw cleanupFailure
  if (failure !== undefined) throw failure
  expect(unexpected, 'UNEXPECTED_NETWORK_EFFECT_AFTER_CLOSE').toEqual([])
  exactInitialRequests(requests, path)
  if (
    options.held ??
    (path.startsWith('/claim/') || path === '/auth/claim-callback' || urlMode !== 'native')
  ) {
    heldRequests(requests, path, 'CLOSED_GATE_LATE_REQUEST')
  }
  observed()
}

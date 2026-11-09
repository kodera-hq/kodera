import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
  type Route,
  type Request,
} from '@playwright/test'
import {
  coordinatorFixtureAssets,
  type CoordinatorFixtureVariant,
  type NativeCapabilityClient,
  type NativeCapabilityReply,
  rank1BrowserProgram,
  type Rank1PageClient,
  type Rank1PageState,
  fencingFixtureAssets,
  fencingBrowserProgram,
  type FencingVariant,
  type FencingReply,
  type FencingPageClient,
  type FencingPageState,
} from './support/ownerClaimCoordinatorFixture'

declare global {
  interface Window {
    __koderaNativeCapability: NativeCapabilityClient
    __koderaRank1?: Rank1PageClient
    __koderaFencing?: FencingPageClient
  }
}

type CaseId = 'C01' | 'C02' | 'C03'
type RunVariant = CoordinatorFixtureVariant | 'split-name'
interface Comparison {
  marker: string
  actual: number
  expected: number
}
interface OwnedFixture {
  context: BrowserContext
  origin: string
  variant: RunVariant
  page: () => Promise<Page>
}

const CANONICAL_NAME = 'kodera-test-owner-claim-coordinator'
const SPLIT_NAME = 'kodera-test-owner-claim-coordinator-split'
const MARKER_NAME = 'kodera.test.owner-claim.arm.v1'
const STATIC_SCRIPT = fileURLToPath(new URL('../../server/static.mjs', import.meta.url))
const ASSET_NAMES = [
  'fixture-client.js',
  'fixture-icon.svg',
  'index.html',
  'owner-claim-coordinator.js',
]
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

interface ExpectedChromium {
  name: 'chromium' | 'chromium-headless-shell'
  browserVersion: string
  revision: string
}

function assertExcludedArtifact(path: string, contents?: string): void {
  expect(path.includes('owner-claim-coordinator.js'), 'FIXTURE_WORKER_NOT_BUNDLED').toBe(false)
  if (contents === undefined) return
  for (const forbidden of ['W03_NATIVE_COORDINATOR_FIXTURE_ONLY', CANONICAL_NAME, MARKER_NAME]) {
    expect(contents.includes(forbidden), 'FIXTURE_SENTINEL_NOT_BUNDLED').toBe(false)
  }
}

function assertBrowserVersion(observed: string, expected: readonly ExpectedChromium[]): void {
  expect(
    expected.some((entry) => entry.browserVersion === observed),
    'NATIVE_BROWSER_VERSION_MATCHES_MANIFEST'
  ).toBe(true)
}

async function expectedChromium(): Promise<{ sha256: string; entries: ExpectedChromium[] }> {
  const bytes = await readFile(
    new URL('../../../../node_modules/playwright-core/browsers.json', import.meta.url)
  )
  const manifest: unknown = JSON.parse(bytes.toString())
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    !('browsers' in manifest) ||
    !Array.isArray(manifest.browsers)
  ) {
    throw Error('NATIVE_BROWSER_MANIFEST_SHAPE')
  }
  const browsers: unknown[] = manifest.browsers
  const names = ['chromium', 'chromium-headless-shell'] as const
  const entries = names.map((name): ExpectedChromium => {
    const matches = browsers.filter(
      (entry) =>
        entry !== null && typeof entry === 'object' && 'name' in entry && entry.name === name
    )
    expect(matches, 'NATIVE_BROWSER_MANIFEST_ONE_ENTRY').toHaveLength(1)
    const entry = matches[0]
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !('browserVersion' in entry) ||
      typeof entry.browserVersion !== 'string' ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(entry.browserVersion) ||
      !('revision' in entry) ||
      typeof entry.revision !== 'string' ||
      !/^\d+$/.test(entry.revision)
    ) {
      throw Error('NATIVE_BROWSER_MANIFEST_ENTRY_SHAPE')
    }
    return { name, browserVersion: entry.browserVersion, revision: entry.revision }
  })
  return { sha256: digest(bytes), entries }
}

function guardMustRefuse(
  assertion: () => void,
  marker:
    | 'FIXTURE_WORKER_NOT_BUNDLED'
    | 'FIXTURE_SENTINEL_NOT_BUNDLED'
    | 'NATIVE_BROWSER_VERSION_MATCHES_MANIFEST',
  actual: boolean,
  expected: boolean
): void {
  let refusal: unknown
  try {
    assertion()
  } catch (error) {
    refusal = error
  }
  expect(refusal, 'NATIVE_GUARD_CONTROL_MUST_FAIL').toBeInstanceOf(Error)
  const failure = refusal as Error & {
    matcherResult?: { actual?: unknown; expected?: unknown; name?: string; pass?: boolean }
  }
  expect(failure.message, 'NATIVE_GUARD_CONTROL_MARKER').toContain(marker)
  expect(failure.matcherResult, 'NATIVE_GUARD_CONTROL_OPERANDS').toMatchObject({
    actual,
    expected,
    name: 'toBe',
    pass: false,
  })
}

async function guardSelfTests(browser: Browser): Promise<void> {
  const cleanPath = '/synthetic/clean-entry.js'
  const cleanContents = 'synthetic-clean-output'
  assertExcludedArtifact(cleanPath, cleanContents)
  guardMustRefuse(
    () => assertExcludedArtifact('/synthetic/owner-claim-coordinator.js', cleanContents),
    'FIXTURE_WORKER_NOT_BUNDLED',
    true,
    false
  )
  assertExcludedArtifact(cleanPath, cleanContents)
  guardMustRefuse(
    () => assertExcludedArtifact(cleanPath, 'W03_NATIVE_COORDINATOR_FIXTURE_ONLY'),
    'FIXTURE_SENTINEL_NOT_BUNDLED',
    true,
    false
  )
  assertExcludedArtifact(cleanPath, cleanContents)
  const manifest = await expectedChromium()
  const observed = browser.version()
  assertBrowserVersion(observed, manifest.entries)
  guardMustRefuse(
    () => assertBrowserVersion(observed + '-input-drift', manifest.entries),
    'NATIVE_BROWSER_VERSION_MATCHES_MANIFEST',
    false,
    true
  )
  assertBrowserVersion(observed, manifest.entries)
  console.log('W03_NATIVE_PREFLIGHT_CONTROLS exact-input-refusals-and-pristine-restoration')
}

async function deadline<Value>(
  promise: Promise<Value>,
  milliseconds: number,
  marker: string
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(marker)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function emittedFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    expect(item.isSymbolicLink(), 'FIXTURE_DIST_SYMLINK').toBe(false)
    if (item.isDirectory()) files.push(...(await emittedFiles(path)))
    else if (item.isFile()) files.push(path)
    else throw Error('FIXTURE_DIST_UNEXPECTED_ENTRY')
  }
  return files
}

async function assertExcluded(): Promise<void> {
  const files = await emittedFiles(fileURLToPath(new URL('../../dist/', import.meta.url)))
  expect(files.length, 'FIXTURE_DIST_PRESENT').toBeGreaterThan(0)
  for (const path of files) {
    const contents = /\.(?:html|m?js)$/.test(path) ? await readFile(path, 'utf8') : undefined
    assertExcludedArtifact(path, contents)
  }
}

interface Rank1FixtureMetadata {
  browser: {
    playwright: '1.63.0'
    version: string
    manifest: string
    expected: ExpectedChromium[]
    platform: string
    arch: string
    actualBinaryAttested: false
    projectPreferenceInheritanceAttested: false
    serviceWorkers: 'block'
  }
  contextClosed: boolean
  serverStopped: boolean
  rootRemoved: boolean
  pending: number
  sticky: number
}

async function withFixture<Value = Comparison>(
  browser: Browser,
  testInfo: TestInfo,
  label: string,
  variant: RunVariant,
  probe: (fixture: OwnedFixture) => Promise<Value>,
  forceFirstDisposeError = false,
  rank1 = false,
  fencingVariant?: FencingVariant
): Promise<{ comparison: Value; hashes: Record<string, string>; rank1?: Rank1FixtureMetadata }> {
  const failures: unknown[] = []
  const sticky: string[] = []
  let root: string | undefined
  let context: BrowserContext | undefined
  let child: ChildProcess | undefined
  let closed: Promise<void> | undefined
  let stopping = false
  let stdout = ''
  let stderr = ''
  let origin = ''
  let serverArguments: string[] = []
  const requests: { path: string; method: string; type: string }[] = []
  const snapshots: {
    before: ReturnType<NativeCapabilityClient['inspect']>
    after: ReturnType<NativeCapabilityClient['inspect']>
  }[] = []
  let comparison: Value | undefined
  let contextClosed = false
  let serverStopped = false
  let rootRemoved = false
  let rank1Metadata: Rank1FixtureMetadata | undefined
  const hashes: Record<string, string> = {}
  const assets =
    fencingVariant === undefined
      ? coordinatorFixtureAssets(variant === 'split-name' ? 'canonical' : variant)
      : fencingFixtureAssets(fencingVariant)
  try {
    await assertExcluded()
    await mkdir(testInfo.outputPath(), { recursive: true })
    root = await mkdtemp(join(testInfo.outputPath(), `${label}-`))
    for (const [name, contents] of Object.entries(assets)) {
      await writeFile(join(root, name), contents, { flag: 'wx' })
      hashes[name] = digest(contents)
    }
    expect((await readdir(root)).sort(), 'FIXTURE_EXACT_ASSETS').toEqual(ASSET_NAMES)
    serverArguments = [
      STATIC_SCRIPT,
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
    ]
    child = spawn(process.execPath, serverArguments, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1' },
    })
    closed = new Promise((resolve) => {
      child?.once('close', () => {
        if (!stopping) sticky.push('FIXTURE_UNEXPECTED_CHILD_EXIT')
        resolve()
      })
    })
    child.once('error', () => sticky.push('FIXTURE_CHILD_ERROR'))
    for (const [stream, kind] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      stream?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > 16_384) {
          sticky.push('FIXTURE_CHILD_OUTPUT_CAP')
          child?.kill('SIGKILL')
          return
        }
        if (kind === 'stdout') stdout += chunk.toString()
        else stderr += chunk.toString()
      })
    }
    await expect
      .poll(() => stdout.includes('\n') || sticky.length > 0, { timeout: 5000 })
      .toBe(true)
    expect(sticky, 'FIXTURE_READY_STICKY').toEqual([])
    const ready: unknown = JSON.parse(stdout.trim())
    expect(ready, 'FIXTURE_READY').toMatchObject({ event: 'listening', host: '127.0.0.1' })
    if (
      ready === null ||
      typeof ready !== 'object' ||
      !('port' in ready) ||
      typeof ready.port !== 'number' ||
      !Number.isSafeInteger(ready.port) ||
      ready.port < 1
    ) {
      throw Error('FIXTURE_READY_PORT')
    }
    origin = `http://127.0.0.1:${ready.port}`
    context = await browser.newContext({ serviceWorkers: 'block' })
    const allowed = new Set(ASSET_NAMES.map((name) => origin + '/' + name))
    if (rank1) allowed.add(origin + '/fixture-icon.svg?rank1-probe=1')
    context.on('request', (request) => {
      if (!allowed.has(request.url()) || request.method() !== 'GET') {
        sticky.push('FIXTURE_UNEXPECTED_REQUEST')
      }
      if (requests.length >= 64) sticky.push('FIXTURE_REQUEST_CAP')
      else {
        requests.push({
          path: new URL(request.url()).pathname,
          method: request.method(),
          type: request.resourceType(),
        })
      }
    })
    await context.route(
      (url) => !allowed.has(url.href),
      async (route) => {
        sticky.push('FIXTURE_ABORTED_UNEXPECTED_REQUEST')
        await route.abort()
      }
    )
    context.on('page', (page) => page.on('pageerror', () => sticky.push('FIXTURE_PAGE_ERROR')))
    const ownedContext = context
    const page = async (): Promise<Page> => {
      const created = await ownedContext.newPage()
      await created.goto(origin + '/index.html')
      await created.waitForFunction(() => !!window.__koderaNativeCapability)
      return created
    }
    comparison = await probe({ context, origin, variant, page })
    expect(sticky, 'FIXTURE_PROBE_STICKY').toEqual([])
    for (const name of ASSET_NAMES) {
      expect(digest(await readFile(join(root, name))), 'FIXTURE_ASSET_UNCHANGED').toBe(hashes[name])
    }
  } catch (error) {
    failures.push(error)
  } finally {
    if (context !== undefined) {
      for (const [pageIndex, page] of context.pages().entries()) {
        try {
          const snapshot = await deadline(
            page.evaluate(
              (contamination: 'FORCED_DISPOSE_ERROR' | undefined) => {
                const before = window.__koderaNativeCapability.inspect()
                window.__koderaNativeCapability.dispose(contamination)
                return { before, after: window.__koderaNativeCapability.inspect() }
              },
              forceFirstDisposeError && pageIndex === 0
                ? ('FORCED_DISPOSE_ERROR' as const)
                : undefined
            ),
            3000,
            'FIXTURE_ATOMIC_DISPOSE_TIMEOUT'
          )
          snapshots.push(snapshot)
          expect(snapshot.before.pending, 'FIXTURE_UNSETTLED_OPERATIONS').toBe(0)
          expect(snapshot.before.errors, 'FIXTURE_CLIENT_STICKY').toEqual([])
          expect(snapshot.after.pending, 'FIXTURE_FINAL_UNSETTLED_OPERATIONS').toBe(0)
          expect(snapshot.after.errors, 'FIXTURE_FINAL_CLIENT_STICKY').toEqual([])
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await deadline(context.close(), 5000, 'FIXTURE_CONTEXT_CLOSE_TIMEOUT')
        contextClosed = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (child !== undefined) {
      try {
        if (child.exitCode !== null || child.signalCode !== null) {
          sticky.push('FIXTURE_CHILD_EXITED_BEFORE_STOP')
        }
        stopping = true
        child.kill('SIGTERM')
        if (closed !== undefined) await deadline(closed, 2000, 'FIXTURE_CHILD_TERM_TIMEOUT')
      } catch (error) {
        failures.push(error)
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          try {
            if (closed !== undefined) await deadline(closed, 1000, 'FIXTURE_CHILD_KILL_TIMEOUT')
          } catch (error) {
            failures.push(error)
          }
        }
      }
      try {
        serverStopped = child.exitCode !== null || child.signalCode !== null
        expect(stdout.trim().split('\n'), 'FIXTURE_READY_ONCE').toHaveLength(1)
        expect(stderr, 'FIXTURE_CHILD_STDERR').toBe('')
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      expect(sticky, 'FIXTURE_FINAL_STICKY').toEqual([])
    } catch (error) {
      failures.push(error)
    }
    if (root !== undefined) {
      try {
        await rm(root, { recursive: true })
        rootRemoved = true
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      const installed: unknown = JSON.parse(
        await readFile(
          new URL('../../../../node_modules/playwright-core/package.json', import.meta.url),
          'utf8'
        )
      )
      expect(installed, 'NATIVE_LOCKED_PLAYWRIGHT').toMatchObject({ version: '1.63.0' })
      const browserManifest = await expectedChromium()
      assertBrowserVersion(browser.version(), browserManifest.entries)
      const evidence = {
        label,
        variant,
        project: testInfo.project.name,
        retry: testInfo.retry,
        explicitContextOptions: { serviceWorkers: 'block' },
        projectDevicePreferenceInheritanceAttested: false,
        forceFirstDisposeError,
        playwright: '1.63.0',
        lockSha256: digest(await readFile(new URL('../../../../package-lock.json', import.meta.url))),
        browserVersion: browser.version(),
        reportedDefaultExecutable: browser.browserType().executablePath(),
        browserManifest,
        matchedExpectedBrowserEntries: browserManifest.entries.filter(
          (entry) => entry.browserVersion === browser.version()
        ),
        actualLaunchedExecutableAndRevisionAttested: false,
        platform: process.platform,
        arch: process.arch,
        origin,
        serverArguments,
        readiness: stdout.trim(),
        hashes,
        requests,
        snapshots,
        comparison,
        sticky,
        cleanupFailed: failures.length > 0,
        fixtureSourceSha256: digest(
          await readFile(new URL('./support/ownerClaimCoordinatorFixture.ts', import.meta.url))
        ),
        staticServerSha256: digest(await readFile(STATIC_SCRIPT)),
      }
      if (rank1) {
        expect(snapshots, 'R1_TWO_ATOMIC_DISPOSALS').toHaveLength(2)
        expect({ contextClosed, serverStopped, rootRemoved }, 'R1_FIXTURE_FINALIZED').toEqual({
          contextClosed: true,
          serverStopped: true,
          rootRemoved: true,
        })
        rank1Metadata = {
          browser: {
            playwright: '1.63.0',
            version: browser.version(),
            manifest: browserManifest.sha256,
            expected: browserManifest.entries,
            platform: process.platform,
            arch: process.arch,
            actualBinaryAttested: false,
            projectPreferenceInheritanceAttested: false,
            serviceWorkers: 'block',
          },
          contextClosed,
          serverStopped,
          rootRemoved,
          pending: snapshots.reduce(
            (total, snapshot) => total + snapshot.before.pending + snapshot.after.pending,
            0
          ),
          sticky:
            sticky.length +
            snapshots.reduce(
              (total, snapshot) =>
                total + snapshot.before.errors.length + snapshot.after.errors.length,
              0
            ),
        }
      } else {
        const bytes = Buffer.from(JSON.stringify(evidence))
        expect(bytes.byteLength, 'FIXTURE_EVIDENCE_CAP').toBeLessThanOrEqual(65_536)
        await testInfo.attach(label, { body: bytes, contentType: 'application/json' })
        console.log('W03_NATIVE_CAPABILITY ' + bytes.toString())
      }
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'FIXTURE_NONQUALIFIED')
  if (comparison === undefined) throw Error('FIXTURE_COMPARISON_MISSING')
  return { comparison, hashes, ...(rank1 ? { rank1: rank1Metadata } : {}) }
}

async function connect(page: Page, name = CANONICAL_NAME): Promise<NativeCapabilityReply> {
  const reply = await page.evaluate(
    (workerName) => window.__koderaNativeCapability.connect(workerName),
    name
  )
  expect(reply.op, 'NATIVE_HELLO_OPERATION').toBe('hello')
  expect(reply.status, 'NATIVE_HELLO_STATUS').toBe('hello')
  expect(reply.instance, 'NATIVE_HELLO_INSTANCE').toMatch(/^[0-9a-f-]{36}$/)
  expect(reply.port, 'NATIVE_HELLO_PORT').toBeGreaterThan(0)
  const state = await page.evaluate(() => window.__koderaNativeCapability.inspect())
  expect(state.constructors.at(-1), 'NATIVE_CONSTRUCTOR_IDENTITY').toEqual({
    url: '/owner-claim-coordinator.js',
    name,
    type: 'classic',
    credentials: 'same-origin',
  })
  return reply
}

async function openerChild(keeper: Page, context: BrowserContext): Promise<Page> {
  const popup = context.waitForEvent('page')
  await keeper.getByRole('button', { name: 'Open prepared child' }).click()
  const child = await popup
  await child.waitForLoadState('load')
  await child.waitForFunction(() => !!window.__koderaNativeCapability)
  expect(await child.evaluate(() => window.opener !== null), 'NATIVE_CHILD_HAS_OPENER').toBe(true)
  return child
}

async function probe(caseId: CaseId, fixture: OwnedFixture): Promise<Comparison> {
  const keeper = await fixture.page()
  const first = await connect(keeper)
  if (caseId === 'C01') {
    const second = await fixture.page()
    const next = await connect(
      second,
      fixture.variant === 'split-name' ? SPLIT_NAME : CANONICAL_NAME
    )
    return {
      marker: 'NATIVE_SHARED_INSTANCE_COUNT',
      actual: new Set([first.instance, next.instance]).size,
      expected: 1,
    }
  }
  const early = caseId === 'C02' ? await openerChild(keeper, fixture.context) : undefined
  if (early !== undefined) {
    expect(
      (await early.evaluate(() => window.__koderaNativeCapability.inspect())).initialMarker,
      'NATIVE_PREARM_CHILD_EMPTY'
    ).toBeNull()
    expect((await connect(early)).instance, 'NATIVE_PREARM_SHARED_INSTANCE').toBe(first.instance)
  }
  const prepared = await keeper.evaluate(() => window.__koderaNativeCapability.prepare())
  expect(prepared.status, 'NATIVE_PREPARE_STATUS').toBe('prepared')
  const marker = (await keeper.evaluate(() => window.__koderaNativeCapability.inspect()))
    .currentMarker
  expect(marker, 'NATIVE_PREPARED_MARKER').not.toBeNull()
  if (marker === null) throw Error('NATIVE_MARKER_ABSENT')
  if (caseId === 'C02') {
    if (early === undefined) throw Error('NATIVE_EARLY_CHILD_ABSENT')
    expect(
      (await early.evaluate(() => window.__koderaNativeCapability.inspect())).currentMarker,
      'NATIVE_PREARM_NOT_UPDATED'
    ).toBeNull()
    const children = [
      await openerChild(keeper, fixture.context),
      await openerChild(keeper, fixture.context),
    ]
    const ports: number[] = []
    for (const child of children) {
      expect(
        (await child.evaluate(() => window.__koderaNativeCapability.inspect())).initialMarker,
        'NATIVE_OPENER_COPIED_ARM'
      ).toBe(marker)
      const hello = await connect(child)
      expect(hello.instance, 'NATIVE_CHILD_SHARED_INSTANCE').toBe(first.instance)
      ports.push(hello.port)
    }
    expect(new Set(ports).size, 'NATIVE_DISTINCT_CHILD_PORTS').toBe(2)
    const replies = await Promise.all(
      children.map((child) => child.evaluate(() => window.__koderaNativeCapability.take()))
    )
    expect(
      replies.map((reply) => reply.op),
      'NATIVE_TAKE_REPLY_OPERATIONS'
    ).toEqual(['take', 'take'])
    for (const reply of replies) {
      expect(['taken', 'refused'], 'NATIVE_TAKE_STATUS').toContain(reply.status)
    }
    await children[0]!.evaluate((key) => sessionStorage.removeItem(key), MARKER_NAME)
    expect(
      (await keeper.evaluate(() => window.__koderaNativeCapability.inspect())).currentMarker,
      'NATIVE_KEEPER_INDEPENDENT_COPY'
    ).toBe(marker)
    const independent = await fixture.page()
    expect(
      (await independent.evaluate(() => window.__koderaNativeCapability.inspect())).initialMarker,
      'NATIVE_INDEPENDENT_PAGE_EMPTY'
    ).toBeNull()
    await connect(independent)
    expect(
      (await independent.evaluate(() => window.__koderaNativeCapability.take())).status,
      'NATIVE_MISSING_ARM_REFUSED'
    ).toBe('refused')
    return {
      marker: 'NATIVE_SHARED_ARM_TAKE_SUCCESSES',
      actual: replies.filter((reply) => reply.status === 'taken').length,
      expected: 1,
    }
  }
  expect(
    (await keeper.evaluate(() => window.__koderaNativeCapability.take())).status,
    'NATIVE_INITIAL_TAKE'
  ).toBe('taken')
  expect(
    (await keeper.evaluate(() => window.__koderaNativeCapability.closeWorker())).status,
    'NATIVE_CLOSE_ACK'
  ).toBe('closing')
  const fresh = await fixture.page()
  const next = await connect(fresh)
  expect(next.instance, 'NATIVE_NEW_INSTANCE_AFTER_CLOSE').not.toBe(first.instance)
  expect(next.armPresent, 'NATIVE_NEW_INSTANCE_EMPTY').toBe(false)
  expect(
    (await fresh.evaluate(() => window.__koderaNativeCapability.take())).status,
    'NATIVE_NEW_MISSING_ARM_REFUSAL'
  ).toBe('refused')
  const replay = await fresh.evaluate(
    (oldMarker) => window.__koderaNativeCapability.replay(oldMarker),
    marker
  )
  expect(replay.op, 'NATIVE_REPLAY_OPERATION').toBe('take')
  expect(['taken', 'refused'], 'NATIVE_REPLAY_STATUS').toContain(replay.status)
  if (replay.status === 'refused') {
    expect(
      (await fresh.evaluate(() => window.__koderaNativeCapability.prepare())).status,
      'NATIVE_EXPLICIT_FRESH_PREPARE'
    ).toBe('prepared')
    expect(
      (await fresh.evaluate(() => window.__koderaNativeCapability.take())).status,
      'NATIVE_EXPLICIT_FRESH_TAKE'
    ).toBe('taken')
  }
  return {
    marker: 'NATIVE_REPLAY_ARM_TAKE_SUCCESSES',
    actual: replay.status === 'taken' ? 1 : 0,
    expected: 0,
  }
}

function compare(result: Comparison): void {
  expect(result.actual, result.marker).toBe(result.expected)
}

async function campaign(caseId: CaseId, browser: Browser, testInfo: TestInfo): Promise<void> {
  const variant: RunVariant =
    caseId === 'C01' ? 'split-name' : caseId === 'C02' ? 'per-port-spent' : 'hydrate-replay'
  const pristine = await withFixture(
    browser,
    testInfo,
    `${caseId}-pristine`,
    'canonical',
    (fixture) => probe(caseId, fixture)
  )
  compare(pristine.comparison)
  const control = await withFixture(browser, testInfo, `${caseId}-control`, variant, (fixture) =>
    probe(caseId, fixture)
  )
  expect(control.comparison.marker, 'NATIVE_CONTROL_SAME_COMPARATOR').toBe(
    pristine.comparison.marker
  )
  expect(control.comparison.expected, 'NATIVE_CONTROL_EXPECTED').toBe(pristine.comparison.expected)
  expect(control.comparison.actual, 'NATIVE_CONTROL_EXACT_ACTUAL').toBe(caseId === 'C03' ? 1 : 2)
  let refusal: unknown
  try {
    compare(control.comparison)
  } catch (error) {
    refusal = error
  }
  expect(refusal, 'NATIVE_CONTROL_COMPARATOR_MUST_FAIL').toBeInstanceOf(Error)
  const assertion = refusal as Error & {
    matcherResult?: { actual?: unknown; expected?: unknown; name?: string; pass?: boolean }
  }
  expect(assertion.message, 'NATIVE_CONTROL_MARKER').toContain(control.comparison.marker)
  expect(assertion.matcherResult, 'NATIVE_CONTROL_OPERANDS').toMatchObject({
    actual: control.comparison.actual,
    expected: control.comparison.expected,
    name: 'toBe',
    pass: false,
  })
  if (caseId === 'C01') {
    let contamination: unknown
    try {
      await withFixture(
        browser,
        testInfo,
        'C01-disposal-control',
        'canonical',
        async (fixture) => {
          const result = await probe('C01', fixture)
          compare(result)
          return result
        },
        true
      )
    } catch (error) {
      contamination = error
    }
    expect(contamination, 'NATIVE_DISPOSAL_CONTROL_MUST_FAIL').toBeInstanceOf(AggregateError)
    const members: unknown[] = (contamination as AggregateError).errors
    expect(members, 'NATIVE_DISPOSAL_CONTROL_ONLY_INTENDED_FAILURE').toHaveLength(1)
    expect(members[0], 'NATIVE_DISPOSAL_CONTROL_ASSERTION').toBeInstanceOf(Error)
    const failure = members[0] as Error & {
      matcherResult?: { actual?: unknown; expected?: unknown; name?: string; pass?: boolean }
    }
    expect(failure.message, 'NATIVE_DISPOSAL_CONTROL_MARKER').toContain(
      'FIXTURE_FINAL_CLIENT_STICKY'
    )
    expect(failure.matcherResult, 'NATIVE_DISPOSAL_CONTROL_OPERANDS').toMatchObject({
      actual: ['FORCED_DISPOSE_ERROR'],
      expected: [],
      name: 'toEqual',
      pass: false,
    })
    console.log('W03_NATIVE_DISPOSAL_CONTROL FORCED_DISPOSE_ERROR exact-final-sticky-refusal')
  }
  const restored = await withFixture(
    browser,
    testInfo,
    `${caseId}-restored`,
    'canonical',
    (fixture) => probe(caseId, fixture)
  )
  compare(restored.comparison)
  expect(restored.hashes, 'NATIVE_PRISTINE_BYTE_RESTORATION').toEqual(pristine.hashes)
  console.log(
    'W03_NATIVE_CONTROL ' +
      JSON.stringify({
        caseId,
        marker: control.comparison.marker,
        actual: control.comparison.actual,
        expected: control.comparison.expected,
        restored: true,
        retry: testInfo.retry,
      })
  )
}

test('W03 native C01 canonical live sharing', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  await guardSelfTests(browser)
  await campaign('C01', browser, testInfo)
})

test('W03 native C02 keeper opener copy and shared one use', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  await campaign('C02', browser, testInfo)
})

test('W03 native C03 same URL new instance refuses replay', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  await campaign('C03', browser, testInfo)
})

test('W03 rank1 lock spans native invocation not response', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  rank1ReceiptSelfTests()
  let pristine: Awaited<ReturnType<typeof runRank1Subject>> | undefined
  for (const [label, variant] of [
    ['pristine', 'canonical'],
    ['F1', 'F1'],
    ['after-F1', 'canonical'],
    ['F2', 'F2'],
    ['after-F2', 'canonical'],
  ] as const) {
    const observed = await runRank1Subject(
      browser,
      testInfo,
      label,
      rank1BrowserProgram(variant),
      pristine?.hashes
    )
    if (pristine === undefined) pristine = observed
    if (variant === 'canonical') {
      expect(observed.hashes, 'R1_FOUR_ASSET_RESTORATION').toEqual(pristine.hashes)
      expect(observed.record.source.program, 'R1_CANONICAL_PROGRAM_RESTORATION').toBe(
        pristine.record.source.canonicalProgram
      )
    }
  }
})

type Rank1Label = 'pristine' | 'F1' | 'after-F1' | 'F2' | 'after-F2'
type NativeProfile = ReturnType<NativeCapabilityClient['inspect']>['profile']
interface Rank1Record {
  version: 1
  label: Rank1Label
  project: string
  retry: number
  worker: number
  source: {
    spec: string
    fixture: string
    staticServer: string
    lock: string
    canonicalProgram: string
    program: string
  }
  browser: Rank1FixtureMetadata['browser']
  profiles: NativeProfile[]
  observations: {
    companionAcquiredBeforeDispatch: boolean
    nativeBeforeLockCompletion: boolean
    companionAcquiredDuringResponse: boolean
    witness: 'lock-completed' | 'response-adopted'
    nativeInvocationOrder: number
    lockCompletionOrder: number
    adoptionOrder: number | null
    requestCount: number
    responseHeldAtProbe: boolean
    responseSettledAtProbe: boolean
    method: string
    postDataAbsent: boolean
    authorizationAbsent: boolean
    idempotencyAbsent: boolean
  }
  result: 'pristine' | 'expected-control-refusal'
  refusal: null | 'R1_LOCK_TO_NATIVE_INVOCATION' | 'R1_LOCK_RELEASED_DURING_RESPONSE'
  cleanup: {
    pending: number
    sticky: number
    routeRemoved: boolean
    operationSettled: boolean
    forwardingSettled: boolean
    observerSettled: boolean
    contextClosed: boolean
    serverStopped: boolean
    rootRemoved: boolean
  }
}

async function rank1Probe(
  fixture: OwnedFixture,
  program: string
): Promise<{
  observations: Rank1Record['observations']
  profiles: NativeProfile[]
  cleanup: Pick<
    Rank1Record['cleanup'],
    'routeRemoved' | 'operationSettled' | 'forwardingSettled' | 'observerSettled'
  >
}> {
  const dispatch = await fixture.page()
  const companion = await fixture.page()
  const profiles = [
    (await dispatch.evaluate(() => window.__koderaNativeCapability.inspect())).profile,
    (await companion.evaluate(() => window.__koderaNativeCapability.inspect())).profile,
  ]
  const url = fixture.origin + '/fixture-icon.svg?rank1-probe=1'
  let releaseResponse: () => void = () => {}
  const responseBarrier = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let requestArrived: (kind: 'request' | 'cleanup-only') => void = () => {}
  const requestWitness = new Promise<'request' | 'cleanup-only'>((resolve) => {
    requestArrived = resolve
  })
  let released = false
  let requestCount = 0
  let routeCount = 0
  let routeWork: Promise<void> | undefined
  let requestFacts:
    | Pick<
        Rank1Record['observations'],
        'method' | 'postDataAbsent' | 'authorizationAbsent' | 'idempotencyAbsent'
      >
    | undefined
  const failures: unknown[] = []
  const operations: Promise<unknown>[] = [requestWitness, responseBarrier]
  let primaryFailed = false
  let primaryError: unknown
  let observations: Rank1Record['observations'] | undefined
  let finalState: Rank1PageState | undefined
  let routeRemoved = false
  let hostDrained = false
  const onRequest = (request: Request) => {
    if (request.url() !== url) return
    requestCount += 1
    if (request.frame().page() !== dispatch) failures.push(Error('R1_WRONG_REQUEST_PAGE'))
  }
  const handler = (route: Route): Promise<void> => {
    const operation = (async () => {
      routeCount += 1
      const request = route.request()
      const headers = Object.keys(request.headers())
      requestFacts = {
        method: request.method(),
        postDataAbsent: request.postData() === null,
        authorizationAbsent: !headers.some((name) => /^authorization$/i.test(name)),
        idempotencyAbsent: !headers.some((name) => /idempotency/i.test(name)),
      }
      requestArrived('request')
      await responseBarrier
      await route.fulfill({ status: 204, body: '', headers: { 'cache-control': 'no-store' } })
    })()
    routeWork = operation
    operations.push(operation)
    operations.push(
      operation.catch((error: unknown) => {
        failures.push(error)
      })
    )
    return operation
  }
  fixture.context.on('request', onRequest)
  try {
    await dispatch.route(url, handler)
    await dispatch.evaluate(program)
    const ready = dispatch.evaluate(() => window.__koderaRank1!.ready())
    operations.push(ready)
    await deadline(ready, 5000, 'R1_READY_TIMEOUT')
    const beforeOperation = companion.evaluate(() =>
      navigator.locks.request(
        'kodera.test.owner-claim/11111111-1111-4111-8111-111111111111',
        { mode: 'exclusive', ifAvailable: true },
        (lock) => lock !== null
      )
    )
    operations.push(beforeOperation)
    const before = await deadline(beforeOperation, 5000, 'R1_BEFORE_PROBE_TIMEOUT')
    await dispatch.evaluate(() => window.__koderaRank1!.release())
    const witnessOperation = dispatch.evaluate(() => window.__koderaRank1!.witness())
    operations.push(witnessOperation)
    const [witness, requestEvent] = await Promise.all([
      deadline(witnessOperation, 5000, 'R1_CAUSAL_WITNESS_TIMEOUT'),
      deadline(requestWitness, 5000, 'R1_REQUEST_TIMEOUT'),
    ])
    expect(requestEvent, 'R1_ACTUAL_REQUEST_WITNESS').toBe('request')
    expect({ requestCount, routeCount }, 'R1_ONE_NATIVE_REQUEST').toEqual({
      requestCount: 1,
      routeCount: 1,
    })
    expect(requestFacts, 'R1_INERT_GET').toEqual({
      method: 'GET',
      postDataAbsent: true,
      authorizationAbsent: true,
      idempotencyAbsent: true,
    })
    const current = await dispatch.evaluate(() => window.__koderaRank1!.inspect())
    expect(current.invocations, 'R1_ONE_NATIVE_INVOCATION').toBe(1)
    expect(witness.invocation, 'R1_WITNESS_CORRELATED_INVOCATION').toBe(
      current.nativeInvocationOrder
    )
    expect(current.nativeInvocationOrder, 'R1_INVOCATION_PRESENT').toBeGreaterThan(0)
    expect(current.errors, 'R1_PAGE_WORK_STICKY').toEqual([])
    expect(current.responseSettled, 'R1_RESPONSE_PENDING_BEFORE_PROBE').toBe(false)
    if (witness.kind === 'lock-completed') {
      expect(current.lockCompletionOrder, 'R1_ACTUAL_LOCK_COMPLETION').toBeGreaterThan(0)
      expect(witness.adoption, 'R1_RELEASE_NOT_ADOPTION').toBeNull()
    } else {
      expect(current.lockCompletionOrder, 'R1_ADOPTED_WORK_STILL_PENDING').toBe(0)
      expect(witness.adoption, 'R1_ACTUAL_CORRELATED_ADOPTION').toBe(current.adoptionOrder)
      expect(current.adoptionOrder, 'R1_ADOPTION_PRESENT').toBeGreaterThan(0)
    }
    const duringOperation = companion.evaluate(() =>
      navigator.locks.request(
        'kodera.test.owner-claim/11111111-1111-4111-8111-111111111111',
        { mode: 'exclusive', ifAvailable: true },
        (lock) => lock !== null
      )
    )
    operations.push(duringOperation)
    const during = await deadline(duringOperation, 5000, 'R1_RESPONSE_PROBE_TIMEOUT')
    const afterProbe = await dispatch.evaluate(() => window.__koderaRank1!.inspect())
    expect({ released, settled: afterProbe.responseSettled }, 'R1_RESPONSE_HELD_AT_PROBE').toEqual({
      released: false,
      settled: false,
    })
    observations = {
      companionAcquiredBeforeDispatch: before,
      nativeBeforeLockCompletion: false,
      companionAcquiredDuringResponse: during,
      witness: witness.kind,
      nativeInvocationOrder: current.nativeInvocationOrder,
      lockCompletionOrder: 0,
      adoptionOrder: current.adoptionOrder,
      requestCount,
      responseHeldAtProbe: !released,
      responseSettledAtProbe: afterProbe.responseSettled,
      ...requestFacts!,
    }
  } catch (error) {
    primaryFailed = true
    primaryError = error
  } finally {
    try {
      await dispatch.evaluate(() => window.__koderaRank1?.release())
    } catch (error) {
      failures.push(error)
    }
    released = true
    releaseResponse()
    try {
      const drained = await deadline(
        dispatch.evaluate(async () => {
          if (!window.__koderaRank1) throw Error('R1_OWNED_STATE_ABSENT')
          return window.__koderaRank1.finish()
        }),
        5000,
        'R1_OPERATION_DRAIN_TIMEOUT'
      )
      finalState = drained
      expect(drained.errors, 'R1_DRAIN_STICKY').toEqual([])
      expect(
        {
          operationSettled: drained.operationSettled,
          responseSettled: drained.responseSettled,
          forwardingSettled: drained.forwardingSettled,
          observerSettled: drained.observerSettled,
        },
        'R1_OWNED_WORK_DRAINED'
      ).toEqual({
        operationSettled: true,
        responseSettled: true,
        forwardingSettled: true,
        observerSettled: true,
      })
    } catch (error) {
      failures.push(error)
    }
    requestArrived('cleanup-only')
    try {
      if (routeWork) await deadline(routeWork, 3000, 'R1_ROUTE_DRAIN_TIMEOUT')
      const settled = await deadline(
        Promise.allSettled(operations),
        3000,
        'R1_HOST_WORK_DRAIN_TIMEOUT'
      )
      expect(
        settled.every((entry) => entry.status === 'fulfilled'),
        'R1_HOST_OPERATIONS_SETTLED'
      ).toBe(true)
      hostDrained = true
    } catch (error) {
      failures.push(error)
    }
    try {
      await dispatch.unroute(url, handler)
      routeRemoved = true
    } catch (error) {
      failures.push(error)
    }
    fixture.context.off('request', onRequest)
    try {
      profiles.push(
        (await dispatch.evaluate(() => window.__koderaNativeCapability.inspect())).profile,
        (await companion.evaluate(() => window.__koderaNativeCapability.inspect())).profile
      )
      if (
        hostDrained &&
        finalState?.operationSettled &&
        finalState.forwardingSettled &&
        finalState.observerSettled
      ) {
        await dispatch.evaluate(() => {
          delete window.__koderaRank1
        })
      }
    } catch (error) {
      failures.push(error)
    }
  }
  if (primaryFailed) {
    if (failures.length)
      throw new AggregateError([primaryError, ...failures], 'R1_PRIMARY_AND_CLEANUP')
    throw primaryError
  }
  if (failures.length) throw new AggregateError(failures, 'R1_CLEANUP_NONQUALIFIED')
  if (!observations || !finalState) throw Error('R1_OBSERVATIONS_ABSENT')
  observations.lockCompletionOrder = finalState.lockCompletionOrder
  observations.nativeBeforeLockCompletion =
    observations.nativeInvocationOrder < finalState.lockCompletionOrder
  expect(finalState.invocations, 'R1_FINAL_ONE_INVOCATION').toBe(1)
  expect(finalState.lockCompletionOrder, 'R1_FINAL_LOCK_COMPLETED').toBeGreaterThan(0)
  expect({ requestCount, routeCount }, 'R1_FINAL_ONE_NATIVE_REQUEST').toEqual({
    requestCount: 1,
    routeCount: 1,
  })
  return {
    observations,
    profiles,
    cleanup: {
      routeRemoved,
      operationSettled: finalState.operationSettled,
      forwardingSettled: finalState.forwardingSettled,
      observerSettled: finalState.observerSettled,
    },
  }
}

function rank1Object(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!
    ) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',')
  )
}

function rank1Shape(value: unknown): asserts value is Rank1Record {
  function schema(): never {
    throw Error('R1_RECEIPT_SCHEMA')
  }
  const member = (item: unknown, values: readonly unknown[]) => values.includes(item)
  const integer = (item: unknown): item is number =>
    Number.isSafeInteger(item) && (item as number) >= 0
  const finite = (item: unknown): item is number =>
    typeof item === 'number' && Number.isFinite(item) && item > 0
  const text = (item: unknown, cap: number): item is string =>
    typeof item === 'string' &&
    item.length > 0 &&
    item.length <= cap &&
    /^[\x20-\x7e]+$/.test(item) &&
    !/[\r\n]/.test(item)
  if (
    !rank1Object(value, [
      'version',
      'label',
      'project',
      'retry',
      'worker',
      'source',
      'browser',
      'profiles',
      'observations',
      'result',
      'refusal',
      'cleanup',
    ])
  )
    schema()
  if (
    value.version !== 1 ||
    !member(value.label, ['pristine', 'F1', 'after-F1', 'F2', 'after-F2']) ||
    !member(value.project, ['chromium', 'chromium-dark']) ||
    !integer(value.retry) ||
    value.retry > 2 ||
    !integer(value.worker)
  )
    schema()
  if (
    !rank1Object(value.source, [
      'spec',
      'fixture',
      'staticServer',
      'lock',
      'canonicalProgram',
      'program',
    ]) ||
    Object.values(value.source).some(
      (item) => typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)
    )
  )
    schema()
  if (
    !rank1Object(value.browser, [
      'playwright',
      'version',
      'manifest',
      'expected',
      'platform',
      'arch',
      'actualBinaryAttested',
      'projectPreferenceInheritanceAttested',
      'serviceWorkers',
    ])
  )
    schema()
  const browser = value.browser
  if (
    browser.playwright !== '1.63.0' ||
    !text(browser.version, 64) ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(browser.version) ||
    typeof browser.manifest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(browser.manifest) ||
    !text(browser.platform, 32) ||
    !text(browser.arch, 32) ||
    browser.actualBinaryAttested !== false ||
    browser.projectPreferenceInheritanceAttested !== false ||
    browser.serviceWorkers !== 'block' ||
    !Array.isArray(browser.expected) ||
    browser.expected.length !== 2
  )
    schema()
  for (const [index, entry] of browser.expected.entries()) {
    if (
      !rank1Object(entry, ['name', 'browserVersion', 'revision']) ||
      entry.name !== ['chromium', 'chromium-headless-shell'][index] ||
      !text(entry.browserVersion, 64) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(entry.browserVersion) ||
      !text(entry.revision, 32) ||
      !/^\d+$/.test(entry.revision)
    )
      schema()
  }
  if (
    !browser.expected.some(
      (entry: { browserVersion: string }) => entry.browserVersion === browser.version
    )
  )
    schema()
  if (!Array.isArray(value.profiles) || value.profiles.length !== 4) schema()
  for (const profile of value.profiles) {
    if (
      !rank1Object(profile, [
        'userAgent',
        'language',
        'colorScheme',
        'timezone',
        'viewport',
        'devicePixelRatio',
        'maxTouchPoints',
        'secureContext',
      ]) ||
      !text(profile.userAgent, 256) ||
      !text(profile.language, 32) ||
      !text(profile.timezone, 64) ||
      !member(profile.colorScheme, ['light', 'dark']) ||
      !finite(profile.devicePixelRatio) ||
      !integer(profile.maxTouchPoints) ||
      profile.secureContext !== true ||
      !rank1Object(profile.viewport, ['width', 'height']) ||
      !finite(profile.viewport.width) ||
      !finite(profile.viewport.height)
    )
      schema()
  }
  if (
    !rank1Object(value.observations, [
      'companionAcquiredBeforeDispatch',
      'nativeBeforeLockCompletion',
      'companionAcquiredDuringResponse',
      'witness',
      'nativeInvocationOrder',
      'lockCompletionOrder',
      'adoptionOrder',
      'requestCount',
      'responseHeldAtProbe',
      'responseSettledAtProbe',
      'method',
      'postDataAbsent',
      'authorizationAbsent',
      'idempotencyAbsent',
    ])
  )
    schema()
  const observed = value.observations
  if (
    [
      'companionAcquiredBeforeDispatch',
      'nativeBeforeLockCompletion',
      'companionAcquiredDuringResponse',
    ].some((key) => typeof observed[key] !== 'boolean') ||
    !member(observed.witness, ['lock-completed', 'response-adopted']) ||
    observed.requestCount !== 1 ||
    observed.responseHeldAtProbe !== true ||
    observed.responseSettledAtProbe !== false ||
    observed.method !== 'GET' ||
    observed.postDataAbsent !== true ||
    observed.authorizationAbsent !== true ||
    observed.idempotencyAbsent !== true
  )
    schema()
  for (const order of [
    observed.nativeInvocationOrder,
    observed.lockCompletionOrder,
    ...(observed.adoptionOrder === null ? [] : [observed.adoptionOrder]),
  ]) {
    if (!integer(order) || order < 1 || order > 16) throw Error('R1_RECEIPT_ORDER')
  }
  const invocation = observed.nativeInvocationOrder as number
  const completion = observed.lockCompletionOrder as number
  if (invocation === completion || observed.nativeBeforeLockCompletion !== invocation < completion)
    throw Error('R1_RECEIPT_ORDER')
  if (
    observed.witness === 'lock-completed'
      ? observed.adoptionOrder !== null
      : !(
          typeof observed.adoptionOrder === 'number' &&
          invocation < observed.adoptionOrder &&
          observed.adoptionOrder < completion
        )
  )
    throw Error('R1_RECEIPT_ORDER')
  const firstControl = value.label === 'F1'
  const secondControl = value.label === 'F2'
  if (
    observed.companionAcquiredBeforeDispatch !== firstControl ||
    observed.nativeBeforeLockCompletion === firstControl ||
    observed.companionAcquiredDuringResponse === secondControl ||
    observed.witness !== (secondControl ? 'response-adopted' : 'lock-completed') ||
    value.result !== (firstControl || secondControl ? 'expected-control-refusal' : 'pristine') ||
    value.refusal !==
      (firstControl
        ? 'R1_LOCK_TO_NATIVE_INVOCATION'
        : secondControl
          ? 'R1_LOCK_RELEASED_DURING_RESPONSE'
          : null)
  )
    schema()
  if (!(firstControl || secondControl) && value.source.program !== value.source.canonicalProgram)
    schema()
  if ((firstControl || secondControl) && value.source.program === value.source.canonicalProgram)
    schema()
  if (
    !rank1Object(value.cleanup, [
      'pending',
      'sticky',
      'routeRemoved',
      'operationSettled',
      'forwardingSettled',
      'observerSettled',
      'contextClosed',
      'serverStopped',
      'rootRemoved',
    ]) ||
    value.cleanup.pending !== 0 ||
    value.cleanup.sticky !== 0 ||
    Object.entries(value.cleanup).some(
      ([key, item]) => key !== 'pending' && key !== 'sticky' && item !== true
    )
  )
    schema()
}

function rank1ByteLimit(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8192) throw Error('R1_RECEIPT_BYTES')
}

function rank1Encode(value: unknown): string {
  rank1Shape(value)
  const body = JSON.stringify(value)
  rank1ByteLimit(Buffer.byteLength(body))
  if (!/^[\x20-\x7e]+$/.test(body) || /[\r\n]/.test(body)) throw Error('R1_RECEIPT_SCHEMA')
  const parsed: unknown = JSON.parse(body)
  rank1Shape(parsed)
  if (JSON.stringify(parsed) !== body) throw Error('R1_RECEIPT_SCHEMA')
  return body
}

function rank1ReceiptSelfTests(): void {
  const hash = '0'.repeat(64)
  const profile = {
    userAgent: 'NO_LOG',
    language: 'fr',
    colorScheme: 'light',
    timezone: 'UTC',
    viewport: { width: 2, height: 2 },
    devicePixelRatio: 1,
    maxTouchPoints: 0,
    secureContext: true,
  }
  const pristine = {
    version: 1,
    label: 'pristine',
    project: 'chromium',
    retry: 0,
    worker: 0,
    source: {
      spec: hash,
      fixture: hash,
      staticServer: hash,
      lock: hash,
      canonicalProgram: hash,
      program: hash,
    },
    browser: {
      playwright: '1.63.0',
      version: '1.2.3.4',
      manifest: hash,
      expected: [
        { name: 'chromium', browserVersion: '1.2.3.4', revision: '1' },
        { name: 'chromium-headless-shell', browserVersion: '1.2.3.4', revision: '1' },
      ],
      platform: 'linux',
      arch: 'x64',
      actualBinaryAttested: false,
      projectPreferenceInheritanceAttested: false,
      serviceWorkers: 'block',
    },
    profiles: [profile, profile, profile, profile],
    observations: {
      companionAcquiredBeforeDispatch: false,
      nativeBeforeLockCompletion: true,
      companionAcquiredDuringResponse: true,
      witness: 'lock-completed',
      nativeInvocationOrder: 1,
      lockCompletionOrder: 2,
      adoptionOrder: null,
      requestCount: 1,
      responseHeldAtProbe: true,
      responseSettledAtProbe: false,
      method: 'GET',
      postDataAbsent: true,
      authorizationAbsent: true,
      idempotencyAbsent: true,
    },
    result: 'pristine',
    refusal: null,
    cleanup: {
      pending: 0,
      sticky: 0,
      routeRemoved: true,
      operationSettled: true,
      forwardingSettled: true,
      observerSettled: true,
      contextClosed: true,
      serverStopped: true,
      rootRemoved: true,
    },
  }
  const original = rank1Encode(pristine)
  const controls = [
    { marker: 'R1_RECEIPT_BYTES', operation: () => rank1ByteLimit(8193) },
    { marker: 'R1_RECEIPT_SCHEMA', operation: () => rank1Encode({ ...pristine, extra: true }) },
    {
      marker: 'R1_RECEIPT_SCHEMA',
      operation: () =>
        rank1Encode(Object.defineProperty(structuredClone(pristine), 'extra', { value: true })),
    },
    {
      marker: 'R1_RECEIPT_ORDER',
      operation: () =>
        rank1Encode({
          ...pristine,
          observations: { ...pristine.observations, nativeInvocationOrder: Infinity },
        }),
    },
  ]
  rank1ByteLimit(8192)
  for (const control of controls) {
    let refused = false
    try {
      control.operation()
    } catch (error) {
      refused = error instanceof Error && error.message === control.marker
    }
    expect(refused, control.marker).toBe(true)
    expect(rank1Encode(structuredClone(pristine)), 'R1_RECEIPT_FRESH_RESTORATION').toBe(original)
  }
  rank1ByteLimit(8192)
  console.log('W03_RANK1_PREFLIGHT_CONTROLS bytes-schema-order-restored')
}

function rank1Compare(observed: Rank1Record['observations']): void {
  expect(
    {
      companionAcquiredBeforeDispatch: observed.companionAcquiredBeforeDispatch,
      nativeBeforeLockCompletion: observed.nativeBeforeLockCompletion,
    },
    'R1_LOCK_TO_NATIVE_INVOCATION'
  ).toEqual({ companionAcquiredBeforeDispatch: false, nativeBeforeLockCompletion: true })
  expect(observed.companionAcquiredDuringResponse, 'R1_LOCK_RELEASED_DURING_RESPONSE').toBe(true)
}

async function runRank1Subject(
  browser: Browser,
  testInfo: TestInfo,
  label: Rank1Label,
  program: string,
  expectedAssets?: Record<string, string>
): Promise<{ record: Rank1Record; hashes: Record<string, string> }> {
  const captured = await withFixture(
    browser,
    testInfo,
    `R1-${label}`,
    'canonical',
    (fixture) => rank1Probe(fixture, program),
    false,
    true
  )
  if (!captured.rank1) throw Error('R1_FINAL_METADATA_ABSENT')
  const { observations, profiles, cleanup } = captured.comparison
  let refused = false
  let original: unknown
  try {
    rank1Compare(observations)
  } catch (error) {
    refused = true
    original = error
  }
  const control = label === 'F1' || label === 'F2'
  if (!control && refused) throw original
  const marker =
    label === 'F1' ? 'R1_LOCK_TO_NATIVE_INVOCATION' : 'R1_LOCK_RELEASED_DURING_RESPONSE'
  if (control) {
    if (!refused) throw Error('R1_CONTROL_NOT_REFUSED')
    if (!(original instanceof Error)) throw original
    try {
      expect(original.message, 'R1_CONTROL_EXACT_MARKER').toContain(marker)
      const assertion = original as Error & {
        matcherResult?: { actual?: unknown; expected?: unknown; name?: string; pass?: boolean }
      }
      expect(assertion.matcherResult, 'R1_CONTROL_EXACT_OPERANDS').toMatchObject(
        label === 'F1'
          ? {
              actual: { companionAcquiredBeforeDispatch: true, nativeBeforeLockCompletion: false },
              expected: {
                companionAcquiredBeforeDispatch: false,
                nativeBeforeLockCompletion: true,
              },
              name: 'toEqual',
              pass: false,
            }
          : { actual: false, expected: true, name: 'toBe', pass: false }
      )
    } catch (error) {
      throw new AggregateError([original, error], 'R1_CONTROL_NONQUALIFIED')
    }
  }
  try {
    if (expectedAssets)
      expect(captured.hashes, 'R1_FOUR_ASSET_RESTORATION_BEFORE_RECEIPT').toEqual(expectedAssets)
    const record: Rank1Record = {
      version: 1,
      label,
      project: testInfo.project.name,
      retry: testInfo.retry,
      worker: testInfo.workerIndex,
      source: {
        spec: digest(
          await readFile(
            new URL('./owner-claim-coordinator.characterization.spec.ts', import.meta.url)
          )
        ),
        fixture: digest(
          await readFile(new URL('./support/ownerClaimCoordinatorFixture.ts', import.meta.url))
        ),
        staticServer: digest(await readFile(STATIC_SCRIPT)),
        lock: digest(await readFile(new URL('../../../../package-lock.json', import.meta.url))),
        canonicalProgram: digest(rank1BrowserProgram('canonical')),
        program: digest(program),
      },
      browser: captured.rank1.browser,
      profiles,
      observations,
      result: control ? 'expected-control-refusal' : 'pristine',
      refusal: control ? marker : null,
      cleanup: {
        pending: captured.rank1.pending,
        sticky: captured.rank1.sticky,
        ...cleanup,
        contextClosed: captured.rank1.contextClosed,
        serverStopped: captured.rank1.serverStopped,
        rootRemoved: captured.rank1.rootRemoved,
      },
    }
    const body = rank1Encode(record)
    expect(
      Buffer.byteLength('W03_RANK1_NATIVE_FETCH ' + body) + 1,
      'R1_WIRE_CAP'
    ).toBeLessThanOrEqual(8216)
    console.log('W03_RANK1_NATIVE_FETCH ' + body)
    return { record, hashes: captured.hashes }
  } catch (error) {
    if (refused) throw new AggregateError([original, error], 'R1_PUBLICATION_NONQUALIFIED')
    throw error
  }
}

test('W03 fencing stale owners and late commands', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  fencingReceiptSelfTests()
  let canonical: Record<string, string> | undefined
  for (const [label, variant] of [
    ['pristine', 'canonical'],
    ['no-grant-revision', 'no-grant-revision'],
    ['after-revision', 'canonical'],
    ['no-owner-binding', 'no-owner-binding'],
    ['after-owner', 'canonical'],
  ] as const) {
    const hashes = await runFencingSubject(browser, testInfo, label, variant, canonical)
    if (canonical === undefined) canonical = hashes
  }
})

type FencingLabel =
  'pristine' | 'no-grant-revision' | 'after-revision' | 'no-owner-binding' | 'after-owner'
type FencingMarker = 'FENCE_OLD_OWNER_NATIVE_FETCH_COUNT' | 'FENCE_LATE_COMMAND_ACCEPTED'
const FENCING_ORG = '11111111-1111-4111-8111-111111111111'
interface FencingRecord {
  version: 1
  label: FencingLabel
  project: string
  retry: number
  worker: number
  org: string
  instance: string
  constructor: {
    url: string
    name: string
    type: 'classic'
    credentials: 'same-origin'
    protocol: 'test-fence-v1'
    ports: { A: 1; B: 2 }
  }
  source: {
    spec: string
    fixture: string
    staticServer: string
    lock: string
    program: string
    canonicalWorker: string
    worker: string
    assets: Record<string, string>
  }
  browser: Rank1FixtureMetadata['browser']
  profiles: NativeProfile[]
  replies: FencingReply[]
  effects: {
    oldInvocations: number
    oldRequests: number
    currentInvocations: number
    currentRequests: number
    totalInvocations: number
    totalRequests: number
    automaticInvocations: number
    automaticRequests: number
    ignoredLateReplies: number
    abandonedContinuations: number
  }
  decision: {
    oldGrantAccepted: boolean
    lateAccepted: boolean
    lateNonce: number
    lateReplySerial: number
    grantReplySerial: number
  }
  finalSnapshot: {
    serial: number
    revision: number
    generation: number
    ownerPort: number | null
    heldCommand: boolean
    heldReply: boolean
  }
  result: 'pristine' | 'expected-control-refusal'
  refusal: FencingMarker | null
  cleanup: {
    pending: number
    abandoned: number
    sticky: number
    rpcTimers: number
    observationsSettled: boolean
    locksSettled: boolean
    responsesDisposed: boolean
    closeAcknowledged: boolean
    portCloseCalls: number
    stateRemoved: boolean
    contextClosed: boolean
    serverStopped: boolean
    rootRemoved: boolean
  }
}

const FENCING_ROLES = [
  [1, 1, 'hello', 'final'],
  [2, 1, 'hello', 'final'],
  [1, 2, 'replace', 'final'],
  [2, 2, 'hello', 'final'],
  [2, 3, 'replace', 'final'],
  [1, 3, 'hello', 'final'],
  [1, 4, 'grant', 'final'],
  [2, 4, 'hello', 'final'],
  [2, 5, 'grant', 'final'],
  [1, 5, 'hello', 'final'],
  [1, 6, 'replace', 'held'],
  [2, 6, 'hello', 'final'],
  [2, 7, 'grant', 'held'],
  [1, 6, 'replace', 'final'],
  [1, 7, 'release', 'final'],
  [2, 7, 'grant', 'final'],
  [1, 8, 'release', 'final'],
  [1, 9, 'hello', 'final'],
  [1, 10, 'close', 'final'],
] as const

function fencingCompare(
  effects: FencingRecord['effects'],
  decision: FencingRecord['decision']
): void {
  expect(effects.oldInvocations, 'FENCE_OLD_OWNER_NATIVE_FETCH_COUNT').toBe(0)
  expect(decision.lateAccepted, 'FENCE_LATE_COMMAND_ACCEPTED').toBe(false)
}

async function fencingProbe(fixture: OwnedFixture, testInfo: TestInfo) {
  const first = await fixture.page()
  const second = await fixture.page()
  const pages = [first, second]
  const profiles: NativeProfile[] = []
  const requests = [0, 0]
  const errors: unknown[] = []
  const operations: Promise<unknown>[] = []
  let primaryFailed = false
  let primary: unknown
  let finalSnapshot: FencingRecord['finalSnapshot'] | undefined
  let closed = false
  let stateRemoved = false
  const url = fixture.origin + '/fixture-icon.svg?rank1-probe=1'
  const observe = (request: Request): void => {
    if (request.url() !== url) return
    try {
      expect(request.method(), 'FENCE_NATIVE_METHOD').toBe('GET')
      expect(request.postData(), 'FENCE_NATIVE_NO_BODY').toBeNull()
      const headers = request.headers()
      expect(headers.authorization, 'FENCE_NATIVE_NO_AUTHORIZATION').toBeUndefined()
      expect(headers['idempotency-key'], 'FENCE_NATIVE_NO_IDEMPOTENCY').toBeUndefined()
      const index = pages.indexOf(request.frame().page())
      expect(index, 'FENCE_NATIVE_OWNED_PAGE').toBeGreaterThanOrEqual(0)
      requests[index]! += 1
    } catch (error) {
      errors.push(error)
    }
  }
  const own = <Value>(operation: Promise<Value>): Promise<Value> => {
    operation.catch(() => {})
    operations.push(operation)
    return deadline(operation, 5000, 'FENCE_HOST_OPERATION_TIMEOUT')
  }
  fixture.context.on('request', observe)
  let states: Awaited<ReturnType<FencingPageClient['finish']>>[] = []
  const partialStates: FencingPageState[] = []
  try {
    for (const page of pages) {
      profiles.push((await page.evaluate(() => window.__koderaNativeCapability.inspect())).profile)
      await own(page.evaluate(fencingBrowserProgram()))
      await own(page.evaluate(() => window.__koderaFencing!.connect()))
    }
    const initial = await Promise.all(
      pages.map((page) => page.evaluate(() => window.__koderaFencing!.inspect()))
    )
    expect(
      initial.map((entry) => entry.port),
      'FENCE_DISTINCT_PORTS'
    ).toEqual([1, 2])
    expect(initial[0]!.instance, 'FENCE_ONE_LIVE_INSTANCE').toBe(initial[1]!.instance)
    expect(
      initial.map((entry) => entry.replies[0]),
      'FENCE_EMPTY_INITIAL_STATE'
    ).toEqual([
      expect.objectContaining({ revision: 0, generation: 0, ownerPort: null }),
      expect.objectContaining({ revision: 0, generation: 0, ownerPort: null }),
    ])
    await own(first.evaluate(() => window.__koderaFencing!.replace(false)))
    await own(second.evaluate(() => window.__koderaFencing!.replace(true)))
    await own(first.evaluate(() => window.__koderaFencing!.grant(false)))
    await own(second.evaluate(() => window.__koderaFencing!.grant(false)))
    await own(first.evaluate(() => window.__koderaFencing!.park()))
    const held = own(second.evaluate(() => window.__koderaFencing!.grant(true)))
    held.catch(() => {})
    await own(second.evaluate(() => window.__koderaFencing!.waitHeld()))
    await own(first.evaluate(() => window.__koderaFencing!.release('late-command')))
    const abandoned = await first.evaluate(() => window.__koderaFencing!.inspect())
    expect(abandoned.ignoredLateReplies, 'FENCE_ACTUAL_ABANDONED_REPLY').toBe(1)
    expect(abandoned.abandoned, 'FENCE_ABANDONED_LEDGER_DRAINED').toBe(0)
    await own(first.evaluate(() => window.__koderaFencing!.release('grant-reply')))
    await held
    const snapshot = await own(first.evaluate(() => window.__koderaFencing!.snapshot()))
    finalSnapshot = {
      serial: snapshot.serial,
      revision: snapshot.revision,
      generation: snapshot.generation,
      ownerPort: snapshot.ownerPort,
      heldCommand: snapshot.heldCommand,
      heldReply: snapshot.heldReply,
    }
    expect([snapshot.heldCommand, snapshot.heldReply], 'FENCE_NO_HELD_WORK').toEqual([false, false])
  } catch (error) {
    primaryFailed = true
    primary = error
  } finally {
    for (const page of pages) {
      try {
        await page.evaluate(() => window.__koderaFencing?.retire())
      } catch (error) {
        errors.push(error)
      }
    }
    if (primaryFailed) {
      for (const slot of ['late-command', 'grant-reply'] as const) {
        try {
          const actual = await Promise.all(
            pages.map((page) => own(page.evaluate(() => window.__koderaFencing?.inspect())))
          )
          const latest = actual
            .flatMap((state) => state?.replies ?? [])
            .sort((left, right) => right.serial - left.serial)[0]
          if (slot === 'late-command' ? latest?.heldCommand : latest?.heldReply) {
            await own(first.evaluate((value) => window.__koderaFencing!.release(value), slot))
          }
        } catch (error) {
          errors.push(error)
        }
      }
    }
    try {
      const outcomes = await deadline(
        Promise.allSettled(operations),
        5000,
        'FENCE_HOST_DRAIN_TIMEOUT'
      )
      expect(
        outcomes.every((entry) => entry.status === 'fulfilled'),
        'FENCE_HOST_DRAINED'
      ).toBe(true)
    } catch (error) {
      errors.push(error)
    }
    for (const page of pages) {
      try {
        partialStates.push(await page.evaluate(() => window.__koderaFencing!.inspect()))
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await own(first.evaluate(() => window.__koderaFencing!.closeWorker()))
      closed = true
    } catch (error) {
      errors.push(error)
    }
    for (const page of pages) {
      try {
        await page.evaluate(() => window.__koderaFencing!.closePort())
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      states = await Promise.all(
        pages.map((page) => own(page.evaluate(() => window.__koderaFencing!.finish())))
      )
    } catch (error) {
      errors.push(error)
    }
    if (closed && states.length === 2) {
      let removed = 0
      for (const page of pages)
        try {
          profiles.push(
            (await page.evaluate(() => window.__koderaNativeCapability.inspect())).profile
          )
          const absent = await page.evaluate(() => {
            delete window.__koderaFencing
            return window.__koderaFencing === undefined
          })
          if (absent) removed += 1
        } catch (error) {
          errors.push(error)
        }
      stateRemoved = removed === 2
    }
    fixture.context.off('request', observe)
  }
  if (primaryFailed || errors.length) {
    try {
      const body = fencingPartialBody(states.length === 2 ? states : partialStates, requests)
      if (body !== undefined)
        await testInfo.attach('FENCE-incomplete', {
          body: Buffer.from(body),
          contentType: 'application/json',
        })
    } catch {
      void 0
    }
  }
  if (primaryFailed) {
    if (errors.length) throw new AggregateError([primary, ...errors], 'FENCE_PRIMARY_AND_CLEANUP')
    throw primary
  }
  if (errors.length) throw new AggregateError(errors, 'FENCE_OBSERVATION_OR_CLEANUP')
  if (!finalSnapshot || states.length !== 2 || !closed || !stateRemoved)
    throw Error('FENCE_INCOMPLETE')
  const [firstState, secondState] = states
  if (!firstState || !secondState) throw Error('FENCE_STATES_ABSENT')
  const replies = states
    .flatMap((state) => state.replies)
    .sort((left, right) => left.serial - right.serial)
  const late = replies.find((reply) => reply.serial === 14)
  const grant = replies.find((reply) => reply.serial === 16)
  const old = replies.find((reply) => reply.serial === 7)
  if (!late || !grant || !old) throw Error('FENCE_ACTUAL_FINAL_REPLIES_ABSENT')
  const effects: FencingRecord['effects'] = {
    oldInvocations: firstState.invocations,
    oldRequests: requests[0]!,
    currentInvocations: secondState.invocations,
    currentRequests: requests[1]!,
    totalInvocations: firstState.invocations + secondState.invocations,
    totalRequests: requests[0]! + requests[1]!,
    automaticInvocations: states.reduce((count, state) => count + state.automaticInvocations, 0),
    automaticRequests:
      requests[0]! + requests[1]! - firstState.invocations - secondState.invocations,
    ignoredLateReplies: firstState.ignoredLateReplies + secondState.ignoredLateReplies,
    abandonedContinuations: firstState.abandonedContinuations + secondState.abandonedContinuations,
  }
  expect(effects.oldRequests, 'FENCE_OLD_INVOCATION_REQUEST_CORRELATION').toBe(
    effects.oldInvocations
  )
  expect(
    [effects.currentInvocations, effects.currentRequests],
    'FENCE_TWO_CURRENT_NATIVE_REQUESTS'
  ).toEqual([2, 2])
  expect(
    [
      effects.automaticInvocations,
      effects.automaticRequests,
      effects.ignoredLateReplies,
      effects.abandonedContinuations,
    ],
    'FENCE_NO_RESURRECTED_CONTINUATION'
  ).toEqual([0, 0, 1, 0])
  const cleanup = {
    pending: states.reduce((count, state) => count + state.pending, 0),
    abandoned: states.reduce((count, state) => count + state.abandoned, 0),
    sticky: states.reduce((count, state) => count + state.errors.length, 0),
    rpcTimers: states.reduce((count, state) => count + state.rpcTimers, 0),
    observationsSettled: true,
    locksSettled: states.every((state) => state.locksSettled),
    responsesDisposed: states.every((state) => state.responsesDisposed),
    closeAcknowledged: firstState.closeAcknowledged,
    portCloseCalls: states.reduce((count, state) => count + state.portCloseCalls, 0),
    stateRemoved,
  }
  expect(cleanup, 'FENCE_ACTUAL_OWNED_CLEANUP').toEqual({
    pending: 0,
    abandoned: 0,
    sticky: 0,
    rpcTimers: 0,
    observationsSettled: true,
    locksSettled: true,
    responsesDisposed: true,
    closeAcknowledged: true,
    portCloseCalls: 2,
    stateRemoved: true,
  })
  return {
    instance: firstState.instance,
    profiles,
    replies,
    effects,
    decision: {
      oldGrantAccepted: old.status === 'granted',
      lateAccepted: late.status === 'replaced',
      lateNonce: late.nonce,
      lateReplySerial: late.serial,
      grantReplySerial: grant.serial,
    },
    finalSnapshot,
    cleanup,
  }
}

async function runFencingSubject(
  browser: Browser,
  testInfo: TestInfo,
  label: FencingLabel,
  variant: FencingVariant,
  canonical?: Record<string, string>
): Promise<Record<string, string>> {
  const captured = await withFixture(
    browser,
    testInfo,
    `FENCE-${label}`,
    'canonical',
    (fixture) => fencingProbe(fixture, testInfo),
    false,
    true,
    variant
  )
  if (!captured.rank1) throw Error('FENCE_FINAL_METADATA_ABSENT')
  const observed = captured.comparison
  let refused = false
  let primary: unknown
  try {
    fencingCompare(observed.effects, observed.decision)
  } catch (error) {
    refused = true
    primary = error
  }
  const control = variant !== 'canonical'
  const marker: FencingMarker =
    variant === 'no-owner-binding'
      ? 'FENCE_OLD_OWNER_NATIVE_FETCH_COUNT'
      : 'FENCE_LATE_COMMAND_ACCEPTED'
  if (!control && refused) throw primary
  if (control) {
    if (!refused) throw Error('FENCE_CONTROL_NOT_REFUSED')
    if (!(primary instanceof Error)) throw primary
    try {
      expect(primary.message, 'FENCE_CONTROL_EXACT_MARKER').toContain(marker)
      const assertion = primary as Error & {
        matcherResult?: { name?: string; pass?: boolean; actual?: unknown; expected?: unknown }
      }
      expect(assertion.matcherResult, 'FENCE_CONTROL_EXACT_MATCHER').toEqual(
        expect.objectContaining({
          name: 'toBe',
          pass: false,
          actual: variant === 'no-owner-binding' ? 1 : true,
          expected: variant === 'no-owner-binding' ? 0 : false,
        })
      )
    } catch (error) {
      throw new AggregateError([primary, error], 'FENCE_CONTROL_NONQUALIFIED')
    }
  }
  try {
    const canonicalAssets = Object.fromEntries(
      Object.entries(fencingFixtureAssets('canonical')).map(([name, body]) => [name, digest(body)])
    )
    if (canonical) expect(canonicalAssets, 'FENCE_CANONICAL_ASSETS_RESTORED').toEqual(canonical)
    if (variant === 'canonical')
      expect(captured.hashes, 'FENCE_FOUR_ACTUAL_ASSETS_RESTORED').toEqual(canonicalAssets)
    for (const name of ASSET_NAMES.filter((name) => name !== 'owner-claim-coordinator.js')) {
      expect(captured.hashes[name], 'FENCE_UNCHANGED_NONWORKER_ASSET').toBe(canonicalAssets[name])
    }
    const record: FencingRecord = {
      version: 1,
      label,
      project: testInfo.project.name,
      retry: testInfo.retry,
      worker: testInfo.workerIndex,
      org: FENCING_ORG,
      instance: observed.instance,
      constructor: {
        url: '/owner-claim-coordinator.js',
        name: CANONICAL_NAME,
        type: 'classic',
        credentials: 'same-origin',
        protocol: 'test-fence-v1',
        ports: { A: 1, B: 2 },
      },
      source: {
        spec: digest(
          await readFile(
            new URL('./owner-claim-coordinator.characterization.spec.ts', import.meta.url)
          )
        ),
        fixture: digest(
          await readFile(new URL('./support/ownerClaimCoordinatorFixture.ts', import.meta.url))
        ),
        staticServer: digest(await readFile(STATIC_SCRIPT)),
        lock: digest(await readFile(new URL('../../../../package-lock.json', import.meta.url))),
        program: digest(fencingBrowserProgram()),
        canonicalWorker: canonicalAssets['owner-claim-coordinator.js']!,
        worker: captured.hashes['owner-claim-coordinator.js']!,
        assets: captured.hashes,
      },
      browser: captured.rank1.browser,
      profiles: observed.profiles,
      replies: observed.replies,
      effects: observed.effects,
      decision: observed.decision,
      finalSnapshot: observed.finalSnapshot,
      result: control ? 'expected-control-refusal' : 'pristine',
      refusal: control ? marker : null,
      cleanup: {
        ...observed.cleanup,
        pending: observed.cleanup.pending + captured.rank1.pending,
        sticky: observed.cleanup.sticky + captured.rank1.sticky,
        contextClosed: captured.rank1.contextClosed,
        serverStopped: captured.rank1.serverStopped,
        rootRemoved: captured.rank1.rootRemoved,
      },
    }
    const body = fencingEncode(record)
    expect(Buffer.byteLength('W03_FENCING ' + body) + 1, 'FENCE_WIRE_CAP').toBeLessThanOrEqual(8205)
    console.log('W03_FENCING ' + body)
    return canonicalAssets
  } catch (error) {
    if (refused) throw new AggregateError([primary, error], 'FENCE_PUBLICATION_NONQUALIFIED')
    throw error
  }
}

function fencingPartialBody(states: FencingPageState[], requests: number[]): string | undefined {
  if (states.length !== 2 || requests.length !== 2) return undefined
  const replies = states
    .flatMap((state) => state.replies)
    .sort((left, right) => left.serial - right.serial)
  if (replies.length > 24) return undefined
  const integer = (value: unknown, minimum: number, maximum: number): boolean =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  for (const reply of replies) {
    if (
      !rank1Object(reply, [
        'serial',
        'port',
        'nonce',
        'op',
        'phase',
        'status',
        'revision',
        'generation',
        'ownerPort',
        'grantRevision',
        'heldCommand',
        'heldReply',
      ]) ||
      !integer(reply.serial, 1, 24) ||
      !integer(reply.port, 1, 2) ||
      !integer(reply.nonce, 1, 16) ||
      !integer(reply.revision, 0, 16) ||
      !integer(reply.generation, 0, 4) ||
      !(reply.ownerPort === null || integer(reply.ownerPort, 1, 2)) ||
      !(reply.grantRevision === null || integer(reply.grantRevision, 0, 16)) ||
      typeof reply.heldCommand !== 'boolean' ||
      typeof reply.heldReply !== 'boolean' ||
      !['hello', 'replace', 'grant', 'release', 'close'].includes(reply.op) ||
      !['held', 'final'].includes(reply.phase) ||
      ![
        'snapshot',
        'replaced',
        'refused',
        'granted',
        'held-command',
        'held-reply',
        'released',
        'closing',
      ].includes(reply.status)
    )
      return undefined
  }
  const counts = {
    oldInvocations: states[0]!.invocations,
    oldRequests: requests[0]!,
    currentInvocations: states[1]!.invocations,
    currentRequests: requests[1]!,
  }
  if (!Object.values(counts).every((value) => integer(value, 0, 3))) return undefined
  const body = JSON.stringify({ incomplete: true, replies, counts })
  return Buffer.byteLength(body) <= 8192 && /^[\x20-\x7e]+$/.test(body) ? body : undefined
}

function fencingExpectedReply(label: FencingLabel, index: number): FencingReply {
  const role = FENCING_ROLES[index]
  if (!role) throw Error('FENCE_RECEIPT_ORDER')
  const serial = index + 1
  const ownerFault = label === 'no-owner-binding'
  const revisionFault = label === 'no-grant-revision'
  const oldRevision = 2 + Number(ownerFault)
  const firstRevision = oldRevision + Number(!revisionFault)
  const heldRevision = firstRevision + Number(!revisionFault)
  const finalRevision = heldRevision + Number(revisionFault)
  const revisions = [
    0,
    0,
    1,
    1,
    2,
    2,
    oldRevision,
    oldRevision,
    firstRevision,
    firstRevision,
    firstRevision,
    firstRevision,
    heldRevision,
    finalRevision,
    finalRevision,
    finalRevision,
    finalRevision,
    finalRevision,
    finalRevision,
  ]
  const generation = serial <= 2 ? 0 : serial <= 4 ? 1 : serial >= 14 && revisionFault ? 3 : 2
  const status: FencingReply['status'] =
    serial === 3 || serial === 5
      ? 'replaced'
      : serial === 7
        ? ownerFault
          ? 'granted'
          : 'refused'
        : serial === 9 || serial === 16
          ? 'granted'
          : serial === 11
            ? 'held-command'
            : serial === 13
              ? 'held-reply'
              : serial === 14
                ? revisionFault
                  ? 'replaced'
                  : 'refused'
                : serial === 15 || serial === 17
                  ? 'released'
                  : serial === 19
                    ? 'closing'
                    : 'snapshot'
  return {
    serial,
    port: role[0],
    nonce: role[1],
    op: role[2],
    phase: role[3],
    status,
    revision: revisions[index]!,
    generation,
    ownerPort: generation === 0 ? null : generation === 1 || generation === 3 ? 1 : 2,
    grantRevision:
      serial === 7 && ownerFault
        ? oldRevision
        : serial === 9
          ? firstRevision
          : serial === 13 || serial === 16
            ? heldRevision
            : null,
    heldCommand: serial >= 11 && serial <= 13,
    heldReply: serial >= 13 && serial <= 15,
  }
}

function fencingShape(value: unknown): asserts value is FencingRecord {
  function schema(): never {
    throw Error('FENCE_RECEIPT_SCHEMA')
  }
  const array = (item: unknown, length: 2 | 4 | 19): boolean => {
    if (!Array.isArray(item) || item.length !== length) return false
    const keys = Reflect.ownKeys(item)
    return (
      keys.length === length + 1 &&
      keys.every((key) => {
        if (
          typeof key !== 'string' ||
          (key !== 'length' &&
            !Array.from({ length }, (_value, index) => String(index)).includes(key))
        )
          return false
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        return (
          descriptor !== undefined &&
          'value' in descriptor &&
          (key === 'length' || descriptor.enumerable === true)
        )
      })
    )
  }
  const integer = (item: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): item is number =>
    typeof item === 'number' && Number.isSafeInteger(item) && item >= minimum && item <= maximum
  const text = (item: unknown, maximum: number): item is string =>
    typeof item === 'string' &&
    item.length > 0 &&
    item.length <= maximum &&
    !/[\r\n]/.test(item) &&
    /^[\x20-\x7e]+$/.test(item)
  const hash = (item: unknown): item is string =>
    typeof item === 'string' && item.length === 64 && /^[a-f0-9]{64}$/.test(item)
  if (
    !rank1Object(value, [
      'version',
      'label',
      'project',
      'retry',
      'worker',
      'org',
      'instance',
      'constructor',
      'source',
      'browser',
      'profiles',
      'replies',
      'effects',
      'decision',
      'finalSnapshot',
      'result',
      'refusal',
      'cleanup',
    ])
  )
    schema()
  const record = value as unknown as FencingRecord
  if (
    record.version !== 1 ||
    ![
      'pristine',
      'no-grant-revision',
      'after-revision',
      'no-owner-binding',
      'after-owner',
    ].includes(record.label) ||
    !['chromium', 'chromium-dark'].includes(record.project) ||
    !integer(record.retry, 0, 2) ||
    !integer(record.worker) ||
    record.org !== FENCING_ORG ||
    typeof record.instance !== 'string' ||
    record.instance.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.instance)
  )
    schema()
  if (
    !rank1Object(record.constructor, ['url', 'name', 'type', 'credentials', 'protocol', 'ports']) ||
    record.constructor.url !== '/owner-claim-coordinator.js' ||
    record.constructor.name !== CANONICAL_NAME ||
    record.constructor.type !== 'classic' ||
    record.constructor.credentials !== 'same-origin' ||
    record.constructor.protocol !== 'test-fence-v1' ||
    !rank1Object(record.constructor.ports, ['A', 'B']) ||
    record.constructor.ports.A !== 1 ||
    record.constructor.ports.B !== 2
  )
    schema()
  if (
    !rank1Object(record.source, [
      'spec',
      'fixture',
      'staticServer',
      'lock',
      'program',
      'canonicalWorker',
      'worker',
      'assets',
    ]) ||
    !['spec', 'fixture', 'staticServer', 'lock', 'program', 'canonicalWorker', 'worker'].every(
      (name) => hash(record.source[name as keyof FencingRecord['source']])
    ) ||
    !rank1Object(record.source.assets, ASSET_NAMES) ||
    !Object.values(record.source.assets).every(hash) ||
    record.source.worker !== record.source.assets['owner-claim-coordinator.js']
  )
    schema()
  const browser = record.browser
  if (
    !rank1Object(browser, [
      'playwright',
      'version',
      'manifest',
      'expected',
      'platform',
      'arch',
      'actualBinaryAttested',
      'projectPreferenceInheritanceAttested',
      'serviceWorkers',
    ]) ||
    browser.playwright !== '1.63.0' ||
    !text(browser.version, 64) ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(browser.version) ||
    !hash(browser.manifest) ||
    !text(browser.platform, 32) ||
    !text(browser.arch, 32) ||
    browser.actualBinaryAttested !== false ||
    browser.projectPreferenceInheritanceAttested !== false ||
    browser.serviceWorkers !== 'block' ||
    !array(browser.expected, 2)
  )
    schema()
  for (const [index, entry] of browser.expected.entries()) {
    if (
      !rank1Object(entry, ['name', 'browserVersion', 'revision']) ||
      entry.name !== ['chromium', 'chromium-headless-shell'][index] ||
      !text(entry.browserVersion, 64) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(entry.browserVersion) ||
      !text(entry.revision, 32) ||
      !/^\d+$/.test(entry.revision)
    )
      schema()
  }
  if (
    !browser.expected.some((entry) => entry.browserVersion === browser.version) ||
    !array(record.profiles, 4)
  )
    schema()
  for (const profile of record.profiles) {
    if (
      !rank1Object(profile, [
        'userAgent',
        'language',
        'colorScheme',
        'timezone',
        'viewport',
        'devicePixelRatio',
        'maxTouchPoints',
        'secureContext',
      ]) ||
      !text(profile.userAgent, 256) ||
      !text(profile.language, 32) ||
      !text(profile.timezone, 64) ||
      !['light', 'dark'].includes(profile.colorScheme) ||
      profile.secureContext !== true ||
      !integer(profile.maxTouchPoints) ||
      typeof profile.devicePixelRatio !== 'number' ||
      !Number.isFinite(profile.devicePixelRatio) ||
      profile.devicePixelRatio <= 0 ||
      !rank1Object(profile.viewport, ['width', 'height']) ||
      !Object.values(profile.viewport).every(
        (item) => typeof item === 'number' && Number.isFinite(item) && item > 0
      )
    )
      schema()
  }
  if (!array(record.replies, 19)) schema()
  for (const [index, reply] of record.replies.entries()) {
    if (
      !rank1Object(reply, [
        'serial',
        'port',
        'nonce',
        'op',
        'phase',
        'status',
        'revision',
        'generation',
        'ownerPort',
        'grantRevision',
        'heldCommand',
        'heldReply',
      ])
    )
      schema()
    const role = FENCING_ROLES[index]!
    if (
      reply.serial !== index + 1 ||
      reply.port !== role[0] ||
      reply.nonce !== role[1] ||
      reply.op !== role[2] ||
      reply.phase !== role[3]
    )
      throw Error('FENCE_RECEIPT_ORDER')
    const expected = fencingExpectedReply(record.label, index)
    if (
      !Object.keys(expected).every(
        (key) => reply[key as keyof FencingReply] === expected[key as keyof FencingReply]
      )
    )
      schema()
  }
  const ownerFault = record.label === 'no-owner-binding'
  const revisionFault = record.label === 'no-grant-revision'
  const effects = record.effects
  if (
    !rank1Object(effects, [
      'oldInvocations',
      'oldRequests',
      'currentInvocations',
      'currentRequests',
      'totalInvocations',
      'totalRequests',
      'automaticInvocations',
      'automaticRequests',
      'ignoredLateReplies',
      'abandonedContinuations',
    ]) ||
    !Object.values(effects).every((item) => integer(item, 0, 3)) ||
    effects.oldInvocations !== Number(ownerFault) ||
    effects.oldRequests !== effects.oldInvocations ||
    effects.currentInvocations !== 2 ||
    effects.currentRequests !== 2 ||
    effects.totalInvocations !== 2 + effects.oldInvocations ||
    effects.totalRequests !== effects.totalInvocations ||
    effects.automaticInvocations !== 0 ||
    effects.automaticRequests !== 0 ||
    effects.ignoredLateReplies !== 1 ||
    effects.abandonedContinuations !== 0
  )
    schema()
  const decision = record.decision
  if (
    !rank1Object(decision, [
      'oldGrantAccepted',
      'lateAccepted',
      'lateNonce',
      'lateReplySerial',
      'grantReplySerial',
    ]) ||
    decision.oldGrantAccepted !== ownerFault ||
    decision.lateAccepted !== revisionFault ||
    decision.lateNonce !== 6 ||
    decision.lateReplySerial !== 14 ||
    decision.grantReplySerial !== 16
  )
    schema()
  const snapshot = record.finalSnapshot
  if (
    !rank1Object(snapshot, [
      'serial',
      'revision',
      'generation',
      'ownerPort',
      'heldCommand',
      'heldReply',
    ]) ||
    !Object.keys(snapshot).every(
      (key) =>
        snapshot[key as keyof typeof snapshot] === record.replies[17]![key as keyof FencingReply]
    )
  )
    schema()
  const control = ownerFault || revisionFault
  if (
    record.result !== (control ? 'expected-control-refusal' : 'pristine') ||
    record.refusal !==
      (ownerFault
        ? 'FENCE_OLD_OWNER_NATIVE_FETCH_COUNT'
        : revisionFault
          ? 'FENCE_LATE_COMMAND_ACCEPTED'
          : null)
  )
    schema()
  const cleanup = record.cleanup
  if (
    !rank1Object(cleanup, [
      'pending',
      'abandoned',
      'sticky',
      'rpcTimers',
      'observationsSettled',
      'locksSettled',
      'responsesDisposed',
      'closeAcknowledged',
      'portCloseCalls',
      'stateRemoved',
      'contextClosed',
      'serverStopped',
      'rootRemoved',
    ]) ||
    !['pending', 'abandoned', 'sticky', 'rpcTimers'].every(
      (key) => cleanup[key as keyof typeof cleanup] === 0
    ) ||
    cleanup.portCloseCalls !== 2 ||
    ![
      'observationsSettled',
      'locksSettled',
      'responsesDisposed',
      'closeAcknowledged',
      'stateRemoved',
      'contextClosed',
      'serverStopped',
      'rootRemoved',
    ].every((key) => cleanup[key as keyof typeof cleanup] === true)
  )
    schema()
}

function fencingByteLimit(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8192) throw Error('FENCE_RECEIPT_BYTES')
}

function fencingEncode(record: unknown): string {
  fencingShape(record)
  const body = JSON.stringify(record)
  fencingByteLimit(Buffer.byteLength(body))
  if (!/^[\x20-\x7e]+$/.test(body)) throw Error('FENCE_RECEIPT_SCHEMA')
  const parsed: unknown = JSON.parse(body)
  fencingShape(parsed)
  if (JSON.stringify(parsed) !== body) throw Error('FENCE_RECEIPT_SCHEMA')
  return body
}

function fencingReceiptSelfTests(): void {
  const hash = 'a'.repeat(64)
  const replies = FENCING_ROLES.map((_role, index) => fencingExpectedReply('pristine', index))
  const profile: NativeProfile = {
    userAgent: 'fixture',
    language: 'fr-FR',
    colorScheme: 'light',
    timezone: 'Europe/Paris',
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 1,
    maxTouchPoints: 0,
    secureContext: true,
  }
  const pristine: FencingRecord = {
    version: 1,
    label: 'pristine',
    project: 'chromium',
    retry: 0,
    worker: 0,
    org: FENCING_ORG,
    instance: '22222222-2222-4222-8222-222222222222',
    constructor: {
      url: '/owner-claim-coordinator.js',
      name: CANONICAL_NAME,
      type: 'classic',
      credentials: 'same-origin',
      protocol: 'test-fence-v1',
      ports: { A: 1, B: 2 },
    },
    source: {
      spec: hash,
      fixture: hash,
      staticServer: hash,
      lock: hash,
      program: hash,
      canonicalWorker: hash,
      worker: hash,
      assets: Object.fromEntries(ASSET_NAMES.map((name) => [name, hash])),
    },
    browser: {
      playwright: '1.63.0',
      version: '153.0.8010.12',
      manifest: hash,
      expected: [
        { name: 'chromium', browserVersion: '153.0.8010.12', revision: '1228' },
        { name: 'chromium-headless-shell', browserVersion: '153.0.8010.12', revision: '1228' },
      ],
      platform: 'linux',
      arch: 'x64',
      actualBinaryAttested: false,
      projectPreferenceInheritanceAttested: false,
      serviceWorkers: 'block',
    },
    profiles: Array.from({ length: 4 }, () => structuredClone(profile)),
    replies,
    effects: {
      oldInvocations: 0,
      oldRequests: 0,
      currentInvocations: 2,
      currentRequests: 2,
      totalInvocations: 2,
      totalRequests: 2,
      automaticInvocations: 0,
      automaticRequests: 0,
      ignoredLateReplies: 1,
      abandonedContinuations: 0,
    },
    decision: {
      oldGrantAccepted: false,
      lateAccepted: false,
      lateNonce: 6,
      lateReplySerial: 14,
      grantReplySerial: 16,
    },
    finalSnapshot: {
      serial: 18,
      revision: 4,
      generation: 2,
      ownerPort: 2,
      heldCommand: false,
      heldReply: false,
    },
    result: 'pristine',
    refusal: null,
    cleanup: {
      pending: 0,
      abandoned: 0,
      sticky: 0,
      rpcTimers: 0,
      observationsSettled: true,
      locksSettled: true,
      responsesDisposed: true,
      closeAcknowledged: true,
      portCloseCalls: 2,
      stateRemoved: true,
      contextClosed: true,
      serverStopped: true,
      rootRemoved: true,
    },
  }
  const original = fencingEncode(pristine)
  const duplicate = structuredClone(pristine)
  duplicate.replies[1]!.serial = 1
  const newline = structuredClone(pristine)
  newline.profiles[0]!.language = 'fr-FR\n'
  const hashNewline = structuredClone(pristine)
  hashNewline.source.spec += '\n'
  const instanceNewline = structuredClone(pristine)
  instanceNewline.instance += '\n'
  const arrayExtra = structuredClone(pristine)
  Object.assign(arrayExtra.browser.expected, { extra: true })
  const arrayNonenumerable = structuredClone(pristine)
  Object.defineProperty(arrayNonenumerable.profiles, 'extra', { value: true })
  const arraySymbol = structuredClone(pristine)
  Object.defineProperty(arraySymbol.replies, Symbol('fixture'), { value: true })
  const arrayGetter = structuredClone(pristine)
  let getterExecuted = false
  Object.defineProperty(arrayGetter.profiles, '0', {
    get: () => {
      getterExecuted = true
      return profile
    },
    enumerable: true,
  })
  const controls = [
    { marker: 'FENCE_RECEIPT_BYTES', operation: () => fencingByteLimit(8193) },
    {
      marker: 'FENCE_RECEIPT_SCHEMA',
      operation: () => fencingEncode({ ...pristine, extra: true }),
    },
    {
      marker: 'FENCE_RECEIPT_SCHEMA',
      operation: () =>
        fencingEncode(Object.defineProperty(structuredClone(pristine), 'extra', { value: true })),
    },
    { marker: 'FENCE_RECEIPT_ORDER', operation: () => fencingEncode(duplicate) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(newline) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(hashNewline) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(instanceNewline) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(arrayExtra) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(arrayNonenumerable) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(arraySymbol) },
    { marker: 'FENCE_RECEIPT_SCHEMA', operation: () => fencingEncode(arrayGetter) },
  ]
  fencingByteLimit(8192)
  for (const control of controls) {
    let refused = false
    try {
      control.operation()
    } catch (error) {
      refused = true
      expect(error, 'FENCE_GUARD_ERROR_IDENTITY').toBeInstanceOf(Error)
      expect((error as Error).message, 'FENCE_GUARD_EXACT_REFUSAL').toBe(control.marker)
    }
    expect(refused, 'FENCE_GUARD_MUST_REFUSE').toBe(true)
    expect(getterExecuted, 'FENCE_ARRAY_GETTER_NEVER_EXECUTED').toBe(false)
    expect(fencingEncode(structuredClone(pristine)), 'FENCE_GUARD_FRESH_RESTORATION').toBe(original)
  }
  fencingByteLimit(8192)
  console.log('W03_FENCING_GUARDS byte-schema-order-refusals-restored')
}

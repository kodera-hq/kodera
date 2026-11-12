// The theme choice (docs/specs/10-appearance.md §12) in a real browser: the theme is on the page
// before the real main response is released, follows the device only while « Automatique » is chosen, is chosen from
// the Apparence page by pointer or keyboard, and survives a reload unless the browser refuses to
// store it; in dark and black the inverse cards keep an edge. Every test here fails on a console
// without `public/theme.js` and the page: nothing sets `data-theme`, and `/{org}/appearance` does
// not exist.

/// <reference lib="dom" />

import { createHash } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Request, type Response, type Route } from '@playwright/test'
import { signIn } from './support/signIn'
import { mainArtifact, readBootstrapEntry } from './support/mainArtifact'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'
const KEY = 'console:theme'
const SCENARIOS = ['shell.single-organisation', 'home.default'] as const
/** The theme « Automatique » paints on each device: Ciel, the default, in its light or dark mode. */
const DEVICE_THEME = { light: 'ciel', dark: 'ciel-nuit' } as const

function html(page: Page) {
  return page.locator('html')
}

function card(page: Page, name: string) {
  return page.getByRole('radiogroup', { name: 'Thème' }).getByRole('radio', { name, exact: true })
}

/**
 * Reloads a signed-in page: the session comes back through the mock identity provider's silent
 * round trip in a hidden frame, which a person never sees and a test answers itself
 * (`tests/e2e/oidc-reload.spec.ts`). The theme is applied before that, by `public/theme.js`.
 */
async function reloadSignedIn(page: Page): Promise<void> {
  await page.reload()
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  const frame = page
    .frames()
    .filter((candidate) => candidate.url().includes('prompt=none'))
    .at(-1)!
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apparence')
}

/**
 * `→` held until the roving focus lands, as a person's key is: Radix moves the focus on a
 * timeout and chooses the card it lands on only while the key is still down
 * (`tests/e2e/01-order.spec.ts`, the plan cards).
 */
async function arrowTo(page: Page, name: string): Promise<void> {
  await page.keyboard.down('ArrowRight')
  await expect(card(page, name)).toBeFocused()
  await page.keyboard.up('ArrowRight')
}

/** Signs in straight to the page. The caller activates `SCENARIOS` first: the hooks lint rule
 * refuses a `use*` call inside a named helper. */
async function openAppearance(page: Page): Promise<void> {
  await signIn(page, ORG, '/appearance')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apparence')
}

test('appearance/boot: applies the selected theme before the real main response, from the choice or the device', async ({
  page,
}, testInfo) => {
  function observationBody(report: string): Buffer {
    if (Buffer.byteLength(report) > 65_536) throw Error('APPEARANCE_OBSERVATION_BYTE_CAP')
    return Buffer.from(report)
  }
  // Finite UTF8 cap controls call the same function used by the report attachment.
  const asciiReport = 'a'.repeat(65_536)
  const asciiBody = observationBody(asciiReport)
  expect(asciiBody.length).toBe(65_536)
  expect(asciiBody.toString('utf8')).toBe(asciiReport)
  const multibyteReport = 'é'.repeat(32_768)
  const multibyteBody = observationBody(multibyteReport)
  expect(multibyteBody.length).toBe(65_536)
  expect(multibyteBody.toString('utf8')).toBe(multibyteReport)
  expect(() => observationBody(multibyteReport + 'a')).toThrow(/^APPEARANCE_OBSERVATION_BYTE_CAP$/)
  const context = page.context()
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw Error('APPEARANCE_BASE_URL_ABSENT')
  const origin = new URL(baseURL).origin
  const distDirectory = new URL('../../dist/', import.meta.url)
  const entry = await readBootstrapEntry(distDirectory)
  const artifact = await mainArtifact({ distDirectory, entry, origin, testInfo })
  // Expected static bytes bound the comparison; response.body() itself is not streaming-capped.
  expect(artifact.mainByteLength, 'APPEARANCE_MAIN_SOURCE_BYTE_BUDGET').toBeLessThanOrEqual(
    8 * 1024 * 1024
  )
  const mainURL = origin + artifact.path
  const matchesMain = (url: string) => new URL(url).pathname === artifact.path
  type RouteRecord = {
    route: Route
    owner: string | null
    type: string
    url: string
    method: string
    done: boolean
    continued: boolean
    cleanupAborted: boolean
  }
  type Phase = {
    name: 'dark' | 'light' | 'black'
    requests: Request[]
    responses: Response[]
    finished: Request[]
    routes: RouteRecord[]
    failures: unknown[]
    release: Promise<void>
    releaseNow: () => void
    released: boolean
    continueNetwork: boolean
    navigationSettled: boolean
    complete: boolean
  }
  const phases: Phase[] = []
  const outsidePhaseFailures: unknown[] = []
  const observations: unknown[] = []
  let active: Phase | undefined
  let routeAttempted = false
  let pendingHandlers = 0
  let primary: unknown
  let primaryFailed = false
  const cleanupFailures: unknown[] = []
  const reportedTransportFailures = new Set<unknown>()
  const failPhase = (phase: Phase): void => {
    if (phase.failures.length > 0) {
      for (const failure of phase.failures) reportedTransportFailures.add(failure)
      throw new AggregateError(phase.failures, 'APPEARANCE_MAIN_TRANSPORT_FAILURE_' + phase.name)
    }
  }
  const onRequest = (request: Request): void => {
    if (!matchesMain(request.url())) return
    if (active === undefined) {
      outsidePhaseFailures.push(Error('APPEARANCE_MAIN_REQUEST_OUTSIDE_PHASE'))
      return
    }
    active.requests.push(request)
  }
  const onResponse = (response: Response): void => {
    if (!matchesMain(response.url())) return
    if (active === undefined) {
      outsidePhaseFailures.push(Error('APPEARANCE_MAIN_RESPONSE_OUTSIDE_PHASE'))
      return
    }
    active.responses.push(response)
  }
  const onFinished = (request: Request): void => {
    if (!matchesMain(request.url())) return
    if (active === undefined) {
      outsidePhaseFailures.push(Error('APPEARANCE_MAIN_FINISH_OUTSIDE_PHASE'))
      return
    }
    active.finished.push(request)
  }
  const onFailed = (request: Request): void => {
    if (!matchesMain(request.url())) return
    // An owned cleanup abort is preserved as cleanup, never as a successful main response.
    if (active !== undefined && !active.continueNetwork && active.released) return
    const failure = Error(
      'APPEARANCE_MAIN_REQUEST_FAILED: ' + (request.failure()?.errorText ?? 'unknown')
    )
    if (active === undefined) outsidePhaseFailures.push(failure)
    else active.failures.push(failure)
  }
  const routePredicate = (url: URL): boolean => url.href === mainURL
  const onRoute = async (route: Route, request: Request): Promise<void> => {
    pendingHandlers += 1
    const phase = active
    let record: RouteRecord | undefined
    try {
      if (phase === undefined) {
        outsidePhaseFailures.push(Error('APPEARANCE_MAIN_ROUTE_OUTSIDE_PHASE'))
        await route.abort()
        return
      }
      record = {
        route,
        owner: request.serviceWorker()?.url() ?? null,
        type: request.resourceType(),
        url: request.url(),
        method: request.method(),
        done: false,
        continued: false,
        cleanupAborted: false,
      }
      phase.routes.push(record)
      if (phase.routes.length !== 1) {
        phase.failures.push(Error('APPEARANCE_DUPLICATE_MAIN_ROUTE_' + phase.name))
        record.cleanupAborted = true
        await route.abort()
        return
      }
      await phase.release
      if (phase.continueNetwork) {
        record.continued = true
        await route.continue()
      } else {
        record.cleanupAborted = true
        await route.abort()
      }
    } catch (error) {
      const errors = phase?.failures ?? outsidePhaseFailures
      errors.push(error)
      if (record === undefined || (!record.continued && !record.cleanupAborted)) {
        try {
          await route.abort()
        } catch (cleanup) {
          errors.push(cleanup)
        }
      }
    } finally {
      if (record !== undefined) record.done = true
      pendingHandlers -= 1
    }
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfinished', onFinished)
  page.on('requestfailed', onFailed)
  try {
    expect(
      process.env.PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK,
      'SERVICE_WORKER_NETWORK_INSPECTION_DISABLED'
    ).toBeUndefined()
    routeAttempted = true
    await context.route(routePredicate, onRoute)
    for (const name of ['dark', 'light', 'black'] as const) {
      if (name === 'black')
        await page.evaluate((key) => window.localStorage.setItem(key, 'black'), KEY)
      await page.emulateMedia({ colorScheme: name === 'light' ? 'light' : 'dark' })
      let releaseNow: () => void = () => undefined
      const release = new Promise<void>((resolve) => {
        releaseNow = resolve
      })
      const phase: Phase = {
        name,
        requests: [],
        responses: [],
        finished: [],
        routes: [],
        failures: [],
        release,
        releaseNow,
        released: false,
        continueNetwork: false,
        navigationSettled: false,
        complete: false,
      }
      phases.push(phase)
      active = phase
      // The document load event may precede main. The route, not navigation completion, is the gate.
      const navigation = name === 'dark' ? page.goto('/login') : page.reload()
      void navigation.then(
        () => {
          phase.navigationSettled = true
        },
        (error: unknown) => {
          phase.failures.push(error)
          phase.navigationSettled = true
        }
      )
      // Event-ledger waits only: never wait for a correct theme after releasing main.
      await expect.poll(() => phase.routes.length > 0 || phase.failures.length > 0).toBe(true)
      failPhase(phase)
      await expect.poll(() => phase.requests.length > 0 || phase.failures.length > 0).toBe(true)
      failPhase(phase)
      expect(phase.routes, 'ONE_REAL_MAIN_NETWORK_GATE_' + name).toHaveLength(1)
      expect(
        phase.requests.map((request) => ({
          url: request.url(),
          method: request.method(),
          type: request.resourceType(),
        })),
        'ONE_PAGE_MAIN_SCRIPT_' + name
      ).toEqual([{ url: mainURL, method: 'GET', type: 'script' }])
      const routeRecord = phase.routes[0]
      if (routeRecord === undefined) throw Error('APPEARANCE_MAIN_GATE_ABSENT')
      expect({ url: routeRecord.url, method: routeRecord.method }).toEqual({
        url: mainURL,
        method: 'GET',
      })
      expect(phase.released, 'MAIN_GATE_RELEASED_BEFORE_THEME_' + name).toBe(false)
      expect(phase.responses, 'MAIN_RESPONSE_BEFORE_THEME_' + name).toHaveLength(0)
      expect(phase.finished, 'MAIN_FINISHED_BEFORE_THEME_' + name).toHaveLength(0)
      const snapshot = await page.evaluate(async (key) => {
        // Capture the theme immediately, before awaiting optional worker observations.
        const theme = document.documentElement.dataset.theme ?? null
        const storedChoice = localStorage.getItem(key)
        const controller = navigator.serviceWorker.controller?.scriptURL ?? null
        const registrations = await navigator.serviceWorker.getRegistrations()
        return {
          theme,
          storedChoice,
          controller,
          registrations: registrations.map((registration) => ({
            scope: registration.scope,
            active: registration.active?.scriptURL ?? null,
            state: registration.active?.state ?? null,
          })),
        }
      }, KEY)
      observations.push({
        phase: name,
        snapshot,
        transportOwner: routeRecord.owner,
        transportType: routeRecord.type,
      })
      expect(snapshot.storedChoice, 'THEME_SOURCE_CHOICE_' + name).toBe(
        name === 'black' ? 'black' : null
      )
      expect(snapshot.theme, 'THEME_BEFORE_REAL_MAIN_' + name.toUpperCase()).toBe(
        name === 'black' ? 'black' : DEVICE_THEME[name]
      )
      expect(phase.released).toBe(false)
      expect(phase.responses).toHaveLength(0)
      expect(phase.finished).toHaveLength(0)
      phase.continueNetwork = true
      phase.released = true
      phase.releaseNow()
      await expect.poll(() => phase.navigationSettled || phase.failures.length > 0).toBe(true)
      failPhase(phase)
      await expect.poll(() => phase.finished.length > 0 || phase.failures.length > 0).toBe(true)
      failPhase(phase)
      expect(phase.routes, 'ONE_COMPLETED_MAIN_GATE_' + name).toHaveLength(1)
      expect(phase.responses, 'ONE_REAL_MAIN_RESPONSE_' + name).toHaveLength(1)
      expect(phase.finished, 'ONE_REAL_MAIN_FINISH_' + name).toHaveLength(1)
      const response = phase.responses[0]
      if (response === undefined) throw Error('APPEARANCE_REAL_MAIN_RESPONSE_ABSENT')
      expect(response.url()).toBe(mainURL)
      expect(response.request()).toBe(phase.requests[0])
      expect(response.status(), 'REAL_MAIN_RESPONSE_STATUS_' + name).toBe(200)
      const bytes = await response.body()
      expect(bytes.byteLength, 'REAL_MAIN_RESPONSE_BYTES_' + name).toBe(artifact.mainByteLength)
      expect(
        createHash('sha256').update(bytes).digest('hex'),
        'REAL_MAIN_RESPONSE_HASH_' + name
      ).toBe(artifact.mainSha256)
      expect(routeRecord.continued).toBe(true)
      expect(routeRecord.cleanupAborted).toBe(false)
      await expect(
        page.getByRole('heading', { name: 'Se connecter à votre console' })
      ).toBeVisible()
      const resources = await page.evaluate(
        ({ themeURL, mainURL }) => {
          const timing = (url: string) =>
            performance.getEntriesByName(url, 'resource').map((item) => {
              if (!(item instanceof PerformanceResourceTiming))
                throw Error('RESOURCE_TIMING_ENTRY_TYPE')
              return {
                start: item.startTime,
                end: item.responseEnd,
                initiatorType: item.initiatorType,
              }
            })
          return { theme: timing(themeURL), main: timing(mainURL) }
        },
        { themeURL: origin + '/theme.js', mainURL }
      )
      expect(resources.theme, 'ONE_COMPLETED_THEME_RESOURCE_' + name).toHaveLength(1)
      expect(resources.main, 'ONE_COMPLETED_MAIN_RESOURCE_' + name).toHaveLength(1)
      const themeTiming = resources.theme[0]
      const mainTiming = resources.main[0]
      if (themeTiming === undefined || mainTiming === undefined)
        throw Error('APPEARANCE_RESOURCE_TIMING_ABSENT')
      expect(themeTiming.end, 'THEME_RESOURCE_NOT_COMPLETED_' + name).toBeGreaterThan(0)
      expect(mainTiming.end, 'MAIN_RESOURCE_NOT_COMPLETED_' + name).toBeGreaterThan(0)
      expect(themeTiming.end, 'THEME_LOAD_BEFORE_MAIN_REQUEST_' + name).toBeLessThanOrEqual(
        mainTiming.start
      )
      observations.push({
        phase: name,
        responseFromWorker: response.fromServiceWorker(),
        resources,
      })
      // These are observed facts, not a requirement that MSW retains a controller across unload.
      observations.push(
        await page.evaluate(() => ({
          controllerAfterApp: navigator.serviceWorker.controller?.scriptURL ?? null,
        }))
      )
      await expect.poll(() => phase.routes.every((record) => record.done)).toBe(true)
      failPhase(phase)
      expect(phase.requests).toHaveLength(1)
      expect(outsidePhaseFailures).toEqual([])
      phase.complete = true
      active = undefined
    }
  } catch (error) {
    primary = error
    primaryFailed = true
  } finally {
    for (const phase of phases) {
      if (!phase.released) {
        phase.continueNetwork = false
        phase.released = true
        phase.releaseNow()
      }
    }
    try {
      await expect
        .poll(
          () =>
            pendingHandlers === 0 &&
            phases.every((phase) => phase.routes.every((record) => record.done))
        )
        .toBe(true)
    } catch (error) {
      cleanupFailures.push(error)
    }
    if (routeAttempted) {
      try {
        await context.unroute(routePredicate, onRoute)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      await expect.poll(() => pendingHandlers === 0).toBe(true)
    } catch (error) {
      cleanupFailures.push(error)
    }
    try {
      await expect.poll(() => phases.every((phase) => phase.navigationSettled)).toBe(true)
    } catch (error) {
      cleanupFailures.push(error)
    }
    page.off('request', onRequest)
    page.off('response', onResponse)
    page.off('requestfinished', onFinished)
    page.off('requestfailed', onFailed)
    try {
      const report = JSON.stringify({
        observations,
        phases: phases.map((phase) => ({
          name: phase.name,
          pageRequests: phase.requests.length,
          routes: phase.routes.map((record) => ({
            url: record.url,
            method: record.method,
            owner: record.owner,
            type: record.type,
            continued: record.continued,
            cleanupAborted: record.cleanupAborted,
            done: record.done,
          })),
          responses: phase.responses.length,
          finishes: phase.finished.length,
          complete: phase.complete,
          failures: phase.failures.map((error) =>
            error instanceof Error ? error.message.slice(0, 256) : typeof error
          ),
        })),
      })
      await testInfo.attach('appearance-before-real-main', {
        body: observationBody(report),
        contentType: 'application/json',
      })
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  // Callback failures arriving after the primary observation remain distinct from cleanup errors.
  const lateTransportFailures = [
    ...phases.flatMap((phase) => phase.failures),
    ...outsidePhaseFailures,
  ].filter((error) => !reportedTransportFailures.has(error))
  if (primaryFailed && (lateTransportFailures.length > 0 || cleanupFailures.length > 0))
    throw new AggregateError(
      [primary, ...lateTransportFailures, ...cleanupFailures],
      'APPEARANCE_PRIMARY_TRANSPORT_AND_CLEANUP'
    )
  if (primaryFailed) throw primary
  if (lateTransportFailures.length > 0 || cleanupFailures.length > 0)
    throw new AggregateError(
      [...lateTransportFailures, ...cleanupFailures],
      'APPEARANCE_TRANSPORT_AND_CLEANUP_FAILED'
    )
})

test('appearance/suite: draws the console in the theme its project’s device asks for', async ({
  page,
}, testInfo) => {
  // `playwright.config.ts` runs the suite on a light device and on a dark one. Without this, a
  // project that lost its colour scheme would repeat the light checks and still read as dark.
  const scheme = testInfo.project.use.colorScheme
  expect(['light', 'dark'], `the ${testInfo.project.name} project's colour scheme`).toContain(
    scheme
  )
  // Both devices are declared. Whether both RUN is `tests/unit/e2e-projects.test.ts`'s to prove:
  // a project filtered out on the command line is still listed here.
  // The `journey` project is set aside: it runs `tests/e2e/journey/` on its own build, light only.
  expect(
    testInfo.config.projects
      .filter((project) => project.name !== 'journey')
      .map((project) => project.use.colorScheme)
      .sort(),
    'the suite declares one light and one dark device'
  ).toEqual(['dark', 'light'])
  await page.goto('/login')
  await expect(html(page)).toHaveAttribute('data-theme', DEVICE_THEME[scheme as 'light' | 'dark'])
})

test('appearance/page: follows the device only while Automatique is chosen', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await useScenario(page, SCENARIOS)
  await openAppearance(page)
  await expect(card(page, 'Automatique')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel-nuit')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel')

  await card(page, 'Sombre').click()
  await expect(card(page, 'Sombre')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'dark')
  // Chosen: the device no longer moves the page.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).toHaveAttribute('data-theme', 'dark')

  await card(page, 'Automatique').click()
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel-nuit')
})

test('appearance/page: reads an unknown stored theme as Automatique', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await useScenario(page, SCENARIOS)
  await openAppearance(page)
  await page.evaluate((key) => window.localStorage.setItem(key, 'sepia'), KEY)
  await reloadSignedIn(page)
  await expect(card(page, 'Automatique')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel-nuit')
})

test('appearance/page: chooses a theme with the keyboard alone and keeps it after a reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await useScenario(page, SCENARIOS)
  await openAppearance(page)

  // `Tab` reaches the group once, on the chosen card.
  const focusedRadio = page.locator('[role="radio"]:focus')
  for (let press = 0; press < 40 && (await focusedRadio.count()) === 0; press += 1) {
    await page.keyboard.press('Tab')
  }
  await expect(card(page, 'Automatique')).toBeFocused()
  // Visible focus: the ring is drawn, not only the browser's default outline removed.
  await expect(card(page, 'Automatique')).not.toHaveCSS('box-shadow', 'none')

  await arrowTo(page, 'Ciel')
  await expect(card(page, 'Ciel')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel')
  await arrowTo(page, 'Ciel nuit')
  await expect(card(page, 'Ciel nuit')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel-nuit')
  await arrowTo(page, 'Clair')
  await expect(card(page, 'Clair')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'light')
  await arrowTo(page, 'Sombre')
  await expect(card(page, 'Sombre')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'dark')
  await arrowTo(page, 'Noir')
  await expect(card(page, 'Noir')).toHaveAttribute('aria-checked', 'true')
  await expect(html(page)).toHaveAttribute('data-theme', 'black')
  // One stop: the next `Tab` leaves the group.
  await page.keyboard.press('Tab')
  await expect(focusedRadio).toHaveCount(0)

  await reloadSignedIn(page)
  await expect(html(page)).toHaveAttribute('data-theme', 'black')
  await expect(card(page, 'Noir')).toHaveAttribute('aria-checked', 'true')
})

test('appearance/page: says the choice is not kept when the browser refuses to store it', async ({
  page,
}) => {
  // The browser refuses this key only; the session and the mock API keep their own storage.
  await page.addInitScript((key) => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      setItem.call(this, name, value)
    }
  }, KEY)
  await page.emulateMedia({ colorScheme: 'light' })
  await useScenario(page, SCENARIOS)
  await openAppearance(page)
  await expect(page.getByRole('status').filter({ hasText: 'pas enregistré' })).toHaveCount(0)

  // A theme switch must not render intermediate card surfaces under the new text colours:
  // the old background transition briefly made the Noir hint only 2.49:1 against a grey card.
  await page.evaluate(() => {
    const record = window as typeof window & {
      blackCardFrames?: { background: string; surface: string }[]
    }
    record.blackCardFrames = []
    const blackCard = document.querySelector<HTMLElement>('[role="radio"][value="black"]')!
    const surfaceProbe = document.createElement('span')
    surfaceProbe.style.color = 'var(--c-surface)'
    document.body.append(surfaceProbe)
    function sample() {
      if (document.documentElement.dataset.theme === 'black') {
        record.blackCardFrames!.push({
          background: getComputedStyle(blackCard).backgroundColor,
          surface: getComputedStyle(surfaceProbe).color,
        })
        if (record.blackCardFrames!.length === 3) {
          surfaceProbe.remove()
          return
        }
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await card(page, 'Noir').click()
  // Applied to this page all the same, and the cause and the next step are said.
  await expect(html(page)).toHaveAttribute('data-theme', 'black')
  await expect(card(page, 'Noir')).toHaveAttribute('aria-checked', 'true')
  const warning = page.getByRole('status').filter({ hasText: 'pas enregistré' })
  await expect(warning).toHaveText(
    /Ce navigateur n’a pas enregistré votre choix.*autorisez ce site à enregistrer des données/
  )
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.waitForFunction(
    () =>
      (window as typeof window & { blackCardFrames?: { background: string; surface: string }[] })
        .blackCardFrames?.length === 3
  )
  const frames = await page.evaluate(
    () =>
      (window as typeof window & { blackCardFrames?: { background: string; surface: string }[] })
        .blackCardFrames
  )
  expect(frames).toHaveLength(3)
  for (const frame of frames!) expect(frame.background).toBe(frame.surface)

  // Nothing was kept: the next load follows the device again.
  await reloadSignedIn(page)
  await expect(html(page)).toHaveAttribute('data-theme', 'ciel')
  await expect(card(page, 'Automatique')).toHaveAttribute('aria-checked', 'true')
})

test('appearance/page: passes axe in every theme', async ({ page }) => {
  await useScenario(page, SCENARIOS)
  await openAppearance(page)
  for (const [theme, scheme, label] of [
    ['ciel', 'normal', 'Ciel'],
    ['ciel-nuit', 'dark', 'Ciel nuit'],
    ['light', 'normal', 'Clair'],
    ['dark', 'dark', 'Sombre'],
    ['black', 'dark', 'Noir'],
  ] as const) {
    await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
      key: KEY,
      value: theme,
    })
    await reloadSignedIn(page)
    await expect(html(page)).toHaveAttribute('data-theme', theme)
    // The browser's own parts — scrollbars, native controls — follow the theme.
    await expect(html(page), `color-scheme in the ${theme} theme`).toHaveCSS('color-scheme', scheme)
    // Checked with the chosen card focused from the keyboard, so its ring is drawn and judged.
    const focusedRadio = page.locator('[role="radio"]:focus')
    for (let press = 0; press < 40 && (await focusedRadio.count()) === 0; press += 1) {
      await page.keyboard.press('Tab')
    }
    await expect(card(page, label)).toBeFocused()
    await expect(card(page, label), `the focus ring in the ${theme} theme`).not.toHaveCSS(
      'box-shadow',
      'none'
    )
    const { violations } = await new AxeBuilder({ page }).analyze()
    expect(violations, `axe in the ${theme} theme`).toEqual([])
  }
})

test('appearance/entry: opens from the account menu on a desktop and from Plus on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useScenario(page, SCENARIOS)
  await signIn(page, ORG)
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('button', { name: /Julie Marchand/ })
    .click()
  await page.getByRole('menuitem', { name: 'Apparence' }).click()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/appearance$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apparence')

  await page.setViewportSize({ width: 390, height: 780 })
  const tabs = page.getByRole('navigation', { name: 'Navigation par onglets' })
  await tabs.getByRole('link', { name: 'Accueil' }).click()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`))
  await tabs.getByRole('button', { name: 'Plus' }).click()
  const sheet = page.getByRole('dialog', { name: 'Plus' })
  // Beside « Sécurité et connexion », the other account place.
  await expect(sheet.getByRole('link')).toHaveText([
    'Personnes',
    'Domaine & identité',
    'Sécurité et connexion',
    'Apparence',
  ])
  await sheet.getByRole('link', { name: 'Apparence' }).click()
  await expect(page).toHaveURL(new RegExp(`/${ORG}/appearance$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apparence')
  await expect(tabs.getByRole('button', { name: 'Plus' })).toHaveAttribute('aria-current', 'true')
})

test('appearance/themes: outlines the inverse cards in dark and black, and not in light', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await useScenario(page, SCENARIOS)
  await openAppearance(page)
  const nav = page.getByRole('navigation', { name: 'Navigation principale' })
  // Each card is the `Card` around the `CardBody` holding its title.
  const inverseCards = {
    contract: page.getByText('Votre contrat', { exact: true }).locator('xpath=../..'),
    support: page.getByText(/^Nous vous répondons sous \d+ heures ouvrées$/).locator('xpath=../..'),
  }

  for (const [label, theme, edged] of [
    ['Clair', 'light', false],
    ['Sombre', 'dark', true],
    ['Noir', 'black', true],
  ] as const) {
    await card(page, label).click()
    await expect(html(page)).toHaveAttribute('data-theme', theme)
    await nav.getByRole('link', { name: 'Accueil', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/${ORG}/home$`))

    for (const [name, inverseCard] of Object.entries(inverseCards)) {
      await expect(inverseCard).toBeVisible()
      const edge = await inverseCard.evaluate((element) => {
        // The theme's own `c-border`, resolved by the browser the same way the edge is.
        const probe = document.createElement('div')
        probe.style.color = 'var(--c-border)'
        element.append(probe)
        const border = getComputedStyle(probe).color
        probe.remove()
        const style = getComputedStyle(element)
        const sides = ['top', 'right', 'bottom', 'left']
        return {
          widths: sides.map((side) => style.getPropertyValue(`border-${side}-width`)),
          styles: sides.map((side) => style.getPropertyValue(`border-${side}-style`)),
          colours: sides.map((side) => style.getPropertyValue(`border-${side}-color`)),
          border,
        }
      })
      if (edged) {
        expect(edge.widths, `the ${name} card's edge in the ${theme} theme`).toEqual(
          Array(4).fill('1px')
        )
        expect(edge.styles, `the ${name} card's edge style in the ${theme} theme`).toEqual(
          Array(4).fill('solid')
        )
        expect(edge.colours, `the ${name} card's edge colour in the ${theme} theme`).toEqual(
          Array(4).fill(edge.border)
        )
      } else {
        // Light draws no edge at all: not even one in the ground's colour, which would move
        // every light baseline by a pixel.
        expect(edge.widths, `the ${name} card has no edge in the ${theme} theme`).toEqual(
          Array(4).fill('0px')
        )
      }
    }

    await page.goBack()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apparence')
  }
})

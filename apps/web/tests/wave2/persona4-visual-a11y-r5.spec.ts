import { expect, test } from '@playwright/test'
import { Actor, gateWorld, readWave2Input, targets } from './world'
import { selectInterfaceLanguage } from './language'
import { finishCleanup } from './cleanup'
import { NetworkLedger, recordNetwork } from './oracles/r1-network'
import { RateBudget } from './oracles/r3-rate-budget'
import {
  ConsentLedger,
  installConsentDispatchProbe,
  installPosthogInterceptor,
  POSTHOG_EU_ENDPOINT,
  revokeConsent,
  assertNativeCancellation,
} from './oracles/r5-posthog-eu'
import type { DispatchFact } from './oracles/r5-posthog-eu'
import {
  assertCell,
  assertLayout,
  assertLocalFont,
  layoutFaults,
  prepareCell,
  snapshotKey,
  verifyFonts,
  verifySkipLink,
  verifyTabOrder,
  verifyTokenBinding,
  verifyWcag,
  viewportScreenshot,
  VIEWPORT_WIDTHS,
  tabOrderForViewport,
  resetDocumentFocus,
} from './oracles/r6-visual-a11y'
import type { VisualCell } from './oracles/r6-visual-a11y'
import { guard } from './oracles/shared'

test('Persona 4: twelve explicit web cells on one retained owner page', async ({ browser }) => {
  const input = readWave2Input('PERSONA4')
  await gateWorld(browser, input)
  const budget = new RateBudget()
  const actor = await Actor.create(browser, 'A', input, budget)
  let succeeded = false
  try {
    await prepareCell(actor.page, {
      origin: 'web',
      surface: 'S11',
      state: 'ready',
      theme: 'light',
      language: 'fr',
      width: 1440,
      height: 900,
    })
    await actor.signIn()
    await actor.workspace(input.workspaceReady, input.visual.webPath)
    guard(
      Number.isSafeInteger(input.visual.clockEpochMs) && input.visual.clockEpochMs > 0,
      'R6_CLOCK_FIXTURE'
    )
    await actor.page.clock.setFixedTime(input.visual.clockEpochMs)
    for (const theme of ['light', 'dark'] as const)
      for (const language of ['fr', 'en'] as const) {
        await actor.page.evaluate((theme) => {
          localStorage.setItem('console:theme', theme)
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: 'console:theme',
              newValue: theme,
              storageArea: localStorage,
            })
          )
        }, theme)
        // Use the application's actual language control: locale and storageState do not switch it.
        await selectInterfaceLanguage(actor.page, {
          button: input.visual.languageButton,
          option: input.visual.languageOptions[language],
          section: input.visual.languageSection,
          close: input.visual.languageClose,
        })
        for (const width of VIEWPORT_WIDTHS) {
          const cell: VisualCell = {
            origin: 'web',
            surface: 'S11',
            state: 'ready',
            theme,
            language,
            width,
            height: 900,
          }
          await actor.page.setViewportSize({ width, height: 900 })
          await actor.page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
          await assertCell(actor.page, cell)
          assertLayout(await layoutFaults(actor.page))
          await verifyFonts(
            actor.page,
            actor.page.locator(input.visual.sansSelector),
            actor.page.locator(input.visual.monoSelector)
          )
          await verifyTokenBinding(actor.page, cell, input.visual.tokenSelector)
          await verifyWcag(actor.page)
          await actor.page.evaluate(resetDocumentFocus)
          const image = await viewportScreenshot(actor.page, cell)
          expect(image).toMatchSnapshot(snapshotKey(cell), { threshold: 0, maxDiffPixels: 0 })
          await verifySkipLink(actor.page, 'main-content')
          await verifyTabOrder(actor.page, tabOrderForViewport(input.visual.tabOrder, width))
          budget.reusePage('A', actor.page)
        }
      }
    budget.assertExact('A', { 'core-token': 2, 'matrix-login': 1, 'local-join': 2 })
    await actor.assertClean()
    succeeded = true
  } finally {
    await finishCleanup(succeeded, [() => actor.close()], 'WAVE2_CLEANUP')
    budget.clear()
  }
})

test('Persona 4: landing retains its independent zero-third-party rule', async ({ browser }) => {
  const input = readWave2Input('PERSONA4')
  await gateWorld(browser, input)
  for (const theme of ['light', 'dark'] as const)
    for (const language of ['fr', 'en'] as const)
      for (const width of VIEWPORT_WIDTHS) {
        const cell: VisualCell = {
          origin: 'landing',
          surface: 'L01',
          state: 'default',
          theme,
          language,
          width,
          height: 900,
        }
        const context = await browser.newContext({
          serviceWorkers: 'block',
          locale: language,
          colorScheme: theme,
          reducedMotion: 'reduce',
        })
        const failures: string[] = []
        const path = language === 'en' ? '/en' : '/'
        const ledger = new NetworkLedger(
          [{ origin: targets().landing, method: 'GET', pathPattern: path, expectedStatus: 200 }],
          [targets().landing]
        )
        const recorder = await recordNetwork(context, ledger)
        let succeeded = false
        context.on('request', (request) => {
          if (new URL(request.url()).origin !== targets().landing)
            failures.push('R6_LANDING_THIRD_PARTY')
          if (request.resourceType() === 'font') {
            try {
              assertLocalFont(request.url(), targets().landing)
            } catch {
              failures.push('R6_THIRD_PARTY_FONT')
            }
          }
        })
        try {
          const page = await context.newPage()
          guard(
            Number.isSafeInteger(input.visual.clockEpochMs) && input.visual.clockEpochMs > 0,
            'R6_CLOCK_FIXTURE'
          )
          await page.clock.setFixedTime(input.visual.clockEpochMs)
          await prepareCell(page, cell)
          const response = await page.goto(`${targets().landing}${path}`)
          guard(response?.status() === 200, 'R1_LANDING_STATUS')
          await expect(page.locator('main')).toBeVisible()
          await assertCell(page, cell)
          assertLayout(await layoutFaults(page))
          await verifyFonts(
            page,
            page.locator(input.visual.landingSansSelector),
            page.locator(input.visual.landingMonoSelector),
            'landing'
          )
          await verifyTokenBinding(page, cell, input.visual.landingTokenSelector)
          await verifyWcag(page)
          expect(await viewportScreenshot(page, cell)).toMatchSnapshot(snapshotKey(cell), {
            threshold: 0,
            maxDiffPixels: 0,
          })
          await verifySkipLink(page, 'contenu')
          guard(!failures.length, failures[0] ?? 'R6_LANDING_THIRD_PARTY')
          await recorder.assertClean()
          succeeded = true
        } finally {
          await finishCleanup(
            succeeded,
            [() => recorder.dispose(), () => context.close()],
            'WAVE2_CLEANUP'
          )
        }
      }
})

test('R5: explicit opt-in, validated EU capture and immediate native cancellation on revoke', async ({
  browser,
}) => {
  const input = readWave2Input('R5')
  await gateWorld(browser, input)
  const consent = new ConsentLedger(targets().web, input.telemetry.captureKey)
  const budget = new RateBudget()
  let interceptor: Awaited<ReturnType<typeof installPosthogInterceptor>> | undefined
  const actor = await Actor.create(browser, 'A', input, budget, {
    extraOrigins: [new URL(POSTHOG_EU_ENDPOINT).origin],
    allowedRequestFailure: (request) => interceptor?.isHeldRequest(request) === true,
    beforePage: async (context) => {
      await installConsentDispatchProbe(
        context,
        `kodera.telemetry.consent.v1:${JSON.stringify([input.telemetry.personId, input.telemetry.workspaceId])}`
      )
      interceptor = await installPosthogInterceptor(context, consent, [
        ...Object.values(targets()),
        input.homeserverOrigin,
        ...(input.livekitOrigin ? [input.livekitOrigin] : []),
      ])
    },
  })
  let succeeded = false
  try {
    await actor.signIn()
    await actor.workspace(input.workspaceReady, input.channelPath)
    await actor.page.locator(input.telemetry.settingsButton).click()
    await actor.page.locator(input.telemetry.privacyButton).click()
    const toggle = actor.page.locator('[data-ph-no-capture]').getByRole('switch')
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    guard(consent.attempts.length === 0, 'R5_ZERO_BEFORE_CONSENT')
    consent.phase = 'consented'
    await toggle.click()
    await expect(toggle).toBeChecked()
    // A real canvas transition is the causal producer; the test never calls a production capture API.
    await actor.page.keyboard.press('Escape')
    await actor.page.locator(input.docsButton).click()
    await expect.poll(() => consent.postCount()).toBeGreaterThan(0)
    consent.assertClean()
    const factsBeforeHold = await actor.page.evaluate(
      () =>
        (window as unknown as { __wave2DispatchFacts: DispatchFact[] }).__wave2DispatchFacts.length
    )
    interceptor!.holdPosts()
    await actor.page.locator(input.docsButton).click()
    await expect.poll(() => interceptor!.heldCount()).toBeGreaterThan(0)
    await actor.page.locator(input.telemetry.settingsButton).click()
    await actor.page.locator(input.telemetry.privacyButton).click()
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeEnabled()
    await actor.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    const before = consent.attempts.length
    const heldCount = interceptor!.heldCount()
    await revokeConsent(consent, () => toggle.evaluate((el: HTMLElement) => el.click()))
    // Read after the handler returns; polling here would conceal delayed cancellation.
    const facts = await actor.page.evaluate(
      () => (window as unknown as { __wave2DispatchFacts: DispatchFact[] }).__wave2DispatchFacts
    )
    assertNativeCancellation(facts, factsBeforeHold, heldCount)
    interceptor!.releaseHeldPosts()
    await expect(toggle).not.toBeChecked()
    await actor.page.keyboard.press('Escape')
    await actor.page.locator(input.docsButton).click()
    await expect(actor.page.locator(input.editor)).toBeVisible()
    await actor.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    guard(consent.attempts.length === before, 'R5_ZERO_AFTER_REVOKE')
    consent.assertClean()
    budget.assertExact('A', { 'core-token': 2, 'matrix-login': 1, 'local-join': 2 })
    await actor.assertClean()
    succeeded = true
  } finally {
    interceptor?.releaseHeldPosts()
    await finishCleanup(
      succeeded,
      [async () => interceptor?.dispose(), () => actor.close()],
      'WAVE2_CLEANUP'
    )
    budget.clear()
  }
})

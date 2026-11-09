// Hermetic workspace E2E suite for the #urgence channel view and sonic preference storage,
// verifying keyboard navigation, quick-switcher discovery, axe accessibility, and zero
// CSP, console.error, or pageerror regressions.

/// <reference lib="dom" />

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'
const SHELL = 'shell.single-organisation'
const URGENCE_CHANNEL_ID = '019a6004-bedc-7911-8911-000000000911'

const openWorkspace = (page: Page) => signIn(page, ORG, '/workspace')

function channels(page: Page) {
  return page.getByRole('navigation', { name: 'Salons' })
}

function pageIsMac(page: Page): Promise<boolean> {
  return page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent))
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
}

interface RuntimeTelemetry {
  readonly pageErrors: string[]
  readonly consoleErrors: string[]
}

async function attachRuntimeHygieneGuards(page: Page): Promise<RuntimeTelemetry> {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []

  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })

  await page.addInitScript(() => {
    const events: Array<{ directive: string; blocked: string }> = []
    Object.defineProperty(window, '__koderaCspEvents', {
      value: events,
      configurable: true,
    })
    document.addEventListener('securitypolicyviolation', (event) => {
      events.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      })
    })
  })

  return { pageErrors, consoleErrors }
}

async function expectZeroRuntimeRegressions(
  page: Page,
  telemetry: RuntimeTelemetry
): Promise<void> {
  const cspEvents = await page.evaluate(() => {
    const win = window as Window & {
      __koderaCspEvents?: Array<{ directive: string; blocked: string }>
    }
    return win.__koderaCspEvents ?? []
  })
  expect(cspEvents).toEqual([])
  expect(telemetry.pageErrors).toEqual([])
  expect(telemetry.consoleErrors).toEqual([])
}

async function routeWorkspaceWithEmergencyChannel(page: Page): Promise<void> {
  await page.route('**/api/v1/organisations/*/workspace', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    const body = (await response.json()) as {
      categories?: Array<{
        id: string
        name: string
        template_key: string | null
        channels: Array<{
          id: string
          kind: string
          name: string
          template_key: string | null
          topic: string
          lifecycle: string
          room_state: string
        }>
      }>
    }
    if (Array.isArray(body.categories) && body.categories[0] !== undefined) {
      body.categories[0].channels.push({
        id: URGENCE_CHANNEL_ID,
        kind: 'text',
        name: 'urgence',
        template_key: null,
        topic: 'Continuité bâtiment et pointage de sécurité hors-ligne',
        lifecycle: 'active',
        room_state: 'ready',
      })
    }
    await route.fulfill({
      response,
      json: body,
    })
  })
}

test('workspace/emergency: lists #urgence in the workspace sidebar, navigates to its channel view, and passes axe with zero CSP or console errors', async ({
  page,
}) => {
  const telemetry = await attachRuntimeHygieneGuards(page)
  await useScenario(page, [SHELL, 'workspace.ready'])
  await routeWorkspaceWithEmergencyChannel(page)
  await openWorkspace(page)

  const nav = channels(page)
  await expect(nav.getByRole('link')).toHaveText(['#bienvenue', '#général', '#urgence'])

  const urgenceLink = nav.getByRole('link', { name: 'urgence' })
  await urgenceLink.click()

  await expect(page).toHaveURL(new RegExp(`/${ORG}/workspace/${URGENCE_CHANNEL_ID}$`))
  const heading = page.getByRole('heading', { level: 1, name: 'urgence' })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  await expect(urgenceLink).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByText('Continuité bâtiment et pointage de sécurité hors-ligne')
  ).toBeVisible()

  await expectAxeClean(page)
  await expectZeroRuntimeRegressions(page, telemetry)
})

test('workspace/emergency: opens #urgence from the quick-switcher search dialog and preserves sonic preference storage with zero runtime errors', async ({
  page,
}) => {
  const telemetry = await attachRuntimeHygieneGuards(page)
  await useScenario(page, [SHELL, 'workspace.ready'])
  await routeWorkspaceWithEmergencyChannel(page)
  await openWorkspace(page)

  await expect(page.getByRole('heading', { level: 1, name: 'bienvenue' })).toBeVisible()

  // Persist and verify canonical sonic identity preferences in storage
  const storedPack = await page.evaluate(() => {
    const payload = {
      pack: 'atelier',
      masterMode: 'on',
      masterVolume: 0.8,
      categories: { voice: true, calls: true, messages: true, workspace: true },
      mentionVariant: 'eclat',
      vipEnriched: true,
      selfActionsOnly: false,
      softenedHighs: false,
      outputDeviceId: null,
    }
    window.localStorage.setItem(
      'kodera:sound-preferences:v1',
      JSON.stringify(payload)
    )
    const readBack = JSON.parse(
      window.localStorage.getItem('kodera:sound-preferences:v1') ?? '{}'
    ) as {
      pack?: string
    }
    return readBack.pack ?? null
  })
  expect(storedPack).toBe('atelier')

  await page.keyboard.press((await pageIsMac(page)) ? 'Meta+k' : 'Control+k')
  const dialog = page.getByRole('dialog', { name: 'Aller à un salon' })
  await expect(dialog).toBeVisible()
  await page.keyboard.type('urg')
  await expect(dialog.getByRole('option')).toHaveText([/urgence/])
  await expectAxeClean(page)
  await page.keyboard.press('Enter')

  await expect(dialog).toHaveCount(0)
  const heading = page.getByRole('heading', { level: 1, name: 'urgence' })
  await expect(heading).toBeFocused()
  await expect(channels(page).getByRole('link', { name: 'urgence' })).toHaveAttribute(
    'aria-current',
    'page'
  )

  await expectAxeClean(page)
  await expectZeroRuntimeRegressions(page, telemetry)
})

// Hermetic workspace E2E suite for the #proximity channel view and sonic preference storage,
// verifying keyboard navigation, quick-switcher discovery, axe accessibility, and zero
// CSP, console.error, or pageerror regressions.

/// <reference lib="dom" />

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

const ORG = 'acme-sa'
const SHELL = 'shell.single-organisation'
const PROXIMITY_CHANNEL_ID = '019a6004-bedc-7911-8911-000000000911'

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

async function routeWorkspaceWithProximityChannel(page: Page): Promise<void> {
  await page.addInitScript((proximityId) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const response = await originalFetch(input, init)
      if (method === 'GET' && /\/api\/v1\/organisations\/[^/]+\/workspace$/.test(url)) {
        const body = (await response.clone().json()) as {
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
            id: proximityId,
            kind: 'text',
            // As Core answers for the proximity template: the channel is named `proximity` and
            // carries the template's row key, which the console labels « proximité » in French.
            name: 'proximity',
            template_key: 'proximity',
            topic: 'Présence de proximité, pointage volontaire',
            lifecycle: 'active',
            room_state: 'ready',
          })
        }
        return new Response(JSON.stringify(body), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      return response
    }
  }, PROXIMITY_CHANNEL_ID)
}

test('workspace/proximity: lists #proximity in the workspace sidebar, navigates to its channel view, and passes axe with zero CSP or console errors', async ({
  page,
}) => {
  const telemetry = await attachRuntimeHygieneGuards(page)
  await useScenario(page, [SHELL, 'workspace.ready'])
  await routeWorkspaceWithProximityChannel(page)
  await openWorkspace(page)

  const nav = channels(page)
  await expect(nav.getByRole('link')).toHaveText(['#bienvenue', '#général', '#proximité'])

  const proximityLink = nav.getByRole('link', { name: 'proximité' })
  await proximityLink.click()

  await expect(page).toHaveURL(new RegExp(`/${ORG}/workspace/${PROXIMITY_CHANNEL_ID}$`))
  const heading = page.getByRole('heading', { level: 1, name: 'proximité' })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  await expect(proximityLink).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Présence de proximité, pointage volontaire')).toBeVisible()

  await expectAxeClean(page)
  await expectZeroRuntimeRegressions(page, telemetry)
})

test('workspace/proximity: opens #proximity from the quick-switcher search dialog and preserves sonic preference storage with zero runtime errors', async ({
  page,
}) => {
  const telemetry = await attachRuntimeHygieneGuards(page)
  await useScenario(page, [SHELL, 'workspace.ready'])
  await routeWorkspaceWithProximityChannel(page)
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
    window.localStorage.setItem('kodera:sound-preferences:v1', JSON.stringify(payload))
    const readBack = JSON.parse(
      window.localStorage.getItem('kodera:sound-preferences:v1') ?? '{}'
    ) as {
      pack?: string
    }
    return readBack.pack ?? null
  })
  expect(storedPack).toBe('atelier')

  await page.keyboard.press((await pageIsMac(page)) ? 'Meta+k' : 'Control+k')
  const dialog = page.getByRole('dialog', { name: 'Commandes et navigation rapide' })
  await expect(dialog).toBeVisible()
  await page.keyboard.type('prox')
  await expect(dialog.getByRole('option')).toHaveText([/proximité/])
  await expectAxeClean(page)
  await page.keyboard.press('Enter')

  await expect(dialog).toHaveCount(0)
  const heading = page.getByRole('heading', { level: 1, name: 'proximité' })
  await expect(heading).toBeFocused()
  await expect(channels(page).getByRole('link', { name: 'proximité' })).toHaveAttribute(
    'aria-current',
    'page'
  )

  await expectAxeClean(page)
  await expectZeroRuntimeRegressions(page, telemetry)
})

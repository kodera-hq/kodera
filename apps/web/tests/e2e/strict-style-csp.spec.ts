// The console under `style-src-attr 'none'` (server/static.mjs): every surface that positions,
// sizes or animates an element at run time — Radix's Tooltip, DropdownMenu, Popover, Dialog and
// Select, the combobox, the audio dock and Theme Studio — is opened against the real server and
// its real policy, and not one `securitypolicyviolation` fires. A `style="…"` attribute, a
// `setAttribute('style', …)` or an injected `<style>` element would each fire one; the CSSOM
// (`src/ui/cssom.ts`, `src/ui/csp/styleSingleton.ts`) fires none, and the `<style>` Radix Select's
// viewport writes is removed at build (scripts/vite/radixSelectViewportStyle.ts).
//
// The demo workspace needs no sign-in, so every step below is the workspace a visitor gets.

/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { startStrictStaticServer, type StrictStaticServer } from './support/strictStaticServer'

const SCENARIOS = ['demo.groupe-vercelli', 'demo.community-member']

interface Violation {
  directive: string
  blocked: string
  sample: string
}

let server: StrictStaticServer

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await startStrictStaticServer()
})

test.afterAll(async () => {
  await server?.close()
})

/** Every violation since the last call, after two frames so a late style write is counted. */
async function violations(page: Page): Promise<Violation[]> {
  return page.evaluate(async () => {
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done()))
    )
    return (window as unknown as { __cspEvents: Violation[] }).__cspEvents.splice(0)
  })
}

async function openWorkspace(page: Page): Promise<string> {
  await page.addInitScript((names: readonly string[]) => {
    window.sessionStorage.setItem('msw:scenarios', JSON.stringify(names))
    const events: Violation[] = []
    Object.defineProperty(window, '__cspEvents', { value: events })
    document.addEventListener('securitypolicyviolation', (event) =>
      events.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        sample: event.sample,
      })
    )
  }, SCENARIOS)
  const response = await page.goto(`${server.origin}/community/workspace`)
  await expect(page.getByRole('button', { name: 'Réglages', exact: true })).toBeVisible()
  return response?.headers()['content-security-policy'] ?? ''
}

test('strict style CSP: the policy refuses every style attribute and inline style element', async ({
  page,
}) => {
  const policy = await openWorkspace(page)
  const directives = new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/)
      return [name, values] as const
    })
  )
  expect(directives.get('style-src-attr')).toEqual(["'none'"])
  expect(directives.get('style-src')).toEqual(["'self'"])
  expect(policy).not.toContain('unsafe-inline')
  // The policy is live: a style attribute written the forbidden way is refused and reported…
  const refused = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.setAttribute('style', 'color: red')
    document.body.append(probe)
    const applied = getComputedStyle(probe).color === 'rgb(255, 0, 0)'
    probe.remove()
    return applied
  })
  expect(refused).toBe(false)
  expect((await violations(page)).map((event) => event.directive)).toContain('style-src-attr')
  // …and the same property through the CSSOM is not.
  const cssom = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.setProperty('color', 'rgb(255, 0, 0)')
    document.body.append(probe)
    const applied = getComputedStyle(probe).color === 'rgb(255, 0, 0)'
    probe.remove()
    return applied
  })
  expect(cssom).toBe(true)
  expect(await violations(page)).toEqual([])
})

test('strict style CSP: Radix primitives, the audio dock and Theme Studio raise no violation', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openWorkspace(page)
  expect(await violations(page), 'workspace load').toEqual([])

  // Tooltip: the composer's mention button names itself beside it once focused.
  await page.getByRole('button', { name: 'Mentionner', exact: true }).focus()
  await expect(page.locator('[data-side]').filter({ hasText: 'Mentionner' })).toBeVisible()
  expect(await violations(page), 'tooltip').toEqual([])

  // DropdownMenu: a message's actions.
  await page
    .getByRole('button', { name: /^Actions du message de Elena Vance/ })
    .first()
    .click()
  await expect(page.getByRole('menu')).toBeVisible()
  expect(await violations(page), 'dropdown menu').toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Popover: the reaction palette.
  await page.getByRole('button', { name: 'Ajouter une réaction' }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await violations(page), 'popover').toEqual([])
  await page.keyboard.press('Escape')

  // The organisation switcher.
  await page
    .getByRole('button', { name: 'Kodera Community, changer d’organisation' })
    .first()
    .click()
  await expect(page.locator('[role="listbox"], [role="menu"], [role="dialog"]')).toHaveCount(1)
  expect(await violations(page), 'organisation switcher').toEqual([])
  await page.keyboard.press('Escape')

  // Dialog: the settings, whose scroll lock now applies (an adopted stylesheet, not a `<style>`).
  await page.getByRole('button', { name: 'Réglages', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Réglages', exact: true })
  await expect(settings).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
    .toBe('hidden')
  expect(await violations(page), 'dialog').toEqual([])

  // Theme Studio, and a Givre theme chosen and left again in one click each.
  await settings.getByRole('tab', { name: /Apparence/ }).click()
  await settings.getByRole('button', { name: 'Ouvrir Theme Studio', exact: true }).click()
  await page.getByTestId('theme-studio-base-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByTestId('theme-studio-base-ciel').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ciel')
  expect(await violations(page), 'theme studio').toEqual([])
  await page.getByTestId('theme-studio-close-btn').click()

  // Select: the audio settings' device choice.
  await settings.getByRole('tab', { name: /Voix/ }).click()
  const device = settings.getByRole('combobox').first()
  await device.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  expect(await violations(page), 'select').toEqual([])
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // The audio dock: joining a voice room shows the call.
  await page.getByRole('button', { name: /^Rejoindre office-hours/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours' })).toBeVisible()
  expect(await violations(page), 'audio dock').toEqual([])
})

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario as selectScenario } from './support/useScenario'

declare global {
  interface Window {
    __callbackTokenRequests?: string[]
    __holdCallbackToken?: boolean
    __releaseCallbackToken?: () => void
  }
}

async function silentFrame(page: Page) {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  return page.frames().find((frame) => frame.url().includes('prompt=none'))!
}

async function start(page: Page) {
  // Observe actual fetch calls in every frame; no SDK operation is replaced.
  await page.addInitScript(() => {
    window.__callbackTokenRequests = []
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/protocol/openid-connect/token')) window.__callbackTokenRequests?.push(url)
      const response = await original(input, init)
      if (url.endsWith('/protocol/openid-connect/token')) {
        if (window.__holdCallbackToken) {
          await new Promise<void>((resolve) => {
            window.__releaseCallbackToken = resolve
          })
        }
        if ((window.__callbackTokenRequests?.length ?? 0) === 1 && response.ok) {
          const payload = (await response.clone().json()) as Record<string, unknown>
          return new Response(JSON.stringify({ ...payload, expires_in: 120 }), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }
      }
      return response
    }
  })
  await selectScenario(page, ['shell.single-organisation'])
  await signIn(page, 'acme-sa')
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await page.evaluate(() => {
    window.__callbackTokenRequests = []
    sessionStorage.setItem('kodera.web.auth.returnTo', '/acme-sa/home?preserve=1')
    window.dispatchEvent(new Event('focus'))
  })
  return silentFrame(page)
}

test('silent callback renews only the parent and preserves its destination', async ({ page }) => {
  let frame = await start(page)
  // Controlled provider refusal: the real SDK must surface a failed renewal.
  const request = new URL(frame.url())
  const refusal = new URL(request.searchParams.get('redirect_uri')!)
  refusal.searchParams.set('state', request.searchParams.get('state')!)
  refusal.searchParams.set('error', 'login_required')
  await frame.goto(refusal.href)
  await expect(page.getByRole('button', { name: 'Garder la session ouverte' })).toBeVisible()
  await page.getByRole('button', { name: 'Garder la session ouverte' }).click()
  frame = await silentFrame(page)
  expect(new URL(frame.url()).searchParams.get('prompt')).toBe('none')
  // The iframe is intentionally hidden; the test controls its synthetic IdP.
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('button', { name: 'Garder la session ouverte' })).toHaveCount(0)
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await expect.poll(() => page.evaluate(() => window.__callbackTokenRequests?.length)).toBe(1)
  expect(await page.evaluate(() => sessionStorage.getItem('kodera.web.auth.returnTo'))).toBe(
    '/acme-sa/home?preserve=1'
  )
  await expect.poll(() => page.frames().length).toBe(1)
})

test('silent renewal timeout remains failed without exchanging a token', async ({ page }) => {
  await start(page)
  await expect(page.getByRole('button', { name: 'Garder la session ouverte' })).toBeVisible({
    timeout: 15_000,
  })
  expect(await page.evaluate(() => window.__callbackTokenRequests?.length)).toBe(0)
  await expect.poll(() => page.frames().length).toBe(1)
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
})

test('missing iframe transaction cannot exchange a token or consume the parent destination', async ({
  page,
}) => {
  const frame = await start(page)
  const callback = new URL(new URL(frame.url()).searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', 'unknown-transaction')
  callback.searchParams.set('code', 'untrusted-code')
  await frame.goto(callback.href)
  await expect(page.getByRole('button', { name: 'Garder la session ouverte' })).toBeVisible({
    timeout: 15_000,
  })
  expect(await page.evaluate(() => window.__callbackTokenRequests?.length)).toBe(0)
  expect(await page.evaluate(() => sessionStorage.getItem('kodera.web.auth.returnTo'))).toBe(
    '/acme-sa/home?preserve=1'
  )
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
})

test('logout wins over a late real SDK iframe token response', async ({ page }) => {
  const frame = await start(page)
  await page.evaluate(() => {
    window.__holdCallbackToken = true
  })
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect
    .poll(() => page.evaluate(() => typeof window.__releaseCallbackToken))
    .toBe('function')
  await page.getByRole('button', { name: /Julie/ }).click()
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.evaluate(async () => {
    window.__releaseCallbackToken?.()
    // Let the released response traverse the SDK's promise chain.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Garder la session ouverte' })).toHaveCount(0)
  await expect(page).toHaveURL(/\/login$/)
  expect(await page.evaluate(() => window.__callbackTokenRequests?.length)).toBe(1)
})

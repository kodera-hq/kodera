import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

declare global {
  interface Window {
    __reloadIdentityReads?: number
  }
}

test('reload restores through silent SSO before reading or rendering private data', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__reloadIdentityReads = 0
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/api/v1/me')) window.__reloadIdentityReads! += 1
      return original(input, init)
    }
  })
  await useScenario(page, ['shell.single-organisation'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  expect(await page.evaluate(() => window.__reloadIdentityReads)).toBe(0)
  await expect(page.getByRole('navigation')).toHaveCount(0)
  const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  expect(await page.evaluate(() => window.__reloadIdentityReads)).toBe(1)
})

for (const outcome of ['refusal', 'timeout'] as const) {
  test(`reload ${outcome} offers one interactive handoff without private data`, async ({
    page,
  }) => {
    await useScenario(page, ['shell.single-organisation'])
    await signIn(page, 'acme-sa')
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
    await page.reload()
    await expect
      .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
      .toBe(true)
    await expect(page.getByRole('navigation')).toHaveCount(0)
    if (outcome === 'refusal') {
      const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
      const request = new URL(frame.url())
      const callback = new URL(request.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', request.searchParams.get('state')!)
      callback.searchParams.set('error', 'login_required')
      await frame.goto(callback.href)
    }
    await expect(page).toHaveURL(/__mock-idp\/authorize/, { timeout: 15_000 })
    expect(new URL(page.url()).searchParams.get('prompt')).toBeNull()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    await page.getByRole('button', { name: 'Continuer' }).click()
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
    await expect(page).toHaveURL(/\/acme-sa\/home$/)
  })
}

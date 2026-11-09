import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

test('application cards preserve keyboard copy and adapt both addresses to the available width', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(baseURL!).origin,
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await useScenario(page, ['shell.single-organisation', 'status.live-healthy'])
  await signIn(page, 'acme-sa', '/status')
  const app = page.getByRole('region', { name: 'Visio', exact: true })
  await expect(app.getByRole('heading', { name: 'Visio', exact: true })).toBeVisible()
  await expect(app.getByText('Opérationnel', { exact: true })).toBeVisible()
  const primary = app.getByText('https://visio.acme.fr', { exact: true })
  const fallback = app.getByText('https://acme.visio.kodera.io', { exact: true })
  await expect(primary).toBeVisible()
  await expect(fallback).toBeVisible()
  const firstBox = await primary.boundingBox()
  const secondBox = await fallback.boundingBox()
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  expect(Math.abs(firstBox!.y - secondBox!.y)).toBeLessThan(2)
  expect(secondBox!.x).toBeGreaterThan(firstBox!.x)
  await app.getByRole('button', { name: 'Copier', exact: true }).nth(1).focus()
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('https://acme.visio.kodera.io')
  const open = app.getByRole('link', { name: /Ouvrir Visio.*nouvel onglet/ })
  await expect(open).toHaveAttribute('href', 'https://visio.acme.fr')
  await expect(open).toHaveAttribute('target', '_blank')
  await context.route('https://visio.acme.fr/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>Application destination</title>',
    })
  )
  const opened = context.waitForEvent('page')
  await open.focus()
  await page.keyboard.press('Enter')
  const destination = await opened
  await expect(destination).toHaveURL('https://visio.acme.fr/')
  await expect(destination).toHaveTitle('Application destination')
  await destination.close()
  await page.setViewportSize({ width: 390, height: 780 })
  await expect(page.getByRole('navigation', { name: 'Navigation par onglets' })).toBeVisible()
  await expect(primary).toBeVisible()
  await expect(fallback).toBeVisible()
  expect((await fallback.boundingBox())!.y).toBeGreaterThan((await primary.boundingBox())!.y)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('narrow application cards keep long addresses complete and copyable without page overflow', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(baseURL!).origin,
  })
  await page.setViewportSize({ width: 390, height: 780 })
  await useScenario(page, [
    'shell.single-organisation',
    'status.live-healthy',
    'status.long-addresses',
  ])
  await signIn(page, 'acme-sa', '/status')
  const app = page.getByRole('region', { name: 'Visio', exact: true })
  const addresses = [
    'https://visio.a-very-long-organisation-name-for-responsive-address-acceptance.example.test',
    'https://a-very-long-organisation-name-for-responsive-address-acceptance.visio.kodera.io',
  ]
  for (const [index, address] of addresses.entries()) {
    await expect(app.getByText(address, { exact: true })).toBeVisible()
    await app.getByRole('button', { name: 'Copier', exact: true }).nth(index).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(address)
  }
  await expect(app.getByRole('link')).toHaveAttribute('href', addresses[0]!)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
async function openHub(page: Page) {
  await page.goto('/login?demo=1&org=community')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/community\/workspace$/)
  if ((page.viewportSize()?.width ?? 1280) < 960) {
    await page.getByRole('button', { name: 'Salons', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await page.getByRole('button', { name: 'Documentation développeur & API (Docs-as-Code)' }).click()
  await expect(page.getByTestId('developer-docs-hub')).toBeVisible()
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready
      return document.fonts.check('400 14px "Plus Jakarta Sans"')
    })
  ).toBe(true)
}
test('desktop reference has three legible columns, source links and complete clipboard exports', async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1600, height: 1000 })
  await openHub(page)
  const geometry = await page.getByTestId('developer-docs-hub').evaluate((element) => {
    const columns = Array.from(element.firstElementChild!.children).map((column) =>
      column.getBoundingClientRect()
    )
    return columns.map(({ x, y, width }) => ({ x, y, width }))
  })
  expect(geometry[1]!.x).toBeGreaterThan(geometry[0]!.x)
  expect(geometry[2]!.x).toBeGreaterThan(geometry[1]!.x)
  expect(geometry[1]!.width).toBeGreaterThanOrEqual(360)
  const clipped = await page.getByTestId('developer-docs-hub').evaluate((element) =>
    Array.from(element.querySelectorAll('button'))
      .filter(
        (button) =>
          button.getBoundingClientRect().width > 0 &&
          button.scrollHeight > button.getBoundingClientRect().height + 1
      )
      .map((button) => button.textContent)
  )
  expect(clipped).toEqual([])
  await page.screenshot({ path: info.outputPath('docs-desktop.png') })
  await page.getByRole('button', { name: 'Copier le Markdown pour agent IA (LLM)' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('# Quickstart & auto-hébergement')
  expect(copied).toContain('deploy/community/README.md')
  await expect(
    page.getByRole('link', { name: 'deploy/community/README.md', exact: true })
  ).toHaveAttribute(
    'href',
    'https://github.com/kodera-hq/kodera/blob/main/deploy/community/README.md'
  )
  expect(
    (await new AxeBuilder({ page }).include('[aria-label="Espace Docs"]').analyze()).violations
  ).toEqual([])
})
test('real browser HMAC verification detects tampering and serves text artifacts', async ({
  page,
  request,
}, info) => {
  await openHub(page)
  await page.getByRole('button', { name: 'Extension SDK & 10 connecteurs' }).click()
  await page.getByRole('button', { name: 'Signer l’exemple' }).click()
  const signature = page.getByRole('textbox', { name: 'En-tête de signature à vérifier' })
  await expect(signature).toHaveValue(/^v1=[a-f0-9]{64}$/)
  await page.getByRole('button', { name: 'Vérifier la signature' }).click()
  await expect(page.getByText('Signature valide localement')).toBeVisible()
  const payload = page.getByRole('textbox', { name: 'Payload JSON exact' })
  await payload.fill((await payload.inputValue()) + ' ')
  await expect(page.getByText('Signature valide localement')).toHaveCount(0)
  await page.getByRole('button', { name: 'Vérifier la signature' }).click()
  await expect(page.getByText('La signature ne correspond pas')).toBeVisible()
  await page.getByRole('combobox', { name: 'Format de signature' }).selectOption('github')
  await page.getByRole('button', { name: 'Signer l’exemple' }).click()
  await expect(signature).toHaveValue(/^sha256=[a-f0-9]{64}$/)
  await page.getByRole('button', { name: 'Vérifier la signature' }).click()
  await expect(page.getByText('Signature valide localement')).toBeVisible()
  await page.screenshot({ path: info.outputPath('docs-signature-lab.png') })
  const llms = await request.get('/llms.txt')
  expect(llms.status()).toBe(200)
  expect(llms.headers()['content-type']).toContain('text/plain')
  expect(await llms.text()).toContain('# Kodera')
  expect(await (await request.get('/developer-docs/en/api.md')).text()).toContain(
    '# API reference & webhooks'
  )
})
test('community entry opens Docs and the appropriate help discussion without allocating rooms', async ({
  page,
}) => {
  await openHub(page)
  await page.getByRole('button', { name: 'Extension SDK & 10 connecteurs' }).click()
  await page.getByRole('button', { name: 'Ouvrir le salon d’entraide associé' }).click()
  await expect(page.getByRole('heading', { name: 'extensions', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('espace-canvas-mode-chat')).toHaveAttribute('aria-current', 'page')
})
test('mobile reference remains readable and scrollable with reduced motion', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openHub(page)
  const measurements = await page.getByTestId('developer-docs-hub').evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    scrollWidth: element.scrollWidth,
    size: parseFloat(getComputedStyle(element.querySelector('article p')!).fontSize),
    documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }))
  expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.width + 1)
  expect(measurements.size).toBeGreaterThanOrEqual(12)
  expect(measurements.documentOverflow).toBe(false)
  await page
    .getByRole('region', { name: 'Espace Docs', exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: info.outputPath('docs-mobile.png') })
  await page.getByRole('searchbox', { name: 'Rechercher dans la documentation' }).fill('qonto')
  await page.getByRole('button', { name: 'Extension SDK & 10 connecteurs' }).click()
  await expect(
    page.getByRole('heading', { name: 'Extension SDK & 10 connecteurs', level: 2 })
  ).toBeVisible()
})
test('dark reference keeps outline keyboard targets and accessible contrast', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await openHub(page)
  const outline = page.getByRole('navigation', { name: 'Sur cette page' })
  const link = outline.getByRole('link').first()
  await link.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('heading', { name: 'Commencer par un plan de configuration' })
  ).toBeFocused()
  expect(
    (await new AxeBuilder({ page }).include('[aria-label="Espace Docs"]').analyze()).violations
  ).toEqual([])
  await page.screenshot({ path: info.outputPath('docs-dark.png') })
})

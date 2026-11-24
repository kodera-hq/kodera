import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.use({ reducedMotion: 'reduce' })

test('Messages uses a wide master/detail view, filters locally and returns to Pro by keyboard', async ({
  page,
}) => {
  await page.goto('/community/workspace')
  const toggle = page.getByTestId('workspace-ui-mode-messages')
  await toggle.click()
  const master = page.getByTestId('simple-messaging-sidebar')
  await expect(master.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(
    await master.evaluate((element) => element.getBoundingClientRect().width)
  ).toBeGreaterThanOrEqual(350)
  await expect(master.locator('[data-testid^="simple-feed-row-"]').first()).toContainText(
    /arrivals|arrivées/i
  )
  const search = master.getByRole('searchbox', { name: 'Filtrer les conversations' })
  await search.fill('support')
  await expect(master.locator('[data-testid^="simple-feed-row-"]')).toHaveCount(1)
  await search.clear()
  await master.getByRole('button', { name: 'Salons', exact: true }).click()
  await expect(master.locator('[data-testid^="simple-feed-row-"]').first()).toContainText(
    /arrivals|arrivées/i
  )
  const message = 'Message from the conversation pane'
  await page.locator('.messages-detail textarea').fill(message)
  await page
    .locator('.messages-detail')
    .getByRole('button', { name: 'Envoyer', exact: true })
    .click()
  const outgoing = page.locator('article[data-own="true"]').filter({ hasText: message })
  await expect(outgoing).toBeVisible()
  const bubble = await outgoing.boundingBox()
  const detail = await page.locator('.messages-detail').boundingBox()
  expect(bubble!.x + bubble!.width).toBeGreaterThan(detail!.x + detail!.width * 0.8)
  expect(
    (
      await new AxeBuilder({ page })
        .include('[data-testid="studio-workspace"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations
  ).toEqual([])
  await page.keyboard.press('Control+Shift+M')
  await expect(master).toHaveCount(0)
  await expect(page.getByTestId('workspace-ui-mode-pro')).toHaveAttribute('aria-pressed', 'true')
})

test('Messages on mobile opens one conversation and returns to the full list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('console:workspace-ui-mode', 'simple'))
  await page.goto('/community/workspace')
  const master = page.getByTestId('simple-messaging-sidebar')
  await expect(master).toBeVisible()
  await expect(page.locator('.messages-detail')).toBeHidden()
  await master.locator('[data-primary-row-button]').first().click()
  await expect(master).toBeHidden()
  await expect(page.locator('.messages-detail')).toBeVisible()
  await page.getByRole('button', { name: 'Retour aux conversations', exact: true }).click()
  await expect(master).toBeVisible()
  await expect(page.locator('.messages-detail')).toBeHidden()
})

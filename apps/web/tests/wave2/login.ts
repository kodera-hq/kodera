import type { Page } from '@playwright/test'

/** Tenant links open the organisation field; the shared entry can ask for an email first. */
export async function enterOrganisation(page: Page, emailAddress: string, organisation: string) {
  const email = page.getByLabel('Adresse e-mail')
  const slug = page.getByLabel('Identifiant de votre organisation')
  const continueButton = page.getByRole('button', { name: 'Continuer', exact: true })
  await email.or(slug).first().waitFor({ state: 'visible', timeout: 15_000 })
  if (await email.isVisible()) {
    await email.fill(emailAddress)
    await continueButton.click()
    await slug.or(page.locator('#username')).first().waitFor({ state: 'visible', timeout: 15_000 })
  }
  if (await slug.isVisible()) {
    await slug.fill(organisation)
    await continueButton.click()
  }
}

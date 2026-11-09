// A signed-in person's read-only pass: who they are, their home, and People. Skipped, saying
// why, unless an account or a saved session is given (e2e/staging/README.md). It opens the invite
// drawer for an owner or an administrator and closes it: nothing is sent, nothing is changed.
import { expect, test, type Page } from '@playwright/test'
import { ORG, readAccount, signIn, type Me } from './support'

const account = readAccount()
const storageState = process.env['KODERA_STAGING_STORAGE_STATE'] ?? ''
const required = process.env['KODERA_STAGING_REQUIRE_SIGNED_IN'] === '1'
const ready = account !== undefined || storageState !== ''

type Membership = NonNullable<Me['organisations']>[number]

test.describe.configure({ mode: 'serial' })

test.describe('signed in, read-only', () => {
  test.skip(!ready && !required, 'no account and no saved session given (e2e/staging/README.md)')

  // One sign-in for the whole pass: a second one would wait for the next one-time code.
  let page: Page
  let membership: Membership | undefined

  test.beforeAll(async ({ browser }) => {
    if (!ready)
      throw new Error('KODERA_STAGING_REQUIRE_SIGNED_IN=1, but no account and no saved session')
    const { baseURL, locale, timezoneId } = test.info().project.use
    const context = await browser.newContext({
      baseURL,
      locale,
      timezoneId,
      ...(storageState === '' ? {} : { storageState }),
    })
    page = await context.newPage()
    const me = await signIn(page, account)
    membership = me.organisations?.find((held) => held.organisation.slug === ORG)
  })

  test.afterAll(async () => {
    await page?.context().close()
  })

  test('/me names an active membership, and home renders', async () => {
    expect(membership, `a membership of ${ORG}`).toBeDefined()
    expect(membership!.state).toBe('active')
    test.info().annotations.push({ type: 'role', description: membership!.role })

    await page.goto(`/${ORG}/home`)
    await expect(page).toHaveURL(new RegExp(`/${ORG}/`))
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
    test.info().annotations.push({ type: 'landed on', description: new URL(page.url()).pathname })
  })

  test('People: the invite drawer opens and closes, and nothing is sent', async () => {
    const role = membership?.role ?? 'no member'
    test.skip(
      !['org_owner', 'org_admin'].includes(role),
      `the invite drawer is for an owner or an administrator, and this account is ${role}`
    )
    let invitationsSent = 0
    page.on('request', (sent) => {
      if (sent.method() === 'POST' && /\/invitations$/.test(new URL(sent.url()).pathname))
        invitationsSent += 1
    })
    await page.goto(`/${ORG}/people`)
    // A list has an « Inviter » menu; an organisation with nobody else yet offers the way directly.
    const menu = page.getByRole('button', { name: 'Inviter', exact: true })
    const direct = page.getByRole('button', { name: 'Inviter par e-mail' })
    await expect(menu.or(direct).first()).toBeVisible()
    if (await direct.isVisible()) await direct.click()
    else {
      await menu.click()
      await page.getByRole('menuitem', { name: 'Inviter par e-mail' }).click()
    }
    const drawer = page.getByRole('dialog', { name: 'Inviter des personnes' })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    expect(invitationsSent, 'invitations sent').toBe(0)
  })
})

// The v1 exit criteria, walked in real browsers against a real Console, Core and Keycloak
// (run-notes plan E1–E7; tests/smoke/README.md). The same spec runs against the local stack and
// against staging: only `SMOKE_BASE_URL` and the `SMOKE_INPUT` file change. Serial: each step
// starts from the state the previous one left.
import { expect, test, type Page } from '@playwright/test'
import { readInput, readRequired, type SmokeAccount } from './support/input'
import { throughKeycloak } from './support/keycloak'
import { linkFromMail } from './support/mailpit'

const input = readInput()
const REQUIRED = readRequired()
const ORG = input.organisation

/** A step without its input is skipped and says why, unless SMOKE_REQUIRE names it: then it fails. */
function needs(step: string, ready: boolean, why: string): void {
  if (ready) return
  if (REQUIRED.has(step)) throw new Error(`${step} is required by SMOKE_REQUIRE, but ${why}`)
  test.skip(true, why)
}

test.describe.configure({ mode: 'serial' })

interface Me {
  organisations?: { role: string; state: string; organisation: { slug: string } }[]
}

/** The console's own sign-in: address, realm discovery, then the organisation's Keycloak. */
async function signIn(page: Page, who: SmokeAccount): Promise<Me> {
  const me = page.waitForResponse(
    (response) => response.request().method() === 'GET' && /\/api\/v1\/me$/.test(response.url())
  )
  await page.goto('/login')
  await page.getByLabel('Adresse e-mail').fill(who.email)
  await page.getByRole('button', { name: 'Continuer' }).click()
  // Core resolves no organisation from an address's domain until a domain is verified, and the
  // page then asks for the organisation's identifier. A resolved realm goes straight to its
  // Keycloak, as the identifier does.
  const slug = page.getByLabel('Identifiant de votre organisation')
  await expect(slug.or(page.locator('#username')).first()).toBeVisible()
  if (await slug.isVisible()) {
    await slug.fill(ORG)
    await page.getByRole('button', { name: 'Continuer' }).click()
  }
  await throughKeycloak(page, who)
  const answered = await me
  expect(answered.status(), 'GET /me after sign-in').toBe(200)
  return (await answered.json()) as Me
}

test('E1: the owner claims the organisation and signs in as its sole owner', async ({
  page,
  context,
}) => {
  if (input.claim === 'mail') {
    const link = await linkFromMail(
      input.mailpit!,
      input.owner.email,
      new RegExp(`https?://[^\\s"<>]+/claim/[0-9a-f-]{36}/${ORG}#[^\\s"<>]+`)
    )
    await page.goto(link)
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Connectez-vous avec le compte invité pour devenir propriétaire de votre organisation',
      })
    ).toBeVisible()
    const popupOpened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await throughKeycloak(await popupOpened, input.owner)
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Confirmez que vous devenez propriétaire de votre organisation',
      })
    ).toBeVisible({ timeout: 30_000 })
    const consumed = page.waitForResponse((response) =>
      response.url().endsWith('/owner-claims/actions/consume')
    )
    await page.getByRole('button', { name: 'Devenir propriétaire' }).click()
    expect((await consumed).status(), 'consumeOwnerClaim').toBe(200)
    await expect(page).not.toHaveURL(/\/claim\//)
    await context.clearCookies()
  }

  const me = await signIn(page, input.owner)
  expect(me.organisations, 'the owner holds exactly one membership').toEqual([
    expect.objectContaining({
      role: 'org_owner',
      state: 'active',
      organisation: expect.objectContaining({ slug: ORG }),
    }),
  ])
  await expect(page).not.toHaveURL(/\/security\/mfa/)
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
})

test('E2: an invited member accepts through the Console and signs in', async ({ browser }) => {
  needs(
    'E2',
    input.member !== undefined && input.mailpit !== undefined,
    'the input names no invited member, or no Mailpit to read the invitation from'
  )
  const member = input.member!
  const link = await linkFromMail(
    input.mailpit!,
    member.email,
    new RegExp(`https?://[^\\s"<>]+/invitations/accept/[0-9a-f-]{36}/${ORG}#[^\\s"<>]+`)
  )
  // A browser of the member's own: the owner's session from E1 must not answer for them.
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(link)
    await expect(
      page.getByRole('heading', { level: 1, name: /^Vous êtes invité à rejoindre / })
    ).toBeVisible()
    const popupOpened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await throughKeycloak(await popupOpened, member)
    const join = page.getByRole('button', { name: /^Rejoindre / })
    await expect(join).toBeVisible({ timeout: 30_000 })
    // The /me that counts is the first one answered after the acceptance, never an earlier one.
    let acceptAnswered = false
    const accepted = page.waitForResponse((response) => {
      const answer = response.url().endsWith('/invitations/accept')
      if (answer) acceptAnswered = true
      return answer
    })
    const me = page.waitForResponse(
      (response) =>
        acceptAnswered &&
        response.request().method() === 'GET' &&
        /\/api\/v1\/me$/.test(response.url())
    )
    await join.click()
    expect((await accepted).status(), 'acceptInvitation').toBe(200)
    // A member lands in Espace, not the admin Home (UX audit #5).
    await expect(page).toHaveURL(new RegExp(`/${ORG}/workspace$`))
    const answered = await me
    expect(answered.status(), 'GET /me after the acceptance').toBe(200)
    const mine = (await answered.json()) as Me
    expect(mine.organisations, 'the member holds exactly one membership').toEqual([
      expect.objectContaining({
        role: 'org_member',
        state: 'active',
        organisation: expect.objectContaining({ slug: ORG }),
      }),
    ])
  } finally {
    await context.close()
  }
})

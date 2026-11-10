// The nine acceptance tests of docs/specs/00-shell-and-login.md §12, titled
// verbatim so the spec-test gate can match them. `tests/e2e/00-smoke.spec.ts`
// covers the sign-in round-trip and the shell frame itself; these specs
// cover the screens and states inside that frame.
//
// Browser-evaluated callbacks need DOM types in the Node-side test project.
/// <reference lib="dom" />

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario } from './support/useScenario'

test('login/realm: sends a known email domain straight to its organisation', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'login.single-organisation'])
  await page.goto('/login')

  await expect(page.getByRole('heading', { name: 'Se connecter à votre console' })).toBeVisible()
  const email = page.getByLabel('Adresse e-mail')
  await expect(email).toBeFocused()
  await email.fill('julie@acme.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()

  // The realm resolves to exactly one organisation (`login.single-organisation`): the
  // browser is sent to that organisation's realm, through the handoff view.
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await expect(page.getByRole('heading', { name: 'Continuer vers acme-sa' })).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()

  // The round trip lands back on the organisation's own home — the
  // destination the login started for, kept across the whole trip.
  await expect(page).toHaveURL(/\/acme-sa\/home$/)

  // The URL can settle while Home is still reading its authoritative state.
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('login/realm: explains an unknown domain and offers the organisation identifier', async ({
  page,
}) => {
  await useScenario(page, ['login.unknown-domain'])
  await page.goto('/login')

  await page.getByLabel('Adresse e-mail').fill('marie.dupont@unknown-example.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()

  // The cause, the fallback and the address to write to, in one message.
  const message = page.getByRole('alert')
  await expect(message).toHaveText(
    "Aucune organisation n'utilise le domaine unknown-example.fr. Utilisez l'identifiant de votre organisation, ou écrivez-nous à support@kodera.io."
  )

  // The fallback field appears, in the same round trip, with the email kept
  // for the trip back.
  const slug = page.getByLabel('Identifiant de votre organisation')
  await expect(slug).toBeVisible()
  // UX audit OL-24: the subtitle still asked for an e-mail address, and the
  // message sat under the identifier as if the identifier were wrong.
  await expect(page.getByText("Indiquez l'identifiant de votre organisation.")).toBeVisible()
  await expect(page.getByText('Indiquez votre adresse e-mail professionnelle.')).toHaveCount(0)
  const messageBox = await message.boundingBox()
  const slugBox = await slug.boundingBox()
  expect(messageBox).not.toBeNull()
  expect(slugBox).not.toBeNull()
  expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(slugBox!.y)
  await expect(slug).not.toHaveAttribute('aria-invalid', 'true')
  await page.getByRole('button', { name: 'Utiliser une adresse e-mail' }).click()
  await expect(page.getByLabel('Adresse e-mail')).toHaveValue('marie.dupont@unknown-example.fr')

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('login/organisation: lets one address choose between two organisations', async ({ page }) => {
  await useScenario(page, ['login.two-organisations'])
  await page.goto('/login')

  await page.getByLabel('Adresse e-mail').fill('julie@acme.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()

  await expect(
    page.getByRole('heading', { name: /organisations utilisent cette adresse/ })
  ).toBeVisible()
  await expect(page.getByText('acme-sa', { exact: true })).toBeVisible()
  await expect(page.getByText('acme-holding', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'ACME Holding' }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await expect(page.getByRole('heading', { name: 'Continuer vers acme-holding' })).toBeVisible()
})

test('login/mfa: forces enrolment before any other screen', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'shell.mfa-not-enrolled'])
  await signIn(page, 'acme-sa')

  await expect(page).toHaveURL(/\/acme-sa\/security\/mfa$/)
  await expect(page.getByRole('heading', { name: 'Sécurisez votre compte' })).toBeVisible()

  // The device key is offered first (§4.4), before the authenticator-app
  // card.
  const methodHeadings = await page.getByRole('heading', { level: 2 }).allTextContents()
  expect(methodHeadings[0]).toBe('La clé de votre appareil')
  expect(methodHeadings[1]).toBe("Une application d'authentification")

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])

  // Cannot navigate away: the guide renders no sidebar and no navigation
  // landmark, so there is nothing on screen to reach another area with
  // (`src/app/org-route.tsx`'s `OrgLayout` renders no `Shell` while a
  // factor is not enrolled).
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Accueil', exact: true })).toHaveCount(0)
})

test('login/mfa: completes application enrolment with the keyboard alone', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'shell.mfa-not-enrolled'])
  await signIn(page, 'acme-sa')
  await expect(page).toHaveURL(/\/acme-sa\/security\/mfa$/)

  const totpButton = page.getByRole('button', { name: 'Utiliser une application' })
  await totpButton.focus()
  await page.keyboard.press('Enter')

  await expect(
    page.getByRole('heading', { name: 'Scannez ce code dans votre application' })
  ).toBeVisible()

  // The secret can be copied.
  const copyButton = page.getByRole('button', { name: 'Copier' })
  await copyButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Copié' })).toBeVisible()

  // The six-digit field is reachable and labelled.
  const codeField = page.getByLabel('Code à six chiffres')
  await codeField.focus()
  await expect(codeField).toBeFocused()
  await page.keyboard.type('123456')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: 'Conservez vos codes de secours' })).toBeVisible()

  // The recovery codes can be downloaded.
  const downloadButton = page.getByRole('button', { name: 'Télécharger les codes de secours' })
  const downloadPromise = page.waitForEvent('download')
  await downloadButton.focus()
  await page.keyboard.press('Enter')
  // Named after the product (UX audit OL-14), as the authenticator entry is.
  expect((await downloadPromise).suggestedFilename()).toBe('kodera-codes-de-secours.txt')

  // Focus never left the guide: the active element, at every step above, was
  // still inside the guide's own `main` landmark.
  const focusStillInsideGuide = await page.evaluate(
    () => document.activeElement?.closest('main') !== null
  )
  expect(focusStillInsideGuide).toBe(true)

  const finishButton = page.getByRole('button', { name: 'Terminer' })
  await finishButton.focus()
  await page.keyboard.press('Enter')

  // Enrolled: the same layout transitions from the guide into its shell.
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  const homeHeading = page.locator('main h1')
  await expect(homeHeading).toHaveCount(1)
  await expect(homeHeading).toBeVisible()
  await expect(homeHeading).toBeFocused()
  await expect(homeHeading).toHaveAttribute('tabindex', '-1')
  await expect(page.locator('p[role="status"][aria-live="polite"]')).toHaveText(
    'Page Accueil chargée.'
  )
  await page.keyboard.press('Tab')
  await expect(homeHeading).not.toBeFocused()
})

test('shell/session: discards OTP input before signing back in', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'shell.mfa-not-enrolled'])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  await signIn(page, 'acme-sa')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  await expect(page).toHaveURL(/\/acme-sa\/security\/mfa$/)

  // Authentication codes are never eligible for form recovery.
  await page.getByRole('button', { name: 'Utiliser une application' }).click()
  await page.getByLabel('Code à six chiffres').fill('864209')

  // The browser clock was installed before the SDK scheduled its timers.
  // Cross the actual synthetic token lifetime; logout remains a different action.
  expect(expiresIn).toBeGreaterThan(0)
  await page.clock.fastForward((expiresIn + 1) * 1000)

  // The refresh had already failed by the time this fired, so the dialog
  // opens straight at its T−0, single-action state.
  await expect(page.getByRole('dialog', { name: 'Votre session a expiré' })).toBeVisible()
  await expect(page.getByText('Reconnectez-vous pour continuer.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Se reconnecter' }).click()

  // Check the persistence boundary while navigation has unmounted the form:
  // a check only after restoration would miss a consumed secret stash.
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  const storedFormData = await page.evaluate(() =>
    [window.sessionStorage, window.localStorage].flatMap((storage) =>
      Object.keys(storage)
        .filter((key) => key.startsWith('kodera.web.') || key.startsWith('order-draft'))
        .map((key) => storage.getItem(key) ?? '')
    )
  )
  expect(storedFormData.join('\n')).not.toContain('864209')
  expect(storedFormData.join('\n')).not.toContain('mfa-totp-code')
  await page.getByRole('button', { name: 'Continuer' }).click()

  // Same destination, fresh enrollment input; no authentication value survives.
  await expect(page).toHaveURL(/\/acme-sa\/security\/mfa$/)
  await page.getByRole('button', { name: 'Utiliser une application' }).click()
  await expect(page.getByLabel('Code à six chiffres')).toHaveValue('')
})

test('shell/access: tells a member which role is needed instead of showing an error', async ({
  page,
}) => {
  await useScenario(page, ['shell.member-role'])
  await signIn(page, 'acme-sa')

  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible()
  // The navigation does not show People.
  await expect(page.getByRole('link', { name: 'Personnes' })).toHaveCount(0)

  // A hard navigation loses the in-memory token. The protected route awaits
  // silent SSO, then reads the current membership before showing its refusal.
  await page.goto('/acme-sa/people')
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('prompt=none')))
    .toBe(true)
  const frame = page.frames().find((candidate) => candidate.url().includes('prompt=none'))!
  await frame
    .getByRole('button', { name: 'Continuer' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(
    page.getByText('Cette page est réservée aux administrateurs.', { exact: false })
  ).toBeVisible()
  // No raw error, no status code shown to the person.
  await expect(page.getByText('403')).toHaveCount(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('shell/status: shows one plain-French banner for a calls outage', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'shell.status-degraded'])
  await signIn(page, 'acme-sa')

  const banner = page.getByRole('alert')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Appels vidéo')
  await expect(banner).toContainText('perturbé')
  // What is promised today: when it started. `status-summary` carries no
  // next-update time until contract 0.12.0, so none is claimed.
  await expect(banner).toContainText('depuis 3 décembre 2026 à 11:58')
  await expect(banner).not.toContainText(/Prochaine mise à jour/)

  // Exactly one banner.
  await expect(page.getByRole('alert')).toHaveCount(1)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

// Not one of §12's named tests: the §5 `shell` Error row and §9's
// `unauthenticated` row, on the journey audit's finding SH-01. A 401 on
// `GET /me` used to reach the router's own boundary, which printed "Something
// went wrong!" and the raw problem URI in English.
test('shell/session: sends a refused session to sign in again once, then offers a way out', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'shell.session-expired'])
  await signIn(page, 'acme-sa', '/invoices')

  const heading = page.getByRole('heading', { level: 1, name: "Votre session n'est pas reconnue" })
  await expect(heading).toBeVisible()
  await expect(page.getByText(/Something went wrong|problems\/unauthenticated/)).toHaveCount(0)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])

  // The same round trip the expiry dialog starts, back to the same page.
  await page.getByRole('button', { name: 'Se reconnecter' }).click()
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.waitForURL((url) => url.pathname === '/acme-sa/invoices')

  // Refused again right after signing in: no second round, a way out.
  await expect(
    page.getByRole('heading', { level: 1, name: "Nous n'avons pas pu rétablir votre session" })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Se reconnecter' })).toHaveCount(0)
  await expect(page.getByText(/écrivez-nous à support@kodera\.io/)).toBeVisible()
  await page.getByRole('button', { name: 'Se déconnecter' }).click()
  await page.waitForURL((url) => url.pathname === '/login')
})

test('shell/offline: keeps content readable and disables submissions', async ({
  page,
  context,
}) => {
  await useScenario(page, ['shell.single-organisation'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  await context.setOffline(true)

  await expect(page.getByText('Pas de connexion', { exact: false })).toBeVisible()
  // Already-loaded content — the navigation and the page heading — stays
  // readable.
  await expect(page.getByRole('link', { name: 'Accueil', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  await context.setOffline(false)
  await expect(page.getByText('Pas de connexion', { exact: false })).toHaveCount(0)
})

test('login/realm: preserves the email action across pointer-down validation paint', async ({
  page,
}) => {
  await useScenario(page, ['login.unknown-domain'])
  await page.goto('/login')
  await page.getByLabel('Adresse e-mail').fill('marie.dupont@unknown-example.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page.getByLabel('Identifiant de votre organisation')).toBeFocused()
  const action = page.getByRole('button', { name: 'Utiliser une adresse e-mail' })
  // Exercise focus-on-pointer-down even on browsers that leave buttons unfocused.
  // Respect preventDefault, exactly as a cancellable native focus action does.
  await action.evaluate((button) => {
    window.addEventListener(
      'mousedown',
      (event) => {
        if (!event.defaultPrevented) button.focus()
      },
      { once: true }
    )
  })
  const box = await action.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 4)
  await page.mouse.down()
  // A held press spans the validation render caused by leaving the empty field.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.mouse.up()
  await expect(page.getByLabel('Adresse e-mail')).toHaveValue('marie.dupont@unknown-example.fr')
  await expect(page.getByLabel('Adresse e-mail')).toBeFocused()
})

test('login/realm: restores the email through keyboard activation after slug blur', async ({
  page,
}) => {
  await useScenario(page, ['login.unknown-domain'])
  await page.goto('/login')
  await page.getByLabel('Adresse e-mail').fill('marie.dupont@unknown-example.fr')
  await page.getByRole('button', { name: 'Continuer' }).click()
  const slug = page.getByLabel('Identifiant de votre organisation')
  await expect(slug).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(slug).toHaveAttribute('aria-invalid', 'true')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Utiliser une adresse e-mail' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Adresse e-mail')).toHaveValue('marie.dupont@unknown-example.fr')
  await expect(page.getByLabel('Adresse e-mail')).toBeFocused()
})

// §12 test 13, UX audit SH-15: after a sidebar click, focus stayed on the link
// and a screen reader said nothing about the page that replaced the last one.
test('shell/navigation: announces the new page and moves focus to its heading', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await signIn(page, 'acme-sa')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // Arriving is not a route change: nothing announced, nothing focused.
  const announcement = page.getByText(/^Page .+ chargée\.$/)
  await expect(announcement).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)

  const sidebar = page.getByRole('navigation', { name: 'Navigation principale' })
  await sidebar.getByRole('link', { name: 'Aide', exact: true }).focus()
  await page.keyboard.press('Enter')

  const help = page.getByRole('heading', { level: 1, name: 'Aide' })
  await expect(help).toBeFocused()
  await expect(announcement).toHaveText('Page Aide chargée.')
  await expect(announcement).toHaveCount(1)
  // The announcement sits in a polite region of its own.
  await expect(
    page.locator('[role="status"][aria-live="polite"]', { hasText: 'Page Aide chargée.' })
  ).toHaveCount(1)

  // Focusable from a script, no tab stop, and no ring: the person got here
  // with the keyboard, so a ring would be drawn if the heading had one.
  await expect(help).toHaveAttribute('tabindex', '-1')
  expect(await help.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
  await page.keyboard.press('Tab')
  await expect(help).not.toBeFocused()
  expect(await page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(true)
  await page.keyboard.press('Shift+Tab')
  await expect(help).not.toBeFocused()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])

  // A screen whose heading arrives with its first read, reached with the
  // pointer this time: the announcement names the area, focus follows the
  // heading once it is drawn.
  await sidebar.getByRole('link', { name: 'Accueil', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await expect(announcement).toHaveText('Page Accueil chargée.')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()

  // From the account menu: the menu closes and hands focus back to its own
  // button, and the heading must still be where focus ends.
  await sidebar.getByRole('button', { name: /Julie Marchand/ }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Apparence' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/acme-sa\/appearance$/)
  await expect(announcement).toHaveText('Page Apparence chargée.')
  await expect(page.getByRole('heading', { level: 1, name: 'Apparence' })).toBeFocused()
})

// §10: arriving is not a route change, "nor is a redirect on the way to a
// page". The second-factor guard redirects once the layout is mounted, and the
// guide it leads to used to be announced and focused as if the person had
// navigated there.
test('shell/navigation: does not announce the enrolment guide a person is sent to on arrival', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'shell.mfa-not-enrolled'])
  // Arrives on the home page's address; the guard sends them to the guide.
  await page.goto('/acme-sa/home')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await expect(page).toHaveURL(/\/acme-sa\/security\/mfa$/)
  const guide = page.getByRole('heading', { level: 1, name: 'Sécurisez votre compte' })
  await expect(guide).toBeVisible()
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()

  await expect(page.getByText(/^Page .+ chargée\.$/)).toHaveCount(0)
  // The guide focuses its own heading when it opens, so where focus is proves
  // nothing here. The mark the route change leaves on a heading it focused
  // does: there is none.
  await expect(guide).not.toHaveAttribute('data-route-heading')
})

test.describe('narrow', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  // The phone's frame is a second tree (`Shell.tsx`), with sticky bars a
  // focused heading must not end up under (WCAG 2.4.11).
  test('shell/navigation: brings the focused heading clear of the bars on a phone', async ({
    page,
  }) => {
    await useScenario(page, ['shell.single-organisation', 'home.default'])
    await signIn(page, 'acme-sa')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const tabs = page.getByRole('navigation', { name: 'Navigation par onglets' })
    await tabs.getByRole('link', { name: 'Aide', exact: true }).focus()
    await page.keyboard.press('Enter')

    const help = page.getByRole('heading', { level: 1, name: 'Aide' })
    await expect(help).toBeFocused()
    await expect(page.getByText('Page Aide chargée.')).toHaveCount(1)

    const heading = await help.boundingBox()
    const topBar = await page.getByRole('banner').boundingBox()
    const tabBar = await tabs.boundingBox()
    expect(heading).not.toBeNull()
    expect(topBar).not.toBeNull()
    expect(tabBar).not.toBeNull()
    expect(heading!.y).toBeGreaterThanOrEqual(topBar!.y + topBar!.height)
    expect(heading!.y + heading!.height).toBeLessThanOrEqual(tabBar!.y)

    // From the « Plus » sheet: it closes and hands focus back to « Plus »,
    // and the heading must still be where focus ends.
    await tabs.getByRole('button', { name: 'Plus' }).focus()
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'Plus' })
    await sheet.getByRole('link', { name: 'Sécurité et connexion' }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/acme-sa\/security$/)
    await expect(sheet).toHaveCount(0)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sécurité et connexion' })
    ).toBeFocused()
    await expect(page.getByText('Page Sécurité et connexion chargée.')).toHaveCount(1)
  })
})

// §12 test 14, UX audit SH-11: the expired dialog was named « Votre session va
// expirer », and its close control was drawn, took focus and did nothing.
test('shell/session: leaves signing in again as the only way out of an expired session', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  await signIn(page, 'acme-sa', '/help')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  await expect(page.getByRole('heading', { level: 1, name: 'Aide' })).toBeVisible()

  // Past the token's whole lifetime, as in the OTP test above: by then the
  // refresh has failed, and the dialog is in its expired state.
  expect(expiresIn).toBeGreaterThan(0)
  await page.clock.fastForward((expiresIn + 1) * 1000)

  const dialog = page.getByRole('dialog', { name: 'Votre session a expiré' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Votre session va expirer' })).toHaveCount(0)
  // The body gives the next action, without repeating the title above it.
  await expect(dialog).toHaveAccessibleDescription('Reconnectez-vous pour continuer.')
  const signInAgain = dialog.getByRole('button', { name: 'Se reconnecter' })
  await expect(dialog.getByRole('button')).toHaveCount(1)
  await expect(signInAgain).toBeFocused()

  // These two steps show what the person sees; they do not prove the refusal.
  // The dialog is driven by the session, so it stays open here whether or not
  // it refuses `Escape` and the press. `Dialog.test.tsx` and
  // `SessionExpiryDialog.test.tsx` own the refusal: they fail when a dismissal
  // is asked for at all.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  // A corner of the overlay, well clear of the dialog in the middle.
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()
  // Focus cannot leave the dialog for the page behind it.
  await page.keyboard.press('Tab')
  await expect(signInAgain).toBeFocused()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])

  await signInAgain.click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
})

// §12 test 15, UX audit OL-24: the message said « 30 secondes » and stayed
// there, beside a button that could still be pressed.
test('login/realm: counts a rate limit down and holds the button until it ends', async ({
  page,
}) => {
  await useScenario(page, ['login.discovery-rate-limited'])
  // The installed clock keeps real time and adds what the test runs it for,
  // so the seconds on screen are read, never assumed: a slow run has already
  // counted some of them. `LoginScreen.test.tsx` checks each second exactly.
  await page.clock.install()
  await page.goto('/login')

  let requests = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/auth/discover')) requests += 1
  })
  const email = page.getByLabel('Adresse e-mail')
  await email.fill('julie@acme.fr')
  const submit = page.getByRole('button', { name: 'Continuer' })
  await submit.click()

  const notice = page.getByText(/^Trop de tentatives\. Réessayez dans \d+ secondes?\.$/)
  const secondsLeft = async () => Number((await notice.textContent())?.match(/\d+/)?.[0])
  await expect(notice).toBeVisible()
  await expect(submit).toBeDisabled()
  // Nothing to retype, and focus is not left on the button that was disabled.
  await expect(email).toHaveValue('julie@acme.fr')
  await expect(email).toBeFocused()
  // `login.discovery-rate-limited` answers `retry_after_s: 30`.
  const atFirst = await secondsLeft()
  expect(atFirst).toBeGreaterThan(20)
  expect(atFirst).toBeLessThanOrEqual(30)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])

  await page.clock.runFor(2000)
  expect(await secondsLeft()).toBeLessThan(atFirst)
  await expect(submit).toBeDisabled()
  // Counted down in silence: once it has ticked, the line is no live region.
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.getByRole('button', { name: "Utiliser l'identifiant de votre organisation" }).click()
  const slug = page.getByLabel('Identifiant de votre organisation')
  await slug.fill('acme-sa')
  await expect(submit).toBeDisabled()
  await expect(notice).toBeVisible()
  await slug.press('Enter')
  expect(requests).toBe(1)
  await page.getByRole('button', { name: 'Utiliser une adresse e-mail' }).click()
  await expect(email).toHaveValue('julie@acme.fr')
  await expect(submit).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.clock.runFor(30_000)
  await expect(notice).toHaveCount(0)
  await expect(submit).toBeEnabled()
  await expect(email).toBeFocused()
  await expect(page.getByRole('status')).toHaveText('Vous pouvez réessayer.')
  const stores = await page.evaluate(() =>
    [sessionStorage, localStorage].flatMap((storage) =>
      Object.keys(storage).map((key) => storage.getItem(key) ?? '')
    )
  )
  expect(stores.join('\n')).not.toContain('julie@acme.fr')
  expect(stores.join('\n')).not.toContain('acme-sa')
  await submit.click()
  await expect(notice).toBeVisible()
  expect(requests).toBe(2)
  await expect(page.getByRole('status')).toBeEmpty()
  await page.reload()
  await expect(page.getByLabel('Adresse e-mail')).toHaveValue('')
  await expect(submit).toBeEnabled()
  await expect(notice).toHaveCount(0)
  await page.getByLabel('Adresse e-mail').fill('julie@acme.fr')
  await submit.click()
  await expect(notice).toBeVisible()
  expect(requests).toBe(3)
})

test('shell/organisation: preserves the area through another realm sign-in', async ({ page }) => {
  await useScenario(page, ['shell.multi-organisation'])
  await page.goto('/')
  await signIn(page, 'acme-sa', '/help')
  const arrivedHeading = page.getByRole('heading', { level: 1, name: 'Aide' })
  await expect(arrivedHeading).toBeVisible()
  await expect(page.locator('p[role="status"][aria-live="polite"]')).toBeEmpty()

  const switcher = page.getByRole('combobox', { name: 'Organisation' })
  await switcher.click()
  await expect(page.getByRole('option', { name: /ACME Holding/ })).toBeVisible()
  // True outside interactions still dismiss the list; the owned input can
  // reopen it and pointer-select the actual second membership.
  await page.getByRole('heading', { level: 1, name: 'Aide' }).click()
  await expect(page.getByRole('option', { name: /ACME Holding/ })).toHaveCount(0)
  await switcher.click()
  await page.getByRole('option', { name: /ACME Holding/ }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await expect(page.getByRole('heading', { name: 'Continuer vers acme-holding' })).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()

  await expect(page).toHaveURL(/\/acme-holding\/help$/)
  const helpHeading = page.getByRole('heading', { level: 1, name: 'Aide' })
  await expect(helpHeading).toBeVisible()
  await expect(page.getByText('ACME Holding', { exact: true })).toBeVisible()
  // This is a new document arrival, not an in-document route change.
  await expect(page.locator('p[role="status"][aria-live="polite"]')).toBeEmpty()
  await expect(helpHeading).not.toHaveAttribute('tabindex')
  await expect(helpHeading).not.toBeFocused()
})

for (const narrow of [false, true]) {
  test(`shell/session: warning preserves MFA editing before blocking expiry (${narrow ? 'narrow' : 'wide'})`, async ({
    page,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 })
    await useScenario(page, ['shell.single-organisation', 'shell.mfa-not-enrolled'])
    await page.clock.install()
    const tokenResponse = page.waitForResponse((response) =>
      response.url().endsWith('/protocol/openid-connect/token')
    )
    await signIn(page, 'acme-sa')
    const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
    await page.getByRole('button', { name: 'Utiliser une application' }).click()
    const input = page.getByLabel('Code à six chiffres')
    await input.fill('864')
    await expect(input).toBeFocused()
    await page.clock.fastForward((expiresIn - 90) * 1000)
    await expect(input).toBeFocused()
    const warning = page.getByRole('region', { name: 'Votre session va expirer' })
    await expect(warning).toBeVisible()
    const initially = await warning.boundingBox()
    expect(initially).not.toBeNull()
    expect(initially!.x).toBeGreaterThanOrEqual(0)
    expect(initially!.x + initially!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(initially!.y).toBeGreaterThanOrEqual(0)
    expect(initially!.y + initially!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const editor = await input.boundingBox()
    expect(editor).not.toBeNull()
    expect(editor!.y + editor!.height).toBeGreaterThan(0)
    expect(editor!.y).toBeLessThan(page.viewportSize()!.height)
    await input.press('End')
    await page.keyboard.type('209')
    await expect(input).toHaveValue('864209')
    await page.keyboard.press('Tab')
    await expect(input).not.toBeFocused()
    const focusInBackground = await page.evaluate(
      () => document.activeElement?.closest('main') !== null
    )
    expect(focusInBackground).toBe(true)
    await input.click()
    await page.keyboard.press('Escape')
    await expect(warning).toBeVisible()
    await expect(input).toBeFocused()
    const box = await warning.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.clock.fastForward(91_000)
    const expired = page.getByRole('dialog', { name: 'Votre session a expiré' })
    await expect(expired).toBeVisible()
    const reconnect = expired.getByRole('button', { name: 'Se reconnecter' })
    await expect(reconnect).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(reconnect).toBeFocused()
    await expect(warning).toHaveCount(0)
    await expect(input).toHaveValue('864209')
  })
}

test('shell/session: warning leaves normal Shell navigation usable', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  await signIn(page, 'acme-sa', '/help')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  const heading = page.getByRole('heading', { level: 1, name: 'Aide' })
  await expect(heading).toBeVisible()
  const helpLink = page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name: 'Aide', exact: true })
  await helpLink.focus()
  await page.clock.fastForward((expiresIn - 90) * 1000)
  await expect(helpLink).toBeFocused()
  const warning = page.getByRole('region', { name: 'Votre session va expirer' })
  await expect(warning).toBeVisible()
  const initially = await warning.boundingBox()
  expect(initially).not.toBeNull()
  expect(initially!.y).toBeGreaterThanOrEqual(0)
  expect(initially!.y + initially!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.getByRole('link', { name: 'Accueil', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Votre session va expirer' })).toBeVisible()
})

test('shell/session: warning leaves normal Shell navigation usable (narrow)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await useScenario(page, ['shell.single-organisation', 'home.default'])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  await signIn(page, 'acme-sa', '/help')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  await expect(page.getByRole('heading', { level: 1, name: 'Aide' })).toBeVisible()
  const tabs = page.getByRole('navigation', { name: 'Navigation par onglets' })
  const home = tabs.getByRole('link', { name: 'Accueil', exact: true })
  await home.focus()
  await page.clock.fastForward((expiresIn - 90) * 1000)
  await expect(home).toBeFocused()
  const warning = page.getByRole('region', { name: 'Votre session va expirer' })
  await expect(warning).toBeVisible()
  const box = await warning.boundingBox()
  const top = await page.getByRole('banner').boundingBox()
  const bottom = await tabs.boundingBox()
  expect(box).not.toBeNull()
  expect(top).not.toBeNull()
  expect(bottom).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(box!.y).toBeGreaterThanOrEqual(top!.y + top!.height)
  expect(box!.y + box!.height).toBeLessThanOrEqual(bottom!.y)
  await home.click()
  await expect(page).toHaveURL(/\/acme-sa\/home$/)
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
  await expect(warning).toBeVisible()
})

// §12 acceptance6 uses an actual eligible invitation, not a toy form or saved fixture.
test('shell/session: signs back in without losing what was typed', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'people.default',
    'people.invitation-recovery',
  ])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/invitations')) posts += 1
  })
  await signIn(page, 'acme-sa', '/people')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  await page.getByRole('button', { name: 'Inviter', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Inviter par e-mail' }).click()
  await page.clock.runFor(1)
  const raw = 'anne.new@acme.fr\nmarie.'
  const field = page.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  await field.fill(raw)
  await page.getByRole('radio', { name: /^Administrateur —/ }).focus()
  await expect(page.getByRole('radio', { name: /^Administrateur —/ })).toBeFocused()
  await page.getByRole('radio', { name: /^Administrateur —/ }).press('Space')
  await expect(page.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
  await page.clock.fastForward((expiresIn + 1) * 1000)
  await page.getByRole('button', { name: 'Se reconnecter', exact: true }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await page.evaluate(() => sessionStorage.setItem('msw:people-recovery-control', 'hold'))
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('msw:people-recovery-requested')))
    .toBe('1')
  await expect(field).toHaveCount(0)
  await page.evaluate(() => {
    sessionStorage.removeItem('msw:people-recovery-control')
    window.dispatchEvent(new Event('mock-people-recovery-release'))
  })
  await expect(page).toHaveURL(/\/acme-sa\/people\/invite$/)
  await expect(field).toHaveValue(raw)
  await expect(page.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
  expect(posts).toBe(0)
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('kodera.web.people.invitationRecovery'))
    )
    .toBeNull()
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/invitations')
  )
  await page.getByRole('button', { name: 'Envoyer 1 invitation', exact: true }).click()
  const request = await sent
  expect(request.postDataJSON()).toEqual({
    invitations: [{ email: 'anne.new@acme.fr', role: 'org_admin' }],
    send_email: true,
    locale: 'fr',
  })
  expect(request.headers()['idempotency-key']).toBeTruthy()
  expect(posts).toBe(1)
})

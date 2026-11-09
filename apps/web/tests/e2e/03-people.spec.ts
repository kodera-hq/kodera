// docs/specs/03-people.md §12 — the twelve acceptance tests, titled verbatim.
// Given = `useScenario` plus navigation (`signIn`), When = user actions,
// Then = assertions on the rendered French (docs/dev/TESTING.md).

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { signIn } from './support/signIn'
import { useScenario, useScenario as applyScenario } from './support/useScenario'
import { SUPPORT_EMAIL } from '../../src/app/supportContact'

const ORG = 'acme-sa'
/** The caller's own membership, as the generated `/me` example names it. */
const CALLER_MEMBERSHIP_ID = '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c'

test('people/list: offers two ways to add the first colleagues', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'people.empty'])
  await signIn(page, ORG, '/people')

  await expect(page.getByRole('heading', { name: "Personne pour l'instant" })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Inviter par e-mail' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Importer un CSV' })).toBeVisible()
  await expect(page.getByRole('columnheader')).toHaveCount(0)

  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
  ).toEqual([])
})

test('people/invite: accepts a spreadsheet paste as separate addresses', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'people.default'])
  await signIn(page, ORG, '/people/invite')

  const field = page.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  await field.fill('julie.leroy@acme.fr, marc.petit@acme.fr\nsamir.benali@acme.fr')
  await field.blur()

  await expect(page.getByText('3 adresses reconnues · 0 en double · 0 invalides')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Envoyer 3 invitations' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retirer samir.benali@acme.fr' })).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('people/invite: retries only the addresses that failed', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'people.default',
    'people.invite-partial-failure',
  ])
  await signIn(page, ORG, '/people/invite')

  await page
    .getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
    .fill('anne@acme.fr\nbad@acme.fr\npaul@acme.fr\nmarc.petit@acme.fr')
  await page.getByRole('button', { name: 'Envoyer 4 invitations' }).click()

  const result = page.getByRole('region', { name: "2 invitations envoyées, 2 n'ont pas abouti" })
  await expect(result.getByRole('listitem').filter({ hasText: 'bad@acme.fr' })).toContainText(
    'Adresse invalide'
  )
  await expect(
    result.getByRole('listitem').filter({ hasText: 'marc.petit@acme.fr' })
  ).toContainText('Déjà membre de votre organisation')

  const retry = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/invitations')
  )
  await page.getByRole('button', { name: "Réessayer l'adresse en échec" }).click()
  const sent = (await retry).postDataJSON() as { invitations: { email: string }[] }
  expect(sent.invitations.map((row) => row.email)).toEqual(['bad@acme.fr'])

  // Every remaining address went through: the drawer closes on the
  // Invitations tab, where the retried address now waits.
  await expect(
    page.getByRole('table', { name: 'Invitations' }).getByRole('row', { name: /bad@acme.fr/ })
  ).toBeVisible()
})

test('people/members: prevents the last owner from removing themselves', async ({ page }) => {
  await useScenario(page, ['shell.single-organisation', 'people.last-owner'])
  await signIn(page, ORG, `/people/${CALLER_MEMBERSHIP_ID}`)

  const drawer = page.getByRole('dialog', { name: 'Julie Marchand' })
  await expect(drawer.getByRole('combobox', { name: 'Rôle' })).toBeDisabled()
  await expect(drawer.getByRole('button', { name: "Retirer de l'organisation" })).toBeDisabled()
  await expect(
    drawer.getByText(
      "Votre organisation doit conserver au moins un propriétaire. Nommez quelqu'un d'autre avant de modifier ce rôle."
    )
  ).toHaveCount(2)
})

test('people/members: confirms a removal by naming the person and the consequence', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'people.default'])
  await signIn(page, ORG, '/people')

  const table = page.getByRole('table', { name: 'Personnes' })
  const row = table.getByRole('row', { name: /Marc Petit/ })
  const openRemoval = async () => {
    await row.getByRole('button', { name: 'Actions pour Marc Petit' }).click()
    await page.getByRole('menuitem', { name: "Retirer de l'organisation" }).click()
  }

  await openRemoval()
  const confirm = page.getByRole('dialog', { name: 'Retirer Marc Petit ?' })
  await expect(confirm).toContainText('Marc Petit ne pourra plus utiliser la console')
  await expect(confirm).toContainText("Son accès à Visio et à Docs n'est pas encore coupé")
  await expect(confirm.getByRole('heading', { name: 'Retirer Marc Petit ?' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(row).toBeVisible()

  await openRemoval()
  await page.getByRole('button', { name: 'Retirer Marc Petit' }).click()
  await expect(table.getByRole('row', { name: /Marc Petit/ })).toHaveCount(0)
  await expect(table.getByRole('row', { name: /Camille Bernard/ })).toBeVisible()
})

test('people/members: keeps billing and ownership grants owner-only', async ({ browser }) => {
  const openRoleControl = async (page: Page) => {
    await signIn(page, ORG, '/people')
    await page.getByRole('button', { name: 'Marc Petit', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'Marc Petit' })
    await drawer.getByRole('combobox', { name: 'Rôle' }).click()
  }

  const owner = await browser.newPage()
  await useScenario(owner, ['shell.single-organisation', 'people.owner-role'])
  await openRoleControl(owner)
  await expect(owner.getByRole('option')).toHaveText([
    'Propriétaire',
    'Administrateur',
    'Facturation',
    'Membre',
  ])
  await owner.getByRole('option', { name: 'Propriétaire' }).click()
  await expect(
    owner.getByRole('dialog', { name: 'Nommer Marc Petit propriétaire ?' })
  ).toContainText('la facturation, les rôles et la suppression')
  await owner.close()

  const admin = await browser.newPage()
  await useScenario(admin, ['shell.single-organisation', 'people.default'])
  await openRoleControl(admin)
  await expect(admin.getByRole('option')).toHaveText(['Administrateur', 'Membre'])
  await admin.close()
})

interface PrintSnapshot {
  sheetVisible: boolean
  sheetText: string
  headingVisible: boolean
  height: number
}

/**
 * The print isolation lives only for the `window.print()` call, so the dialog
 * is replaced by a snapshot of what the paper holds at that moment. With the
 * print media emulated before the click, the snapshot reads the print layout.
 */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { __printed: PrintSnapshot[] }
    target.__printed = []
    window.print = () => {
      const sheet = document.querySelector<HTMLElement>('[data-print-sheet]')
      target.__printed.push({
        sheetVisible: sheet?.checkVisibility() ?? false,
        sheetText: sheet?.textContent ?? '',
        headingVisible: Array.from(document.querySelectorAll('h1')).some((h) =>
          h.checkVisibility()
        ),
        height: document.documentElement.scrollHeight,
      })
    }
  })
}

async function printed(page: Page): Promise<PrintSnapshot[]> {
  return page.evaluate(() => (window as unknown as { __printed: PrintSnapshot[] }).__printed)
}

test('people/on-site: prints a sheet with both a code to scan and a code to type', async ({
  page,
}) => {
  await stubPrint(page)
  await useScenario(page, ['shell.single-organisation', 'people.enrolment-active'])
  await signIn(page, ORG, '/people/on-site')

  // The sheet already on the wall: used-of-total and expiry.
  await expect(page.getByText(/^12 places · 5 utilisées · expire le/)).toBeVisible()

  // Its code was shown once, at creation; a sheet made now can be printed.
  await page.getByRole('button', { name: 'Créer 12 places' }).click()
  const sheet = page.getByRole('region', { name: /Rejoignez la visio de/ })
  const code =
    (await sheet
      .getByText(/^enr_\w+$/)
      .first()
      .textContent()) ?? ''
  expect(code).not.toBe('')
  await expect(
    sheet.getByRole('img', { name: `Code QR à scanner. Code à saisir : ${code}` })
  ).toBeVisible()
  await expect(sheet.getByText(/^Valable jusqu'au/)).toBeVisible()

  // Print view: only the sheet, the code as text, one A4 page (96 dpi).
  await page.emulateMedia({ media: 'print' })
  await sheet.getByRole('button', { name: 'Imprimer' }).click()
  const [paper, ...more] = await printed(page)
  expect(more).toEqual([])
  expect(paper?.sheetVisible).toBe(true)
  expect(paper?.sheetText).toContain(code)
  expect(paper?.headingVisible).toBe(false)
  expect(paper?.height).toBeLessThanOrEqual(1123)

  // Once the print is over, printing the page prints the page again.
  await expect(page.getByRole('heading', { level: 1, name: 'Personnes' })).toBeVisible()
})

test('people/on-site: still gives a usable code when the image fails', async ({ page }) => {
  await stubPrint(page)
  await useScenario(page, [
    'shell.single-organisation',
    'people.owner-role',
    'people.enrolment-qr-failed',
  ])
  await signIn(page, ORG, '/people/on-site')

  await page.getByRole('button', { name: 'Créer 12 places' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: "Le code à scanner n'a pas pu s'afficher." })
  ).toContainText("Le code à scanner n'a pas pu s'afficher.")
  const sheet = page.getByRole('region', { name: /Rejoignez la visio de/ })
  await expect(sheet.getByText('enr_7K4P92MB0000', { exact: true })).toBeVisible()
  await expect(sheet.getByText('https://app.kodera.io/enrol#enr_7K4P92MB0000')).toBeVisible()

  await page.emulateMedia({ media: 'print' })
  await sheet.getByRole('button', { name: 'Imprimer' }).click()
  const [paper] = await printed(page)
  expect(paper?.sheetVisible).toBe(true)
  expect(paper?.sheetText).toContain('enr_7K4P92MB0000')
  expect(paper?.headingVisible).toBe(false)
})

const CSV = {
  name: 'equipe.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'Prénom;Nom;Adresse mail;Service\nJulie;Leroy;julie.leroy@acme.fr;Chantier\n'
  ),
}

test('people/import: separates ready, duplicate and invalid rows before importing', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'people.owner-role', 'people.import-mixed'])
  await signIn(page, ORG, '/people/import')

  await page.locator('input[type="file"]').setInputFiles(CSV)
  await expect(page.getByText('Nous avons trouvé 124 lignes.')).toBeVisible()
  await expect(
    page.getByRole('combobox', { name: 'Champ pour la colonne Adresse mail' })
  ).toContainText('E-mail')

  const counters = page.getByRole('list').filter({ hasText: 'prêtes à être invitées' })
  await expect(counters.getByRole('listitem')).toHaveText([
    '118 prêtes à être invitées',
    '4 déjà membres — elles seront ignorées',
    '2 adresses en double dans le fichier — une seule sera conservée',
    '0 adresses illisibles',
  ])
  await expect(page.getByRole('button', { name: 'Inviter 118 personnes' })).toBeEnabled()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('people/import: lists the failed rows with their line number and reason', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'people.owner-role',
    'people.import-execution-partial',
  ])
  await signIn(page, ORG, '/people/import')

  await page.locator('input[type="file"]').setInputFiles(CSV)
  await page.getByRole('button', { name: 'Inviter 118 personnes' }).click()

  await expect(page.getByRole('heading', { name: '114 invitations envoyées' })).toBeVisible()
  const failures = page.getByRole('table', { name: 'Lignes en échec' })
  const line42 = failures.getByRole('row', { name: /ligne 42/ })
  await expect(line42).toContainText('jean.martin@acme..fr')
  await expect(line42).toContainText('Adresse invalide')
  await expect(failures.getByRole('row', { name: /ligne 77/ })).toContainText(
    "Cette boîte aux lettres n'existe pas."
  )
  await expect(failures.getByRole('row', { name: /ligne (42|77|91|103)/ })).toHaveCount(4)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Télécharger les lignes en échec' }).click()
  expect((await download).suggestedFilename()).toBe('lignes-en-echec.csv')
})

test('people/import: renders durable counts after personal staging data is scrubbed', async ({
  page,
}) => {
  await useScenario(page, [
    'shell.single-organisation',
    'people.owner-role',
    'people.import-completed-scrubbed',
  ])
  await signIn(page, ORG, '/people/import/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d')

  await expect(page.getByRole('heading', { name: '118 invitations envoyées' })).toBeVisible()
  await expect(page.getByText('equipe.csv')).toHaveCount(0)
  await expect(page.getByText(/@acme\.fr/)).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Lignes en échec' })).toHaveCount(0)
})

test('people/import: names the limit when the file is too large', async ({ page }) => {
  await useScenario(page, [
    'shell.single-organisation',
    'people.owner-role',
    'people.import-file-too-large',
  ])
  await signIn(page, ORG, '/people/import')

  await page.locator('input[type="file"]').setInputFiles(CSV)
  await expect(
    page.getByText(
      'Le fichier dépasse la limite de 2 Mo ou de 5 000 lignes. Découpez-le en plusieurs fichiers.'
    )
  ).toBeVisible()
  await expect(page.getByText('CSV · 5 000 lignes maximum · 2 Mo')).toBeVisible()
  await expect(page.locator('input[type="file"]')).toBeEnabled()
})

test('people/recovery: preserves an unsent invitation through expired Browser Back', async ({
  page,
}) => {
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
  await signIn(page, ORG, '/people')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  await page.getByRole('button', { name: 'Inviter', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Inviter par e-mail' }).click()
  await page.clock.runFor(1)
  const field = page.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  const raw = 'someone.new@acme.fr\nunfinished@'
  await field.fill(raw)
  await page.getByRole('radio', { name: /^Administrateur —/ }).focus()
  await expect(page.getByRole('radio', { name: /^Administrateur —/ })).toBeFocused()
  await page.getByRole('radio', { name: /^Administrateur —/ }).press('Space')
  await expect(page.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
  await page.clock.fastForward((expiresIn + 1) * 1000)
  await expect(page.getByRole('dialog', { name: 'Votre session a expiré' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/people\/invite$/)
  await expect(field).toHaveValue(raw)
  await expect(page.getByRole('radio', { name: /^Administrateur —/ })).toBeChecked()
  expect(posts).toBe(0)
})

async function reachUnsentInvitationSignIn(page: Page, extra: string[] = []) {
  await applyScenario(page, [
    'shell.single-organisation',
    'people.default',
    'people.invitation-recovery',
    ...extra,
  ])
  await page.clock.install()
  const tokenResponse = page.waitForResponse((response) =>
    response.url().endsWith('/protocol/openid-connect/token')
  )
  await signIn(page, ORG, '/people/invite')
  const { expires_in: expiresIn } = (await (await tokenResponse).json()) as { expires_in: number }
  const field = page.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  await field.fill('private unfinished@\nsecond@')
  await page.clock.fastForward((expiresIn + 1) * 1000)
  await page.getByRole('button', { name: 'Se reconnecter', exact: true }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  const saved = await page.evaluate(() =>
    sessionStorage.getItem('kodera.web.people.invitationRecovery')
  )
  expect(saved).not.toBeNull()
  expect(JSON.parse(saved!).draft).toEqual({
    text: 'private unfinished@\nsecond@',
    role: 'org_member',
    open: true,
  })
  return field
}

test('people/recovery: discards the draft for a changed fresh Core owner', async ({ page }) => {
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/invitations')) posts++
  })
  const field = await reachUnsentInvitationSignIn(page)
  await page.evaluate(() =>
    sessionStorage.setItem('msw:people-recovery-control', 'changed-core-owner')
  )
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(page).toHaveURL(/\/acme-sa\/people\/invite$/)
  await expect(field).toHaveValue('')
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('kodera.web.people.invitationRecovery'))
    )
    .toBeNull()
  expect(posts).toBe(0)
})

test('people/recovery: explicit logout clears a production-saved draft after denied consumption', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem
    const originalRemove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (
        key === 'kodera.web.people.invitationRecovery' &&
        originalGet.call(this, 'msw:deny-invitation-remove') === '1'
      )
        throw new DOMException('denied', 'SecurityError')
      return originalRemove.call(this, key)
    }
  })
  const field = await reachUnsentInvitationSignIn(page)
  await page.evaluate(() => {
    sessionStorage.setItem('msw:deny-invitation-remove', '1')
    sessionStorage.setItem('unrelated-control', 'keep')
  })
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(field).toHaveValue('private unfinished@\nsecond@')
  expect(
    await page.evaluate(() => sessionStorage.getItem('kodera.web.people.invitationRecovery'))
  ).not.toBeNull()
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.clock.runFor(1)
  await expect(page).toHaveURL(/\/acme-sa\/people$/)
  await expect(page.getByRole('dialog', { name: 'Inviter des personnes' })).toHaveCount(0)
  await page.evaluate(() => sessionStorage.removeItem('msw:deny-invitation-remove'))
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('button', { name: /^Julie/ })
    .click()
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem('kodera.web.people.invitationRecovery'))
    )
    .toBeNull()
  expect(await page.evaluate(() => sessionStorage.getItem('unrelated-control'))).toBe('keep')
})

test('people/recovery: never reopens an attempted batch after denied removal and fresh sign-in', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem
    const remove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (
        key === 'kodera.web.people.invitationRecovery' &&
        get.call(this, 'msw:deny-invitation-remove') === '1'
      )
        throw new DOMException('denied', 'SecurityError')
      return remove.call(this, key)
    }
  })
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/invitations')) posts++
  })
  const field = await reachUnsentInvitationSignIn(page, ['people.invite-all-rejected'])
  await page.evaluate(() => sessionStorage.setItem('msw:deny-invitation-remove', '1'))
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(field).toHaveValue('private unfinished@\nsecond@')
  await field.fill('new@example.test')
  await page.getByRole('button', { name: 'Envoyer 1 invitation', exact: true }).click()
  await expect(
    page.getByRole('region', { name: "0 invitations envoyées, 1 n'ont pas abouti" })
  ).toBeVisible()
  expect(posts).toBe(1)
  await page.clock.fastForward(301_000)
  await page.getByRole('button', { name: 'Se reconnecter', exact: true }).click()
  await expect(page).toHaveURL(/__mock-idp\/authorize/)
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await expect(field).toHaveValue('')
  await expect(page.getByRole('radio', { name: /^Membre —/ })).toBeChecked()
  expect(posts).toBe(1)
})

test('people/support: quota contact keeps the invitation and keyboard focus inside its drawer', async ({
  page,
}) => {
  await useScenario(page, ['shell.single-organisation', 'people.owner-role', 'people.seat-limit'])
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/invitations')) posts++
  })
  await signIn(page, ORG, '/people/invite')
  const field = page.getByRole('textbox', { name: 'Adresses e-mail, une par ligne' })
  await field.fill('private.synthetic@example.test')
  await page.getByRole('button', { name: 'Envoyer 1 invitation', exact: true }).click()
  const contact = page.getByRole('link', { name: 'Nous écrire', exact: true })
  await expect(contact).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
  await expect(
    page
      .getByRole('dialog', { name: 'Inviter des personnes' })
      .getByText(`Cette invitation n'a pas pu être créée. Écrivez-nous à ${SUPPORT_EMAIL}.`, {
        exact: true,
      })
  ).toBeVisible()
  await page.getByRole('radio', { name: /^Membre —/ }).focus()
  await page.keyboard.press('Tab')
  await expect(contact).toBeFocused()
  // Keep the native mail handler closed while exercising the real keyboard
  // activation and any application click handler.
  await contact.evaluate((element) =>
    element.addEventListener('click', (event) => event.preventDefault(), { once: true })
  )
  await page.keyboard.press('Enter')
  await expect(field).toHaveValue('private.synthetic@example.test')
  await expect(page).toHaveURL(/\/people\/invite$/)
  await expect(page.getByRole('dialog', { name: 'Inviter des personnes' })).toBeVisible()
  expect(posts).toBe(1)
})

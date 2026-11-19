import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

interface SessionGateStatus {
  ownsFetch: boolean
  tokenArmed: boolean
  coreArmed: boolean
  tokenStarted: number
  tokenEntered: number
  tokenHeld: number
  coreEntered: number
  coreHeld: number
  coreHeldAfterTokenRelease: number
  abortListeners: number
  failure: string | null
}
interface SessionFetchGate {
  armBoth(): void
  status(): SessionGateStatus
  releaseTokenOnly(): void
  releaseCoreOnly(): void
  cleanup(): void
}
declare global {
  interface Window {
    __healthySessionFetchGate?: SessionFetchGate
  }
}

async function installSessionFetchGate(page: Page) {
  // Core captures fetch when its client is created. Install before login, unarmed.
  await page.addInitScript(() => {
    if (window.top !== window) return
    const original = window.fetch
    type Kind = 'token' | 'core'
    type Cell = { kind: Kind; afterToken: boolean; release(): void; listening(): boolean }
    const cells = new Set<Cell>()
    let active = false,
      tokenArmed = false,
      coreArmed = false,
      tokenReleased = false
    let total = 0,
      tokenStarted = 0,
      tokenEntered = 0,
      coreEntered = 0
    let failure: string | null = null
    function release(kind?: Kind) {
      for (const cell of [...cells]) if (kind === undefined || cell.kind === kind) cell.release()
    }
    function refuse(code: string) {
      failure ??= code
      tokenArmed = false
      coreArmed = false
      release()
    }
    function kindOf(url: URL, method: string): Kind | undefined {
      if (url.origin !== window.location.origin || url.search || url.hash) return undefined
      if (
        method === 'POST' &&
        url.pathname === '/auth/realms/community/protocol/openid-connect/token'
      )
        return 'token'
      if (method === 'GET' && url.pathname === '/api/v1/me') return 'core'
      return undefined
    }
    const wrapper: typeof window.fetch = async (...args) => {
      const [input, init] = args
      const watching = active
      const request = input instanceof Request ? input : undefined
      const overrideSignal = init?.signal
      // Snapshot before native fetch: undefined inherits; null explicitly overrides.
      const signal = overrideSignal === undefined ? request?.signal : overrideSignal
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
      let kind: Kind | undefined
      try {
        kind = kindOf(new URL(request?.url ?? String(input), window.location.href), method)
      } catch {
        /* An invalid native request still follows the original fetch path. */
      }
      const afterToken = tokenReleased
      if (watching && kind === 'token') {
        if (tokenStarted === 8) refuse('response-storm')
        else tokenStarted++
      }
      // Preserve original arguments, native errors, MSW, and the SDK transport.
      const response = (await Reflect.apply(original, window, args)) as Response
      if (
        !watching ||
        !active ||
        failure !== null ||
        kind === undefined ||
        !(kind === 'token' ? tokenArmed : coreArmed)
      )
        return response
      let responseKind: Kind | undefined
      try {
        responseKind = kindOf(new URL(response.url), method)
      } catch {
        /* Refused below. */
      }
      if (response.status !== 200 || responseKind !== kind) {
        refuse('unexpected-response')
        return response
      }
      if (total === 8) {
        refuse('response-storm')
        return response
      }
      total++
      if (kind === 'token') tokenEntered++
      else coreEntered++
      const heldKind = kind
      return new Promise<Response>((resolve, reject) => {
        let settled = false,
          listening = false
        const cell: Cell = {
          kind: heldKind,
          afterToken,
          release: () => finish(false),
          listening: () => listening,
        }
        const abort = () => finish(true)
        function finish(aborted: boolean) {
          if (settled) return
          settled = true
          cells.delete(cell)
          if (listening) {
            signal?.removeEventListener('abort', abort)
            listening = false
          }
          if (aborted) reject(signal?.reason)
          else resolve(response)
        }
        cells.add(cell)
        if (signal !== undefined && signal !== null) {
          signal.addEventListener('abort', abort, { once: true })
          listening = true
          // Covers an abort before/between listener registration and this check.
          if (signal.aborted) abort()
        }
      })
    }
    window.fetch = wrapper
    window.__healthySessionFetchGate = {
      armBoth() {
        if (active || failure !== null || window.fetch !== wrapper) {
          refuse('invalid-arm')
          return
        }
        active = true
        tokenArmed = true
        coreArmed = true
      },
      status() {
        const current = [...cells]
        return {
          ownsFetch: window.fetch === wrapper,
          tokenArmed,
          coreArmed,
          tokenStarted,
          tokenEntered,
          tokenHeld: current.filter((cell) => cell.kind === 'token').length,
          coreEntered,
          coreHeld: current.filter((cell) => cell.kind === 'core').length,
          coreHeldAfterTokenRelease: current.filter(
            (cell) => cell.kind === 'core' && cell.afterToken
          ).length,
          abortListeners: current.filter((cell) => cell.listening()).length,
          failure,
        }
      },
      releaseTokenOnly() {
        if (!tokenArmed || !coreArmed) {
          refuse('invalid-token-release')
          return
        }
        tokenArmed = false
        tokenReleased = true
        release('token')
      },
      releaseCoreOnly() {
        if (tokenArmed || !tokenReleased || !coreArmed) {
          refuse('invalid-core-release')
          return
        }
        coreArmed = false
        release('core')
      },
      cleanup() {
        active = false
        tokenArmed = false
        coreArmed = false
        release()
        if (window.fetch === wrapper) window.fetch = original
      },
    }
  })
}

async function sessionGate(
  page: Page,
  action?: 'armBoth' | 'releaseTokenOnly' | 'releaseCoreOnly' | 'cleanup'
) {
  return page.evaluate((action) => {
    const gate = window.__healthySessionFetchGate
    if (gate === undefined) throw new Error('Session response gate is not installed.')
    if (action !== undefined) gate[action]()
    return gate.status()
  }, action)
}

async function login(page: Page) {
  await page.goto('/login?demo=1&org=community')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.waitForURL(/\/community\/workspace$/)
  await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  await expect(page.getByText('community.kodera.io', { exact: true }).first()).toBeVisible()
}
async function menu(page: Page, action: string, rail = false) {
  const triggers = page.getByRole('button', { name: /changer d’organisation/ })
  await (rail ? triggers.first() : triggers.last()).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

test('community sidebar, both menus, appearance and product dialogs are usable', async ({
  page,
}, info) => {
  await login(page)
  for (const category of ['Community', 'Core Kodera', 'Design Partners']) {
    await expect(page.getByRole('button', { name: category, exact: true })).toBeVisible()
  }
  await expect(page.getByText('Équipe cœur Kodera', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rechercher', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Configurer un espace', exact: true })).toHaveCount(
    0
  )
  for (const [name, theme] of [
    ['Clair', 'light'],
    ['Sombre', 'dark'],
    ['Noir', 'black'],
  ] as const) {
    await menu(page, 'Réglages de l’espace…', true)
    await page.getByRole('tab', { name: 'Apparence & thèmes', exact: true }).click()
    for (const cardLabel of ['Automatique', 'Ciel', 'Ciel nuit', 'Clair', 'Sombre', 'Noir']) {
      await expect(page.getByRole('button', { name: cardLabel, exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name, exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.screenshot({
      path: info.outputPath(`workspace-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    })
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(accessibility.violations, `Workspace accessibility in ${theme}`).toEqual([])
  }
  await menu(page, 'Réglages de l’espace…')
  await page.getByRole('tab', { name: 'Apparence & thèmes', exact: true }).click()
  await page.getByRole('button', { name: 'Ouvrir Theme Studio', exact: true }).click()
  await expect(page.getByTestId('theme-share-code-input')).toBeVisible()
  await page.getByTestId('theme-share-to-channel-btn').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('log')).toContainText('kodera-theme:v1:')
  await menu(page, 'Réglages de l’espace…', true)
  await page.getByRole('tab', { name: 'Connecteurs & extensions', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Frame.io')
  await page.keyboard.press('Escape')
  await menu(page, 'Réglages de l’espace…')
  await page.getByRole('tab', { name: 'Hébergement & administration', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Mode actuel')
  await page.keyboard.press('Escape')
})

test('channels, messages, reactions, threads, invitations and notes work together', async ({
  page,
}, info) => {
  await login(page)
  await page.getByRole('button', { name: 'Créer un salon dans Community', exact: true }).click()
  await page.getByLabel('Nom du salon', { exact: true }).fill('qa-discussion')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'qa-discussion', exact: true })).toBeVisible()
  const composer = page.getByRole('textbox', { name: 'Message dans #qa-discussion', exact: true })
  await composer.fill('Shared browser acceptance message')
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Shared browser acceptance message')
  await page.getByRole('button', { name: 'Ajouter une réaction', exact: true }).last().click()
  await page.getByRole('button', { name: /👍/ }).first().click()
  await expect(page.getByRole('log')).toContainText('👍')
  await page
    .getByRole('button', { name: /Actions du message/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: 'Ouvrir le fil', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Répondre au fil', exact: true })
    .fill('Thread acceptance reply')
  await page.getByRole('button', { name: 'Répondre', exact: true }).click()
  await expect(page.getByText('Thread acceptance reply', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Inviter', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Identifiant Matrix', exact: true })
    .fill('@qa:matrix.example')
  await page.getByRole('button', { name: 'Envoyer l’invitation Matrix', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Invitation Matrix envoyée')
  for (const [name, prefix] of [
    ['Lien universel Matrix (matrix.to)', 'https://matrix.to/'],
    ['URI native Matrix', 'matrix:'],
  ] as const) {
    await page.getByRole('button', { name: `Copier : ${name}`, exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
  }
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Membres', exact: true }).click()
  await expect(
    page
      .getByRole('complementary', { name: 'Membres', exact: true })
      .getByText('Qa', { exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await page.getByRole('button', { name: 'Nouveau document', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Documents du salon' }).click()
  await page.getByLabel('Titre du document', { exact: true }).fill('QA decision')
  await page
    .getByLabel('Source Markdown', { exact: true })
    .fill('## Decision\nBrowser verified publication')
  await page.getByRole('button', { name: 'Publier dans le salon', exact: true }).click()
  await expect(page.getByText('Document publié dans le salon.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('QA decision')
  await expect(page.getByRole('log')).toContainText('Ouvrir dans Docs')
  await page.screenshot({ path: info.outputPath('channel-published.png'), fullPage: true })
})

test('created workspaces switch without losing the previous conversation', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Créer un salon dans Community', exact: true }).click()
  await page.getByLabel('Nom du salon', { exact: true }).fill('retained-channel')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Message dans #retained-channel', exact: true })
    .fill('Retain across workspace switch')
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click()
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await page.getByRole('button', { name: 'Nouveau document', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Documents du salon' }).click()
  await page.getByLabel('Titre du document', { exact: true }).fill('Retained note')
  await menu(page, '+ Créer ou configurer un nouvel espace')
  await page.getByLabel('Nom de l’espace', { exact: true }).fill('QA Studio')
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('button', { name: 'Continuer', exact: true }).click()
  await page.getByRole('button', { name: 'Ouvrir l’espace', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForURL(/\/qa-studio\/workspace/)
  await expect(page.getByRole('button', { name: /QA Studio, changer/ }).first()).toBeVisible()
  await page
    .getByRole('button', { name: /changer d’organisation/ })
    .last()
    .click()
  await page
    .getByRole('menuitemradio', { name: 'Kodera Community Communauté & Support', exact: true })
    .click()
  await page.waitForURL(/\/community\/workspace/)
  await page.getByRole('link', { name: 'retained-channel', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Retain across workspace switch')
  await page.getByRole('button', { name: 'Docs', exact: true }).click()
  await expect(page.getByLabel('Titre du document', { exact: true })).toHaveValue('Retained note')
})

test('console pages remain community-scoped and return to Messages', async ({ page }) => {
  await login(page)
  for (const route of ['home', 'people', 'status', 'security', 'appearance', 'support']) {
    await page.goto(`/community/${route}${route === 'support' ? '?topic=capacity' : ''}`)
    if (route === 'support')
      await expect(page).toHaveURL(/\/community\/help\?topic=capacity$/, { timeout: 20_000 })
    await expect(page.getByRole('navigation', { name: 'Modules', exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Kodera Community', { exact: true }).first()).toBeVisible()
    await expect(page.locator('body')).not.toContainText(
      /Groupe Vercelli|Inès Kaci|138 membres|groupe-vercelli\.fr/
    )
    await page.getByRole('link', { name: 'Messages', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeVisible()
  }
})

test('a healthy session stays unobstructed after one minute and keyboard focus', async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  await installSessionFetchGate(page)
  let completed = false
  try {
    await login(page)
    expect(await sessionGate(page)).toMatchObject({ ownsFetch: true, failure: null })
    await sessionGate(page, 'armBoth')
    await page.waitForTimeout(61_000)
    // Returning focus renews once, even after a minute without a periodic polling loop.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    // Keep the actual token response pending through another focus: one SDK renewal.
    await expect.poll(async () => (await sessionGate(page)).tokenHeld).toBeGreaterThan(0)
    expect(await sessionGate(page)).toMatchObject({
      tokenStarted: 1,
      tokenEntered: 1,
      failure: null,
    })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    expect(await sessionGate(page)).toMatchObject({ tokenStarted: 1, tokenHeld: 1, failure: null })
    expect(await sessionGate(page, 'releaseTokenOnly')).toMatchObject({
      tokenArmed: false,
      tokenHeld: 0,
      coreArmed: true,
      failure: null,
    })
    // The real SDK adopts the response before the new authority read can enter.
    await expect
      .poll(async () => (await sessionGate(page)).coreHeldAfterTokenRelease)
      .toBeGreaterThan(0)
    expect(await sessionGate(page)).toMatchObject({ tokenStarted: 1, failure: null })
    const retainedTrigger = page
      .getByRole('button', {
        name: /changer d’organisation/,
        includeHidden: true,
      })
      .last()
    await expect(retainedTrigger).toBeAttached()
    await expect(
      retainedTrigger.locator('xpath=ancestor::*[@hidden and @aria-hidden="true"]').first()
    ).toBeAttached()
    await expect(retainedTrigger).toBeHidden()
    await expect(page.getByText(/Votre session va expirer/)).toHaveCount(0)
    expect(await sessionGate(page, 'releaseCoreOnly')).toMatchObject({
      tokenArmed: false,
      coreArmed: false,
      coreHeld: 0,
      abortListeners: 0,
      failure: null,
    })
    const acceptedTrigger = page.getByRole('button', { name: /changer d’organisation/ }).last()
    await expect(acceptedTrigger).toBeVisible()
    await expect(acceptedTrigger).toBeEnabled()
    await expect(page.getByText(/Votre session va expirer/)).toHaveCount(0)
    await page
      .getByRole('button', { name: /changer d’organisation/ })
      .last()
      .focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('heading', { name: 'announcements', exact: true })).toBeInViewport()
    await expect
      .poll(
        async () =>
          (await page.getByRole('heading', { name: 'announcements', exact: true }).boundingBox())
            ?.width ?? 0
      )
      .toBeGreaterThan(150)
    await page.screenshot({ path: info.outputPath('workspace-mobile.png'), fullPage: true })
    await page.getByRole('button', { name: 'Salons', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Salons', exact: true })).toBeVisible()
    await page
      .getByRole('dialog', { name: 'Salons', exact: true })
      .getByRole('link', { name: 'support', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: 'Salons', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'support', exact: true })).toBeInViewport()
    await page
      .getByRole('button', { name: /changer d’organisation/ })
      .last()
      .click()
    await expect(
      page.getByRole('menuitemradio', {
        name: 'Kodera Community Communauté & Support',
        exact: true,
      })
    ).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Salons', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Salons', exact: true })
      .getByRole('button', { name: /Rejoindre office-hours/ })
      .click()
    await expect(page.getByRole('dialog', { name: 'Salons', exact: true })).toHaveCount(0)
    await page.getByRole('region', { name: 'Appel en cours', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toBeInViewport()
    await page.screenshot({ path: info.outputPath('workspace-mobile-voice.png'), fullPage: true })
    await page.getByRole('button', { name: 'Quitter', exact: true }).click()

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(await sessionGate(page)).toMatchObject({
      ownsFetch: true,
      tokenStarted: 1,
      failure: null,
    })
    completed = true
  } finally {
    // A failed/closed page must not mask the original assertion; a passing case proves cleanup.
    const cleaned = await sessionGate(page, 'cleanup').catch(() => null)
    if (completed)
      expect(cleaned).toMatchObject({
        ownsFetch: false,
        tokenArmed: false,
        coreArmed: false,
        tokenHeld: 0,
        coreHeld: 0,
        abortListeners: 0,
        failure: null,
      })
  }
})

test('voice rooms expose usable local audio controls', async ({ page }, info) => {
  await login(page)
  await page.getByRole('button', { name: /Rejoindre office-hours/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Couper le micro', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Couper le micro', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.getByRole('button', { name: 'Couper le son', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Couper le son', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.screenshot({ path: info.outputPath('voice-controls.png'), fullPage: true })
  await page.getByRole('button', { name: 'Quitter', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Créer un salon dans Core Kodera', exact: true }).click()
  await page.getByLabel('Nom du salon', { exact: true }).fill('qa-voice')
  await page.getByLabel('Type de salon', { exact: true }).selectOption('audio')
  await page.getByRole('button', { name: 'Créer le salon', exact: true }).click()
  await expect(page.getByRole('button', { name: /Rejoindre qa-voice/ })).toBeVisible()
  await page.getByRole('button', { name: /Rejoindre qa-voice/ }).click()
  await expect(page.getByRole('region', { name: 'Appel en cours', exact: true })).toContainText(
    'qa-voice'
  )
  await page.getByRole('button', { name: 'Quitter', exact: true }).click()
})

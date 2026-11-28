// Import-free gate. The claim entry stays unresolved unless the first-owner journey is built in
// (`VITE_FIRST_OWNER_JOURNEY`, a literal check the minifier folds away when it is not). The
// invitation entry and the protected callback both serve, in every build
// (docs/specs/12-invitation-accept.md §3).
import type { BootEntry } from './main'

declare const __KODERA_INITIAL_GROUND_CSS__: string

function adoptInitialGround(): void {
  if (parent !== window) return
  try {
    const ground = new CSSStyleSheet()
    ground.replaceSync(__KODERA_INITIAL_GROUND_CSS__)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, ground]
  } catch {
    // Fallback to `color-scheme` and `index.css`.
  }
}

const claimEnvelopeKey = 'kodera.owner-claim.entry.v1'
const slugTail =
  '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\/([a-z0-9-]{1,64})$'
const claimPath = new RegExp(`^\\/claim\\/${slugTail}`)
const invitationPath = new RegExp(`^\\/invitations\\/accept\\/${slugTail}`)
const isInvitationEntry = (path: string): boolean =>
  path === '/invitations/accept' || path.startsWith('/invitations/accept/')

/** Removes the fragment and verifies it is gone; `keep` receives it, undecoded, before removal. */
function cleanLocation(keep?: (fragment: string) => void): boolean {
  let opaqueFragment: string
  try {
    // Capture once without decoding. No secret escapes this short lexical scope.
    opaqueFragment = location.hash
    const clean = new URL(location.href)
    clean.hash = ''
    if (opaqueFragment !== '') history.replaceState(history.state, '', clean.href)
    if (location.hash !== '' || location.href !== clean.href) return false
    keep?.(opaqueFragment.slice(1))
    return true
  } catch {
    return false
  } finally {
    // eslint-disable-next-line no-useless-assignment -- Drop the captured fragment before returning.
    opaqueFragment = ''
  }
}

function discardSelectedClaimEnvelope(): boolean {
  try {
    if (sessionStorage.getItem(claimEnvelopeKey) !== null) {
      sessionStorage.removeItem(claimEnvelopeKey)
      return sessionStorage.getItem(claimEnvelopeKey) === null
    }
    return true
  } catch {
    return false
  }
}

function showRecovery(): void {
  const root = document.getElementById('root')
  const template = document.getElementById('entry-recovery')
  if (root === null || !(template instanceof HTMLTemplateElement)) {
    throw Error('ENTRY_RECOVERY_MARKUP_MISSING')
  }
  root.replaceChildren(template.content.cloneNode(true))
  const heading = root.querySelector('h1')
  if (heading !== null) document.title = heading.textContent ?? document.title
}

function isBundledDesktopLocation(): boolean {
  return location.protocol === 'kodera-asset:' || location.hostname === 'kodera-asset.localhost'
}

function appBaseUrl(): URL {
  return new URL(import.meta.env.BASE_URL, location.href)
}

const KNOWN_THEMES = ['light', 'dark', 'black', 'ciel', 'ciel-nuit']

function applySavedOrDeviceTheme(): void {
  if (parent !== window) return
  let theme: string | null = null
  try {
    theme = localStorage.getItem('console:theme')
  } catch {
    // Follow device.
  }
  if (!theme || !KNOWN_THEMES.includes(theme)) {
    theme = 'dark'
    try {
      if (!matchMedia('(prefers-color-scheme: dark)').matches) theme = 'light'
    } catch {
      // Follow Dark Precision.
    }
  }
  document.documentElement.dataset.theme = theme
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute('content', theme === 'light' || theme === 'ciel' ? 'light' : 'dark')
}

async function releaseOrdinaryPage(entry?: BootEntry): Promise<void> {
  const head = document.getElementById('entry-page-head')
  if (!(head instanceof HTMLTemplateElement)) throw Error('ENTRY_HEAD_MARKUP_MISSING')
  await new Promise<void>((resolve, reject) => {
    const theme = document.createElement('script')
    theme.src = new URL('theme.js', appBaseUrl()).href
    theme.async = false
    theme.onload = () => resolve()
    theme.onerror = () => reject(Error('ENTRY_THEME_LOAD_FAILED'))
    document.head.append(theme)
  })
  document.head.append(head.content.cloneNode(true))
  const { boot } = await import('./main')
  await boot(entry)
}

async function runOrdinaryPage(entry?: BootEntry): Promise<void> {
  try {
    await releaseOrdinaryPage(entry)
  } catch {
    showRecovery()
  }
}

/** Retires only the old simulation worker; unrelated workers and real OIDC state survive. */
export async function retireLegacyWorker(): Promise<'ready' | 'reload' | 'blocked'> {
  const marker = 'kodera.web.legacy-worker-reload'
  const opaqueOrigin = location.origin === 'null' || location.protocol === 'kodera-asset:'
  const legacy = (worker: ServiceWorker | null | undefined): boolean => {
    if (!worker || opaqueOrigin) return false
    try {
      const url = new URL(worker.scriptURL)
      return url.origin === location.origin && url.pathname.endsWith('/mockServiceWorker.js')
    } catch {
      return false
    }
  }
  const service = opaqueOrigin ? undefined : navigator.serviceWorker
  const controlled = legacy(service?.controller)
  try {
    for (let i = sessionStorage.length; i-- > 0;) {
      const key = sessionStorage.key(i)
      if (key?.startsWith('msw:') || key?.startsWith('kodera.demo.')) sessionStorage.removeItem(key)
    }
    if (service) {
      const registrations = await service.getRegistrations()
      await Promise.all(
        registrations
          .filter((registration) =>
            [registration.active, registration.waiting, registration.installing].some(legacy)
          )
          .map((registration) => registration.unregister())
      )
    }
    if (controlled) {
      // Storage must prove a persistent loop guard before a reload is allowed.
      if (sessionStorage.getItem(marker) === '1') return 'blocked'
      sessionStorage.setItem(marker, '1')
      if (sessionStorage.getItem(marker) !== '1') return 'blocked'
      location.reload()
      return 'reload'
    }
    sessionStorage.removeItem(marker)
    return 'ready'
  } catch {
    return controlled ? 'blocked' : 'ready'
  }
}

async function startEntry(): Promise<void> {
  adoptInitialGround()
  applySavedOrDeviceTheme()
  if (import.meta.env.VITE_AUTH_MODE === 'oidc' || import.meta.env.VITE_ENABLE_MSW !== '1') {
    const retirement = await retireLegacyWorker()
    if (retirement === 'reload') return
    if (retirement === 'blocked') {
      cleanLocation()
      showRecovery()
      return
    }
  }
  let secret = ''
  const journey = import.meta.env.VITE_FIRST_OWNER_JOURNEY === '1'
  // Read before cleanup, which never changes the path: only an entry that can use the fragment
  // keeps it. The raw path, like every protected test below.
  const keeps = journey || isInvitationEntry(location.pathname)
  if (
    !cleanLocation(
      keeps
        ? (fragment) => {
            secret = fragment
          }
        : undefined
    )
  ) {
    showRecovery()
    return
  }
  if (isBundledDesktopLocation() && location.pathname === '/index.html') {
    try {
      const rootHref = `${appBaseUrl().href}${location.search}`
      history.replaceState(history.state, '', rootHref)
    } catch {
      showRecovery()
      return
    }
  }
  let path: string
  try {
    path = decodeURIComponent(location.pathname)
  } catch {
    showRecovery()
    return
  }
  // The admitted callback also serves silent renewal. Only the parent owns the SDK transaction;
  // a framed response must never load the theme or mount another application.
  if (path === '/auth/callback' && window.parent !== window) {
    if (window.location.origin === 'null') {
      showRecovery()
      return
    }
    window.parent.postMessage(
      { source: 'oidc-client', url: window.location.href, keepOpen: false },
      window.location.origin
    )
    return
  }
  const protectedCallback =
    path === '/auth/claim-callback' || path.startsWith('/auth/claim-callback/')
  const protectedClaim = path === '/claim' || path.startsWith('/claim/')
  const protectedInvitation = isInvitationEntry(path)
  if (protectedCallback) {
    // No envelope is ever written: the claim or invitation secret stays in the opener's memory.
    // Served in every build, since an invitation's sign-in returns here too.
    if (!discardSelectedClaimEnvelope()) {
      showRecovery()
      return
    }
    if (path === '/auth/claim-callback') {
      await runOrdinaryPage({ kind: 'claim-callback' })
      return
    }
    showRecovery()
    return
  }
  if (protectedInvitation) {
    // Bounded as the contract bounds the token (32–256), and otherwise opaque.
    const match = invitationPath.exec(location.pathname)
    if (match === null || !/^[!-~]{32,256}$/.test(secret)) {
      // eslint-disable-next-line no-useless-assignment -- Clear the fragment before recovery UI.
      secret = ''
      showRecovery()
      return
    }
    const entry: BootEntry = {
      kind: 'invitation',
      organisationId: match[1]!,
      organisationSlug: match[2]!,
      secret,
    }
    // eslint-disable-next-line no-useless-assignment -- Only the admitted entry retains the secret across the await.
    secret = ''
    await runOrdinaryPage(entry)
    return
  }
  if (protectedClaim) {
    // The raw path, not the decoded one: an encoded separator is not a path segment the
    // router would match. The secret is opaque but bounded to one URL-safe token.
    const match = journey ? claimPath.exec(location.pathname) : null
    if (match === null || !/^[!-~]{1,1024}$/.test(secret)) {
      showRecovery()
      return
    }
    const entry: BootEntry = {
      kind: 'claim',
      organisationId: match[1]!,
      organisationSlug: match[2]!,
      secret,
    }
    // eslint-disable-next-line no-useless-assignment -- Only the admitted entry retains the secret across the await.
    secret = ''
    await runOrdinaryPage(entry)
    return
  }
  await runOrdinaryPage()
}

void startEntry()

// Import-free gate. The claim entry stays unresolved unless the first-owner journey is built in
// (`VITE_FIRST_OWNER_JOURNEY`, a literal check the minifier folds away when it is not). The
// invitation entry and the protected callback both serve, in every build
// (docs/specs/12-invitation-accept.md §3).
import type { BootEntry } from './main'

const claimEnvelopeKey = 'kodera.owner-claim.entry.v1'
const claimPath =
  /^\/claim\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z0-9-]{1,64})$/
const invitationPath =
  /^\/invitations\/accept\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z0-9-]{1,64})$/
const isInvitationEntry = (path: string): boolean =>
  path === '/invitations/accept' || path.startsWith('/invitations/accept/')

/** Removes the fragment and verifies it is gone; `keep` receives it, undecoded, before removal. */
function cleanLocation(keep?: (fragment: string) => void): boolean {
  let opaqueFragment = ''
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

async function releaseOrdinaryPage(entry?: BootEntry): Promise<void> {
  const head = document.getElementById('entry-page-head')
  if (!(head instanceof HTMLTemplateElement)) throw Error('ENTRY_HEAD_MARKUP_MISSING')
  await new Promise<void>((resolve, reject) => {
    const theme = document.createElement('script')
    theme.src = new URL('theme.js', location.origin + import.meta.env.BASE_URL).href
    theme.async = false
    theme.addEventListener('load', () => resolve(), { once: true })
    theme.addEventListener('error', () => reject(Error('ENTRY_THEME_LOAD_FAILED')), { once: true })
    document.head.append(theme)
  })
  document.head.append(head.content.cloneNode(true))
  const { boot } = await import('./main')
  await boot(entry)
}

/** Retires only the old simulation worker; unrelated workers and real OIDC state survive. */
export async function retireLegacyWorker(): Promise<'ready' | 'reload' | 'blocked'> {
  const marker = 'kodera.web.legacy-worker-reload'
  const legacy = (worker: ServiceWorker | null | undefined): boolean => {
    if (!worker) return false
    try {
      const url = new URL(worker.scriptURL)
      return url.origin === location.origin && url.pathname.endsWith('/mockServiceWorker.js')
    } catch {
      return false
    }
  }
  const service = navigator.serviceWorker
  const controlled = legacy(service?.controller)
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)
    )
    for (const key of keys) {
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
  let path: string
  try {
    path = decodeURIComponent(location.pathname)
  } catch {
    showRecovery()
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
      try {
        await releaseOrdinaryPage({ kind: 'claim-callback' })
      } catch {
        showRecovery()
      }
      return
    }
    showRecovery()
    return
  }
  if (protectedInvitation) {
    // Bounded as the contract bounds the token (32–256), and otherwise opaque.
    const match = invitationPath.exec(location.pathname)
    if (match === null || !/^[!-~]{32,256}$/.test(secret)) {
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
    secret = ''
    try {
      await releaseOrdinaryPage(entry)
    } catch {
      showRecovery()
    }
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
    secret = ''
    try {
      await releaseOrdinaryPage(entry)
    } catch {
      showRecovery()
    }
    return
  }
  try {
    await releaseOrdinaryPage()
  } catch {
    showRecovery()
  }
}

void startEntry()

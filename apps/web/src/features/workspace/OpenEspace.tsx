// « Ouvrir les messages »: the way into the live workspace (messaging-pilot design §2.4). It finds the
// organisation's homeserver (`../espace/homeserver.ts`) and sends the page through Synapse's SSO
// login (`beginMatrixSignIn`), which returns to `/espace/callback` and from there to this page,
// now with a Matrix session. Offered only where the deployment names a matrix domain.
//
// The Console holds one Matrix session, from the last organisation opened. Another
// organisation's workspace does not show it (`espaceSessionFor`): it draws its layout and its
// own « Ouvrir les messages », whose sign-in leaves the page and so replaces the session. The foreign
// session is not signed out on the way: its device is shared by every tab on that homeserver
// (`src/auth/matrix.ts`), and signing it out would end Espace in the member's other tabs.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { beginMatrixSignIn, getMatrixSession } from '../../auth/matrix'
import type { MatrixSession } from '../../auth/matrix'
import { espaceDevHomeserver, espaceDevServerName, matrixDomain } from '../../config'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { HomeserverUnresolved, resolveHomeserver, sessionBelongsTo } from '../espace/homeserver'
import type { HomeserverProblem, ServerNameOptions } from '../espace/homeserver'

const PROBLEM_COPY: Record<HomeserverProblem, MessageKey> = {
  network: 'console.workspace.live.problem-unreachable',
  unavailable: 'console.workspace.live.problem-unreachable',
  malformed: 'console.workspace.live.problem-unavailable',
  misconfigured: 'console.workspace.live.problem-unavailable',
}

/** Whether this deployment offers the live workspace at all. */
export function espaceOffered(): boolean {
  return matrixDomain() !== undefined
}

/** The deployment's settings for finding an organisation's server name; none without a domain. */
function serverNameOptions(): ServerNameOptions | undefined {
  const domain = matrixDomain()
  if (domain === undefined) return undefined
  return {
    matrixDomain: domain,
    devHomeserver: espaceDevHomeserver(),
    devServerName: espaceDevServerName(),
  }
}

/**
 * The Matrix session, when it is this tenant's homeserver's; never another's. `serverSlug` is the
 * tenant's slug, its server name's label — which may differ from the organisation's slug
 * (quick-workspace SPEC §2.1, lead ruling 11-06).
 */
export function espaceSessionFor(serverSlug: string): MatrixSession | undefined {
  const session = getMatrixSession()
  const options = serverNameOptions()
  if (session === undefined || options === undefined) return undefined
  return sessionBelongsTo(session, serverSlug, options) ? session : undefined
}

const AUTO_OPEN_KEY = 'kodera.espace.auto-open.v1'
/** A second automatic sign-in within this long is not started: the member came back from it. */
const AUTO_OPEN_AGAIN_AFTER_MS = 60_000

/**
 * Whether an automatic start is due: not within a minute of the last one. « Back » from Synapse
 * or Keycloak reloads this page, and starting again would hold the member in a loop. It only
 * reads, so the first draw can ask it; `claimAutoOpen` is what takes the turn.
 */
function autoOpenDue(now = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(AUTO_OPEN_KEY))
    return !(Number.isFinite(last) && now - last >= 0 && now - last < AUTO_OPEN_AGAIN_AFTER_MS)
  } catch {
    return false
  }
}

/**
 * Whether this tab may start the sign-in on its own, and if so, notes that it does
 * (`autoOpenDue`). Without storage, never: the loop it guards against would have no stop.
 */
function claimAutoOpen(now = Date.now()): boolean {
  if (!autoOpenDue(now)) return false
  try {
    window.sessionStorage.setItem(AUTO_OPEN_KEY, String(now))
    return window.sessionStorage.getItem(AUTO_OPEN_KEY) === String(now)
  } catch {
    return false
  }
}

/**
 * Opens the messages without the click (UX audit #6, V1 bar M4): the Console's sign-in already
 * holds a Keycloak session, so Synapse's SSO comes straight back. Once per page, and never right
 * after the last automatic start (`claimAutoOpen`); « Ouvrir les messages » stays for every other
 * case. Never while `offered` is false — a homeserver still being prepared included — and once it
 * turns true, as a tenant set active does, on that same draw (quick-workspace SPEC W2).
 *
 * Returns whether that start is still to come. It is decided in the draw itself, so a page that
 * is about to leave draws « Ouverture de vos messages… » from the start, never the invitation to
 * open them (gap report G7). The effect hands over to `entry.opening` in the same commit.
 *
 * `returnTo`: where the sign-in comes back to, when not the page on screen.
 */
export function useAutoOpenEspace(
  entry: ReturnType<typeof useOpenEspace>,
  offered: boolean,
  returnTo?: string
): boolean {
  const started = useRef(false)
  const [settled, setSettled] = useState(false)
  const { open } = entry
  useEffect(() => {
    if (!offered || started.current) return
    started.current = true
    if (claimAutoOpen())
      void open({ replace: true, ...(returnTo === undefined ? {} : { returnTo }) })
    setSettled(true)
  }, [offered, open, returnTo])
  return offered && !settled && autoOpenDue()
}

/** The Console path to come back to: the one on screen, as the callback route expects it. */
function currentPath(): string {
  const { pathname, search, hash } = window.location
  return `${pathname}${search}${hash}`
}

/** `serverSlug`: the tenant's slug, from which its homeserver is found (`espaceSessionFor`). */
export function useOpenEspace(serverSlug: string) {
  const [state, setState] = useState<'idle' | 'opening' | MessageKey>('idle')
  // Set in the click itself: two clicks before React draws « opening » start one sign-in.
  const opening = useRef(false)

  useEffect(() => {
    // Back from Synapse through the back/forward cache: the page is the one left « opening »,
    // with nothing running. It is idle again.
    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted) return
      opening.current = false
      setState('idle')
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  /** `replace`: the automatic start, which leaves no entry for « back » to start it again.
   * `returnTo`: the Console path to come back to; the page on screen by default. */
  const open = useCallback(
    async ({ replace = false, returnTo }: { replace?: boolean; returnTo?: string } = {}) => {
      if (opening.current) return
      const options = serverNameOptions()
      if (options === undefined) return
      opening.current = true
      setState('opening')
      try {
        const { baseUrl } = await resolveHomeserver(serverSlug, options)
        // A full-page navigation: the page stays « opening » until it is gone.
        beginMatrixSignIn(
          baseUrl,
          returnTo ?? currentPath(),
          replace ? { navigate: (url) => window.location.replace(url) } : {}
        )
      } catch (error) {
        opening.current = false
        setState(
          error instanceof HomeserverUnresolved
            ? PROBLEM_COPY[error.problem]
            : 'console.workspace.live.problem-unavailable'
        )
      }
    },
    [serverSlug]
  )

  return {
    opening: state === 'opening',
    problem: state === 'idle' || state === 'opening' ? undefined : state,
    open,
  }
}

export function OpenEspaceButton({
  entry,
  size = 'sm',
  opening,
}: {
  entry: ReturnType<typeof useOpenEspace>
  size?: 'sm' | 'md'
  /**
   * Busy: the sign-in is under way (`entry.opening`), or the automatic one is about to start
   * (`useAutoOpenEspace`). The caller combines them, since its copy follows the same state.
   */
  opening: boolean
}) {
  const { t } = useTranslation()
  return (
    <Button size={size} className="shrink-0" loading={opening} onClick={() => void entry.open()}>
      {t('console.workspace.live.action-open')}
    </Button>
  )
}

export function OpenEspaceProblem({ entry }: { entry: ReturnType<typeof useOpenEspace> }) {
  const { t } = useTranslation()
  return entry.problem === undefined ? null : (
    <InlineAlert kind="error">{t(entry.problem)}</InlineAlert>
  )
}

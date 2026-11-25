import { useNavigate, useSearch } from '@tanstack/react-router'
import { lazy, Suspense, useEffect } from 'react'
import { authAdapter } from '../../auth/oidc'
import { isDesktopBundledOrigin } from '../../auth/desktopOidc'
import { consumeReturnTo } from '../../auth/return-to'
import { consumeDesktopWorkspaceCreation } from '../../auth/desktopWorkspaceCreation'
import { SessionLoading } from '../../app/SessionLoading'
import { LoginScreen } from './LoginScreen'
import { shouldRenderCommunityWelcome } from './routes'

// The Community welcome has no callback tokens or entry state to capture. Fetch
// its presentation only when this login destination is opened.
const CommunityWelcome = lazy(() =>
  import('./CommunityWelcome').then(({ CommunityWelcome }) => ({ default: CommunityWelcome }))
)

/** What `/login` draws (`./routes.tsx`), fetched with the route rather than with the entry. */
export function LoginRoute() {
  const navigate = useNavigate()
  useEffect(() => {
    if (!isDesktopBundledOrigin()) return
    let completed = false
    const complete = () => {
      if (
        !completed &&
        authAdapter.getSnapshot().status === 'ready' &&
        authAdapter.getAccessToken() !== undefined
      ) {
        completed = true
        const returnTo = consumeReturnTo()
        const creation = consumeDesktopWorkspaceCreation(authAdapter.getUser()?.realm ?? '')
        // Registration overrides unrelated destinations, but recovery keeps the
        // query and fragment of an already requested workspace creation route.
        const destination =
          creation !== undefined && returnTo.split(/[?#]/, 1)[0] !== creation ? creation : returnTo
        void navigate({ to: destination, replace: true })
      }
    }
    const unsubscribe = authAdapter.subscribe(complete)
    complete()
    return unsubscribe
  }, [navigate])
  const { org, mode } = useSearch({ from: '/login' })
  if (import.meta.env.VITE_AUTH_MODE === 'oidc' && shouldRenderCommunityWelcome(org, mode)) {
    return (
      <Suspense fallback={<SessionLoading />}>
        <CommunityWelcome />
      </Suspense>
    )
  }
  return <LoginScreen {...(org === undefined ? {} : { initialSlug: org })} />
}

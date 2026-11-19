import { useSearch } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
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

// `/{org}/security/mfa` (docs/specs/00-shell-and-login.md §3): forced after
// first login when the caller's active identity is not MFA-enrolled.
// `src/app/org-route.tsx`'s `OrgLayout` is what forces it — this route only
// renders the guide once the person is already here.

import { createRoute, useRouter } from '@tanstack/react-router'
import { AreaStub } from '../../app/AreaStub'
import { orgRoute } from '../../app/org-route'
import { MfaEnrolScreen } from './MfaEnrolScreen'

// `/{org}/security` — « Sécurité et connexion », the account menu's place in
// both layouts (`src/app/accountItems.ts`). The same placeholder as People and
// Domain until the screen exists: no link sends an enrolled person back into
// the enrolment guide, which in a real build only says enrolment is not
// available yet (owner ruling, 2026-09-24). Every role has an account, so no
// role gate.
export const securityRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'security',
  component: () => <AreaStub titleKey="console.shell.account.action-security" />,
})

export const securityMfaRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'security/mfa',
  component: SecurityMfaRoute,
})

function SecurityMfaRoute() {
  const { me } = orgRoute.useLoaderData()
  const router = useRouter()
  const { org } = securityMfaRoute.useParams()
  return (
    <MfaEnrolScreen
      accountEmail={me.email}
      onEnrolled={() => void router.navigate({ to: '/$org/home', params: { org } })}
    />
  )
}

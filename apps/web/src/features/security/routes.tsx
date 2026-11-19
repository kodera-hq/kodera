// `/{org}/security/mfa` (docs/specs/00-shell-and-login.md §3): forced after
// first login when the caller's active identity is not MFA-enrolled.
// `src/app/org-route.tsx`'s `OrgLayout` is what forces it — this route only
// renders the guide once the person is already here.

import { createRoute, useRouter } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { orgRoute } from '../../app/org-route'
import { MfaEnrolScreen } from './MfaEnrolScreen'

const SecuritySettings = lazy(() => import('./SecuritySettings'))

export const securityRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'security',
  component: SecuritySettingsRoute,
})

export const securityMfaRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'security/mfa',
  component: SecurityMfaRoute,
})

function SecurityMfaRoute() {
  const { me, membership } = orgRoute.useLoaderData()
  const router = useRouter()
  const { org } = securityMfaRoute.useParams()
  return (
    <MfaEnrolScreen
      accountEmail={me.email}
      memberRole={membership.role}
      onEnrolled={() => void router.navigate({ to: '/$org/home', params: { org } })}
    />
  )
}

function SecuritySettingsRoute() {
  const { me, membership } = orgRoute.useLoaderData()
  const { org } = securityRoute.useParams()
  const { t } = useTranslation()
  return (
    <Suspense fallback={<p role="status">{t('console.security.settings.loading')}</p>}>
      <SecuritySettings
        org={org}
        accountId={me.id}
        organisationId={membership.organisation.id}
        membershipId={membership.membership_id}
      />
    </Suspense>
  )
}

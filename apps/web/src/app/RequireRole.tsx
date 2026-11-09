// A direct URL to an area a member-role token cannot use (docs/specs/
// 00-shell-and-login.md §5 "Permission denied" row, acceptance test 7):
// "the action is not rendered at all, and a direct URL shows a `Banner`
// naming who can do it" — never a raw 403. `Sidebar.tsx` already leaves the
// nav item out for the same role; this is what the route itself renders
// when the person types the URL in anyway.

import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { orgRoute } from './org-route'
import type { OrganisationRole } from './Sidebar'
import { Banner } from '../ui/Banner/Banner'
import type { MessageKey } from '../i18n'

export interface RequireRoleProps {
  allow: readonly OrganisationRole[]
  /** The area's own nav title (`console.shell.nav.title-*`) — the denied
   * view is still a whole screen (§10: "one h1 per screen"), so it needs a
   * heading of its own, the same one the nav item names. */
  titleKey: MessageKey
  children: ReactNode
}

export function RequireRole({ allow, titleKey, children }: RequireRoleProps) {
  const { t } = useTranslation()
  const { membership } = orgRoute.useLoaderData()

  if (allow.includes(membership.role)) return <>{children}</>

  return (
    <div className="flex flex-1 flex-col items-center gap-4 py-12 text-center">
      <h1 className="text-lg font-semibold text-c-ink">{t(titleKey)}</h1>
      <Banner
        kind="info"
        headline={t('console.shell.access.error-role', {
          owner: t('console.shell.access.label-owner-fallback'),
        })}
        className="w-full max-w-[560px] text-left"
      />
    </div>
  )
}

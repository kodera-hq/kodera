// docs/specs/03-people.md §4.1: the People area — header with the three
// counted groups, the Membres / Invitations / Accès sur site tabs, and the
// drawers opened over the list. Router-free: the route reads the URL and
// passes what to show plus `onNavigate`, so the screen is testable against
// the mocks alone.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs } from '../../ui/Tabs/Tabs'
import { trackPeopleViewed } from './analytics'
import { InvitationsPanel } from './InvitationsPanel'
import { MembersPanel } from './MembersPanel'
import { useMembershipCountQuery } from './queries'
import type { OrganisationRole } from './roles'
import { PAGE_TITLE } from '../../ui/pageTitle'
import { offers } from '../../app/capabilities'

export type PeopleTab = 'members' | 'invitations' | 'on-site'

export type PeopleTarget =
  | { to: '' }
  | { to: 'invitations' }
  | { to: 'on-site' }
  | { to: 'invite' }
  | { to: 'import' }
  | { to: 'member'; memberId: string }

export interface PeopleScreenProps {
  organisationId: string
  callerRole: OrganisationRole
  /** The caller's own membership: their row carries no menu (§8 self-removal). */
  callerMembershipId: string
  tab: PeopleTab
  onNavigate: (target: PeopleTarget) => void
  /** Rendered inside the On-site tab. */
  onSite?: React.ReactNode
  /** A drawer opened over the list (invite, member detail). */
  children?: React.ReactNode
}

export function PeopleScreen({
  organisationId,
  callerRole,
  callerMembershipId,
  tab,
  onNavigate,
  onSite,
  children,
}: PeopleScreenProps) {
  const { t } = useTranslation()
  const members = useMembershipCountQuery(organisationId, 'members')
  const admins = useMembershipCountQuery(organisationId, 'admins')
  const invitations = useMembershipCountQuery(organisationId, 'invitations')

  // §11: one view event per tab shown, with the member count bucketed.
  useEffect(() => {
    if (members.data !== undefined) trackPeopleViewed(tab, members.data)
  }, [tab, members.data])

  const counted = (label: string, count: number | undefined) =>
    count === undefined ? label : `${label} (${count})`

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className={PAGE_TITLE}>{t('console.people.list.title')}</h1>
        {members.data === undefined ||
        admins.data === undefined ||
        invitations.data === undefined ? null : (
          <p className="text-sm text-c-ink-2">
            {t('console.people.list.subtitle', {
              members: members.data,
              admins: admins.data,
              invitations: invitations.data,
            })}
          </p>
        )}
      </header>
      <Tabs
        ariaLabel={t('console.people.list.title')}
        value={tab}
        onValueChange={(value) =>
          onNavigate({ to: value === 'members' ? '' : (value as 'invitations' | 'on-site') })
        }
        items={[
          {
            value: 'members',
            label: counted(t('console.people.list.label-tab-members'), members.data),
            content:
              tab === 'members' ? (
                <MembersPanel
                  organisationId={organisationId}
                  callerRole={callerRole}
                  callerMembershipId={callerMembershipId}
                  onNavigate={onNavigate}
                />
              ) : null,
          },
          {
            value: 'invitations',
            label: counted(t('console.people.list.label-tab-invitations'), invitations.data),
            content:
              tab === 'invitations' ? <InvitationsPanel organisationId={organisationId} /> : null,
          },
          // Hidden while Core does not serve enrolment tokens (`src/app/capabilities.ts`).
          ...(offers('on-site-enrolment')
            ? [
                {
                  value: 'on-site',
                  label: t('console.people.list.label-tab-on-site'),
                  content: tab === 'on-site' ? onSite : null,
                },
              ]
            : []),
        ]}
      />
      {children}
    </div>
  )
}

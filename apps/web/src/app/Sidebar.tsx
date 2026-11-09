import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../i18n'
import type { components } from '../api/schema'
import { OrgSwitcher } from './OrgSwitcher'
import type { OrgSwitcherMembership, OrgSwitcherOrganisation } from './OrgSwitcher'
import { UserBlock } from './UserBlock'
import { CURRENT_BAR } from '../ui/currentBar'
import type { UserBlockProps } from './UserBlock'
import type { UserBlockUser } from './UserBlock'

export type OrganisationRole = components['schemas']['OrganisationRole']

/** Existing areas follow the pinned Core role matrix, including the provisional
 * sideways billing grant. An allowed invoice read never implies People or
 * Domain management. These are presentation rules; Core authorizes requests. */
const READERS: readonly OrganisationRole[] = ['org_owner', 'org_admin', 'org_billing', 'org_member']
const MANAGERS: readonly OrganisationRole[] = ['org_owner', 'org_admin']
const BILLING_READERS: readonly OrganisationRole[] = ['org_owner', 'org_admin', 'org_billing']
export type NavArea = 'home' | 'apps' | 'people' | 'domain' | 'invoices' | 'support'

export interface NavItem {
  area: NavArea
  titleKey: MessageKey
  to: string
  allow: readonly OrganisationRole[]
}

const NAV_ITEMS: readonly NavItem[] = [
  { area: 'home', titleKey: 'console.shell.nav.title-home', to: '/$org/home', allow: READERS },
  { area: 'apps', titleKey: 'console.shell.nav.title-apps', to: '/$org/status', allow: READERS },
  {
    area: 'people',
    titleKey: 'console.shell.nav.title-people',
    to: '/$org/people',
    allow: MANAGERS,
  },
  {
    area: 'domain',
    titleKey: 'console.shell.nav.title-domain',
    to: '/$org/domain',
    allow: MANAGERS,
  },
  {
    area: 'invoices',
    titleKey: 'console.shell.nav.title-invoices',
    to: '/$org/invoices',
    allow: BILLING_READERS,
  },
  { area: 'support', titleKey: 'console.shell.nav.title-help', to: '/$org/help', allow: READERS },
]

/** The areas a role may see, in the sidebar's order. The one role matrix: the
 * narrow layout's tab bar and its « Plus » sheet (`src/app/NarrowShell.tsx`)
 * read it too, so no layout can show an area another one hides. */
export function navItemsFor(role: OrganisationRole): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => item.allow.includes(role))
}

// The router joins `className` with the active or inactive `className`, and
// `cx` does not merge: a colour in the shared base fought the current item's
// and won by stylesheet order, so "Accueil" painted `c-ink`, not
// `c-accent-ink`. The shared base carries no colour and no weight. As in the
// mock, an idle item is `c-ink-2` at 500 on a `c-muted` hover, and the current
// one `c-accent-ink` at 600 on a `c-accent-soft` pill (tokens v0.5.0, DIRECTION.md §6).
//
// The current item also has a 1 px `c-accent-ink` edge (owner ruling,
// 2026-09-24; not in the mock) and a 3 px `c-action` bar at its start, like the
// rail's. Its pill is 1.21 / 1.25 / 1.17 : 1 against the sidebar's `c-sunken`
// ground; the edge is 8.07 / 10.37 / 11.20 : 1 against that ground in light /
// dark / black, so the edge is what tells the item apart. The bar is 5.54 /
// 2.99 / 3.44 : 1 on the pill: a further cue, not the one 1.4.11 rests on. Every item
// carries the 1 px border, transparent when idle, so the current item's text
// stays in line with the others.
const NAV_ITEM =
  'relative flex h-10 items-center rounded-md border px-3 text-md transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring'
const NAV_ITEM_IDLE = {
  className: 'border-transparent font-medium text-c-ink-2 hover:bg-c-muted',
}
const NAV_ITEM_CURRENT = {
  className: `border-c-accent-ink bg-c-accent-soft font-semibold text-c-accent-ink ${CURRENT_BAR}`,
}

export interface SidebarProps {
  org: string
  organisation: OrgSwitcherOrganisation
  /** The organisation's own mark, rendered beside its name. Demo-only — see
   * `src/app/demoBranding.ts` for why the contract cannot supply one. */
  organisationMark?: string
  memberships?: readonly OrgSwitcherMembership[]
  onSwitchOrganisation?: (slug: string) => void
  user: UserBlockUser
  role: OrganisationRole
  onSignOut: () => void
  onOpenAccountPlace?: UserBlockProps['onOpenPlace']
}

/** The token-width sunken navigation follows the complete product mock.
 * Current items retain the owner-approved accent edge for all three themes. */
export function Sidebar({
  org,
  organisation,
  organisationMark,
  memberships,
  onSwitchOrganisation,
  user,
  role,
  onSignOut,
  onOpenAccountPlace,
}: SidebarProps) {
  const { t } = useTranslation()
  const items = navItemsFor(role)
  return (
    <nav
      aria-label={t('console.shell.nav.a11y-label')}
      className="sticky top-0 flex h-screen w-shell-sidebar-width shrink-0 flex-col border-r border-c-border-soft bg-c-sunken"
    >
      <div className="p-3">
        <OrgSwitcher
          embedded
          organisation={organisation}
          {...(organisationMark === undefined ? {} : { mark: organisationMark })}
          {...(memberships === undefined ? {} : { memberships })}
          {...(onSwitchOrganisation === undefined ? {} : { onSwitch: onSwitchOrganisation })}
        />
      </div>
      <ul className="flex flex-1 flex-col gap-1 px-3">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              params={{ org }}
              className={NAV_ITEM}
              activeProps={NAV_ITEM_CURRENT}
              inactiveProps={NAV_ITEM_IDLE}
            >
              {t(item.titleKey)}
            </Link>
          </li>
        ))}
      </ul>
      <UserBlock
        user={user}
        onSignOut={onSignOut}
        {...(onOpenAccountPlace === undefined ? {} : { onOpenPlace: onOpenAccountPlace })}
      />
    </nav>
  )
}

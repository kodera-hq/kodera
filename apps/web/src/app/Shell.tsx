import { DemoDisclosure } from './DemoDisclosure'
import { useState, type ReactNode } from 'react'
import { WorkspaceSettingsHost } from '../features/workspace/WorkspaceSettingsHost'
import type { MessageKey } from '../i18n'
import { Button } from '../ui/Button/Button'
import { Tooltip } from '../ui/Tooltip/Tooltip'
import { HelpLink } from '../features/support/HelpLink'
import { useTranslation } from 'react-i18next'
import { IncidentBannerClaimProvider } from './incidentBannerClaim'
import { ModuleRail } from './ModuleRail'
import { NarrowModuleBar, NarrowTabBar, NarrowTopBar } from './NarrowShell'
import { phoneTabBarOf } from './railModules'
import type { RailSurface } from './railModules'
import type { OrgSwitcherMembership, OrgSwitcherOrganisation } from './OrgSwitcher'
import { OrganisationSwitchContext } from './organisationSwitch'
import type { OrganisationSwitch } from './organisationSwitch'
import { Sidebar } from './Sidebar'
import type { OrganisationRole, SidebarProps } from './Sidebar'
import { StatusBanner } from './StatusBanner'
import type { UserBlockUser } from './UserBlock'
import { useNarrowViewport } from './useNarrowViewport'

const SKIP_LINK =
  'sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-c-elevated focus-visible:px-4 focus-visible:py-2 focus-visible:text-c-ink focus-visible:shadow-pop focus-visible:shadow-c-shadow-2 focus-visible:outline-hidden focus-visible:ring'

export interface ShellProps {
  org: string
  organisationId: string
  organisation: OrgSwitcherOrganisation
  memberships?: readonly OrgSwitcherMembership[]
  onSwitchOrganisation?: (slug: string) => void
  user: UserBlockUser
  role: OrganisationRole
  onSignOut: () => void
  /** Opens an account place (« Sécurité et connexion », `accountItems.ts`)
   * from the wide layout's account menu; the narrow layout links to it. */
  onOpenAccountPlace?: SidebarProps['onOpenAccountPlace']
  /** The organisation's own mark, beside its name in the sidebar. Set only by
   * the demo seed (`src/app/demoBranding.ts`): the Core contract has no
   * branding field, so this is `undefined` in every build a customer loads. */
  organisationMark?: string
  contentTitleKey?: MessageKey
  /** Which surface is on screen (`railModules.ts`). The workspace has a layout of its own: the
   * rail, then the whole width for the workspace — no console sidebar, no content header and,
   * on a phone, the rail places as a tab bar, including the way back to the console
   * (docs/specs/11-workspace.md §4). */
  surface?: RailSurface
  sessionExpiry?: ReactNode
  children: ReactNode
}

/**
 * The authenticated frame (docs/specs/00-shell-and-login.md §4.5): the module
 * rail, sidebar, contextual header, banner slot and page content.
 * Landmarks include two `nav`s (`ModuleRail`, `Sidebar`) and `main`, each
 * `nav` named so the two are told apart (§10); the skip link is still the
 * first focusable thing on the page, ahead of both, per the shell's documented
 * focus order.
 *
 * In the narrow layout (`layoutQuery.ts`: below 768 px, or a phone held
 * sideways) the same content sits in the narrow frame instead
 * (`NarrowShell.tsx`, §4.5): no rail, no sidebar; a top bar, the page, and a
 * tab bar at the foot of the screen. Landmarks there are `header`, the tab
 * bar's own named `nav`, and the same `main`; the skip link is still first.
 */
export function Shell({
  org,
  organisationId,
  organisation,
  memberships,
  onSwitchOrganisation,
  user,
  role,
  onSignOut,
  onOpenAccountPlace,
  organisationMark,
  contentTitleKey = 'console.shell.rail.title-console',
  surface = 'console',
  sessionExpiry,
  children,
}: ShellProps) {
  const { t } = useTranslation()
  const narrow = useNarrowViewport()
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const settings = (
    <WorkspaceSettingsHost
      org={org}
      organisationId={organisationId}
      organisationName={organisation.name}
      displayName={user.displayName}
      role={role}
    />
  )
  const toggleName = t(
    sidebarVisible
      ? 'console.shell.header.action-hide-navigation'
      : 'console.shell.header.action-show-navigation'
  )

  if (narrow) {
    // A workspace phone tab bar carries the rail places and the way back to the console.
    const modules = phoneTabBarOf(surface) === 'modules'
    const organisationSwitch: OrganisationSwitch | undefined =
      memberships === undefined || onSwitchOrganisation === undefined
        ? undefined
        : { memberships, onSwitch: onSwitchOrganisation }
    return (
      <OrganisationSwitchContext.Provider value={organisationSwitch}>
        <div className="flex min-h-screen flex-col">
          {settings}
          <a href="#main-content" className={SKIP_LINK}>
            {t('console.shell.nav.action-skip-to-content')}
          </a>
          <NarrowTopBar
            org={org}
            organisation={organisation}
            {...(organisationMark === undefined ? {} : { organisationMark })}
            {...(memberships === undefined ? {} : { memberships })}
            {...(onSwitchOrganisation === undefined ? {} : { onSwitchOrganisation })}
            user={user}
            onSignOut={onSignOut}
          />
          {modules ? (
            <NarrowModuleBar org={org} organisationId={organisationId} />
          ) : (
            <NarrowTabBar org={org} role={role} />
          )}
          {/* `clear-of-bars` (src/index.css): a control reached with Tab here
            scrolls clear of both bars. */}
          <div className="clear-of-bars flex min-w-0 flex-1 flex-col">
            <IncidentBannerClaimProvider>
              {sessionExpiry}
              <DemoDisclosure org={org} surface={surface} />
              <StatusBanner
                organisationId={organisationId}
                org={org}
                role={role}
                className="px-4 pt-4 empty:hidden"
              />
              {/* 16 px on every side (the mock's mobile gutter), one column. */}
              <main id="main-content" className="flex w-full min-w-0 flex-1 flex-col gap-6 p-4">
                {children}
              </main>
            </IncidentBannerClaimProvider>
          </div>
        </div>
      </OrganisationSwitchContext.Provider>
    )
  }

  const rail = (
    <ModuleRail
      org={org}
      organisationId={organisationId}
      organisationName={organisation.name}
      user={user}
      surface={surface}
      role={role}
    />
  )

  if (surface === 'workspace') {
    // One screen tall: the workspace scrolls inside its own panes, so its channel list and its
    // conversation stay in view together. The banner slot is kept — an offline or session
    // notice concerns this surface as much as the console. No console sidebar here, so the
    // workspace's own header carries the organisation switch (`organisationSwitch.ts`).
    const organisationSwitch: OrganisationSwitch | undefined =
      memberships === undefined || onSwitchOrganisation === undefined
        ? undefined
        : { memberships, onSwitch: onSwitchOrganisation }
    return (
      <OrganisationSwitchContext.Provider value={organisationSwitch}>
        <div className="flex min-h-screen">
          {settings}
          <a href="#main-content" className={SKIP_LINK}>
            {t('console.shell.nav.action-skip-to-content')}
          </a>
          {rail}
          <div className="flex h-screen min-w-0 flex-1 flex-col">
            <IncidentBannerClaimProvider>
              {sessionExpiry}
              <DemoDisclosure org={org} surface={surface} />
              <StatusBanner organisationId={organisationId} org={org} role={role} />
              <main id="main-content" className="flex min-h-0 w-full flex-1 flex-col">
                {children}
              </main>
            </IncidentBannerClaimProvider>
          </div>
        </div>
      </OrganisationSwitchContext.Provider>
    )
  }

  return (
    <div className="flex min-h-screen">
      {settings}
      <a href="#main-content" className={SKIP_LINK}>
        {t('console.shell.nav.action-skip-to-content')}
      </a>
      {rail}
      <div id="console-sidebar" hidden={!sidebarVisible}>
        <Sidebar
          org={org}
          organisation={organisation}
          {...(organisationMark === undefined ? {} : { organisationMark })}
          {...(memberships === undefined ? {} : { memberships })}
          {...(onSwitchOrganisation === undefined ? {} : { onSwitchOrganisation })}
          user={user}
          role={role}
          onSignOut={onSignOut}
          {...(onOpenAccountPlace === undefined ? {} : { onOpenAccountPlace })}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          aria-label={t('console.shell.header.a11y-label')}
          className="flex h-shell-header-height shrink-0 items-center gap-3 border-b border-c-border-soft bg-c-surface px-6"
        >
          <Tooltip content={toggleName} side="bottom" names>
            <Button
              variant="tertiary"
              size="sm"
              aria-label={toggleName}
              aria-controls="console-sidebar"
              aria-expanded={sidebarVisible}
              onClick={() => setSidebarVisible((visible) => !visible)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-4 w-4"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
              </svg>
            </Button>
          </Tooltip>
          <p className="min-w-0 flex-1 truncate text-md font-semibold text-c-ink">
            {t(contentTitleKey)}
          </p>
          <HelpLink org={org} variant="tertiary" size="sm">
            {t('console.shell.nav.title-help')}
          </HelpLink>
        </header>
        <IncidentBannerClaimProvider>
          {/* Status banner slot (§4.5): one slot, at most one banner, chosen by
              offline → session-expiring → incident → dunning → capacity →
              maintenance precedence (`src/app/bannerPrecedence.ts`). */}
          {sessionExpiry}
          <DemoDisclosure org={org} surface={surface} />
          <StatusBanner organisationId={organisationId} org={org} role={role} />
          <main id="main-content" className="flex w-full flex-1 flex-col gap-6 px-6 py-5">
            {children}
          </main>
        </IncidentBannerClaimProvider>
      </div>
    </div>
  )
}

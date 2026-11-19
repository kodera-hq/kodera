import { DemoDisclosure } from './DemoDisclosure'
import { useState, type ReactNode } from 'react'
import { ShellShortcuts } from './ShellShortcuts'
import { PaletteProvider } from '../features/command-palette/PaletteContext'

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

const MAIN_CONTENT_ID = 'main-content'
const MAIN_CONTENT_FOCUS = 'outline-hidden'

/** Focus explicitly so repeated fragment activation also reaches the landmark. */
function SkipToContentLink() {
  const { t } = useTranslation()
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className={SKIP_LINK}
      onClick={() => document.getElementById(MAIN_CONTENT_ID)?.focus()}
    >
      {t('console.shell.nav.action-skip-to-content')}
    </a>
  )
}

export interface ShellProps {
  org: string
  organisationId: string
  personId?: string | undefined
  organisation: OrgSwitcherOrganisation
  memberships?: readonly OrgSwitcherMembership[]
  onSwitchOrganisation?: (slug: string) => void
  /** Whether the signed-in identity is staff (`Me.staff`); shared with the workspace's own menu. */
  staff?: boolean
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
  personId,
  organisation,
  memberships,
  onSwitchOrganisation,
  staff = false,
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
      personId={personId}
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

  // One tree for every layout (kodera issue 201): each slot below keeps its place whatever the
  // viewport or the surface, and a layout fills it or leaves it empty. `<main>` and the page in it
  // (`children`, the router's `<Outlet />`) therefore keep the same React path across the 768 px
  // breakpoint and across Console ↔ workspace, so crossing either never unmounts the page —
  // and never ends the call the workspace view owns.
  const workspace = surface === 'workspace'
  // The narrow frame and the workspace have no console sidebar: their own headers carry the
  // organisation switch (`organisationSwitch.ts`).
  const organisationSwitch: OrganisationSwitch | undefined =
    memberships !== undefined && onSwitchOrganisation !== undefined
      ? { memberships, onSwitch: onSwitchOrganisation, staff }
      : undefined
  // A workspace phone tab bar carries the rail places and the way back to the console.
  const narrowModules = phoneTabBarOf(surface) === 'modules'
  const consoleFrame = !narrow && !workspace

  return (
    <PaletteProvider key={org}>
      <OrganisationSwitchContext.Provider value={organisationSwitch}>
        {/* A phone's workspace is one screen tall too (`visible-screen-frame`, the visible height under a
          browser's own bars): its timeline scrolls inside, and the composer stays at the foot
          of the screen rather than below the whole history (kodera issue 216, 390 × 844). */}
        <div
          className={
            narrow
              ? workspace
                ? 'visible-screen-frame flex flex-col overflow-hidden'
                : 'flex min-h-screen flex-col'
              : 'flex min-h-screen'
          }
        >
          <ShellShortcuts key={org} org={org} />
          {settings}
          <SkipToContentLink />
          {narrow ? (
            <NarrowTopBar
              org={org}
              organisation={organisation}
              {...(organisationMark === undefined ? {} : { organisationMark })}
              {...(memberships === undefined ? {} : { memberships })}
              {...(onSwitchOrganisation === undefined ? {} : { onSwitchOrganisation })}
              user={user}
              onSignOut={onSignOut}
            />
          ) : (
            <ModuleRail
              org={org}
              organisationId={organisationId}
              organisationName={organisation.name}
              user={user}
              surface={surface}
              role={role}
            />
          )}
          {narrow ? (
            narrowModules ? (
              <NarrowModuleBar org={org} organisationId={organisationId} />
            ) : (
              <NarrowTabBar org={org} role={role} />
            )
          ) : null}
          {consoleFrame ? (
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
          ) : null}
          {/* Narrow: `clear-of-bars` (src/index.css), so a control reached with Tab scrolls clear
            of both bars. Workspace: one screen tall, the workspace scrolls inside its own panes
            so its channel list and its conversation stay in view together. */}
          <div
            className={
              narrow
                ? `clear-of-bars flex min-w-0 flex-1 flex-col${workspace ? 'min-h-0' : ''}`
                : workspace
                  ? 'flex h-screen min-w-0 flex-1 flex-col'
                  : 'flex min-w-0 flex-1 flex-col'
            }
          >
            {consoleFrame ? (
              <header
                aria-label={t('console.shell.header.a11y-label')}
                className="material-bar flex h-shell-header-height shrink-0 items-center gap-3 border-b border-c-border-soft px-6"
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
            ) : null}
            <IncidentBannerClaimProvider>
              {/* Status banner slot (§4.5): one slot, at most one banner, chosen by
                offline → session-expiring → incident → dunning → capacity →
                maintenance precedence (`src/app/bannerPrecedence.ts`). The banner notice
                concerns the workspace as much as the console. */}
              {sessionExpiry}
              <DemoDisclosure org={org} surface={surface} />
              <StatusBanner
                organisationId={organisationId}
                org={org}
                role={role}
                {...(narrow ? { className: 'px-4 pt-4 empty:hidden' } : {})}
              />
              {/* Narrow: 16 px on every side (the mock's mobile gutter), one column; the phone's
                workspace keeps a tighter gutter, its own panes drawing their edges. */}
              <main
                id={MAIN_CONTENT_ID}
                tabIndex={-1}
                className={`${
                  narrow
                    ? workspace
                      ? 'flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto px-3 pt-2'
                      : 'flex w-full min-w-0 flex-1 flex-col gap-6 p-4'
                    : workspace
                      ? 'flex min-h-0 w-full flex-1 flex-col'
                      : 'flex w-full flex-1 flex-col gap-6 px-6 py-5'
                } ${MAIN_CONTENT_FOCUS}`}
              >
                {children}
              </main>
            </IncidentBannerClaimProvider>
          </div>
        </div>
      </OrganisationSwitchContext.Provider>
    </PaletteProvider>
  )
}

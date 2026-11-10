import { Link, useRouterState } from '@tanstack/react-router'
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../i18n'
import { Avatar, initialsOf } from '../ui/Avatar/Avatar'
import { Button } from '../ui/Button/Button'
import { Drawer } from '../ui/Drawer/Drawer'
import { KoderaMark } from '../ui/icons/KoderaMark'
import { ModuleGlyph } from '../ui/icons/ModuleGlyph'
import { openWorkspaceCommand } from '../features/workspace/WorkspaceMenu'
import { TabGlyph } from '../ui/icons/TabGlyph'
import type { TabGlyphName } from '../ui/icons/TabGlyph'
import { ACCOUNT_ITEMS, accountRoleLabelKey } from './accountItems'
import type { AccountItem } from './accountItems'
import { OrgSwitcher } from './OrgSwitcher'
import type { OrgSwitcherMembership, OrgSwitcherOrganisation } from './OrgSwitcher'
import { consoleSurface, moduleGlyphName, railSurfaces } from './railModules'
import { otherApplications, useTenantApplications } from './tenantApplications'
import { navItemsFor } from './Sidebar'
import type { NavArea, OrganisationRole } from './Sidebar'
import type { UserBlockUser } from './UserBlock'

/**
 * The narrow layout's two bars (docs/specs/00-shell-and-login.md §4.5; when is
 * `layoutQuery.ts`'s to say), drawn in the delivered mock's mobile language:
 * one column, a top bar, and a tab bar in a five-column grid.
 *
 * Where each item lives — one place each, never two:
 *
 * - The TOP BAR carries who and where: the organisation's name, and one menu
 *   (« Compte et organisation ») holding the organisation switcher, the account
 *   block and the account list's actions (« Se déconnecter ») — about the
 *   session, not places.
 * - The TAB BAR carries the places a person goes most: « Accueil »,
 *   « Applications », « Facturation », « Aide », and « Plus ».
 * - « PLUS » opens a sheet with every other place: the sidebar areas
 *   `NAV_PLACEMENT` sends there (« Personnes », « Domaine & identité ») and the
 *   account list's places (« Sécurité et connexion », « Apparence »).
 *
 * The role matrix is the sidebar's own (`navItemsFor`) and the account entries
 * are the wide menu's own (`accountItems.ts`), so no layout can show what the
 * other hides.
 */

/**
 * Where each sidebar area goes on a phone. A `Record` over every `NavArea`: an
 * area added to the sidebar without a place here is a type error, not an area
 * phones silently lose. The order within each group is the sidebar's.
 */
const NAV_PLACEMENT: Record<NavArea, { in: 'tab'; glyph: TabGlyphName } | { in: 'more' }> = {
  home: { in: 'tab', glyph: 'home' },
  apps: { in: 'tab', glyph: 'apps' },
  people: { in: 'more' },
  domain: { in: 'more' },
  invoices: { in: 'tab', glyph: 'invoices' },
  support: { in: 'tab', glyph: 'question' },
}

// Four columns for a role without « Facturation », five otherwise; the module
// bar has three to seven. Written out so Tailwind sees every class name in the
// source.
const GRID_COLUMNS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
  6: 'grid-cols-6',
  7: 'grid-cols-7',
}

// A tab: 52 px tall (touch targets are 44 px at least, README §3), glyph over
// label, the columns edge to edge with no gutter so « Applications » fits a
// 360 px phone; below that it is cut with an ellipsis rather than spilling
// into its neighbour (its name, read from the text, stays whole). The label is
// `text-xs`, 12 px, the preset's smallest size — the mock draws 9 px, which is
// not a step of the type scale (owner-approved deviation, 2026-09-24).
//
// The current tab is told apart by more than its colour (the sidebar's rule,
// console PR 125): `c-accent-ink` ink at 600 AND a 2 px `c-accent-ink` edge
// along the bar's top; an idle tab carries the same edge, transparent, so the
// labels stay aligned. As in the sidebar, the shared base carries no colour and
// no weight — the router joins it with the active or the inactive classes.
const TAB =
  'flex min-h-[52px] w-full min-w-0 flex-col items-center justify-center gap-1 border-t-2 pb-1 pt-2 text-xs leading-tight tracking-tight transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring'
const TAB_IDLE = 'border-transparent font-medium text-c-ink-3'
const TAB_CURRENT = 'border-c-accent-ink font-semibold text-c-accent-ink'

// A row of the « Plus » sheet: the mock's settings list, one bordered row per
// place, 48 px tall. Current row: accent ink, 600, and an accent edge.
const ROW =
  'flex min-h-[48px] items-center rounded-lg border px-3 text-md transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring'
const ROW_IDLE = 'border-c-border-soft font-medium text-c-ink hover:bg-c-muted'
const ROW_CURRENT = 'border-c-accent-ink font-semibold text-c-accent-ink'

// A few pixels of air between a focused control's ring and the bar it scrolls
// clear of (WCAG 2.4.11, `.clear-of-bars` in `src/index.css`).
const FOCUS_CLEARANCE = 8

function areaOf(pathname: string): string {
  return pathname.split('/')[2] ?? ''
}

/**
 * Publishes a bar's height, safe area included, as a custom property on the
 * document: `.clear-of-bars` keeps a focused control clear of the bar,
 * and the toast stack sits above the tab bar. Removed with the bar, so the
 * wide layout reads 0.
 */
function usePublishedHeight(ref: RefObject<HTMLElement | null>, property: string): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const root = document.documentElement
    const publish = () => {
      root.style.setProperty(property, `${element.offsetHeight + FOCUS_CLEARANCE}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty(property)
    }
  }, [ref, property])
}

export interface NarrowTopBarProps {
  org: string
  organisation: OrgSwitcherOrganisation
  organisationMark?: string
  memberships?: readonly OrgSwitcherMembership[]
  onSwitchOrganisation?: (slug: string) => void
  user: UserBlockUser
  onSignOut: () => void
  /** The account entries; `ACCOUNT_ITEMS` in the app, a stub list in a test. */
  accountItems?: readonly AccountItem[]
}

/**
 * Sticky at the top, on `c-surface` with a soft hairline as in the mock's
 * frames. The organisation's name is the bar's title; it is not a heading —
 * the screen below keeps the page's one `h1`.
 */
export function NarrowTopBar({
  org,
  organisation,
  organisationMark,
  memberships,
  onSwitchOrganisation,
  user,
  onSignOut,
  accountItems = ACCOUNT_ITEMS,
}: NarrowTopBarProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const bar = useRef<HTMLElement>(null)
  usePublishedHeight(bar, '--shell-header-block')
  const avatarVariant = user.role === 'org_admin' ? 'admin' : 'member'
  const actions = accountItems.filter((item) => item.narrow === 'account-menu')

  return (
    <header
      ref={bar}
      className="safe-area-top sticky top-0 z-10 border-b border-c-border-soft bg-c-surface"
    >
      <div className="flex min-h-[56px] items-center gap-3 px-4">
        <KoderaMark className="h-[18px] w-auto shrink-0 text-c-ink" />
        <span className="min-w-0 flex-1 truncate text-lg font-semibold text-c-ink">
          {organisation.name}
        </span>
        <Drawer
          open={open}
          onOpenChange={setOpen}
          size="sm"
          title={t('console.shell.topbar.title-menu')}
          closeLabel={t('console.common.action-close')}
          trigger={
            <button
              type="button"
              // Its visible text is the avatar's initials, so its name starts with them (WCAG
              // 2.5.3, label in name: a voice user says what they see). The avatar here takes no
              // photo; one that did would show no initials, and the name would drop them.
              aria-label={
                initialsOf(user.displayName) === ''
                  ? t('console.shell.topbar.title-menu')
                  : t('console.shell.topbar.title-menu-button', {
                      initials: initialsOf(user.displayName),
                    })
              }
              className="-mr-2 flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full focus-visible:ring focus-visible:outline-hidden"
            >
              <Avatar name={user.displayName} variant={avatarVariant} />
            </button>
          }
        >
          <div className="flex flex-col gap-4">
            <OrgSwitcher
              organisation={organisation}
              {...(organisationMark === undefined ? {} : { mark: organisationMark })}
              {...(memberships === undefined ? {} : { memberships })}
              {...(onSwitchOrganisation === undefined
                ? {}
                : {
                    onSwitch: (slug: string) => {
                      setOpen(false)
                      onSwitchOrganisation(slug)
                    },
                  })}
            />
            <div className="flex items-center gap-3 rounded-lg border border-c-border-soft p-3">
              <Avatar name={user.displayName} variant={avatarVariant} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-c-ink">
                  {user.displayName}
                </span>
                <span className="block truncate text-xs text-c-ink-3">
                  {t(accountRoleLabelKey(user))}
                </span>
              </span>
            </div>
            {actions.map((item) => {
              const label = t(item.labelKey)
              // What an entry does comes from its kind, as in `UserBlock` —
              // never from being in this menu, whose other entry signs out.
              switch (item.kind) {
                case 'place':
                  return (
                    <Button key={item.id} variant="secondary" size="lg" className="w-full" asChild>
                      <Link to={item.to} params={{ org }} onClick={() => setOpen(false)}>
                        {label}
                      </Link>
                    </Button>
                  )
                case 'pending':
                  return (
                    <Button key={item.id} variant="secondary" size="lg" className="w-full" disabled>
                      {label}
                    </Button>
                  )
                case 'sign-out':
                  return (
                    <Button
                      key={item.id}
                      variant="secondary"
                      size="lg"
                      className="w-full"
                      onClick={onSignOut}
                    >
                      {label}
                    </Button>
                  )
              }
            })}
          </div>
        </Drawer>
      </div>
    </header>
  )
}

export interface NarrowModuleBarProps {
  org: string
  organisationId: string
}

/**
 * The rail's places on a phone, for a surface that has no console tab bar (`railModules.ts`,
 * `phoneTabBar`): the workspace (docs/specs/11-workspace.md §4.2). A `nav` named « Modules », as
 * the rail it stands in for, drawn like the console's tab bar and in the same place.
 *
 * « Accueil » first, the way back to the console for every role, then the surfaces the rail
 * draws but the console (« Messages », current here), then the tenant's other applications in the
 * rail's order, each opening in a new tab and saying so in its name, as on the rail. Nothing the
 * tenant does not run is drawn: a tab with nowhere to go would be a dead button.
 */
export function NarrowModuleBar({ org, organisationId }: NarrowModuleBarProps) {
  const { t } = useTranslation()
  const bar = useRef<HTMLElement>(null)
  usePublishedHeight(bar, '--shell-tab-bar-block')
  const { apps: tenantApps } = useTenantApplications(organisationId)
  const apps = otherApplications(tenantApps)
  const home = consoleSurface()
  const surfaces = railSurfaces().filter((item) => item.surface !== 'console')
  const openInNewTab = t('console.common.a11y-opens-new-tab')

  return (
    <nav
      ref={bar}
      aria-label={t('console.shell.rail.a11y-label')}
      className="safe-area-bottom sticky bottom-0 z-10 order-last border-t border-c-border-soft bg-c-surface"
    >
      <ul className={`grid ${GRID_COLUMNS[2 + surfaces.length + apps.length] ?? 'grid-cols-6'}`}>
        <li className="flex">
          <Link to={home.to} params={{ org }} className={`${TAB} ${TAB_IDLE}`}>
            <TabGlyph name="home" />
            <span className="max-w-full truncate">{t('console.shell.nav.title-home')}</span>
          </Link>
        </li>
        {surfaces.map((item) => (
          <li key={item.surface} className="flex">
            <Link
              to={item.to}
              params={{ org }}
              className={TAB}
              activeProps={{ className: TAB_CURRENT }}
              inactiveProps={{ className: TAB_IDLE }}
            >
              <ModuleGlyph name={item.glyph} size="tab" />
              <span className="max-w-full truncate">{t(item.titleKey)}</span>
            </Link>
          </li>
        ))}
        {apps.map((app) => (
          <li key={app.code} className="flex">
            <a
              href={app.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`${app.name} — ${openInNewTab}`}
              className={`${TAB} ${TAB_IDLE}`}
            >
              <ModuleGlyph name={moduleGlyphName(app.code)} size="tab" />
              <span className="max-w-full truncate">{app.name}</span>
            </a>
          </li>
        ))}
        <li className="flex">
          <button
            type="button"
            className={`${TAB} ${TAB_IDLE}`}
            data-workspace-settings-trigger
            onClick={() => openWorkspaceCommand('settings')}
          >
            <ModuleGlyph name="console" size="tab" />
            <span className="max-w-full truncate">{t('console.shell.rail.title-settings')}</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

export interface NarrowTabBarProps {
  org: string
  role: OrganisationRole
}

interface MoreEntry {
  key: string
  titleKey: MessageKey
  to: string
}

/**
 * The tab bar: a `nav` named « Navigation par onglets », told apart from the
 * wide layout's « Navigation principale » even though the two never render
 * together, so a person who meets both knows which one they are in.
 *
 * Rendered BEFORE `main` in the document, like the sidebar — the documented
 * focus order is skip link, navigation, content (§10) — and drawn at the foot
 * of the screen by `order-last` and `sticky bottom-0`: it stays on screen
 * while the page scrolls, and at the end of the page it takes its own room
 * instead of covering the last row, which a `position: fixed` bar would.
 */
export function NarrowTabBar({ org, role }: NarrowTabBarProps) {
  const { t } = useTranslation()
  const [moreOpen, setMoreOpen] = useState(false)
  const bar = useRef<HTMLElement>(null)
  usePublishedHeight(bar, '--shell-tab-bar-block')
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const allowed = navItemsFor(role)
  const tabs = allowed.flatMap((item) => {
    const placement = NAV_PLACEMENT[item.area]
    return placement.in === 'tab' ? [{ ...item, glyph: placement.glyph }] : []
  })
  const more: MoreEntry[] = [
    ...allowed
      .filter((item) => NAV_PLACEMENT[item.area].in === 'more')
      .map((item) => ({ key: item.area, titleKey: item.titleKey, to: item.to })),
    ...ACCOUNT_ITEMS.flatMap((item) =>
      item.kind === 'place' && item.narrow === 'more'
        ? [{ key: item.id, titleKey: item.labelKey, to: item.to }]
        : []
    ),
  ]
  // « Plus » is lit while one of its places is open, so the tab bar always
  // says where the person is.
  const current = areaOf(pathname)
  const moreCurrent = more.some((entry) => areaOf(entry.to) === current)

  return (
    <nav
      ref={bar}
      aria-label={t('console.shell.tabs.a11y-label')}
      className="safe-area-bottom sticky bottom-0 z-10 order-last border-t border-c-border-soft bg-c-surface"
    >
      <ul className={`grid ${GRID_COLUMNS[tabs.length + 1] ?? 'grid-cols-5'}`}>
        {tabs.map((item) => (
          <li key={item.area} className="flex">
            <Link
              to={item.to}
              params={{ org }}
              className={TAB}
              activeProps={{ className: TAB_CURRENT }}
              inactiveProps={{ className: TAB_IDLE }}
            >
              <TabGlyph name={item.glyph} />
              <span className="max-w-full truncate">{t(item.titleKey)}</span>
            </Link>
          </li>
        ))}
        <li className="flex">
          <Drawer
            open={moreOpen}
            onOpenChange={setMoreOpen}
            side="bottom"
            title={t('console.shell.tabs.title-more')}
            closeLabel={t('console.common.action-close')}
            trigger={
              <button
                type="button"
                {...(moreCurrent ? { 'aria-current': 'true' as const } : {})}
                className={`${TAB} ${moreCurrent ? TAB_CURRENT : TAB_IDLE}`}
              >
                <TabGlyph name="more" />
                <span className="max-w-full truncate">{t('console.shell.tabs.title-more')}</span>
              </button>
            }
          >
            <ul className="flex flex-col gap-2">
              {more.map((entry) => (
                <li key={entry.key}>
                  <Link
                    to={entry.to}
                    params={{ org }}
                    className={ROW}
                    activeProps={{ className: ROW_CURRENT }}
                    inactiveProps={{ className: ROW_IDLE }}
                    onClick={() => setMoreOpen(false)}
                  >
                    {t(entry.titleKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </Drawer>
        </li>
      </ul>
    </nav>
  )
}

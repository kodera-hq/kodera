import { Link } from '@tanstack/react-router'
import { isDemoActive } from './interactiveDemo'
import { useTranslation } from 'react-i18next'
import { moduleGlyphName, railSurfaces } from './railModules'
import type { RailSurface, RailSurfaceItem } from './railModules'
import type { OrganisationRole } from './Sidebar'
import type { UserBlockUser } from './UserBlock'
import { otherApplications, useTenantApplications } from './tenantApplications'
import { openWorkspaceCommand, WorkspaceMenu } from '../features/workspace/WorkspaceMenu'
import { ModuleGlyph } from '../ui/icons/ModuleGlyph'
import { RAIL_TIP_OFFSET } from '../ui/Rail/Rail'
import { Tooltip } from '../ui/Tooltip/Tooltip'

// Icons only (owner decision, 2026-11-07): a 48 px square per destination, its glyph centred. The name is
// the item's accessible name and shows beside it, on hover and on focus, as a tooltip; no visible
// label under the glyph, and no `title`, which would draw the browser's own second tooltip. The
// glyph is decoration; the control carries the name.
const ITEM_BASE =
  'flex h-12 w-12 items-center justify-center rounded-lg transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring focus-visible:ring-c-on-inverse'

// The focus ring is `c-on-inverse`, not the default ring: docs/specs/
// 00-shell-and-login.md §10 requires 3:1 against both adjacent surfaces, and
// the default ring, the theme's accent ink, is 2.20 : 1 on the rail's
// `c-inverse` ground in light. `c-on-inverse` is 17.74 / 18.51 / 20.03 : 1 on
// the rail, and 6.70 / 4.66 / 4.79 : 1 against the current item's `c-action`
// tile it sits flush with. The other inverse grounds (`Card`, `Banner` and
// `Toast`) get the same ring from `focus-ground-inverse` in `src/index.css`.
// The current item is the mock's `c-action` tile. `c-inverse-2`, its hover
// ground, sits 1.16 / 1.16 / 1.19 : 1 against the rail (light / dark / black);
// `c-action` is 2.65 / 3.97 / 4.18, with its `c-on-inverse` glyph at 6.70 /
// 4.66 / 4.79. `aria-current="page"` carries the state either way.
const ITEM_IDLE = `${ITEM_BASE} text-c-on-inverse-dim hover:bg-c-inverse-2 hover:text-c-on-inverse`
const ITEM_CURRENT = `${ITEM_BASE} relative bg-c-action text-c-on-inverse`

export interface ModuleRailProps {
  org: string
  organisationId: string
  organisationName: string
  user: UserBlockUser
  /** The surface on screen (`railModules.ts`, `surfaceOf`): its item is the current one. */
  surface?: RailSurface
  /** The role determines workspace availability; personal settings are available to everyone. */
  role?: OrganisationRole
}

/** Application navigation and a persistent entry point to personal and workspace settings.
 * Settings grants no administrative authority: each section retains its own role checks. */
export function ModuleRail({
  org,
  organisationId,
  organisationName,
  surface = 'console',
  role,
}: ModuleRailProps) {
  const { t } = useTranslation()
  const { apps: tenantApps, noTenantYet } = useTenantApplications(organisationId)
  // « Messages » is the tenant's `messaging` app (Espace), and this application's own workspace
  // surface: it is drawn once, as that surface, for an organisation that has it. An organisation
  // whose tenant runs without it (Visio alone, say) has no homeserver behind it. A member of an
  // organisation with no tenant yet lands on the workspace (`landing.ts`), which says how far its
  // setup has come, so the item stays for them; an owner's way to a first workspace is Home. On
  // the workspace itself the item stays, as the current one.
  const hasMessaging = isDemoActive(org) || tenantApps.some((app) => app.code === 'messaging')
  const memberBeforeTenant = noTenantYet && role === 'org_member'
  const apps = otherApplications(tenantApps)
  const surfaces = railSurfaces().filter((item) =>
    item.surface === 'workspace'
      ? hasMessaging || memberBeforeTenant || surface === 'workspace'
      : true
  )
  const modules = surfaces.filter((item) => item.surface !== 'console')
  const openInNewTab = t('console.common.a11y-opens-new-tab')

  // Each stays a link to its surface's entry rather than becoming inert text, so it keeps its place
  // in the tab order. The one on screen is the current item, and `aria-current="page"` is what says
  // so to a screen reader; the action tile only repeats it.
  function surfaceItem(item: RailSurfaceItem) {
    const current = item.surface === surface
    return (
      <li key={item.surface}>
        <Tooltip content={t(item.titleKey)} side="right" sideOffset={RAIL_TIP_OFFSET} names>
          <Link
            to={item.to}
            params={{ org }}
            aria-current={current ? 'page' : undefined}
            aria-label={t(item.titleKey)}
            className={current ? ITEM_CURRENT : ITEM_IDLE}
          >
            {current ? (
              <span
                aria-hidden="true"
                className="absolute top-4 left-1 h-4 w-1 rounded-sm bg-c-on-inverse"
              />
            ) : null}
            <ModuleGlyph name={item.glyph} />
          </Link>
        </Tooltip>
      </li>
    )
  }

  return (
    <nav
      aria-label={t('console.shell.rail.a11y-label')}
      className="sticky top-0 flex h-screen w-shell-rail-width shrink-0 flex-col items-center gap-3 bg-c-inverse py-4"
    >
      {surface === 'workspace' ? (
        <WorkspaceMenu
          name={organisationName}
          slug={org}
          trigger={
            <button
              type="button"
              aria-label={t('console.workspace.sidebar.action-switch-organisation', {
                name: organisationName,
              })}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-c-inverse-2 focus-visible:ring focus-visible:ring-c-on-inverse focus-visible:outline-hidden"
            >
              <img src="/kodera-mark-white.svg" alt="" className="h-5 w-auto" />
            </button>
          }
        />
      ) : (
        <Tooltip
          content={t('console.shell.rail.a11y-home', { organisation: organisationName })}
          side="right"
          sideOffset={RAIL_TIP_OFFSET}
          names
        >
          <Link
            to="/$org/home"
            params={{ org }}
            aria-label={t('console.shell.rail.a11y-home', { organisation: organisationName })}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg focus-visible:ring focus-visible:ring-c-on-inverse focus-visible:outline-hidden"
          >
            <img src="/kodera-mark-white.svg" alt="" className="h-5 w-auto" />
          </Link>
        </Tooltip>
      )}

      <ul className="flex w-full flex-1 flex-col items-center gap-1 border-t border-c-rail-line pt-3">
        {apps.map((app) => (
          <li key={app.code}>
            <Tooltip content={app.name} side="right" sideOffset={RAIL_TIP_OFFSET} names>
              <a
                href={app.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${app.name} — ${openInNewTab}`}
                className={ITEM_IDLE}
              >
                <ModuleGlyph name={moduleGlyphName(app.code)} />
              </a>
            </Tooltip>
          </li>
        ))}
        {/* The workspace, after the tenant's applications. A surface that is not released is not
            drawn (`railSurfaces`), nor Messages for an organisation without it. */}
        {modules.map(surfaceItem)}
      </ul>

      <div className="flex w-full shrink-0 flex-col items-center gap-3 border-t border-c-rail-line pt-3">
        <ul className="flex flex-col items-center">
          <li>
            <Tooltip
              content={t('console.shell.rail.title-settings')}
              side="right"
              sideOffset={RAIL_TIP_OFFSET}
              names
            >
              <button
                type="button"
                aria-current={surface === 'console' ? 'page' : undefined}
                aria-label={t('console.shell.rail.title-settings')}
                data-workspace-settings-trigger
                onClick={() => openWorkspaceCommand('settings')}
                className={surface === 'console' ? ITEM_CURRENT : ITEM_IDLE}
              >
                {surface === 'console' ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-4 left-1 h-4 w-1 rounded-sm bg-c-on-inverse"
                  />
                ) : null}
                <ModuleGlyph name="console" />
              </button>
            </Tooltip>
          </li>
        </ul>
      </div>
    </nav>
  )
}

// Which glyph the module rail draws for one application code.
//
// `AppCode` (src/api/schema.d.ts) is a closed enum today — `visio`, `docs`,
// `drive`, `messaging`, `grist` — but the rail reads a value that arrives over the
// network, so an unrecognised code must draw SOMETHING rather than an empty
// hole in the rail. Same defensive shape as `componentPillState`
// (src/features/status/components.ts): a value this module does not know
// resolves to a neutral glyph, never to another application's.
//
// The rail names its items from `TenantApp.name` — the server's own label —
// so a new application code needs no copy row here, only a glyph.

import type { components } from '@/api/schema'
import type { MessageKey } from '@/i18n'

export type AppCode = components['schemas']['AppCode']

/** Every glyph `ModuleGlyph` can draw, including the console's own and the
 * fallback for a code that is not in the contract this build was generated
 * from. */
export type ModuleGlyphName = AppCode | 'console' | 'workspace' | 'unknown'

const KNOWN: Record<AppCode, ModuleGlyphName> = {
  visio: 'visio',
  docs: 'docs',
  drive: 'drive',
  messaging: 'messaging',
  grist: 'grist',
}

/**
 * The glyph for an application code. Never throws and never falls through to
 * another application's mark: an unknown code is drawn as `unknown`.
 *
 * `Object.hasOwn` rather than a plain lookup with `??`: a code arriving from
 * the network can be any string, and `KNOWN['toString']` resolves through the
 * prototype chain to a function — truthy, so `??` would hand it back as if it
 * were a glyph name.
 */
export function moduleGlyphName(code: string): ModuleGlyphName {
  return Object.hasOwn(KNOWN, code) ? (KNOWN as Record<string, ModuleGlyphName>)[code]! : 'unknown'
}

/** The two surfaces of this application the rail switches between: the administration console
 * and the organisation's workspace (docs/specs/11-workspace.md §3). Each has its own layout in
 * `Shell`; the address says which one is on screen. The rail names the workspace « Messages »,
 * with the tenant's applications, and the console « Réglages », at its foot
 * (docs/specs/00-shell-and-login.md §4.5). */
export type RailSurface = 'console' | 'workspace'

export interface RailSurfaceItem {
  surface: RailSurface
  titleKey: MessageKey
  to: '/$org/home' | '/$org/workspace'
  glyph: ModuleGlyphName
  /** `false` keeps the item off the rail while its route stays reachable by address: for a
   * surface whose Core operations are pinned but not yet served in production. Releasing it is
   * this flag, and nothing else. */
  released?: false
  /** `'modules'`: on a phone, the console's tab bar is not drawn while this surface is on screen;
   * the rail's places are, as the surface's own tab bar (`NarrowModuleBar`), whose « Accueil » is
   * the way back to the console. `Shell.wayBack.test.tsx` holds every declared surface to a way
   * back, released or not. */
  phoneTabBar?: 'modules'
}

/** In the rail's order: the workspace after the tenant's own applications, the console at the
 * foot. */
const RAIL_SURFACES: readonly RailSurfaceItem[] = [
  {
    surface: 'workspace',
    titleKey: 'console.shell.rail.title-workspace',
    to: '/$org/workspace',
    // « Messages », drawn as a speech bubble, as the reference draws it.
    glyph: 'messaging',
    // The workspace draws the rail's places on a phone (docs/specs/11-workspace.md §4.2).
    phoneTabBar: 'modules',
  },
  {
    surface: 'console',
    titleKey: 'console.shell.rail.title-settings',
    to: '/$org/home',
    glyph: 'console',
  },
]

/** The surfaces the rail draws: the released ones, unless `includeUnreleased` asks for all. */
export function railSurfaces({
  includeUnreleased = false,
}: { includeUnreleased?: boolean } = {}): readonly RailSurfaceItem[] {
  return RAIL_SURFACES.filter((item) => includeUnreleased || item.released !== false)
}

/** The console's own item: where the way back from a surface without the console's phone tab bar
 * leads. */
export function consoleSurface(): RailSurfaceItem & { to: '/$org/home' } {
  const item = RAIL_SURFACES.find((candidate) => candidate.surface === 'console')
  if (item === undefined || item.to !== '/$org/home')
    throw new Error('The rail has no console item.')
  return { ...item, to: item.to }
}

/** Which tab bar a phone draws while `surface` is on screen: the console's, or the rail's places. */
export function phoneTabBarOf(surface: RailSurface): 'console' | 'modules' {
  return RAIL_SURFACES.some((item) => item.surface === surface && item.phoneTabBar === 'modules')
    ? 'modules'
    : 'console'
}

/** The surface an address belongs to: `/{org}/workspace…` is the workspace, the rest the console. */
export function surfaceOf(pathname: string): RailSurface {
  return pathname.split('/')[2] === 'workspace' ? 'workspace' : 'console'
}

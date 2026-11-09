import type { MessageKey } from '../i18n'
import { ACCOUNT_ITEMS } from './accountItems'
import { navItemsFor, type OrganisationRole } from './Sidebar'

/** Use the existing destinations and role matrix; nested pages retain their area. */
export function contentTitleKey(pathname: string, role: OrganisationRole): MessageKey {
  const area = pathname.split('/')[2]
  // The workspace is its own surface beside the console (`railModules.ts`), not a console area.
  if (area === 'workspace') return 'console.workspace._.title'
  const navigation = navItemsFor(role).find((item) => item.to.split('/')[2] === area)
  if (navigation) return navigation.titleKey
  const account = ACCOUNT_ITEMS.find(
    (item) => item.kind === 'place' && item.to.split('/')[2] === area
  )
  return account?.labelKey ?? 'console.shell.rail.title-console'
}

/**
 * The title a route change announces (docs/specs/00-shell-and-login.md §10):
 * the one the content header shows, except in the order flow. The order is no
 * navigation item, so the header has only its fallback there, and « Page
 * Console chargée. » tells a person nothing about where they are: the flow is
 * announced under its own name, the one each of its screens carries for a
 * screen reader.
 */
export function announcedTitleKey(pathname: string, role: OrganisationRole): MessageKey {
  if (pathname.split('/')[2] === 'order') return 'console.order._.title'
  return contentTitleKey(pathname, role)
}

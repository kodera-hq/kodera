// The organisation switch, for a surface that draws its own organisation header instead of the
// console sidebar's switcher: the workspace (docs/specs/11-workspace.md §4.1). `Shell` provides
// what `OrgLayout` hands it; outside a shell, as in a component test, there is none, and the
// header draws the organisation without a menu.

import { createContext, useContext } from 'react'
import type { AdminSection } from '../features/workspace/admin/sections'
import type { OrgSwitcherMembership } from './OrgSwitcher'

export interface OrganisationSwitch {
  /** Every organisation the signed-in identity belongs to, from `GET /me`, the current one marked. */
  readonly memberships: readonly OrgSwitcherMembership[]
  /** Opens the chosen organisation; `OrgLayout` keeps the area and handles a different realm. */
  readonly onSwitch: (slug: string) => void
  /**
   * Whether the signed-in identity is staff (`Me.staff`). On the public community's own host an
   * ordinary member has no workspace of their own to create, so the menu does not offer to create
   * one; staff, who operate the fleet, keep it.
   */
  readonly staff?: boolean | undefined
  /**
   * Whether the caller may open the workspace administration at all: an owner, an administrator,
   * or a member with at least one delegated administration capability (`manage_roles`,
   * `view_audit_log`). `false` hides every administration entry point; `undefined` (no shell, as
   * in a component test) leaves the decision to the consumer's default.
   */
  readonly canAdminister?: boolean | undefined
  /** The administration sections this caller may open; `undefined` when unknown. */
  readonly adminSections?: readonly AdminSection[] | undefined
}

export const OrganisationSwitchContext = createContext<OrganisationSwitch | undefined>(undefined)

export function useOrganisationSwitch(): OrganisationSwitch | undefined {
  return useContext(OrganisationSwitchContext)
}

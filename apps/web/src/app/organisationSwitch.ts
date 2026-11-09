// The organisation switch, for a surface that draws its own organisation header instead of the
// console sidebar's switcher: the workspace (docs/specs/11-workspace.md §4.1). `Shell` provides
// what `OrgLayout` hands it; outside a shell, as in a component test, there is none, and the
// header draws the organisation without a menu.

import { createContext, useContext } from 'react'
import type { OrgSwitcherMembership } from './OrgSwitcher'

export interface OrganisationSwitch {
  /** Every organisation the signed-in identity belongs to, from `GET /me`, the current one marked. */
  readonly memberships: readonly OrgSwitcherMembership[]
  /** Opens the chosen organisation; `OrgLayout` keeps the area and handles a different realm. */
  readonly onSwitch: (slug: string) => void
}

export const OrganisationSwitchContext = createContext<OrganisationSwitch | undefined>(undefined)

export function useOrganisationSwitch(): OrganisationSwitch | undefined {
  return useContext(OrganisationSwitchContext)
}

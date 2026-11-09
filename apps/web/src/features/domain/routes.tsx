import { createRoute } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { DomainScreen } from './DomainScreen'

// `/{org}/domain` — « Domaine & identité » (docs/specs/04-domain.md), first
// slice: the list of addresses, read-only
// (docs/specs/domain-addresses-list.md). Hidden from a member's and a billing
// contact's navigation (`src/app/Sidebar.tsx`); for a direct URL the screen
// itself answers with the role banner rather than the list
// (docs/specs/00-shell-and-login.md §5, acceptance test 7).
//
// No search parameter is declared yet. `?tab=` arrives with the tab strip,
// and the strip with the second tab (docs/specs/07-federation.md), which is
// still the stub route `/{org}/federation`; its redirect into this screen
// lands with it. The other routes of the specification — `domain/new`,
// `domain/$domainId` — are registered by the slices that build their screens,
// as flat siblings under `orgRoute` the way the invoices area registers its own.
export const domainRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'domain',
  component: DomainScreen,
})

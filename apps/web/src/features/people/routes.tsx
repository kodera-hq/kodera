// `/{org}/people` — "Personnes" (docs/specs/03-people.md §3). Flat siblings
// under `orgRoute`, like every other area: the drawers (`invite`, a member)
// and the On-site tab keep the list underneath, so each of those routes
// renders the same `PeopleScreen` with its own tab or drawer. Static
// segments (`invite`, `import`, `on-site`) match before `$memberId`.
//
// Hidden from a member's and a billing contact's navigation
// (`src/app/Sidebar.tsx`); a direct URL answers with the role-needed banner
// (docs/specs/00-shell-and-login.md §5, acceptance test 7).

import { createRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { z } from 'zod'
import { orgRoute } from '../../app/org-route'
import { RequireRole } from '../../app/RequireRole'
import {
  PeopleImportBody,
  PeopleImportResultBody,
  PeopleInviteBody,
  PeopleListBody,
  PeopleMemberBody,
  PeopleOnSiteBody,
  PeopleRecoveryGate,
} from './PeopleArea'

function Guard({ children }: { children: ReactNode }) {
  return (
    <PeopleRecoveryGate>
      <RequireRole allow={['org_owner', 'org_admin']} titleKey="console.shell.nav.title-people">
        {children}
      </RequireRole>
    </PeopleRecoveryGate>
  )
}

export const peopleRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'people',
  validateSearch: z.object({ tab: z.enum(['invitations']).optional() }),
  component: () => (
    <Guard>
      <PeopleListBody />
    </Guard>
  ),
})

export const peopleInviteRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'people/invite',
  component: () => (
    <Guard>
      <PeopleInviteBody />
    </Guard>
  ),
})

export const peopleOnSiteRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'people/on-site',
  component: () => (
    <Guard>
      <PeopleOnSiteBody />
    </Guard>
  ),
})

export const peopleMemberRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'people/$memberId',
  component: () => (
    <Guard>
      <PeopleMemberBody />
    </Guard>
  ),
})

export const peopleImportRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'people/import',
  /** §3: the order confirmation and the status screen link here. */
  validateSearch: z.object({ from: z.enum(['order', 'status']).optional() }),
  component: () => (
    <Guard>
      <PeopleImportBody />
    </Guard>
  ),
})

export const peopleImportResultRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'people/import/$importId',
  component: () => (
    <Guard>
      <PeopleImportResultBody />
    </Guard>
  ),
})

// docs/specs/03-people.md §7 `people.empty`: one membership (the owner), no
// invitations, `memberships/count` returns 1.

import { caller, peopleHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({ callerRole: 'org_owner', members: [caller('org_owner')] })

export const handlers = scenario()

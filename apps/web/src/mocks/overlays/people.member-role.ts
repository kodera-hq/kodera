// docs/specs/03-people.md §7 `people.member-role`: the caller is a member; the
// area is not reachable.

import { defaultMembers, peopleHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({
    callerRole: 'org_member',
    members: defaultMembers('org_member'),
  })

export const handlers = scenario()

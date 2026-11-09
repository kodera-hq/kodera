// docs/specs/03-people.md §7 `people.last-owner`: the caller is the only
// owner, so their own detail answers `can_remove: false`,
// `can_change_role: false`, `blocked_reason: last_owner`.

import { caller, member, peopleHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({
    callerRole: 'org_owner',
    members: [caller('org_owner'), member('Marc Petit', 'marc.petit@acme.fr', 'org_member')],
  })

export const handlers = scenario()

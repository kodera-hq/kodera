// docs/specs/03-people.md §4.1: the same list seen by an owner. Marie Dupont
// is a second owner, so the caller is not the last one.

import { defaultMembers, invitation, peopleHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({
    callerRole: 'org_owner',
    members: defaultMembers('org_owner'),
    invitations: [invitation('anne.moreau@acme.fr')],
  })

export const handlers = scenario()

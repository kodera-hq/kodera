// docs/specs/03-people.md §4.1: the wireframe's People list, seen by an
// administrator (the caller `/me` names), with two pending invitations.

import { defaultMembers, invitation, peopleHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({
    callerRole: 'org_admin',
    members: defaultMembers('org_admin'),
    invitations: [
      invitation('anne.moreau@acme.fr'),
      invitation('paul.girard@acme.fr', 'org_admin'),
    ],
  })

export const handlers = scenario()

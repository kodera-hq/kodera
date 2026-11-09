// docs/specs/03-people.md §7 `people.large-list`: 118 memberships over three
// cursor pages of the console's page size, `has_more` on the first two.

import { caller, member, peopleHandlers } from './support/people'

const others = Array.from({ length: 117 }, (_, i) =>
  member(`Personne ${String(i + 1).padStart(3, '0')}`, `personne${i + 1}@acme.fr`, 'org_member')
)

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({
    callerRole: 'org_owner',
    members: [caller('org_owner'), ...others],
  })

export const handlers = scenario()

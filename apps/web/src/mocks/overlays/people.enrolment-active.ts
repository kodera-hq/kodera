// docs/specs/03-people.md §7 `people.enrolment-active`: one active sheet, 12
// places, 5 used.

import { defaultMembers, peopleHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  peopleHandlers({
    callerRole: 'org_owner',
    members: defaultMembers('org_owner'),
    tokens: [
      {
        id: 'e1e1e1e1-0000-4000-8000-000000000001',
        organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
        role: 'org_member',
        state: 'active',
        max_uses: 12,
        uses: 5,
        label: null,
        fingerprint: '4a1b2c3d4e5f6071',
        expires_at: '2027-03-05T09:12:00Z',
        created_at: '2027-03-04T09:12:00Z',
      },
    ],
  })

export const handlers = scenario()

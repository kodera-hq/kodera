// docs/specs/03-people.md §7 `people.import-mixed`: the mapping answers 118
// ready, 4 already members, 2 duplicates, 0 invalid.

import { memberImportHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  memberImportHandlers({
    summary: { ready: 118, already_member: 4, already_invited: 0, duplicate: 2, invalid: 0 },
  })

export const handlers = scenario()

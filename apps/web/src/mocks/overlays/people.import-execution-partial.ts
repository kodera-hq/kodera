// docs/specs/03-people.md §7 `people.import-execution-partial`: after
// execution `state: partially_failed`, 114 invited, 4 failed rows with a
// `reason_code` each.

import { memberImportHandlers } from './support/people'

/** A fresh store, for a unit test that must not inherit another test's writes. */
export const scenario = () =>
  memberImportHandlers({
    summary: { ready: 118, already_member: 4, already_invited: 0, duplicate: 2, invalid: 0 },
    outcome: 'partially_failed',
    failedRows: [
      { line: 42, email: 'jean.martin@acme..fr', status: 'failed', reason_code: 'invalid_email' },
      {
        line: 77,
        email: 's.benali@acme.fr',
        status: 'failed',
        reason_code: 'mail_provider_rejected',
      },
      { line: 91, email: 'contact@acme.fr', status: 'failed', reason_code: 'already_invited' },
      { line: 103, email: 'pierre@', status: 'failed', reason_code: 'invalid_email' },
    ],
  })

export const handlers = scenario()

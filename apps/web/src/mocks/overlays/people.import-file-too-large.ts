// docs/specs/03-people.md §7 `people.import-file-too-large`: the upload is
// refused with `413 payload-too-large`, the limit named in `detail`.

import { http } from 'msw/http'
import { problem } from '../problem'

export const handlers = [
  http.post('*/api/v1/organisations/:organisation_id/member-imports', () =>
    problem('https://kodera.io/problems/payload-too-large', {
      detail: 'At most 2 MB and 5000 rows.',
    })
  ),
]

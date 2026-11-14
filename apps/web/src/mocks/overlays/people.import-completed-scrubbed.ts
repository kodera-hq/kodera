// docs/specs/03-people.md §7 `people.import-completed-scrubbed`: a completed
// import read back after its personal staging data is gone — `filename:
// null`, `rows: []`, no detected sample, durable counts only.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { ORG_ID } from './support/people'

type MemberImport = components['schemas']['MemberImport']

export const SCRUBBED_IMPORT_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'

export const handlers = [
  http.get('*/api/v1/member-imports/:member_import_id', () => {
    const body: MemberImport = {
      id: SCRUBBED_IMPORT_ID,
      organisation_id: ORG_ID,
      state: 'completed',
      filename: null,
      row_count: 124,
      has_header_row: true,
      detected_columns: [
        { index: 0, header: null, sample: null },
        { index: 1, header: null, sample: null },
        { index: 2, header: null, sample: null },
      ],
      column_mapping: null,
      default_role: 'org_member',
      summary: {
        ready: 0,
        already_member: 4,
        already_invited: 0,
        duplicate: 2,
        invalid: 0,
        invited: 118,
        failed: 0,
      },
      rows: [],
      staging_expires_at: '2027-03-11T09:12:00Z',
      created_at: '2027-03-04T09:12:00Z',
    }
    return HttpResponse.json(body, { headers: { ETag: '"scrubbed-1"' } })
  }),
]

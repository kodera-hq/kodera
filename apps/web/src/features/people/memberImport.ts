// docs/specs/03-people.md §4.3 and §6: the staged CSV import. Upload is the
// contract's only multipart body; the mapping is a `PATCH` whose `If-Match`
// comes from a fresh read; execution is a synchronous `POST` that answers the
// same batch result as the invitation drawer.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import { offers } from '../../app/capabilities'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'
import { peopleKeys, type MemberImport, type Tagged } from './queries'
import type { InvitationRole } from './roles'

export type ColumnMapping = NonNullable<
  components['schemas']['MemberImportPatchRequest']['column_mapping']
>

/** States the server is still working through; the console re-reads them. */
const IN_PROGRESS: ReadonlySet<MemberImport['state']> = new Set(['validating', 'running'])

export const POLL_INTERVAL_MS = 1000

/** A failed poll is retried this many times, backing off, before polling stops. */
export const POLL_RETRIES = 3
const POLL_MAX_DELAY_MS = 10_000

/** 1 s, 2 s, 4 s… capped at 10 s. */
export function pollRetryDelay(failureCount: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** failureCount, POLL_MAX_DELAY_MS)
}

function inProgress(record: Tagged<MemberImport> | undefined): boolean {
  return record !== undefined && IN_PROGRESS.has(record.value.state)
}

export async function fetchMemberImport(importId: string): Promise<Tagged<MemberImport>> {
  const { data, response } = await coreApi().GET('/member-imports/{member_import_id}', {
    params: { path: { member_import_id: importId } },
  })
  const etag = response.headers.get('ETag')
  if (data === undefined || etag === null) {
    throw new Error('GET member import answered without a body or an ETag.')
  }
  return { value: data, etag }
}

export function memberImportQuery(importId: string) {
  return {
    queryKey: peopleKeys.memberImport(importId),
    queryFn: () => fetchMemberImport(importId),
  }
}

export function useMemberImportQuery(importId: string | null) {
  const options = memberImportQuery(importId ?? '')
  const polling = inProgress(useQueryClient().getQueryData<Tagged<MemberImport>>(options.queryKey))
  return useQuery({
    ...options,
    // Never fetched while Core does not serve it (`src/app/capabilities.ts`).
    enabled: importId !== null && offers('member-import'),
    // A failed poll backs off, then stops: the query turns to error and the
    // screen offers a retry, rather than polling a failing server forever.
    ...(polling ? { retry: POLL_RETRIES, retryDelay: pollRetryDelay } : {}),
    // §6: polled while `state` is `validating` or `running`.
    refetchInterval: (query) =>
      query.state.status !== 'error' && inProgress(query.state.data) ? POLL_INTERVAL_MS : false,
  })
}

export async function uploadMemberImport(
  organisationId: string,
  file: File,
  idempotencyKey: string
): Promise<MemberImport> {
  const form = new FormData()
  form.append('file', file)
  // `mutate` always sends JSON, so the multipart upload goes through the
  // client directly; the middleware still raises a refusal as `ApiProblem`.
  // Returning `FormData` from the serializer lets the browser set the
  // multipart boundary itself.
  const { data } = await coreApi().POST('/organisations/{organisation_id}/member-imports', {
    params: {
      path: { organisation_id: organisationId },
      header: { 'Idempotency-Key': idempotencyKey },
    },
    body: { file: file.name },
    bodySerializer: () => form,
  })
  if (data === undefined) throw new Error('POST member-imports resolved with no body.')
  return data
}

export async function mapMemberImport(
  importId: string,
  columnMapping: ColumnMapping,
  defaultRole: InvitationRole
): Promise<MemberImport> {
  // The tag comes only from a fresh read, never from a cached one: the
  // server rewrites the record while it validates.
  const fresh = await fetchMemberImport(importId)
  return mutate(
    { method: 'patch', path: '/member-imports/{member_import_id}' },
    {
      params: { path: { member_import_id: importId } },
      body: { column_mapping: columnMapping, default_role: defaultRole },
      concurrency: fresh.etag,
    }
  )
}

export function executeMemberImport(
  importId: string,
  options: { onlyLines?: number[]; locale: 'fr' | 'en' },
  idempotencyKey: string
) {
  return mutate(
    { method: 'post', path: '/member-imports/{member_import_id}/actions/execute' },
    {
      params: {
        path: { member_import_id: importId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body: {
        ...(options.onlyLines === undefined ? {} : { only_lines: options.onlyLines }),
        send_email: true,
        locale: options.locale,
      },
    }
  )
}

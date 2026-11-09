import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProblem, coreApi } from '@/api/client'
import { authAdapter } from '@/auth/oidc'
import { server } from '@/mocks/server'
import {
  defaultMembers,
  invitation,
  member,
  memberImportHandlers,
  ORG_ID,
  peopleHandlers,
} from '@/mocks/overlays/support/people'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.example.test/api/v1')
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
})
afterEach(() => {
  server.resetHandlers()
  vi.restoreAllMocks()
})
afterAll(() => server.close())

/** Both handlers finish parsing before either continuation may compare/write. */
function synchronizePatchBodies(url: string) {
  const parse = Request.prototype.json
  let release!: () => void
  const bothParsed = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived = 0
  vi.spyOn(Request.prototype, 'json').mockImplementation(async function (this: Request) {
    const body: unknown = await parse.call(this)
    if (this.method === 'PATCH' && this.url === url) {
      arrived += 1
      if (arrived === 2) release()
      await bothParsed
    }
    return body
  })
}

describe('People mock request fidelity', () => {
  it('allows only one simultaneous membership write from the same tag', async () => {
    const target = member('Concurrent member', 'concurrent@example.test', 'org_member')
    server.use(
      ...peopleHandlers({
        callerRole: 'org_owner',
        members: [...defaultMembers('org_owner'), target],
      })
    )
    const url = `https://core.example.test/api/v1/organisations/${ORG_ID}/memberships/${target.id}`
    const oldTag = (await fetch(url)).headers.get('ETag')!
    const bodies = [{ role: 'org_admin' }, { role: 'org_billing' }]
    synchronizePatchBodies(url)
    const responses = await Promise.all(
      bodies.map((body) =>
        fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': oldTag },
          body: JSON.stringify(body),
        })
      )
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
    const winner = responses.findIndex((response) => response.status === 200)
    const loser = responses.find((response) => response.status === 412)!
    const currentTag = responses[winner]!.headers.get('ETag')!
    expect(currentTag).toBe(`"${target.id}-2"`)
    expect(loser.headers.get('ETag')).toBe(currentTag)
    expect(await loser.json()).toMatchObject({
      type: 'https://kodera.io/problems/precondition-failed',
      current_etag: currentTag,
    })
    const reread = await fetch(url)
    expect((await reread.json()).role).toBe(bodies[winner]!.role)
    expect(reread.headers.get('ETag')).toBe(currentTag)
  })

  it('allows only one simultaneous import mapping write from the same tag', async () => {
    server.use(...memberImportHandlers())
    const uploaded = await coreApi().POST('/organisations/{organisation_id}/member-imports', {
      params: {
        path: { organisation_id: ORG_ID },
        header: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000004' },
      },
      body: { file: 'equipe.csv' },
    })
    const id = uploaded.data!.id
    const url = `https://core.example.test/api/v1/member-imports/${id}`
    const oldTag = (await fetch(url)).headers.get('ETag')!
    const bodies = [
      { column_mapping: { email: 1 }, default_role: 'org_member' },
      { column_mapping: { email: 2 }, default_role: 'org_admin' },
    ]
    synchronizePatchBodies(url)
    const responses = await Promise.all(
      bodies.map((body) =>
        fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': oldTag },
          body: JSON.stringify(body),
        })
      )
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
    const winner = responses.findIndex((response) => response.status === 200)
    const loser = responses.find((response) => response.status === 412)!
    const currentTag = responses[winner]!.headers.get('ETag')!
    expect(currentTag).toBe(`"${id}-2"`)
    expect(loser.headers.get('ETag')).toBe(currentTag)
    expect(await loser.json()).toMatchObject({
      type: 'https://kodera.io/problems/precondition-failed',
      current_etag: currentTag,
    })
    const reread = await fetch(url)
    expect(await reread.json()).toMatchObject(bodies[winner]!)
    expect(reread.headers.get('ETag')).toBe(currentTag)
  })

  it('replays the first resend response without another send or later response mutation', async () => {
    const pending = invitation('replay@example.test')
    server.use(
      ...peopleHandlers({
        callerRole: 'org_admin',
        members: defaultMembers('org_admin'),
        invitations: [pending],
      })
    )
    const resend = (key: string) =>
      coreApi().POST('/invitations/{invitation_id}/actions/resend', {
        params: { path: { invitation_id: pending.id }, header: { 'Idempotency-Key': key } },
      })
    const first = (await resend('00000000-0000-4000-8000-000000000001')).data
    expect(first?.sent_count).toBe(2)
    expect((await resend('00000000-0000-4000-8000-000000000001')).data).toEqual(first)
    expect((await resend('00000000-0000-4000-8000-000000000002')).data?.sent_count).toBe(3)
    expect((await resend('00000000-0000-4000-8000-000000000001')).data).toEqual(first)
    const list = await coreApi().GET('/organisations/{organisation_id}/invitations', {
      params: { path: { organisation_id: ORG_ID } },
    })
    expect(list.data?.data.find((row) => row.id === pending.id)?.sent_count).toBe(3)
  })

  it('rejects stale membership tags with the current tag and no role/version mutation', async () => {
    const target = member('Synthetic member', 'member@example.test', 'org_member')
    server.use(
      ...peopleHandlers({
        callerRole: 'org_owner',
        members: [...defaultMembers('org_owner'), target],
      })
    )
    const path = { organisation_id: ORG_ID, membership_id: target.id }
    const original = await coreApi().GET(
      '/organisations/{organisation_id}/memberships/{membership_id}',
      {
        params: { path },
      }
    )
    const oldTag = original.response.headers.get('ETag')!
    const changed = await coreApi().PATCH(
      '/organisations/{organisation_id}/memberships/{membership_id}',
      {
        params: { path, header: { 'If-Match': oldTag } },
        body: { role: 'org_admin' },
      }
    )
    const currentTag = changed.response.headers.get('ETag')!
    expect(currentTag).not.toBe(oldTag)
    const failure = await coreApi()
      .PATCH('/organisations/{organisation_id}/memberships/{membership_id}', {
        params: { path, header: { 'If-Match': oldTag } },
        body: { role: 'org_billing' },
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiProblem)
    expect(failure).toMatchObject({
      status: 412,
      type: 'https://kodera.io/problems/precondition-failed',
      currentEtag: currentTag,
    })
    const refused = await fetch(
      `https://core.example.test/api/v1/organisations/${ORG_ID}/memberships/${target.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': oldTag },
        body: JSON.stringify({ role: 'org_billing' }),
      }
    )
    expect(refused.status).toBe(412)
    expect(refused.headers.get('ETag')).toBe(currentTag)
    expect((await refused.json()).current_etag).toBe(currentTag)
    const malformed = await fetch(
      `https://core.example.test/api/v1/organisations/${ORG_ID}/memberships/${target.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': oldTag },
        body: '{',
      }
    )
    expect(malformed.status).toBe(412)
    expect(malformed.headers.get('ETag')).toBe(currentTag)
    const reread = await coreApi().GET(
      '/organisations/{organisation_id}/memberships/{membership_id}',
      {
        params: { path },
      }
    )
    expect(reread.data?.role).toBe('org_admin')
    expect(reread.response.headers.get('ETag')).toBe(currentTag)
    const missing = await fetch(
      `https://core.example.test/api/v1/organisations/${ORG_ID}/memberships/${target.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json' },
        body: '{',
      }
    )
    expect(missing.status).toBe(428)
    expect((await missing.json()).type).toBe('https://kodera.io/problems/precondition-required')
  })

  it('rejects stale import tags with the current tag and no mapping/version mutation', async () => {
    server.use(...memberImportHandlers())
    const uploaded = await coreApi().POST('/organisations/{organisation_id}/member-imports', {
      params: {
        path: { organisation_id: ORG_ID },
        header: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000003' },
      },
      body: { file: 'equipe.csv' },
    })
    const path = { member_import_id: uploaded.data!.id }
    const original = await coreApi().GET('/member-imports/{member_import_id}', { params: { path } })
    const oldTag = original.response.headers.get('ETag')!
    const changed = await coreApi().PATCH('/member-imports/{member_import_id}', {
      params: { path, header: { 'If-Match': oldTag } },
      body: { column_mapping: { email: 2 }, default_role: 'org_member' },
    })
    const currentTag = changed.response.headers.get('ETag')!
    expect(currentTag).not.toBe(oldTag)
    const failure = await coreApi()
      .PATCH('/member-imports/{member_import_id}', {
        params: { path, header: { 'If-Match': oldTag } },
        body: { column_mapping: { email: 0 }, default_role: 'org_admin' },
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiProblem)
    expect(failure).toMatchObject({
      status: 412,
      type: 'https://kodera.io/problems/precondition-failed',
      currentEtag: currentTag,
    })
    const refused = await fetch(
      `https://core.example.test/api/v1/member-imports/${path.member_import_id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': oldTag },
        body: JSON.stringify({ column_mapping: { email: 0 }, default_role: 'org_admin' }),
      }
    )
    expect(refused.status).toBe(412)
    expect(refused.headers.get('ETag')).toBe(currentTag)
    expect((await refused.json()).current_etag).toBe(currentTag)
    const malformed = await fetch(
      `https://core.example.test/api/v1/member-imports/${path.member_import_id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': oldTag },
        body: '{',
      }
    )
    expect(malformed.status).toBe(412)
    expect(malformed.headers.get('ETag')).toBe(currentTag)
    const reread = await coreApi().GET('/member-imports/{member_import_id}', { params: { path } })
    expect(reread.data?.column_mapping).toEqual({ email: 2 })
    expect(reread.data?.default_role).toBe('org_member')
    expect(reread.response.headers.get('ETag')).toBe(currentTag)
    const missing = await fetch(
      `https://core.example.test/api/v1/member-imports/${path.member_import_id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json' },
        body: '{',
      }
    )
    expect(missing.status).toBe(428)
    expect((await missing.json()).type).toBe('https://kodera.io/problems/precondition-required')
  })
})

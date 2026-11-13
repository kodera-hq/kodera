// What the generated msw handlers actually answer.
//
// Every assertion here stands for a failure that produces no error message. A
// collection that answers the `CursorPage` example verbatim is an empty page, and
// every list screen in the console would render its empty state against a green
// suite. A POST that does not replay by idempotency key lets a retried order create a
// second one, which the mocks would never catch either.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EXAMPLES } from '@/mocks/generated/examples'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { PROBLEM_TYPES } from '@/mocks/generated/problems'
import { server } from '@/mocks/server'

const BASE = 'https://core.test/api/v1'

// Any value the path parameter can take; the handlers match on shape, not on identity.
const fill = (path: string): string => path.replace(/\{[^{}]+\}/g, 'fixture-id')

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
})
afterAll(() => {
  server.close()
})

const operations = Object.values(EXAMPLES)
const collections = operations.filter((op) => op.isList)

describe('the generated handlers', () => {
  it('cover every operation in the contract', () => {
    // A count that silently drops to zero would make every assertion below vacuous.
    expect(operations.length).toBe(166)
    expect(collections.length).toBeGreaterThan(20)
  })

  it.each(collections.map((op) => [op.operationId, op] as const))(
    '%s answers a page with at least one row',
    async (_id, op) => {
      const response = await fetch(`${BASE}${fill(op.path)}`, {
        method: op.method.toUpperCase(),
        headers: op.idempotent ? { 'Idempotency-Key': crypto.randomUUID() } : {},
      })
      expect(response.status).toBe(op.status)
      expect(response.headers.get('X-Request-Id')).toBeTruthy()
      const page = (await response.json()) as { data: unknown[]; has_more: boolean }
      expect(Array.isArray(page.data)).toBe(true)
      expect(page.data.length).toBeGreaterThanOrEqual(1)
      expect(page).toHaveProperty('has_more')
    }
  )

  it('replaces device subscriptions through PUT', async () => {
    const op = EXAMPLES.putPushSubscription
    expect(op.method).toBe('put')
    const response = await fetch(`${BASE}${fill(op.path)}`, { method: 'PUT' })
    expect(response.status).toBe(204)
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('gives every response a fresh X-Request-Id', async () => {
    const first = await fetch(`${BASE}/me`)
    const second = await fetch(`${BASE}/me`)
    const a = first.headers.get('X-Request-Id')
    expect(a).toBeTruthy()
    expect(second.headers.get('X-Request-Id')).not.toBe(a)
  })

  it('answers a text/plain operation with its plain-text example', async () => {
    const response = await fetch(`${BASE}/legal-documents/cgv/2026.11/fr`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
    expect(await response.text()).toContain('# Conditions générales de vente')
  })
})

describe('idempotency on POST', () => {
  const post = (key?: string): Promise<Response> =>
    fetch(`${BASE}/organisations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      body: JSON.stringify({ name: 'ACME' }),
    })

  it('replays the first response for a repeated key', async () => {
    const key = 'a-key-used-twice'
    const first = await post(key)
    const firstBody: unknown = await first.json()
    const operationReference = first.headers.get('X-Operation-Ref')
    expect(operationReference).toMatch(/^[0-9a-f]{64}$/)
    expect(operationReference).not.toMatch(/\n/)
    expect(first.headers.get('Idempotency-Replayed')).toBeNull()

    const second = await post(key)
    expect(second.status).toBe(first.status)
    expect(second.headers.get('Idempotency-Replayed')).toBe('true')
    expect(second.headers.get('X-Operation-Ref')).toBe(operationReference)
    expect(await second.json()).toEqual(firstBody)
  })

  it('treats a different key as a different request', async () => {
    await post('key-one')
    const other = await post('key-two')
    expect(other.headers.get('Idempotency-Replayed')).toBeNull()
  })

  it('refuses a POST with no key, as a problem document from the registry', async () => {
    const response = await post()
    expect(response.status).toBe(400)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
    expect(response.headers.get('X-Operation-Ref')).toBeNull()

    const body = (await response.json()) as { type: string; request_id: string; status: number }
    expect(body.type).toBe('https://kodera.io/problems/idempotency-key-missing')
    expect(PROBLEM_TYPES).toContain(body.type)
    expect(body.status).toBe(400)
    expect(body.request_id).toBe(response.headers.get('X-Request-Id'))
  })
})

describe('If-Match on PATCH', () => {
  const patchOps = operations.filter((op) => op.method === 'patch')

  it('every PATCH the contract declares requires If-Match', () => {
    // A fixed inventory prevents the conditional-write assertions becoming vacuous.
    expect(patchOps.length).toBe(14)
    expect(patchOps.every((op) => op.requiresIfMatch)).toBe(true)
  })

  it('requires If-Match on collection row replacement too', async () => {
    const op = EXAMPLES.putWorkspaceCollectionRow
    expect(op.requiresIfMatch).toBe(true)
    const url = `${BASE}${fill(op.path)}`
    const refused = await fetch(url, { method: 'PUT' })
    expect(refused.status).toBe(428)
    expect(await refused.json()).toMatchObject({
      type: 'https://kodera.io/problems/precondition-required',
    })
    const accepted = await fetch(url, { method: 'PUT', headers: { 'If-Match': '"row-tag"' } })
    expect(accepted.status).toBe(200)
  })

  const patchMe = (ifMatch?: string): Promise<Response> =>
    fetch(`${BASE}/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/merge-patch+json',
        ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }),
      },
      body: JSON.stringify({ locale: 'fr' }),
    })

  it('answers the example when If-Match is present', async () => {
    const response = await patchMe('"some-etag"')
    expect(response.status).toBe(200)
  })

  it('refuses a PATCH with no If-Match, as a problem document from the registry', async () => {
    const response = await patchMe()
    expect(response.status).toBe(428)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
    expect(response.headers.get('X-Request-Id')).toBeTruthy()

    const body = (await response.json()) as { type: string; request_id: string; status: number }
    expect(body.type).toBe('https://kodera.io/problems/precondition-required')
    expect(PROBLEM_TYPES).toContain(body.type)
    expect(body.status).toBe(428)
    expect(body.request_id).toBe(response.headers.get('X-Request-Id'))
  })
})

describe('202-then-poll (CONVENTIONS §7)', () => {
  it('a 202 carries a Location a caller can follow to GET /jobs/{job_id}', async () => {
    // `deleteDomain` is a `DELETE` that enqueues a job rather than acting inline — one of
    // the operations `Location`'s header-level example (not its schema, which carries none)
    // was silently dropped for before spec.ts read `header.example` too. (`removeMembership`
    // was the example until contract 0.18.0 made it answer inline.)
    const accepted = await fetch(`${BASE}/domains/fixture-id`, { method: 'DELETE' })
    expect(accepted.status).toBe(202)

    const location = accepted.headers.get('Location')
    expect(location).toBeTruthy()

    // The example is `/api/v1/jobs/<id>` — already rooted under the API's base path —
    // so it is followed straight off the response's own origin, the way a client that
    // never hard-codes `/api/v1` twice would.
    const job = await fetch(new URL(location as string, accepted.url))
    expect(job.status).toBe(200)
    const jobBody = (await job.json()) as { id: string }
    expect(jobBody.id).toBeTruthy()
    expect(location).toContain(jobBody.id)
  })
})

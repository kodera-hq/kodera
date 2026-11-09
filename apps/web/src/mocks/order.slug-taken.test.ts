// The `order.slug-taken` overlay's suggestions are tenant slugs themselves.
//
// `SlugAvailability.suggestions[]` carries the tenant slug pattern (3–32 characters, a DNS
// label), so a suggestion built on a slug near the bound has to be cut before its suffix is
// added. The overlay-contract gate never judges that answer: the contract gives the `slug`
// query parameter no example, so the gate's request carries no `slug` parameter at all, which
// the overlay reads as an empty slug and refuses with `400 malformed-request` before any 200
// body exists. This is where the 200 body is judged, against exact suggestion lists.

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { handlers } from '@/mocks/overlays/order.slug-taken'

type SlugAvailability = components['schemas']['SlugAvailability']

const ENDPOINT = 'https://core.test/api/v1/slug-availability'

function ask(slug: string): Promise<Response> {
  return fetch(`${ENDPOINT}?slug=${encodeURIComponent(slug)}`)
}

describe('order.slug-taken', () => {
  const server = setupServer(...handlers)
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('answers a taken slug with three suggestions built on it', async () => {
    const response = await ask('acme')
    expect(response.status).toBe(200)
    const body = (await response.json()) as SlugAvailability
    expect(body).toMatchObject({ slug: 'acme', available: false, reason: 'taken' })
    expect(body.suggestions).toEqual(['acme-fr', 'acme-group', 'acme-2027'])
  })

  it('cuts a suggestion built on a 32-character slug to the tenant slug bound', async () => {
    const longest = 'a'.repeat(32)
    const response = await ask(longest)
    expect(response.status).toBe(200)
    const body = (await response.json()) as SlugAvailability
    expect(body.slug).toBe(longest)
    expect(body.suggestions).toEqual([
      `${'a'.repeat(29)}-fr`,
      `${'a'.repeat(26)}-group`,
      `${'a'.repeat(27)}-2027`,
    ])
  })

  it('drops the hyphens a cut leaves at the end of the slug before adding the suffix', async () => {
    // Every cut — 29 characters for `fr`, 26 for `group`, 27 for `2027` — ends inside the
    // run of hyphens, so each suggestion is the 25 leading letters and its suffix, with one
    // hyphen between them rather than the run the cut kept.
    const slug = `${'a'.repeat(25)}----aaa`
    expect(slug).toHaveLength(32)
    const response = await ask(slug)
    expect(response.status).toBe(200)
    const body = (await response.json()) as SlugAvailability
    expect(body.suggestions).toEqual([
      `${'a'.repeat(25)}-fr`,
      `${'a'.repeat(25)}-group`,
      `${'a'.repeat(25)}-2027`,
    ])
  })

  it('refuses a slug the parameter refuses, before any availability answer', async () => {
    const response = await ask('a'.repeat(33))
    expect(response.status).toBe(400)
    expect(response.headers.get('Content-Type')).toBe('application/problem+json')
    const body = (await response.json()) as { type: string }
    expect(body.type).toBe('https://kodera.io/problems/malformed-request')
  })
})

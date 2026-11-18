import { describe, expect, it } from 'vitest'
import { membershipDirectoryResponse } from './membershipDirectory'
import { caller, member } from './overlays/support/people'

const request = (query = '') =>
  new Request(`https://core.test/api/v1/organisations/example/memberships${query}`)

const me = caller('org_member')
const colleague = member('Public name', 'private-probe@example.test', 'org_member')
const rows = [me, colleague]

describe('membership directory mock search', () => {
  it.each(['org_owner', 'org_admin'] as const)(
    'matches email for an authorized %s',
    async (role) => {
      const response = membershipDirectoryResponse(
        rows,
        request('?q=++PRIVATE-PROBE++'),
        role,
        me.id
      )
      expect((await response.json()).data).toEqual([colleague])
    }
  )

  it.each(['staff_operator', 'staff_support'] as const)(
    'does not disclose or search a colleague email for %s',
    async (role) => {
      const response = membershipDirectoryResponse(rows, request('?q=private-probe'), role, me.id)
      expect((await response.json()).data).toEqual([])
      const page = await membershipDirectoryResponse(rows, request(), role, me.id).json()
      expect(page.data[1]).not.toHaveProperty('email')
    }
  )

  it.each([
    '?limit=',
    '?limit=0',
    '?limit=201',
    '?limit=01',
    '?limit=1.0',
    '?limit=1e2',
    '?limit=%2B1',
    '?limit=+1',
    '?limit=1%0A',
    '?limit=1&limit=1',
    '?role=',
    '?role=owner',
    '?role=org_member&role=org_member',
    '?state=',
    '?state=unknown',
    '?state=active&state=active',
    '?cursor=',
    '?cursor=unknown',
    '?cursor=a&cursor=a',
    '?unknown=value',
    '?q=a&q=b',
    `?q=${'x'.repeat(201)}`,
    '?q=%00',
    `?q=${'%20'.repeat(1400)}`,
  ])('returns the Core 400 problem for invalid input %s', async (query) => {
    const response = membershipDirectoryResponse(rows, request(query), 'org_owner', me.id)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      type: 'https://kodera.io/problems/validation-error',
      status: 400,
    })
  })

  it('accepts empty search and valid role/state filters with canonical limits', async () => {
    const page = await membershipDirectoryResponse(
      rows,
      request('?q=++&role=org_member&state=active&limit=200'),
      'org_owner',
      me.id
    ).json()
    expect(page.data).toEqual(rows)
  })

  it('evicts the oldest cursor above 256 while preserving recent continuations', async () => {
    const issue = async () =>
      (await membershipDirectoryResponse(rows, request('?limit=1'), 'org_owner', me.id).json())
        .next_cursor as string
    const oldest = await issue()
    let newest = oldest
    for (let i = 0; i < 256; i += 1) newest = await issue()
    const resume = (cursor: string) =>
      membershipDirectoryResponse(rows, request(`?limit=1&cursor=${cursor}`), 'org_owner', me.id)
    expect(resume(oldest).status).toBe(400)
    expect((await resume(newest).json()).data).toEqual([colleague])
  })

  it('never matches a withheld email, but matches public names and the caller’s own email', async () => {
    const search = async (q: string) =>
      (
        await membershipDirectoryResponse(
          rows,
          request(`?q=${encodeURIComponent(q)}`),
          'org_member',
          me.id
        ).json()
      ).data
    expect(await search('private-probe')).toEqual([])
    expect(await search('PUBLIC NAME')).toEqual([
      expect.not.objectContaining({ email: expect.anything() }),
    ])
    expect(await search(me.email!)).toEqual([me])
    expect(await search('')).toHaveLength(2)
  })

  it('binds normalized search to pagination and rejects a changed or malformed query', async () => {
    const first = membershipDirectoryResponse(
      rows,
      request('?limit=1&q=++ACME++'),
      'org_owner',
      me.id
    )
    const body = await first.json()
    // Both rows match a common domain only after giving the colleague the same domain.
    const matching = [me, { ...colleague, email: 'private@acme.fr' }]
    const page = await membershipDirectoryResponse(
      matching,
      request('?limit=1&q=++ACME++'),
      'org_owner',
      me.id
    ).json()
    expect(page.has_more).toBe(true)
    const cursor = page.next_cursor
    const next = membershipDirectoryResponse(
      matching,
      request(`?limit=1&q=acme&cursor=${cursor}`),
      'org_owner',
      me.id
    )
    expect((await next.json()).data).toEqual([matching[1]])
    expect(
      membershipDirectoryResponse(
        matching,
        request(`?limit=1&q=other&cursor=${cursor}`),
        'org_owner',
        me.id
      ).status
    ).toBe(400)
    expect(body.data).toEqual([me])
    for (const query of ['?q=a&q=b', `?q=${'x'.repeat(201)}`, '?q=%00']) {
      expect(membershipDirectoryResponse(rows, request(query), 'org_owner', me.id).status).toBe(400)
    }
  })
})

// The order identity must be the one the mock provider signs in, or the order wizard refuses.
//
// `resolveOrderOwner` compares the `/me` identity with the live session and returns
// `undefined` on any mismatch, so an identity naming another realm or subject signs in,
// renders the shell, and then shows "Nous n'avons pas pu vérifier vos droits" on every order
// screen — which no unit test saw when the contract renamed the example organisation.

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { authHandlers } from '@/mocks/auth'
import { EXAMPLES } from '@/mocks/generated/examples'
import { ownedOrderMe } from '@/mocks/orderIdentity'

import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (payload === undefined) throw new Error('not a JWT')
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
}

describe('ownedOrderMe', () => {
  const server = setupServer(...authHandlers())
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('is the identity the mock provider mints for the realm the specs sign in to', async () => {
    const me = ownedOrderMe()
    // The specs sign in at `/<slug>/…`, and the route signs in to the realm of that name.
    const realm = EXAMPLES.getMe.body.organisations[0]!.organisation.slug
    expect(me.organisations[0]!.organisation.slug).toBe(realm)

    const response = await fetch(
      `https://id.example.test/realms/${realm}/protocol/openid-connect/token`,
      { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) }
    )
    const { id_token } = (await response.json()) as { id_token: string }
    const claims = decodeJwtPayload(id_token)

    const identity = me.identities[0]!
    expect(identity.issuer, 'the order identity names another issuer').toBe(claims['iss'])
    expect(identity.subject, 'the order identity names another subject').toBe(claims['sub'])
    expect(me.organisations[0]!.identity_id).toBe(identity.id)
  })
})

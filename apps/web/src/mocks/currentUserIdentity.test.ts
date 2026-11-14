import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { authHandlers } from './auth'
import { handlers } from './generated/handlers'

import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'

function decodeClaims(token: string): { iss: string; sub: string } {
  const payload = token.split('.')[1]
  if (payload === undefined) throw new Error('Mock provider returned a malformed token.')
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
    iss: string
    sub: string
  }
}

describe('mock current-user identity contract', () => {
  const server = setupServer(...authHandlers(), ...handlers)
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('binds the default Core fixture to the exact identity-provider claims', async () => {
    const tokenResponse = await fetch(
      'https://id.example.test/realms/acme-sa/protocol/openid-connect/token',
      { method: 'POST' }
    )
    const { access_token: accessToken } = (await tokenResponse.json()) as {
      access_token: string
    }
    const claims = decodeClaims(accessToken)
    const response = await fetch('https://core.example.test/api/v1/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const me = (await response.json()) as components['schemas']['Me']
    const identity = me.identities.find(
      (candidate) => candidate.issuer === claims.iss && candidate.subject === claims.sub
    )
    const membership = me.organisations.find(
      (candidate) => candidate.organisation.slug === 'acme-sa'
    )

    expect(identity).toBeDefined()
    expect(membership?.identity_id).toBe(identity?.id)
    expect(membership?.state).toBe('active')
  })
})

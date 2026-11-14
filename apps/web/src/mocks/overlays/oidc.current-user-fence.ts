// Deterministic browser acceptance for docs/specs/current-token-authority.md.
// The first credential and `/me` answer establish the shell. The second
// identity answer is deliberately late and says MFA is absent. A third token
// and current answer must retire that late authority before it can redirect.

import { http, HttpResponse } from 'msw/http'
import { delay } from 'msw/utils/delay'
import type { components } from '@/api/schema'
import { keycloakUrl, oidcClientId } from '@/config'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES } from '../generated/examples'

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function mockJwt(claims: Record<string, unknown>): string {
  return [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(JSON.stringify(claims)),
    base64url('current-token-authority-acceptance'),
  ].join('.')
}

let credentialSequence = 0
let identitySequence = 0
let releaseHeldIdentity!: () => void
const latestIdentityStarted = new Promise<void>((resolve) => {
  releaseHeldIdentity = resolve
})

export const handlers = [
  http.post('*/auth/realms/:realm/protocol/openid-connect/token', ({ params }) => {
    credentialSequence += 1
    const realm = String(params['realm'])
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: `${keycloakUrl()}/realms/${realm}`,
      sub: `mock-user-${realm}`,
      aud: oidcClientId(),
      iat: now,
      exp: now + 300,
      credential_sequence: credentialSequence,
    }
    return HttpResponse.json({
      access_token: mockJwt(claims),
      id_token: mockJwt(claims),
      token_type: 'Bearer',
      expires_in: 300,
      scope: 'openid profile email',
    })
  }),
  http.get('*/api/v1/me', async ({ request }) => {
    identitySequence += 1
    const sequence = identitySequence
    if (sequence === 2) {
      await latestIdentityStarted
      await delay(250)
    }
    if (sequence === 3) releaseHeldIdentity()
    const example = EXAMPLES.getMe
    const body = bindCurrentUserToMockRequest(example.body as components['schemas']['Me'], request)
    const membership = body.organisations[0]!
    const identity = body.identities[0]!
    identity.mfa_enrolled = sequence !== 2
    body.identities = [identity]
    body.organisations = [membership]
    return HttpResponse.json(body, { status: example.status, headers: { ...example.headers } })
  }),
]

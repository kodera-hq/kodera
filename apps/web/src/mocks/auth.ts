// The mock identity provider's MSW handlers (ADR-0007). Appended to the
// generated Core API handlers only in the mock build (`src/mocks/browser.ts`,
// gated on `authMode() === 'mock'`): the discovery document and the token
// endpoint, both served under the configured Keycloak base URL exactly as the
// real realm would, so oidc-client-ts runs its real state-check-and-code-
// exchange path end to end. Only the authorize page itself is faked, at
// `src/auth/mock-idp.tsx` — an app-local route these handlers point to
// instead of Keycloak's own hosted login page.

import { http, HttpResponse } from 'msw'
import { isDemoActive } from '../app/interactiveDemo'
import { keycloakUrl, oidcClientId } from '../config'

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A JWT shaped like a real one — three base64url segments, a decodable
 * payload with `iss`, `sub` and `exp` — and never verified anywhere in this
 * build: nothing here holds a signing key, and oidc-client-ts's own signin
 * validation (checked against its source: `ResponseValidator
 * ._validateIdTokenAttributes`) only decodes the payload and checks `sub`: it
 * never fetches `jwks_uri` on this path. The third segment is a placeholder
 * shaped like a signature, not a real one.
 */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  const signature = base64url('mock-signature-never-verified')
  return `${header}.${payload}.${signature}`
}

const EXPIRES_IN_S = 300

export function authHandlers() {
  const base = keycloakUrl()
  const clientId = oidcClientId()

  return [
    http.get(`${base}/realms/:realm/.well-known/openid-configuration`, ({ params }) => {
      const realm = params['realm']
      const issuer = `${base}/realms/${String(realm)}`
      return HttpResponse.json({
        issuer,
        // The app-local mock authorize page (ADR-0007), not Keycloak's own —
        // the realm travels as a query param so the page knows what it is
        // standing in for; oidc-client-ts appends its own params alongside it.
        authorization_endpoint: `${window.location.origin}/__mock-idp/authorize?realm=${String(realm)}`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }),

    http.post(`${base}/realms/:realm/protocol/openid-connect/token`, ({ params }) => {
      const realm = params['realm']
      const issuer = `${base}/realms/${String(realm)}`
      const expiresIn = isDemoActive(String(realm)) ? 3600 : EXPIRES_IN_S
      const now = Math.floor(Date.now() / 1000)
      const claims = {
        iss: issuer,
        sub: `mock-user-${String(realm)}`,
        aud: clientId,
        iat: now,
        exp: now + expiresIn,
      }
      return HttpResponse.json({
        access_token: fakeJwt(claims),
        // Lets the installed SDK renew demo sessions without opening an interactive iframe,
        // while keeping standard mock realms on explicit silent-SSO and expiry timers.
        ...(isDemoActive(String(realm)) ? { refresh_token: `mock-refresh-${String(realm)}` } : {}),
        id_token: fakeJwt(claims),
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: 'openid profile email',
      })
    }),
  ]
}

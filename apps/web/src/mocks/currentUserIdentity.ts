import type { components } from '../api/schema'

type Me = components['schemas']['Me']

export interface MockIdentityClaims {
  readonly issuer: string
  readonly subject: string
}

function realmFromIssuer(issuer: string): string | undefined {
  try {
    const segments = new URL(issuer).pathname.split('/').filter(Boolean)
    return segments.at(-1)
  } catch {
    return undefined
  }
}

function bearerClaims(request: Request): MockIdentityClaims | undefined {
  const authorization = request.headers.get('Authorization')
  if (authorization === null || !authorization.startsWith('Bearer ')) return undefined
  const payload = authorization.slice('Bearer '.length).split('.')[1]
  if (payload === undefined) return undefined
  try {
    const decoded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(decoded.padEnd(Math.ceil(decoded.length / 4) * 4, '='))) as {
      iss?: unknown
      sub?: unknown
    }
    if (typeof claims.iss !== 'string' || typeof claims.sub !== 'string') return undefined
    return { issuer: claims.iss, subject: claims.sub }
  } catch {
    return undefined
  }
}

/** Bind a contract-derived `/me` fixture to the identity the mock provider minted. */
export function bindCurrentUserToMockIdentity(me: Me, claims: MockIdentityClaims): Me {
  const current = structuredClone(me)
  const realm = realmFromIssuer(claims.issuer)
  const membership =
    current.organisations.find(
      (entry) => entry.organisation.realm === realm || entry.organisation.slug === realm
    ) ?? current.organisations[0]
  const identity =
    current.identities.find((entry) => entry.id === membership?.identity_id) ??
    current.identities[0]
  if (identity === undefined) return current
  identity.issuer = claims.issuer
  identity.subject = claims.subject
  if (realm !== undefined) identity.realm = realm
  if (membership !== undefined) membership.identity_id = identity.id
  return current
}

/** Preserve the contract fixture when a unit request carries no mock bearer. */
export function bindCurrentUserToMockRequest(me: Me, request: Request): Me {
  const claims = bearerClaims(request)
  return claims === undefined ? structuredClone(me) : bindCurrentUserToMockIdentity(me, claims)
}

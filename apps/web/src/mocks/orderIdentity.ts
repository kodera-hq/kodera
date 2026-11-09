// Explicit synthetic order identity: fixtures must match the local provider's
// processed issuer/subject instead of bypassing the production owner resolver.
//
// The e2e and visual specs sign in at `/<organisation slug>/…`, and the route signs in to the
// realm of that name (`src/app/org-route.tsx`); the mock provider then mints
// `iss: <keycloak>/realms/<realm>` and `sub: mock-user-<realm>` (`src/mocks/auth.ts`). Both are
// derived here from the contract example's organisation slug, so a contract that renames it
// cannot leave this identity naming the previous realm — `orderIdentity.test.ts` holds the
// result to the token the provider actually issues.
import type { components } from '../api/schema'
import { keycloakUrl } from '../config'
import { bindCurrentUserToMockIdentity } from './currentUserIdentity'
import { EXAMPLES } from './generated/examples'

export function ownedOrderMe(): components['schemas']['Me'] {
  const base = EXAMPLES.getMe.body as components['schemas']['Me']
  const realm = base.organisations[0]!.organisation.slug
  const me = bindCurrentUserToMockIdentity(base, {
    issuer: `${keycloakUrl()}/realms/${realm}`,
    subject: `mock-user-${realm}`,
  })
  const identity = me.identities[0]!
  const membership = me.organisations[0]!
  identity.mfa_enrolled = true
  me.identities = [identity]
  membership.identity_id = identity.id
  membership.role = 'org_owner'
  membership.state = 'active'
  me.organisations = [membership]
  return me
}

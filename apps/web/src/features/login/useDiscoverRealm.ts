// `POST /auth/discover` (docs/specs/00-shell-and-login.md §6): unauthenticated,
// rate-limited, and answers the same shape for an unknown slug and an unknown
// domain, so the console never reveals which one failed. A write in the sense
// `src/api/mutations.ts` means it — no `GET` reads this — so it goes through
// `mutate()` rather than a bespoke `fetch`, even though nothing it does is
// persisted: the idempotency key and the typed request/response shape are
// exactly what a POST needs here too.

import { useMutation } from '@tanstack/react-query'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'

export type RealmDiscoveryRequest = components['schemas']['RealmDiscoveryRequest']
export type RealmDiscoveryResult = components['schemas']['RealmDiscoveryResult']

async function discoverRealm(body: RealmDiscoveryRequest): Promise<RealmDiscoveryResult> {
  return mutate({ method: 'post', path: '/auth/discover' }, { body })
}

export function useDiscoverRealm() {
  return useMutation({ mutationFn: discoverRealm })
}

import type { Query, QueryClient } from '@tanstack/react-query'
import { ApiProblem, coreApi } from '../api/client'
import type { components } from '../api/schema'
import type { AuthAdapter } from '../auth/AuthAdapter'
import { authAdapter } from '../auth/oidc'
import { queryClient } from './queryClient'

type Me = components['schemas']['Me']

export interface CurrentUserAuthority {
  readonly me: Me
  readonly generation: number
  readonly credentialGeneration: number
}

function ended(): DOMException {
  return new DOMException('Credential authority ended.', 'AbortError')
}

/** One exact-token authority read, shared only inside the captured boundary. */
export function createCurrentUserLoader(
  adapter: Pick<AuthAdapter, 'restoreSession' | 'getSnapshot' | 'getAccessToken' | 'subscribe'>,
  client: QueryClient
) {
  let pending:
    | {
        generation: number
        credentialGeneration: number
        request: Promise<CurrentUserAuthority>
      }
    | undefined
  return async (): Promise<CurrentUserAuthority> => {
    if (!(await adapter.restoreSession())) throw new Error('No authenticated session.')
    const snapshot = adapter.getSnapshot()
    const generation = snapshot.generation
    const credentialGeneration = snapshot.credentialGeneration
    const accessToken = adapter.getAccessToken()
    if (snapshot.status !== 'ready' || accessToken === undefined) throw ended()
    const current = () => {
      const live = adapter.getSnapshot()
      return (
        live.status === 'ready' &&
        live.generation === generation &&
        live.credentialGeneration === credentialGeneration &&
        adapter.getAccessToken() === accessToken
      )
    }
    if (
      pending?.generation === generation &&
      pending.credentialGeneration === credentialGeneration
    ) {
      const authority = await pending.request
      if (!current()) throw ended()
      return authority
    }
    // A new credential owns a new `/me` family member. Retire every prior
    // generation synchronously while leaving unrelated query and form state.
    const priorAuthority = (query: Query) =>
      query.queryKey[0] === 'me' &&
      (query.queryKey.length !== 3 ||
        query.queryKey[1] !== generation ||
        query.queryKey[2] !== credentialGeneration)
    void client.cancelQueries({ predicate: priorAuthority })
    client.removeQueries({ predicate: priorAuthority })
    const authorityController = new AbortController()
    let retired = false
    const retire = () => {
      if (retired || current()) return
      retired = true
      authorityController.abort(ended())
      void client.cancelQueries({ queryKey: ['me'] })
      client.removeQueries({ queryKey: ['me'] })
    }
    const unsubscribe = adapter.subscribe(() => {
      retire()
    })
    retire()
    if (retired) {
      unsubscribe()
      throw ended()
    }
    const request = client
      .fetchQuery({
        queryKey: ['me', generation, credentialGeneration],
        staleTime: Infinity,
        retry: (failureCount, error) => {
          if (error instanceof ApiProblem && (error.status === 401 || error.status === 403))
            return false
          // Preserve the client's transient retry policy; authority refusals above
          // are final for this request, not a reason to repeat the same credential.
          const retry = client.getDefaultOptions().queries?.retry ?? 2
          return typeof retry === 'function'
            ? retry(failureCount, error)
            : retry === true || (retry !== false && failureCount < retry)
        },
        queryFn: async ({ signal }) => {
          const cancel = () => authorityController.abort(ended())
          if (signal.aborted) cancel()
          else signal.addEventListener('abort', cancel, { once: true })
          try {
            if (!current() || authorityController.signal.aborted) throw ended()
            const { data } = await coreApi().GET('/me', { signal: authorityController.signal })
            if (!current() || authorityController.signal.aborted) throw ended()
            if (data === undefined) throw new Error('GET /me returned no identity.')
            return { me: data, generation, credentialGeneration }
          } finally {
            signal.removeEventListener('abort', cancel)
          }
        },
      })
      .finally(unsubscribe)
    pending = { generation, credentialGeneration, request }
    try {
      const authority = await request
      if (!current()) throw ended()
      return authority
    } finally {
      // Deduplicate only in-flight reads. Settled data belongs to the query
      // cache, whose invalidation must expose new workspace memberships.
      if (pending?.request === request) pending = undefined
    }
  }
}

export const loadCurrentUser = createCurrentUserLoader(authAdapter, queryClient)

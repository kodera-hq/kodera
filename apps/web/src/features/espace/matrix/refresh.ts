// Refreshing Synapse access tokens for matrix-js-sdk (messaging-pilot design §2.4). The tokens
// expire within minutes and live in memory only. matrix-js-sdk 43 can refresh only through
// OAuth: handed a refresh token without one, it logs the session out at the first expiry. So
// the SDK never sees the refresh token. Its requests go through this `fetch`, which on
// `401 M_UNKNOWN_TOKEN` buys a new access token once, however many requests failed together,
// and retries each with it. Only a refusal of the refresh token itself ends the session: the
// SDK then sees the original 401 and signs out. A refresh that could not reach the homeserver
// fails the request as a network error would, and the SDK retries it later.

import { RefreshRefused } from '@/auth/matrix'

export { RefreshRefused }

/**
 * The access token is not replaced: the session has no refresh token, or the store asking was
 * stopped. A refusal of it is not an expiry, so it does not end the session either.
 */
export class NotRenewable extends Error {
  constructor() {
    super('This Matrix session has no refresh token.')
    this.name = 'NotRenewable'
  }
}

export interface TokenSource {
  /** The access token in use now. */
  current: () => string
  /**
   * Buys and installs a new access token, and returns it. Rejects with `RefreshRefused` when the
   * homeserver refuses, with anything else when it could not be asked.
   */
  refresh: () => Promise<string>
}

function bearer(headers: Headers): string | null {
  const value = headers.get('Authorization')
  return value?.startsWith('Bearer ') === true ? value.slice('Bearer '.length) : null
}

async function expiredToken(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  try {
    const body = (await response.clone().json()) as { errcode?: unknown }
    return body.errcode === 'M_UNKNOWN_TOKEN'
  } catch {
    return false
  }
}

export function refreshingFetch(base: typeof fetch, tokens: TokenSource): typeof fetch {
  let inFlight: Promise<string> | null = null
  const renew = () => {
    inFlight ??= tokens.refresh().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return async (input, init) => {
    // The headers fetch will send: init's replace a Request's own, they are not merged.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    const sent = bearer(headers)
    // A Request's body is read once: keep a copy for the retry.
    const again = input instanceof Request ? input.clone() : input
    const response = await base(input, init)
    // Only a request that carried a token, refused because the token is no longer known.
    if (sent === null || !(await expiredToken(response))) return response
    let next: string
    try {
      // Another request may already have bought the next token: use it rather than buy another.
      next = sent === tokens.current() ? await renew() : tokens.current()
    } catch (error) {
      if (error instanceof RefreshRefused) return response
      throw error
    }
    headers.set('Authorization', `Bearer ${next}`)
    return base(again, { ...init, headers })
  }
}

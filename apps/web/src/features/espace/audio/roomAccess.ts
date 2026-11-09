// The room-access call (messaging-pilot design §2.7): before joining an audio room, the Console
// trades the member's own Matrix access token for a LiveKit token for that one room. The service
// runs on the tenant's VM (kodera-core `room_access/`) and the tenant edge routes it on the
// homeserver's own origin, so it is reached the way the homeserver is, and named in the CSP's
// `connect-src` the same way (console ADR-0012).
//
// The service checks that the member is a joined member of the room, and answers with the
// LiveKit URL, a token for that room only, and whether the member may only listen. It is asked
// again for every join; the token is never kept, nor logged.

import { homeserverOrigin, RefreshRefused } from '@/auth/matrix'
import { matrixDomain } from '@/config'
import { isUnderMatrixDomain, isWithinServerName } from '../homeserver'
import { NotRenewable } from '../matrix/refresh'

const PATH = '/_kodera/rooms/token'

export type RoomAccessProblem =
  /** The Matrix token was refused, and a fresh one too, or the session could not be refreshed. */
  | 'unauthenticated'
  /** Not a joined member of the room, the room archived, or not an audio room. */
  | 'forbidden'
  /**
   * The service, or the LiveKit server behind it, cannot hand out tokens now; or it refused a
   * token that is never replaced (a session without a refresh token), which is not an expiry.
   */
  | 'unavailable'
  /** The request or the answer was not of the agreed shape. */
  | 'malformed'
  /** No answer at all: the network, or a refresh that could not reach the homeserver. */
  | 'network'

export class RoomAccessFailed extends Error {
  constructor(readonly problem: RoomAccessProblem) {
    super(`The room-access service refused the audio room: ${problem}.`)
    this.name = 'RoomAccessFailed'
  }
}

/** What a join needs from the service. */
export interface RoomGrant {
  /**
   * The LiveKit server: `wss:` on the session's server name or under it, under the matrix domain,
   * on the default port and with no path, as the CSP names it (or `ws:` to this machine, in
   * development).
   */
  url: string
  /** The LiveKit token for this room only. A secret: never logged, never stored. */
  token: string
  /** The token cannot publish: the member may listen and not speak. */
  listenOnly: boolean
}

/**
 * Whether a plain `ws:` LiveKit URL is allowed: only to this machine, in development. The rule is
 * the one `homeserverOrigin` (src/auth/matrix.ts) applies to a plain-HTTP homeserver, applied to
 * the same host.
 */
function devLoopback(url: URL): boolean {
  try {
    homeserverOrigin(`http://${url.host}/`)
    return true
  } catch {
    return false
  }
}

function liveKitUrl(value: unknown, serverName: string): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    // livekit-client opens `/rtc…` under the URL's path; the CSP names those paths at the root.
    url.pathname !== '/'
  ) {
    return null
  }
  if (url.protocol === 'ws:' && devLoopback(url)) return value
  // A second check behind the CSP, narrower than it: a grant naming a server that is not the
  // organisation's own (another tenant's, under the same matrix domain) is refused before
  // connecting.
  const domain = matrixDomain()
  if (
    url.protocol === 'wss:' &&
    url.port === '' &&
    domain !== undefined &&
    isUnderMatrixDomain(url.hostname, domain) &&
    isWithinServerName(url.hostname, serverName)
  ) {
    return value
  }
  return null
}

function grantOf(body: unknown, serverName: string): RoomGrant | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const { url, token, listen_only: listenOnly } = body as Record<string, unknown>
  const server = liveKitUrl(url, serverName)
  if (server === null || typeof token !== 'string' || token === '') return null
  if (typeof listenOnly !== 'boolean') return null
  return { url: server, token, listenOnly }
}

const PROBLEMS: Partial<Record<number, RoomAccessProblem>> = {
  400: 'malformed',
  401: 'unauthenticated',
  403: 'forbidden',
}

/**
 * Asks the room-access service for a LiveKit token for one audio room, once.
 *
 * @param homeserverBaseUrl the workspace's homeserver, as the Matrix session names it
 * @param accessToken the member's Matrix access token
 * @param roomId the audio room's Matrix room id, `!…`
 * @param serverName the session's Matrix server name, which the LiveKit server must be on or under
 * @throws RoomAccessFailed with the problem; any other error for a homeserver URL that is not
 *   an https origin, before anything is sent
 */
export async function requestRoomToken(
  homeserverBaseUrl: string,
  accessToken: string,
  roomId: string,
  serverName: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<RoomGrant> {
  const url = new URL(PATH, homeserverOrigin(homeserverBaseUrl))
  let response: Response
  try {
    response = await fetchImpl(url.href, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      // A string: fetch sends it with a Content-Length, which the service requires.
      body: JSON.stringify({ room_id: roomId }),
      credentials: 'omit',
      cache: 'no-store',
      // The token must not follow a redirect anywhere.
      redirect: 'error',
    })
  } catch {
    throw new RoomAccessFailed('network')
  }
  if (!response.ok) {
    // 503, and anything else that is not the service's own answer (a gateway's error page).
    throw new RoomAccessFailed(PROBLEMS[response.status] ?? 'unavailable')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RoomAccessFailed('malformed')
  }
  const grant = grantOf(body, serverName)
  if (grant === null) throw new RoomAccessFailed('malformed')
  return grant
}

/** The member's Matrix access token, and how to replace it once refused. */
export interface MatrixTokens {
  /** The access token in use now. */
  current: () => string
  /**
   * The token to use after `stale` was refused. Rejects with `RefreshRefused` when the session
   * is over, `NotRenewable` when the session has no refresh token or the store is stopped, and
   * anything else when the homeserver could not be asked.
   */
  renew: (stale: string) => Promise<string>
}

/**
 * `requestRoomToken` with the token in use, and once more after a 401 with a refreshed one: the
 * Matrix token expires within minutes, and the service answers 401 to an expired one.
 */
export async function fetchRoomGrant(
  homeserverBaseUrl: string,
  tokens: MatrixTokens,
  roomId: string,
  serverName: string,
  fetchImpl?: typeof fetch
): Promise<RoomGrant> {
  const sent = tokens.current()
  try {
    return await requestRoomToken(homeserverBaseUrl, sent, roomId, serverName, fetchImpl)
  } catch (error) {
    if (!(error instanceof RoomAccessFailed) || error.problem !== 'unauthenticated') throw error
  }
  let next: string
  try {
    next = await tokens.renew(sent)
  } catch (error) {
    throw new RoomAccessFailed(
      error instanceof RefreshRefused
        ? 'unauthenticated'
        : error instanceof NotRenewable
          ? 'unavailable'
          : 'network'
    )
  }
  return requestRoomToken(homeserverBaseUrl, next, roomId, serverName, fetchImpl)
}

// The split-origin ledger (contract B5): every request a real-identity community page makes must
// go to the one origin that serves it. The static SPA origin serves files and Matrix client
// discovery only; the Core API, the identity provider, the homeserver (with the room-access call
// on its origin) and the LiveKit signalling server each answer on their own origin, under their
// own paths. A request that leaves that map is a violation, named so a failing run says which.
//
// Pure: the harness (`stack.ts`) feeds it what the browser and the servers observed, and the
// unit refusal self-test (`tests/unit/split-origin-ledger.test.ts`) feeds it known leaks.

export interface SplitOrigins {
  /** `https://community.{domain}`: the static SPA. */
  spa: string
  /** `https://api.{domain}`: the Core API. */
  api: string
  /** `https://auth.{domain}`: the identity provider. */
  auth: string
  /** `https://matrix.community.{domain}`: Synapse and the room-access call. */
  matrix: string
  /** `wss://livekit.community.{domain}`: LiveKit signalling. */
  livekit: string
}

export interface ObservedRequest {
  url: string
}

/** Backend paths the static origin must never be asked for (it answers them 503). */
const BACKEND_PATH = /^\/(?:api|_matrix|_kodera|_synapse|realms|agent|health)(?:\/|$)/

/** The paths each backend origin is reached on; anything else there is a misrouted call. */
function admittedPath(role: Exclude<keyof SplitOrigins, 'spa'>, path: string): boolean {
  switch (role) {
    case 'api':
      return path.startsWith('/api/v1/')
    case 'auth':
      return path.startsWith('/realms/')
    case 'matrix':
      return (
        path.startsWith('/_matrix/client/') ||
        path.startsWith('/_matrix/media/') ||
        path.startsWith('/_synapse/client/') ||
        path === '/_kodera/rooms/token'
      )
    case 'livekit':
      return path === '/rtc' || path.startsWith('/rtc/')
  }
}

function roleOf(url: URL, origins: SplitOrigins): keyof SplitOrigins | undefined {
  for (const role of ['spa', 'api', 'auth', 'matrix'] as const) {
    if (url.origin === new URL(origins[role]).origin) return role
  }
  // LiveKit signals over `wss:`; its client checks the same host over `https:` on failure.
  const livekit = new URL(origins.livekit)
  if (url.host === livekit.host && (url.protocol === 'wss:' || url.protocol === 'https:'))
    return 'livekit'
  return undefined
}

/**
 * Every request that breaks the split-origin map, described; empty when the run kept to it.
 *
 * - `same-origin backend call`: a relative `/api`, `/_matrix`, `/_kodera`… call that reached the
 *   static origin instead of its backend.
 * - `disallowed origin`: a host outside the five origins.
 * - `misrouted path`: a known backend origin asked for a path it does not serve (federation,
 *   key, agent or an API path on the homeserver, for example).
 */
export function splitOriginViolations(
  observed: readonly ObservedRequest[],
  origins: SplitOrigins
): string[] {
  const violations: string[] = []
  for (const request of observed) {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      violations.push(`unreadable URL: ${request.url}`)
      continue
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') continue
    const role = roleOf(url, origins)
    if (role === undefined) {
      violations.push(`disallowed origin: ${url.origin}${url.pathname}`)
    } else if (role === 'spa') {
      if (BACKEND_PATH.test(url.pathname)) {
        violations.push(`same-origin backend call: ${url.pathname}`)
      }
    } else if (!admittedPath(role, url.pathname)) {
      violations.push(`misrouted path on ${role}: ${url.pathname}`)
    }
  }
  return violations
}

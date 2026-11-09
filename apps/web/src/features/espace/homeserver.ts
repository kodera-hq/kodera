// Where an organisation's homeserver is (console ADR-0012). The one place that derives it: a later
// per-organisation homeserver from Core (a customer's own domain) replaces this function and
// leaves its callers alone.
//
// - The Matrix server name is `{tenant slug}.{matrix domain}`: the organisation's tenant, whose
//   slug may differ from the organisation's (quick-workspace W2). The matrix domain is a
//   setting per environment (`VITE_MATRIX_DOMAIN`): `kodera.io` in production, `staging.kodera.io`
//   on staging.
// - The homeserver is found by Matrix client discovery: `GET https://{server name}/.well-known/
//   matrix/client`, whose `m.homeserver.base_url` the tenant serves with CORS `*`. A 404 means
//   the server name is the homeserver (the spec's IGNORE); a document that answers without a
//   usable `m.homeserver` is the spec's FAIL_PROMPT, refused as `malformed`.
// - The base URL is accepted only on the tenant's own server name or a host under it, and
//   only where the Console's CSP lets the page reach it: an `https` origin, on the default port
//   (`server/static.mjs` names `https://*.{matrix domain}/_matrix/` and nothing wider).
// - A Matrix session belongs to the tenant whose server name its user ID carries
//   (`sessionBelongsTo`): the Console keeps one session, and an organisation's workspace shows it
//   only when it is that organisation's tenant's.
//
// The development stack's homeserver is a plain-HTTP origin on this machine, with no discovery to
// ask: `devHomeserver` names it, in a development build only. Its server name is the stack's own
// (`devServerName`, `kodera.test` by default), the same for every organisation: one local stack
// serves them all.

import { homeserverOrigin } from '../../auth/matrix'
import { isDomainName } from '../../api/domainName'
import { isTenantSlug } from '../../api/tenantSlug'

const WELL_KNOWN = '/.well-known/matrix/client'
/** Discovery never holds the screen longer than this. */
const DISCOVERY_WAIT_MS = 5_000

/**
 * Whether `value` is a matrix domain: a lowercase DNS name of two labels at least, with no scheme,
 * port, wildcard or trailing dot, whose last label is not a number. `server/static.mjs` applies the
 * same rule to `--matrix-domain`.
 */
export function isMatrixDomain(value: string): boolean {
  return isDomainName(value)
}

/** Whether `hostname` is a host under the matrix domain, which the CSP's wildcard names. */
export function isUnderMatrixDomain(hostname: string, matrixDomain: string): boolean {
  return (
    isMatrixDomain(matrixDomain) &&
    hostname.endsWith(`.${matrixDomain}`) &&
    hostname.length > matrixDomain.length + 1
  )
}

export type HomeserverProblem =
  /** The slug, the matrix domain or the development override is not usable. */
  | 'misconfigured'
  /** No answer: the network, or no answer within the wait. */
  | 'network'
  /** An HTTP error other than 404. */
  | 'unavailable'
  /** An answer that is not discovery's shape, or a base URL the Console may not reach. */
  | 'malformed'

export class HomeserverUnresolved extends Error {
  constructor(readonly problem: HomeserverProblem) {
    super(`The workspace's homeserver could not be found: ${problem}.`)
    this.name = 'HomeserverUnresolved'
  }
}

export interface Homeserver {
  /** The Matrix server name, the part after `:` in a Matrix ID. */
  serverName: string
  /** The client-server API's origin, with no trailing slash. */
  baseUrl: string
}

export interface ServerNameOptions {
  /** `VITE_MATRIX_DOMAIN`. */
  matrixDomain: string
  /** `VITE_ESPACE_DEV_HOMESERVER`: refused outside a development build. */
  devHomeserver?: string | undefined
  /** `VITE_ESPACE_DEV_SERVER_NAME`: the local stack's server name, with `devHomeserver` only. */
  devServerName?: string | undefined
}

export interface ResolveOptions extends ServerNameOptions {
  fetch?: typeof fetch
  /** How long discovery may take; for tests. */
  timeoutMs?: number
}

/** The local stack's server name (`tests/espace/stack/synapse/homeserver.yaml.tmpl`). */
const DEV_SERVER_NAME = 'kodera.test'

/** Whether `hostname` is the server name itself or a host under it. */
export function isWithinServerName(hostname: string, serverName: string): boolean {
  return serverName !== '' && (hostname === serverName || hostname.endsWith(`.${serverName}`))
}

/**
 * The organisation's Matrix server name: `{slug}.{matrix domain}`, or the local stack's with the
 * development override.
 *
 * @throws HomeserverUnresolved `misconfigured`, when the slug, the domain or the override is not
 *   usable
 */
export function serverNameFor(tenantSlug: string, options: ServerNameOptions): string {
  // The tenant's slug, by the tenant's rule (3–32), not the organisation's (5–20): a tenant
  // named `acme` is a valid server name (quick-workspace W2).
  if (!isTenantSlug(tenantSlug) || !isMatrixDomain(options.matrixDomain)) {
    throw new HomeserverUnresolved('misconfigured')
  }
  if (options.devHomeserver === undefined) return `${tenantSlug}.${options.matrixDomain}`
  if (!import.meta.env.DEV) throw new HomeserverUnresolved('misconfigured')
  const devServerName = options.devServerName ?? DEV_SERVER_NAME
  if (!isMatrixDomain(devServerName)) throw new HomeserverUnresolved('misconfigured')
  return devServerName
}

/** The server name a Matrix user ID carries: what follows its first `:`. */
export function serverNameOf(userId: string): string | undefined {
  const separator = userId.indexOf(':')
  return userId.startsWith('@') && separator > 1 ? userId.slice(separator + 1) : undefined
}

/** A channel id as Core writes it: a UUID, in lower-case hex with dashes. */
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A server name as a user ID carries it: a host name or IP literal, and an optional port. */
const SERVER_NAME = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/

/** Whether `value` is a channel id as Core writes it: a lower-case UUID with dashes. */
export function isChannelId(value: string): boolean {
  return CHANNEL_ID.test(value)
}

/**
 * The alias of a channel's Matrix room, `#kodera-ch-{channel id}:{server name}` (Core contract
 * 0.25.2, `docs/specs/ESPACE_STRUCTURE.md`): the one key by which a client finds the room, through
 * the room directory. It never derives from the channel's name, so a rename keeps it.
 *
 * @returns undefined when the channel id is not a lower-case UUID or the server name is not one:
 *   such a channel has no room the Console may look up
 */
export function channelRoomAlias(channelId: string, serverName: string): string | undefined {
  if (!isChannelId(channelId) || !SERVER_NAME.test(serverName)) return undefined
  return `#kodera-ch-${channelId}:${serverName}`
}

/**
 * Whether a Matrix session is the organisation's: its user ID is on the organisation's server
 * name. Anything that cannot be decided is not.
 */
export function sessionBelongsTo(
  session: { userId: string },
  tenantSlug: string,
  options: ServerNameOptions
): boolean {
  let expected: string
  try {
    expected = serverNameFor(tenantSlug, options)
  } catch {
    return false
  }
  return serverNameOf(session.userId) === expected
}

/**
 * A discovered base URL the Console may call: an https origin on the organisation's server name
 * or under it, and under the matrix domain the CSP names.
 */
function acceptedBaseUrl(value: unknown, serverName: string, matrixDomain: string): string {
  if (typeof value !== 'string') throw new HomeserverUnresolved('malformed')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HomeserverUnresolved('malformed')
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    // A trailing slash is the only path the CSP's `/_matrix/` leaves room for.
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !isUnderMatrixDomain(url.hostname, matrixDomain) ||
    !isWithinServerName(url.hostname, serverName)
  ) {
    throw new HomeserverUnresolved('malformed')
  }
  return url.origin
}

/**
 * The tenant's homeserver.
 *
 * @param tenantSlug the organisation's tenant's slug, which may differ from the `$org` of the
 *   Console's routes
 * @throws HomeserverUnresolved with the problem; nothing else
 */
export async function resolveHomeserver(
  tenantSlug: string,
  options: ResolveOptions
): Promise<Homeserver> {
  const { matrixDomain } = options
  const serverName = serverNameFor(tenantSlug, options)

  if (options.devHomeserver !== undefined) {
    // A development build only (`serverNameFor`), and only a loopback origin
    // (`homeserverOrigin`'s rule).
    let origin: string
    try {
      origin = homeserverOrigin(options.devHomeserver)
    } catch {
      throw new HomeserverUnresolved('misconfigured')
    }
    if (!origin.startsWith('http:')) throw new HomeserverUnresolved('misconfigured')
    return { serverName, baseUrl: origin }
  }

  const call = options.fetch ?? globalThis.fetch.bind(globalThis)
  let response: Response
  try {
    response = await call(`https://${serverName}${WELL_KNOWN}`, {
      method: 'GET',
      credentials: 'omit',
      // Discovery's answer is the tenant's to cache; a redirect would leave the CSP's paths.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_WAIT_MS),
    })
  } catch {
    throw new HomeserverUnresolved('network')
  }
  if (response.status === 404) return { serverName, baseUrl: `https://${serverName}` }
  if (!response.ok) throw new HomeserverUnresolved('unavailable')
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new HomeserverUnresolved('malformed')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HomeserverUnresolved('malformed')
  }
  // Only a 404 falls back to the server name. A document without `m.homeserver` is the spec's
  // FAIL_PROMPT: the tenant answered, and what it answered names no homeserver.
  const homeserver = (body as Record<string, unknown>)['m.homeserver']
  if (
    homeserver === undefined ||
    homeserver === null ||
    typeof homeserver !== 'object' ||
    Array.isArray(homeserver)
  ) {
    throw new HomeserverUnresolved('malformed')
  }
  return {
    serverName,
    baseUrl: acceptedBaseUrl(
      (homeserver as Record<string, unknown>)['base_url'],
      serverName,
      matrixDomain
    ),
  }
}

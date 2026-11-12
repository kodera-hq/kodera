// A deterministic split-origin stack on this machine (contract B5): five HTTPS origins, each its
// own local server on its own port, reached by their production-shaped names through a local
// forward proxy, so the page computes exactly the URLs a `package-real.py` build computes:
//
//   https://community.kodera.test        the static SPA (Vite, real-identity settings)
//   https://auth.kodera.test             an OIDC provider stub (PKCE S256 checked)
//   https://api.kodera.test              a Core API stub
//   https://matrix.community.kodera.test a Synapse stub and the room-access call on its origin
//   wss://livekit.community.kodera.test  a LiveKit signalling stub
//   https://elsewhere.kodera.test        a foreign origin, for the CORS refusal proof
//
// Every backend applies strict CORS: only the SPA origin is admitted, never with credentials,
// and a preflight from any other origin is refused. Each server records what it was asked, so a
// test can prove where every call went and that none carried a cookie. Nothing leaves loopback:
// the proxy refuses (and records) any host it does not map.

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import type { SplitOrigins } from './ledger'

export const DOMAIN = 'kodera.test'
export const HOSTS = {
  spa: `community.${DOMAIN}`,
  api: `api.${DOMAIN}`,
  auth: `auth.${DOMAIN}`,
  matrix: `matrix.community.${DOMAIN}`,
  livekit: `livekit.community.${DOMAIN}`,
  foreign: `elsewhere.${DOMAIN}`,
} as const
export const ORIGINS: SplitOrigins = {
  spa: `https://${HOSTS.spa}`,
  api: `https://${HOSTS.api}`,
  auth: `https://${HOSTS.auth}`,
  matrix: `https://${HOSTS.matrix}`,
  livekit: `wss://${HOSTS.livekit}`,
}
export const FOREIGN_ORIGIN = `https://${HOSTS.foreign}`
export const ISSUER = `${ORIGINS.auth}/realms/community`
/** The member's `sub`, and so the localpart of their Matrix ID. */
export const SUBJECT = '0b3d7a52-6c1e-4f8a-9d2b-5e7f1a3c9b04'
export const SERVER_NAME = HOSTS.spa
export const AUDIO_ROOM = `!audio-room:${SERVER_NAME}`
export const LIVEKIT_TOKEN = 'synthetic-livekit-grant'

/** The settings `package-real.py` builds the community bundle with, for this stack's domain. */
export const REAL_BUILD_ENV = {
  VITE_AUTH_MODE: 'oidc',
  VITE_ENABLE_MSW: '0',
  VITE_MOCK_UNSERVED: '0',
  VITE_FIRST_OWNER_JOURNEY: '0',
  VITE_OIDC_CLIENT_ID: 'console',
  VITE_CORE_API_URL: `${ORIGINS.api}/api/v1`,
  VITE_KEYCLOAK_URL: ORIGINS.auth,
  VITE_MATRIX_DOMAIN: DOMAIN,
  VITE_TENANT_DOMAIN: '',
} as const

export interface Hit {
  server: 'spa' | 'api' | 'auth' | 'matrix' | 'livekit' | 'foreign'
  method: string
  path: string
  origin: string | undefined
  cookie: boolean
  authorization: string | undefined
  upgrade: boolean
}

export interface SplitStack {
  /** The forward proxy a browser context sends every request through. */
  proxy: string
  hits: Hit[]
  /** Hosts the proxy refused: anything outside the map above. */
  refusedHosts: string[]
  /** Preflights or requests a backend refused because of their `Origin`. */
  corsRefusals: Hit[]
  /**
   * Whether a socket is the development server's own channel, which `@vite/client` opens on the
   * page's origin (or, failing that, on the server's loopback address). A production static origin
   * has no socket at all; this one exists only because the harness serves sources, so it is set
   * aside by name rather than admitted by the ledger.
   */
  isDevChannel: (url: string) => boolean
  close: () => Promise<void>
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function json(response: ServerResponse, status: number, body: unknown, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port))
  })
}

async function freePort(): Promise<number> {
  const probe = createNetServer()
  const port = await listen(probe as unknown as Server)
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

function closeServer(server: { close: (callback: () => void) => unknown }): Promise<void> {
  return new Promise((done) => {
    ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
    server.close(() => done())
  })
}

export async function startSplitStack(): Promise<SplitStack> {
  const hits: Hit[] = []
  const refusedHosts: string[] = []
  const corsRefusals: Hit[] = []
  const tls = mkdtempSync(resolve(tmpdir(), 'kodera-split-origin-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      resolve(tls, 'key.pem'),
      '-out',
      resolve(tls, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      `/CN=${DOMAIN}`,
      '-addext',
      `subjectAltName=DNS:${DOMAIN},DNS:*.${DOMAIN},DNS:*.community.${DOMAIN}`,
    ],
    { stdio: 'ignore' }
  )
  const key = readFileSync(resolve(tls, 'key.pem'))
  const cert = readFileSync(resolve(tls, 'cert.pem'))
  // Test-only material: nothing outlives the read.
  rmSync(tls, { recursive: true, force: true })

  const record = (server: Hit['server'], request: IncomingMessage, upgrade = false): Hit => {
    const hit: Hit = {
      server,
      method: request.method ?? 'GET',
      path: new URL(request.url ?? '/', 'https://stack.invalid').pathname,
      origin: request.headers.origin,
      cookie: request.headers.cookie !== undefined,
      authorization: request.headers.authorization,
      upgrade,
    }
    hits.push(hit)
    return hit
  }

  /**
   * Strict CORS for the SPA origin alone, never with credentials. Returns true when the request
   * is answered here: a preflight, or one refused for its origin.
   */
  const cors = (hit: Hit, request: IncomingMessage, response: ServerResponse): boolean => {
    const origin = request.headers.origin
    if (origin !== undefined && origin !== ORIGINS.spa) {
      corsRefusals.push(hit)
      if (request.method === 'OPTIONS') {
        response.writeHead(403).end()
        return true
      }
      // Answered without an allow header: the browser keeps the body from the page.
      return false
    }
    if (origin === undefined) return false
    response.setHeader('Access-Control-Allow-Origin', ORIGINS.spa)
    response.setHeader('Vary', 'Origin')
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': request.headers['access-control-request-headers'] ?? '',
        'Access-Control-Max-Age': '0',
      })
      response.end()
      return true
    }
    return false
  }

  // --- Identity provider -----------------------------------------------------------------------
  const codes = new Map<string, { challenge: string; nonce: string | null; redirect: string }>()
  const accessTokens = new Set<string>()
  const issueTokens = (nonce: string | null) => {
    const now = Math.floor(Date.now() / 1000)
    const accessToken = `at-${randomBytes(12).toString('hex')}`
    accessTokens.add(accessToken)
    const claims = {
      iss: ISSUER,
      aud: 'console',
      azp: 'console',
      sub: SUBJECT,
      iat: now,
      auth_time: now,
      exp: now + 600,
      email: 'member@example.org',
      email_verified: true,
      ...(nonce === null ? {} : { nonce }),
    }
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 600,
      refresh_token: `rt-${randomBytes(12).toString('hex')}`,
      scope: 'openid profile email',
      id_token: `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('synthetic')}`,
    }
  }
  const auth = createHttpsServer({ key, cert }, (request, response) => {
    void (async () => {
      const hit = record('auth', request)
      if (cors(hit, request, response)) return
      const url = new URL(request.url ?? '/', ISSUER)
      const base = '/realms/community'
      if (url.pathname === `${base}/.well-known/openid-configuration`) {
        return json(response, 200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
          end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (
        url.pathname === `${base}/protocol/openid-connect/auth` ||
        url.pathname === `${base}/protocol/openid-connect/registrations`
      ) {
        const redirect = url.searchParams.get('redirect_uri') ?? ''
        const challenge = url.searchParams.get('code_challenge') ?? ''
        if (
          url.searchParams.get('client_id') !== 'console' ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
          redirect !== `${ORIGINS.spa}/auth/callback`
        ) {
          return json(response, 400, { error: 'invalid_request' })
        }
        const code = randomBytes(16).toString('hex')
        codes.set(code, { challenge, nonce: url.searchParams.get('nonce'), redirect })
        const back = new URL(redirect)
        back.searchParams.set('code', code)
        back.searchParams.set('state', url.searchParams.get('state') ?? '')
        back.searchParams.set('session_state', 'synthetic-session')
        back.searchParams.set('iss', ISSUER)
        response.writeHead(302, { Location: back.href, 'Cache-Control': 'no-store' })
        return response.end()
      }
      if (url.pathname === `${base}/protocol/openid-connect/token` && request.method === 'POST') {
        const form = new URLSearchParams(await readBody(request))
        if (form.get('grant_type') === 'refresh_token')
          return json(response, 200, issueTokens(null))
        const pending = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (
          pending === undefined ||
          form.get('client_id') !== 'console' ||
          form.get('redirect_uri') !== pending.redirect ||
          b64url(createHash('sha256').update(verifier).digest()) !== pending.challenge
        ) {
          return json(response, 400, { error: 'invalid_grant' })
        }
        return json(response, 200, issueTokens(pending.nonce))
      }
      if (url.pathname === `${base}/protocol/openid-connect/userinfo`) {
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
        if (!accessTokens.has(token)) return json(response, 401, { error: 'invalid_token' })
        return json(response, 200, { sub: SUBJECT, email: 'member@example.org' })
      }
      if (url.pathname === `${base}/protocol/openid-connect/certs`)
        return json(response, 200, { keys: [] })
      return json(response, 404, { error: 'not_found' })
    })()
  })

  // --- Core API --------------------------------------------------------------------------------
  const core = createHttpsServer({ key, cert }, (request, response) => {
    void (async () => {
      const hit = record('api', request)
      if (cors(hit, request, response)) return
      await readBody(request)
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      const problem = (status: number, title: string) =>
        json(response, status, { type: 'about:blank', title, status }, 'application/problem+json')
      if (!accessTokens.has(token)) return problem(401, 'Unauthenticated')
      if (hit.path === '/api/v1/me' && request.method === 'GET') {
        return json(response, 200, {
          id: '7f9a1c2e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
          email: 'member@example.org',
          display_name: 'Synthetic Member',
          locale: 'fr',
          staff: false,
          identities: [
            {
              id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              issuer: ISSUER,
              realm: 'community',
              subject: SUBJECT,
              email: 'member@example.org',
              email_verified: true,
            },
          ],
          organisations: [
            {
              organisation: {
                id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
                slug: 'community',
                name: 'Kodera Community',
                realm: 'community',
              },
              membership_id: '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f',
              role: 'org_member',
              state: 'active',
              identity_id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
            },
          ],
        })
      }
      if (hit.path === '/api/v1/community/support/tickets' && request.method === 'POST') {
        if (!request.headers['idempotency-key']) return problem(400, 'Idempotency-Key required')
        return json(response, 201, {
          id: '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a',
          state: 'open',
          priority: 'P3',
          queue: 'product-engineering',
          confirmation: 'ticket-created',
        })
      }
      return problem(404, 'Not Found')
    })()
  })

  // --- Homeserver and room access ---------------------------------------------------------------
  const loginTokens = new Set<string>()
  let matrixAccess = ''
  let matrixRefresh = ''
  let roomTokenCalls = 0
  const matrix = createHttpsServer({ key, cert }, (request, response) => {
    void (async () => {
      const hit = record('matrix', request)
      if (cors(hit, request, response)) return
      const url = new URL(request.url ?? '/', ORIGINS.matrix)
      const body = request.method === 'POST' ? await readBody(request) : ''
      const bearer = request.headers.authorization?.replace(/^Bearer /, '')
      const issue = () => {
        matrixAccess = `mat-${randomBytes(8).toString('hex')}`
        matrixRefresh = `mrt-${randomBytes(8).toString('hex')}`
        return { access_token: matrixAccess, refresh_token: matrixRefresh, expires_in_ms: 60_000 }
      }
      if (url.pathname === '/_matrix/client/versions')
        return json(response, 200, { versions: ['v1.11'] })
      if (url.pathname === '/_matrix/client/v3/login/sso/redirect') {
        const redirect = url.searchParams.get('redirectUrl') ?? ''
        // Synapse's `sso.client_whitelist` names the community origin with its trailing slash.
        if (!redirect.startsWith(`${ORIGINS.spa}/`))
          return json(response, 400, { errcode: 'M_FORBIDDEN' })
        const loginToken = `lt-${randomBytes(8).toString('hex')}`
        loginTokens.add(loginToken)
        const back = new URL(redirect)
        back.searchParams.set('loginToken', loginToken)
        response.writeHead(302, { Location: back.href })
        return response.end()
      }
      if (url.pathname === '/_matrix/client/v3/login' && request.method === 'POST') {
        const login = JSON.parse(body) as { type?: string; token?: string; refresh_token?: boolean }
        if (
          login.type !== 'm.login.token' ||
          !loginTokens.delete(login.token ?? '') ||
          login.refresh_token !== true
        )
          return json(response, 403, { errcode: 'M_FORBIDDEN' })
        return json(response, 200, {
          user_id: `@${SUBJECT}:${SERVER_NAME}`,
          device_id: 'SYNTHETICDEV',
          ...issue(),
        })
      }
      if (url.pathname === '/_matrix/client/v3/refresh' && request.method === 'POST') {
        const refresh = JSON.parse(body) as { refresh_token?: string }
        if (refresh.refresh_token !== matrixRefresh)
          return json(response, 401, { errcode: 'M_UNKNOWN_TOKEN' })
        return json(response, 200, issue())
      }
      if (url.pathname === '/_matrix/client/v3/logout' && request.method === 'POST')
        return json(response, 200, {})
      if (url.pathname === '/_kodera/rooms/token' && request.method === 'POST') {
        roomTokenCalls += 1
        // The first grant meets an expired Matrix token, as the service answers within minutes.
        if (roomTokenCalls === 1 || bearer !== matrixAccess)
          return json(response, 401, { errcode: 'M_UNKNOWN_TOKEN' })
        const asked = JSON.parse(body) as { room_id?: string }
        if (asked.room_id !== AUDIO_ROOM) return json(response, 403, { errcode: 'M_FORBIDDEN' })
        return json(response, 200, {
          url: ORIGINS.livekit,
          token: LIVEKIT_TOKEN,
          listen_only: false,
        })
      }
      // Federation and key routes stay closed, as on the real edge.
      return json(response, 404, { errcode: 'M_UNRECOGNIZED' })
    })()
  })

  // --- LiveKit signalling ------------------------------------------------------------------------
  const livekit = createHttpsServer({ key, cert }, (request, response) => {
    const hit = record('livekit', request)
    if (cors(hit, request, response)) return
    json(response, 401, { error: 'synthetic signalling refuses' })
  })
  livekit.on('upgrade', (request: IncomingMessage, socket) => {
    record('livekit', request, true)
    // The handshake reached the right origin; that is all this stub proves. Refuse it cleanly.
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })

  // --- A foreign origin, for the CORS refusal proof -------------------------------------------
  const foreign = createHttpsServer({ key, cert }, (request, response) => {
    record('foreign', request)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>Foreign origin</title>')
  })

  // --- The static SPA, built with the real-identity settings ------------------------------------
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'kodera-split-vite-'))
  const previous = Object.fromEntries(
    Object.keys(REAL_BUILD_ENV).map((name) => [name, process.env[name]])
  )
  Object.assign(process.env, REAL_BUILD_ENV)
  const spaPort = await freePort()
  let vite: ViteDevServer | undefined
  try {
    vite = await createViteServer({
      root,
      envDir: false,
      cacheDir,
      logLevel: 'error',
      // Discovered late, these would re-optimise mid-test and reload the page under it.
      optimizeDeps: { include: ['livekit-client', 'matrix-js-sdk', 'oidc-client-ts'] },
      server: {
        host: '127.0.0.1',
        port: spaPort,
        strictPort: true,
        https: { key, cert },
        hmr: false,
        allowedHosts: [HOSTS.spa],
        fs: {
          allow: [
            resolve(root, '../..'),
            realpathSync(resolve(root, '../../node_modules')),
            realpathSync(resolve(root, '../../node_modules/@kodera/design-tokens')),
          ],
        },
      },
      plugins: [
        {
          name: 'split-origin-static-contract',
          configureServer(server) {
            // The static origin's contract (kodera-ops `deployment/community/server.mjs`): files,
            // the root redirect, Matrix discovery with public CORS, and 503 for any backend path.
            server.middlewares.use((request, response, next) => {
              const hit = record('spa', request)
              if (hit.path === '/.well-known/matrix/client') {
                response.setHeader('Access-Control-Allow-Origin', '*')
                return json(response, 200, { 'm.homeserver': { base_url: ORIGINS.matrix } })
              }
              if (/^\/(?:api|realms|_matrix|_kodera|_synapse)(?:\/|$)/.test(hit.path)) {
                response.writeHead(503).end()
                return
              }
              if (hit.path === '/') {
                response.writeHead(302, { Location: '/community/workspace' }).end()
                return
              }
              next()
            })
          },
        },
      ],
    })
    await vite.listen()
  } catch (error) {
    rmSync(cacheDir, { recursive: true, force: true })
    throw error
  } finally {
    // The settings are read when the server resolves its configuration, which is now done.
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const ports = new Map<string, number>([
    [HOSTS.spa, spaPort],
    [HOSTS.auth, await listen(auth)],
    [HOSTS.api, await listen(core)],
    [HOSTS.matrix, await listen(matrix)],
    [HOSTS.livekit, await listen(livekit)],
    [HOSTS.foreign, await listen(foreign)],
  ])

  // --- The forward proxy: each production-shaped name to its own local server -------------------
  const proxy = createHttpServer((request, response) => {
    // Plain HTTP is never part of the contract.
    refusedHosts.push(request.headers.host ?? request.url ?? '')
    response.writeHead(403).end()
  })
  proxy.on('connect', (request: IncomingMessage, socket, head: Buffer) => {
    const [host, port] = (request.url ?? '').split(':')
    const target = host === undefined ? undefined : ports.get(host)
    if (target === undefined || port !== '443') {
      refusedHosts.push(request.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = connect(target, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const proxyPort = await listen(proxy)

  return {
    proxy: `http://127.0.0.1:${proxyPort}`,
    hits,
    refusedHosts,
    corsRefusals,
    isDevChannel: (url) => {
      const parsed = new URL(url)
      return (
        parsed.protocol === 'wss:' &&
        parsed.pathname === '/' &&
        (parsed.host === HOSTS.spa || parsed.host === `127.0.0.1:${spaPort}`)
      )
    },
    close: async () => {
      try {
        await Promise.all([proxy, auth, core, matrix, livekit, foreign].map(closeServer))
        await vite?.close()
      } finally {
        rmSync(cacheDir, { recursive: true, force: true })
      }
    },
  }
}

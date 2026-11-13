// Source-serving boundary only: no API, provider client, secret state or deployment configuration.
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { createServer, STATUS_CODES } from 'node:http'
import { extname, isAbsolute, join, relative } from 'node:path'

const REQUIRED = [
  '--root',
  '--port',
  '--prefix',
  '--claim-path',
  '--core-origin',
  '--provider-origin',
  // Every organisation's homeserver and LiveKit server sit under it (ADR-0012).
  '--matrix-domain',
]
// The local stack's homeserver and LiveKit server, on this machine: refused without
// `--allow-loopback`, which no deployment passes, and which is refused without one of them, so a
// deployment that carries it by mistake does not start.
const OPTIONAL = ['--homeserver-origin', '--livekit-origin']
// Where members' attachments are stored: the presigned uploads go there, and to that path only
// (docs/specs/messaging-media-and-notifications.md). A deployment without it offers no upload.
const ATTACHMENT_BASE = '--attachment-base'
// The address to listen on: loopback unless a container passes `0.0.0.0`, where loopback is
// unreachable from the edge in front of it. No other address is accepted.
const HOST = '--host'
const HOSTS = ['127.0.0.1', '0.0.0.0']
const FLAGS = [...REQUIRED, ...OPTIONAL, ATTACHMENT_BASE, HOST]
// A flag without a value.
const ALLOW_LOOPBACK = '--allow-loopback'
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']
// What livekit-client 2.22.4 opens under its server's URL: signalling (`/rtc/v1`, and `/rtc` when
// it falls back to the v0 path) and, over HTTP after a failed connection, the validation of each.
// tests/unit/serving/livekit-paths.test.ts holds this list to the installed SDK.
const LIVEKIT_PATHS = ['/rtc', '/rtc/v1', '/rtc/validate', '/rtc/v1/validate']
// Built files under `/assets` are named by their content hash, so a name never serves two contents:
// they alone are cached for a year and never revalidated. Every other response, the documents and
// the SPA fallback first (claim and invitation entries carry a secret in the address), stays
// `no-store` (docs/specs/asset-caching-and-compression.md).
const ASSET_CACHE = 'public, max-age=31536000, immutable'
// Encodings the build writes beside a text asset (`scripts/precompress.mjs`), brotli first: the
// server's choice when a request weights both alike. A sibling is served only when the request
// accepts its encoding.
const ENCODINGS = [
  ['br', '.br'],
  ['gzip', '.gz'],
]
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DNS_NAME = new RegExp(`^(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`)
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.wasm', 'application/wasm'],
])

function within(path, base) {
  return path === base || path.startsWith(base + '/')
}

function configuredPath(value, allowRoot) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    /[\s\\%?#\p{Cc}]/u.test(value) ||
    value.includes('//') ||
    (value === '/' ? !allowRoot : value.endsWith('/')) ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Invalid configuration')
  return value
}

function configuredOrigin(value, scheme = 'https') {
  const lead = `${scheme}://`
  if (
    typeof value !== 'string' ||
    value.slice(0, lead.length).toLowerCase() !== lead ||
    /[\s\\?#;'",*\p{Cc}]/u.test(value)
  )
    throw new Error('Invalid configuration')
  const authority = value.slice(lead.length).split('/')[0]
  if (!authority || authority.includes('@')) throw new Error('Invalid configuration')
  const url = new URL(value)
  if (
    url.protocol !== `${scheme}:` ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /[;'",*\s\p{Cc}]/u.test(url.origin)
  )
    throw new Error('Invalid configuration')
  // URL normalizes dot segments: refuse a non-root raw path before trusting that result.
  const path = value.slice(lead.length + authority.length)
  if (path !== '' && path !== '/') throw new Error('Invalid configuration')
  return url.origin
}

// A lowercase DNS name of two labels at least: no scheme, port, wildcard or trailing dot, and a
// last label that is not a number. `src/features/espace/homeserver.ts` applies the same rule.
function configuredDomain(value) {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    !DNS_NAME.test(value) ||
    /^[0-9]+$/.test(value.split('.').at(-1))
  )
    throw new Error('Invalid configuration')
  return value
}

// An origin on this machine, in one of `schemes`, validated like the others.
function configuredLoopbackOrigin(value, schemes) {
  const scheme = schemes.find(
    (candidate) =>
      typeof value === 'string' &&
      value.slice(0, candidate.length + 3).toLowerCase() === `${candidate}://`
  )
  if (scheme === undefined) throw new Error('Invalid configuration')
  const origin = configuredOrigin(value, scheme)
  if (!LOOPBACK.includes(new URL(origin).hostname)) throw new Error('Invalid configuration')
  return origin
}

// An https origin and a path below it that ends in `/`: never a bare origin, which would open the
// whole host to the page's requests.
function configuredBase(value) {
  if (typeof value !== 'string' || !value.endsWith('/')) throw new Error('Invalid configuration')
  const lead = 'https://'
  const authorityEnd = value.indexOf('/', lead.length)
  if (authorityEnd === -1) throw new Error('Invalid configuration')
  const origin = configuredOrigin(value.slice(0, authorityEnd))
  const path = configuredPath(value.slice(authorityEnd, -1), false)
  return `${origin}${path}/`
}

async function configuration(arguments_) {
  const values = new Map()
  let allowLoopback = false
  let index = 0
  while (index < arguments_.length) {
    const flag = arguments_[index]
    if (flag === ALLOW_LOOPBACK) {
      if (allowLoopback) throw new Error('Invalid configuration')
      allowLoopback = true
      index += 1
      continue
    }
    if (!FLAGS.includes(flag) || values.has(flag) || index + 1 >= arguments_.length) {
      throw new Error('Invalid configuration')
    }
    values.set(flag, arguments_[index + 1])
    index += 2
  }
  if (REQUIRED.some((flag) => !values.has(flag))) throw new Error('Invalid configuration')
  if (!/^(?:0|[1-9]\d*)$/.test(values.get('--port'))) throw new Error('Invalid configuration')
  const port = Number(values.get('--port'))
  if (!Number.isSafeInteger(port) || port > 65535) throw new Error('Invalid configuration')
  const prefix = configuredPath(values.get('--prefix'), true)
  const claimPath = configuredPath(values.get('--claim-path'), false)
  if (
    ['/auth', '/assets', '/api'].some((base) => within(claimPath, base) || within(base, claimPath))
  ) {
    throw new Error('Invalid configuration')
  }
  const coreOrigin = configuredOrigin(values.get('--core-origin'))
  const providerOrigin = configuredOrigin(values.get('--provider-origin'))
  // Every organisation's Synapse and LiveKit server, under one domain (ADR-0012).
  const matrixDomain = configuredDomain(values.get('--matrix-domain'))
  // `--allow-loopback` and a loopback origin come together, or neither does.
  if (OPTIONAL.some((flag) => values.has(flag)) !== allowLoopback) {
    throw new Error('Invalid configuration')
  }
  const homeserverOrigin = values.has('--homeserver-origin')
    ? configuredLoopbackOrigin(values.get('--homeserver-origin'), ['http', 'https'])
    : null
  const liveKitOrigin = values.has('--livekit-origin')
    ? configuredLoopbackOrigin(values.get('--livekit-origin'), ['ws'])
    : null
  const attachmentBase = values.has(ATTACHMENT_BASE)
    ? configuredBase(values.get(ATTACHMENT_BASE))
    : null
  // The store is its own host: under Core's or the identity provider's, it would open their paths.
  if (
    attachmentBase !== null &&
    [coreOrigin, providerOrigin].includes(new URL(attachmentBase).origin)
  ) {
    throw new Error('Invalid configuration')
  }
  const host = values.has(HOST) ? values.get(HOST) : '127.0.0.1'
  if (!HOSTS.includes(host)) throw new Error('Invalid configuration')
  const root = await realpath(values.get('--root'))
  if (!(await stat(root)).isDirectory()) throw new Error('Invalid configuration')
  return {
    root,
    host,
    port,
    prefix,
    claimPath,
    coreOrigin,
    providerOrigin,
    matrixDomain,
    homeserverOrigin,
    liveKitOrigin,
    attachmentBase,
  }
}

function headers(config, path) {
  const ordinaryCallback = path === '/auth/callback' && !within(path, config.claimPath)
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    [
      "connect-src 'self'",
      `${config.coreOrigin}/api/v1/`,
      `${config.providerOrigin}/realms/`,
      // Every source under the matrix domain names its path: a host wildcard with a bare origin
      // would open Core, the identity provider and every other host under the domain.
      `https://*.${config.matrixDomain}/.well-known/matrix/client`,
      `https://*.${config.matrixDomain}/_matrix/`,
      // The room-access call on the homeserver's origin: this one path, exactly.
      `https://*.${config.matrixDomain}/_kodera/rooms/token`,
      // A `wss` source also matches `https` (CSP Level 3), so these too name their paths.
      ...LIVEKIT_PATHS.map((path) => `wss://*.${config.matrixDomain}${path}`),
      ...(config.homeserverOrigin === null
        ? []
        : [
            `${config.homeserverOrigin}/_matrix/`,
            `${config.homeserverOrigin}/_kodera/rooms/token`,
          ]),
      ...(config.liveKitOrigin === null
        ? []
        : LIVEKIT_PATHS.map((path) => `${config.liveKitOrigin}${path}`)),
      ...(config.attachmentBase === null ? [] : [config.attachmentBase]),
    ].join(' '),
    `frame-src 'self' ${config.providerOrigin}/realms/`,
    `frame-ancestors ${ordinaryCallback ? "'self'" : "'none'"}`,
  ].join('; ')
  return {
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': policy,
  }
}

// A qvalue, as RFC 9110 §12.4.2 writes it: 0 to 1, with at most three decimals.
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/
// Older names of the same codings (RFC 9110 §8.4.1.3).
const ALIASES = new Map([['x-gzip', 'gzip']])

// The weight a request's Accept-Encoding gives `coding` (RFC 9110 §12.5.3): its own entry, else
// `*`'s, else 0. An entry with a malformed weight is ignored, so it never accepts anything.
function weight(header, coding) {
  if (typeof header !== 'string') return 0
  let named
  let wildcard
  for (const part of header.split(',')) {
    const [rawToken = '', ...parameters] = part.split(';')
    const token = rawToken.trim().toLowerCase()
    let q = 1
    let valid = true
    for (const parameter of parameters) {
      const [key = '', value = '', ...rest] = parameter.split('=').map((piece) => piece.trim())
      if (key.toLowerCase() !== 'q') continue
      if (rest.length === 0 && QVALUE.test(value)) q = Number(value)
      else valid = false
    }
    if (!valid || token === '') continue
    // A repeated entry keeps its lowest weight, so a q=0 anywhere refuses the coding.
    if ((ALIASES.get(token) ?? token) === coding) named = Math.min(named ?? 1, q)
    else if (token === '*') wildcard = Math.min(wildcard ?? 1, q)
  }
  return named ?? wildcard ?? 0
}

function empty(response, config, path, status, extra = {}) {
  response.writeHead(status, {
    ...headers(config, path),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': '0',
    ...extra,
  })
  response.end()
}

function requestPath(target) {
  // Never pass an untrusted target through URL normalization before checking traversal.
  if (
    typeof target !== 'string' ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('#')
  )
    throw new Error('Invalid request target')
  const raw = target.split('?')[0]
  if (/[\s\\\p{Cc}]/u.test(raw) || raw.includes('//') || /%(?:2f|5c|25)/i.test(raw)) {
    throw new Error('Invalid request target')
  }
  const path = decodeURIComponent(raw)
  if (
    /[\s\\\p{Cc}]/u.test(path) ||
    path.includes('//') ||
    path.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Invalid request target')
  }
  return path
}

function insideRoot(root, path) {
  const difference = relative(root, path)
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith('../')
}

async function resource(root, name) {
  let handle
  try {
    let path = root
    // Check every existing ancestor before considering SPA fallback, including a symlink to
    // an outside directory whose requested final file does not exist.
    for (const segment of name.split('/').filter(Boolean)) {
      path = await realpath(join(path, segment))
      if (!insideRoot(root, path)) return { status: 403 }
    }
    if (!(await stat(path)).isFile()) return { status: 404 }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) {
      await handle.close()
      return { status: 404 }
    }
    return {
      status: 200,
      handle,
      size: info.size,
      type: MIME.get(extname(name).toLowerCase()) ?? 'application/octet-stream',
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 404 }
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP') {
      return { status: 403 }
    }
    return { status: 500 }
  }
}

async function dispatch(config, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    empty(response, config, undefined, 405, { Allow: 'GET, HEAD' })
    return
  }
  let path
  try {
    path = requestPath(request.url)
  } catch {
    empty(response, config, undefined, 400)
    return
  }
  if (config.prefix !== '/' && !within(path, config.prefix)) {
    empty(response, config, undefined, 404)
    return
  }
  const local = config.prefix === '/' ? path : path.slice(config.prefix.length) || '/'
  const name = local.slice(1)
  if (within(local, '/api') || name.split('/').some((part) => part.startsWith('.'))) {
    empty(response, config, local, 404)
    return
  }
  const asset = within(local, '/assets')
  // A precompressed sibling is only ever a representation of its source file, never a resource;
  // and an asset is a file, never a directory, so no trailing slash can rename one.
  if (
    asset &&
    (local.endsWith('/') || ENCODINGS.some(([, suffix]) => name.toLowerCase().endsWith(suffix)))
  ) {
    empty(response, config, local, 404)
    return
  }
  let found = await resource(config.root, name || 'index.html')
  if (found.status === 404 && !within(local, '/assets') && extname(local) === '') {
    found = await resource(config.root, 'index.html')
  }
  if (found.status !== 200) {
    empty(response, config, local, found.status)
    return
  }
  const representation = {}
  if (asset) {
    representation['Cache-Control'] = ASSET_CACHE
    representation.Vary = 'Accept-Encoding'
    // The coding the request weights highest, brotli first on a tie; the file as it is otherwise.
    const header = request.headers['accept-encoding']
    const ranked = ENCODINGS.map(([coding, suffix]) => ({
      coding,
      suffix,
      q: weight(header, coding),
    }))
      .filter(({ q }) => q > 0)
      .sort((left, right) => right.q - left.q)
    for (const { coding, suffix } of ranked) {
      const encoded = await resource(config.root, name + suffix)
      if (encoded.status !== 200) continue
      await found.handle.close()
      found = { ...encoded, type: found.type }
      representation['Content-Encoding'] = coding
      break
    }
  }
  if (request.method === 'HEAD') {
    await found.handle.close()
    response.writeHead(200, {
      ...headers(config, local),
      ...representation,
      'Content-Type': found.type,
      'Content-Length': String(found.size),
    })
    response.end()
    return
  }
  const stream = found.handle.createReadStream()
  stream.once('error', () => response.destroy())
  response.once('close', () => stream.destroy())
  response.writeHead(200, {
    ...headers(config, local),
    ...representation,
    'Content-Type': found.type,
    'Content-Length': String(found.size),
  })
  stream.pipe(response)
}

function refuseSocket(socket, config, status, allow = false) {
  socket.once('error', () => {})
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const fields = { ...headers(config, undefined), 'Content-Length': '0', Connection: 'close' }
  if (allow) fields.Allow = 'GET, HEAD'
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
      Object.entries(fields)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('') +
      '\r\n'
  )
}

async function main() {
  let config
  try {
    config = await configuration(process.argv.slice(2))
  } catch {
    process.stderr.write('configuration-invalid\n')
    process.exitCode = 2
    return
  }
  const serve = (request, response) => {
    void dispatch(config, request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) empty(response, config, undefined, 500)
      else response.destroy()
    })
  }
  const server = createServer(serve)
  server.on('checkContinue', serve)
  server.on('checkExpectation', (_request, response) => empty(response, config, undefined, 417))
  server.on('clientError', (_error, socket) => refuseSocket(socket, config, 400))
  server.on('connect', (_request, socket) => refuseSocket(socket, config, 405, true))
  server.on('upgrade', (_request, socket) => refuseSocket(socket, config, 400))
  let ready = false
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    server.close()
    server.closeAllConnections()
  }
  server.on('error', () => {
    process.exitCode = ready ? 1 : 2
    if (!ready) process.stderr.write('configuration-invalid\n')
    close()
  })
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
  server.listen(config.port, config.host, () => {
    const address = server.address()
    if (address === null || typeof address === 'string' || address.address !== config.host) {
      process.exitCode = 2
      process.stderr.write('configuration-invalid\n')
      close()
      return
    }
    ready = true
    process.stdout.write(
      JSON.stringify({ event: 'listening', host: address.address, port: address.port }) + '\n'
    )
  })
}

void main()

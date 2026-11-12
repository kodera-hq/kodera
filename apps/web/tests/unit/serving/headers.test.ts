// @vitest-environment node
// New executable interface: initial absence is a missing-interface red, not an existing bug.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve('server/static.mjs')
const mutationChildren = new Set<ChildProcessWithoutNullStreams>()
const PREFIX = '/console'
const CORE = 'https://core.fixture.test'
const PROVIDER = 'https://identity.fixture.test'
const MATRIX_DOMAIN = 'kodera.fixture.test'
// The local stack's servers, on this machine: named only behind `--allow-loopback`.
const LOOPBACK_HOMESERVER = 'http://127.0.0.1:8008'
const LOOPBACK_LIVEKIT = 'ws://127.0.0.1:7880'
// What livekit-client opens under its server's URL (tests/unit/serving/livekit-paths.test.ts).
const LIVEKIT_PATHS = ['/rtc', '/rtc/v1', '/rtc/validate', '/rtc/v1/validate']
const INDEX = '<!doctype html><title>Finite serving fixture</title><div id="root"></div>'
const CONTROL = 'synthetic-outside-file-must-never-be-served'
// The built assets' policy (docs/specs/asset-caching-and-compression.md); every other response
// is `no-store`.
const ASSET_CACHE = 'public, max-age=31536000, immutable'
const APP_JS = 'export const fixture = true\n'

interface Running {
  child: ChildProcessWithoutNullStreams
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | undefined }>
  port: number
  output: () => { stdout: string; stderr: string }
  observation: () => {
    stdoutOverflow: boolean
    stderrOverflow: boolean
    unexpectedTermination: boolean
  }
  expectCleanup: () => void
}

function args(root: string): string[] {
  return [
    '--root',
    root,
    '--port',
    '0',
    '--prefix',
    PREFIX,
    '--claim-path',
    '/claim',
    '--core-origin',
    CORE,
    '--provider-origin',
    PROVIDER,
    '--matrix-domain',
    MATRIX_DOMAIN,
  ]
}

function child(
  arguments_: string[],
  purpose: 'serving' | 'configuration' = 'serving',
  script = SCRIPT
) {
  if (script !== SCRIPT)
    expect(
      mutationChildren.size,
      'Previous mutation child must be closed before another spawn'
    ).toBe(0)
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' }
  delete env.NODE_OPTIONS
  delete env.NODE_COMPILE_CACHE
  const spawned = spawn(process.execPath, ['--max-old-space-size=128', script, ...arguments_], {
    env,
    stdio: 'pipe',
  })
  if (script !== SCRIPT) {
    mutationChildren.add(spawned)
    spawned.once('close', () => mutationChildren.delete(spawned))
  }
  // Register immediately: exit does not establish that stdout/stderr have closed.
  let spawnError: Error | undefined
  spawned.once('error', (error) => {
    spawnError = error
  })
  const closed = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    error: Error | undefined
  }>((done) => {
    spawned.once('close', (code, signal) => done({ code, signal, error: spawnError }))
  })
  let stdout = ''
  let stderr = ''
  let stdoutOverflow = false
  let stderrOverflow = false
  let cleanupExpected = false
  let unexpectedTermination = false
  spawned.once('exit', () => {
    if (purpose === 'serving' && !cleanupExpected) unexpectedTermination = true
  })
  spawned.stdout.on('data', (value: Buffer) => {
    if (Buffer.byteLength(stdout) + value.length > 16_384) {
      stdoutOverflow = true
      spawned.kill('SIGKILL')
    } else stdout += value.toString()
  })
  spawned.stderr.on('data', (value: Buffer) => {
    if (Buffer.byteLength(stderr) + value.length > 16_384) {
      stderrOverflow = true
      spawned.kill('SIGKILL')
    } else stderr += value.toString()
  })
  return {
    child: spawned,
    closed,
    output: () => ({ stdout, stderr }),
    observation: () => ({ stdoutOverflow, stderrOverflow, unexpectedTermination }),
    expectCleanup: () => {
      cleanupExpected = true
    },
  }
}

function observed(running: Pick<Running, 'observation'>) {
  expect(running.observation()).toEqual({
    stdoutOverflow: false,
    stderrOverflow: false,
    unexpectedTermination: false,
  })
}

async function stop(running: Pick<Running, 'child' | 'closed' | 'observation' | 'expectCleanup'>) {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.expectCleanup()
    running.child.kill('SIGTERM')
  }
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 1000)
  try {
    const terminal = await running.closed
    expect(terminal.error).toBeUndefined()
    observed(running)
  } finally {
    clearTimeout(timer)
  }
}

async function start(arguments_: string[], script = SCRIPT): Promise<Running> {
  const running = child(arguments_, 'serving', script)
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => {
        running.child.kill('SIGKILL')
        reject(new Error('Static server readiness timeout'))
      }, 5000)
      const finish = () => clearTimeout(timer)
      running.child.once('error', (error) => {
        finish()
        reject(error)
      })
      running.child.once('close', () => {
        finish()
        reject(new Error('Static server exited before readiness: ' + running.output().stderr))
      })
      running.child.stdout.on('data', () => {
        if (!running.output().stdout.includes('\n')) return
        const line = running.output().stdout.split('\n')[0]
        if (!line) return
        try {
          const value: unknown = JSON.parse(line)
          if (
            typeof value !== 'object' ||
            value === null ||
            !('event' in value) ||
            value.event !== 'listening' ||
            !('port' in value) ||
            typeof value.port !== 'number' ||
            !Number.isInteger(value.port) ||
            value.port < 1 ||
            value.port > 65535
          )
            return
          if (!('host' in value) || value.host !== '127.0.0.1') {
            finish()
            reject(new Error('Listener must report its actual bound loopback address'))
            return
          }
          finish()
          resolvePort(value.port)
        } catch {
          // Wait for a full JSON line; bounded readiness still fails malformed output.
        }
      })
    })
    return { ...running, port }
  } catch (error) {
    try {
      await stop(running)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Static server setup and cleanup observations failed'
      )
    }
    throw error
  }
}

async function http(port: number, path: string, method = 'GET', headers: OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; raw: Buffer }>(
    (resolveResponse, reject) => {
      const outgoing = request(
        { hostname: '127.0.0.1', port, path, method, headers },
        (response) => {
          const chunks: Buffer[] = []
          let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 8192) outgoing.destroy(new Error('Fixture body bound exceeded'))
            else chunks.push(chunk)
          })
          response.on('end', () =>
            resolveResponse({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
              raw: Buffer.concat(chunks),
            })
          )
          response.on('error', reject)
        }
      )
      outgoing.setTimeout(2000, () => outgoing.destroy(new Error('Owned HTTP request timeout')))
      const deadline = setTimeout(
        () => outgoing.destroy(new Error('Owned HTTP absolute deadline')),
        2000
      )
      outgoing.once('close', () => clearTimeout(deadline))
      outgoing.on('error', reject)
      outgoing.end()
    }
  )
}

function directives(headers: IncomingHttpHeaders) {
  const csp = headers['content-security-policy']
  expect(typeof csp).toBe('string')
  if (typeof csp !== 'string') throw new Error('Missing actual CSP response')
  const values = new Map<string, string[]>()
  for (const clause of csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [name, ...tokens] = clause.split(/\s+/)
    if (name === undefined) throw new Error('Empty directive')
    expect(values.has(name)).toBe(false)
    values.set(name, tokens)
  }
  return values
}

function security(
  headers: IncomingHttpHeaders,
  ancestor: "'none'" | "'self'" = "'none'",
  loopback: readonly string[] = [],
  cache: 'no-store' | typeof ASSET_CACHE = 'no-store'
) {
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['cache-control']).toBe(cache)
  expect(headers['x-content-type-options']).toBe('nosniff')
  // No opener policy, of any value: the sign-in popup (src/auth/oidc.ts) is watched through
  // `window.closed`, and under one the opener reads it as true, so every popup sign-in would
  // abort half a second after it opened.
  expect(headers['cross-origin-opener-policy']).toBeUndefined()
  const csp = directives(headers)
  // Exact directive inventory prevents an added *-src-elem/worker-src override
  // from bypassing the asserted fallback policy.
  expect([...csp.keys()].sort()).toEqual(
    [
      'default-src',
      'script-src',
      'script-src-attr',
      'style-src',
      'style-src-attr',
      'img-src',
      'font-src',
      'object-src',
      'base-uri',
      'form-action',
      'connect-src',
      'frame-src',
      'frame-ancestors',
    ].sort()
  )
  expect(csp.get('default-src')).toEqual(["'self'"])
  expect(csp.get('script-src')).toEqual(["'self'"])
  expect(csp.get('script-src-attr')).toEqual(["'none'"])
  // `'self'` alone: no `'unsafe-inline'`, no hash, no nonce. The one inline `<style>` a
  // dependency wrote is removed at build (tests/unit/serving/radix-select-style.test.ts).
  expect(csp.get('style-src')).toEqual(["'self'"])
  expect(csp.get('style-src-attr')).toEqual(["'none'"])
  expect(csp.get('img-src')).toEqual(["'self'"])
  expect(csp.get('font-src')).toEqual(["'self'"])
  expect(csp.get('object-src')).toEqual(["'none'"])
  expect(csp.get('base-uri')).toEqual(["'none'"])
  expect(csp.get('form-action')).toEqual(["'self'"])
  expect(csp.get('connect-src')).toEqual([
    "'self'",
    CORE + '/api/v1/',
    PROVIDER + '/realms/',
    // Every host under the matrix domain, on the paths the Console calls and no others
    // (ADR-0012): discovery, the client-server API, the room-access call, and LiveKit's.
    `https://*.${MATRIX_DOMAIN}/.well-known/matrix/client`,
    `https://*.${MATRIX_DOMAIN}/_matrix/`,
    `https://*.${MATRIX_DOMAIN}/_kodera/rooms/token`,
    ...LIVEKIT_PATHS.map((path) => `wss://*.${MATRIX_DOMAIN}${path}`),
    ...loopback,
  ])
  // A source with no path opens its whole host, and under CSP Level 3 a `wss:` source matches
  // `https:` too: every source but 'self' names a path below its host.
  for (const source of csp.get('connect-src')!.slice(1)) {
    expect(source, source).toMatch(/^[a-z]+:\/\/[^/]+\/./)
  }
  expect(csp.get('frame-src')).toEqual(["'self'", PROVIDER + '/realms/'])
  expect(csp.get('frame-ancestors')).toEqual([ancestor])
}

describe('actual source static-serving boundary', { concurrent: false }, () => {
  let temporary = ''
  let root = ''
  let running: Running | undefined
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'console-serving-'))
    root = join(temporary, 'dist')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), INDEX)
    await writeFile(join(root, 'llms.txt'), '# Kodera\n')
    await mkdir(join(root, 'developer-docs'), { recursive: true })
    await writeFile(join(root, 'developer-docs', 'quickstart.md'), '# Quickstart\n')
    await writeFile(join(root, 'assets', 'app.js'), APP_JS)
    // The build's precompressed siblings (scripts/precompress.mjs); `plain.css` has none.
    await writeFile(join(root, 'assets', 'app.js.br'), brotliCompressSync(APP_JS))
    await writeFile(join(root, 'assets', 'app.js.gz'), gzipSync(APP_JS))
    await writeFile(join(root, 'assets', 'plain.css'), 'body{}\n')
    await writeFile(join(temporary, 'outside.txt'), CONTROL)
    await symlink(join(temporary, 'outside.txt'), join(root, 'escape.txt'))
    running = await start(args(root))
  })
  afterAll(async () => {
    try {
      if (running !== undefined) await stop(running)
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true })
    }
  })
  function port() {
    if (running === undefined) throw new Error('New server interface not ready')
    return running.port
  }

  it.each([
    '/console/claim/fixture-id/fixture-slug',
    '/console/auth/claim-callback?code=synthetic-code&state=synthetic-state',
    '/console/acme-sa/home',
  ])('serves real protected/fallback HTML headers on GET and HEAD: %s', async (path) => {
    const get = await http(port(), path)
    expect(get.status).toBe(200)
    expect(get.body).toBe(INDEX)
    expect(get.headers['content-type']).toMatch(/^text\/html/)
    security(get.headers)
    const head = await http(port(), path, 'HEAD')
    expect(head.status).toBe(get.status)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toBe(get.headers['content-type'])
    expect(head.headers['content-length']).toBe(get.headers['content-length'])
    security(head.headers)
  })

  it('keeps only the exact ordinary callback same-origin frameable', async () => {
    const ordinary = await http(port(), '/console/auth/callback?code=synthetic')
    expect(ordinary.status).toBe(200)
    security(ordinary.headers, "'self'")
    const head = await http(port(), '/console/auth/callback?code=synthetic', 'HEAD')
    expect(head.status).toBe(ordinary.status)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toBe(ordinary.headers['content-type'])
    expect(head.headers['content-length']).toBe(ordinary.headers['content-length'])
    security(head.headers, "'self'")
    const suffix = await http(port(), '/console/auth/callback/extra')
    security(suffix.headers)
  })

  it('never derives CSP sources from adversarial Host or forwarding headers', async () => {
    const result = await http(port(), '/console/claim/fixture-id/fixture-slug', 'GET', {
      Host: 'untrusted.fixture.test:8443',
      Forwarded: 'for=192.0.2.1;host=untrusted.fixture.test;proto=http',
      'X-Forwarded-Host': 'untrusted.fixture.test',
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Port': '8443',
      'X-Forwarded-Prefix': '/untrusted',
    })
    expect(result.status).toBe(200)
    expect(result.body).toBe(INDEX)
    security(result.headers)
  })

  it('serves agent documentation as text and Markdown instead of SPA HTML', async () => {
    for (const [path, body, type] of [
      ['/console/llms.txt', '# Kodera\n', 'text/plain; charset=utf-8'],
      ['/console/developer-docs/quickstart.md', '# Quickstart\n', 'text/markdown; charset=utf-8'],
    ]) {
      const result = await http(port(), path!)
      expect(result.status).toBe(200)
      expect(result.body).toBe(body)
      expect(result.headers['content-type']).toBe(type)
      security(result.headers, "'none'", [])
    }
  })

  it('serves a real asset without turning a missing asset or API path into SPA HTML', async () => {
    const asset = await http(port(), '/console/assets/app.js')
    expect(asset.status).toBe(200)
    expect(asset.body).toContain('fixture')
    expect(asset.headers['content-type']).toMatch(/javascript/)
    security(asset.headers, "'none'", [], ASSET_CACHE)
    const head = await http(port(), '/console/assets/app.js', 'HEAD')
    expect(head.status).toBe(asset.status)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toBe(asset.headers['content-type'])
    expect(head.headers['content-length']).toBe(asset.headers['content-length'])
    security(head.headers, "'none'", [], ASSET_CACHE)
    for (const path of [
      '/console/assets/missing.js',
      '/console/api/v1/me',
      '/consolex/home',
      '/',
    ]) {
      const result = await http(port(), path)
      expect(result.status).toBe(404)
      expect(result.body).not.toBe(INDEX)
      security(result.headers)
      const missingHead = await http(port(), path, 'HEAD')
      expect(missingHead.status).toBe(result.status)
      expect(missingHead.body).toBe('')
      expect(missingHead.headers['content-type']).toBe(result.headers['content-type'])
      expect(missingHead.headers['content-length']).toBe(result.headers['content-length'])
      security(missingHead.headers)
    }
  })

  it('caches a built asset for a year, and nothing else', async () => {
    const asset = await http(port(), '/console/assets/app.js')
    expect(asset.headers['cache-control']).toBe(ASSET_CACHE)
    expect(asset.headers.vary).toBe('Accept-Encoding')
    expect(asset.headers['content-encoding']).toBeUndefined()
    expect(asset.body).toBe(APP_JS)
    // A document, the SPA fallback and a missing asset stay unstored, whatever the request accepts.
    for (const path of ['/console/', '/console/home', '/console/assets/missing.js']) {
      const result = await http(port(), path, 'GET', { 'accept-encoding': 'br, gzip' })
      expect(result.headers['cache-control'], path).toBe('no-store')
      expect(result.headers['content-encoding'], path).toBeUndefined()
      expect(result.headers.vary, path).toBeUndefined()
    }
  })

  it.each([
    ['br', 'br'],
    ['gzip, deflate, br', 'br'],
    ['br;q=0, gzip', 'gzip'],
    ['gzip', 'gzip'],
    ['*', 'br'],
    ['br;q=0, *', 'gzip'],
    ['*;q=0', undefined],
    ['identity', undefined],
    ['', undefined],
    // The coding weighted highest wins; brotli only on a tie.
    ['gzip;q=1, br;q=0.5', 'gzip'],
    ['br;q=0.001', 'br'],
    ['x-gzip', 'gzip'],
    // Whitespace around a weight, and malformed weights, which accept nothing.
    ['br; q = 0, gzip', 'gzip'],
    ['br;q=0x1', undefined],
    ['br;q=1e-9', undefined],
    ['br;q=1.5', undefined],
    ['br;q=0.5=1', undefined],
    // A repeated entry keeps its lowest weight, so a q=0 anywhere refuses.
    ['br;q=0, br;q=1', undefined],
    ['br;q=1, br;q=0, gzip', 'gzip'],
    ['*;q=1, *;q=0', undefined],
  ])('serves the encoding %j accepts: %s', async (accept, coding) => {
    let length: string | undefined
    for (const method of ['GET', 'HEAD']) {
      const result = await http(port(), '/console/assets/app.js', method, {
        'accept-encoding': accept,
      })
      expect(result.status).toBe(200)
      expect(result.headers['content-encoding']).toBe(coding)
      expect(result.headers['content-type']).toMatch(/javascript/)
      security(result.headers, "'none'", [], ASSET_CACHE)
      expect(result.headers.vary).toBe('Accept-Encoding')
      if (method === 'HEAD') {
        expect(result.body).toBe('')
        // The same representation as GET's: the encoded copy's length, not the file's.
        expect(result.headers['content-length']).toBe(length)
        continue
      }
      expect(result.headers['content-length']).toBe(String(result.raw.length))
      length = result.headers['content-length']
      const decoded =
        coding === 'br'
          ? brotliDecompressSync(result.raw)
          : coding === 'gzip'
            ? gunzipSync(result.raw)
            : result.raw
      expect(decoded.toString()).toBe(APP_JS)
    }
  })

  it('serves an asset without a compressed copy as it is, and never a copy by its own name', async () => {
    const plain = await http(port(), '/console/assets/plain.css', 'GET', {
      'accept-encoding': 'br, gzip',
    })
    expect(plain.status).toBe(200)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body).toBe('body{}\n')
    security(plain.headers, "'none'", [], ASSET_CACHE)
    for (const path of [
      '/console/assets/app.js.br',
      '/console/assets/app.js.gz',
      // A trailing slash names no file, and renames no copy.
      '/console/assets/app.js.br/',
      '/console/assets/app.js.gz/',
      '/console/assets/app.js/',
      // Named in another case: a case-insensitive disk would otherwise find the copy.
      '/console/assets/app.js.BR',
    ]) {
      const copy = await http(port(), path)
      expect(copy.status, path).toBe(404)
      security(copy.headers)
    }
  })

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])(
    'refuses the %s method with protected headers and no business effect',
    async (method) => {
      const result = await http(port(), '/console/auth/claim-callback', method)
      expect(result.status).toBe(405)
      expect(result.headers.allow).toBe('GET, HEAD')
      security(result.headers)
    }
  )

  it.each([
    '/console/../outside.txt',
    '/console/%2e%2e/outside.txt',
    '/console/%252e%252e/outside.txt',
    '/console/%2foutside.txt',
    '/console/%5coutside.txt',
    '/console/a\\b',
    '/console/%00',
    '/console/%zz',
  ])('refuses raw traversal/encoding input before file access: %s', async (path) => {
    const result = await http(port(), path)
    expect(result.status).toBe(400)
    expect(result.body).not.toContain(CONTROL)
    security(result.headers)
    const head = await http(port(), path, 'HEAD')
    expect(head.status).toBe(400)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toBe(result.headers['content-type'])
    expect(head.headers['content-length']).toBe(result.headers['content-length'])
    security(head.headers)
  })

  it('refuses a symlink escaping the configured immutable dist root', async () => {
    const result = await http(port(), '/console/escape.txt')
    expect(result.status).toBe(403)
    expect(result.body).not.toContain(CONTROL)
    security(result.headers)
    const head = await http(port(), '/console/escape.txt', 'HEAD')
    expect(head.status).toBe(403)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toBe(result.headers['content-type'])
    expect(head.headers['content-length']).toBe(result.headers['content-length'])
    security(head.headers)
  })

  it('does not proxy absolute-form targets to even an owned loopback sink', async () => {
    let calls = 0
    const sink = createServer((_request, response) => {
      calls += 1
      response.end(CONTROL)
    })
    sink.listen(0, '127.0.0.1')
    await once(sink, 'listening')
    try {
      const address = sink.address()
      if (address === null || typeof address === 'string') throw new Error('Owned sink not bound')
      const result = await http(port(), `http://127.0.0.1:${address.port}/outside`)
      expect(result.status).toBe(400)
      expect(result.body).not.toContain(CONTROL)
      security(result.headers)
      const head = await http(port(), `http://127.0.0.1:${address.port}/outside`, 'HEAD')
      expect(head.status).toBe(400)
      expect(head.body).toBe('')
      security(head.headers)
      expect(calls).toBe(0)
    } finally {
      sink.close()
      await once(sink, 'close')
    }
  })

  it('keeps missing-index errors protected and emits no callback query/access logs', async () => {
    const empty = join(temporary, 'empty')
    await mkdir(empty)
    const other = await start(args(empty))
    try {
      const result = await http(other.port, '/console/auth/claim-callback?code=never-log-this')
      expect(result.status).toBe(404)
      security(result.headers)
      const head = await http(
        other.port,
        '/console/auth/claim-callback?code=never-log-this',
        'HEAD'
      )
      expect(head.status).toBe(404)
      expect(head.body).toBe('')
      expect(head.headers['content-type']).toBe(result.headers['content-type'])
      expect(head.headers['content-length']).toBe(result.headers['content-length'])
      security(head.headers)
      await stop(other)
      expect(other.output().stdout.trim().split('\n')).toHaveLength(1)
      expect(other.output().stderr).toBe('')
      expect(other.output().stdout).not.toContain('never-log-this')
    } finally {
      await stop(other)
    }
    if (running === undefined) throw new Error('New server interface not ready')
    await stop(running)
    expect(running?.output().stdout.trim().split('\n')).toHaveLength(1)
    expect(running?.output().stderr).toBe('')
  })

  it('accepts explicit root prefix and a trailing-slash origin without widening policy', async () => {
    const arguments_ = args(root)
    arguments_[arguments_.indexOf('--prefix') + 1] = '/'
    arguments_[arguments_.indexOf('--core-origin') + 1] = CORE + '/'
    const rootPrefix = await start(arguments_)
    try {
      const protectedDocument = await http(rootPrefix.port, '/claim/fixture-id/fixture-slug')
      expect(protectedDocument.status).toBe(200)
      expect(protectedDocument.body).toBe(INDEX)
      security(protectedDocument.headers)
      const ordinary = await http(rootPrefix.port, '/auth/callback?code=root-prefix-never-log')
      expect(ordinary.status).toBe(200)
      security(ordinary.headers, "'self'")
    } finally {
      await stop(rootPrefix)
    }
    expect(rootPrefix.output().stdout.trim().split('\n')).toHaveLength(1)
    expect(rootPrefix.output().stdout).not.toContain('root-prefix-never-log')
    expect(rootPrefix.output().stderr).toBe('')
  })

  it('names the hosts under a deeper matrix domain, staging, the same way', async () => {
    const staging = await start([...args(root).slice(0, -1), `staging.${MATRIX_DOMAIN}`])
    try {
      const document = await http(staging.port, '/console/acme-sa/home')
      expect(document.status).toBe(200)
      expect(directives(document.headers).get('connect-src')).toEqual([
        "'self'",
        CORE + '/api/v1/',
        PROVIDER + '/realms/',
        `https://*.staging.${MATRIX_DOMAIN}/.well-known/matrix/client`,
        `https://*.staging.${MATRIX_DOMAIN}/_matrix/`,
        `https://*.staging.${MATRIX_DOMAIN}/_kodera/rooms/token`,
        ...LIVEKIT_PATHS.map((path) => `wss://*.staging.${MATRIX_DOMAIN}${path}`),
      ])
    } finally {
      await stop(staging)
    }
  })

  const loopbackSources = (homeserver: string | null, liveKit: string | null) => [
    ...(homeserver === null ? [] : [`${homeserver}/_matrix/`, `${homeserver}/_kodera/rooms/token`]),
    ...(liveKit === null ? [] : LIVEKIT_PATHS.map((path) => `${liveKit}${path}`)),
  ]

  it.each([
    [['--homeserver-origin', LOOPBACK_HOMESERVER], loopbackSources(LOOPBACK_HOMESERVER, null)],
    [
      ['--homeserver-origin', 'http://localhost:8008/'],
      loopbackSources('http://localhost:8008', null),
    ],
    [['--homeserver-origin', 'https://[::1]:8448'], loopbackSources('https://[::1]:8448', null)],
    [['--livekit-origin', LOOPBACK_LIVEKIT], loopbackSources(null, LOOPBACK_LIVEKIT)],
    [['--livekit-origin', 'WS://localhost:7880'], loopbackSources(null, 'ws://localhost:7880')],
    [['--livekit-origin', 'ws://[::1]:7880'], loopbackSources(null, 'ws://[::1]:7880')],
    [
      ['--homeserver-origin', LOOPBACK_HOMESERVER, '--livekit-origin', LOOPBACK_LIVEKIT],
      loopbackSources(LOOPBACK_HOMESERVER, LOOPBACK_LIVEKIT),
    ],
  ])(
    'names the local stack %j in connect-src behind --allow-loopback, on its paths only',
    async (extra, expected) => {
      const withLoopback = await start([...args(root), '--allow-loopback', ...extra])
      try {
        const document = await http(withLoopback.port, '/console/acme-sa/home')
        expect(document.status).toBe(200)
        security(document.headers, "'none'", expected)
        const asset = await http(withLoopback.port, '/console/assets/app.js')
        security(asset.headers, "'none'", expected, ASSET_CACHE)
      } finally {
        await stop(withLoopback)
      }
    }
  )

  it.each([
    // No deployment names a homeserver or a LiveKit server: the matrix domain covers them.
    [
      'a loopback homeserver without --allow-loopback',
      ['--homeserver-origin', LOOPBACK_HOMESERVER],
    ],
    ['a loopback LiveKit without --allow-loopback', ['--livekit-origin', LOOPBACK_LIVEKIT]],
    [
      'two loopback origins without --allow-loopback',
      ['--livekit-origin', LOOPBACK_LIVEKIT, '--homeserver-origin', LOOPBACK_HOMESERVER],
    ],
    ...(
      [
        ['--homeserver-origin', 'https://matrix.acme-sa.fixture.test'],
        ['--homeserver-origin', 'http://matrix.acme-sa.fixture.test'],
        ['--homeserver-origin', 'http://127.0.0.2:8008'],
        ['--homeserver-origin', 'ws://127.0.0.1:8008'],
        ['--homeserver-origin', 'http://127.0.0.1:8008/_matrix'],
        ['--homeserver-origin', 'http://127.0.0.1:8008 https://elsewhere.test'],
        ['--homeserver-origin', 'http://127.0.0.1:8008;'],
        ['--livekit-origin', 'wss://rtc.acme-sa.fixture.test'],
        ['--livekit-origin', 'wss://127.0.0.1:7880'],
        ['--livekit-origin', 'https://rtc.acme-sa.fixture.test'],
        ['--livekit-origin', 'http://127.0.0.1:7880'],
        ['--livekit-origin', 'ws://rtc.acme-sa.fixture.test'],
        ['--livekit-origin', 'ws://127.0.0.2:7880'],
        ['--livekit-origin', 'wss://*.fixture.test'],
        ['--livekit-origin', 'ws://127.0.0.1:7880/rtc'],
        ['--livekit-origin', 'ws://127.0.0.1:7880?'],
        ['--livekit-origin', 'ws://user:password@127.0.0.1:7880'],
        ['--livekit-origin', 'ws://127.0.0.1:7880 wss://elsewhere.test'],
        ['--livekit-origin', 'ws://127.0.0.1:7880;'],
        ['--livekit-origin', ''],
        ['--livekit-origin', 'ws://'],
      ] as const
    ).map(
      ([flag, value]) =>
        [`${flag}=${value} even with --allow-loopback`, ['--allow-loopback', flag, value]] as [
          string,
          string[],
        ]
    ),
    ['a repeated --allow-loopback', ['--allow-loopback', '--allow-loopback']],
    // A flag that opens nothing is a deployment that carries it by mistake.
    ['--allow-loopback without a loopback origin', ['--allow-loopback']],
    [
      'a repeated LiveKit origin',
      [
        '--allow-loopback',
        '--livekit-origin',
        LOOPBACK_LIVEKIT,
        '--livekit-origin',
        LOOPBACK_LIVEKIT,
      ],
    ],
    ['a flag without its value', ['--allow-loopback', '--livekit-origin']],
    ['an unknown flag', ['--turn-origin', 'turns://turn.fixture.test']],
    ['a second matrix domain', ['--matrix-domain', 'other.fixture.test']],
    ['a host that is neither loopback nor every address', ['--host', '192.0.2.1']],
    ['a host name instead of an address', ['--host', 'localhost']],
    ['a repeated host', ['--host', '0.0.0.0', '--host', '0.0.0.0']],
  ])('refuses %s before listening', async (_label, extra) => {
    const invalid = child([...args(root), ...extra], 'configuration')
    const timer = setTimeout(() => invalid.child.kill('SIGKILL'), 3000)
    try {
      const terminal = await invalid.closed
      expect(terminal.error).toBeUndefined()
      expect(terminal.code).toBe(2)
      expect(terminal.signal).toBeNull()
      observed(invalid)
      expect(invalid.output().stdout).toBe('')
      expect(invalid.output().stderr.trim()).toBe('configuration-invalid')
    } finally {
      clearTimeout(timer)
      await stop(invalid)
    }
  })

  it('listens on every address only when a container asks for it with --host 0.0.0.0', async () => {
    const wide = child([...args(root), '--host', '0.0.0.0'])
    const timer = setTimeout(() => wide.child.kill('SIGKILL'), 3000)
    try {
      const [line] = (await once(wide.child.stdout, 'data')) as [Buffer]
      expect(JSON.parse(line.toString('utf8'))).toMatchObject({
        event: 'listening',
        host: '0.0.0.0',
      })
    } finally {
      clearTimeout(timer)
      await stop(wide)
    }
  })

  it.each([
    ['--port', ''],
    ['--port', '-1'],
    ['--port', '65536'],
    ['--port', '1.5'],
    ['--port', '0x10'],
    ['--port', ' 0'],
    ['--core-origin', 'http://core.fixture.test'],
    ['--core-origin', ''],
    ['--core-origin', 'https://'],
    ['--core-origin', 'https://user:password@core.fixture.test'],
    ['--core-origin', 'https://@core.fixture.test'],
    ['--core-origin', 'https:core.fixture.test'],
    ['--core-origin', 'https://core.fixture.test/other'],
    ['--core-origin', 'https://core.fixture.test?'],
    ['--core-origin', 'https://core.fixture.test#'],
    ['--core-origin', 'https://core.fixture.test/?'],
    ['--core-origin', 'https://core.fixture.test/#'],
    ['--core-origin', ' https://core.fixture.test'],
    ['--core-origin', 'https://core.fixture.test\\'],
    ['--core-origin', 'https://core.fixture.test\t'],
    ['--core-origin', 'https://core.fixture.test\n'],
    ['--core-origin', 'https://core.fixture.test\u0001'],
    ['--core-origin', 'https://core.fixture.test\u007f'],
    ['--core-origin', 'https://core.fixture.test\u0085'],
    ['--provider-origin', 'https://identity.fixture.test?query=1'],
    ['--provider-origin', 'https://identity.fixture.test#fragment'],
    ['--provider-origin', 'https://identity.fixture.test?'],
    ['--provider-origin', 'https://identity.fixture.test#'],
    ['--provider-origin', 'https://identity.fixture.test\\'],
    ['--provider-origin', 'https://identity.fixture.test\u0085'],
    ['--matrix-domain', ''],
    ['--matrix-domain', 'fixture'],
    ['--matrix-domain', 'https://kodera.fixture.test'],
    ['--matrix-domain', 'kodera.fixture.test:443'],
    ['--matrix-domain', '*.kodera.fixture.test'],
    ['--matrix-domain', 'kodera.fixture.test.'],
    ['--matrix-domain', '.kodera.fixture.test'],
    ['--matrix-domain', 'kodera..fixture.test'],
    ['--matrix-domain', 'Kodera.fixture.test'],
    ['--matrix-domain', '-kodera.fixture.test'],
    ['--matrix-domain', 'kodera-.fixture.test'],
    ['--matrix-domain', 'kodera_x.fixture.test'],
    ['--matrix-domain', 'kodera.fixture.test/_matrix'],
    ['--matrix-domain', 'kodera.fixture.test https://elsewhere.test'],
    ['--matrix-domain', 'kodera.fixture.test;'],
    ['--matrix-domain', 'kodera.fixture.test\n'],
    ['--matrix-domain', '127.0.0.1'],
    ['--matrix-domain', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`],
    ['--prefix', '/console/../other'],
    ['--prefix', '//console'],
    ['--prefix', ''],
    ['--prefix', '/console/'],
    ['--prefix', '/console?'],
    ['--prefix', '/console#'],
    ['--prefix', '/console%2fextra'],
    ['--prefix', '/console\t'],
    ['--claim-path', '/auth/callback'],
    ['--root', 'missing-fixture'],
  ])('fails before listen for malformed config %s=%s', async (flag, value) => {
    const arguments_ = args(root)
    const index = arguments_.indexOf(flag)
    expect(index).toBeGreaterThanOrEqual(0)
    arguments_[index + 1] = flag === '--root' ? join(temporary, value) : value
    const invalid = child(arguments_, 'configuration')
    const timer = setTimeout(() => invalid.child.kill('SIGKILL'), 3000)
    try {
      const terminal = await invalid.closed
      expect(terminal.error).toBeUndefined()
      expect(terminal.code).toBe(2)
      expect(terminal.signal).toBeNull()
      observed(invalid)
      expect(invalid.output().stdout).toBe('')
      expect(invalid.output().stderr.trim()).toBe('configuration-invalid')
    } finally {
      clearTimeout(timer)
      await stop(invalid)
    }
  })

  it.each([
    '--root',
    '--port',
    '--prefix',
    '--claim-path',
    '--core-origin',
    '--provider-origin',
    '--matrix-domain',
  ])('refuses missing required configuration %s before listening', async (flag) => {
    const arguments_ = args(root)
    const index = arguments_.indexOf(flag)
    expect(index).toBeGreaterThanOrEqual(0)
    arguments_.splice(index, 2)
    const invalid = child(arguments_, 'configuration')
    const timer = setTimeout(() => invalid.child.kill('SIGKILL'), 3000)
    try {
      const terminal = await invalid.closed
      expect(terminal.error).toBeUndefined()
      expect(terminal.code).toBe(2)
      expect(terminal.signal).toBeNull()
      observed(invalid)
      expect(invalid.output().stdout).toBe('')
      expect(invalid.output().stderr.trim()).toBe('configuration-invalid')
    } finally {
      clearTimeout(timer)
      await stop(invalid)
    }
  })
})

// Finite real-source controls. The production file is read and hash-checked only;
// each executable variant is an owned temporary exact copy, never a fake server.
const PRISTINE_SHA = 'c58931759c51608850cd1b1e154f2dfe44617a3e613889cfcf3dfed920e9983a'
type Scenario =
  | 'referrer'
  | 'directive'
  | 'callback'
  | 'symlink'
  | 'fallback'
  | 'method'
  | 'overflow'
  | 'exit'
  | 'error-headers'
  | 'document-cache'
interface Mutation {
  id: string
  scenario: Scenario
  from: string
  to: string
}
const MUTATIONS: readonly Mutation[] = [
  {
    id: 'M01-referrer',
    scenario: 'referrer',
    from: "    'Referrer-Policy': 'no-referrer',",
    to: "    'Referrer-Policy': 'unsafe-url',",
  },
  {
    id: 'M02-effective-script-override',
    scenario: 'directive',
    from: `    "script-src 'self'",`,
    to: `    "script-src 'self'",\n    "script-src-elem * 'unsafe-inline'",`,
  },
  {
    id: 'M03-protected-callback-framing',
    scenario: 'callback',
    from: "  const ordinaryCallback = path === '/auth/callback' && !within(path, config.claimPath)",
    to: "  const ordinaryCallback = path?.startsWith('/auth/') && !within(path, config.claimPath)",
  },
  {
    id: 'M04-symlink-containment',
    scenario: 'symlink',
    from: '      if (!insideRoot(root, path)) return { status: 403 }',
    to: '      // Finite mutation: omit ancestor containment refusal.',
  },
  {
    id: 'M05-missing-asset-fallback',
    scenario: 'fallback',
    from: "  if (found.status === 404 && !within(local, '/assets') && extname(local) === '') {",
    to: '  if (found.status === 404) {',
  },
  {
    id: 'M06-method-boundary',
    scenario: 'method',
    from: "  if (request.method !== 'GET' && request.method !== 'HEAD') {",
    to: '  if (false) {',
  },
  {
    id: 'M07-request-triggered-output-overflow',
    scenario: 'overflow',
    from: '  const serve = (request, response) => {',
    to: `  const serve = (request, response) => {
    if (request.url === '/console/claim/mutation/overflow') {
      response.once('finish', () => setTimeout(() => process.stdout.write('x'.repeat(16_385)), 25))
    }`,
  },
  {
    id: 'M08-request-triggered-early-exit',
    scenario: 'exit',
    from: '  const serve = (request, response) => {',
    to: `  const serve = (request, response) => {
    if (request.url === '/console/claim/mutation/exit') {
      response.once('finish', () => setTimeout(() => process.exit(17), 25))
    }`,
  },
  {
    id: 'M09-head-error-policy',
    scenario: 'error-headers',
    from: `function empty(response, config, path, status, extra = {}) {
  response.writeHead(status, {
    ...headers(config, path),`,
    to: `function empty(response, config, path, status, extra = {}) {
  response.writeHead(status, {
    ...(status === 404 ? {} : headers(config, path)),`,
  },
  {
    id: 'M10-document-cached-as-an-asset',
    scenario: 'document-cache',
    from: "  const asset = within(local, '/assets')",
    to: '  const asset = true',
  },
]

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function closedWithin(running: Pick<Running, 'closed'>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      running.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Mutation close observation deadline')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stopMutation(running: Running, expected: ReturnType<Running['observation']>) {
  let failure: unknown
  let cleanupFailure: unknown
  try {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.expectCleanup()
      running.child.kill('SIGTERM')
    }
    const terminal = await closedWithin(running)
    expect(terminal.error).toBeUndefined()
    expect(running.observation()).toEqual(expected)
  } catch (error) {
    failure = error
  } finally {
    try {
      if (running.child.exitCode === null && running.child.signalCode === null) {
        running.expectCleanup()
        running.child.kill('SIGKILL')
        await closedWithin(running)
      }
    } catch (cleanup) {
      cleanupFailure = cleanup
    }
  }
  if (failure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([failure, cleanupFailure], 'Mutation close and kill cleanup failed')
  if (cleanupFailure !== undefined) throw cleanupFailure
  if (failure !== undefined) throw failure
}

async function intendedFailure(assertion: () => void, tag: string) {
  let failure: unknown
  try {
    assertion()
  } catch (error) {
    failure = error
  }
  expect(failure, 'Mutation must reach the intended assertion').toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error('No intended assertion error')
  expect(failure.name).toBe('AssertionError')
  expect(failure.message).toContain(tag)
}

async function phase(script: string, root: string, mutation: Mutation, changed: boolean) {
  const running = await start(args(root), script)
  const expected = { stdoutOverflow: false, stderrOverflow: false, unexpectedTermination: false }
  let failure: unknown
  let cleanupFailure: unknown
  try {
    const path =
      mutation.scenario === 'symlink'
        ? '/console/escape.txt'
        : mutation.scenario === 'fallback' || mutation.scenario === 'error-headers'
          ? '/console/assets/missing.js'
          : mutation.scenario === 'callback'
            ? '/console/auth/claim-callback'
            : `/console/claim/mutation/${mutation.scenario}`
    const result = await http(
      running.port,
      path,
      mutation.scenario === 'method'
        ? 'POST'
        : mutation.scenario === 'error-headers'
          ? 'HEAD'
          : 'GET'
    )
    if (mutation.scenario === 'error-headers') {
      expect(result.status).toBe(404)
      expect(result.body).toBe('')
    }
    const tag = 'INTENDED_' + mutation.id
    const assertion = () => {
      if (mutation.scenario === 'symlink') expect(result.status, tag).toBe(403)
      else if (mutation.scenario === 'fallback') expect(result.status, tag).toBe(404)
      else if (mutation.scenario === 'method') expect(result.status, tag).toBe(405)
      else if (mutation.scenario === 'overflow' || mutation.scenario === 'exit') {
        expect(() => observed(running), tag).not.toThrow()
      } else expect(() => security(result.headers), tag).not.toThrow()
    }
    if (mutation.scenario === 'overflow' || mutation.scenario === 'exit') {
      // A completed real HTTP response is mandatory before observing an effect.
      // A request timeout/reset, readiness failure or cleanup error is not a kill.
      expect(result.status).toBe(200)
      expect(result.body).toBe(INDEX)
      security(result.headers)
      if (changed) {
        const terminal = await closedWithin(running)
        expect(terminal.error).toBeUndefined()
        if (mutation.scenario === 'overflow') {
          expect(terminal.signal).toBe('SIGKILL')
          expect(terminal.code).toBeNull()
          expected.stdoutOverflow = true
        } else {
          expect(terminal.code).toBe(17)
          expect(terminal.signal).toBeNull()
        }
        expected.unexpectedTermination = true
        expect(running.observation()).toEqual(expected)
      } else {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
        const alive = await http(running.port, '/console/claim/still/alive')
        expect(alive.status).toBe(200)
        observed(running)
      }
    } else if (changed) {
      // Confirm the selected unsafe effect separately, before challenging the guard.
      if (mutation.scenario === 'referrer')
        expect(result.headers['referrer-policy']).toBe('unsafe-url')
      else if (mutation.scenario === 'directive')
        expect(directives(result.headers).has('script-src-elem')).toBe(true)
      else if (mutation.scenario === 'callback')
        expect(directives(result.headers).get('frame-ancestors')).toEqual(["'self'"])
      else if (mutation.scenario === 'document-cache')
        expect(result.headers['cache-control']).toBe(ASSET_CACHE)
      else if (mutation.scenario === 'error-headers') {
        for (const field of [
          'referrer-policy',
          'cache-control',
          'x-content-type-options',
          'content-security-policy',
        ]) {
          expect(result.headers[field]).toBeUndefined()
        }
      } else {
        expect(result.status).toBe(200)
        expect(result.body).toBe(mutation.scenario === 'symlink' ? CONTROL : INDEX)
      }
    }
    if (changed) await intendedFailure(assertion, tag)
    else assertion()
  } catch (error) {
    failure = error
  } finally {
    try {
      await stopMutation(running, expected)
    } catch (cleanup) {
      cleanupFailure = cleanup
    }
  }
  if (failure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([failure, cleanupFailure], 'Mutation phase and cleanup failed')
  if (cleanupFailure !== undefined) throw cleanupFailure
  if (failure !== undefined) throw failure
  const output = running.output()
  expect(output.stderr).toBe('')
  if (mutation.scenario !== 'overflow' || !changed)
    expect(output.stdout.trim().split('\n')).toHaveLength(1)
}

describe('finite real-source serving mutation controls', { concurrent: false }, () => {
  for (const mutation of MUTATIONS) {
    it(
      mutation.id + ' reaches its intended guard with pristine before/after',
      { timeout: 40_000 },
      async () => {
        const source = await readFile(SCRIPT, 'utf8')
        expect(digest(source)).toBe(PRISTINE_SHA)
        expect(source.split(mutation.from)).toHaveLength(2)
        const variant = source.replace(mutation.from, mutation.to)
        expect(Buffer.byteLength(variant)).toBeLessThanOrEqual(65_536)
        const temporary = await mkdtemp(join(tmpdir(), 'console-serving-mutant-'))
        const root = join(temporary, 'dist')
        try {
          await mkdir(join(root, 'assets'), { recursive: true })
          await writeFile(join(root, 'index.html'), INDEX, { flag: 'wx' })
          await writeFile(join(temporary, 'outside.txt'), CONTROL, { flag: 'wx' })
          await symlink(join(temporary, 'outside.txt'), join(root, 'escape.txt'))
          let firstFailure: unknown
          try {
            for (const changed of [false, true]) {
              const executable = join(temporary, changed ? 'mutant.mjs' : 'pristine-before.mjs')
              const bytes = changed ? variant : source
              await writeFile(executable, bytes, { flag: 'wx' })
              expect(digest(await readFile(executable, 'utf8'))).toBe(digest(bytes))
              await phase(executable, root, mutation, changed)
            }
          } catch (error) {
            firstFailure = error
          }
          // Restoration evidence is attempted even if the mutant was not qualified.
          const after = join(temporary, 'pristine-after.mjs')
          await writeFile(after, source, { flag: 'wx' })
          try {
            await phase(after, root, mutation, false)
          } catch (error) {
            if (firstFailure !== undefined)
              throw new AggregateError([firstFailure, error], 'Mutation and pristine-after failed')
            throw error
          }
          if (firstFailure !== undefined) throw firstFailure
        } finally {
          try {
            expect(digest(await readFile(SCRIPT, 'utf8'))).toBe(PRISTINE_SHA)
          } finally {
            await rm(temporary, { recursive: true, force: true })
          }
        }
      }
    )
  }

  it(
    'bind-all single change is refused by the intact readiness guard; not a listener kill',
    { timeout: 40_000 },
    async () => {
      const source = await readFile(SCRIPT, 'utf8')
      expect(digest(source)).toBe(PRISTINE_SHA)
      const anchor = '  server.listen(config.port, config.host, () => {'
      expect(source.split(anchor)).toHaveLength(2)
      const temporary = await mkdtemp(join(tmpdir(), 'console-serving-bind-guard-'))
      const root = join(temporary, 'dist')
      try {
        await mkdir(root)
        await writeFile(join(root, 'index.html'), INDEX, { flag: 'wx' })
        const baseline = MUTATIONS[0]
        if (baseline === undefined) throw new Error('Pristine control missing')
        const before = join(temporary, 'pristine-before.mjs')
        await writeFile(before, source, { flag: 'wx' })
        await phase(before, root, baseline, false)
        let failure: unknown
        try {
          const variant = join(temporary, 'bind-all.mjs')
          await writeFile(
            variant,
            source.replace(anchor, "  server.listen(config.port, '0.0.0.0', () => {"),
            { flag: 'wx' }
          )
          const invalid = child(args(root), 'configuration', variant)
          try {
            const terminal = await closedWithin(invalid)
            expect(terminal.error).toBeUndefined()
            expect(terminal.code).toBe(2)
            expect(terminal.signal).toBeNull()
            expect(invalid.output().stdout).toBe('')
            expect(invalid.output().stderr).toBe('configuration-invalid\n')
            observed(invalid)
          } finally {
            await stop(invalid)
          }
        } catch (error) {
          failure = error
        }
        const after = join(temporary, 'pristine-after.mjs')
        await writeFile(after, source, { flag: 'wx' })
        try {
          await phase(after, root, baseline, false)
        } catch (error) {
          if (failure !== undefined)
            throw new AggregateError([failure, error], 'Bind refusal and pristine-after failed')
          throw error
        }
        if (failure !== undefined) throw failure
      } finally {
        try {
          expect(digest(await readFile(SCRIPT, 'utf8'))).toBe(PRISTINE_SHA)
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
    }
  )
})

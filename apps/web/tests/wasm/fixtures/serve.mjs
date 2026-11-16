import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const digest = (body) => crypto.createHash('sha256').update(body).digest('hex')
const need = (value) => { if (!value) throw new Error('Fixture') }
const CSP = "default-src 'none'; script-src 'self'; script-src-attr 'none'; worker-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
const WASM_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")

export async function startFixture() {
  const root = process.env.WASM_PROOF_ROOT
  need(root && path.isAbsolute(root) && fs.realpathSync(root) === root)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifact-manifest.json'), 'utf8'))
  need(manifest.schema === 'wasm-device-proof-v1' && Array.isArray(manifest.files) && manifest.files.length <= 128)
  const routes = new Map()
  const add = (route, filename, expected, cap) => {
    need(!routes.has(route) && fs.realpathSync(filename) === filename && fs.lstatSync(filename).isFile())
    const body = fs.readFileSync(filename)
    need(body.length <= cap && (!expected || digest(body) === expected))
    routes.set(route, { filename, hash: digest(body), bytes: body.length })
  }
  for (const item of manifest.files) {
    need(typeof item.path === 'string' && !item.path.split('/').some((part) => ['', '.', '..'].includes(part)) &&
      !item.path.includes('\\') && !item.path.includes('%'))
    if (item.path.endsWith('.d.ts')) continue
    need(item.path === 'kodera_rs.js' || item.path === 'kodera_rs_bg.wasm' ||
      item.path.startsWith('snippets/') && item.path.endsWith('.js'))
    add('/native/' + item.path, path.join(root, 'generated', item.path), item.sha256, item.path.endsWith('.wasm') ? 32 * 1024 * 1024 : 2 * 1024 * 1024)
  }
  for (const name of ['client.mjs', 'actor.worker.mjs', 'host-adapter.mjs', 'mutant.worker.mjs'])
    add('/fixture/' + name, path.join(here, name), null, 128 * 1024)
  const abi = JSON.parse(fs.readFileSync(path.join(root, 'semantic-abi.json'), 'utf8'))
  need(abi.schema === 'wasm-device-abi-v1' && abi.declarationRemovalMutantRefused === true)
  add('/storage/local-state.js', path.join(root, 'local-state.js'), abi.compiledStorageSha256, 128 * 1024)
  need(abi.httpDeclarationRemovalMutantRefused === true && abi.httpHostOracleOnly === true &&
    Array.isArray(abi.compiledTransport) && abi.compiledTransport.length === 3 &&
    new Set(abi.compiledTransport.map((row) => row.name)).size === 3)
  const aliases = { 'local-state': [], 'device-http-record': [], 'device-cas-host': ['./local-state', './device-http-record'] }
  for (const row of abi.compiledTransport) {
    need(Object.hasOwn(aliases, row.name) && JSON.stringify([...row.imports].sort()) === JSON.stringify([...aliases[row.name]].sort()))
    if (row.name === 'local-state') need(row.compiledSha256 === abi.compiledStorageSha256)
    else add('/storage/' + row.name + '.js', path.join(root, row.name + '.js'), row.compiledSha256, 128 * 1024)
    if (row.name !== 'device-cas-host') add('/storage/' + row.name, path.join(root, row.name + '.js'), row.compiledSha256, 128 * 1024)
  }
  const httpInventoryBody = fs.readFileSync(path.join(here, '../http-cases.json'))
  need(httpInventoryBody.length <= 8192 && digest(httpInventoryBody) === abi.httpInventorySha256)
  const httpInventory = JSON.parse(httpInventoryBody.toString('utf8'))
  need(Object.keys(httpInventory).sort().join(',') === 'cases,hostOracleOnly,schema' &&
    httpInventory.schema === 'wasm-device-http-host-oracle-v1' && httpInventory.hostOracleOnly === true &&
    Array.isArray(httpInventory.cases) && httpInventory.cases.length === 35 && new Set(httpInventory.cases).size === 35)
  for (const name of ['http-client.mjs', 'http-host-adapter.mjs']) {
    const row = abi.httpFixtureSources?.filter((entry) => entry.path === 'fixtures/' + name)
    need(row?.length === 1)
    add('/fixture/' + name, path.join(here, name), row[0].sha256, 128 * 1024)
  }
  add('/native/mutant-kodera_rs.js', path.join(root, 'mutant-kodera_rs.js'), abi.mutantGlueSha256, 2 * 1024 * 1024)
  const sockets = new Set()
  let controlOrigin, requests = 0
  const handler = (control) => (request, response) => {
    try {
      need(++requests <= 2048 && sockets.size <= 32 && request.method === 'GET' && typeof request.url === 'string' && request.url.length <= 512)
      const url = new URL(request.url, 'http://127.0.0.1')
      const worker = ['/fixture/actor.worker.mjs', '/fixture/mutant.worker.mjs', '/fixture/http-host-adapter.mjs'].includes(url.pathname)
      const headers = { 'Content-Security-Policy': worker || control ? WASM_CSP : CSP,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin' }
      if (url.pathname === '/') {
        const keys = [...url.searchParams.keys()], httpCase = url.searchParams.get('httpCase')
        if (httpCase !== null) need(!control && keys.length === 1 && keys[0] === 'httpCase' && httpInventory.cases.includes(httpCase))
        else need(keys.every((key) => key === 'case'))
        const body = '<!doctype html><meta charset="utf-8"><meta name="control-origin" content="' + controlOrigin +
          '"><title>Device component proof</title><output data-phase="pending"></output><script type="module" src="/fixture/' +
          (httpCase === null ? 'client.mjs' : 'http-client.mjs') + '"></script>'
        response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); return
      }
      need(!url.search && !url.hash)
      if (control && url.pathname === '/fixture/cross-origin.worker.mjs') {
        response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); response.end('postMessage(1)'); return
      }
      const record = routes.get(url.pathname)
      need(record)
      const body = fs.readFileSync(record.filename)
      need(body.length === record.bytes && digest(body) === record.hash)
      response.writeHead(200, { ...headers, 'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8' })
      response.end(body)
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('refused') }
  }
  const servers = [http.createServer(handler(false)), http.createServer(handler(true))]
  for (const server of servers) { server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000 }
  try {
    for (const server of servers) {
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    }
  } catch {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))))
    throw new Error('Fixture')
  }
  const origin = 'http://127.0.0.1:' + servers[0].address().port
  controlOrigin = 'http://127.0.0.1:' + servers[1].address().port
  return Object.freeze({ origin, controlOrigin, async close() {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))))
  } })
}

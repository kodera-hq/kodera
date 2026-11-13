/** Private, mutually authenticated transformation port; no request logging. */
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { work } from './worker.mjs'
import { Refused } from './engine.mjs'
const MAX_RPC = 8 * 1024 * 1024
export function requestMac(key, timestamp, body) {
  return createHmac('sha256', key).update('kodera-transform:v1\n' + timestamp + '\n').update(body).digest('hex')
}
export function responseMac(key, requestSignature, body) {
  return createHmac('sha256', key).update('kodera-transform-response:v1\n' + requestSignature + '\n').update(body).digest('hex')
}
export function createTransformServer(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('application key required')
  const server = createServer({maxHeaderSize: 8192, requestTimeout: 6000, headersTimeout: 5000, keepAliveTimeout: 1000}, async (request, response) => {
    if (request.method === 'GET' && request.url === '/health/live') {
      response.writeHead(200, {'Content-Type': 'application/json'}).end('{"status":"ok"}')
      return
    }
    if (request.method !== 'POST' || request.url !== '/internal/transform' || request.headers['content-type'] !== 'application/json') {
      response.writeHead(404).end()
      return
    }
    let signature
    function answer(status, value) {
      const bytes = Buffer.from(JSON.stringify(value))
      if (response.destroyed) return
      const headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}
      if (signature) headers['X-Kodera-Mac'] = responseMac(key, signature, bytes)
      response.writeHead(status, headers).end(bytes)
    }
    const timeout = setTimeout(() => request.destroy(), 5000)
    try {
      const timestamp = request.headers['x-kodera-time'], supplied = request.headers.authorization
      if (typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp) || String(Number(timestamp)) !== timestamp ||
          Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 5 || typeof supplied !== 'string' || !/^KoderaTransform [a-f0-9]{64}$/.test(supplied)) {
        answer(401, {error: 'request refused'});return
      }
      let total = 0
      const chunks = []
      for await (const chunk of request) {
        total += chunk.length
        if (total > MAX_RPC) { answer(413, {error: 'request refused'});return }
        chunks.push(chunk)
      }
      clearTimeout(timeout)
      const bytes = Buffer.concat(chunks)
      const candidate = supplied.slice('KoderaTransform '.length)
      const expected = requestMac(key, timestamp, bytes)
      if (!timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'))) { answer(401, {error: 'request refused'});return }
      signature = candidate
      let body
      try { body = JSON.parse(bytes.toString('utf8')) } catch { answer(422, {error: 'invalid document'});return }
      try { answer(200, await work(body)) }
      catch (error) { answer(error instanceof Refused ? 422 : 503, {error: error instanceof Refused ? 'invalid document' : 'service unavailable'}) }
    } catch { answer(400, {error: 'request refused'}) }
    finally { clearTimeout(timeout) }
  })
  server.on('clientError', (_error, socket) => { socket.destroy() })
  return server
}

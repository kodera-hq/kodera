import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createTransformServer, requestMac, responseMac } from '../transform-http.mjs'
import { work } from '../worker.mjs'

function request(markdown = '# Example\n\nNative blocks\n') {
  return {operation: 'replace', snapshot: '', updates: [], nonce: randomUUID(), markdown}
}

test('worker returns a bounded canonical binary state and refuses malformed input', async () => {
  const result = await work(request())
  assert.match(result.markdown, /Native blocks/)
  assert.ok(Buffer.from(result.snapshot, 'base64').length > 0)
  await assert.rejects(work({...request(), extra: 'unsupported'}), /invalid document state/)
})

test('private transform HTTP authenticates both directions against the exact request bytes', async () => {
  const key = randomBytes(32)
  const server = createTransformServer(key)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  try {
    const body = JSON.stringify(request())
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = requestMac(key, timestamp, Buffer.from(body))
    const headers = {'Content-Type': 'application/json', 'X-Kodera-Time': timestamp, Authorization: 'KoderaTransform ' + signature}
    const response = await fetch(origin + '/internal/transform', {method: 'POST', headers, body})
    const raw = Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-kodera-mac'), responseMac(key, signature, raw))
    assert.match(JSON.parse(raw).markdown, /Native blocks/)
    const anonymous = await fetch(origin + '/internal/transform', {method: 'POST', headers: {'Content-Type': 'application/json'}, body})
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.headers.get('x-kodera-mac'), null)
    const forged = await fetch(origin + '/internal/transform', {method: 'POST', headers, body: body + ' '})
    assert.equal(forged.status, 401)
    assert.equal(forged.headers.get('x-kodera-mac'), null)
    const expired = await fetch(origin + '/internal/transform', {method: 'POST', headers: {...headers, 'X-Kodera-Time': String(Number(timestamp) - 60)}, body})
    assert.equal(expired.status, 401)
    assert.equal((await fetch(origin + '/internal/transform')).status, 404)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

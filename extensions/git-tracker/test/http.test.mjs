import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeHandler } from '../src/http.mjs';

async function request({ body = [Buffer.from('{}')], method = 'POST', headers = { 'content-type': 'application/json' }, receive = async () => ({ status: 'queued' }) } = {}) {
  let status, value;
  const incoming = { method, headers, async *[Symbol.asyncIterator]() { yield* body; } };
  const response = { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } };
  await createNodeHandler({ receive })(incoming, response);
  return { status, value };
}

test('HTTP adapter preserves exact byte chunks and only acknowledges durable acceptance', async () => {
  const result = await request({ body: [Buffer.from('{'), Buffer.from('}')], receive: async ({ rawBody }) => { assert.deepEqual(rawBody, Buffer.from('{}')); return { status: 'queued' }; } });
  assert.equal(result.status, 202);
  assert.equal((await request({ receive: async () => ({ status: 'duplicate' }) })).status, 200);
});

test('HTTP bounds, encoding and methods reject before verification', async () => {
  const receive = async () => { assert.fail('must not verify an invalid transport'); };
  assert.equal((await request({ receive, method: 'GET' })).status, 405);
  assert.equal((await request({ receive, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request({ receive, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await request({ receive, body: [Buffer.alloc(1_048_577)] })).status, 413);
});

for (const [code, status] of [['INVALID_SIGNATURE', 401], ['INVALID_BODY', 400], ['REPLAY_STORE_FULL', 503], ['DATABASE_UNAVAILABLE', 503]]) {
  test(`HTTP ${code} emits safe status and no diagnostics`, async () => {
    const result = await request({ receive: async () => { throw Object.assign(new Error('secret-private-diagnostic'), { code }); } });
    assert.equal(result.status, status);
    assert.doesNotMatch(JSON.stringify(result), /secret|diagnostic/);
  });
}

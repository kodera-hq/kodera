import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  DELIVERY_ID_HEADER, EVENT_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER,
  createWebhookHandler, createExtensionClient, createExtensionTestHarness, signWebhookPayload,
  validateEndpointUrl, verifyWebhookRequest,
} from '../src/index.mjs';
import { createQontoTreasuryWebhookHandler, maskIban, sanitizeTreasuryText } from '../../../extensions/qonto-treasury-feed/index.mjs';

const SECRET = 'whsec_local_audit_fixture_0123456789abcdef';
const NOW = 1_762_540_000;
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
const MAX_WEBHOOK_REPLAY_ENTRIES = 4096;

function request(body, id, now = NOW, timestamp = String(now)) {
  const payload = JSON.parse(body);
  if (payload.type === undefined && payload.event === undefined) body = JSON.stringify({ ...payload, type: 'message.created' });
  return {
    rawBody: body,
    nowUnixSeconds: now,
    headers: {
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signWebhookPayload(SECRET, now, body),
      [EVENT_HEADER]: 'message.created',
      ...(id === undefined ? {} : { [DELIVERY_ID_HEADER]: id }),
    },
  };
}
const refusal = (code) => (error) => error?.code === code;

for (const mutation of ['replace-id', 'remove-id', 'add-id', 'timestamp-alias']) {
  test(`authenticated transcript cannot replay by ${mutation}`, async () => {
    let effects = 0;
    const handler = createWebhookHandler({ secret: SECRET, onEvent: () => { effects++; } });
    const original = request('{"event":"message.created","value":1}', mutation === 'add-id' ? undefined : 'original');
    await handler(original);
    const replay = { ...original, headers: { ...original.headers } };
    if (mutation === 'replace-id' || mutation === 'add-id') replay.headers[DELIVERY_ID_HEADER] = 'replacement';
    if (mutation === 'remove-id') delete replay.headers[DELIVERY_ID_HEADER];
    if (mutation === 'timestamp-alias') {
      replay.headers[TIMESTAMP_HEADER] = '0' + String(NOW);
      delete replay.headers[DELIVERY_ID_HEADER];
    }
    let rejected;
    try { await handler(replay); } catch (error) { rejected = error; }
    assert.equal(effects, 1, 'an unsigned metadata change dispatched a second side effect');
    assert.ok(rejected, 'a replay must refuse even when its callback is otherwise harmless');
  });
}

test('parallel replays are admitted atomically before awaiting the callback', async () => {
  let effects = 0;
  const handler = createWebhookHandler({ secret: SECRET, onEvent: async () => {
    effects++;
    await new Promise((resolve) => setImmediate(resolve));
  } });
  const results = await Promise.allSettled([
    handler(request('{"value":1}', 'one')),
    handler(request('{"value":1}', 'two')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(effects, 1);
});

test('invalid signatures never reserve a delivery identifier', async () => {
  let effects = 0;
  const handler = createWebhookHandler({ secret: SECRET, onEvent: () => { effects++; } });
  const valid = request('{"value":1}', 'unused');
  const invalid = { ...valid, headers: { ...valid.headers, [SIGNATURE_HEADER]: 'v1=' + '0'.repeat(64) } };
  await assert.rejects(() => handler(invalid), refusal('SIGNATURE_MISMATCH'));
  await handler(valid);
  assert.equal(effects, 1);
});

test('bounded replay capacity refuses without evicting live signatures and recovers after expiry', async () => {
  let effects = 0;
  const handler = createWebhookHandler({ secret: SECRET, maxReplayEntries: 2, maxSkewSeconds: 30,
    onEvent: () => { effects++; } });
  await handler(request('{"value":1}', 'one'));
  await handler(request('{"value":2}', 'two'));
  await assert.rejects(() => handler(request('{"value":3}', 'three')), refusal('REPLAY_CAPACITY_EXCEEDED'));
  await assert.rejects(() => handler(request('{"value":1}', 'replacement')), refusal('REPLAY_DETECTED'));
  await assert.rejects(() => handler(request('{"value":4}', 'one')), refusal('REPLAY_DETECTED'));
  assert.equal(effects, 2);
  await handler(request('{"value":3}', 'three', NOW + 31));
  assert.equal(effects, 3);
  await assert.rejects(() => handler(request('{"value":9}', 'nine', NOW)), refusal('INVALID_CLOCK'));
});

test('clock, tolerance and replay capacity configuration fail closed', () => {
  const body = '{"event":"message.created"}';
  const signatureHeader = signWebhookPayload(SECRET, NOW, body);
  for (const now of [NaN, Infinity, -1, 0.5]) {
    assert.throws(() => verifyWebhookRequest({ secret: SECRET, rawBody: body, signatureHeader,
      timestampHeader: String(NOW), nowUnixSeconds: now }), refusal('INVALID_CLOCK'));
  }
  for (const skew of [NaN, Infinity, -1, 0.5, 301]) {
    assert.throws(() => createWebhookHandler({ secret: SECRET, maxSkewSeconds: skew }), refusal('INVALID_CLOCK'));
    assert.throws(() => verifyWebhookRequest({ secret: SECRET, rawBody: body, signatureHeader,
      timestampHeader: String(NOW), nowUnixSeconds: NOW, maxSkewSeconds: skew }), refusal('INVALID_CLOCK'));
  }
  for (const capacity of [0, -1, NaN, Infinity, 1.5, MAX_WEBHOOK_REPLAY_ENTRIES + 1]) {
    assert.throws(() => createWebhookHandler({ secret: SECRET, maxReplayEntries: capacity }), refusal('INVALID_REPLAY_CAPACITY'));
  }
});

test('delivery metadata is bounded without burning valid replacement requests', async () => {
  const handler = createWebhookHandler({ secret: SECRET });
  for (const id of ['', 'x'.repeat(256), 'bad\nheader']) {
    await assert.rejects(() => handler(request('{"value":1}', id)), refusal('INVALID_DELIVERY_ID'));
  }
  await handler(request('{"value":1}', 'valid'));
});

test('webhook bytes are bounded before signing and invalid UTF-8 refuses after authentication', () => {
  assert.throws(() => signWebhookPayload(SECRET, NOW, Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1)), refusal('BODY_TOO_LARGE'));
  const bytes = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const signatureHeader = signWebhookPayload(SECRET, NOW, bytes);
  assert.throws(() => verifyWebhookRequest({ secret: SECRET, rawBody: bytes, signatureHeader,
    timestampHeader: String(NOW), nowUnixSeconds: NOW }), refusal('INVALID_JSON'));
  for (const timestamp of [NaN, Infinity, -1, 1.5, '01']) {
    assert.throws(() => signWebhookPayload(SECRET, timestamp, '{}'), refusal('INVALID_TIMESTAMP'));
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

for (const redirectStatus of [302, 307]) {
  test(`real HTTP ${redirectStatus} redirect cannot cross the validated endpoint boundary`, async () => {
    let targetHits = 0;
    const target = createServer((_request, response) => {
      targetHits++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    let source;
    try {
      const targetOrigin = await listen(target);
      source = createServer((_request, response) => {
        response.writeHead(redirectStatus, { location: `${targetOrigin}/private-target` });
        response.end();
      });
      const sourceOrigin = await listen(source);
      // Only the transport is adapted to local listeners. SDK fetch options are
      // passed unchanged, and the public synthetic hostname is never resolved.
      const client = createExtensionClient({ baseUrl: 'https://api.example.invalid', token: 'fixture-token-only',
        fetchImpl: (url, init) => fetch(new URL(new URL(String(url)).pathname, sourceOrigin), init) });
      let rejected;
      try { await client.postChannelMessage({ channelId: 'channel', text: 'Local test' }); } catch (error) { rejected = error; }
      assert.equal(targetHits, 0, 'a redirect reached an endpoint the SDK never validated');
      assert.ok(rejected, 'the public endpoint redirect must refuse');
    } finally {
      if (source) await close(source);
      await close(target);
    }
  });
}

test('malformed endpoint diagnostics do not reflect credentials', () => {
  const sensitive = 'fixture-credential-only';
  assert.throws(() => validateEndpointUrl(`https://user:${sensitive}@[invalid`), (error) =>
    error.code === 'INVALID_URL' && !error.message.includes(sensitive));
});

test('treasury normalization cannot reconstruct an unmasked account after redaction', () => {
  const raw = 'FR7612345678901234567890189';
  for (const formatted of [
    'FR76 <b>1234</b> 5678 9012 3456 7890 189',
    'FR76 **1234** 5678 9012 3456 7890 189',
    'FR76 12\u000034 5678 9012 3456 7890 189',
  ]) {
    const output = sanitizeTreasuryText(formatted, 'Unavailable');
    assert.ok(output.includes('*'), 'normalization exposed an account without a mask');
    assert.ok(!output.replaceAll(' ', '').includes(raw));
    assert.ok(!output.includes('1234 5678 9012 3456 7890'));
  }
});

test('treasury account admission matches the 15..34 bound and rejects oversized or non-ASCII input', () => {
  assert.throws(() => maskIban('FR76' + '1'.repeat(10)), refusal('INVALID_IBAN'));
  assert.ok(maskIban('FR76' + '1'.repeat(11)).includes('*'));
  for (const bad of ['FR76' + '1'.repeat(31), ' '.repeat(129), 'FR76\u00a012345678901']) {
    assert.throws(() => maskIban(bad), refusal('INVALID_IBAN'));
  }
});

test('signed treasury delivery cannot post a normalized raw account in text or structured blocks', async () => {
  const raw = 'FR7612345678901234567890189';
  const handler = createQontoTreasuryWebhookHandler({ secret: SECRET });
  const harness = createExtensionTestHarness({ secret: SECRET, handler, nowSeconds: NOW });
  await harness.sendWebhook({ event: 'transfer.incoming', deliveryId: 'treasury-local-audit', payload: {
    transactionId: 'audit-synthetic', amountEur: 1, iban: raw,
    reference: 'FR76 <b>1234</b> 5678 9012 3456 7890 189',
    transactionUrl: 'https://app.qonto.com/transactions/synthetic',
  } });
  assert.equal(harness.recordedCalls.length, 1);
  const body = harness.recordedCalls[0].body;
  assert.ok(!JSON.stringify(body).replace(/\s+/g, '').includes(raw), 'a signed connector delivery posted an unmasked account');
  assert.ok(body.blocks[0].reference.includes('*'));
});


test('a tampered first event header cannot reroute or consume a signed delivery', async () => {
  let created = 0;
  let deleted = 0;
  const handler = createWebhookHandler({ secret: SECRET, handlers: {
    'message.created': () => { created++; }, 'message.deleted': () => { deleted++; },
  } });
  const original = request('{"type":"message.created","value":1}', 'event-bound');
  const tampered = { ...original, nowUnixSeconds: NOW + 10, headers: { ...original.headers, [EVENT_HEADER]: 'message.deleted' } };
  await assert.rejects(() => handler(tampered), refusal('INVALID_EVENT'));
  assert.equal(created + deleted, 0);
  await handler(original);
  assert.equal(created, 1);
  assert.equal(deleted, 0);
  const bodyOnly = request('{"type":"message.created","value":2}', 'body-only');
  delete bodyOnly.headers[EVENT_HEADER];
  await handler(bodyOnly);
  assert.equal(created, 2);
  assert.equal(deleted, 0);
});

test('header-only and conflicting signed event markers never dispatch', async () => {
  let effects = 0;
  const handler = createWebhookHandler({ secret: SECRET, onEvent: () => { effects++; } });
  for (const payload of [{ value: 1 }, { type: 'message.created', event: 'message.deleted' },
    { type: 3 }, { type: null, event: 'message.created' }]) {
    const rawBody = JSON.stringify(payload);
    const req = request('{"type":"message.created"}', 'invalid-event');
    req.rawBody = rawBody;
    req.headers[SIGNATURE_HEADER] = signWebhookPayload(SECRET, NOW, rawBody);
    await assert.rejects(() => handler(req), refusal('INVALID_EVENT'));
  }
  assert.equal(effects, 0);
});

test('treasury final redaction covers every canonical length, arbitrary groups and format controls', () => {
  for (let length = 15; length <= 34; length++) {
    const account = 'ZZ00' + '1'.repeat(length - 8) + '9876';
    for (const text of [account, account.match(/.{1,2}/g).join('-'),
      account.match(/.{1,2}/g).join(' '), account.match(/.{1,2}/g).join('\u00a0'), account.split('').join('-'), account.slice(0, 9) + '\u200b\ufeff' + account.slice(9)]) {
      const result = sanitizeTreasuryText(text, 'Unavailable');
      assert.ok(result.includes('*'), `length ${length} did not redact`);
      assert.ok(!result.replace(/[ -]/g, '').includes(account));
    }
  }
});


test('a refused replay cannot prune history and reopen it through clock rollback', async () => {
  let effects = 0;
  const handler = createWebhookHandler({ secret: SECRET, onEvent: () => { effects++; } });
  const old = request('{"type":"message.created","value":1}', 'old', 1000);
  const recent = request('{"type":"message.created","value":2}', 'recent', 1100);
  await handler(old);
  await handler(recent);
  await assert.rejects(() => handler({ ...recent, nowUnixSeconds: 1301 }), refusal('REPLAY_DETECTED'));
  await assert.rejects(() => handler({ ...old, nowUnixSeconds: 1200 }), refusal('INVALID_CLOCK'));
  assert.equal(effects, 2);
});

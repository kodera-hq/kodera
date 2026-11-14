import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRotatingWebhookVerifier, signWebhookPayload, verifyRotatingWebhookRequest, verifyWebhookRequest } from '../src/index.mjs';

const source = fileURLToPath(new URL('../../../apps/server', import.meta.url));
const python = process.env.KODERA_TEST_PYTHON ?? 'python3';
const script = `import json\nfrom uuid import UUID\nfrom datetime import datetime,UTC,timedelta\nfrom apps.extensions.wire import event_payload,signed_delivery\nn=datetime(2026,11,13,12,tzinfo=UTC)\nx=signed_delivery(organisation_id=UUID(int=1),installation_id=UUID(int=2),delivery_id=UUID(int=3),generation=UUID(int=4),event=event_payload('command.invoked',{'text':'hello'}),secret='synthetic-current-webhook-key-00000000',now=n,previous_generation=UUID(int=5),previous_secret='synthetic-previous-webhook-key-0000000',grace_expires_at=n+timedelta(hours=1))\nprint(json.dumps({'body':x.body.decode(),'headers':x.headers}))`;
const child = spawnSync(python, ['-c', script], { cwd: source, encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
assert.equal(child.status, 0, child.stderr);
const fixture = JSON.parse(child.stdout), headers = fixture.headers, body = JSON.parse(fixture.body);
const options = { rawBody: fixture.body, signatureHeader: headers['X-Kodera-Signature-256'],
  previousSignatureHeader: headers['X-Kodera-Previous-Signature-256'], timestampHeader: headers['X-Kodera-Timestamp'],
  eventHeader: headers['X-Kodera-Event'], deliveryIdHeader: headers['X-Kodera-Delivery-Id'],
  organisationId: body.organisation_id, installationId: body.installation_id,
  current: { generation: body.key_generation, secret: 'synthetic-current-webhook-key-00000000' },
  previous: { generation: body.previous_key_generation, secret: 'synthetic-previous-webhook-key-0000000', expiresAt: body.grace_expires_at },
  nowUnixSeconds: Number(headers['X-Kodera-Timestamp']) };

test('actual Python producer remains compatible with unchanged SDK v1', () => {
  assert.equal(verifyWebhookRequest({ ...options, secret: options.current.secret }).delivery_id, body.delivery_id);
});
test('current and bounded previous key verify the same signed installation scope', () => {
  assert.equal(verifyRotatingWebhookRequest(options).delivery_id, body.delivery_id);
  assert.equal(verifyRotatingWebhookRequest({ ...options, current: { generation: body.key_generation } }).delivery_id, body.delivery_id);
});
test('absolute grace rejects at equality and altered trusted expiry', () => {
  assert.throws(() => verifyRotatingWebhookRequest({ ...options, nowUnixSeconds: body.grace_expires_at }), /binding refused/);
  assert.throws(() => verifyRotatingWebhookRequest({ ...options, previous: { ...options.previous, expiresAt: body.grace_expires_at + 1 } }), /binding refused/);
});
test('unsigned headers and expected scope cannot override signed body', () => {
  for (const change of [{ organisationId: body.installation_id }, { installationId: body.organisation_id }, { eventHeader: 'message.created' }, { deliveryIdHeader: body.installation_id }, { current: { ...options.current, generation: body.installation_id } }, { rawBody: fixture.body.replace('hello', 'forged') }, { previousSignatureHeader: options.signatureHeader, current: { generation: body.key_generation } }])
    assert.throws(() => verifyRotatingWebhookRequest({ ...options, ...change }), /binding refused/);
});
test('reused delivery id rejects even when switching from old to current signature', () => {
  const verify = createRotatingWebhookVerifier({ organisationId: options.organisationId, installationId: options.installationId, current: options.current, previous: options.previous, nowUnixSeconds: options.nowUnixSeconds });
  verify(options);
  assert.throws(() => verify({ ...options, signatureHeader: 'v1=' + '0'.repeat(64) }), /binding refused/);
});

test('malformed signature syntax and oversized bodies refuse before parsing', () => {
  for (const change of [{ signatureHeader: options.signatureHeader + ',v1=bad' }, { previousSignatureHeader: 'bad' }, { rawBody: 'x'.repeat(128 * 1024 + 1) }])
    assert.throws(() => verifyRotatingWebhookRequest({ ...options, ...change }), /binding refused/);
});


function vector(deliveryId, timestamp, previousOnly = false) {
  const rawBody = JSON.stringify({ ...body, delivery_id: deliveryId });
  return { ...options, rawBody, deliveryIdHeader: deliveryId,
    signatureHeader: previousOnly ? 'v1=' + '0'.repeat(64) : signWebhookPayload(options.current.secret, timestamp, rawBody),
    previousSignatureHeader: signWebhookPayload(options.previous.secret, timestamp, rawBody),
    timestampHeader: String(timestamp), nowUnixSeconds: timestamp };
}
function receiver() {
  return createRotatingWebhookVerifier({ organisationId: options.organisationId,
    installationId: options.installationId, current: options.current, previous: options.previous });
}
const refusal = code => error => error.code === code;

test('previous-to-current delivery replay refuses after pruning and clock rollback', () => {
  const verify = receiver();
  const now = options.nowUnixSeconds;
  const first = vector('00000000-0000-0000-0000-000000000010', now, true);
  verify(first);
  verify(vector('00000000-0000-0000-0000-000000000011', now + 301));
  const replay = { ...first, signatureHeader: signWebhookPayload(options.current.secret, now, first.rawBody) };
  assert.throws(() => verify(replay), refusal('INVALID_CLOCK'));
});

test('refused rotating replay advances the verified clock before pruning', () => {
  const verify = receiver();
  const now = options.nowUnixSeconds;
  const old = vector('00000000-0000-0000-0000-000000000020', now, true);
  const recent = vector('00000000-0000-0000-0000-000000000021', now + 100);
  verify(old);
  verify(recent);
  assert.throws(() => verify({ ...recent, nowUnixSeconds: now + 301 }), refusal('ROTATION_REPLAY'));
  assert.throws(() => verify({ ...old, nowUnixSeconds: now + 200 }), refusal('INVALID_CLOCK'));
});

test('refused rotating capacity advances clock while unauthenticated requests cannot poison it', () => {
  const verify = receiver();
  const now = options.nowUnixSeconds;
  const first = vector('00000000-0000-0000-0000-000000000030', now, true);
  assert.throws(() => verify({ ...first, nowUnixSeconds: now + 200,
    signatureHeader: 'v1=' + '0'.repeat(64), previousSignatureHeader: 'v1=' + '0'.repeat(64) }), refusal('ROTATION_SIGNATURE'));
  verify(first);
  for (let index = 1; index < 4096; index++) {
    verify(vector('00000000-0000-0000-0001-' + index.toString(16).padStart(12, '0'), now));
  }
  assert.throws(() => verify(vector('00000000-0000-0000-0002-000000000001', now + 1)), refusal('ROTATION_REPLAY_CAPACITY'));
  assert.throws(() => verify({ ...first, signatureHeader: signWebhookPayload(options.current.secret, now, first.rawBody) }), refusal('INVALID_CLOCK'));
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRotatingWebhookVerifier, verifyRotatingWebhookRequest, verifyWebhookRequest } from '../src/index.mjs';

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

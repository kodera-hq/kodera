import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_EXTENSION_SCOPES,
  DEFAULT_TOLERANCE_SECONDS,
  DELIVERY_ID_HEADER,
  EVENT_HEADER,
  EXTENSION_EVENTS,
  EXTENSION_SCOPES,
  ExtensionSdkError,
  MANIFEST_SCHEMA_VERSION,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookVerificationError,
  createExtensionClient,
  createExtensionTestHarness,
  createWebhookHandler,
  defineSlashCommand,
  parseCommandInvocation,
  signWebhookPayload,
  validateEndpointUrl,
  validateManifest,
  verifyWebhookRequest,
  verifyWebhookSignature,
} from '../src/index.mjs';

const SECRET = 'whsec_test_kodera_0123456789abcdef';

test('verifies authentic webhook payload within replay window', () => {
  const now = 1_762_520_000;
  const body = JSON.stringify({ event: 'message.created', channelId: '019a5e10-0000-7000-8000-000000000001' });
  const sig = signWebhookPayload(SECRET, now - 10, body);
  const parsed = verifyWebhookRequest({
    secret: SECRET,
    rawBody: body,
    signatureHeader: sig,
    timestampHeader: String(now - 10),
    nowUnixSeconds: now,
  });
  assert.equal(parsed.event, 'message.created');

  const parsedViaAlias = verifyWebhookSignature({
    secret: SECRET,
    payload: body,
    signature: sig,
    timestamp: now - 10,
    nowSeconds: now,
    toleranceSeconds: DEFAULT_TOLERANCE_SECONDS,
  });
  assert.equal(parsedViaAlias.event, 'message.created');
  assert.deepEqual(EXTENSION_SCOPES, ALLOWED_EXTENSION_SCOPES);
  assert.ok(EXTENSION_EVENTS.includes('release.published'));
  assert.equal(EVENT_HEADER, 'x-kodera-event');
  assert.equal(DELIVERY_ID_HEADER, 'x-kodera-delivery-id');
});

test('rejects tampered payload and expired replay timestamps', () => {
  const now = 1_762_520_000;
  const body = JSON.stringify({ event: 'message.created' });
  const sig = signWebhookPayload(SECRET, now, body);

  assert.throws(
    () =>
      verifyWebhookRequest({
        secret: SECRET,
        rawBody: JSON.stringify({ event: 'message.deleted' }),
        signatureHeader: sig,
        timestampHeader: String(now),
        nowUnixSeconds: now,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  assert.throws(
    () =>
      verifyWebhookRequest({
        secret: SECRET,
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: String(now),
        nowUnixSeconds: now + 900,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'TIMESTAMP_OUT_OF_RANGE'
  );
});

test('normalizes and freezes slash command definitions', async () => {
  const cmd = defineSlashCommand({
    name: '/incident',
    description: 'Open an incident room',
    handler: ({ args }) => ({ text: `Incident opened: ${args}`, ephemeral: false }),
  });
  assert.equal(cmd.name, 'incident');
  const res = await cmd.handler({ command: 'incident', args: 'DB latency', channelId: 'c1', actorId: 'u1' });
  assert.equal(res.text, 'Incident opened: DB latency');
});

test('validateEndpointUrl enforces HTTPS, forbids credentials, and blocks SSRF IPv4/IPv6 ranges', () => {
  assert.equal(
    validateEndpointUrl('https://extensions.kodera.io/webhooks/github'),
    'https://extensions.kodera.io/webhooks/github'
  );
  assert.equal(
    validateEndpointUrl('http://localhost:8787/webhook', { allowLocalhostHttp: true }),
    'http://localhost:8787/webhook'
  );
  assert.equal(
    validateEndpointUrl('http://127.0.0.1:4000/hook', { allowLocalhostHttp: true }),
    'http://127.0.0.1:4000/hook'
  );

  const ssrfVectors = [
    'http://extensions.kodera.io/webhooks/github',
    'ftp://extensions.kodera.io/file',
    'javascript:alert(1)',
    'https://admin:secret@extensions.kodera.io/hook',
    'https://localhost/hook',
    'https://sub.localhost/hook',
    'https://redis/hook',
    'https://metadata.internal/computeMetadata/v1/',
    'https://service.local/hook',
    'https://0.0.0.0/hook',
    'https://127.0.0.1/hook',
    'https://127.0.1.250/hook',
    'https://10.0.0.1/hook',
    'https://10.255.255.254/hook',
    'https://172.16.0.1/hook',
    'https://172.31.255.254/hook',
    'https://192.168.0.1/hook',
    'https://192.168.255.254/hook',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://100.64.0.1/hook',
    'https://100.127.255.254/hook',
    'https://[::1]/hook',
    'https://[::]/hook',
    'https://[fc00::1]/hook',
    'https://[fd12:3456:789a::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:169.254.169.254]/hook',
    'https://[::ffff:10.0.0.1]/hook',
    'https://[::ffff:172.16.0.1]/hook',
    'https://[::ffff:192.168.1.1]/hook',
    'https://[::ffff:100.64.0.1]/hook',
  ];

  for (const vector of ssrfVectors) {
    assert.throws(
      () => validateEndpointUrl(vector),
      (err) => err instanceof ExtensionSdkError,
      `Expected SSRF vector to be rejected: ${vector}`
    );
  }

  //Public IPv4 outside RFC1918/CGNAT/loopback should pass
  assert.equal(validateEndpointUrl('https://172.15.0.1/hook'), 'https://172.15.0.1/hook');
  assert.equal(validateEndpointUrl('https://172.32.0.1/hook'), 'https://172.32.0.1/hook');
});

test('validateEndpointUrl refuses IPv4-mapped, 6to4 and site-local IPv6 ranges', () => {
  const refusals = [
    // ::ffff:0:0/96 refused whole, a public IPv4 address included.
    ['https://[::ffff:8.8.8.8]/hook', '::ffff:0:0/96'],
    ['https://[::ffff:0:7f00:1]/hook', '::ffff:0:0:0/96'],
    // 2002::/16 carries an IPv4 address: 2002:7f00:1:: is 127.0.0.1's 6to4 prefix.
    ['https://[2002:7f00:1::1]/hook', '2002::/16'],
    ['https://[2002:808:808::1]/hook', '2002::/16'],
    ['https://[fec0::1]/hook', 'fec0::/10'],
    ['https://[feff:ffff::1]/hook', 'fec0::/10'],
  ];
  for (const [url, range] of refusals) {
    assert.throws(
      () => validateEndpointUrl(url),
      (err) =>
        err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP' && err.message.includes(range),
      `Expected ${url} to be refused as ${range}`
    );
  }
  // The neighbouring global ranges stay open.
  assert.equal(validateEndpointUrl('https://[2001:4860:4860::8888]/hook'), 'https://[2001:4860:4860::8888]/hook');
  assert.equal(validateEndpointUrl('https://[2003::1]/hook'), 'https://[2003::1]/hook');
  assert.equal(validateEndpointUrl('https://[fe7f::1]/hook'), 'https://[fe7f::1]/hook');
});

test('validateManifest validates schema and rejects SSRF webhookUrl by default', () => {
  const valid = validateManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: 'github-release-notifier',
    name: 'GitHub Release Notifier',
    version: '1.0.0',
    description: 'Publishes signed release cards to Kodera channels.',
    scopes: ['messages:write', 'webhooks:incoming'],
    events: ['release.published', 'ci.workflow_failed'],
    webhookUrl: 'https://extensions.kodera.io/github/webhook',
    commands: [{ name: '/release-status', description: 'Check latest release status' }],
  });

  assert.equal(valid.id, 'github-release-notifier');
  assert.equal(valid.commands[0].name, 'release-status');
  assert.ok(Object.isFrozen(valid));

  assert.throws(
    () =>
      validateManifest({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        id: 'ssrf-manifest',
        name: 'Bad Manifest',
        version: '1.0.0',
        description: 'Points webhook to cloud metadata IP',
        scopes: ['messages:write'],
        webhookUrl: 'https://169.254.169.254/latest/meta-data',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('parseCommandInvocation parses subcommands, flags, quotes, and guards against prototype pollution', () => {
  const parsed = parseCommandInvocation(
    '/deploy production --region=eu-west-1 --dry-run -v "service-api" v2.4.0'
  );
  assert.equal(parsed.command, 'deploy');
  assert.equal(parsed.subcommand, 'production');
  assert.deepEqual(parsed.args, ['service-api', 'v2.4.0']);
  assert.equal(Object.getPrototypeOf(parsed.flags), null);
  assert.equal(parsed.flags.region, 'eu-west-1');
  assert.equal(parsed.flags['dry-run'], true);
  assert.equal(parsed.flags.v, true);

  assert.throws(
    () => parseCommandInvocation('/deploy prod --__proto__=polluted'),
    (err) => err instanceof ExtensionSdkError && err.code === 'FORBIDDEN_FLAG_NAME'
  );
  assert.throws(
    () => parseCommandInvocation('/deploy prod --constructor=polluted'),
    (err) => err instanceof ExtensionSdkError && err.code === 'FORBIDDEN_FLAG_NAME'
  );
  assert.throws(
    () => parseCommandInvocation(`/deploy ${'a'.repeat(2100)}`),
    (err) => err instanceof ExtensionSdkError && err.code === 'COMMAND_INPUT_TOO_LONG'
  );
});

test('createExtensionClient enforces payload bounds, SSRF externalUrl checks, and headers', async () => {
  /** @type {Array<{ url: string, init: RequestInit | undefined }>} */
  const calls = [];
  const client = createExtensionClient({
    baseUrl: 'https://api.kodera.io',
    token: 'kdr_tok_1234567890abcdef',
    timeoutMs: 3000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, id: 'msg_01' }), { status: 200 });
    },
  });

  await client.postChannelMessage({
    channelId: 'chan_releases',
    text: 'Release v1.2.0 deployed',
    idempotencyKey: 'rel:v1.2.0',
  });
  await client.postThreadReply({
    channelId: 'chan_releases',
    threadRootId: 'msg_01',
    text: 'All smoke checks green',
    idempotencyKey: 'rel:v1.2.0:reply',
  });
  await client.postIncidentCard({
    channelId: 'chan_incidents',
    title: 'API Gateway Elevated 5xx',
    severity: 'critical',
    summary: 'EU-FR1 edge nodes reporting 4.2% HTTP 502 rate.',
    externalUrl: 'https://status.kodera.io/incidents/inc_42',
    status: 'open',
    idempotencyKey: 'inc:42:open',
  });

  assert.equal(calls.length, 3);
  const firstHeaders = /** @type {Record<string, string>} */ (calls[0].init?.headers);
  assert.equal(firstHeaders.authorization, 'Bearer kdr_tok_1234567890abcdef');
  assert.equal(firstHeaders['idempotency-key'], 'rel:v1.2.0');
  assert.equal(firstHeaders['user-agent'], 'kodera-extension-sdk/0.1.0');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);

  // Oversized text rejected
  await assert.rejects(
    () =>
      client.postChannelMessage({
        channelId: 'chan_releases',
        text: 'x'.repeat(4001),
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'PAYLOAD_TOO_LARGE'
  );

  // Invalid severity rejected
  await assert.rejects(
    () =>
      client.postIncidentCard({
        channelId: 'chan_incidents',
        title: 'Bad severity',
        // @ts-expect-error testing runtime rejection of invalid severity
        severity: 'catastrophic',
        summary: 'Summary',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_SEVERITY'
  );

  // Non-HTTPS or private IP externalUrl rejected
  await assert.rejects(
    () =>
      client.postIncidentCard({
        channelId: 'chan_incidents',
        title: 'SSRF external URL',
        severity: 'high',
        summary: 'Summary',
        externalUrl: 'http://169.254.169.254/latest/meta-data',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
});

test('createExtensionTestHarness and createWebhookHandler run end-to-end with replay detection', async () => {
  const handler = createWebhookHandler({
    secret: SECRET,
    handlers: {
      'release.published': async (payload, { client }) => {
        return client?.postChannelMessage({
          channelId: String(payload.channelId),
          text: `Shipped ${payload.tag}`,
          idempotencyKey: `release:${payload.tag}`,
        });
      },
    },
  });

  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_520_000,
  });

  const delivery = await harness.sendWebhook({
    event: 'release.published',
    deliveryId: 'deliv_unique_001',
    payload: {
      channelId: 'chan_eng',
      tag: 'v1.4.0',
    },
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].idempotencyKey, 'release:v1.4.0');
  assert.equal(harness.recordedCalls[0].body.text, 'Shipped v1.4.0');
  assert.equal(delivery.deliveryId, 'deliv_unique_001');

  // Replaying the exact same deliveryId within the tolerance window must throw REPLAY_DETECTED
  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'release.published',
        deliveryId: 'deliv_unique_001',
        payload: {
          channelId: 'chan_eng',
          tag: 'v1.4.0',
        },
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );
});

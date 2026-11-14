import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createSentryWebhookHandler,
  extensionManifest,
  formatSentryStackPreview,
  handleSentryCommand,
  sentryCommand,
  signSentryWebhookPayload,
} from '../index.mjs';

const SECRET = 'sentry_whsec_reference_secret_0123456789abcdef';

test('sentry manifest validates reverse-DNS id, scopes, and /sentry slash command', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.sentry');
  assert.equal(extensionManifest.slug, 'sentry');
  assert.equal(extensionManifest.webhookUrl, 'https://extensions.example.invalid/hooks/sentry');
  assert.equal(sentryCommand.name, 'sentry');
});

test('sentry & GlitchTip issue lifecycle (created, regressed, resolved, ignored) and sanitized culprit preview', async () => {
  const handler = createSentryWebhookHandler({
    secret: SECRET,
    instanceOrigin: 'https://glitchtip.ops.example.org',
    defaultChannelId: 'chan_errors',
  });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const alertBody = JSON.stringify({
    action: 'triggered',
    data: {
      event: {
        title: 'TypeError: Cannot read properties of null <script>x()</script>',
        level: 'fatal',
        environment: 'production',
        release: 'kodera-web@0.4.2',
        web_url: 'https://glitchtip.ops.example.org/kodera/issues/402',
        exception: {
          values: [
            {
              type: 'TypeError',
              stacktrace: {
                frames: [
                  { filename: 'node_modules/vendor/index.js', lineno: 12, function: 'run', in_app: false },
                  {
                    filename: '/Users/dev/project/src/session/tokenStore.ts?token=secret',
                    lineno: 88,
                    function: 'refreshSession',
                    in_app: true,
                  },
                ],
              },
            },
          ],
        },
      },
      issue: {
        shortId: 'KODERA-WEB-4A',
        userCount: 19,
        count: 53,
      },
    },
  });

  await handler({
    secret: SECRET,
    rawBody: alertBody,
    headers: {
      'sentry-hook-resource': 'event_alert',
      'sentry-hook-signature': signSentryWebhookPayload(SECRET, alertBody),
      'request-id': 'sentry_req_1',
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].path, '/api/v1/extensions/channels/chan_errors/incidents');
  assert.equal(harness.recordedCalls[0].body.severity, 'critical');
  const summary = String(harness.recordedCalls[0].body.summary);
  assert.ok(summary.includes('project/src/session/tokenStore.ts:88 in refreshSession'));
  assert.ok(!summary.includes('/Users/dev'));
  assert.ok(!summary.includes('token=secret'));
  assert.ok(summary.includes('Environment: production · Release: kodera-web@0.4.2 · Events: 53 · Users: 19'));

  // Resolved replies on existing issue thread
  const resolvedBody = JSON.stringify({
    action: 'resolved',
    actor: { name: 'Lours' },
    data: {
      issue: {
        shortId: 'KODERA-WEB-4A',
        title: 'TypeError: Cannot read properties of null',
        permalink: 'https://glitchtip.ops.example.org/kodera/issues/402',
      },
    },
  });

  await handler({
    secret: SECRET,
    rawBody: resolvedBody,
    headers: {
      'sentry-hook-resource': 'issue',
      'sentry-hook-signature': signSentryWebhookPayload(SECRET, resolvedBody),
      'request-id': 'sentry_req_2',
    },
    nowUnixSeconds: harness.getNow() + 10,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 2);
  assert.match(harness.recordedCalls[1].path, /\/threads\/msg_test_1\/replies$/);
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[ISSUE RESOLVED] **KODERA-WEB-4A**'));

  // Regressed & ignored
  const regressedBody = JSON.stringify({
    action: 'regressed',
    data: {
      issue: {
        shortId: 'KODERA-WEB-4B',
        title: 'WebSocket reconnect timeout',
        level: 'error',
        culprit: 'src/ws/client.ts',
        userCount: 4,
        count: 9,
        permalink: 'https://glitchtip.ops.example.org/kodera/issues/403',
      },
    },
  });
  await handler({
    secret: SECRET,
    rawBody: regressedBody,
    headers: {
      'sentry-hook-resource': 'issue',
      'sentry-hook-signature': signSentryWebhookPayload(SECRET, regressedBody),
      'request-id': 'sentry_req_3',
    },
    nowUnixSeconds: harness.getNow() + 15,
    client: harness.client,
  });

  const ignoredBody = JSON.stringify({
    action: 'ignored',
    data: {
      issue: {
        shortId: 'KODERA-WEB-4B',
        title: 'WebSocket reconnect timeout',
        permalink: 'https://glitchtip.ops.example.org/kodera/issues/403',
      },
    },
  });
  await handler({
    secret: SECRET,
    rawBody: ignoredBody,
    headers: {
      'sentry-hook-resource': 'issue',
      'sentry-hook-signature': signSentryWebhookPayload(SECRET, ignoredBody),
      'request-id': 'sentry_req_4',
    },
    nowUnixSeconds: harness.getNow() + 20,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 4);
  assert.ok(String(harness.recordedCalls[2].body.title).includes('[REGRESSED] KODERA-WEB-4B'));
  assert.ok(String(harness.recordedCalls[3].body.text).includes('[ISSUE IGNORED] **KODERA-WEB-4B**'));
});

test('sentry refuses forged Sentry-Hook-Signature, replays, and SSRF issue links', async () => {
  const handler = createSentryWebhookHandler({ secret: SECRET });
  const body = JSON.stringify({
    action: 'created',
    data: {
      issue: {
        shortId: 'KODERA-SRV-1',
        title: 'Database pool timeout',
        permalink: 'https://sentry.io/organizations/kodera/issues/1/',
      },
    },
  });
  const sig = signSentryWebhookPayload(SECRET, body);

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: `${body} `,
        headers: {
          'sentry-hook-resource': 'issue',
          'sentry-hook-signature': sig,
          'request-id': 'sentry_forged',
        },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  await handler({
    secret: SECRET,
    rawBody: body,
    headers: {
      'sentry-hook-resource': 'issue',
      'sentry-hook-signature': sig,
      'request-id': 'sentry_once',
    },
    nowUnixSeconds: 1_762_525_000,
  });

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: body,
        headers: {
          'sentry-hook-resource': 'issue',
          'sentry-hook-signature': sig,
          'request-id': 'sentry_twice',
        },
        nowUnixSeconds: 1_762_525_005,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // SSRF permalink inside payload is rejected by validateEndpointUrl
  const ssrfBody = JSON.stringify({
    action: 'created',
    data: {
      issue: {
        shortId: 'KODERA-SRV-2',
        title: 'SSRF attempt',
        permalink: 'http://127.0.0.1:9000/internal',
      },
    },
  });
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: ssrfBody,
        headers: {
          'sentry-hook-resource': 'issue',
          'sentry-hook-signature': signSentryWebhookPayload(SECRET, ssrfBody),
          'request-id': 'sentry_ssrf',
        },
        nowUnixSeconds: 1_762_525_010,
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
});

test('/sentry slash command and stack preview helper validate inputs', () => {
  assert.equal(handleSentryCommand({ args: '' }).subcommand, 'status');
  assert.equal(handleSentryCommand({ args: 'issues --project=kodera-server --env=staging' }).environment, 'staging');
  assert.equal(handleSentryCommand({ args: 'resolve --issue=KODERA-WEB-4A' }).issueId, 'KODERA-WEB-4A');
  assert.equal(handleSentryCommand({ args: 'ignore KODERA-WEB-4A' }).subcommand, 'ignore');
  assert.equal(formatSentryStackPreview({ culprit: '/home/alice/app/main.py' }), 'app/main.py');
});

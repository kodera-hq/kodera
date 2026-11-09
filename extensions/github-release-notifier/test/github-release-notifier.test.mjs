import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createReleaseNotifierWebhookHandler,
  extensionManifest,
  sanitizeReleaseNotes,
  validateReleaseTag,
} from '../src/index.mjs';

const SECRET = 'whsec_github_release_notifier_0123456789';

test('github-release-notifier manifest validates cleanly against kodera.extension.v1', () => {
  assert.equal(extensionManifest.id, 'github-release-notifier');
  assert.ok(extensionManifest.scopes.includes('messages:write'));
  assert.ok(extensionManifest.events.includes('release.published'));
});

test('publishes structured release card with sanitized markdown and deterministic idempotency key', async () => {
  const handler = createReleaseNotifierWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_releases',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_520_200,
  });

  await harness.sendWebhook({
    event: 'release.published',
    deliveryId: 'gh_deliv_101',
    payload: {
      repository: 'kodera-hq/kodera',
      tag: '1.4.2',
      author: 'zxxma',
      htmlUrl: 'https://github.com/kodera-hq/kodera/releases/tag/v1.4.2',
      body: '### Security Fixes\n<script>alert("xss")</script>\n- Upgraded TLS pinning\n- [Exploit](javascript:alert(1))',
    },
  });

  assert.equal(harness.recordedCalls.length, 1);
  const call = harness.recordedCalls[0];
  assert.equal(call.idempotencyKey, 'release:kodera-hq/kodera:v1.4.2');
  assert.equal(call.path, '/api/v1/extensions/channels/chan_releases/messages');
  assert.ok(!String(call.body.text).includes('<script>'));
  assert.ok(!String(call.body.text).includes('javascript:alert'));
  assert.ok(String(call.body.text).includes('kodera-hq/kodera v1.4.2'));
});

test('publishes CI workflow failure alert and rejects SSRF or invalid tags', async () => {
  const handler = createReleaseNotifierWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_ci_alerts',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_520_300,
  });

  await harness.sendWebhook({
    event: 'ci.workflow_failed',
    deliveryId: 'gh_deliv_202',
    payload: {
      repository: 'kodera-hq/kodera',
      workflow: 'ci-security',
      branch: 'main',
      runId: '998877',
      runUrl: 'https://github.com/kodera-hq/kodera/actions/runs/998877',
      failureSummary: 'Cargo audit reported 1 advisory in transitive crate.',
    },
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].idempotencyKey, 'ci-failure:kodera-hq/kodera:998877');

  // Reject non-SemVer tag
  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'release.published',
        deliveryId: 'gh_deliv_bad_tag',
        payload: {
          repository: 'kodera-hq/kodera',
          tag: 'latest-branch-snapshot; rm -rf /',
        },
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_RELEASE_TAG'
  );

  // Reject SSRF htmlUrl pointing to cloud metadata
  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'release.published',
        deliveryId: 'gh_deliv_ssrf',
        payload: {
          repository: 'kodera-hq/kodera',
          tag: 'v1.5.0',
          htmlUrl: 'https://169.254.169.254/latest/meta-data/',
        },
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );

  // Reject replay of deliveryId gh_deliv_202
  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'ci.workflow_failed',
        deliveryId: 'gh_deliv_202',
        payload: {
          repository: 'kodera-hq/kodera',
          workflow: 'ci-security',
          runId: '998877',
        },
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );
});

test('supports /release-notes slash command invocation with flag parsing', async () => {
  const handler = createReleaseNotifierWebhookHandler({ secret: SECRET });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const { response } = await harness.sendWebhook({
    event: 'command.invoked',
    deliveryId: 'gh_cmd_1',
    payload: {
      args: 'v2.0.0-rc.1 --repo=kodera-hq/kodera --channel=releases',
      channelId: 'chan_eng',
      actorId: 'usr_zxxma',
    },
  });

  const res = /** @type {{ result: { text: string, ephemeral: boolean } }} */ (response);
  assert.ok(res.result.text.includes('kodera-hq/kodera@v2.0.0-rc.1'));
  assert.equal(validateReleaseTag('2.1.0'), 'v2.1.0');
  assert.equal(sanitizeReleaseNotes('<iframe src="evil"></iframe>Clean note'), 'Clean note');
});

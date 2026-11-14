import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  TELEMETRY_ENABLED,
  buildSelfHostedSummarizerRequest,
  createReleaseAssistantWebhookHandler,
  extensionManifest,
  formatBilingualReleaseNotes,
  handleReleaseAssistantCommand,
  signReleaseWebhookPayload,
  validateReleaseAssistantManifest,
  verifyReleaseWebhookSignature,
} from '../index.mjs';

const TEST_SECRET = 'whsec_release_assistant_secret_0123456789ab';

test('release-assistant manifest validates cleanly, disables telemetry, and rejects SSRF webhookUrl overrides', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.release-assistant');
  assert.equal(extensionManifest.slug, 'release-assistant');
  assert.equal(extensionManifest.commands[0].name, 'release-draft');
  assert.equal(TELEMETRY_ENABLED, false);

  assert.throws(
    () => validateReleaseAssistantManifest({ ...extensionManifest, webhookUrl: 'http://ollama.internal/hook' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
});

test('formatBilingualReleaseNotes deterministically groups conventional commits and PRs in French and English without any inference endpoint', () => {
  const result = formatBilingualReleaseNotes({
    versionTag: 'v2.4.0',
    repository: 'kodera-hq/kodera',
    locale: 'bilingual',
    commits: [
      'feat(voice)!: enforce TURN over TLS 1.3 only',
      'security(sdk): block IPv6 NAT64 SSRF addresses',
      'feat(studio): add SMPTE 29.97 drop-frame calculator',
      'fix(sync): prevent duplicate timeline pagination cursor <script>bad()</script>',
      'docs(ext): document per-room opt-in capability scope',
    ],
    pullRequests: [
      { number: 94, title: 'Add renderfarm Flamenco OOM card', labels: ['enhancement'] },
      { number: 95, title: 'Harden HMAC replay cache pruning', labels: ['security'] },
    ],
  });

  assert.equal(result.mode, 'deterministic');
  assert.equal(result.telemetryEnabled, false);
  assert.equal(result.counts.breaking, 1);
  assert.equal(result.counts.security, 2);
  assert.equal(result.counts.features, 2);
  assert.equal(result.counts.fixes, 1);
  assert.equal(result.counts.maintenance, 1);

  assert.ok(result.markdown.includes('### Notes de version (FR) — kodera-hq/kodera v2.4.0'));
  assert.ok(result.markdown.includes('**Changements majeurs**'));
  assert.ok(result.markdown.includes('**Sécurité**'));
  assert.ok(result.markdown.includes('### Release Notes (EN) — kodera-hq/kodera v2.4.0'));
  assert.ok(result.markdown.includes('**Breaking Changes**'));
  assert.ok(!result.markdown.includes('<script>'));
});

test('strict per-room opt-in scope and SSRF validation on optional self-hosted Ollama / vLLM HTTPS endpoints', async () => {
  // Non-opted-in room is refused before any request is constructed
  assert.throws(
    () =>
      buildSelfHostedSummarizerRequest({
        endpointUrl: 'https://inference.example.org/v1/chat/completions',
        channelId: 'chan_random',
        optInChannels: ['chan_releases'],
        versionTag: 'v2.4.0',
        deterministicDraft: 'Draft text',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'ROOM_NOT_OPTED_IN'
  );

  // SSRF vectors on self-hosted inference endpoint must be refused
  for (const badEndpoint of [
    'http://inference.example.org/v1/chat/completions',
    'https://127.0.0.1:11434/v1/chat/completions',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.10.0.12:8000/v1/chat/completions',
    'https://token:secret@inference.example.org/v1/chat/completions',
  ]) {
    assert.throws(
      () =>
        buildSelfHostedSummarizerRequest({
          endpointUrl: badEndpoint,
          channelId: 'chan_releases',
          optInChannels: ['chan_releases'],
          versionTag: 'v2.4.0',
          deterministicDraft: 'Draft text',
        }),
      (err) => err instanceof ExtensionSdkError,
      `Expected SSRF rejection for ${badEndpoint}`
    );
  }

  // Validated HTTPS self-hosted endpoint builds deterministic zero-telemetry request
  const reqDesc = buildSelfHostedSummarizerRequest({
    endpointUrl: 'https://inference.example.org/v1/chat/completions',
    modelId: 'self-hosted-summarizer-v1',
    channelId: 'chan_releases',
    optInChannels: ['chan_releases'],
    versionTag: 'v2.4.0',
    deterministicDraft: '### Release Notes',
  });
  assert.equal(reqDesc.url, 'https://inference.example.org/v1/chat/completions');
  assert.equal(reqDesc.headers['x-kodera-telemetry'], 'disabled');
  assert.equal(reqDesc.body.stream, false);
  assert.equal(reqDesc.telemetryEnabled, false);
});

test('webhook handler posts bilingual release card in opted-in room, refuses non-opted-in rooms, and supports /release-draft + /release-notes alias', async () => {
  const posted = [];
  const handler = createReleaseAssistantWebhookHandler({
    secret: TEST_SECRET,
    defaultChannelId: 'chan_releases',
    optInChannels: ['chan_releases'],
    inferenceEndpointUrl: 'https://inference.example.org/v1/chat/completions',
    client: {
      async postChannelMessage(msg) {
        const id = `msg_rel_${posted.length + 1}`;
        posted.push({ id, ...msg });
        return { id };
      },
    },
  });

  const validBody = JSON.stringify({
    type: 'release.published',
    channelId: 'chan_releases',
    repository: 'kodera-hq/kodera',
    versionTag: 'v2.5.0',
    commits: ['feat(connectors): ship studio and ops connectors'],
  });
  const sig = signReleaseWebhookPayload(TEST_SECRET, validBody);

  const res = await handler({
    rawBody: validBody,
    headers: { 'x-release-signature-256': sig, 'x-release-delivery': 'rel_deliv_1' },
    nowUnixSeconds: 1_763_160_000,
  });
  assert.equal(res.ok, true);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].text.includes('Notes de version (FR)'));
  assert.ok(posted[0].text.includes('Release Notes (EN)'));
  assert.equal(res.result.summarizerRequest.url, 'https://inference.example.org/v1/chat/completions');

  // Non-opted-in room webhook must be refused
  const blockedBody = JSON.stringify({
    type: 'release.published',
    channelId: 'chan_engineering_chat',
    repository: 'kodera-hq/kodera',
    versionTag: 'v2.5.1',
    commits: ['fix(core): patch timeout'],
  });
  await assert.rejects(
    () =>
      handler({
        rawBody: blockedBody,
        headers: {
          'x-release-signature-256': signReleaseWebhookPayload(TEST_SECRET, blockedBody),
          'x-release-delivery': 'rel_deliv_2',
        },
        nowUnixSeconds: 1_763_160_010,
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'ROOM_NOT_OPTED_IN'
  );

  // Forged signature rejected
  assert.throws(
    () =>
      verifyReleaseWebhookSignature({
        secret: TEST_SECRET,
        rawBody: validBody,
        signatureHeader: signReleaseWebhookPayload('whsec_forged_wrong_secret_000000000', validBody),
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  // Both /release-draft and /release-notes alias work in opted-in rooms, and draft fails in non-opted-in rooms
  const aliasRes = handleReleaseAssistantCommand({
    rawCommand: '/release-notes draft --tag=v2.5.0 --locale=fr',
    channelId: 'chan_releases',
    optInChannels: ['chan_releases'],
  });
  assert.equal(aliasRes.invokedAs, '/release-notes');
  assert.ok(aliasRes.text.includes('Notes de version (FR)'));

  assert.throws(
    () =>
      handleReleaseAssistantCommand({
        rawCommand: '/release-draft draft --tag=v2.5.0',
        channelId: 'chan_unlisted',
        optInChannels: ['chan_releases'],
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'ROOM_NOT_OPTED_IN'
  );

  // Conformance status invocation on arbitrary channel succeeds ephemerally without leaking or throwing
  const harness = createExtensionTestHarness({
    secret: TEST_SECRET,
    handler,
  });
  const statusRes = await harness.sendWebhook({
    event: 'command.invoked',
    payload: {
      type: 'command.invoked',
      command: 'release-draft',
      args: '',
      channelId: 'chan_conformance',
      actorId: 'usr_conformance',
    },
  });
  assert.equal(statusRes.response.result.subcommand, 'status');
  assert.equal(statusRes.response.result.roomOptedIn, false);
  assert.equal(statusRes.response.result.telemetryEnabled, false);
});

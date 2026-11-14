import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  computeDocsIdempotencyKey,
  createDocsCollabWebhookHandler,
  docPadCommand,
  extensionManifest,
  handleDocPadCommand,
  manifest,
  sanitizeDocText,
  validateDocsManifest,
} from '../index.mjs';
import '../../../packages/extension-sdk/test/conformance.test.mjs';

const SECRET = 'whsec_docs_collab_announcer_0123456789abcdef';

test('docs-collab-announcer manifest validates against kodera.extension.v1', () => {
  assert.equal(manifest.schema, 'kodera.extension.v1');
  assert.equal(manifest.schemaVersion, 'kodera.extension.v1');
  assert.equal(manifest.canonicalId, 'io.kodera.ext.docs-collab-announcer');
  assert.equal(extensionManifest.id, 'docs-collab-announcer');
  assert.equal(manifest.name, 'Docs Collaborative Pad Announcer');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.permissions, [
    'messages:write',
    'commands:register',
    'webhooks:incoming',
  ]);
  assert.equal(
    manifest.webhookUrl,
    'https://extensions.example.org/hooks/docs-collab-announcer'
  );
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].command, '/doc-pad');
  assert.equal(manifest.commands[0].name, 'doc-pad');

  // Rejects SSRF webhookUrl in manifest validation
  assert.throws(
    () =>
      validateDocsManifest({
        ...manifest,
        webhookUrl: 'https://169.254.169.254/latest/meta-data',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('handles signed document.created, document.published, and document.comment_resolved webhooks with sanitized French cards and deterministic idempotency keys', async () => {
  const handler = createDocsCollabWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_architecture',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_522_000,
  });

  // 1. document.created with untrusted HTML/markdown injection in title and author
  await harness.sendWebhook({
    event: 'document.created',
    deliveryId: 'docs_deliv_101',
    payload: {
      docId: 'pad-adr-0042',
      revision: 1,
      title: 'Architecture Espace <script>alert(1)</script> [click](javascript:evil())\r\nv2',
      author: 'zôÖma\n<iframe src="evil"></iframe>',
      documentUrl: 'https://docs.kodera.io/pads/pad-adr-0042',
    },
  });

  assert.equal(harness.recordedCalls.length, 1);
  const createdCall = harness.recordedCalls[0];
  assert.equal(createdCall.path, '/api/v1/extensions/channels/chan_architecture/messages');
  assert.equal(createdCall.idempotencyKey, 'docs:pad-adr-0042:document.created:1');
  assert.ok(String(createdCall.body.text).includes('[NOUVEAU PAD DOCS]'));
  assert.ok(String(createdCall.body.text).includes('Architecture Espace click v2'));
  assert.ok(!String(createdCall.body.text).includes('<script>'));
  assert.ok(!String(createdCall.body.text).includes('javascript:'));
  assert.ok(!String(createdCall.body.text).includes('<iframe'));

  // 2. document.published
  await harness.sendWebhook({
    event: 'document.published',
    deliveryId: 'docs_deliv_102',
    payload: {
      docId: 'pad-adr-0042',
      revision: 'r7',
      title: 'Architecture Espace v2',
      author: 'Lours',
      documentUrl: 'https://docs.kodera.io/pads/pad-adr-0042?rev=r7',
    },
  });

  assert.equal(harness.recordedCalls.length, 2);
  const publishedCall = harness.recordedCalls[1];
  assert.equal(publishedCall.idempotencyKey, 'docs:pad-adr-0042:document.published:r7');
  assert.ok(String(publishedCall.body.text).includes('[DOCUMENT PUBLIÉ]'));
  assert.ok(String(publishedCall.body.text).includes('publié par **Lours**'));

  // 3. document.comment_resolved
  await harness.sendWebhook({
    event: 'document.comment_resolved',
    deliveryId: 'docs_deliv_103',
    payload: {
      docId: 'pad-adr-0042',
      revision: 'r8',
      title: 'Architecture Espace v2',
      author: 'Miguel',
      commentSummary: 'Validation des en-têtes CSP et quotas WebSocket terminée.',
      documentUrl: 'https://docs.kodera.io/pads/pad-adr-0042#comment-19',
    },
  });

  assert.equal(harness.recordedCalls.length, 3);
  const resolvedCall = harness.recordedCalls[2];
  assert.equal(resolvedCall.idempotencyKey, 'docs:pad-adr-0042:document.comment_resolved:r8');
  assert.ok(String(resolvedCall.body.text).includes('[COMMENTAIRE RÉSOLU]'));
  assert.ok(String(resolvedCall.body.text).includes('Validation des en-têtes CSP'));
});

test('refuses SSRF documentUrl vectors (http://, 127.0.0.1, 169.254.169.254, RFC1918, embedded credentials) and rejects replay', async () => {
  const handler = createDocsCollabWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_securite',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_523_000,
  });

  const ssrfDocumentUrls = [
    { url: 'http://docs.kodera.io/pads/pad-1', expectedCode: 'SSRF_INSECURE_PROTOCOL' },
    { url: 'https://127.0.0.1/admin/config', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://169.254.169.254/latest/meta-data/', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://10.0.0.15/internal-pad', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://192.168.1.20/pad', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://user:pass@docs.kodera.io/pads/pad-1', expectedCode: 'SSRF_EMBEDDED_CREDENTIALS' },
  ];

  for (const [idx, vector] of ssrfDocumentUrls.entries()) {
    await assert.rejects(
      () =>
        harness.sendWebhook({
          event: 'document.created',
          deliveryId: `docs_ssrf_${idx}`,
          payload: {
            docId: 'pad-sec-01',
            revision: 1,
            title: 'Pad test SSRF',
            documentUrl: vector.url,
          },
        }),
      (err) => err instanceof ExtensionSdkError && err.code === vector.expectedCode,
      `Expected SSRF documentUrl "${vector.url}" to fail with ${vector.expectedCode}`
    );
  }

  assert.equal(harness.recordedCalls.length, 0, 'No outbound call may be emitted when documentUrl fails SSRF check');

  // Valid delivery followed by replay of same deliveryId -> REPLAY_DETECTED
  await harness.sendWebhook({
    event: 'document.published',
    deliveryId: 'docs_replay_check_1',
    payload: {
      docId: 'pad-sec-01',
      revision: 2,
      title: 'Politique de sécurité',
      documentUrl: 'https://docs.kodera.io/pads/pad-sec-01',
    },
  });
  assert.equal(harness.recordedCalls.length, 1);

  await assert.rejects(
    () =>
      harness.sendWebhook({
        event: 'document.published',
        deliveryId: 'docs_replay_check_1',
        payload: {
          docId: 'pad-sec-01',
          revision: 2,
          title: 'Politique de sécurité',
          documentUrl: 'https://docs.kodera.io/pads/pad-sec-01',
        },
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );
});

test('executes /doc-pad slash command (open, link, status) with --doc and --title flags via createExtensionTestHarness', async () => {
  const handler = createDocsCollabWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_produit',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_524_000,
  });

  // 1. /doc-pad open --doc=roadmap-q4 --title="Feuille de route Produit"
  const openRes = await harness.sendWebhook({
    event: 'command.invoked',
    deliveryId: 'docs_cmd_open',
    payload: {
      args: 'open --doc=roadmap-q4 --title="Feuille de route Produit"',
      channelId: 'chan_produit',
      actorId: 'usr_zxxma',
    },
  });
  const openResult = /** @type {{ result: { text: string, ephemeral: boolean, subcommand: string, docId: string, title: string, documentUrl: string } }} */ (
    openRes.response
  ).result;
  assert.equal(openResult.subcommand, 'open');
  assert.equal(openResult.docId, 'roadmap-q4');
  assert.equal(openResult.title, 'Feuille de route Produit');
  assert.equal(openResult.ephemeral, false);
  // Compare parsed URL components; a substring check would also accept
  // https://docs.kodera.io.evil.example/pads/roadmap-q4.
  const openedUrl = new URL(openResult.documentUrl);
  assert.equal(openedUrl.protocol, 'https:');
  assert.equal(openedUrl.origin, 'https://docs.kodera.io');
  assert.equal(openedUrl.pathname, '/pads/roadmap-q4');
  assert.ok(openResult.text.endsWith(openResult.documentUrl));

  // 2. /doc-pad link --doc=spec-visio --title="Spécification Visio"
  const linkRes = await harness.sendWebhook({
    event: 'command.invoked',
    deliveryId: 'docs_cmd_link',
    payload: {
      args: 'link --doc=spec-visio --title="Spécification Visio"',
      channelId: 'chan_produit',
      actorId: 'usr_lours',
    },
  });
  const linkResult = /** @type {{ result: { text: string, ephemeral: boolean, subcommand: string, docId: string } }} */ (
    linkRes.response
  ).result;
  assert.equal(linkResult.subcommand, 'link');
  assert.equal(linkResult.docId, 'spec-visio');
  assert.equal(linkResult.ephemeral, false);
  assert.ok(linkResult.text.includes('associé au salon'));

  // 3. /doc-pad status --doc=spec-visio
  const statusRes = await harness.sendWebhook({
    event: 'command.invoked',
    deliveryId: 'docs_cmd_status',
    payload: {
      args: 'status --doc=spec-visio',
      channelId: 'chan_produit',
      actorId: 'usr_lours',
    },
  });
  const statusResult = /** @type {{ result: { text: string, ephemeral: boolean, subcommand: string } }} */ (
    statusRes.response
  ).result;
  assert.equal(statusResult.subcommand, 'status');
  assert.equal(statusResult.ephemeral, true);
  assert.ok(statusResult.text.includes('synchronisé'));

  // Direct helper checks
  assert.equal(docPadCommand.name, 'doc-pad');
  assert.equal(computeDocsIdempotencyKey('pad-01', 'document.created', 3), 'docs:pad-01:document.created:3');
  assert.equal(sanitizeDocText('<b>Titre</b>\0\r\nPropre', 'Fallback'), 'Titre Propre');
  assert.throws(
    () => handleDocPadCommand({ rawCommand: '/doc-pad delete --doc=pad-01' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNSUPPORTED_DOC_SUBCOMMAND'
  );
});

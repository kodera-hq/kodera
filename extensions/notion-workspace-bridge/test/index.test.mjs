import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createNotionWorkspaceWebhookHandler,
  extensionManifest,
  handleNotionPageCommand,
  manifest,
  notionPageCommand,
  validateNotionManifest,
  validateNotionUrl,
} from '../index.mjs';

const SECRET = 'whsec_notion_workspace_bridge_0123456789abcdef';

test('notion-workspace-bridge manifest validates against kodera.extension.v1 and /notion-page', () => {
  assert.equal(manifest.schemaVersion, 'kodera.extension.v1');
  assert.equal(manifest.canonicalId, 'io.kodera.ext.notion-workspace-bridge');
  assert.equal(extensionManifest.id, 'notion-workspace-bridge');
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].command, '/notion-page');
  assert.equal(manifest.commands[0].name, 'notion-page');
  assert.equal(notionPageCommand.name, 'notion-page');

  assert.throws(
    () =>
      validateNotionManifest({
        ...manifest,
        webhookUrl: 'https://10.0.0.42/hooks/notion',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('shares and tracks Notion workspace pages and database entries alongside Docs and blocks SSRF URLs', async () => {
  const handler = createNotionWorkspaceWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_produit',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_532_000,
  });

  await harness.sendWebhook({
    event: 'page.shared',
    deliveryId: 'notion_deliv_1',
    payload: {
      pageId: 'page-okr-q4',
      title: 'Objectifs & Résultats Clés <script>evil()</script>',
      workspaceName: 'Kodera Produit',
      author: 'zôÖma',
      pageUrl: 'https://www.notion.so/kodera/page-okr-q4',
      docsCompanionUrl: 'https://docs.kodera.io/pads/page-okr-q4',
    },
  });

  await harness.sendWebhook({
    event: 'database.entry_synced',
    deliveryId: 'notion_deliv_2',
    payload: {
      pageId: 'db-item-42',
      title: 'Connecteur Qonto Trésorerie',
      databaseName: 'Backlog Connecteurs B2B',
      status: 'Livré',
      author: 'Lours',
      pageUrl: 'https://www.notion.so/kodera/db-item-42',
      docsCompanionUrl: 'https://docs.kodera.io/pads/db-item-42',
    },
  });

  assert.equal(harness.recordedCalls.length, 2);
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[NOTION PAGE PARTAGÉE]'));
  assert.ok(!String(harness.recordedCalls[0].body.text).includes('<script>'));
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[NOTION ENTRÉE BASE SYNCHRONISÉE]'));
  assert.ok(String(harness.recordedCalls[1].body.text).includes('Backlog Connecteurs B2B'));

  const cmdRes = handleNotionPageCommand({
    rawCommand: '/notion-page share --page=architecture-v2 --title="Architecture Souveraine" --database="ADR"',
    channelId: 'chan_produit',
    actorId: 'usr_zxxma',
  });
  assert.equal(cmdRes.pageId, 'architecture-v2');
  assert.equal(cmdRes.pageUrl, 'https://www.notion.so/kodera/architecture-v2');
  assert.equal(cmdRes.docsCompanionUrl, 'https://docs.kodera.io/pads/architecture-v2');

  assert.throws(
    () => validateNotionUrl('http://www.notion.so/kodera/insecure'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
  assert.throws(
    () => validateNotionUrl('https://169.254.169.254/latest/meta-data'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

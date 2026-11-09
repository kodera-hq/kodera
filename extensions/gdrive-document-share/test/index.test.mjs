import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  GDRIVE_ACCESS_MODES,
  createGdriveShareWebhookHandler,
  extensionManifest,
  gdriveShareCommand,
  handleGdriveShareCommand,
  manifest,
  normalizeGdriveAccessMode,
  validateGdriveManifest,
  validateGdriveUrl,
} from '../index.mjs';

const SECRET = 'whsec_gdrive_document_share_0123456789abcdef';

test('gdrive-document-share manifest validates against kodera.extension.v1 and /gdrive-share', () => {
  assert.equal(manifest.schemaVersion, 'kodera.extension.v1');
  assert.equal(manifest.canonicalId, 'io.kodera.ext.gdrive-document-share');
  assert.equal(extensionManifest.id, 'gdrive-document-share');
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].command, '/gdrive-share');
  assert.equal(manifest.commands[0].name, 'gdrive-share');
  assert.equal(gdriveShareCommand.name, 'gdrive-share');
  assert.deepEqual(GDRIVE_ACCESS_MODES, ['lecture', 'commentaire', 'édition']);

  assert.throws(
    () =>
      validateGdriveManifest({
        ...manifest,
        webhookUrl: 'https://192.168.1.50/hooks/gdrive',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('shares Google Drive files and folders with lecture, commentaire, and édition badges and blocks SSRF', async () => {
  const handler = createGdriveShareWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_projets',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_533_000,
  });

  await harness.sendWebhook({
    event: 'file.shared',
    deliveryId: 'gdrive_deliv_1',
    payload: {
      fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
      title: 'Contrat Cadre Prestataire.pdf',
      accessMode: 'lecture',
      sharedBy: 'David',
      url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view',
    },
  });

  await harness.sendWebhook({
    event: 'file.shared',
    deliveryId: 'gdrive_deliv_2',
    payload: {
      fileId: '1SpecSheetId002',
      title: 'Matrice de conformité RGPD',
      accessMode: 'commentaire',
      sharedBy: 'Miguel',
      url: 'https://docs.google.com/spreadsheets/d/1SpecSheetId002/edit',
    },
  });

  await harness.sendWebhook({
    event: 'folder.shared',
    deliveryId: 'gdrive_deliv_3',
    payload: {
      fileId: '1FolderLivrablesQ4',
      title: 'Livrables Clients B2B',
      accessMode: 'édition',
      sharedBy: 'zôÖma',
      url: 'https://drive.google.com/drive/folders/1FolderLivrablesQ4',
    },
  });

  assert.equal(harness.recordedCalls.length, 3);
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[ACCÈS : LECTURE]'));
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[ACCÈS : COMMENTAIRE]'));
  assert.ok(String(harness.recordedCalls[2].body.text).includes('[ACCÈS : ÉDITION]'));

  const cmdRes = handleGdriveShareCommand({
    rawCommand:
      '/gdrive-share édition --kind=folder --id=1FolderLivrablesQ4 --title="Dossier Architecture"',
    channelId: 'chan_projets',
    actorId: 'usr_zxxma',
  });
  assert.equal(cmdRes.accessMode, 'édition');
  assert.equal(cmdRes.accessBadge, '[ACCÈS : ÉDITION]');
  assert.equal(cmdRes.resourceUrl, 'https://drive.google.com/drive/folders/1FolderLivrablesQ4');

  assert.equal(normalizeGdriveAccessMode('read'), 'lecture');
  assert.equal(normalizeGdriveAccessMode('comment'), 'commentaire');
  assert.equal(normalizeGdriveAccessMode('edition'), 'édition');

  assert.throws(
    () => normalizeGdriveAccessMode('admin_root'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_GDRIVE_ACCESS_MODE'
  );
  assert.throws(
    () => validateGdriveUrl('http://drive.google.com/file/d/123/view'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
  assert.throws(
    () => validateGdriveUrl('https://169.254.169.254/latest/meta-data'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
  assert.throws(
    () => validateGdriveUrl('https://attacker.example.com/file/d/123'),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNTRUSTED_GDRIVE_HOST'
  );
});

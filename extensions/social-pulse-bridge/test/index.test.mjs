import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  SOCIAL_NETWORKS,
  createSocialPulseWebhookHandler,
  extensionManifest,
  handleSocialPostCommand,
  manifest,
  sanitizeSocialPostUrl,
  socialPostCommand,
  validateSocialManifest,
} from '../index.mjs';

const SECRET = 'whsec_social_pulse_bridge_0123456789abcdef';

test('social-pulse-bridge manifest validates against kodera.extension.v1 and /social-post', () => {
  assert.equal(manifest.schemaVersion, 'kodera.extension.v1');
  assert.equal(manifest.canonicalId, 'io.kodera.ext.social-pulse-bridge');
  assert.equal(extensionManifest.id, 'social-pulse-bridge');
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].command, '/social-post');
  assert.equal(manifest.commands[0].name, 'social-post');
  assert.equal(socialPostCommand.name, 'social-post');
  assert.deepEqual(SOCIAL_NETWORKS, ['x', 'mastodon', 'instagram']);

  assert.throws(
    () =>
      validateSocialManifest({
        ...manifest,
        webhookUrl: 'http://extensions.example.kodera.io/hooks/social-pulse-bridge',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
});

test('sanitizeSocialPostUrl supports X/Twitter, Mastodon/Fediverse, and Instagram while stripping utm_*, fbclid, twclid, and igsh', () => {
  // 1. X / Twitter
  const xCleaned = sanitizeSocialPostUrl(
    'https://x.com/kodera_io/status/185000000000001?utm_source=twitter&utm_medium=social&twclid=tw_999&lang=fr'
  );
  assert.equal(xCleaned.network, 'x');
  assert.equal(xCleaned.trackingStripped, true);
  assert.equal(xCleaned.cleanUrl, 'https://x.com/kodera_io/status/185000000000001?lang=fr');
  assert.deepEqual(xCleaned.removedTrackingParams, ['utm_source', 'utm_medium', 'twclid']);

  // 2. Mastodon / Custom Fediverse instance
  const mastoCleaned = sanitizeSocialPostUrl(
    'https://piaille.fr/@kodera/1134567890123456?utm_campaign=launch&fbclid=fb_123'
  );
  assert.equal(mastoCleaned.network, 'mastodon');
  assert.equal(mastoCleaned.trackingStripped, true);
  assert.equal(mastoCleaned.cleanUrl, 'https://piaille.fr/@kodera/1134567890123456');

  // 3. Instagram
  const instaCleaned = sanitizeSocialPostUrl(
    'https://www.instagram.com/p/DB9abc123/?igsh=MzRlODBiNWFlZA==&utm_content=reel&fbclid=iwAR123'
  );
  assert.equal(instaCleaned.network, 'instagram');
  assert.equal(instaCleaned.trackingStripped, true);
  assert.equal(instaCleaned.cleanUrl, 'https://www.instagram.com/p/DB9abc123/');

  // Rejects SSRF and untrusted hosts
  assert.throws(
    () => sanitizeSocialPostUrl('http://x.com/kodera_io/status/1'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
  assert.throws(
    () => sanitizeSocialPostUrl('https://169.254.169.254/latest/meta-data'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('syndicates X, Mastodon, and Instagram webhooks with trackingStripped: true and zero third-party pixels', async () => {
  const handler = createSocialPulseWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_veille',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_534_000,
  });

  await harness.sendWebhook({
    event: 'social.x_posted',
    deliveryId: 'social_deliv_x_1',
    payload: {
      postId: 'x_18501',
      author: '@kodera_io',
      content: 'Sortie officielle du SDK connecteurs v1 <img src="https://tracker.evil/pixel.gif">',
      postUrl: 'https://twitter.com/kodera_io/status/18501?twclid=abc&utm_source=x',
    },
  });

  await harness.sendWebhook({
    event: 'social.mastodon_boosted',
    deliveryId: 'social_deliv_masto_2',
    payload: {
      postId: 'masto_1134',
      author: '@kodera@mastodon.social',
      content: 'Interopérabilité ouverte Matrix + Docs',
      postUrl: 'https://mastodon.social/@kodera/1134?utm_medium=fediverse&fbclid=xyz',
    },
  });

  await harness.sendWebhook({
    event: 'social.instagram_published',
    deliveryId: 'social_deliv_insta_3',
    payload: {
      postId: 'insta_db9',
      author: '@kodera.studio',
      content: 'Design système Cobalt × Kodera — givre',
      postUrl: 'https://instagram.com/p/DB9/?igsh=secret_token&utm_campaign=design',
    },
  });

  assert.equal(harness.recordedCalls.length, 3);
  for (const call of harness.recordedCalls) {
    const serialized = JSON.stringify(call.body);
    assert.ok(serialized.includes('"trackingStripped":true'));
    assert.ok(!serialized.includes('utm_'));
    assert.ok(!serialized.includes('fbclid'));
    assert.ok(!serialized.includes('twclid'));
    assert.ok(!serialized.includes('igsh'));
    assert.ok(!serialized.includes('<img'));
  }

  const cmdRes = handleSocialPostCommand({
    rawCommand:
      '/social-post --url="https://x.com/kodera_io/status/42?utm_source=share&twclid=track99" --author="@kodera_io" --excerpt="Annonce v1"',
    channelId: 'chan_veille',
    actorId: 'usr_zxxma',
  });
  assert.equal(cmdRes.network, 'x');
  assert.equal(cmdRes.trackingStripped, true);
  assert.equal(cmdRes.postUrl, 'https://x.com/kodera_io/status/42');
});

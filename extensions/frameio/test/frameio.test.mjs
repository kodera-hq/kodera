import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createFrameioDailiesWebhookHandler,
  extensionManifest,
  formatSmpteTimecode,
  handleDailiesCommand,
  signFrameioWebhookPayload,
  summarizeOtioMarkers,
  validateFrameioUrl,
  verifyFrameioWebhookSignature,
} from '../index.mjs';

const TEST_SECRET = 'whsec_frameio_studio_dailies_secret_0123456789';
const FIXED_NOW = 1_762_600_000;

test('frameio manifest validates cleanly and declares /dailies', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.frameio');
  assert.equal(extensionManifest.slug, 'frameio');
  assert.equal(extensionManifest.commands[0].name, 'dailies');
});

test('formatSmpteTimecode formats 23.976, 24, 25, 29.97 DF/NDF, 30, and 60 fps accurately', () => {
  assert.equal(formatSmpteTimecode(0, 24).timecode, '00:00:00:00');
  assert.equal(formatSmpteTimecode(86_400, 24).timecode, '01:00:00:00');
  assert.equal(formatSmpteTimecode(24 * 60 + 14, 23.976).timecode, '00:01:00:14');
  assert.equal(formatSmpteTimecode(25 * 90 + 12, 25).timecode, '00:01:30:12');
  assert.equal(formatSmpteTimecode(30 * 5 + 29, 30).timecode, '00:00:05:29');
  assert.equal(formatSmpteTimecode(60 * 61 + 59, 60).timecode, '00:01:01:59');

  // SMPTE 12M 29.97 drop-frame boundaries:
  // Frame 1799 -> 00:00:59;29, Frame 1800 -> 00:01:00;02 (;00 and ;01 dropped on minute 1)
  assert.equal(formatSmpteTimecode(1799, 29.97).timecode, '00:00:59;29');
  assert.equal(formatSmpteTimecode(1800, 29.97).timecode, '00:01:00;02');
  // 10th minute (17,982 frames) does NOT drop ;00 or ;01
  assert.equal(formatSmpteTimecode(17_981, 29.97).timecode, '00:09:59;29');
  assert.equal(formatSmpteTimecode(17_982, 29.97).timecode, '00:10:00;00');
  // 1 hour in 29.97 DF = 107,892 frames -> 01:00:00;00
  assert.equal(formatSmpteTimecode(107_892, 29.97).timecode, '01:00:00;00');

  // Explicit non-drop 29.97 uses colon separator
  const ndf = formatSmpteTimecode(1800, 29.97, { dropFrame: false });
  assert.equal(ndf.timecode, '00:01:00:00');
  assert.equal(ndf.dropFrame, false);

  assert.throws(
    () => formatSmpteTimecode(-1, 24),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_FRAME_NUMBER'
  );
  assert.throws(
    () => formatSmpteTimecode(100, 24, { dropFrame: true }),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_DROP_FRAME'
  );
  assert.throws(
    () => formatSmpteTimecode(100, 48),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNSUPPORTED_FPS'
  );
});

test('summarizeOtioMarkers extracts rational-time markers from an OpenTimelineIO timeline', () => {
  const otioDoc = {
    OTIO_SCHEMA: 'Timeline.1',
    name: 'EP01_PictureLock',
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'SH010_plate',
              markers: [
                {
                  OTIO_SCHEMA: 'Marker.2',
                  name: 'VFX paint-out boom mic',
                  color: 'RED',
                  comment: '<b>Rig removal</b> frame 1450',
                  marked_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 1450, rate: 24 },
                    duration: { OTIO_SCHEMA: 'RationalTime.1', value: 1, rate: 24 },
                  },
                },
                {
                  OTIO_SCHEMA: 'Marker.2',
                  name: 'Color trim approved',
                  color: 'GREEN',
                  comment: 'Supervisor sign-off',
                  marked_range: {
                    OTIO_SCHEMA: 'TimeRange.1',
                    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 2880, rate: 24 },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const summary = summarizeOtioMarkers(otioDoc);
  assert.equal(summary.timelineName, 'EP01_PictureLock');
  assert.equal(summary.markerCount, 2);
  assert.deepEqual(summary.byColor, { RED: 1, GREEN: 1 });
  assert.equal(summary.markers[0].timecode, '00:01:00:10');
  assert.ok(!summary.markers[0].comment.includes('<b>'));
  assert.ok(summary.summaryText.includes('[00:01:00:10] (RED) VFX paint-out boom mic'));
});

test('verifyFrameioWebhookSignature enforces v0 HMAC-SHA256, timestamp skew, and native replay protection', async () => {
  const posted = [];
  const replied = [];
  const fakeClient = {
    async postChannelMessage(msg) {
      posted.push(msg);
      return { id: `msg_${posted.length}` };
    },
    async postThreadReply(reply) {
      replied.push(reply);
      return { id: `reply_${replied.length}` };
    },
  };

  const handler = createFrameioDailiesWebhookHandler({
    secret: TEST_SECRET,
    defaultChannelId: 'chan_dailies',
    client: fakeClient,
  });

  const createdBody = JSON.stringify({
    type: 'comment.created',
    project: { name: 'SciFi_Short' },
    asset: { id: 'asset_sh040', name: 'SH040_comp_v03.mov', fps: 24 },
    user: { name: 'Camille (VFX)' },
    comment: {
      id: 'cmt_101',
      frame: 362,
      fps: 24,
      text: '<script>evil()</script>Check edge matte on left shoulder',
      annotation_summary: 'Lasso polygon @ top-left',
      review_url: 'https://app.frame.io/player/asset_sh040?frame=362',
    },
  });
  const sig1 = signFrameioWebhookPayload(TEST_SECRET, FIXED_NOW, createdBody);

  const res1 = await handler({
    rawBody: createdBody,
    headers: {
      'x-frameio-request-timestamp': String(FIXED_NOW),
      'x-frameio-signature': sig1,
      'x-frameio-delivery': 'fio_deliv_1',
    },
    nowUnixSeconds: FIXED_NOW,
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.result.timecode, '00:00:15:02');
  assert.equal(posted.length, 1);
  assert.ok(!posted[0].text.includes('<script>'));
  assert.ok(posted[0].text.includes('`00:00:15:02`'));

  // Replay of same signature is rejected
  await assert.rejects(
    () =>
      handler({
        rawBody: createdBody,
        headers: {
          'x-frameio-request-timestamp': String(FIXED_NOW),
          'x-frameio-signature': sig1,
          'x-frameio-delivery': 'fio_deliv_2',
        },
        nowUnixSeconds: FIXED_NOW + 2,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // comment.completed threads onto the existing asset root message
  const completedBody = JSON.stringify({
    type: 'comment.completed',
    asset: { id: 'asset_sh040', name: 'SH040_comp_v03.mov', fps: 24 },
    user: { name: 'Nadia (Comp)' },
    comment: {
      id: 'cmt_101',
      frame: 362,
      fps: 24,
      text: 'Edge matte fixed in v04',
      review_url: 'https://app.frame.io/player/asset_sh040?frame=362',
    },
  });
  const sig2 = signFrameioWebhookPayload(TEST_SECRET, FIXED_NOW + 10, completedBody);
  const res2 = await handler({
    rawBody: completedBody,
    headers: {
      'x-frameio-request-timestamp': String(FIXED_NOW + 10),
      'x-frameio-signature': sig2,
      'x-frameio-delivery': 'fio_deliv_3',
    },
    nowUnixSeconds: FIXED_NOW + 10,
  });
  assert.equal(res2.result.threaded, true);
  assert.equal(replied.length, 1);
  assert.equal(replied[0].threadRootId, 'msg_1');

  // Forged signature and expired timestamp fail closed
  assert.throws(
    () =>
      verifyFrameioWebhookSignature({
        secret: TEST_SECRET,
        rawBody: createdBody,
        signatureHeader: 'v0=' + '0'.repeat(64),
        timestampHeader: String(FIXED_NOW),
        nowUnixSeconds: FIXED_NOW,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  assert.throws(
    () =>
      verifyFrameioWebhookSignature({
        secret: TEST_SECRET,
        rawBody: createdBody,
        signatureHeader: sig1,
        timestampHeader: String(FIXED_NOW),
        nowUnixSeconds: FIXED_NOW + 900,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'TIMESTAMP_OUT_OF_RANGE'
  );
});

test('asset.ready, review_link.created, SSRF refusal, and /dailies command work via SDK harness', async () => {
  const harness = createExtensionTestHarness({
    secret: TEST_SECRET,
    handler: createFrameioDailiesWebhookHandler({ secret: TEST_SECRET }),
    nowSeconds: FIXED_NOW,
  });

  const assetDelivery = await harness.sendWebhook({
    event: 'asset.ready',
    deliveryId: 'fio_sdk_asset_1',
    payload: {
      type: 'asset.ready',
      projectName: 'Docu_Reel',
      asset: {
        id: 'asset_900',
        name: 'Reel1_Master.mov',
        frames: 1800,
        fps: 29.97,
        resolution: '3840x2160',
        codec: 'ProRes 4444',
        view_url: 'https://app.frame.io/player/asset_900',
      },
    },
  });
  assert.equal(assetDelivery.response.result.durationTimecode, '00:01:00;02');

  const linkDelivery = await harness.sendWebhook({
    event: 'review_link.created',
    deliveryId: 'fio_sdk_link_1',
    payload: {
      type: 'review_link.created',
      review_link: {
        id: 'rl_55',
        name: 'Director Cut Screening',
        expires_at: '2026-12-01T00:00:00Z',
        short_url: 'https://app.frame.io/reviews/rl_55',
      },
    },
  });
  assert.equal(linkDelivery.response.result.linkId, 'rl_55');

  const cmdRes = handleDailiesCommand({
    rawCommand: '/dailies timecode --frame=1800 --fps=29.97 --drop-frame=true',
  });
  assert.equal(cmdRes.timecode, '00:01:00;02');

  assert.throws(
    () => validateFrameioUrl('https://169.254.169.254/latest/meta-data/'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
  assert.throws(
    () => validateFrameioUrl('https://attacker.example.net/player/1'),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNTRUSTED_FRAMEIO_HOST'
  );
});

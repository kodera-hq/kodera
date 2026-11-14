import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  buildKoderaVoiceRoomJump,
  createCalcomWebhookHandler,
  extensionManifest,
  handleScheduleCommand,
  signCalcomWebhookPayload,
  validateCalcomManifest,
  validateIsoUtcWindow,
  verifyCalcomWebhookSignature,
} from '../index.mjs';

const TEST_SECRET = 'whsec_calcom_studio_secret_0123456789abcdef';

test('calcom manifest validates cleanly and rejects SSRF webhookUrl overrides', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.calcom');
  assert.equal(extensionManifest.slug, 'calcom');
  assert.equal(extensionManifest.commands[0].name, 'schedule');

  assert.throws(
    () => validateCalcomManifest({ ...extensionManifest, webhookUrl: 'http://127.0.0.1:8080/cal' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
});

test('validateIsoUtcWindow normalizes offset timestamps to UTC and rejects missing offsets or inverted windows', () => {
  const windowInfo = validateIsoUtcWindow('2026-11-14T15:00:00+01:00', '2026-11-14T15:45:00+01:00');
  assert.equal(windowInfo.startIsoUtc, '2026-11-14T14:00:00.000Z');
  assert.equal(windowInfo.endIsoUtc, '2026-11-14T14:45:00.000Z');
  assert.equal(windowInfo.durationMinutes, 45);

  // Missing timezone offset must be rejected
  assert.throws(
    () => validateIsoUtcWindow('2026-11-14T15:00:00', '2026-11-14T15:30:00Z'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_BOOKING_TIMESTAMP'
  );

  // Inverted range must be rejected
  assert.throws(
    () => validateIsoUtcWindow('2026-11-14T16:00:00Z', '2026-11-14T15:00:00Z'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_BOOKING_WINDOW'
  );
});

test('buildKoderaVoiceRoomJump produces a validated HTTPS jump action to 🔊 office-hours and blocks SSRF origins', () => {
  const jump = buildKoderaVoiceRoomJump({
    roomSlug: 'office-hours',
    workspaceBaseUrl: 'https://workspace.example.org',
  });
  assert.equal(jump.roomLabel, '🔊 office-hours');
  assert.equal(jump.jumpUrl, 'https://workspace.example.org/voice/office-hours');

  assert.throws(
    () => buildKoderaVoiceRoomJump({ roomSlug: 'office-hours', workspaceBaseUrl: 'https://169.254.169.254' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('native X-Cal-Signature-256 webhooks create a meeting card without leaking attendee emails and thread reschedules/starts/cancellations', async () => {
  const postedMessages = [];
  const threadReplies = [];
  const mockClient = {
    async postChannelMessage(msg) {
      const id = `msg_cal_${postedMessages.length + 1}`;
      postedMessages.push({ id, ...msg });
      return { id };
    },
    async postThreadReply(reply) {
      const id = `reply_cal_${threadReplies.length + 1}`;
      threadReplies.push({ id, ...reply });
      return { id };
    },
  };

  const handler = createCalcomWebhookHandler({
    secret: TEST_SECRET,
    defaultChannelId: 'chan_office_hours',
    defaultVoiceRoom: 'office-hours',
    workspaceBaseUrl: 'https://workspace.example.org',
    client: mockClient,
  });

  const nowSec = 1_763_136_000;
  const createdBody = JSON.stringify({
    triggerEvent: 'BOOKING_CREATED',
    createdAt: new Date(nowSec * 1000).toISOString(),
    payload: {
      uid: 'bk_studio_sync_42',
      title: 'Architecture Office Hours <script>alert(1)</script>',
      startTime: '2026-11-15T10:00:00Z',
      endTime: '2026-11-15T10:30:00Z',
      organizer: { name: 'Camille Laurent', email: 'camille.private@example.org' },
      attendees: [
        { name: 'Guest One', email: 'guest1.secret@example.org', phoneNumber: '+33612345678' },
        { name: 'Guest Two', email: 'guest2.secret@example.org' },
      ],
      bookingUrl: 'https://app.cal.com/booking/bk_studio_sync_42',
    },
  });

  const createdSig = signCalcomWebhookPayload(TEST_SECRET, createdBody);
  const createdRes = await handler({
    rawBody: createdBody,
    headers: {
      'x-cal-signature-256': createdSig,
      'x-cal-delivery-id': 'cal_deliv_1',
    },
    nowUnixSeconds: nowSec,
  });

  assert.equal(createdRes.ok, true);
  assert.equal(postedMessages.length, 1);
  assert.ok(postedMessages[0].text.includes('[BOOKING CREATED]'));
  assert.ok(postedMessages[0].text.includes('🔊 office-hours'));
  const parsedJump = new URL(postedMessages[0].blocks[0].actions[0].jumpUrl);
  assert.equal(parsedJump.origin, 'https://workspace.example.org');
  assert.equal(parsedJump.pathname, '/voice/office-hours');
  assert.ok(postedMessages[0].text.includes('/voice/office-hours'));
  assert.ok(!postedMessages[0].text.includes('<script>'));
  // Attendee and organizer raw emails/phones must never leak into channel card text or blocks
  const serializedCard = JSON.stringify(postedMessages[0]);
  assert.ok(!serializedCard.includes('camille.private@example.org'));
  assert.ok(!serializedCard.includes('guest1.secret@example.org'));
  assert.ok(!serializedCard.includes('+33612345678'));
  assert.equal(postedMessages[0].blocks[0].actions[0].jumpUrl, 'https://workspace.example.org/voice/office-hours');

  // Replay of identical signed delivery must fail
  await assert.rejects(
    () =>
      handler({
        rawBody: createdBody,
        headers: { 'x-cal-signature-256': createdSig, 'x-cal-delivery-id': 'cal_deliv_2' },
        nowUnixSeconds: nowSec + 5,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // Reschedule, Meeting Started, and Cancellation thread onto the root booking message
  for (const [idx, triggerEvent] of ['BOOKING_RESCHEDULED', 'MEETING_STARTED', 'BOOKING_CANCELLED'].entries()) {
    const updateBody = JSON.stringify({
      triggerEvent,
      createdAt: new Date((nowSec + 10 + idx) * 1000).toISOString(),
      payload: {
        uid: 'bk_studio_sync_42',
        title: 'Architecture Office Hours',
        startTime: '2026-11-15T11:00:00Z',
        endTime: '2026-11-15T11:30:00Z',
        organizer: { name: 'Camille Laurent' },
        attendees: [{ name: 'Guest One' }],
        cancellationReason: triggerEvent === 'BOOKING_CANCELLED' ? 'Moved to async review' : undefined,
      },
    });
    const sig = signCalcomWebhookPayload(TEST_SECRET, updateBody);
    await handler({
      rawBody: updateBody,
      headers: { 'x-cal-signature-256': sig, 'x-cal-delivery-id': `cal_deliv_upd_${idx}` },
      nowUnixSeconds: nowSec + 10 + idx,
    });
  }

  assert.equal(threadReplies.length, 3);
  assert.equal(threadReplies[0].threadRootId, 'msg_cal_1');
  assert.ok(threadReplies[0].text.includes('[BOOKING RESCHEDULED]'));
  assert.ok(threadReplies[1].text.includes('[MEETING LIVE]'));
  assert.ok(threadReplies[2].text.includes('[BOOKING CANCELLED]'));
  assert.deepEqual(threadReplies[2].blocks[0].actions, []);
});

test('verifyCalcomWebhookSignature rejects forged digests and /schedule slash command runs via Kodera harness', async () => {
  const body = JSON.stringify({
    triggerEvent: 'MEETING_STARTED',
    payload: {
      uid: 'bk_009',
      startTime: '2026-11-15T12:00:00Z',
      endTime: '2026-11-15T12:30:00Z',
    },
  });

  assert.throws(
    () =>
      verifyCalcomWebhookSignature({
        secret: TEST_SECRET,
        rawBody: body,
        signatureHeader: signCalcomWebhookPayload('whsec_wrong_secret_value_0000000000', body),
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  const directCmd = handleScheduleCommand({ rawCommand: '/schedule room --room=design-crit' });
  assert.equal(directCmd.subcommand, 'room');
  assert.equal(directCmd.voiceRoom.roomLabel, '🔊 design-crit');

  const harness = createExtensionTestHarness({
    secret: TEST_SECRET,
    handler: createCalcomWebhookHandler({ secret: TEST_SECRET }),
  });
  const res = await harness.sendWebhook({
    event: 'command.invoked',
    payload: {
      type: 'command.invoked',
      command: 'schedule',
      args: 'upcoming --window=week',
      channelId: 'chan_ops',
      actorId: 'usr_lead',
    },
  });
  assert.equal(res.response.result.subcommand, 'upcoming');
});

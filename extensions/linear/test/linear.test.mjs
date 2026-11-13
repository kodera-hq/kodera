import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createLinearWebhookHandler,
  extensionManifest,
  handleLinearCommand,
  linearCommand,
  signLinearWebhookPayload,
  validateLinearIssueIdentifier,
  validateLinearUrl,
} from '../index.mjs';

const SECRET = 'lin_whsec_reference_secret_0123456789abcdef';

test('linear manifest validates reverse-DNS id, scopes, and /linear slash command', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.linear');
  assert.equal(extensionManifest.slug, 'linear');
  assert.equal(extensionManifest.webhookUrl, 'https://extensions.example.invalid/hooks/linear');
  assert.equal(linearCommand.name, 'linear');
});

test('linear Issue create/update/remove, sanitized Comment quote preview, Cycle, and ProjectUpdate health transitions', async () => {
  const handler = createLinearWebhookHandler({ secret: SECRET, defaultChannelId: 'chan_product' });
  const harness = createExtensionTestHarness({ secret: SECRET, handler, nowSeconds: 1_762_525_000 });
  const nowMs = harness.getNow() * 1000;

  // 1. Issue created
  const createIssueBody = JSON.stringify({
    action: 'create',
    type: 'Issue',
    webhookId: 'lin_wh_issue_142_create',
    webhookTimestamp: nowMs,
    url: 'https://linear.app/kodera/issue/ENG-142',
    data: {
      identifier: 'ENG-142',
      title: 'Add replay-safe webhook verification <script>evil()</script>',
      priority: 1,
      state: { name: 'In Progress' },
      assignee: { name: 'Miguel' },
    },
  });

  await handler({
    secret: SECRET,
    rawBody: createIssueBody,
    headers: {
      'linear-signature': signLinearWebhookPayload(SECRET, createIssueBody),
      'linear-delivery': 'lin_deliv_1',
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[ISSUE CREATED] **ENG-142** Add replay-safe webhook verification'));
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[In Progress · Urgent · Miguel]'));
  assert.ok(!String(harness.recordedCalls[0].body.text).includes('<script>'));

  // 2. Issue updated (status/priority/assignee transition replies in thread)
  const updateIssueBody = JSON.stringify({
    action: 'update',
    type: 'Issue',
    webhookId: 'lin_wh_issue_142_update',
    webhookTimestamp: nowMs + 2000,
    url: 'https://linear.app/kodera/issue/ENG-142',
    updatedFrom: { stateId: 'old', priority: 1, assigneeId: 'old_usr' },
    data: {
      identifier: 'ENG-142',
      title: 'Add replay-safe webhook verification',
      priority: 2,
      state: { name: 'In Review' },
      assignee: { name: 'Lours' },
      updatedAt: '2026-11-13T18:00:02Z',
    },
  });

  await handler({
    secret: SECRET,
    rawBody: updateIssueBody,
    headers: {
      'linear-signature': signLinearWebhookPayload(SECRET, updateIssueBody),
      'linear-delivery': 'lin_deliv_2',
    },
    nowUnixSeconds: harness.getNow() + 2,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 2);
  assert.match(harness.recordedCalls[1].path, /\/threads\/msg_test_1\/replies$/);
  assert.ok(String(harness.recordedCalls[1].body.text).includes('status → In Review, priority → High, assignee → Lours'));

  // 3. Comment created with sanitized plain-text quote preview on the issue thread
  const commentBody = JSON.stringify({
    action: 'create',
    type: 'Comment',
    webhookId: 'lin_wh_comment_1',
    webhookTimestamp: nowMs + 4000,
    url: 'https://linear.app/kodera/issue/ENG-142#comment-abc',
    data: {
      id: 'comment_abc',
      issue: { identifier: 'ENG-142' },
      user: { name: 'David' },
      body: '<b>Verified</b> against synthetic fixture; javascript:alert(1) neutralized.',
    },
  });

  await handler({
    secret: SECRET,
    rawBody: commentBody,
    headers: {
      'linear-signature': signLinearWebhookPayload(SECRET, commentBody),
      'linear-delivery': 'lin_deliv_3',
    },
    nowUnixSeconds: harness.getNow() + 4,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 3);
  const commentText = String(harness.recordedCalls[2].body.text);
  assert.ok(!commentText.includes('<b>'));
  assert.ok(commentText.includes('blocked-scheme:alert(1)'));

  // 4. Cycle & ProjectUpdate (onTrack, atRisk, offTrack)
  const cycleBody = JSON.stringify({
    action: 'update',
    type: 'Cycle',
    webhookId: 'lin_wh_cycle_8',
    webhookTimestamp: nowMs + 5000,
    data: { number: 8, name: 'Wave 6 Connectors', progress: 0.75, url: 'https://linear.app/kodera/cycle/8' },
  });
  await handler({
    secret: SECRET,
    rawBody: cycleBody,
    headers: { 'linear-signature': signLinearWebhookPayload(SECRET, cycleBody) },
    nowUnixSeconds: harness.getNow() + 5,
    client: harness.client,
  });

  for (const [idx, health] of /** @type {const} */ (['onTrack', 'atRisk', 'offTrack']).entries()) {
    const puBody = JSON.stringify({
      action: 'create',
      type: 'ProjectUpdate',
      webhookId: `lin_wh_pu_${health}`,
      webhookTimestamp: nowMs + (6 + idx) * 1000,
      data: {
        id: `pu_${health}`,
        health,
        project: { name: 'Connector Pack' },
        user: { name: 'zxxma' },
        body: `Status check ${health}`,
        url: 'https://linear.app/kodera/projects',
      },
    });
    await handler({
      secret: SECRET,
      rawBody: puBody,
      headers: { 'linear-signature': signLinearWebhookPayload(SECRET, puBody) },
      nowUnixSeconds: harness.getNow() + 6 + idx,
      client: harness.client,
    });
  }

  assert.equal(harness.recordedCalls.length, 7);
  assert.ok(String(harness.recordedCalls[3].body.text).includes('progress: 75%'));
  assert.ok(String(harness.recordedCalls[4].body.text).includes('[ON TRACK]'));
  assert.ok(String(harness.recordedCalls[5].body.text).includes('[AT RISK]'));
  assert.ok(String(harness.recordedCalls[6].body.text).includes('[OFF TRACK]'));
});

test('linear refuses forged Linear-Signature, stale webhookTimestamp, replayed webhookId, and untrusted hosts', async () => {
  const handler = createLinearWebhookHandler({ secret: SECRET });
  const nowSec = 1_762_525_000;

  const staleBody = JSON.stringify({
    action: 'remove',
    type: 'Issue',
    webhookId: 'lin_stale_1',
    webhookTimestamp: (nowSec - 900) * 1000,
    data: { identifier: 'ENG-99', title: 'Old issue' },
  });

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: staleBody,
        headers: { 'linear-signature': signLinearWebhookPayload(SECRET, staleBody) },
        nowUnixSeconds: nowSec,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'TIMESTAMP_OUT_OF_RANGE'
  );

  const validBody = JSON.stringify({
    action: 'remove',
    type: 'Issue',
    webhookId: 'lin_valid_once',
    webhookTimestamp: nowSec * 1000,
    data: { identifier: 'ENG-99', title: 'Removed issue' },
  });
  const sig = signLinearWebhookPayload(SECRET, validBody);

  // Tampered payload
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: `${validBody} `,
        headers: { 'linear-signature': sig },
        nowUnixSeconds: nowSec,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  // First succeeds, replay fails
  await handler({
    secret: SECRET,
    rawBody: validBody,
    headers: { 'linear-signature': sig },
    nowUnixSeconds: nowSec,
  });

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: validBody,
        headers: { 'linear-signature': sig },
        nowUnixSeconds: nowSec + 1,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  assert.throws(
    () => validateLinearIssueIdentifier('bad_id'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_LINEAR_ISSUE_ID'
  );
  assert.throws(
    () => validateLinearUrl('https://evil.example.org/issue/ENG-1'),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNTRUSTED_LINEAR_HOST'
  );
});

test('/linear slash command supports status, issue, triage, cycle, and project', () => {
  assert.equal(handleLinearCommand({ args: '' }).subcommand, 'status');
  assert.equal(handleLinearCommand({ args: 'issue --id=ENG-34 --priority=urgent' }).issueId, 'ENG-34');
  assert.equal(handleLinearCommand({ args: 'triage ENG-34 --priority=high' }).ephemeral, false);
  assert.equal(handleLinearCommand({ args: 'cycle --team=SEC' }).team, 'SEC');
  assert.equal(handleLinearCommand({ args: 'project --health=atRisk' }).health, 'atRisk');
});

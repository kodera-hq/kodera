import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createOpenprojectWebhookHandler,
  extensionManifest,
  handleWorkCommand,
  normalizeSovereignWorkItem,
  signWorkWebhookPayload,
  validateOpenprojectManifest,
  validateWorkTrackerUrl,
  verifyWorkWebhookSignature,
} from '../index.mjs';

const TEST_SECRET = 'whsec_openproject_jira_secret_0123456789abcdef';

test('openproject manifest validates cleanly and rejects SSRF webhookUrl overrides', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.openproject');
  assert.equal(extensionManifest.slug, 'openproject');
  assert.equal(extensionManifest.commands[0].name, 'work');

  assert.throws(
    () => validateOpenprojectManifest({ ...extensionManifest, webhookUrl: 'https://192.168.1.25/hook' }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
  assert.throws(
    () => validateWorkTrackerUrl('https://127.0.0.1/work_packages/1'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
});

test('OpenProject HAL+JSON work_package:created and work_package:updated normalize cleanly and correlate threads', async () => {
  const postedMessages = [];
  const threadReplies = [];
  const mockClient = {
    async postChannelMessage(msg) {
      const id = `msg_op_${postedMessages.length + 1}`;
      postedMessages.push({ id, ...msg });
      return { id };
    },
    async postThreadReply(reply) {
      const id = `reply_op_${threadReplies.length + 1}`;
      threadReplies.push({ id, ...reply });
      return { id };
    },
  };

  const handler = createOpenprojectWebhookHandler({
    secret: TEST_SECRET,
    defaultChannelId: 'chan_roadmap',
    client: mockClient,
  });

  const createdPayload = {
    action: 'work_package:created',
    work_package: {
      id: 1042,
      subject: 'Harden Matrix federation ingress <img src=x onerror=alert(1)>',
      htmlUrl: 'https://openproject.example.org/work_packages/1042',
      _embedded: {
        project: { identifier: 'core-sec' },
        status: { name: 'New' },
        priority: { name: 'High' },
        assignee: { name: 'Nadia Moreau', email: 'nadia.secret@example.org' },
        version: { name: 'Release 2.4' },
      },
    },
  };
  const createdRaw = JSON.stringify(createdPayload);
  const createdSig = signWorkWebhookPayload(TEST_SECRET, createdRaw);

  const createdRes = await handler({
    rawBody: createdRaw,
    headers: {
      'x-openproject-signature': createdSig,
      'x-openproject-delivery': 'op_deliv_1',
    },
    nowUnixSeconds: 1_763_150_000,
  });

  assert.equal(createdRes.ok, true);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].blocks[0].provider, 'openproject');
  assert.equal(postedMessages[0].blocks[0].itemKey, 'CORE-SEC-1042');
  assert.equal(postedMessages[0].blocks[0].statusBadge, '[NEW]');
  assert.equal(postedMessages[0].blocks[0].sprintContext, 'Release 2.4');
  assert.ok(!postedMessages[0].text.includes('<img'));
  assert.ok(!JSON.stringify(postedMessages[0]).includes('nadia.secret@example.org'));

  // Subsequent work_package:updated threads onto msg_op_1
  const updatedPayload = {
    ...createdPayload,
    action: 'work_package:updated',
    work_package: {
      ...createdPayload.work_package,
      _embedded: {
        ...createdPayload.work_package._embedded,
        status: { name: 'In Progress' },
      },
    },
  };
  const updatedRaw = JSON.stringify(updatedPayload);
  await handler({
    rawBody: updatedRaw,
    headers: {
      'x-openproject-signature': signWorkWebhookPayload(TEST_SECRET, updatedRaw),
      'x-openproject-delivery': 'op_deliv_2',
    },
    nowUnixSeconds: 1_763_150_010,
  });

  assert.equal(threadReplies.length, 1);
  assert.equal(threadReplies[0].threadRootId, 'msg_op_1');
  assert.equal(threadReplies[0].blocks[0].statusBadge, '[IN PROGRESS]');
});

test('Jira issue and sprint fixtures normalize into identical sovereign card contract and reject forged signatures', async () => {
  const postedMessages = [];
  const threadReplies = [];
  const mockClient = {
    async postChannelMessage(msg) {
      const id = `msg_jira_${postedMessages.length + 1}`;
      postedMessages.push({ id, ...msg });
      return { id };
    },
    async postThreadReply(reply) {
      const id = `reply_jira_${threadReplies.length + 1}`;
      threadReplies.push({ id, ...reply });
      return { id };
    },
  };

  const handler = createOpenprojectWebhookHandler({
    secret: TEST_SECRET,
    defaultChannelId: 'chan_sprint',
    client: mockClient,
  });

  // 1. Jira issue created + updated
  const issueCreatedRaw = JSON.stringify({
    webhookEvent: 'jira:issue_created',
    issue: {
      key: 'OPS-208',
      browseUrl: 'https://jira.example.org/browse/OPS-208',
      fields: {
        summary: 'Rotate cluster ingress certificates',
        status: { name: 'Selected for Development' },
        priority: { name: 'Highest' },
        assignee: { displayName: 'Marc Lefevre' },
        sprint: { name: 'Sprint 14' },
      },
    },
  });
  await handler({
    rawBody: issueCreatedRaw,
    headers: {
      'x-hub-signature-256': signWorkWebhookPayload(TEST_SECRET, issueCreatedRaw),
      'x-atlassian-webhook-identifier': 'jira_deliv_1',
    },
    nowUnixSeconds: 1_763_151_000,
  });

  const issueUpdatedRaw = JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    issue: {
      key: 'OPS-208',
      browseUrl: 'https://jira.example.org/browse/OPS-208',
      fields: {
        summary: 'Rotate cluster ingress certificates',
        status: { name: 'Done' },
        priority: { name: 'Highest' },
        assignee: { displayName: 'Marc Lefevre' },
        sprint: { name: 'Sprint 14' },
      },
    },
  });
  await handler({
    rawBody: issueUpdatedRaw,
    headers: {
      'x-hub-signature-256': signWorkWebhookPayload(TEST_SECRET, issueUpdatedRaw),
      'x-atlassian-webhook-identifier': 'jira_deliv_2',
    },
    nowUnixSeconds: 1_763_151_020,
  });

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].blocks[0].provider, 'jira');
  assert.equal(postedMessages[0].blocks[0].itemKey, 'OPS-208');
  assert.equal(postedMessages[0].blocks[0].sprintContext, 'Sprint 14');
  assert.equal(threadReplies.length, 1);
  assert.equal(threadReplies[0].threadRootId, 'msg_jira_1');
  assert.equal(threadReplies[0].blocks[0].statusBadge, '[DONE]');

  // 2. Jira sprint_started & sprint_closed normalization
  const sprintStarted = normalizeSovereignWorkItem('sprint_started', {
    sprint: { id: 14, name: 'Sprint 14', goal: 'Zero-trust connector rollout' },
  });
  assert.equal(sprintStarted.itemKey, 'SPRINT-14');
  assert.equal(sprintStarted.statusBadge, '[SPRINT ACTIVE]');

  const sprintClosed = normalizeSovereignWorkItem('sprint_closed', {
    sprint: { id: 14, name: 'Sprint 14', goal: 'Zero-trust connector rollout' },
  });
  assert.equal(sprintClosed.statusBadge, '[SPRINT CLOSED]');

  // 3. Forged signature rejected
  assert.throws(
    () =>
      verifyWorkWebhookSignature({
        secret: TEST_SECRET,
        rawBody: issueCreatedRaw,
        signatureHeader: signWorkWebhookPayload('whsec_attacker_wrong_secret_00000000', issueCreatedRaw),
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  // 4. /work command direct + harness execution
  const triage = handleWorkCommand({ rawCommand: '/work triage --key=OPS-208 --status=Done' });
  assert.equal(triage.subcommand, 'triage');
  assert.equal(triage.itemKey, 'OPS-208');

  const harness = createExtensionTestHarness({
    secret: TEST_SECRET,
    handler,
  });
  const cmdRes = await harness.sendWebhook({
    event: 'command.invoked',
    payload: {
      type: 'command.invoked',
      command: 'work',
      args: 'inspect --key=OP-1042',
      channelId: 'chan_roadmap',
      actorId: 'usr_pm',
    },
  });
  assert.equal(cmdRes.response.result.itemKey, 'OP-1042');
});

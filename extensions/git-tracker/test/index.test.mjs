import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createExtensionClient } from '@kodera/extension-sdk';
import { createGitTracker, createMemoryDeliveryStore, extensionManifest, verifyProviderRequest } from '../src/index.mjs';

const secret = 'synthetic-local-hook-secret-32-bytes';
const slug = 'example/project';
const repository = { full_name: slug };
const project = { path_with_namespace: slug };
const pull = { number: 12, draft: false };
function signed(event, payload, id = 'delivery-1', provider = 'github') {
  const rawBody = JSON.stringify(payload);
  return { rawBody, headers: provider === 'github' ? {
    'x-github-event': event, 'x-github-delivery': id,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  } : { 'x-gitlab-event': event, 'x-gitlab-event-uuid': id, 'x-gitlab-token': secret } };
}
function fixture(options = {}) {
  const posted = [];
  const store = options.deliveryStore ?? createMemoryDeliveryStore();
  const config = {
    provider: 'github', secret, hookId: 'hook-1', channelId: 'channel-1',
    repositories: [{ slug, defaultBranch: 'main' }], deliveryStore: store,
    client: { async postChannelMessage(card) { posted.push(card); } }, ...options,
  };
  return { tracker: createGitTracker(config), posted, store, config };
}
const push = { repository, ref: 'refs/heads/main', commits: [{ id: 'a'.repeat(40) }] };
const issue = { repository, action: 'opened', issue: { number: 42 } };
function run(conclusion, n, extra = {}) {
  return { repository, action: 'completed', workflow_run: { id: n, workflow_id: 10, run_number: n, run_attempt: 1, head_branch: 'main', status: 'completed', conclusion, ...extra } };
}

test('manifest uses only existing SDK minimum scopes', () => {
  assert.equal(extensionManifest.id, 'git-tracker');
  assert.deepEqual(extensionManifest.scopes, ['messages:write', 'webhooks:incoming']);
});

for (const [event, payload, kind] of [
  ['push', push, 'push'],
  ['pull_request', { repository, action: 'opened', pull_request: pull }, 'pull_opened'],
  ['pull_request', { repository, action: 'ready_for_review', pull_request: pull }, 'pull_ready'],
  ['pull_request', { repository, action: 'closed', pull_request: { ...pull, merged: true } }, 'pull_merged'],
  ['pull_request', { repository, action: 'closed', pull_request: pull }, 'pull_closed'],
  ['issues', issue, 'issue_opened'],
  ['issues', { ...issue, action: 'closed' }, 'issue_closed'],
  ['release', { repository, action: 'published', release: { draft: false } }, 'release'],
  ...['approved', 'changes_requested', 'commented'].map((state) => ['pull_request_review', { repository, action: 'submitted', pull_request: pull, review: { state } }, `review_${state}`]),
  ['workflow_run', run('failure', 2), 'failed'],
  ['check_suite', { repository, action: 'completed', check_suite: { id: 2, app: { id: 7 }, status: 'completed', conclusion: 'failure', head_branch: 'main' } }, 'failed'],
]) {
  test(`GitHub ${event}/${kind} projects a verified card`, async () => {
    const { tracker, posted } = fixture();
    assert.equal((await tracker.receive(signed(event, payload))).status, 'queued');
    assert.equal(await tracker.deliverPending(), 1);
    assert.equal(posted[0].blocks[0].kind, kind);
    assert.match(posted[0].blocks[0].url, /^https:\/\/github.com\/example\/project\//);
  });
}

for (const [event, payload, kind] of [
  ['Push Hook', { object_kind: 'push', project, ref: 'refs/heads/main', commits: [{}] }, 'push'],
  ['Merge Request Hook', { object_kind: 'merge_request', project, object_attributes: { iid: 3, action: 'open' } }, 'pull_opened'],
  ['Merge Request Hook', { object_kind: 'merge_request', project, object_attributes: { iid: 3, action: 'update' }, changes: { draft: { previous: true, current: false } } }, 'pull_ready'],
  ['Merge Request Hook', { object_kind: 'merge_request', project, object_attributes: { iid: 3, action: 'merge' } }, 'pull_merged'],
  ['Issue Hook', { object_kind: 'issue', project, object_attributes: { iid: 3, action: 'open' } }, 'issue_opened'],
  ['Issue Hook', { object_kind: 'issue', project, object_attributes: { iid: 3, action: 'close' } }, 'issue_closed'],
  ['Release Hook', { object_kind: 'release', project, action: 'create' }, 'release'],
  ['Pipeline Hook', { object_kind: 'pipeline', project, object_attributes: { id: 10, ref: 'main', status: 'failed' } }, 'failed'],
]) {
  test(`GitLab ${event}/${kind} projects a token-authenticated card`, async () => {
    const { tracker, posted } = fixture({ provider: 'gitlab' });
    assert.equal((await tracker.receive(signed(event, payload, 'gitlab-delivery', 'gitlab'))).status, 'queued');
    await tracker.deliverPending();
    assert.equal(posted[0].blocks[0].kind, kind);
    assert.match(posted[0].blocks[0].url, /^https:\/\/gitlab.com\/example\/project\//);
  });
}

for (const mutate of [
  (request) => { request.rawBody += ' '; },
  (request) => { request.headers['x-hub-signature-256'] = 'sha256=' + '0'.repeat(64); },
  (request) => { request.headers['x-hub-signature-256'] = 'sha1=' + '0'.repeat(40); },
  (request) => { delete request.headers['x-hub-signature-256']; },
  (request) => { request.headers['X-Hub-Signature-256'] = request.headers['x-hub-signature-256']; },
  (request) => { request.headers['x-hub-signature-256'] = [request.headers['x-hub-signature-256']]; },
]) {
  test(`signature tampering rejected before reserving delivery (${mutate.toString().slice(15, 70)})`, async () => {
    const { tracker } = fixture();
    const request = signed('push', push);
    mutate(request);
    await assert.rejects(tracker.receive(request), { code: 'INVALID_SIGNATURE' });
    assert.equal((await tracker.receive(signed('push', push))).status, 'queued');
  });
}

test('GitLab wrong token, including differing length, cannot poison replay receipts', async () => {
  const { tracker } = fixture({ provider: 'gitlab' });
  const request = signed('Push Hook', { ...push, project, object_kind: 'push' }, 'delivery', 'gitlab');
  for (const token of ['', 'bad', 'z'.repeat(secret.length), secret + 'x']) {
    await assert.rejects(tracker.receive({ ...request, headers: { ...request.headers, 'x-gitlab-token': token } }), { code: 'INVALID_SIGNATURE' });
  }
  assert.equal((await tracker.receive(request)).status, 'queued');
});

test('case-insensitive headers and raw bytes are accepted', async () => {
  const { tracker } = fixture();
  const request = signed('push', push);
  request.headers = new Headers(request.headers);
  request.rawBody = Buffer.from(request.rawBody);
  assert.equal((await tracker.receive(request)).status, 'queued');
});

test('unsigned event-header relabeling and ambiguous signed payloads are rejected', async () => {
  const { tracker } = fixture();
  const request = signed('push', push);
  request.headers['x-github-event'] = 'issues';
  await assert.rejects(tracker.receive(request), { code: 'INVALID_EVENT' });
  await assert.rejects(tracker.receive(signed('push', { ...push, issue: { number: 4 } })), { code: 'INVALID_EVENT' });
});

test('concurrent delivery and altered unsigned delivery ID emit once', async () => {
  const { tracker, posted } = fixture();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => tracker.receive(signed('push', push, `delivery-${i}`))));
  assert.equal(results.filter((result) => result.status === 'queued').length, 1);
  await tracker.deliverPending();
  assert.equal(posted.length, 1);
  assert.equal((await tracker.receive(signed('push', push, 'changed'))).status, 'duplicate');
});

test('same delivery ID with different authenticated body cannot enqueue twice', async () => {
  const { tracker } = fixture();
  await tracker.receive(signed('push', push));
  assert.equal((await tracker.receive(signed('issues', issue))).status, 'duplicate');
});

test('receiver restart retains injected receipts; downstream failures remain retryable', async () => {
  const store = createMemoryDeliveryStore();
  let failOnce = true;
  const sent = [];
  const setup = fixture({ deliveryStore: store, client: { async postChannelMessage(card) {
    sent.push(card);
    if (failOnce) { failOnce = false; throw new Error('temporary failure'); }
  } } });
  await setup.tracker.receive(signed('push', push));
  await assert.rejects(setup.tracker.deliverPending(), /temporary/);
  const restarted = createGitTracker(setup.config);
  assert.equal((await restarted.receive(signed('push', push))).status, 'duplicate');
  assert.equal(await restarted.deliverPending(), 1);
  assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
  assert.equal(await restarted.deliverPending(), 0);
});

test('shared outbox never delivers another hook/channel card', async () => {
  const store = createMemoryDeliveryStore();
  const first = fixture({ deliveryStore: store });
  const second = fixture({ deliveryStore: store, hookId: 'other', channelId: 'channel-2' });
  await first.tracker.receive(signed('push', push));
  await second.tracker.receive(signed('push', push));
  assert.equal(await second.tracker.deliverPending(), 1);
  assert.equal(second.posted[0].channelId, 'channel-2');
  assert.equal(await first.tracker.deliverPending(), 1);
});

test('CI only alerts failure transitions and recovery, rejects reordered old results', async () => {
  const { tracker, posted } = fixture();
  for (const [n, result, expected] of [[1, 'success', 'ignored'], [2, 'failure', 'queued'], [3, 'failure', 'ignored'], [4, 'success', 'queued'], [0, 'failure', 'ignored']]) {
    const body = run(result, n || 1, n ? {} : { run_attempt: 2 });
    assert.equal((await tracker.receive(signed('workflow_run', body, `delivery-${n}`))).status, expected);
  }
  await tracker.deliverPending();
  assert.deepEqual(posted.map((card) => card.blocks[0].kind), ['failed', 'recovered']);
});

test('GitLab pipeline recovery is persisted in the same outbox state', async () => {
  const { tracker, posted } = fixture({ provider: 'gitlab' });
  for (const [id, status] of [[1, 'failed'], [2, 'success']]) {
    await tracker.receive(signed('Pipeline Hook', { object_kind: 'pipeline', project, object_attributes: { id, status, ref: 'main' } }, `delivery-${id}`, 'gitlab'));
  }
  await tracker.deliverPending();
  assert.deepEqual(posted.map((card) => card.blocks[0].kind), ['failed', 'recovered']);
});

for (const [event, payload, option] of [
  ['pull_request', { repository, action: 'opened', pull_request: { ...pull, draft: true } }, 'includeDrafts'],
  ['push', { ...push, ref: 'refs/heads/feature' }, 'includeOtherBranches'],
  ['push', { ...push, commits: [{ author: { username: 'dependabot[bot]' }, added: [], modified: ['package-lock.json'], removed: [] }] }, 'includeBotLockfiles'],
]) {
  test(`noise filter ${option} is opt-in`, async () => {
    assert.equal((await fixture().tracker.receive(signed(event, payload))).status, 'ignored');
    assert.equal((await fixture({ [option]: true }).tracker.receive(signed(event, payload))).status, 'queued');
  });
}

test('unknown files and mixed human commits are not suppressed', async () => {
  for (const commits of [[{ author: { username: 'dependabot[bot]' } }], [{ author: { username: 'dependabot[bot]' }, modified: ['package-lock.json', 'src/main.js'] }], [{ author: { username: 'person' }, modified: ['package-lock.json'] }]]) {
    assert.equal((await fixture().tracker.receive(signed('push', { ...push, commits }))).status, 'queued');
  }
});

test('arbitrary secrets, PII and untrusted URLs never enter cards or persisted outbox', async () => {
  const { tracker, posted } = fixture();
  const leak = 'PERSON_PRIVATE@example.test ghp_secret_value password=private';
  await tracker.receive(signed('issues', { ...issue, sender: { login: leak }, issue: { number: 42, title: leak, body: leak, html_url: 'https://evil.test/?token=private' } }));
  await tracker.deliverPending();
  assert.doesNotMatch(JSON.stringify(posted), /PERSON|private|evil|secret_value|password/);
  assert.match(posted[0].text, /https:\/\/github.com\/example\/project\/issues\/42/);
});

test('both locale catalogues produce distinct complete labels', async () => {
  const english = fixture();
  const french = fixture({ locale: 'fr' });
  await english.tracker.receive(signed('issues', issue));
  await french.tracker.receive(signed('issues', issue));
  await english.tracker.deliverPending();
  await french.tracker.deliverPending();
  assert.notEqual(english.posted[0].text, french.posted[0].text);
  assert.doesNotMatch(french.posted[0].text, /undefined/);
});

test('SDK client performs actual serialized outbound protocol with stable idempotency', async () => {
  const requests = [];
  const client = createExtensionClient({ baseUrl: 'https://api.example.test', token: 'synthetic-extension-token', fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response('{}', { status: 201 }); } });
  const { tracker } = fixture({ client });
  await tracker.receive(signed('issues', issue));
  await tracker.deliverPending();
  assert.match(requests[0].url, /channels\/channel-1\/messages$/);
  assert.equal(JSON.parse(requests[0].options.body).blocks[0].kind, 'issue_opened');
  assert.match(new Headers(requests[0].options.headers).get('idempotency-key'), /^[a-f0-9]{64}$/);
});

test('config and bounded storage fail closed', async () => {
  for (const options of [{ deliveryStore: null }, { secret: 'short' }, { locale: '__proto__' }, { providerOrigin: 'https://example.test/path' }, { repositories: [{ slug: 'example/../secret', defaultBranch: 'main' }] }]) {
    assert.throws(() => fixture(options));
  }
  const { tracker } = fixture({ deliveryStore: createMemoryDeliveryStore({ capacity: 2 }) });
  await tracker.receive(signed('push', push));
  await assert.rejects(tracker.receive(signed('issues', issue, 'second')), { code: 'REPLAY_STORE_FULL' });
  assert.equal((await tracker.receive(signed('push', push))).status, 'duplicate');
});

test('repository allowlist and malformed primitive/bounded bodies reject safely', async () => {
  const { tracker } = fixture();
  await assert.rejects(tracker.receive(signed('issues', { ...issue, repository: { full_name: 'other/repo' } })), { code: 'REPOSITORY_NOT_ALLOWED' });
  for (const rawBody of [null, {}, 'x'.repeat(1_048_577)]) {
    assert.throws(() => verifyProviderRequest({ provider: 'github', secret, headers: {}, rawBody }), { code: 'INVALID_BODY' });
  }
  await assert.rejects(tracker.receive(signed('issues', [])), { code: 'INVALID_BODY' });
});

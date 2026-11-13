import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createGitlabWebhookHandler,
  extensionManifest,
  formatPipelineDuration,
  gitlabCommand,
  handleGitlabCommand,
  validateGitlabOrigin,
  validateGitlabProjectPath,
} from '../index.mjs';

const SECRET = 'gl_token_reference_secret_0123456789abcdef';
const SELF_HOSTED_ORIGIN = 'https://gitlab.ops.example.org';

test('gitlab manifest validates reverse-DNS id, scopes, and /gitlab slash command', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.gitlab');
  assert.equal(extensionManifest.slug, 'gitlab');
  assert.equal(extensionManifest.webhookUrl, 'https://extensions.example.invalid/hooks/gitlab');
  assert.equal(gitlabCommand.name, 'gitlab');
  assert.equal(formatPipelineDuration(145), '2m 25s');
});

test('gitlab self-hosted CE/EE handles Merge Request Hook threading and Pipeline Hook stage breakdown', async () => {
  const handler = createGitlabWebhookHandler({
    secret: SECRET,
    instanceOrigin: SELF_HOSTED_ORIGIN,
    defaultChannelId: 'chan_gitlab_ops',
  });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const mrOpenBody = JSON.stringify({
    object_kind: 'merge_request',
    user: { username: 'lours' },
    project: { path_with_namespace: 'infra/keycloak/realm-config' },
    object_attributes: {
      iid: 27,
      action: 'open',
      title: 'Pin OIDC client scopes <img src=x onerror=alert(1)>',
      source_branch: 'feat/oidc-scopes',
      target_branch: 'main',
      url: `${SELF_HOSTED_ORIGIN}/infra/keycloak/realm-config/-/merge_requests/27`,
    },
  });

  await handler({
    secret: SECRET,
    rawBody: mrOpenBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Merge Request Hook',
      'x-gitlab-event-uuid': 'gl_uuid_mr_27_open',
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.ok(!String(harness.recordedCalls[0].body.text).includes('<img'));
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[MR OPEN] **infra/keycloak/realm-config!27**'));

  const mrMergeBody = JSON.stringify({
    object_kind: 'merge_request',
    user: { username: 'zxxma' },
    project: { path_with_namespace: 'infra/keycloak/realm-config' },
    object_attributes: {
      iid: 27,
      action: 'merge',
      title: 'Pin OIDC client scopes',
      source_branch: 'feat/oidc-scopes',
      target_branch: 'main',
      url: `${SELF_HOSTED_ORIGIN}/infra/keycloak/realm-config/-/merge_requests/27`,
    },
  });

  await handler({
    secret: SECRET,
    rawBody: mrMergeBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Merge Request Hook',
      'x-gitlab-event-uuid': 'gl_uuid_mr_27_merge',
    },
    nowUnixSeconds: harness.getNow() + 5,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 2);
  assert.match(
    harness.recordedCalls[1].path,
    /^\/api\/v1\/extensions\/channels\/chan_gitlab_ops\/threads\/msg_test_1\/replies$/
  );

  const pipelineBody = JSON.stringify({
    object_kind: 'pipeline',
    project: { path_with_namespace: 'infra/keycloak/realm-config' },
    object_attributes: {
      id: 8821,
      ref: 'main',
      status: 'failed',
      duration: 94,
      stages: ['lint', 'test', 'verify'],
      url: `${SELF_HOSTED_ORIGIN}/infra/keycloak/realm-config/-/pipelines/8821`,
    },
    builds: [
      { name: 'lint-manifests', status: 'success' },
      { name: 'realm-integration-test', status: 'failed' },
    ],
  });

  await handler({
    secret: SECRET,
    rawBody: pipelineBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Pipeline Hook',
      'x-gitlab-event-uuid': 'gl_uuid_pipe_8821',
    },
    nowUnixSeconds: harness.getNow() + 15,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 3);
  const pipeText = String(harness.recordedCalls[2].body.text);
  assert.ok(pipeText.includes('[PIPELINE FAILED] **infra/keycloak/realm-config** pipeline #8821 on `main` (1m 34s · stages: lint → test → verify)'));
  assert.ok(pipeText.includes('Failed jobs: realm-integration-test'));
});

test('gitlab handles Push Hook, Tag Push Hook, Issue Hook, and Release Hook', async () => {
  const handler = createGitlabWebhookHandler({ secret: SECRET, defaultChannelId: 'chan_gl' });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const pushBody = JSON.stringify({
    object_kind: 'push',
    ref: 'refs/heads/main',
    after: 'abcdef1234567890abcdef1234567890abcdef12',
    user_username: 'miguel',
    project: { path_with_namespace: 'kodera/core', web_url: 'https://gitlab.com/kodera/core' },
    commits: [{ title: 'Enforce strict replay bounds' }],
  });

  await handler({
    secret: SECRET,
    rawBody: pushBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-event-uuid': 'gl_push_1',
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  const tagBody = JSON.stringify({
    object_kind: 'tag_push',
    ref: 'refs/tags/v1.4.0',
    user_username: 'lours',
    project: { path_with_namespace: 'kodera/core' },
  });

  await handler({
    secret: SECRET,
    rawBody: tagBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Tag Push Hook',
      'x-gitlab-event-uuid': 'gl_tag_1',
    },
    nowUnixSeconds: harness.getNow() + 1,
    client: harness.client,
  });

  const issueBody = JSON.stringify({
    object_kind: 'issue',
    user: { username: 'david' },
    project: { path_with_namespace: 'kodera/core' },
    object_attributes: {
      iid: 19,
      action: 'open',
      title: 'Document self-hosted origin verification',
      url: 'https://gitlab.com/kodera/core/-/issues/19',
    },
  });

  await handler({
    secret: SECRET,
    rawBody: issueBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Issue Hook',
      'x-gitlab-event-uuid': 'gl_issue_19',
    },
    nowUnixSeconds: harness.getNow() + 2,
    client: harness.client,
  });

  const releaseBody = JSON.stringify({
    object_kind: 'release',
    action: 'create',
    tag: 'v1.4.0',
    description: 'Signed webhook enhancements',
    project: { path_with_namespace: 'kodera/core' },
    url: 'https://gitlab.com/kodera/core/-/releases/v1.4.0',
  });

  await handler({
    secret: SECRET,
    rawBody: releaseBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Release Hook',
      'x-gitlab-event-uuid': 'gl_rel_140',
    },
    nowUnixSeconds: harness.getNow() + 3,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 4);
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[PUSH] **kodera/core** `main` (1 commit by **miguel**)'));
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[TAG] **kodera/core** tag `v1.4.0`'));
  assert.ok(String(harness.recordedCalls[2].body.text).includes('[ISSUE OPEN] **kodera/core#19**'));
  assert.ok(String(harness.recordedCalls[3].body.text).includes('[RELEASE] **kodera/core v1.4.0**'));
});

test('gitlab refuses wrong-length X-Gitlab-Token in constant time, mismatched X-Gitlab-Event, replays, and SSRF origins', async () => {
  const handler = createGitlabWebhookHandler({ secret: SECRET, instanceOrigin: SELF_HOSTED_ORIGIN });
  const validBody = JSON.stringify({
    object_kind: 'tag_push',
    ref: 'refs/tags/v0.1.0',
    user_username: 'lours',
    project: { path_with_namespace: 'kodera/core' },
  });

  // Wrong-length token (short & long) both fail via SHA-256 digest timingSafeEqual
  for (const badToken of ['x', `${SECRET}_extra_bytes_padding`]) {
    await assert.rejects(
      () =>
        handler({
          secret: SECRET,
          rawBody: validBody,
          headers: {
            'x-gitlab-token': badToken,
            'x-gitlab-event': 'Tag Push Hook',
            'x-gitlab-event-uuid': 'gl_bad_tok',
          },
          nowUnixSeconds: 1_762_525_000,
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
    );
  }

  // Event header spoofing
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: validBody,
        headers: {
          'x-gitlab-token': SECRET,
          'x-gitlab-event': 'Release Hook',
          'x-gitlab-event-uuid': 'gl_bad_evt',
        },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'INVALID_EVENT'
  );

  // Replay guard across identical body even if UUID changes
  await handler({
    secret: SECRET,
    rawBody: validBody,
    headers: {
      'x-gitlab-token': SECRET,
      'x-gitlab-event': 'Tag Push Hook',
      'x-gitlab-event-uuid': 'gl_first',
    },
    nowUnixSeconds: 1_762_525_000,
  });

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: validBody,
        headers: {
          'x-gitlab-token': SECRET,
          'x-gitlab-event': 'Tag Push Hook',
          'x-gitlab-event-uuid': 'gl_second',
        },
        nowUnixSeconds: 1_762_525_005,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // SSRF self-hosted origin checks
  assert.throws(
    () => validateGitlabOrigin('http://gitlab.example.org'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
  assert.throws(
    () => validateGitlabOrigin('https://10.10.0.5'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
  assert.throws(
    () => validateGitlabProjectPath('group/../secret'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_GITLAB_PROJECT'
  );
});

test('/gitlab slash command supports status, mr, pipelines, and issues', () => {
  assert.equal(handleGitlabCommand({ args: '' }).subcommand, 'status');
  assert.equal(handleGitlabCommand({ args: 'mr kodera/core --iid=5' }).iid, 5);
  assert.equal(handleGitlabCommand({ args: 'pipelines kodera/core --ref=develop' }).ref, 'develop');
  assert.equal(handleGitlabCommand({ args: 'issues kodera/core --iid=11' }).iid, 11);
});

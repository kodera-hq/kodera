import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  GITHUB_REPO_EVENTS,
  createGithubRepoTrackerWebhookHandler,
  extensionManifest,
  githubTrackCommand,
  handleGithubTrackCommand,
  manifest,
  validateGithubEndpointUrl,
  validateGithubRepository,
  validateGithubTrackerManifest,
  validateTrackedGithubEvents,
} from '../index.mjs';

const SECRET = 'whsec_github_repo_tracker_0123456789abcdef';

test('github-repo-tracker manifest validates against kodera.extension.v1 and /github-track', () => {
  assert.equal(manifest.schemaVersion, 'kodera.extension.v1');
  assert.equal(manifest.canonicalId, 'io.kodera.ext.github-repo-tracker');
  assert.equal(extensionManifest.id, 'github-repo-tracker');
  assert.equal(manifest.commands.length, 1);
  assert.equal(manifest.commands[0].command, '/github-track');
  assert.equal(manifest.commands[0].name, 'github-track');
  assert.deepEqual(GITHUB_REPO_EVENTS, [
    'issues',
    'pull_requests',
    'workflow_runs',
    'releases',
    'security_advisories',
  ]);

  assert.throws(
    () =>
      validateGithubTrackerManifest({
        ...manifest,
        webhookUrl: 'http://extensions.example.kodera.io/hooks/github-repo-tracker',
      }),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
});

test('tracks issues, pull_requests, workflow_runs, releases, and security_advisories with github.com / api.github.com validation', async () => {
  const handler = createGithubRepoTrackerWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_eng_github',
  });
  const harness = createExtensionTestHarness({
    secret: SECRET,
    handler,
    nowSeconds: 1_762_530_000,
  });

  const sampleEvents = [
    {
      event: 'issues',
      badge: '[GITHUB ISSUE]',
      payload: {
        repository: 'kodera-hq/kodera',
        action: 'opened',
        number: 142,
        title: 'Durcir la validation des webhooks <script>alert(1)</script>',
        actor: 'zxxma',
        htmlUrl: 'https://github.com/kodera-hq/kodera/issues/142',
        apiUrl: 'https://api.github.com/repos/kodera-hq/kodera/issues/142',
      },
    },
    {
      event: 'pull_requests',
      badge: '[GITHUB PR]',
      payload: {
        repository: 'kodera-hq/kodera',
        action: 'merged',
        number: 218,
        title: 'Pack connecteurs officiels B2B & réseaux sociaux',
        actor: 'lours',
        htmlUrl: 'https://github.com/kodera-hq/kodera/pull/218',
        apiUrl: 'https://api.github.com/repos/kodera-hq/kodera/pulls/218',
      },
    },
    {
      event: 'workflow_runs',
      badge: '[GITHUB WORKFLOW]',
      payload: {
        repository: 'kodera-hq/kodera',
        action: 'completed',
        number: 9012,
        title: 'ci-security-gate',
        actor: 'github-actions',
        htmlUrl: 'https://github.com/kodera-hq/kodera/actions/runs/9012',
        apiUrl: 'https://api.github.com/repos/kodera-hq/kodera/actions/runs/9012',
      },
    },
    {
      event: 'releases',
      badge: '[GITHUB RELEASE]',
      payload: {
        repository: 'kodera-hq/kodera',
        action: 'published',
        number: 'v1.4.0',
        title: 'Kodera v1.4.0',
        actor: 'zxxma',
        htmlUrl: 'https://github.com/kodera-hq/kodera/releases/tag/v1.4.0',
        apiUrl: 'https://api.github.com/repos/kodera-hq/kodera/releases/tags/v1.4.0',
      },
    },
    {
      event: 'security_advisories',
      badge: '[GITHUB SECURITY ADVISORY]',
      payload: {
        repository: 'kodera-hq/kodera',
        action: 'published',
        number: 'GHSA-xxxx-yyyy-zzzz',
        title: 'Mise à jour préventive dépendance TLS',
        actor: 'miguel',
        htmlUrl: 'https://github.com/kodera-hq/kodera/security/advisories/GHSA-xxxx-yyyy-zzzz',
        apiUrl: 'https://api.github.com/repos/kodera-hq/kodera/security-advisories/GHSA-xxxx-yyyy-zzzz',
      },
    },
  ];

  for (const [idx, item] of sampleEvents.entries()) {
    await harness.sendWebhook({
      event: item.event,
      deliveryId: `gh_track_deliv_${idx}`,
      payload: item.payload,
    });
  }

  assert.equal(harness.recordedCalls.length, 5);
  for (const [idx, item] of sampleEvents.entries()) {
    const call = harness.recordedCalls[idx];
    assert.ok(String(call.body.text).includes(item.badge));
    assert.ok(!String(call.body.text).includes('<script>'));
  }
});

test('executes /github-track command and rejects SSRF or non-GitHub hosts', () => {
  const res = handleGithubTrackCommand({
    rawCommand: '/github-track subscribe --repo=kodera-hq/kodera-core --events=issues,pull_requests,security_advisories',
    channelId: 'chan_core',
    actorId: 'usr_zxxma',
  });

  assert.equal(res.repository, 'kodera-hq/kodera-core');
  assert.deepEqual(res.events, ['issues', 'pull_requests', 'security_advisories']);
  assert.equal(res.htmlUrl, 'https://github.com/kodera-hq/kodera-core');
  assert.equal(res.apiUrl, 'https://api.github.com/repos/kodera-hq/kodera-core');
  assert.equal(githubTrackCommand.name, 'github-track');

  assert.throws(
    () => validateGithubRepository('invalid_repo_without_slash'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_GITHUB_REPO'
  );
  assert.throws(
    () => validateTrackedGithubEvents('issues,unknown_event'),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNSUPPORTED_GITHUB_EVENT'
  );
  assert.throws(
    () => validateGithubEndpointUrl('http://github.com/kodera-hq/kodera'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_INSECURE_PROTOCOL'
  );
  assert.throws(
    () => validateGithubEndpointUrl('https://169.254.169.254/latest/meta-data'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
  assert.throws(
    () => validateGithubEndpointUrl('https://evil.example.com/kodera-hq/kodera'),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNTRUSTED_GITHUB_HOST'
  );
});

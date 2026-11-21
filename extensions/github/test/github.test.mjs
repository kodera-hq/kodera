import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExtensionSdkError,
  WebhookVerificationError,
  createExtensionTestHarness,
} from '@kodera/extension-sdk';
import {
  createDurableReplayStore,
  createGithubWebhookHandler,
  extensionManifest,
  ghCommand,
  handleGhCommand,
  sanitizeGithubText,
  signGithubWebhookPayload,
  validateGithubRepoSlug,
  validateGithubUrl,
} from '../index.mjs';

const SECRET = 'whsec_github_reference_secret_0123456789abcdef';

test('github manifest validates reverse-DNS id, scopes, and /gh slash command', () => {
  assert.equal(extensionManifest.canonicalId, 'io.kodera.ext.github');
  assert.equal(extensionManifest.slug, 'github');
  assert.equal(extensionManifest.webhookUrl, 'https://extensions.example.invalid/hooks/github');
  assert.equal(ghCommand.name, 'gh');
});

test('github pull_request + pull_request_review correlate onto a single thread via native X-Hub-Signature-256', async () => {
  const handler = createGithubWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_pr_reviews',
    allowEphemeralReplayStore: true,
  });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const openedBody = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'kodera-hq/kodera' },
    pull_request: {
      number: 108,
      draft: false,
      title: 'Harden webhook replay verification <script>alert(1)</script>',
      user: { login: 'miguel' },
      head: { ref: 'feat/replay-guard' },
      base: { ref: 'main' },
      html_url: 'https://github.com/kodera-hq/kodera/pull/108',
    },
  });

  const openedRes = await handler({
    secret: SECRET,
    rawBody: openedBody,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'gh_deliv_pr_108_open',
      'x-hub-signature-256': signGithubWebhookPayload(SECRET, openedBody),
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(openedRes.status, 200);
  assert.equal(harness.recordedCalls.length, 1);
  assert.equal(harness.recordedCalls[0].path, '/api/v1/extensions/channels/chan_pr_reviews/messages');
  assert.ok(!String(harness.recordedCalls[0].body.text).includes('<script>'));
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[PR OPENED] **kodera-hq/kodera#108**'));

  const reviewBody = JSON.stringify({
    action: 'submitted',
    repository: { full_name: 'kodera-hq/kodera' },
    pull_request: {
      number: 108,
      html_url: 'https://github.com/kodera-hq/kodera/pull/108',
    },
    review: {
      id: 901,
      state: 'approved',
      user: { login: 'lours' },
      body: 'Constant-time signature check verified.',
      html_url: 'https://github.com/kodera-hq/kodera/pull/108#pullrequestreview-901',
    },
  });

  const reviewRes = await handler({
    secret: SECRET,
    rawBody: reviewBody,
    headers: {
      'x-github-event': 'pull_request_review',
      'x-github-delivery': 'gh_deliv_pr_108_rev',
      'x-hub-signature-256': signGithubWebhookPayload(SECRET, reviewBody),
    },
    nowUnixSeconds: harness.getNow() + 5,
    client: harness.client,
  });

  assert.equal(reviewRes.status, 200);
  assert.equal(harness.recordedCalls.length, 2);
  assert.match(
    harness.recordedCalls[1].path,
    /^\/api\/v1\/extensions\/channels\/chan_pr_reviews\/threads\/msg_test_1\/replies$/
  );
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[PR APPROVED]'));

  const mergedBody = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'kodera-hq/kodera' },
    pull_request: {
      number: 108,
      merged: true,
      title: 'Harden webhook replay verification',
      user: { login: 'miguel' },
      head: { ref: 'feat/replay-guard' },
      base: { ref: 'main' },
      html_url: 'https://github.com/kodera-hq/kodera/pull/108',
    },
  });

  await handler({
    secret: SECRET,
    rawBody: mergedBody,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'gh_deliv_pr_108_merge',
      'x-hub-signature-256': signGithubWebhookPayload(SECRET, mergedBody),
    },
    nowUnixSeconds: harness.getNow() + 10,
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 3);
  assert.ok(String(harness.recordedCalls[2].body.text).includes('[PR MERGED]'));
});

test('github check_suite, workflow_run, issues, and release events publish validated cards', async () => {
  const handler = createGithubWebhookHandler({
    secret: SECRET,
    defaultChannelId: 'chan_ci',
    allowEphemeralReplayStore: true,
  });
  const harness = createExtensionTestHarness({ secret: SECRET, handler });

  const workflowBody = JSON.stringify({
    action: 'completed',
    repository: { full_name: 'kodera-hq/kodera' },
    workflow_run: {
      id: 44012,
      name: 'Security & SDK Suite',
      head_branch: 'main',
      head_sha: '60e7a01deadbeef1234567890abcdef123456789',
      conclusion: 'failure',
      html_url: 'https://github.com/kodera-hq/kodera/actions/runs/44012',
    },
  });

  await handler({
    secret: SECRET,
    rawBody: workflowBody,
    headers: {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'gh_wf_44012',
      'x-hub-signature-256': signGithubWebhookPayload(SECRET, workflowBody),
    },
    nowUnixSeconds: harness.getNow(),
    client: harness.client,
  });

  assert.equal(harness.recordedCalls.length, 1);
  assert.ok(String(harness.recordedCalls[0].body.text).includes('[CI FAILURE] **kodera-hq/kodera** Security & SDK Suite `failure` on `main` (`60e7a01`)'));

  await harness.sendWebhook({
    event: 'issues',
    deliveryId: 'kodera_issue_42',
    payload: {
      type: 'issues',
      action: 'opened',
      repository: { full_name: 'kodera-hq/kodera' },
      issue: {
        number: 42,
        title: 'Audit webhook signature replay window',
        user: { login: 'david' },
        labels: [{ name: 'security' }, { name: 'triage' }],
        html_url: 'https://github.com/kodera-hq/kodera/issues/42',
      },
    },
  });

  assert.equal(harness.recordedCalls.length, 2);
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[ISSUE OPENED] **kodera-hq/kodera#42**'));
  assert.ok(String(harness.recordedCalls[1].body.text).includes('[security, triage]'));

  await harness.sendWebhook({
    event: 'release.published',
    deliveryId: 'kodera_rel_020',
    payload: {
      type: 'release.published',
      repository: 'kodera-hq/kodera',
      tag: 'v0.2.0',
      notes: 'Signed connector pack',
      url: 'https://github.com/kodera-hq/kodera/releases/tag/v0.2.0',
    },
  });

  assert.equal(harness.recordedCalls.length, 3);
  assert.ok(String(harness.recordedCalls[2].body.text).includes('[RELEASE] **kodera-hq/kodera v0.2.0**'));
});

test('github refuses tampered X-Hub-Signature-256, spoofed X-GitHub-Event header, replays, and SSRF URLs', async () => {
  const handler = createGithubWebhookHandler({ secret: SECRET, allowEphemeralReplayStore: true });
  const rawBody = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'kodera-hq/kodera' },
    issue: {
      number: 9,
      title: 'Test',
      html_url: 'https://github.com/kodera-hq/kodera/issues/9',
    },
  });
  const sig = signGithubWebhookPayload(SECRET, rawBody);

  // Tampered body with valid-format signature
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody: `${rawBody} `,
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'gh_tampered_1',
          'x-hub-signature-256': sig,
        },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH'
  );

  // Spoofed unsigned X-GitHub-Event header that disagrees with signed payload
  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody,
        headers: {
          'x-github-event': 'release',
          'x-github-delivery': 'gh_spoofed_evt',
          'x-hub-signature-256': sig,
        },
        nowUnixSeconds: 1_762_525_000,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'INVALID_EVENT'
  );

  // First valid delivery accepted, second replay rejected even with rotated unsigned delivery id
  await handler({
    secret: SECRET,
    rawBody,
    headers: {
      'x-github-event': 'issues',
      'x-github-delivery': 'gh_first_ok',
      'x-hub-signature-256': sig,
    },
    nowUnixSeconds: 1_762_525_000,
  });

  await assert.rejects(
    () =>
      handler({
        secret: SECRET,
        rawBody,
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'gh_rotated_delivery_id',
          'x-hub-signature-256': sig,
        },
        nowUnixSeconds: 1_762_525_010,
      }),
    (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
  );

  // SSRF / untrusted host rejection
  assert.throws(
    () => validateGithubUrl('https://169.254.169.254/latest/meta-data/'),
    (err) => err instanceof ExtensionSdkError && err.code === 'SSRF_FORBIDDEN_IP'
  );
  assert.throws(
    () => validateGithubUrl('https://evil.example.com/kodera-hq/kodera/pull/1'),
    (err) => err instanceof ExtensionSdkError && err.code === 'UNTRUSTED_GITHUB_HOST'
  );
  assert.throws(
    () => validateGithubRepoSlug('../etc/passwd'),
    (err) => err instanceof ExtensionSdkError && err.code === 'INVALID_GITHUB_REPO'
  );
});

test('/gh slash command supports status, pr, checks, and triage subcommands and sanitizes markup', () => {
  const statusRes = handleGhCommand({ args: '', channelId: 'chan_dev', actorId: 'usr_1' });
  assert.equal(statusRes.subcommand, 'status');
  assert.equal(statusRes.ephemeral, true);

  const prRes = handleGhCommand({
    args: 'pr kodera-hq/kodera --state=open --number=32',
    channelId: 'chan_dev',
    actorId: 'usr_1',
  });
  assert.equal(prRes.subcommand, 'pr');
  assert.equal(prRes.number, 32);

  const checksRes = handleGhCommand({
    args: 'checks kodera-hq/kodera --branch=feat/connectors',
    channelId: 'chan_dev',
    actorId: 'usr_1',
  });
  assert.equal(checksRes.subcommand, 'checks');
  assert.equal(checksRes.branch, 'feat/connectors');

  const triageRes = handleGhCommand({
    args: 'triage kodera-hq/kodera --number=32 --label=secops --assignee=miguel',
    channelId: 'chan_dev',
    actorId: 'usr_1',
  });
  assert.equal(triageRes.subcommand, 'triage');
  assert.equal(triageRes.ephemeral, false);

  const cleaned = sanitizeGithubText('<<script>alert(1)</script>Click javascript :alert(2)', 'fallback');
  assert.ok(!cleaned.includes('<'));
  assert.ok(!cleaned.includes('>'));
  assert.ok(cleaned.includes('blocked-scheme:alert(2)'));
});

test('github BUG-0064 blocks timeless signature replays at +10s, +301s, >24h and across restarts while rejecting stale Kodera timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kodera-gh-replay-'));
  const storePath = join(dir, 'replay.json');
  const baseNow = 1_765_000_000;
  try {
    let handler = createGithubWebhookHandler({
      secret: SECRET,
      replayStore: createDurableReplayStore(storePath),
    });
    const harness = createExtensionTestHarness({ secret: SECRET, handler, initialUnixSeconds: baseNow });

    const body1 = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'kodera-hq/kodera' },
      issue: { number: 101, title: 'Replay check', html_url: 'https://github.com/kodera-hq/kodera/issues/101' },
    });
    const sig1 = signGithubWebhookPayload(SECRET, body1);

    await handler({
      rawBody: body1,
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': 'gh_deliv_initial',
        'x-hub-signature-256': sig1,
      },
      nowUnixSeconds: baseNow,
      client: harness.client,
    });
    assert.equal(harness.recordedCalls.length, 1);

    for (const delta of [10, 301, 90_000]) {
      await assert.rejects(
        () =>
          handler({
            rawBody: body1,
            headers: {
              'x-github-event': 'issues',
              'x-github-delivery': `gh_deliv_replay_${delta}`,
              'x-hub-signature-256': sig1,
            },
            nowUnixSeconds: baseNow + delta,
            client: harness.client,
          }),
        (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
      );
    }

    // Restart handler against the same durable store and rotate unsigned delivery ID
    handler = createGithubWebhookHandler({
      secret: SECRET,
      replayStore: createDurableReplayStore(storePath),
    });
    await assert.rejects(
      () =>
        handler({
          rawBody: body1,
          headers: {
            'x-github-event': 'issues',
            'x-github-delivery': 'gh_deliv_after_restart',
            'x-hub-signature-256': sig1,
          },
          nowUnixSeconds: baseNow + 120_000,
          client: harness.client,
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED'
    );
    assert.equal(harness.recordedCalls.length, 1);

    // Genuinely new signed event still dispatches
    const body2 = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'kodera-hq/kodera' },
      issue: { number: 102, title: 'Fresh event', html_url: 'https://github.com/kodera-hq/kodera/issues/102' },
    });
    await handler({
      rawBody: body2,
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': 'gh_deliv_fresh_102',
        'x-hub-signature-256': signGithubWebhookPayload(SECRET, body2),
      },
      nowUnixSeconds: baseNow + 120_005,
      client: harness.client,
    });
    assert.equal(harness.recordedCalls.length, 2);

    // Canonical Kodera signed webhook still enforces stale timestamp rejection
    const harnessRestarted = createExtensionTestHarness({
      secret: SECRET,
      handler,
      nowUnixSeconds: baseNow + 120_010,
    });
    await assert.rejects(
      () =>
        harnessRestarted.sendWebhook({
          event: 'issues',
          deliveryId: 'kodera_stale_ts',
          timestampSeconds: baseNow + 120_010 - 600,
          payload: {
            type: 'issues',
            action: 'opened',
            repository: { full_name: 'kodera-hq/kodera' },
            issue: { number: 103, title: 'Stale', html_url: 'https://github.com/kodera-hq/kodera/issues/103' },
          },
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'TIMESTAMP_OUT_OF_RANGE'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github BUG-0064 requires durable backing independently of NODE_ENV and blocks cross-process replays at +90000s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kodera-gh-mw-'));
  const prevReplayDir = process.env.KODERA_WEBHOOK_REPLAY_DIR;
  try {
    delete process.env.KODERA_WEBHOOK_REPLAY_DIR;

    // Ephemeral store truthfully reports durable === false; missing durable dir throws regardless of NODE_ENV
    assert.equal(createDurableReplayStore(undefined, { allowEphemeral: true }).durable, false);
    assert.throws(
      () => createDurableReplayStore(),
      (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_STORE_NOT_DURABLE'
    );

    const storeA = createDurableReplayStore(join(dir, 'shared'));
    const storeB = createDurableReplayStore(join(dir, 'shared'));
    assert.equal(storeA.durable, true);
    assert.equal(storeA.claim('sig:writer-a', { recordedAt: 100, expiresAt: null }, 100), true);
    assert.equal(storeB.claim('sig:writer-b', { recordedAt: 101, expiresAt: null }, 101), true);
    const storeRestarted = createDurableReplayStore(join(dir, 'shared'));
    assert.equal(storeRestarted.has('sig:writer-a'), true);
    assert.equal(storeRestarted.has('sig:writer-b'), true);
    assert.equal(storeRestarted.claim('sig:writer-a', { recordedAt: 200, expiresAt: null }, 200), false);
    assert.equal(storeRestarted.claim('sig:writer-b', { recordedAt: 200, expiresAt: null }, 200), false);

    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'kodera-hq/kodera' },
      issue: { number: 301, title: 'Default durable check', html_url: 'https://github.com/kodera-hq/kodera/issues/301' },
    });
    const sig = signGithubWebhookPayload(SECRET, body);
    const baseNow = 1_760_100_000;

    // Handler without replayStoreDir or KODERA_WEBHOOK_REPLAY_DIR fails closed even in non-production NODE_ENV
    const hMissingDurable = createGithubWebhookHandler({
      secret: SECRET,
      defaultChannelId: 'chan_missing_durable',
    });
    await assert.rejects(
      () =>
        hMissingDurable({
          rawBody: body,
          headers: {
            'x-github-event': 'issues',
            'x-github-delivery': 'gh_deliv_missing_durable',
            'x-hub-signature-256': sig,
          },
          nowUnixSeconds: baseNow,
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_STORE_NOT_DURABLE'
    );

    // Non-durable Map (even with spoofed .durable = true) is refused for timeless signatures
    const spoofedMap = Object.assign(new Map(), { durable: true });
    const hEphemeral = createGithubWebhookHandler({
      secret: SECRET,
      defaultChannelId: 'chan_ephemeral_refusal',
      replayStore: spoofedMap,
    });
    await assert.rejects(
      () =>
        hEphemeral({
          rawBody: body,
          headers: {
            'x-github-event': 'issues',
            'x-github-delivery': 'gh_deliv_ephemeral',
            'x-hub-signature-256': sig,
          },
          nowUnixSeconds: baseNow,
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_STORE_NOT_DURABLE'
    );

    // Separate OS processes sharing KODERA_WEBHOOK_REPLAY_DIR persist across process exit and reject replay at +90,000s
    const sharedEnvDir = join(dir, 'env-replay');
    const indexUrl = new URL('../index.mjs', import.meta.url).href;
    const workerScript = `
      import { createGithubWebhookHandler } from ${JSON.stringify(indexUrl)};
      const handler = createGithubWebhookHandler({
        secret: process.env.TEST_WH_SECRET,
        defaultChannelId: 'chan_recreate_check',
      });
      try {
        await handler({
          rawBody: process.env.TEST_BODY,
          headers: {
            'x-github-event': 'issues',
            'x-github-delivery': process.env.TEST_DELIVERY,
            'x-hub-signature-256': process.env.TEST_SIG,
          },
          nowUnixSeconds: Number(process.env.TEST_NOW),
        });
        process.stdout.write('ACCEPTED');
      } catch (err) {
        process.stdout.write(String(err.code || err.message));
      }
    `;
    const firstOut = execFileSync(process.execPath, ['--input-type=module', '-e', workerScript], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        KODERA_WEBHOOK_REPLAY_DIR: sharedEnvDir,
        TEST_WH_SECRET: SECRET,
        TEST_BODY: body,
        TEST_SIG: sig,
        TEST_DELIVERY: 'gh_deliv_proc_1',
        TEST_NOW: String(baseNow),
      },
      encoding: 'utf8',
    });
    assert.equal(firstOut, 'ACCEPTED');

    const secondOut = execFileSync(process.execPath, ['--input-type=module', '-e', workerScript], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        KODERA_WEBHOOK_REPLAY_DIR: sharedEnvDir,
        TEST_WH_SECRET: SECRET,
        TEST_BODY: body,
        TEST_SIG: sig,
        TEST_DELIVERY: 'gh_deliv_proc_2',
        TEST_NOW: String(baseNow + 90_000),
      },
      encoding: 'utf8',
    });
    assert.equal(secondOut, 'REPLAY_DETECTED');
  } finally {
    if (prevReplayDir === undefined) {
      delete process.env.KODERA_WEBHOOK_REPLAY_DIR;
    } else {
      process.env.KODERA_WEBHOOK_REPLAY_DIR = prevReplayDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

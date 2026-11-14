import test from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ExtensionSdkError,
  MANIFEST_SCHEMA_VERSION,
  WebhookVerificationError,
  createExtensionTestHarness,
  validateEndpointUrl,
  validateManifest,
} from '../src/index.mjs';

const EXTENSIONS_DIR = fileURLToPath(new URL('../../../extensions', import.meta.url));
const REVERSE_DNS_PREFIX = 'io.kodera.ext.';
const REVERSE_DNS_REGEX = /^io\.kodera\.ext\.([a-z0-9][a-z0-9-]{1,62})$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONFORMANCE_SECRET = 'whsec_conformance_suite_0123456789abcdef';

/**
 * Normalizes a raw extension manifest (`extension.json`, `manifest.json`, or `kodera-extension.json`)
 * and validates it against `@kodera/extension-sdk`'s `validateManifest`.
 *
 * @param {Record<string, unknown>} raw
 */
function normalizeAndValidateExtensionManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExtensionSdkError('INVALID_MANIFEST', 'Manifest must be a JSON object.');
  }

  const schemaVersion = String(raw.schemaVersion ?? raw.schema ?? '');
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_SCHEMA',
      `Expected schema "${MANIFEST_SCHEMA_VERSION}", received "${schemaVersion}".`
    );
  }

  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  let slug = '';
  let canonicalId = '';

  const reverseMatch = REVERSE_DNS_REGEX.exec(rawId);
  if (reverseMatch) {
    slug = reverseMatch[1];
    canonicalId = rawId;
  } else if (SLUG_REGEX.test(rawId)) {
    slug = rawId;
    canonicalId = `${REVERSE_DNS_PREFIX}${rawId}`;
  } else {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_ID',
      `Invalid extension id "${rawId}"; expected reverse-DNS "io.kodera.ext.<slug>" or lowercase slug.`
    );
  }

  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes
    : Array.isArray(raw.permissions)
      ? raw.permissions
      : [];

  const rawCommands = Array.isArray(raw.commands) ? raw.commands : [];
  const commands = rawCommands.map((cmd) => {
    if (!cmd || typeof cmd !== 'object') {
      return cmd;
    }
    const record = /** @type {Record<string, unknown>} */ (cmd);
    return {
      name: String(record.name ?? record.command ?? ''),
      description: String(record.description ?? ''),
    };
  });

  const description =
    typeof raw.description === 'string' && raw.description.trim().length > 0
      ? raw.description.trim()
      : `${String(raw.name ?? slug)} reference Kodera extension.`;

  const validated = validateManifest({
    ...raw,
    schemaVersion,
    id: slug,
    description,
    scopes,
    commands,
  });

  return {
    canonicalId,
    slug,
    validated,
  };
}

/**
 * Discovers all extension directories under `extensions/*`.
 */
function discoverExtensions() {
  const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  return entries.map((dirName) => {
    const extRoot = join(EXTENSIONS_DIR, dirName);
    const extensionJsonPath = join(extRoot, 'extension.json');
    const manifestJsonPath = join(extRoot, 'manifest.json');
    const koderaManifestPath = join(extRoot, 'kodera-extension.json');
    const manifestPath = existsSync(extensionJsonPath)
      ? extensionJsonPath
      : existsSync(manifestJsonPath)
        ? manifestJsonPath
        : koderaManifestPath;

    const rootIndexPath = join(extRoot, 'index.mjs');
    const srcIndexPath = join(extRoot, 'src', 'index.mjs');
    const entryPath = existsSync(rootIndexPath) ? rootIndexPath : srcIndexPath;

    return {
      dirName,
      extRoot,
      manifestPath,
      entryPath,
    };
  });
}

const REQUIRED_EXTENSION_DIRS = Object.freeze([
  'alertmanager',
  'docs-collab-announcer',
  'frameio-review-bridge',
  'gdrive-document-share',
  'git-tracker',
  'github',
  'github-release-notifier',
  'github-repo-tracker',
  'gitlab',
  'hello-webhook',
  'linear',
  'notion-workspace-bridge',
  'qonto-treasury-feed',
  'rss-advisories',
  'sentry',
  'social-pulse-bridge',
  'uptime-incident-bridge',
]);

const REQUIRED_SLASH_COMMANDS = Object.freeze([
  'advisories',
  'alerts',
  'doc-pad',
  'frameio-review',
  'gdrive-share',
  'gh',
  'github-track',
  'gitlab',
  'hello',
  'incident-bridge',
  'linear',
  'notion-page',
  'qonto-feed',
  'release-notes',
  'sentry',
  'social-post',
]);

test('conformance: dynamically discovers all reference extensions under extensions/*', () => {
  const discovered = discoverExtensions();
  const dirNames = discovered.map((item) => item.dirName);

  assert.ok(discovered.length >= REQUIRED_EXTENSION_DIRS.length);
  for (const requiredDir of REQUIRED_EXTENSION_DIRS) {
    assert.ok(dirNames.includes(requiredDir), `Expected extension directory "${requiredDir}"`);
  }

  for (const item of discovered) {
    assert.ok(existsSync(item.manifestPath), `Missing manifest file for ${item.dirName}`);
    assert.ok(existsSync(item.entryPath), `Missing index.mjs entrypoint for ${item.dirName}`);
  }
});

test('conformance: every extension manifest passes validateManifest, SSRF checks, and global uniqueness across extensions/*', () => {
  const discovered = discoverExtensions();
  const seenCanonicalIds = new Set();
  const seenSlugs = new Set();
  const seenCommands = new Set();
  const seenWebhookUrls = new Set();

  const ssrfVectors = [
    { url: 'http://extensions.kodera.io/insecure', expectedCode: 'SSRF_INSECURE_PROTOCOL' },
    { url: 'https://127.0.0.1/webhook', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://169.254.169.254/latest/meta-data/', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://10.0.0.15/internal', expectedCode: 'SSRF_FORBIDDEN_IP' },
    { url: 'https://user:secret@extensions.kodera.io/hook', expectedCode: 'SSRF_EMBEDDED_CREDENTIALS' },
  ];

  for (const item of discovered) {
    const rawManifest = JSON.parse(readFileSync(item.manifestPath, 'utf8'));
    const { canonicalId, slug, validated } = normalizeAndValidateExtensionManifest(rawManifest);

    assert.equal(validated.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(slug, item.dirName, `Extension slug "${slug}" must match directory "${item.dirName}"`);
    assert.match(canonicalId, REVERSE_DNS_REGEX);
    assert.ok(Object.isFrozen(validated));

    assert.ok(
      typeof validated.webhookUrl === 'string' && validated.webhookUrl.startsWith('https://'),
      `Extension ${item.dirName} must declare an HTTPS webhookUrl`
    );
    assert.equal(
      validateEndpointUrl(validated.webhookUrl, { allowLocalhostHttp: false }),
      validated.webhookUrl
    );

    // Every one of the 9 extensions must refuse SSRF webhookUrl overrides
    for (const vector of ssrfVectors) {
      assert.throws(
        () =>
          normalizeAndValidateExtensionManifest({
            ...rawManifest,
            webhookUrl: vector.url,
          }),
        (err) => err instanceof ExtensionSdkError && err.code === vector.expectedCode,
        `Extension ${item.dirName} must reject SSRF vector ${vector.url} (${vector.expectedCode})`
      );
    }

    assert.ok(
      !seenCanonicalIds.has(canonicalId),
      `Duplicate extension canonical id "${canonicalId}" across extensions/*`
    );
    seenCanonicalIds.add(canonicalId);

    assert.ok(!seenSlugs.has(slug), `Duplicate extension slug "${slug}" across extensions/*`);
    seenSlugs.add(slug);

    assert.ok(
      !seenWebhookUrls.has(validated.webhookUrl),
      `Duplicate webhookUrl "${validated.webhookUrl}" across extensions/*`
    );
    seenWebhookUrls.add(validated.webhookUrl);

    if (item.dirName === 'git-tracker') {
      assert.deepEqual(validated.scopes, ['messages:write', 'webhooks:incoming']);
      assert.deepEqual(validated.commands, []);
    } else assert.ok(validated.commands.length > 0, `Extension ${item.dirName} must register at least one slash command`);
    for (const cmd of validated.commands) {
      assert.match(cmd.name, /^[a-z0-9][a-z0-9-]{1,31}$/);
      assert.ok(
        !seenCommands.has(cmd.name),
        `Duplicate slash command "/${cmd.name}" declared by ${item.dirName}`
      );
      seenCommands.add(cmd.name);
    }
  }

  assert.equal(seenCanonicalIds.size, discovered.length);
  for (const requiredCmd of REQUIRED_SLASH_COMMANDS) {
    assert.ok(seenCommands.has(requiredCmd), `Expected slash command "/${requiredCmd}"`);
  }
});

test('conformance: every extension index.mjs exports valid handlers and rejects forged HMAC signatures and expired replay timestamps', async () => {
  const discovered = discoverExtensions();

  for (const item of discovered) {
    const rawManifest = JSON.parse(readFileSync(item.manifestPath, 'utf8'));
    const { validated } = normalizeAndValidateExtensionManifest(rawManifest);
    if (item.dirName === 'git-tracker') {
      const mod = await import(pathToFileURL(item.entryPath).href);
      const tracker = mod.createGitTracker({
        provider: 'github', secret: CONFORMANCE_SECRET, hookId: 'conformance', channelId: 'private-channel',
        repositories: [{ slug: 'example/project', defaultBranch: 'main' }],
        deliveryStore: mod.createMemoryDeliveryStore(), client: { async postChannelMessage() {} },
      });
      const rawBody = JSON.stringify({ repository: { full_name: 'example/project' }, action: 'opened', issue: { number: 1 } });
      const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'native-delivery', 'x-hub-signature-256': `sha256=${createHmac('sha256', CONFORMANCE_SECRET).update(rawBody).digest('hex')}` };
      await assert.rejects(tracker.receive({ headers, rawBody: rawBody + ' ' }), { code: 'INVALID_SIGNATURE' });
      assert.equal((await tracker.receive({ headers, rawBody })).status, 'queued');
      assert.equal((await tracker.receive({ headers: { ...headers, 'x-github-delivery': 'changed-unsigned-id' }, rawBody })).status, 'duplicate');
      continue;
    }
    const primaryCommand = validated.commands[0].name;

    const mod = await import(pathToFileURL(item.entryPath).href);

    // Resolve exported slash command object across all reference extensions
    const exportedCommand =
      mod.slashCommand ??
      mod.ghCommand ??
      mod.gitlabCommand ??
      mod.linearCommand ??
      mod.sentryCommand ??
      mod.alertsCommand ??
      mod.advisoriesCommand ??
      mod.frameioReviewCommand ??
      mod.docPadCommand ??
      mod.gdriveShareCommand ??
      mod.githubTrackCommand ??
      mod.helloCommand ??
      mod.incidentBridgeCommand ??
      mod.notionPageCommand ??
      mod.qontoFeedCommand ??
      mod.releaseNotesCommand ??
      mod.socialPostCommand;
    assert.ok(exportedCommand, `Extension ${item.dirName} must export its slash command definition`);
    assert.equal(exportedCommand.name, primaryCommand);
    assert.equal(typeof exportedCommand.handler, 'function');

    // Resolve or instantiate webhook handler across all reference extensions
    const handlerFactory =
      mod.createExtensionWebhookHandler ??
      mod.createGithubWebhookHandler ??
      mod.createGitlabWebhookHandler ??
      mod.createLinearWebhookHandler ??
      mod.createSentryWebhookHandler ??
      mod.createAlertmanagerWebhookHandler ??
      mod.createRssAdvisoriesWebhookHandler ??
      mod.createFrameioWebhookHandler ??
      mod.createDocsCollabWebhookHandler ??
      mod.createGdriveShareWebhookHandler ??
      mod.createGithubRepoTrackerWebhookHandler ??
      mod.createNotionWorkspaceWebhookHandler ??
      mod.createQontoTreasuryWebhookHandler ??
      mod.createReleaseNotifierWebhookHandler ??
      mod.createSocialPulseWebhookHandler ??
      mod.createUptimeIncidentBridgeHandler;

    const webhookHandler =
      typeof handlerFactory === 'function'
        ? handlerFactory({ secret: CONFORMANCE_SECRET })
        : mod.handleIncomingWebhook;

    assert.equal(
      typeof webhookHandler,
      'function',
      `Extension ${item.dirName} must export a callable webhook handler or factory`
    );

    const harness = createExtensionTestHarness({
      secret: CONFORMANCE_SECRET,
      handler: webhookHandler,
      nowSeconds: 1_762_525_000,
    });

    // 1. Valid signed slash-command webhook delivery succeeds
    const validDelivery = await harness.sendWebhook({
      event: 'command.invoked',
      deliveryId: `conf_valid_${item.dirName}`,
      payload: {
        type: 'command.invoked',
        command: primaryCommand,
        args: '',
        channelId: 'chan_conformance',
        actorId: 'usr_conformance',
      },
    });
    assert.ok(validDelivery.response, `Expected non-empty response from ${item.dirName}`);

    // 2. Forged HMAC signature is rejected with SIGNATURE_MISMATCH
    await assert.rejects(
      () =>
        harness.sendWebhook({
          event: 'command.invoked',
          deliveryId: `conf_forged_${item.dirName}`,
          secretOverride: 'whsec_forged_attacker_secret_00000000',
          payload: {
            type: 'command.invoked',
            command: primaryCommand,
            args: '',
            channelId: 'chan_conformance',
            actorId: 'usr_conformance',
          },
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'SIGNATURE_MISMATCH',
      `Extension ${item.dirName} must reject forged HMAC signatures`
    );

    // 3. Expired replay timestamp (outside 300s skew window) is rejected with TIMESTAMP_OUT_OF_RANGE
    await assert.rejects(
      () =>
        harness.sendWebhook({
          event: 'command.invoked',
          deliveryId: `conf_expired_${item.dirName}`,
          timestampSeconds: harness.getNow() - 900,
          payload: {
            type: 'command.invoked',
            command: primaryCommand,
            args: '',
            channelId: 'chan_conformance',
            actorId: 'usr_conformance',
          },
        }),
      (err) => err instanceof WebhookVerificationError && err.code === 'TIMESTAMP_OUT_OF_RANGE',
      `Extension ${item.dirName} must reject expired replay timestamps`
    );

    // 4. Replayed deliveryId on createWebhookHandler-based extensions is rejected with REPLAY_DETECTED
    if (typeof handlerFactory === 'function') {
      await assert.rejects(
        () =>
          harness.sendWebhook({
            event: 'command.invoked',
            deliveryId: `conf_valid_${item.dirName}`,
            payload: {
              type: 'command.invoked',
              command: primaryCommand,
              args: '',
              channelId: 'chan_conformance',
              actorId: 'usr_conformance',
            },
          }),
        (err) => err instanceof WebhookVerificationError && err.code === 'REPLAY_DETECTED',
        `Extension ${item.dirName} must reject duplicate delivery IDs`
      );
    }
  }
});

test('conformance: verifies deterministic IBAN masking in qonto-treasury-feed and tracking-parameter stripping in social-pulse-bridge', async () => {
  const qontoMod = await import(
    pathToFileURL(join(EXTENSIONS_DIR, 'qonto-treasury-feed', 'index.mjs')).href
  );
  const socialMod = await import(
    pathToFileURL(join(EXTENSIONS_DIR, 'social-pulse-bridge', 'index.mjs')).href
  );

  // 1. Qonto IBAN masking: country + check digits + masked middle + last 4 chars
  const rawIban = 'FR76 3000 6000 0112 3456 7890 189';
  const masked = qontoMod.maskIban(rawIban);
  assert.equal(masked, 'FR76 **** **** **** **** ***0 189');

  const qontoCard = qontoMod.buildQontoTreasuryCard('transfer.outgoing', {
    transactionId: 'tx_conf_01',
    amountEur: 4200,
    iban: rawIban,
    counterparty: 'Scaleway SAS',
    reference: `Facture serveur sur ${rawIban}`,
    transactionUrl: 'https://app.qonto.com/organizations/kodera/transactions/tx_conf_01',
  });
  assert.equal(qontoCard.maskedIban, 'FR76 **** **** **** **** ***0 189');
  assert.ok(qontoCard.text.includes('FR76 **** **** **** **** ***0 189'));
  assert.ok(!qontoCard.text.includes('3000 6000 0112 3456 7890'));

  // 2. Social Pulse tracking parameter stripping across X, Mastodon, and Instagram
  const xCleaned = socialMod.sanitizeSocialPostUrl(
    'https://x.com/kodera_io/status/101?utm_source=x&utm_campaign=v1&twclid=tw_secret&fbclid=fb_secret'
  );
  assert.equal(xCleaned.network, 'x');
  assert.equal(xCleaned.trackingStripped, true);
  assert.equal(xCleaned.cleanUrl, 'https://x.com/kodera_io/status/101');

  const mastoCleaned = socialMod.sanitizeSocialPostUrl(
    'https://mastodon.social/@kodera/102?utm_medium=fediverse&fbclid=fb_123'
  );
  assert.equal(mastoCleaned.network, 'mastodon');
  assert.equal(mastoCleaned.trackingStripped, true);
  assert.equal(mastoCleaned.cleanUrl, 'https://mastodon.social/@kodera/102');

  const instaCleaned = socialMod.sanitizeSocialPostUrl(
    'https://www.instagram.com/p/DB999/?igsh=insta_tracker_id&utm_term=reel'
  );
  assert.equal(instaCleaned.network, 'instagram');
  assert.equal(instaCleaned.trackingStripped, true);
  assert.equal(instaCleaned.cleanUrl, 'https://www.instagram.com/p/DB999/');
});

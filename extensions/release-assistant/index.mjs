import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_SKEW_SECONDS,
  ExtensionSdkError,
  MANIFEST_SCHEMA_VERSION,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_REPLAY_ENTRIES,
  SIGNATURE_HEADER,
  WebhookVerificationError,
  createExtensionClient,
  createWebhookHandler,
  defineSlashCommand,
  getHeaderValue,
  parseCommandInvocation,
  validateEndpointUrl,
  validateManifest,
} from '@kodera/extension-sdk';

const rawManifest = JSON.parse(
  readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')
);

const REVERSE_DNS_ID_PREFIX = 'io.kodera.ext.';
const REVERSE_DNS_ID_PATTERN = /^io\.kodera\.ext\.([a-z0-9][a-z0-9-]{1,62})$/;
const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const RELEASE_SIG_PATTERN = /^(?:sha256=)?([0-9a-fA-F]{64})$/;
const SAFE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_REPO_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,63}$/;
const CONVENTIONAL_COMMIT_PATTERN =
  /^(feat|fix|perf|security|sec|docs|refactor|chore|build|ci|test)(?:\(([A-Za-z0-9_./-]+)\))?(!)?:\s+(.+)$/i;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RELEASE_ENTRIES = 100;

/**
 * Background telemetry is permanently disabled in this reference implementation.
 */
export const TELEMETRY_ENABLED = false;

export const DEFAULT_OPT_IN_CHANNELS = Object.freeze([
  'chan_releases',
  'chan_changelog',
  'releases',
]);

export const RELEASE_ASSISTANT_SUBCOMMANDS = Object.freeze([
  'draft',
  'opt-in-check',
  'status',
]);

export const SUPPORTED_RELEASE_LOCALES = Object.freeze([
  'bilingual',
  'fr',
  'en',
]);

export const ACCEPTED_SLASH_COMMANDS = Object.freeze([
  'release-draft',
  'release-notes',
]);

/**
 * Validates and normalizes the `release-assistant` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateReleaseAssistantManifest(input = rawManifest, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExtensionSdkError('INVALID_MANIFEST', 'Extension manifest must be a non-null JSON object.');
  }

  const schemaVersion = String(input.schemaVersion ?? input.schema ?? MANIFEST_SCHEMA_VERSION);
  const rawId = typeof input.id === 'string' ? input.id.trim() : '';
  let slugId = rawId;
  let canonicalId = rawId;

  const reverseMatch = REVERSE_DNS_ID_PATTERN.exec(rawId);
  if (reverseMatch) {
    slugId = reverseMatch[1];
    canonicalId = rawId;
  } else if (SLUG_ID_PATTERN.test(rawId)) {
    slugId = rawId;
    canonicalId = `${REVERSE_DNS_ID_PREFIX}${rawId}`;
  } else {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_ID',
      `Manifest "id" must be "io.kodera.ext.<slug>" or a lowercase slug (received "${rawId}").`
    );
  }

  const rawScopes = Array.isArray(input.scopes)
    ? input.scopes
    : Array.isArray(input.permissions)
      ? input.permissions
      : [];

  const rawCommands = Array.isArray(input.commands) ? input.commands : [];
  const normalizedCommands = rawCommands.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const rec = /** @type {Record<string, unknown>} */ (entry);
    return {
      ...rec,
      name: String(rec.name ?? rec.command ?? ''),
      description: String(rec.description ?? ''),
    };
  });

  const sdkValidated = validateManifest(
    {
      ...input,
      schemaVersion,
      id: slugId,
      scopes: rawScopes,
      commands: normalizedCommands,
    },
    options
  );

  return Object.freeze({
    ...sdkValidated,
    schema: schemaVersion,
    canonicalId,
    slug: slugId,
    permissions: sdkValidated.scopes,
  });
}

export const extensionManifest = validateReleaseAssistantManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeReleaseText(rawValue, fallback = '', maxLength = 220) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const bounded = rawValue.length > 16_384 ? rawValue.slice(0, 16_384) : rawValue;
  let out = '';
  let inTag = false;
  let lastSpace = true;

  for (let i = 0; i < bounded.length; i += 1) {
    const ch = bounded[i];
    const code = bounded.charCodeAt(i);
    if (ch === '<') {
      inTag = true;
      if (!lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (inTag) {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      if ((ch === '\n' || ch === '\r' || ch === '\t') && !lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '`' || ch === '~' || ch === '[' || ch === ']') {
      continue;
    }
    if (ch === ' ') {
      if (!lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    out += ch;
    lastSpace = false;
  }

  let cleaned = out.trim();
  if (cleaned.includes(':')) {
    cleaned = cleaned
      .replaceAll(/javascript\s*:/gi, 'blocked-scheme:')
      .replaceAll(/vbscript\s*:/gi, 'blocked-scheme:')
      .replaceAll(/data\s*:/gi, 'blocked-scheme:');
  }
  if (!cleaned) {
    return fallback;
  }
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength)}…`;
  }
  return cleaned;
}

/**
 * Asserts that a target room has explicitly opted into the release assistant capability scope.
 *
 * @param {string} channelId
 * @param {readonly string[]} [optInChannels]
 */
export function assertRoomOptedIn(channelId, optInChannels = DEFAULT_OPT_IN_CHANNELS) {
  const normalized = typeof channelId === 'string' ? channelId.trim() : '';
  if (!normalized || !optInChannels.includes(normalized)) {
    throw new ExtensionSdkError(
      'ROOM_NOT_OPTED_IN',
      `Channel "${normalized || 'unknown'}" has not opted into release-assistant capability scope.`
    );
  }
}

/**
 * Parses conventional commit lines and merged pull requests into deterministic bilingual (`fr`/`en`)
 * release notes without requiring any external inference service.
 *
 * @param {{
 *   versionTag: unknown,
 *   repository?: unknown,
 *   commits?: readonly unknown[],
 *   pullRequests?: readonly unknown[],
 *   locale?: 'bilingual' | 'fr' | 'en',
 * }} input
 */
export function formatBilingualReleaseNotes(input) {
  const rawTag = String(input?.versionTag ?? '').trim();
  if (!SAFE_TAG_PATTERN.test(rawTag) || rawTag.includes('..')) {
    throw new ExtensionSdkError('INVALID_RELEASE_TAG', `Invalid release version tag "${rawTag}".`);
  }

  const rawRepo =
    typeof input?.repository === 'string' && input.repository.trim()
      ? input.repository.trim()
      : 'kodera-hq/kodera';
  if (!SAFE_REPO_PATTERN.test(rawRepo) || rawRepo.includes('..')) {
    throw new ExtensionSdkError('INVALID_REPOSITORY', `Invalid repository slug "${rawRepo}".`);
  }

  const locale = input?.locale ?? 'bilingual';
  if (!SUPPORTED_RELEASE_LOCALES.includes(locale)) {
    throw new ExtensionSdkError(
      'INVALID_LOCALE',
      `Unsupported locale "${String(locale)}"; expected: ${SUPPORTED_RELEASE_LOCALES.join(', ')}.`
    );
  }

  const buckets = {
    breaking: /** @type {string[]} */ ([]),
    security: /** @type {string[]} */ ([]),
    features: /** @type {string[]} */ ([]),
    fixes: /** @type {string[]} */ ([]),
    maintenance: /** @type {string[]} */ ([]),
  };

  const rawCommits = Array.isArray(input?.commits) ? input.commits.slice(0, MAX_RELEASE_ENTRIES) : [];
  for (const entry of rawCommits) {
    const rawMsg =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? String((/** @type {Record<string, unknown>} */ (entry)).message ?? '')
          : '';
    const firstLine = sanitizeReleaseText(rawMsg.split('\n')[0] ?? '', '', 180);
    if (!firstLine) continue;

    const match = CONVENTIONAL_COMMIT_PATTERN.exec(firstLine);
    if (!match) {
      buckets.maintenance.push(firstLine);
      continue;
    }

    const type = match[1].toLowerCase();
    const scope = match[2] ? `(${match[2]}) ` : '';
    const isBreaking = Boolean(match[3]) || /breaking change/i.test(rawMsg);
    const summary = match[4].trim();
    const line = `${scope}${summary}`;

    if (isBreaking) {
      buckets.breaking.push(line);
    } else if (type === 'security' || type === 'sec') {
      buckets.security.push(line);
    } else if (type === 'feat') {
      buckets.features.push(line);
    } else if (type === 'fix' || type === 'perf') {
      buckets.fixes.push(line);
    } else {
      buckets.maintenance.push(line);
    }
  }

  const rawPrs = Array.isArray(input?.pullRequests) ? input.pullRequests.slice(0, MAX_RELEASE_ENTRIES) : [];
  for (const prEntry of rawPrs) {
    if (!prEntry || typeof prEntry !== 'object') continue;
    const pr = /** @type {Record<string, unknown>} */ (prEntry);
    const num = Number(pr.number);
    const suffix = Number.isSafeInteger(num) && num > 0 ? ` (#${num})` : '';
    const title = sanitizeReleaseText(pr.title, '', 160);
    if (!title) continue;
    const labels = Array.isArray(pr.labels)
      ? pr.labels.map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())
      : [];

    const item = `${title}${suffix}`;
    if (labels.includes('breaking')) {
      buckets.breaking.push(item);
    } else if (labels.includes('security')) {
      buckets.security.push(item);
    } else if (labels.includes('bug') || labels.includes('fix') || labels.includes('performance')) {
      buckets.fixes.push(item);
    } else if (labels.includes('docs') || labels.includes('chore')) {
      buckets.maintenance.push(item);
    } else {
      buckets.features.push(item);
    }
  }

  const totalEntries =
    buckets.breaking.length +
    buckets.security.length +
    buckets.features.length +
    buckets.fixes.length +
    buckets.maintenance.length;

  const renderSectionBlock = (headings) => {
    const lines = [`### ${headings.header} — ${rawRepo} ${rawTag}`];
    if (totalEntries === 0) {
      lines.push(`- ${headings.empty}`);
      return lines.join('\n');
    }
    const order = [
      ['breaking', headings.breaking],
      ['security', headings.security],
      ['features', headings.features],
      ['fixes', headings.fixes],
      ['maintenance', headings.maintenance],
    ];
    for (const [key, label] of order) {
      const items = buckets[key];
      if (items.length === 0) continue;
      lines.push(`**${label}**`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    }
    return lines.join('\n');
  };

  const frMarkdown = renderSectionBlock({
    header: 'Notes de version (FR)',
    breaking: 'Changements majeurs',
    security: 'Sécurité',
    features: 'Nouveautés',
    fixes: 'Correctifs & Performances',
    maintenance: 'Documentation & Maintenance',
    empty: 'Aucun commit ou changement répertorié pour cette version.',
  });

  const enMarkdown = renderSectionBlock({
    header: 'Release Notes (EN)',
    breaking: 'Breaking Changes',
    security: 'Security',
    features: 'Features',
    fixes: 'Fixes & Performance',
    maintenance: 'Documentation & Maintenance',
    empty: 'No commits or merged pull requests listed for this release.',
  });

  const markdown =
    locale === 'fr'
      ? frMarkdown
      : locale === 'en'
        ? enMarkdown
        : `${frMarkdown}\n\n${enMarkdown}`;

  return Object.freeze({
    repository: rawRepo,
    versionTag: rawTag,
    locale,
    mode: 'deterministic',
    telemetryEnabled: TELEMETRY_ENABLED,
    counts: Object.freeze({
      total: totalEntries,
      breaking: buckets.breaking.length,
      security: buckets.security.length,
      features: buckets.features.length,
      fixes: buckets.fixes.length,
      maintenance: buckets.maintenance.length,
    }),
    frMarkdown,
    enMarkdown,
    markdown,
  });
}

/**
 * Builds a validated HTTPS request descriptor for an optional self-hosted Ollama or vLLM
 * chat-completions endpoint (`validateEndpointUrl` enforces strict anti-SSRF refusal of HTTP,
 * loopback, link-local metadata, RFC1918 private ranges, and embedded credentials).
 *
 * @param {{
 *   endpointUrl: unknown,
 *   modelId?: unknown,
 *   channelId: string,
 *   optInChannels?: readonly string[],
 *   versionTag: string,
 *   deterministicDraft: string,
 *   maxTokens?: number,
 * }} options
 */
export function buildSelfHostedSummarizerRequest(options) {
  assertRoomOptedIn(options.channelId, options.optInChannels ?? DEFAULT_OPT_IN_CHANNELS);

  const validatedUrl = validateEndpointUrl(String(options.endpointUrl ?? ''), {
    allowLocalhostHttp: false,
  });

  const rawModel =
    typeof options.modelId === 'string' && options.modelId.trim()
      ? options.modelId.trim()
      : 'self-hosted-summarizer-v1';
  if (!SAFE_MODEL_ID_PATTERN.test(rawModel)) {
    throw new ExtensionSdkError('INVALID_MODEL_ID', `Invalid self-hosted model identifier "${rawModel}".`);
  }

  const maxTokens = options.maxTokens ?? 512;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 32 || maxTokens > 2048) {
    throw new ExtensionSdkError('INVALID_MAX_TOKENS', 'maxTokens must be an integer between 32 and 2048.');
  }

  const safeTag = sanitizeReleaseText(options.versionTag, 'v0.1.0', 64);
  const safeDraft = String(options.deterministicDraft ?? '').slice(0, 8_000);

  return Object.freeze({
    url: validatedUrl,
    method: 'POST',
    headers: Object.freeze({
      'content-type': 'application/json',
      'x-kodera-telemetry': 'disabled',
    }),
    body: Object.freeze({
      model: rawModel,
      stream: false,
      temperature: 0,
      max_tokens: maxTokens,
      messages: Object.freeze([
        Object.freeze({
          role: 'system',
          content:
            'Summarize the provided structured release notes concisely in French and English without inventing changes.',
        }),
        Object.freeze({
          role: 'user',
          content: `Release ${safeTag}:\n${safeDraft}`,
        }),
      ]),
    }),
    telemetryEnabled: TELEMETRY_ENABLED,
  });
}

/**
 * Computes an `X-Release-Signature-256` (`sha256=<hex>`) HMAC-SHA256 digest over exact raw UTF-8 bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signReleaseWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Release webhook secret must be at least 16 characters.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return `sha256=${createHmac('sha256', secret).update(bodyBuf).digest('hex')}`;
}

/**
 * Verifies a native `X-Release-Signature-256` / `X-Hub-Signature-256` HMAC-SHA256 digest
 * in constant time using `timingSafeEqual`.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 * }} params
 */
export function verifyReleaseWebhookSignature({ secret, rawBody, signatureHeader }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Release webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Release webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? RELEASE_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed X-Release-Signature-256 header.');
  }

  const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Release HMAC-SHA256 signature verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Release webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Release webhook payload must be a JSON object.');
  }

  const eventName = String(payload.type ?? payload.event ?? 'release.published').trim();
  if (eventName !== 'release.published') {
    throw new WebhookVerificationError('INVALID_EVENT', `Unsupported release-assistant event "${eventName}".`);
  }

  return {
    event: 'release.published',
    payload: /** @type {Record<string, unknown>} */ (payload),
    signature: `sha256=${actualBuf.toString('hex')}`,
  };
}

/**
 * Executes `/release-draft` (and accepts `/release-notes` as a command alias) with per-room opt-in enforcement.
 *
 * @param {{
 *   rawCommand?: string,
 *   command?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   optInChannels?: readonly string[],
 *   inferenceEndpointUrl?: string,
 * }} input
 */
export function handleReleaseAssistantCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_releases';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_release_mgr';
  const optInChannels = input.optInChannels ?? DEFAULT_OPT_IN_CHANNELS;

  const rawCommandName = typeof input.command === 'string' && input.command.trim()
    ? input.command.trim().replace(/^\//, '')
    : 'release-draft';
  if (!ACCEPTED_SLASH_COMMANDS.includes(rawCommandName)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_RELEASE_COMMAND',
      `Unsupported release command "/${rawCommandName}".`
    );
  }

  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/${rawCommandName} ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  if (!ACCEPTED_SLASH_COMMANDS.includes(parsed.command)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_RELEASE_COMMAND',
      `Unsupported release command "/${parsed.command}"; expected /release-draft or /release-notes.`
    );
  }

  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!RELEASE_ASSISTANT_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_RELEASE_SUBCOMMAND',
      `Unsupported /${parsed.command} subcommand "${subcommand}"; expected: ${RELEASE_ASSISTANT_SUBCOMMANDS.join(', ')}.`
    );
  }

  const roomOptedIn = optInChannels.includes(channelId);

  if (subcommand === 'draft') {
    assertRoomOptedIn(channelId, optInChannels);
    const versionTag = String(parsed.flags.tag ?? parsed.args[0] ?? 'v0.1.0').trim();
    const repository = String(parsed.flags.repo ?? 'kodera-hq/kodera').trim();
    const localeFlag = /** @type {'bilingual' | 'fr' | 'en'} */ (
      typeof parsed.flags.locale === 'string' ? parsed.flags.locale.toLowerCase() : 'bilingual'
    );
    const sampleCommits = typeof parsed.flags.commit === 'string' ? [parsed.flags.commit] : [];
    const formatted = formatBilingualReleaseNotes({
      versionTag,
      repository,
      commits: sampleCommits,
      locale: localeFlag,
    });

    const summarizerRequest =
      typeof input.inferenceEndpointUrl === 'string' && input.inferenceEndpointUrl.trim()
        ? buildSelfHostedSummarizerRequest({
            endpointUrl: input.inferenceEndpointUrl,
            channelId,
            optInChannels,
            versionTag: formatted.versionTag,
            deterministicDraft: formatted.markdown,
          })
        : null;

    return {
      text: formatted.markdown,
      ephemeral: true,
      subcommand: 'draft',
      invokedAs: `/${parsed.command}`,
      actorId,
      roomOptedIn: true,
      telemetryEnabled: TELEMETRY_ENABLED,
      notes: formatted,
      summarizerRequest,
    };
  }

  if (subcommand === 'opt-in-check') {
    return {
      text: roomOptedIn
        ? `[Release Assistant] Channel <#${channelId}> is opted in (telemetry: disabled).`
        : `[Release Assistant] Channel <#${channelId}> is NOT opted in; release drafting is disabled in this room.`,
      ephemeral: true,
      subcommand: 'opt-in-check',
      roomOptedIn,
      telemetryEnabled: TELEMETRY_ENABLED,
    };
  }

  return {
    text: `[Release Assistant] Ready (channel <#${channelId}> opted-in: \`${roomOptedIn}\` · mode: \`${input.inferenceEndpointUrl ? 'self-hosted-https' : 'deterministic-bilingual'}\` · telemetry: \`disabled\`).`,
    ephemeral: true,
    subcommand: 'status',
    invokedAs: `/${parsed.command}`,
    roomOptedIn,
    telemetryEnabled: TELEMETRY_ENABLED,
  };
}

export const releaseDraftCommand = defineSlashCommand({
  name: '/release-draft',
  description: 'Generate deterministic bilingual (FR/EN) release notes in opted-in channels',
  scopes: ['ephemeral:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleReleaseAssistantCommand({ command: 'release-draft', args, channelId, actorId }),
});

export const slashCommand = releaseDraftCommand;

/**
 * Processes a `release.published` webhook for an opted-in room, formatting deterministic
 * bilingual FR/EN release notes and optionally building a validated HTTPS self-hosted request.
 *
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   optInChannels: readonly string[],
 *   inferenceEndpointUrl?: string,
 *   modelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processReleasePublishedEvent(payload, state) {
  const { defaultChannelId, optInChannels, inferenceEndpointUrl, modelId, client } = state;
  const channelId =
    typeof payload.channelId === 'string' && payload.channelId.trim()
      ? payload.channelId.trim()
      : defaultChannelId;

  assertRoomOptedIn(channelId, optInChannels);

  const locale = /** @type {'bilingual' | 'fr' | 'en'} */ (
    typeof payload.locale === 'string' ? payload.locale.toLowerCase() : 'bilingual'
  );
  const notes = formatBilingualReleaseNotes({
    versionTag: payload.versionTag ?? payload.tag_name ?? payload.tag ?? 'v0.1.0',
    repository: payload.repository ?? 'kodera-hq/kodera',
    commits: Array.isArray(payload.commits) ? payload.commits : [],
    pullRequests: Array.isArray(payload.pullRequests) ? payload.pullRequests : [],
    locale,
  });

  const summarizerRequest =
    typeof inferenceEndpointUrl === 'string' && inferenceEndpointUrl.trim()
      ? buildSelfHostedSummarizerRequest({
          endpointUrl: inferenceEndpointUrl,
          modelId,
          channelId,
          optInChannels,
          versionTag: notes.versionTag,
          deterministicDraft: notes.markdown,
        })
      : null;

  const idempotencyKey = `release-assistant:${notes.repository}:${notes.versionTag}:${notes.locale}`;
  const blocks = [
    {
      type: 'bilingual_release_notes_card',
      repository: notes.repository,
      versionTag: notes.versionTag,
      locale: notes.locale,
      counts: notes.counts,
      mode: summarizerRequest ? 'self-hosted-https-ready' : 'deterministic',
      telemetryEnabled: TELEMETRY_ENABLED,
    },
  ];

  if (client) {
    const delivery = await client.postChannelMessage({
      channelId,
      text: notes.markdown,
      blocks,
      idempotencyKey,
    });
    return {
      posted: true,
      channelId,
      notes,
      summarizerRequest,
      telemetryEnabled: TELEMETRY_ENABLED,
      idempotencyKey,
      delivery,
    };
  }

  return {
    posted: false,
    channelId,
    notes,
    summarizerRequest,
    telemetryEnabled: TELEMETRY_ENABLED,
    idempotencyKey,
    text: notes.markdown,
    blocks,
  };
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` envelopes
 * and native `X-Release-Signature-256` webhooks with strict per-room opt-in enforcement.
 *
 * @param {{
 *   secret: string,
 *   releaseSecret?: string,
 *   defaultChannelId?: string,
 *   optInChannels?: readonly string[],
 *   inferenceEndpointUrl?: string,
 *   modelId?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createReleaseAssistantWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const releaseSecret = config.releaseSecret ?? config.secret;
  const optInChannels = config.optInChannels ?? DEFAULT_OPT_IN_CHANNELS;
  const defaultChannelId = config.defaultChannelId ?? optInChannels[0] ?? 'chan_releases';
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  if (typeof config.inferenceEndpointUrl === 'string' && config.inferenceEndpointUrl.trim()) {
    validateEndpointUrl(config.inferenceEndpointUrl, { allowLocalhostHttp: false });
  }

  /** @type {Map<string, number>} */
  const nativeSeenSignatures = new Map();
  /** @type {Map<string, number>} */
  const nativeSeenDeliveries = new Map();

  const pruneNativeReplay = (nowSec) => {
    for (const [sig, ts] of nativeSeenSignatures.entries()) {
      if (nowSec - ts > maxSkewSeconds) nativeSeenSignatures.delete(sig);
    }
    for (const [deliv, ts] of nativeSeenDeliveries.entries()) {
      if (nowSec - ts > maxSkewSeconds) nativeSeenDeliveries.delete(deliv);
    }
  };

  const stateBase = {
    defaultChannelId,
    optInChannels,
    inferenceEndpointUrl: config.inferenceEndpointUrl,
    modelId: config.modelId,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'release.published': (payload, { client }) =>
        processReleasePublishedEvent(payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleReleaseAssistantCommand({
          command: String(payload.command ?? 'release-draft'),
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_release_mgr'),
          optInChannels,
          inferenceEndpointUrl: config.inferenceEndpointUrl,
        }),
    },
  });

  return async function handleIncomingReleaseAssistantWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const nativeSig =
      getHeaderValue(req.headers, 'x-release-signature-256') ??
      getHeaderValue(req.headers, 'x-hub-signature-256');

    if (koderaSig !== undefined || nativeSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId = getHeaderValue(req.headers, 'x-release-delivery') ?? getHeaderValue(req.headers, 'x-request-id');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Release delivery identifier must be bounded ASCII.');
    }

    const { event, payload, signature } = verifyReleaseWebhookSignature({
      secret: releaseSecret,
      rawBody: req.rawBody,
      signatureHeader: nativeSig,
    });

    pruneNativeReplay(nowSec);
    if (nativeSeenSignatures.has(signature) || (deliveryId !== undefined && nativeSeenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate release webhook delivery rejected.');
    }
    if (nativeSeenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Release replay cache is full.');
    }
    nativeSeenSignatures.set(signature, nowSec);
    if (deliveryId !== undefined) {
      nativeSeenDeliveries.set(deliveryId, nowSec);
    }

    const activeClient = req.client ?? config.client;
    const result = await processReleasePublishedEvent(payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: 200,
      event,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createReleaseAssistantWebhookHandler;

export default {
  manifest,
  extensionManifest,
  TELEMETRY_ENABLED,
  slashCommand,
  releaseDraftCommand,
  handleReleaseAssistantCommand,
  assertRoomOptedIn,
  formatBilingualReleaseNotes,
  buildSelfHostedSummarizerRequest,
  signReleaseWebhookPayload,
  verifyReleaseWebhookSignature,
  createReleaseAssistantWebhookHandler,
  createExtensionWebhookHandler,
};

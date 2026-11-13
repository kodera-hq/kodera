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
const SENTRY_HEX_SIG_PATTERN = /^(?:sha256=)?([0-9a-fA-F]{64})$/;
const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/i;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ISSUE_THREADS = 1024;

export const SENTRY_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'issues',
  'resolve',
  'ignore',
  'status',
]);

/**
 * Validates and normalizes the `sentry` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateSentryManifest(input = rawManifest, options = {}) {
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
    throw new ExtensionSdkError('INVALID_MANIFEST_ID', `Invalid Sentry manifest id "${rawId}".`);
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

export const extensionManifest = validateSentryManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeSentryText(rawValue, fallback = '', maxLength = 240) {
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
 * Scrubs local home-directory prefixes and URL query strings from stacktrace filenames
 * before rendering a compact culprit frame preview (`src/auth/verify.ts:84 in verifyToken`).
 *
 * @param {Record<string, unknown>} eventOrIssue
 * @returns {string}
 */
export function formatSentryStackPreview(eventOrIssue) {
  const excValues = Array.isArray(eventOrIssue?.exception?.values)
    ? eventOrIssue.exception.values
    : [];
  const topException = excValues.length > 0 ? excValues[excValues.length - 1] : null;
  const frames = Array.isArray(topException?.stacktrace?.frames)
    ? topException.stacktrace.frames
    : [];

  let chosenFrame = null;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const f = frames[i];
    if (f && typeof f === 'object' && f.in_app === true) {
      chosenFrame = f;
      break;
    }
  }
  if (!chosenFrame && frames.length > 0) {
    chosenFrame = frames[frames.length - 1];
  }

  if (chosenFrame && typeof chosenFrame === 'object') {
    let rawFile = String(chosenFrame.filename ?? chosenFrame.abs_path ?? 'unknown');
    const qIdx = rawFile.indexOf('?');
    if (qIdx !== -1) rawFile = rawFile.slice(0, qIdx);
    rawFile = rawFile
      .replace(/^\/(?:Users|home)\/[^/]+\//, '')
      .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '');
    const safeFile = sanitizeSentryText(rawFile, 'unknown', 100);
    const lineno = Number.isSafeInteger(chosenFrame.lineno) && chosenFrame.lineno > 0
      ? `:${chosenFrame.lineno}`
      : '';
    const fnName = sanitizeSentryText(chosenFrame.function, '', 60);
    return fnName ? `${safeFile}${lineno} in ${fnName}` : `${safeFile}${lineno}`;
  }

  const rawCulprit = String(
    eventOrIssue?.culprit ?? eventOrIssue?.metadata?.filename ?? 'unattributed-frame'
  )
    .replace(/^\/(?:Users|home)\/[^/]+\//, '')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '');
  return sanitizeSentryText(rawCulprit, 'unattributed-frame', 120);
}

/**
 * Maps Sentry/GlitchTip level strings to Kodera `IncidentSeverity`.
 *
 * @param {unknown} rawLevel
 * @returns {'critical' | 'high' | 'medium' | 'low' | 'info'}
 */
export function mapSentryLevelToSeverity(rawLevel) {
  const level = String(rawLevel ?? 'error').toLowerCase();
  if (level === 'fatal') return 'critical';
  if (level === 'error') return 'high';
  if (level === 'warning') return 'medium';
  if (level === 'debug') return 'low';
  if (level === 'info') return 'info';
  return 'high';
}

/**
 * Computes a `Sentry-Hook-Signature` (`HMAC-SHA256` hex) over exact raw bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signSentryWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Sentry webhook secret must be at least 16 characters.');
  }
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return createHmac('sha256', secret).update(bytes).digest('hex');
}

/**
 * Verifies a native `Sentry-Hook-Signature` header in constant time over exact raw bytes.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   timestampHeader?: string | undefined,
 *   nowUnixSeconds?: number,
 *   maxSkewSeconds?: number,
 * }} params
 */
export function verifySentryWebhookSignature({
  secret,
  rawBody,
  signatureHeader,
  timestampHeader,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Sentry webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Sentry webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? SENTRY_HEX_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed Sentry-Hook-Signature header.');
  }

  const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Sentry-Hook-Signature HMAC-SHA256 verification failed.');
  }

  if (timestampHeader !== undefined) {
    if (!/^(0|[1-9]\d{0,15})$/.test(timestampHeader.trim())) {
      throw new WebhookVerificationError('MISSING_TIMESTAMP', 'Invalid Sentry-Hook-Timestamp header.');
    }
    const ts = Number(timestampHeader.trim());
    if (!Number.isSafeInteger(ts) || Math.abs(nowUnixSeconds - ts) > maxSkewSeconds) {
      throw new WebhookVerificationError('TIMESTAMP_OUT_OF_RANGE', 'Sentry webhook timestamp outside replay window.');
    }
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Sentry webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Sentry webhook payload must be a JSON object.');
  }

  return {
    payload: /** @type {Record<string, unknown>} */ (payload),
    signature: actualBuf.toString('hex'),
  };
}

/**
 * Executes the `/sentry` slash command (`issues`, `resolve`, `ignore`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   instanceOrigin?: string,
 * }} input
 */
export function handleSentryCommand(input) {
  const originUrl = validateEndpointUrl(input.instanceOrigin ?? 'https://sentry.io', {
    allowLocalhostHttp: false,
  }).replace(/\/$/, '');
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_secops';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_unknown';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/sentry ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!SENTRY_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_SENTRY_SUBCOMMAND',
      `Unsupported /sentry subcommand "${subcommand}"; expected: ${SENTRY_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  const project = String(parsed.flags.project ?? 'kodera-web').trim();
  if (!PROJECT_SLUG_PATTERN.test(project)) {
    throw new ExtensionSdkError('INVALID_SENTRY_PROJECT', `Invalid Sentry project slug "${project}".`);
  }

  if (subcommand === 'issues') {
    const env = sanitizeSentryText(parsed.flags.env ?? 'production', 'production', 40);
    return {
      text: `[Sentry Issues] Project **${project}** [env=${env}] summary requested by <@${actorId}> (${originUrl}).`,
      ephemeral: true,
      subcommand: 'issues',
      project,
      environment: env,
    };
  }

  if (subcommand === 'resolve' || subcommand === 'ignore') {
    const rawIssue = String(parsed.flags.issue ?? parsed.args[0] ?? '').trim();
    if (!SHORT_ID_PATTERN.test(rawIssue)) {
      throw new ExtensionSdkError('INVALID_SENTRY_ISSUE', 'Issue shortId is required (e.g. KODERA-WEB-4A).');
    }
    return {
      text: `[Sentry ${subcommand === 'resolve' ? 'Resolve' : 'Ignore'}] Issue **${rawIssue}** queued in <#${channelId}> by <@${actorId}>.`,
      ephemeral: false,
      subcommand,
      issueId: rawIssue,
    };
  }

  return {
    text: `[Sentry] Bridge ready in <#${channelId}> for project **${project}** (\`${originUrl}\`) — subcommands: \`issues\`, \`resolve\`, \`ignore\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    project,
  };
}

export const sentryCommand = defineSlashCommand({
  name: '/sentry',
  description: 'Inspect, triage, or resolve Sentry and GlitchTip error issues',
  scopes: ['messages:write', 'incidents:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleSentryCommand({ args, channelId, actorId }),
});

export const slashCommand = sentryCommand;

/**
 * Extracts a tag value from Sentry's `tags` array or object.
 *
 * @param {unknown} tags
 * @param {string} key
 * @returns {string | undefined}
 */
function lookupSentryTag(tags, key) {
  if (Array.isArray(tags)) {
    for (const pair of tags) {
      if (Array.isArray(pair) && pair[0] === key && typeof pair[1] === 'string') {
        return pair[1];
      }
      if (pair && typeof pair === 'object' && pair.key === key && typeof pair.value === 'string') {
        return pair.value;
      }
    }
  } else if (tags && typeof tags === 'object') {
    const val = /** @type {Record<string, unknown>} */ (tags)[key];
    if (typeof val === 'string') return val;
  }
  return undefined;
}

/**
 * Processes Sentry & GlitchTip `event_alert` and `issue` webhook payloads.
 *
 * @param {string} resource
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   issueThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processSentryEvent(resource, payload, state) {
  const { defaultChannelId, issueThreads, client } = state;
  const action = String(payload.action ?? 'created').toLowerCase();
  const data = /** @type {Record<string, unknown>} */ (
    typeof payload.data === 'object' && payload.data !== null ? payload.data : payload
  );
  const eventObj = /** @type {Record<string, unknown> | undefined} */ (
    typeof data.event === 'object' && data.event !== null ? data.event : undefined
  );
  const issueObj = /** @type {Record<string, unknown>} */ (
    typeof data.issue === 'object' && data.issue !== null ? data.issue : eventObj ?? data
  );

  const rawIssueId = String(
    issueObj.shortId ?? issueObj.short_id ?? issueObj.issue_id ?? issueObj.id ?? payload.id ?? 'ISSUE-1'
  ).trim();
  if (!SHORT_ID_PATTERN.test(rawIssueId)) {
    throw new ExtensionSdkError('INVALID_SENTRY_ISSUE', `Invalid Sentry/GlitchTip issue identifier "${rawIssueId}".`);
  }

  const channelId = String(payload.channelId ?? defaultChannelId);
  const title = sanitizeSentryText(
    issueObj.title ?? eventObj?.title ?? payload.message ?? `Error ${rawIssueId}`,
    `Error ${rawIssueId}`,
    160
  );
  const culpritFrame = formatSentryStackPreview(eventObj ?? issueObj);
  const environment = sanitizeSentryText(
    eventObj?.environment ??
      issueObj.environment ??
      lookupSentryTag(eventObj?.tags ?? issueObj.tags, 'environment') ??
      'production',
    'production',
    40
  );
  const release = sanitizeSentryText(
    eventObj?.release ??
      issueObj.release ??
      lookupSentryTag(eventObj?.tags ?? issueObj.tags, 'release') ??
      'unversioned',
    'unversioned',
    64
  );
  const userCount = Math.max(0, Number(issueObj.userCount ?? issueObj.user_count ?? 0) || 0);
  const eventCount = Math.max(1, Number(issueObj.count ?? 1) || 1);
  const severity = mapSentryLevelToSeverity(eventObj?.level ?? issueObj.level ?? 'error');

  const rawUrl =
    eventObj?.web_url ??
    issueObj.web_url ??
    issueObj.permalink ??
    payload.url ??
    'https://sentry.io/issues/';
  const externalUrl = validateEndpointUrl(String(rawUrl), { allowLocalhostHttp: false });

  const rememberThread = (id, threadId) => {
    if (issueThreads.size >= MAX_ISSUE_THREADS && !issueThreads.has(id)) {
      const oldest = issueThreads.keys().next().value;
      if (oldest !== undefined) issueThreads.delete(oldest);
    }
    issueThreads.set(id, threadId);
  };

  if (resource === 'event_alert' || action === 'triggered' || action === 'created' || action === 'regressed') {
    const label =
      action === 'regressed' ? 'REGRESSED' : resource === 'event_alert' ? 'EVENT ALERT' : 'NEW ISSUE';
    const incidentTitle = `[${label}] ${rawIssueId}: ${title}`.slice(0, 200);
    const summary =
      `Culprit: ${culpritFrame}\n` +
      `Environment: ${environment} · Release: ${release} · Events: ${eventCount} · Users: ${userCount}\n` +
      `Issue: ${externalUrl}`;
    const idempotencyKey = `sentry:${resource}:${rawIssueId}:${action}`;

    if (client) {
      const delivery = await client.postIncidentCard({
        channelId,
        title: incidentTitle,
        severity,
        summary,
        externalUrl,
        status: 'open',
        idempotencyKey,
      });
      if (typeof delivery.id === 'string') {
        rememberThread(rawIssueId, delivery.id);
      }
      return {
        posted: true,
        issueId: rawIssueId,
        action,
        severity,
        culpritFrame,
        environment,
        release,
        userCount,
        externalUrl,
        idempotencyKey,
        delivery,
      };
    }

    return {
      posted: false,
      issueId: rawIssueId,
      action,
      severity,
      culpritFrame,
      environment,
      release,
      userCount,
      externalUrl,
      idempotencyKey,
      summary,
    };
  }

  if (action === 'resolved' || action === 'ignored') {
    const statusBadge = action === 'resolved' ? '[ISSUE RESOLVED]' : '[ISSUE IGNORED]';
    const actor = sanitizeSentryText(payload.actor?.name ?? 'triage', 'triage', 60);
    const text = `${statusBadge} **${rawIssueId}** (${title}) marked **${action}** by **${actor}**\n${externalUrl}`;
    const idempotencyKey = `sentry:issue:${rawIssueId}:${action}`;

    if (client) {
      const existingThread = issueThreads.get(rawIssueId);
      if (existingThread) {
        const delivery = await client.postThreadReply({
          channelId,
          threadRootId: existingThread,
          text,
          idempotencyKey,
        });
        return { posted: true, threaded: true, issueId: rawIssueId, action, idempotencyKey, delivery };
      }
      const delivery = await client.postChannelMessage({ channelId, text, idempotencyKey });
      return { posted: true, threaded: false, issueId: rawIssueId, action, idempotencyKey, delivery };
    }
    return { posted: false, issueId: rawIssueId, action, idempotencyKey, text };
  }

  return { posted: false, ignored: true, reason: 'unsupported_sentry_action', issueId: rawIssueId, action };
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` signatures
 * and native `Sentry-Hook-Signature` (`HMAC-SHA256`) constant-time verification for Sentry and GlitchTip.
 *
 * @param {{
 *   secret: string,
 *   sentrySecret?: string,
 *   instanceOrigin?: string,
 *   defaultChannelId?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createSentryWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const sentrySecret = config.sentrySecret ?? config.secret;
  const instanceOrigin = config.instanceOrigin ?? 'https://sentry.io';
  validateEndpointUrl(instanceOrigin, { allowLocalhostHttp: false });
  const defaultChannelId = config.defaultChannelId ?? 'chan_sentry';
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, string>} */
  const issueThreads = new Map();
  /** @type {Map<string, number>} */
  const seenSignatures = new Map();
  /** @type {Map<string, number>} */
  const seenDeliveries = new Map();

  const pruneReplay = (nowSec) => {
    for (const [key, ts] of seenSignatures.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenSignatures.delete(key);
    }
    for (const [key, ts] of seenDeliveries.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenDeliveries.delete(key);
    }
  };

  const stateBase = {
    defaultChannelId,
    issueThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      event_alert: (payload, { client }) => processSentryEvent('event_alert', payload, { ...stateBase, client }),
      issue: (payload, { client }) => processSentryEvent('issue', payload, { ...stateBase, client }),
      'incident.opened': (payload, { client }) =>
        processSentryEvent('issue', { ...payload, action: 'created' }, { ...stateBase, client }),
      'incident.resolved': (payload, { client }) =>
        processSentryEvent('issue', { ...payload, action: 'resolved' }, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleSentryCommand({
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_unknown'),
          instanceOrigin,
        }),
    },
  });

  return async function handleIncomingSentryWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const sentrySig = getHeaderValue(req.headers, 'sentry-hook-signature');

    if (koderaSig !== undefined || sentrySig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const { payload, signature } = verifySentryWebhookSignature({
      secret: sentrySecret,
      rawBody: req.rawBody,
      signatureHeader: sentrySig,
      timestampHeader: getHeaderValue(req.headers, 'sentry-hook-timestamp'),
      nowUnixSeconds: nowSec,
      maxSkewSeconds,
    });

    const resource = String(getHeaderValue(req.headers, 'sentry-hook-resource') ?? payload.resource ?? 'issue').toLowerCase();
    if (!['event_alert', 'issue'].includes(resource)) {
      throw new WebhookVerificationError('INVALID_EVENT', `Unsupported Sentry-Hook-Resource "${resource}".`);
    }

    const deliveryId = getHeaderValue(req.headers, 'request-id') ?? getHeaderValue(req.headers, 'x-sentry-delivery');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Sentry Request-ID header must be bounded.');
    }

    pruneReplay(nowSec);
    if (seenSignatures.has(signature) || (deliveryId !== undefined && seenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate Sentry webhook delivery rejected.');
    }
    if (seenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Sentry replay cache is full.');
    }
    seenSignatures.set(signature, nowSec);
    if (deliveryId !== undefined) {
      seenDeliveries.set(deliveryId, nowSec);
    }

    const activeClient = req.client ?? config.client;
    const result = await processSentryEvent(resource, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: result.ignored ? 202 : 200,
      event: resource,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createSentryWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  sentryCommand,
  handleSentryCommand,
  createSentryWebhookHandler,
  createExtensionWebhookHandler,
};

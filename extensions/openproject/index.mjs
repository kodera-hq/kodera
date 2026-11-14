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
const WORK_SIG_PATTERN = /^(?:sha256=)?([0-9a-fA-F]{64})$/;
const SAFE_WORK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_#-]{0,47}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_WORK_THREADS = 1024;

export const OPENPROJECT_EVENTS = Object.freeze([
  'work_package:created',
  'work_package:updated',
]);

export const JIRA_EVENTS = Object.freeze([
  'jira:issue_created',
  'jira:issue_updated',
  'sprint_started',
  'sprint_closed',
]);

export const SUPPORTED_WORK_EVENTS = Object.freeze([
  ...OPENPROJECT_EVENTS,
  ...JIRA_EVENTS,
]);

export const WORK_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'inspect',
  'sprint',
  'triage',
  'status',
]);

export const DEFAULT_ALLOWED_WORK_HOSTS = Object.freeze([
  'openproject.example.org',
  'projects.example.org',
  'jira.example.org',
  'tracker.example.com',
]);

/**
 * Validates and normalizes the `openproject` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateOpenprojectManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateOpenprojectManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Linear-time plain-text sanitizer without HTML-tag regular expressions.
 * Also scrubs raw email tokens so assignee privacy is preserved.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeWorkText(rawValue, fallback = '', maxLength = 200) {
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
  if (cleaned.includes('@')) {
    cleaned = cleaned
      .split(' ')
      .map((tok) => (tok.includes('@') && tok.includes('.') ? '[redacted-email]' : tok))
      .join(' ');
  }
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
 * Validates a sovereign work-tracker HTTPS link via `validateEndpointUrl` and optional host allowlist.
 *
 * @param {unknown} rawUrl
 * @param {readonly string[]} [allowedHosts]
 * @returns {string}
 */
export function validateWorkTrackerUrl(rawUrl, allowedHosts = DEFAULT_ALLOWED_WORK_HOSTS) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), { allowLocalhostHttp: false });
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
    const parsed = new URL(validated);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const normalizedAllowlist = allowedHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
    if (!normalizedAllowlist.includes(host)) {
      throw new ExtensionSdkError(
        'UNTRUSTED_WORK_HOST',
        `Work tracker URL host "${host}" is outside the configured allowlist.`
      );
    }
  }
  return validated;
}

/**
 * Normalizes both OpenProject HAL+JSON (`work_package:created`, `work_package:updated`) and
 * Jira (`jira:issue_created`, `jira:issue_updated`, `sprint_started`, `sprint_closed`) payloads
 * into a unified sovereign work-item timeline card structure.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{ allowedHosts?: readonly string[] }} [options]
 */
export function normalizeSovereignWorkItem(eventName, payload, options = {}) {
  if (!SUPPORTED_WORK_EVENTS.includes(eventName)) {
    throw new ExtensionSdkError('UNSUPPORTED_WORK_EVENT', `Unsupported work event "${eventName}".`);
  }
  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_WORK_HOSTS;

  // 1. OpenProject HAL+JSON work_package payloads
  if (OPENPROJECT_EVENTS.includes(eventName)) {
    const wp = /** @type {Record<string, unknown> | undefined} */ (
      typeof payload.work_package === 'object' && payload.work_package !== null && !Array.isArray(payload.work_package)
        ? payload.work_package
        : payload
    );
    const wpId = Number(wp?.id);
    if (!Number.isSafeInteger(wpId) || wpId < 1) {
      throw new ExtensionSdkError('INVALID_WORK_PACKAGE_ID', 'OpenProject work_package.id must be a positive integer.');
    }

    const embedded = /** @type {Record<string, any>} */ (
      typeof wp?._embedded === 'object' && wp._embedded !== null ? wp._embedded : {}
    );
    const links = /** @type {Record<string, any>} */ (
      typeof wp?._links === 'object' && wp._links !== null ? wp._links : {}
    );

    const projectCode = sanitizeWorkText(
      embedded.project?.identifier ?? embedded.project?.name ?? payload.project ?? 'OP',
      'OP',
      24
    ).toUpperCase();
    const itemKey = `${projectCode.replaceAll(/[^A-Z0-9-]/g, '') || 'OP'}-${wpId}`;
    const title = sanitizeWorkText(wp?.subject ?? wp?.title ?? `Work package #${wpId}`, `Work package #${wpId}`, 160);
    const statusLabel = sanitizeWorkText(
      embedded.status?.name ?? links.status?.title ?? wp?.status ?? 'Open',
      'Open',
      40
    );
    const priority = sanitizeWorkText(
      embedded.priority?.name ?? links.priority?.title ?? wp?.priority ?? 'Normal',
      'Normal',
      32
    );
    const assignee = sanitizeWorkText(
      embedded.assignee?.name ?? links.assignee?.title ?? wp?.assignee ?? 'Unassigned',
      'Unassigned',
      60
    );
    const sprintContext = sanitizeWorkText(
      embedded.version?.name ?? links.version?.title ?? wp?.version ?? 'Backlog',
      'Backlog',
      64
    );
    const rawUrl =
      wp?.htmlUrl ??
      wp?.url ??
      payload.url ??
      `https://openproject.example.org/work_packages/${wpId}`;
    const url = validateWorkTrackerUrl(rawUrl, allowedHosts);

    return Object.freeze({
      provider: 'openproject',
      event: eventName,
      isRootEvent: eventName === 'work_package:created',
      correlationKey: `openproject:${wpId}`,
      itemKey,
      title,
      statusBadge: `[${statusLabel.toUpperCase()}]`,
      status: statusLabel,
      priority,
      assignee,
      sprintContext,
      url,
    });
  }

  // 2. Jira sprint lifecycle (`sprint_started`, `sprint_closed`)
  if (eventName === 'sprint_started' || eventName === 'sprint_closed') {
    const sprint = /** @type {Record<string, unknown> | undefined} */ (
      typeof payload.sprint === 'object' && payload.sprint !== null && !Array.isArray(payload.sprint)
        ? payload.sprint
        : payload
    );
    const sprintId = Number(sprint?.id ?? 1);
    if (!Number.isSafeInteger(sprintId) || sprintId < 1) {
      throw new ExtensionSdkError('INVALID_SPRINT_ID', 'Sprint id must be a positive integer.');
    }
    const sprintName = sanitizeWorkText(sprint?.name ?? `Sprint ${sprintId}`, `Sprint ${sprintId}`, 80);
    const goal = sanitizeWorkText(sprint?.goal ?? 'Deliver committed sprint backlog', 'Deliver committed sprint backlog', 160);
    const statusLabel = eventName === 'sprint_started' ? 'Sprint Active' : 'Sprint Closed';
    const rawUrl =
      sprint?.url ??
      payload.url ??
      `https://jira.example.org/secure/RapidBoard.jspa?sprint=${sprintId}`;
    const url = validateWorkTrackerUrl(rawUrl, allowedHosts);

    return Object.freeze({
      provider: 'jira',
      event: eventName,
      isRootEvent: eventName === 'sprint_started',
      correlationKey: `jira:sprint:${sprintId}`,
      itemKey: `SPRINT-${sprintId}`,
      title: `${sprintName} — ${goal}`,
      statusBadge: `[${statusLabel.toUpperCase()}]`,
      status: statusLabel,
      priority: 'Normal',
      assignee: sanitizeWorkText(payload.user?.displayName ?? 'Scrum Lead', 'Scrum Lead', 60),
      sprintContext: sprintName,
      url,
    });
  }

  // 3. Jira issue lifecycle (`jira:issue_created`, `jira:issue_updated`)
  const issue = /** @type {Record<string, any> | undefined} */ (
    typeof payload.issue === 'object' && payload.issue !== null && !Array.isArray(payload.issue)
      ? payload.issue
      : undefined
  );
  if (!issue) {
    throw new ExtensionSdkError('INVALID_JIRA_ISSUE', 'Missing Jira issue object in payload.');
  }
  const rawKey = String(issue.key ?? '').trim();
  if (!SAFE_WORK_KEY_PATTERN.test(rawKey)) {
    throw new ExtensionSdkError('INVALID_JIRA_KEY', `Invalid Jira issue key "${rawKey}".`);
  }
  const fields = /** @type {Record<string, any>} */ (
    typeof issue.fields === 'object' && issue.fields !== null ? issue.fields : {}
  );
  const title = sanitizeWorkText(fields.summary ?? `Issue ${rawKey}`, `Issue ${rawKey}`, 160);
  const statusLabel = sanitizeWorkText(fields.status?.name ?? 'To Do', 'To Do', 40);
  const priority = sanitizeWorkText(fields.priority?.name ?? 'Medium', 'Medium', 32);
  const assignee = sanitizeWorkText(fields.assignee?.displayName ?? 'Unassigned', 'Unassigned', 60);
  const sprintObj = Array.isArray(fields.closedSprints) && fields.closedSprints.length > 0
    ? fields.closedSprints[fields.closedSprints.length - 1]
    : fields.sprint;
  const sprintContext = sanitizeWorkText(
    sprintObj?.name ?? fields.fixVersions?.[0]?.name ?? 'Backlog',
    'Backlog',
    64
  );
  const rawUrl =
    issue.browseUrl ??
    payload.browseUrl ??
    `https://jira.example.org/browse/${encodeURIComponent(rawKey)}`;
  const url = validateWorkTrackerUrl(rawUrl, allowedHosts);

  return Object.freeze({
    provider: 'jira',
    event: eventName,
    isRootEvent: eventName === 'jira:issue_created',
    correlationKey: `jira:issue:${rawKey}`,
    itemKey: rawKey,
    title,
    statusBadge: `[${statusLabel.toUpperCase()}]`,
    status: statusLabel,
    priority,
    assignee,
    sprintContext,
    url,
  });
}

/**
 * Computes an OpenProject / Jira `sha256=<hex>` HMAC-SHA256 webhook signature over exact raw UTF-8 bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signWorkWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Work tracker webhook secret must be at least 16 characters.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return `sha256=${createHmac('sha256', secret).update(bodyBuf).digest('hex')}`;
}

/**
 * Verifies a native OpenProject (`X-OpenProject-Signature`) or Jira (`X-Hub-Signature-256`)
 * HMAC-SHA256 signature over exact raw bytes in constant time using `timingSafeEqual`.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 * }} params
 */
export function verifyWorkWebhookSignature({ secret, rawBody, signatureHeader }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Work tracker webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Work tracker webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? WORK_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed work tracker HMAC-SHA256 signature.');
  }

  const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Work tracker HMAC-SHA256 signature verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Work tracker webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Work tracker webhook payload must be a JSON object.');
  }

  const eventName = String(payload.action ?? payload.webhookEvent ?? payload.type ?? payload.event ?? '').trim();
  if (!SUPPORTED_WORK_EVENTS.includes(eventName)) {
    throw new WebhookVerificationError(
      'INVALID_EVENT',
      `Unsupported work tracker event "${eventName}"; expected one of: ${SUPPORTED_WORK_EVENTS.join(', ')}.`
    );
  }

  return {
    event: eventName,
    payload: /** @type {Record<string, unknown>} */ (payload),
    signature: `sha256=${actualBuf.toString('hex')}`,
  };
}

/**
 * Executes the `/work` slash command (`inspect`, `sprint`, `triage`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleWorkCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_project';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_pm';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/work ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!WORK_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_WORK_SUBCOMMAND',
      `Unsupported /work subcommand "${subcommand}"; expected: ${WORK_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  if (subcommand === 'inspect') {
    const rawKey = String(parsed.flags.key ?? parsed.args[0] ?? 'OP-101').trim();
    if (!SAFE_WORK_KEY_PATTERN.test(rawKey)) {
      throw new ExtensionSdkError('INVALID_WORK_KEY', `Invalid work item key "${rawKey}".`);
    }
    return {
      text: `[Sovereign Work] Inspecting item **${rawKey}** in <#${channelId}> for <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'inspect',
      itemKey: rawKey,
    };
  }

  if (subcommand === 'sprint') {
    const sprintName = sanitizeWorkText(parsed.flags.name ?? parsed.args[0] ?? 'Sprint 14', 'Sprint 14', 64);
    return {
      text: `[Sprint Timeline] Active sprint **${sprintName}** summary requested in <#${channelId}> by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'sprint',
      sprintName,
    };
  }

  if (subcommand === 'triage') {
    const rawKey = String(parsed.flags.key ?? parsed.args[0] ?? 'OP-101').trim();
    if (!SAFE_WORK_KEY_PATTERN.test(rawKey)) {
      throw new ExtensionSdkError('INVALID_WORK_KEY', `Invalid work item key "${rawKey}".`);
    }
    const status = sanitizeWorkText(parsed.flags.status ?? 'In Progress', 'In Progress', 40);
    return {
      text: `[Work Triage] **${rawKey}** marked \`${status}\` in <#${channelId}> by <@${actorId}>.`,
      ephemeral: false,
      subcommand: 'triage',
      itemKey: rawKey,
      status,
    };
  }

  return {
    text: `[OpenProject & Jira] Unified work timeline bridge ready in <#${channelId}> — subcommands: \`inspect\`, \`sprint\`, \`triage\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
  };
}

export const workCommand = defineSlashCommand({
  name: '/work',
  description: 'Inspect OpenProject work packages, Jira issues, or active sprint timelines',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleWorkCommand({ args, channelId, actorId }),
});

export const slashCommand = workCommand;

/**
 * Formats and dispatches normalized OpenProject or Jira events to Kodera channels and item threads.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   allowedHosts: readonly string[],
 *   workThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processWorkEvent(eventName, payload, state) {
  const { defaultChannelId, allowedHosts, workThreads, client } = state;
  const item = normalizeSovereignWorkItem(eventName, payload, { allowedHosts });
  const channelId = String(payload.channelId ?? defaultChannelId);
  const providerTag = item.provider === 'openproject' ? 'OpenProject' : 'Jira';

  const text =
    `${item.statusBadge} **${item.itemKey}** (${providerTag}) ${item.title}\n` +
    `Assignee: **${item.assignee}** · Priority: \`${item.priority}\` · Sprint/Version: \`${item.sprintContext}\`\n` +
    `${item.url}`;

  const idempotencyKey = `work:${item.provider}:${item.event}:${item.itemKey}:${item.status}`;
  const blocks = [
    {
      type: 'sovereign_work_item_card',
      provider: item.provider,
      event: item.event,
      itemKey: item.itemKey,
      title: item.title,
      statusBadge: item.statusBadge,
      status: item.status,
      priority: item.priority,
      assignee: item.assignee,
      sprintContext: item.sprintContext,
      url: item.url,
    },
  ];

  const rememberThread = (key, threadId) => {
    if (workThreads.size >= MAX_WORK_THREADS && !workThreads.has(key)) {
      const oldest = workThreads.keys().next().value;
      if (oldest !== undefined) workThreads.delete(oldest);
    }
    workThreads.set(key, threadId);
  };

  if (client) {
    const existingThread = workThreads.get(item.correlationKey);
    if (existingThread && !item.isRootEvent) {
      const delivery = await client.postThreadReply({
        channelId,
        threadRootId: existingThread,
        text,
        blocks,
        idempotencyKey,
      });
      return { posted: true, threaded: true, item, idempotencyKey, delivery };
    }

    const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
    if (typeof delivery.id === 'string') {
      rememberThread(item.correlationKey, delivery.id);
    }
    return { posted: true, threaded: false, item, idempotencyKey, delivery };
  }

  return { posted: false, item, idempotencyKey, text, blocks };
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` envelopes
 * and native OpenProject (`X-OpenProject-Signature`) / Jira (`X-Hub-Signature-256`) webhooks.
 *
 * @param {{
 *   secret: string,
 *   workSecret?: string,
 *   defaultChannelId?: string,
 *   allowedHosts?: readonly string[],
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createOpenprojectWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const workSecret = config.workSecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_project';
  const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_WORK_HOSTS;
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, string>} */
  const workThreads = new Map();
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
    allowedHosts,
    workThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'work_package:created': (payload, { client }) =>
        processWorkEvent('work_package:created', payload, { ...stateBase, client }),
      'work_package:updated': (payload, { client }) =>
        processWorkEvent('work_package:updated', payload, { ...stateBase, client }),
      'jira:issue_created': (payload, { client }) =>
        processWorkEvent('jira:issue_created', payload, { ...stateBase, client }),
      'jira:issue_updated': (payload, { client }) =>
        processWorkEvent('jira:issue_updated', payload, { ...stateBase, client }),
      sprint_started: (payload, { client }) =>
        processWorkEvent('sprint_started', payload, { ...stateBase, client }),
      sprint_closed: (payload, { client }) =>
        processWorkEvent('sprint_closed', payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        workCommand.handler({
          command: 'work',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_pm'),
        }),
    },
  });

  return async function handleIncomingWorkWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const nativeSig =
      getHeaderValue(req.headers, 'x-openproject-signature') ??
      getHeaderValue(req.headers, 'x-hub-signature-256');

    if (koderaSig !== undefined || nativeSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId =
      getHeaderValue(req.headers, 'x-openproject-delivery') ??
      getHeaderValue(req.headers, 'x-atlassian-webhook-identifier') ??
      getHeaderValue(req.headers, 'x-request-id');

    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Work tracker delivery identifier must be bounded ASCII.');
    }

    const { event, payload, signature } = verifyWorkWebhookSignature({
      secret: workSecret,
      rawBody: req.rawBody,
      signatureHeader: nativeSig,
    });

    pruneNativeReplay(nowSec);
    if (nativeSeenSignatures.has(signature) || (deliveryId !== undefined && nativeSeenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate work tracker webhook delivery rejected.');
    }
    if (nativeSeenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Work tracker replay cache is full.');
    }
    nativeSeenSignatures.set(signature, nowSec);
    if (deliveryId !== undefined) {
      nativeSeenDeliveries.set(deliveryId, nowSec);
    }

    const activeClient = req.client ?? config.client;
    const result = await processWorkEvent(event, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: 200,
      event,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createOpenprojectWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  workCommand,
  handleWorkCommand,
  normalizeSovereignWorkItem,
  validateWorkTrackerUrl,
  signWorkWebhookPayload,
  verifyWorkWebhookSignature,
  createOpenprojectWebhookHandler,
  createExtensionWebhookHandler,
};

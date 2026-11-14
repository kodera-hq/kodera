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
const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,11}-\d{1,7}$/;
const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,11}$/;
const LINEAR_HEX_SIG_PATTERN = /^[0-9a-fA-F]{64}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ISSUE_THREADS = 1024;

export const LINEAR_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'issue',
  'cycle',
  'project',
  'triage',
  'status',
]);

export const LINEAR_PRIORITY_LABELS = Object.freeze({
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
});

export const LINEAR_PROJECT_HEALTH_BADGES = Object.freeze({
  onTrack: '[ON TRACK]',
  atRisk: '[AT RISK]',
  offTrack: '[OFF TRACK]',
});

/**
 * Validates and normalizes the `linear` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateLinearManifest(input = rawManifest, options = {}) {
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
    throw new ExtensionSdkError('INVALID_MANIFEST_ID', `Invalid Linear manifest id "${rawId}".`);
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

export const extensionManifest = validateLinearManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeLinearText(rawValue, fallback = '', maxLength = 240) {
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
 * Validates a Linear issue identifier (`ENG-142`).
 *
 * @param {unknown} rawIdentifier
 * @returns {string}
 */
export function validateLinearIssueIdentifier(rawIdentifier) {
  if (typeof rawIdentifier !== 'string') {
    throw new ExtensionSdkError('INVALID_LINEAR_ISSUE_ID', 'Linear issue identifier must match "TEAM-123".');
  }
  const normalized = rawIdentifier.trim().toUpperCase();
  if (!ISSUE_IDENTIFIER_PATTERN.test(normalized)) {
    throw new ExtensionSdkError(
      'INVALID_LINEAR_ISSUE_ID',
      `Invalid Linear issue identifier "${rawIdentifier}".`
    );
  }
  return normalized;
}

/**
 * Validates a Linear HTTPS URL via `validateEndpointUrl` and pins it to `linear.app`.
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function validateLinearUrl(rawUrl) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), { allowLocalhostHttp: false });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== 'linear.app' && !host.endsWith('.linear.app')) {
    throw new ExtensionSdkError('UNTRUSTED_LINEAR_HOST', `Linear URL host "${host}" is not allowed.`);
  }
  return validated;
}

/**
 * Computes a hex `Linear-Signature` (`HMAC-SHA256`) over raw webhook bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signLinearWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Linear webhook secret must be at least 16 characters.');
  }
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return createHmac('sha256', secret).update(bytes).digest('hex');
}

/**
 * Verifies a native Linear webhook's `Linear-Signature` in constant time and enforces
 * `webhookTimestamp` freshness within `maxSkewSeconds`.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   nowUnixSeconds: number,
 *   maxSkewSeconds?: number,
 * }} params
 */
export function verifyLinearWebhookRequest({
  secret,
  rawBody,
  signatureHeader,
  nowUnixSeconds,
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Linear webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Linear webhook body is empty or exceeds the byte limit.');
  }

  const trimmedSig = typeof signatureHeader === 'string' ? signatureHeader.trim() : '';
  if (!LINEAR_HEX_SIG_PATTERN.test(trimmedSig)) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed Linear-Signature header.');
  }

  const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
  const actualBuf = Buffer.from(trimmedSig, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Linear-Signature HMAC-SHA256 verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Linear webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Linear webhook payload must be a JSON object.');
  }

  const rawWebhookTs = payload.webhookTimestamp;
  if (!Number.isSafeInteger(rawWebhookTs) || rawWebhookTs <= 0) {
    throw new WebhookVerificationError(
      'MISSING_TIMESTAMP',
      'Linear webhook payload must include a positive integer webhookTimestamp.'
    );
  }
  // Linear emits webhookTimestamp in epoch milliseconds; normalize milliseconds >= 1e11 to seconds.
  const tsSeconds = rawWebhookTs >= 100_000_000_000 ? Math.floor(rawWebhookTs / 1000) : rawWebhookTs;
  if (Math.abs(nowUnixSeconds - tsSeconds) > maxSkewSeconds) {
    throw new WebhookVerificationError(
      'TIMESTAMP_OUT_OF_RANGE',
      'Linear webhookTimestamp is outside the allowed freshness window.'
    );
  }

  return {
    payload: /** @type {Record<string, unknown>} */ (payload),
    timestampSeconds: tsSeconds,
    signature: actualBuf.toString('hex'),
  };
}

/**
 * Maps a numeric Linear priority (`0..4`) to a human-readable label.
 *
 * @param {unknown} rawPriority
 * @returns {string}
 */
export function formatLinearPriority(rawPriority) {
  const num = Number(rawPriority);
  if (Number.isInteger(num) && Object.prototype.hasOwnProperty.call(LINEAR_PRIORITY_LABELS, num)) {
    return LINEAR_PRIORITY_LABELS[/** @type {0 | 1 | 2 | 3 | 4} */ (num)];
  }
  return 'No priority';
}

/**
 * Executes the `/linear` slash command (`issue`, `cycle`, `project`, `triage`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleLinearCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_linear';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_unknown';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/linear ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!LINEAR_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_LINEAR_SUBCOMMAND',
      `Unsupported /linear subcommand "${subcommand}"; expected: ${LINEAR_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  const rawTeam = String(parsed.flags.team ?? 'ENG').trim().toUpperCase();
  if (!TEAM_KEY_PATTERN.test(rawTeam)) {
    throw new ExtensionSdkError('INVALID_LINEAR_TEAM', `Invalid Linear team key "${rawTeam}".`);
  }

  if (subcommand === 'issue' || subcommand === 'triage') {
    const issueId = validateLinearIssueIdentifier(parsed.flags.id ?? parsed.args[0] ?? `${rawTeam}-1`);
    const priority = typeof parsed.flags.priority === 'string' ? parsed.flags.priority.toLowerCase() : 'high';
    if (!['urgent', 'high', 'medium', 'low', 'none'].includes(priority)) {
      throw new ExtensionSdkError('INVALID_LINEAR_PRIORITY', `Unsupported priority "${priority}".`);
    }
    const url = validateLinearUrl(`https://linear.app/kodera/issue/${issueId}`);
    return {
      text: `[Linear ${subcommand === 'triage' ? 'Triage' : 'Issue'}] **${issueId}** [priority=${priority}] requested by <@${actorId}> (${url}).`,
      ephemeral: subcommand === 'issue',
      subcommand,
      issueId,
      priority,
      url,
    };
  }

  if (subcommand === 'cycle') {
    const url = validateLinearUrl(`https://linear.app/kodera/team/${rawTeam}/active`);
    return {
      text: `[Linear Cycle] Active cycle summary for team **${rawTeam}** requested by <@${actorId}> (${url}).`,
      ephemeral: true,
      subcommand: 'cycle',
      team: rawTeam,
      url,
    };
  }

  if (subcommand === 'project') {
    const health = typeof parsed.flags.health === 'string' ? parsed.flags.health : 'onTrack';
    if (!Object.prototype.hasOwnProperty.call(LINEAR_PROJECT_HEALTH_BADGES, health)) {
      throw new ExtensionSdkError('INVALID_PROJECT_HEALTH', `Unsupported project health "${health}".`);
    }
    const badge = LINEAR_PROJECT_HEALTH_BADGES[/** @type {keyof typeof LINEAR_PROJECT_HEALTH_BADGES} */ (health)];
    return {
      text: `[Linear Project] ${badge} Health filter for team **${rawTeam}** requested by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'project',
      team: rawTeam,
      health,
    };
  }

  return {
    text: `[Linear] Bridge ready in <#${channelId}> for team **${rawTeam}** — subcommands: \`issue\`, \`triage\`, \`cycle\`, \`project\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    team: rawTeam,
  };
}

export const linearCommand = defineSlashCommand({
  name: '/linear',
  description: 'Inspect or triage Linear issues, cycles, and project health updates',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleLinearCommand({ args, channelId, actorId }),
});

export const slashCommand = linearCommand;

/**
 * Formats and posts Linear `Issue`, `Comment`, `Cycle`, and `ProjectUpdate` events.
 *
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   issueThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processLinearEvent(payload, state) {
  const { defaultChannelId, issueThreads, client } = state;
  const entityType = String(payload.entityType ?? payload.type ?? '');
  const action = String(payload.action ?? 'create').toLowerCase();
  const data = /** @type {Record<string, unknown>} */ (
    typeof payload.data === 'object' && payload.data !== null ? payload.data : payload
  );
  const channelId = String(payload.channelId ?? defaultChannelId);

  const rememberIssueThread = (identifier, threadId) => {
    if (issueThreads.size >= MAX_ISSUE_THREADS && !issueThreads.has(identifier)) {
      const oldest = issueThreads.keys().next().value;
      if (oldest !== undefined) issueThreads.delete(oldest);
    }
    issueThreads.set(identifier, threadId);
  };

  if (entityType === 'Issue') {
    if (!['create', 'update', 'remove'].includes(action)) {
      return { posted: false, ignored: true, reason: 'unsupported_issue_action' };
    }
    const identifier = validateLinearIssueIdentifier(data.identifier ?? payload.identifier);
    const title = sanitizeLinearText(data.title, `Issue ${identifier}`, 160);
    const stateName = sanitizeLinearText(data.state?.name ?? data.status, 'Triage', 50);
    const priorityLabel = formatLinearPriority(data.priority);
    const assignee = sanitizeLinearText(data.assignee?.name ?? data.assignee, 'Unassigned', 60);
    const url = validateLinearUrl(payload.url ?? data.url ?? `https://linear.app/kodera/issue/${identifier}`);

    const updatedFrom = /** @type {Record<string, unknown> | undefined} */ (
      typeof payload.updatedFrom === 'object' && payload.updatedFrom !== null ? payload.updatedFrom : undefined
    );
    const changes = [];
    if (action === 'update' && updatedFrom) {
      if ('stateId' in updatedFrom || 'state' in updatedFrom) changes.push(`status → ${stateName}`);
      if ('priority' in updatedFrom) changes.push(`priority → ${priorityLabel}`);
      if ('assigneeId' in updatedFrom || 'assignee' in updatedFrom) changes.push(`assignee → ${assignee}`);
    }
    const diffSummary = changes.length > 0 ? ` (${changes.join(', ')})` : ` [${stateName} · ${priorityLabel} · ${assignee}]`;
    const badge =
      action === 'create' ? '[ISSUE CREATED]' : action === 'remove' ? '[ISSUE REMOVED]' : '[ISSUE UPDATED]';
    const text = `${badge} **${identifier}** ${title}${diffSummary}\n${url}`;
    const idempotencyKey = `linear:issue:${identifier}:${action}:${String(data.updatedAt ?? payload.webhookId ?? action)}`;
    const blocks = [
      {
        type: 'linear_issue_card',
        identifier,
        action,
        title,
        state: stateName,
        priority: priorityLabel,
        assignee,
        changes,
        url,
      },
    ];

    if (client) {
      const existingThread = issueThreads.get(identifier);
      if (existingThread && action !== 'create') {
        const delivery = await client.postThreadReply({
          channelId,
          threadRootId: existingThread,
          text,
          blocks,
          idempotencyKey,
        });
        return { posted: true, threaded: true, identifier, action, changes, idempotencyKey, delivery };
      }
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      if (typeof delivery.id === 'string' && action === 'create') {
        rememberIssueThread(identifier, delivery.id);
      }
      return { posted: true, threaded: false, identifier, action, changes, idempotencyKey, delivery };
    }
    return { posted: false, identifier, action, changes, idempotencyKey, text, blocks };
  }

  if (entityType === 'Comment') {
    if (action !== 'create') {
      return { posted: false, ignored: true, reason: 'non_create_comment' };
    }
    const identifier = validateLinearIssueIdentifier(data.issue?.identifier ?? payload.issueIdentifier);
    const author = sanitizeLinearText(data.user?.name ?? payload.actor?.name, 'Team member', 60);
    const quotePreview = sanitizeLinearText(data.body, 'Comment posted.', 260);
    const commentId = sanitizeLinearText(String(data.id ?? 'c1'), 'c1', 64);
    const url = validateLinearUrl(payload.url ?? data.url ?? `https://linear.app/kodera/issue/${identifier}`);
    const text = `[COMMENT] **${identifier}** — **${author}**: "${quotePreview}"\n${url}`;
    const idempotencyKey = `linear:comment:${identifier}:${commentId}`;
    const blocks = [
      {
        type: 'linear_comment_card',
        identifier,
        author,
        quotePreview,
        url,
      },
    ];

    if (client) {
      const existingThread = issueThreads.get(identifier);
      if (existingThread) {
        const delivery = await client.postThreadReply({
          channelId,
          threadRootId: existingThread,
          text,
          blocks,
          idempotencyKey,
        });
        return { posted: true, threaded: true, identifier, quotePreview, idempotencyKey, delivery };
      }
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, threaded: false, identifier, quotePreview, idempotencyKey, delivery };
    }
    return { posted: false, identifier, quotePreview, idempotencyKey, text, blocks };
  }

  if (entityType === 'Cycle') {
    if (!['create', 'update'].includes(action)) {
      return { posted: false, ignored: true, reason: 'unsupported_cycle_action' };
    }
    const cycleNumber = Number(data.number ?? 1);
    if (!Number.isSafeInteger(cycleNumber) || cycleNumber < 1) {
      throw new ExtensionSdkError('INVALID_CYCLE_NUMBER', 'Linear cycle number must be a positive integer.');
    }
    const cycleName = sanitizeLinearText(data.name, `Cycle ${cycleNumber}`, 80);
    const rawProgress = Number(data.progress ?? 0);
    const progressPct = Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(100, Math.round(rawProgress <= 1 ? rawProgress * 100 : rawProgress)))
      : 0;
    const url = validateLinearUrl(payload.url ?? data.url ?? `https://linear.app/kodera/cycle/${cycleNumber}`);
    const text = `[CYCLE ${action.toUpperCase()}] **${cycleName}** (#${cycleNumber}) — progress: ${progressPct}%\n${url}`;
    const idempotencyKey = `linear:cycle:${cycleNumber}:${action}:${progressPct}`;
    const blocks = [{ type: 'linear_cycle_card', cycleNumber, name: cycleName, progressPct, url }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, cycleNumber, progressPct, idempotencyKey, delivery };
    }
    return { posted: false, cycleNumber, progressPct, idempotencyKey, text, blocks };
  }

  if (entityType === 'ProjectUpdate') {
    if (!['create', 'update'].includes(action)) {
      return { posted: false, ignored: true, reason: 'unsupported_project_update_action' };
    }
    const rawHealth = String(data.health ?? 'onTrack');
    if (!Object.prototype.hasOwnProperty.call(LINEAR_PROJECT_HEALTH_BADGES, rawHealth)) {
      throw new ExtensionSdkError(
        'INVALID_PROJECT_HEALTH',
        `Unsupported Linear ProjectUpdate health "${rawHealth}"; expected onTrack, atRisk, or offTrack.`
      );
    }
    const health = /** @type {'onTrack' | 'atRisk' | 'offTrack'} */ (rawHealth);
    const badge = LINEAR_PROJECT_HEALTH_BADGES[health];
    const projectName = sanitizeLinearText(data.project?.name ?? data.projectName, 'Project', 100);
    const author = sanitizeLinearText(data.user?.name ?? payload.actor?.name, 'Lead', 60);
    const summary = sanitizeLinearText(data.body, 'Project status updated.', 280);
    const updateId = sanitizeLinearText(String(data.id ?? `${projectName}-${health}`), 'pu1', 64);
    const url = validateLinearUrl(payload.url ?? data.url ?? 'https://linear.app/kodera/projects');
    const text = `${badge} **${projectName}** project update by **${author}** — ${summary}\n${url}`;
    const idempotencyKey = `linear:project-update:${updateId}`;
    const blocks = [{ type: 'linear_project_update_card', projectName, health, author, summary, url }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, projectName, health, idempotencyKey, delivery };
    }
    return { posted: false, projectName, health, idempotencyKey, text, blocks };
  }

  return { posted: false, ignored: true, reason: 'unhandled_entity', entityType };
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` signatures
 * and native `Linear-Signature` (`HMAC-SHA256`) + `webhookTimestamp` freshness verification.
 *
 * @param {{
 *   secret: string,
 *   linearSecret?: string,
 *   defaultChannelId?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createLinearWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const linearSecret = config.linearSecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_linear';
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
      Issue: (payload, { client }) => processLinearEvent({ ...payload, entityType: 'Issue' }, { ...stateBase, client }),
      Comment: (payload, { client }) => processLinearEvent({ ...payload, entityType: 'Comment' }, { ...stateBase, client }),
      Cycle: (payload, { client }) => processLinearEvent({ ...payload, entityType: 'Cycle' }, { ...stateBase, client }),
      ProjectUpdate: (payload, { client }) =>
        processLinearEvent({ ...payload, entityType: 'ProjectUpdate' }, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        linearCommand.handler({
          command: 'linear',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_unknown'),
        }),
    },
  });

  return async function handleIncomingLinearWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const linearSig = getHeaderValue(req.headers, 'linear-signature');

    if (koderaSig !== undefined || linearSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const { payload, timestampSeconds, signature } = verifyLinearWebhookRequest({
      secret: linearSecret,
      rawBody: req.rawBody,
      signatureHeader: linearSig,
      nowUnixSeconds: nowSec,
      maxSkewSeconds,
    });

    const rawDeliveryId = getHeaderValue(req.headers, 'linear-delivery') ?? (typeof payload.webhookId === 'string' ? payload.webhookId : undefined);
    if (rawDeliveryId !== undefined && !DELIVERY_ID_PATTERN.test(rawDeliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Linear webhookId/delivery header must be bounded.');
    }

    pruneReplay(nowSec);
    if (seenSignatures.has(signature) || (rawDeliveryId !== undefined && seenDeliveries.has(rawDeliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate Linear webhook delivery rejected.');
    }
    if (seenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Linear webhook replay cache is full.');
    }
    seenSignatures.set(signature, timestampSeconds);
    if (rawDeliveryId !== undefined) {
      seenDeliveries.set(rawDeliveryId, timestampSeconds);
    }

    const activeClient = req.client ?? config.client;
    const result = await processLinearEvent(payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: result.ignored ? 202 : 200,
      event: String(payload.type ?? 'LinearWebhook'),
      deliveryId: rawDeliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createLinearWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  linearCommand,
  handleLinearCommand,
  createLinearWebhookHandler,
  createExtensionWebhookHandler,
};

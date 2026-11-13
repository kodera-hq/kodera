import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
const ALERTMANAGER_SIG_PATTERN = /^(?:sha256=)?([0-9a-fA-F]{64})$/;
const BEARER_HEADER_PATTERN = /^Bearer\s+(\S+)$/i;
const SAFE_ALERT_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ACTIVE_GROUPS = 1024;

export const ALERTMANAGER_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'firing',
  'runbook',
  'status',
]);

export const ALERTMANAGER_SEVERITY_BADGES = Object.freeze([
  'critical',
  'warning',
  'info',
]);

/**
 * Validates and normalizes the `alertmanager` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateAlertmanagerManifest(input = rawManifest, options = {}) {
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
    throw new ExtensionSdkError('INVALID_MANIFEST_ID', `Invalid Alertmanager manifest id "${rawId}".`);
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

export const extensionManifest = validateAlertmanagerManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeAlertText(rawValue, fallback = '', maxLength = 240) {
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
 * Normalizes an Alertmanager or Grafana severity label into a badge (`critical` | `warning` | `info`)
 * and a Kodera SDK `IncidentSeverity` (`critical` | `high` | `medium` | `low` | `info`).
 *
 * @param {unknown} rawSeverity
 * @returns {{ badge: 'critical' | 'warning' | 'info', incidentSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info' }}
 */
export function resolveAlertSeverity(rawSeverity) {
  const s = String(rawSeverity ?? 'warning').trim().toLowerCase();
  if (s === 'critical' || s === 'page' || s === 'fatal' || s === 'p1') {
    return { badge: 'critical', incidentSeverity: 'critical' };
  }
  if (s === 'high' || s === 'error') {
    return { badge: 'critical', incidentSeverity: 'high' };
  }
  if (s === 'warning' || s === 'warn' || s === 'medium') {
    return { badge: 'warning', incidentSeverity: 'medium' };
  }
  if (s === 'info' || s === 'informational' || s === 'none' || s === 'low') {
    return { badge: 'info', incidentSeverity: 'info' };
  }
  return { badge: 'warning', incidentSeverity: 'medium' };
}

/**
 * Computes an `X-Alertmanager-Signature` (`sha256=<hex>`) header over raw bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signAlertmanagerWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Alertmanager secret must be at least 16 characters.');
  }
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

/**
 * Verifies an incoming Alertmanager or Grafana webhook using either constant-time
 * `X-Alertmanager-Signature` (`HMAC-SHA256`) OR constant-time `Authorization: Bearer <secret>`
 * over 32-byte SHA-256 digests so secret length never leaks.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader?: string | undefined,
 *   authorizationHeader?: string | undefined,
 * }} params
 */
export function verifyAlertmanagerWebhookRequest({
  secret,
  rawBody,
  signatureHeader,
  authorizationHeader,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Alertmanager secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Alertmanager webhook body is empty or exceeds the byte limit.');
  }

  if (signatureHeader !== undefined) {
    const sigMatch = ALERTMANAGER_SIG_PATTERN.exec(signatureHeader.trim());
    if (!sigMatch) {
      throw new WebhookVerificationError('MISSING_SIGNATURE', 'Malformed X-Alertmanager-Signature header.');
    }
    const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
    const actualBuf = Buffer.from(sigMatch[1], 'hex');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'X-Alertmanager-Signature verification failed.');
    }
  } else if (authorizationHeader !== undefined) {
    if (authorizationHeader.length > 4096) {
      throw new WebhookVerificationError('MISSING_SIGNATURE', 'Authorization header exceeds maximum length.');
    }
    const bearerMatch = BEARER_HEADER_PATTERN.exec(authorizationHeader.trim());
    if (!bearerMatch) {
      throw new WebhookVerificationError('MISSING_SIGNATURE', 'Expected Authorization: Bearer <secret>.');
    }
    const expectedDigest = createHash('sha256').update(secret, 'utf8').digest();
    const actualDigest = createHash('sha256').update(bearerMatch[1], 'utf8').digest();
    if (!timingSafeEqual(expectedDigest, actualDigest)) {
      throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Alertmanager Bearer secret verification failed.');
    }
  } else {
    throw new WebhookVerificationError(
      'MISSING_SIGNATURE',
      'Missing X-Alertmanager-Signature or Authorization Bearer header.'
    );
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Alertmanager webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Alertmanager webhook payload must be a JSON object.');
  }

  const bodyDigest = createHash('sha256').update(bodyBuf).digest('hex');
  return {
    payload: /** @type {Record<string, unknown>} */ (payload),
    bodyDigest,
  };
}

/**
 * Executes the `/alerts` slash command (`firing`, `runbook`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   activeCount?: number,
 * }} input
 */
export function handleAlertsCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_alerts';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_oncall';
  const activeCount = Number(input.activeCount ?? 0);

  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/alerts ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!ALERTMANAGER_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_ALERTS_SUBCOMMAND',
      `Unsupported /alerts subcommand "${subcommand}"; expected: ${ALERTMANAGER_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  if (subcommand === 'firing') {
    const severityFilter = typeof parsed.flags.severity === 'string'
      ? parsed.flags.severity.toLowerCase()
      : 'all';
    if (severityFilter !== 'all' && !ALERTMANAGER_SEVERITY_BADGES.includes(severityFilter)) {
      throw new ExtensionSdkError('INVALID_SEVERITY_FILTER', `Unsupported severity badge "${severityFilter}".`);
    }
    return {
      text: `[Alertmanager] Firing alerts [severity=${severityFilter}] (${activeCount} active group${activeCount === 1 ? '' : 's'}) requested by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'firing',
      severity: severityFilter,
      activeCount,
    };
  }

  if (subcommand === 'runbook') {
    const alertName = String(parsed.flags.alert ?? parsed.args[0] ?? 'HighErrorRate').trim();
    if (!SAFE_ALERT_NAME_PATTERN.test(alertName)) {
      throw new ExtensionSdkError('INVALID_ALERT_NAME', `Invalid alert name "${alertName}".`);
    }
    const url = validateEndpointUrl(
      `https://runbooks.example.org/alerts/${encodeURIComponent(alertName)}`,
      { allowLocalhostHttp: false }
    );
    return {
      text: `[Alertmanager Runbook] **${alertName}** reference for <#${channelId}>: ${url}`,
      ephemeral: true,
      subcommand: 'runbook',
      alertName,
      runbookUrl: url,
    };
  }

  return {
    text: `[Alertmanager] Bridge ready in <#${channelId}> (${activeCount} firing group${activeCount === 1 ? '' : 's'}) — subcommands: \`firing\`, \`runbook\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    activeCount,
  };
}

export const alertsCommand = defineSlashCommand({
  name: '/alerts',
  description: 'List firing alerts, inspect runbooks, or check Alertmanager routing status',
  scopes: ['messages:write', 'incidents:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleAlertsCommand({ args, channelId, actorId }),
});

export const slashCommand = alertsCommand;

/**
 * Normalizes Prometheus Alertmanager v4 and Grafana Unified Alerting payloads and posts
 * structured incident cards (`postIncidentCard`) or resolution thread replies.
 *
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   activeGroups: Map<string, { threadRootId: string, channelId: string, alertName: string, badge: string }>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processAlertPayload(payload, state) {
  const { defaultChannelId, activeGroups, client } = state;
  const channelId = String(payload.channelId ?? defaultChannelId);

  const rawStatus = String(payload.status ?? payload.state ?? 'firing').toLowerCase();
  const normalizedStatus =
    rawStatus === 'resolved' || rawStatus === 'ok' || rawStatus === 'normal' ? 'resolved' : 'firing';

  const commonLabels = /** @type {Record<string, unknown>} */ (
    typeof payload.commonLabels === 'object' && payload.commonLabels !== null ? payload.commonLabels : {}
  );
  const commonAnnotations = /** @type {Record<string, unknown>} */ (
    typeof payload.commonAnnotations === 'object' && payload.commonAnnotations !== null
      ? payload.commonAnnotations
      : {}
  );
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const firstAlert = /** @type {Record<string, unknown>} */ (
    alerts.length > 0 && typeof alerts[0] === 'object' && alerts[0] !== null ? alerts[0] : {}
  );
  const firstLabels = /** @type {Record<string, unknown>} */ (
    typeof firstAlert.labels === 'object' && firstAlert.labels !== null ? firstAlert.labels : {}
  );
  const firstAnnotations = /** @type {Record<string, unknown>} */ (
    typeof firstAlert.annotations === 'object' && firstAlert.annotations !== null ? firstAlert.annotations : {}
  );

  const isGrafana = payload.orgId !== undefined || payload.ruleUrl !== undefined || firstAlert.dashboardURL !== undefined;
  const alertName = sanitizeAlertText(
    commonLabels.alertname ?? firstLabels.alertname ?? payload.title ?? 'AlertGroup',
    'AlertGroup',
    100
  );
  const serviceName = sanitizeAlertText(
    commonLabels.service ?? commonLabels.job ?? firstLabels.service ?? firstLabels.job ?? 'cluster',
    'cluster',
    60
  );
  const { badge, incidentSeverity } = resolveAlertSeverity(
    commonLabels.severity ?? firstLabels.severity ?? payload.severity ?? 'warning'
  );

  const rawExternalUrl =
    payload.externalURL ?? payload.ruleUrl ?? firstAlert.dashboardURL ?? firstAlert.generatorURL;
  const externalUrl =
    rawExternalUrl !== undefined && String(rawExternalUrl).trim() !== ''
      ? validateEndpointUrl(String(rawExternalUrl), { allowLocalhostHttp: false })
      : undefined;

  const rawRunbookUrl =
    commonAnnotations.runbook_url ?? firstAnnotations.runbook_url ?? payload.runbook_url;
  const runbookUrl =
    rawRunbookUrl !== undefined && String(rawRunbookUrl).trim() !== ''
      ? validateEndpointUrl(String(rawRunbookUrl), { allowLocalhostHttp: false })
      : undefined;

  const rawGroupKey = String(
    payload.groupKey ?? payload.groupId ?? `${alertName}:${serviceName}`
  ).slice(0, 180);
  const groupDigest = createHash('sha256').update(rawGroupKey, 'utf8').digest('hex').slice(0, 16);

  const summaryAnnotation = sanitizeAlertText(
    commonAnnotations.summary ??
      commonAnnotations.description ??
      firstAnnotations.summary ??
      firstAnnotations.description ??
      payload.message ??
      `${alertName} is ${normalizedStatus}`,
    `${alertName} is ${normalizedStatus}`,
    300
  );

  const alertCount = Math.max(1, alerts.length);
  const sourceLabel = isGrafana ? 'Grafana' : 'Alertmanager';

  if (normalizedStatus === 'firing') {
    const title = `[${badge.toUpperCase()}] ${alertName} (${serviceName})`.slice(0, 200);
    const lines = [
      `Source: ${sourceLabel} · Badge: ${badge} · Alerts: ${alertCount} · Status: firing`,
      summaryAnnotation,
    ];
    if (runbookUrl) lines.push(`Runbook: ${runbookUrl}`);
    if (externalUrl) lines.push(`Console: ${externalUrl}`);
    const summary = lines.join('\n');
    const idempotencyKey = `alertmanager:firing:${groupDigest}:${alertCount}`;

    if (client) {
      const delivery = await client.postIncidentCard({
        channelId,
        title,
        severity: incidentSeverity,
        summary,
        ...(externalUrl ? { externalUrl } : {}),
        status: 'open',
        idempotencyKey,
      });
      if (typeof delivery.id === 'string') {
        if (activeGroups.size >= MAX_ACTIVE_GROUPS && !activeGroups.has(groupDigest)) {
          const oldest = activeGroups.keys().next().value;
          if (oldest !== undefined) activeGroups.delete(oldest);
        }
        activeGroups.set(groupDigest, {
          threadRootId: delivery.id,
          channelId,
          alertName,
          badge,
        });
      }
      return {
        posted: true,
        status: 'firing',
        source: sourceLabel.toLowerCase(),
        alertName,
        severityBadge: badge,
        severity: incidentSeverity,
        alertCount,
        runbookUrl: runbookUrl ?? null,
        externalUrl: externalUrl ?? null,
        idempotencyKey,
        delivery,
      };
    }

    return {
      posted: false,
      status: 'firing',
      source: sourceLabel.toLowerCase(),
      alertName,
      severityBadge: badge,
      severity: incidentSeverity,
      alertCount,
      runbookUrl: runbookUrl ?? null,
      externalUrl: externalUrl ?? null,
      idempotencyKey,
      summary,
    };
  }

  // Resolved state
  const existing = activeGroups.get(groupDigest);
  activeGroups.delete(groupDigest);
  const idempotencyKey = `alertmanager:resolved:${groupDigest}`;
  const resolvedText = `[RESOLVED] **${alertName}** (${serviceName}) [${badge}] — ${summaryAnnotation}${
    runbookUrl ? `\nRunbook: ${runbookUrl}` : ''
  }`;

  if (client) {
    if (existing) {
      const delivery = await client.postThreadReply({
        channelId: existing.channelId,
        threadRootId: existing.threadRootId,
        text: resolvedText,
        idempotencyKey,
      });
      return {
        posted: true,
        threaded: true,
        status: 'resolved',
        alertName,
        severityBadge: badge,
        idempotencyKey,
        delivery,
      };
    }

    const delivery = await client.postIncidentCard({
      channelId,
      title: `[RESOLVED] ${alertName} (${serviceName})`.slice(0, 200),
      severity: incidentSeverity,
      summary: resolvedText,
      ...(externalUrl ? { externalUrl } : {}),
      status: 'resolved',
      idempotencyKey,
    });
    return {
      posted: true,
      threaded: false,
      status: 'resolved',
      alertName,
      severityBadge: badge,
      idempotencyKey,
      delivery,
    };
  }

  return {
    posted: false,
    status: 'resolved',
    alertName,
    severityBadge: badge,
    idempotencyKey,
    text: resolvedText,
  };
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` signatures
 * as well as native `X-Alertmanager-Signature` (`HMAC-SHA256`) and constant-time
 * `Authorization: Bearer <secret>` verification for Prometheus Alertmanager v4 and Grafana Unified Alerting.
 *
 * @param {{
 *   secret: string,
 *   webhookSecret?: string,
 *   defaultChannelId?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createAlertmanagerWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const webhookSecret = config.webhookSecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_alerts';
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, { threadRootId: string, channelId: string, alertName: string, badge: string }>} */
  const activeGroups = new Map();
  /** @type {Map<string, number>} */
  const seenDigests = new Map();

  const pruneReplay = (nowSec) => {
    for (const [digest, ts] of seenDigests.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenDigests.delete(digest);
    }
  };

  const stateBase = {
    defaultChannelId,
    activeGroups,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'alertmanager.v4': (payload, { client }) => processAlertPayload(payload, { ...stateBase, client }),
      'grafana.alert': (payload, { client }) => processAlertPayload(payload, { ...stateBase, client }),
      'incident.opened': (payload, { client }) =>
        processAlertPayload({ ...payload, status: 'firing' }, { ...stateBase, client }),
      'incident.resolved': (payload, { client }) =>
        processAlertPayload({ ...payload, status: 'resolved' }, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleAlertsCommand({
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_oncall'),
          activeCount: activeGroups.size,
        }),
    },
  });

  return async function handleIncomingAlertmanagerWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const alertSig = getHeaderValue(req.headers, 'x-alertmanager-signature');
    const authHeader = getHeaderValue(req.headers, 'authorization');

    if (koderaSig !== undefined || (alertSig === undefined && authHeader === undefined)) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId = getHeaderValue(req.headers, 'x-alertmanager-delivery');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'X-Alertmanager-Delivery must be bounded.');
    }

    const { payload, bodyDigest } = verifyAlertmanagerWebhookRequest({
      secret: webhookSecret,
      rawBody: req.rawBody,
      signatureHeader: alertSig,
      authorizationHeader: authHeader,
    });

    pruneReplay(nowSec);
    const replayKey = deliveryId ? `${deliveryId}:${bodyDigest}` : bodyDigest;
    if (seenDigests.has(bodyDigest) || seenDigests.has(replayKey)) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate Alertmanager/Grafana webhook rejected.');
    }
    if (seenDigests.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Alertmanager replay cache is full.');
    }
    seenDigests.set(bodyDigest, nowSec);

    const activeClient = req.client ?? config.client;
    const result = await processAlertPayload(payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: 200,
      event: `alert.${result.status}`,
      deliveryId: deliveryId ?? bodyDigest.slice(0, 16),
      result,
    };
  };
}

export const createExtensionWebhookHandler = createAlertmanagerWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  alertsCommand,
  handleAlertsCommand,
  createAlertmanagerWebhookHandler,
  createExtensionWebhookHandler,
};

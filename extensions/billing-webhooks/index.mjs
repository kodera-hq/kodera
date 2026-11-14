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
  validateManifest,
} from '@kodera/extension-sdk';

const rawManifest = JSON.parse(
  readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')
);

const REVERSE_DNS_ID_PREFIX = 'io.kodera.ext.';
const REVERSE_DNS_ID_PATTERN = /^io\.kodera\.ext\.([a-z0-9][a-z0-9-]{1,62})$/;
const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const TIMESTAMP_DIGITS_PATTERN = /^(0|[1-9]\d{0,15})$/;
const HEX_SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const SAFE_WORKSPACE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;
const SAFE_PLAN_TIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;
const SAFE_EVENT_ID_PATTERN = /^[a-zA-Z]{2,8}_[A-Za-z0-9_-]{2,48}$/;
const SAFE_QUOTA_METRIC_PATTERN = /^[a-z][a-z0-9_.-]{1,47}$/;
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

export const SUPPORTED_BILLING_EVENTS = Object.freeze([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'quota.threshold_reached',
]);

export const BILLING_OPS_SUBCOMMANDS = Object.freeze([
  'summary',
  'quotas',
  'policy',
  'status',
]);

export const DEFAULT_AUTHORIZED_OPS_CHANNELS = Object.freeze([
  'chan_billing_ops',
  'chan_ops',
  'billing-ops',
]);

export const ALLOWED_BILLING_STATUSES = Object.freeze([
  'completed',
  'paid',
  'payment_failed',
  'open',
  'past_due',
  'unpaid',
  'active',
  'trialing',
  'canceled',
  'paused',
  'threshold_reached',
  'warning',
  'critical',
]);

/**
 * Explicit list of sensitive PII/PCI object keys that are structurally ignored and stripped.
 */
export const FORBIDDEN_PII_KEYS = Object.freeze([
  'customer_email',
  'receipt_email',
  'email',
  'customer_name',
  'name',
  'phone',
  'customer_phone',
  'address',
  'billing_details',
  'customer_details',
  'shipping',
  'shipping_details',
  'card',
  'payment_method',
  'payment_method_details',
  'last4',
  'number',
  'pan',
  'cvc',
  'exp_month',
  'exp_year',
  'fingerprint',
  'iban',
  'bic',
  'tax_id',
  'tax_ids',
]);

/**
 * Validates and normalizes the `billing-webhooks` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateBillingWebhooksManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateBillingWebhooksManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Linear-time plain-text sanitizer and PII scrubber (strips markup, emails, IBANs,
 * long digit runs / card PANs, and phone-number sequences without backtracking regexes).
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function redactBillingText(rawValue, fallback = '', maxLength = 160) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const bounded = rawValue.length > 8_192 ? rawValue.slice(0, 8_192) : rawValue;
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

  const tokens = out
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((token) => {
      // Email-like token
      if (token.includes('@')) {
        return '[REDACTED_EMAIL]';
      }
      const compactAlphaNum = token.replaceAll(/[^A-Za-z0-9]/g, '');
      const digitCount = compactAlphaNum.replaceAll(/[^0-9]/g, '').length;
      // IBAN-like token (2 letters + 2 digits + >=10 alphanumerics)
      if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i.test(compactAlphaNum)) {
        return '[REDACTED_IBAN]';
      }
      // Card PAN or phone token (8+ digits or + prefix with 7+ digits)
      if (digitCount >= 8 || (token.startsWith('+') && digitCount >= 6)) {
        return '[REDACTED_NUMBER]';
      }
      return token;
    });

  let cleaned = tokens.join(' ').trim();
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
 * Formats integer minor currency units into deterministic `0.00 CUR` summary text.
 *
 * @param {unknown} rawAmountMinor
 * @param {unknown} rawCurrency
 * @returns {{ amountMinor: number, currency: string, formattedAmount: string }}
 */
export function formatBillingAmount(rawAmountMinor, rawCurrency = 'EUR') {
  const currencyCandidate = typeof rawCurrency === 'string' ? rawCurrency.trim().toUpperCase() : 'EUR';
  const currency = ISO_CURRENCY_PATTERN.test(currencyCandidate) ? currencyCandidate : 'EUR';
  const parsedMinor = Number(rawAmountMinor ?? 0);
  if (!Number.isSafeInteger(parsedMinor) || parsedMinor < 0 || parsedMinor > 100_000_000_000) {
    throw new ExtensionSdkError('INVALID_BILLING_AMOUNT', 'Billing amount in minor units must be a non-negative integer.');
  }

  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return {
      amountMinor: parsedMinor,
      currency,
      formattedAmount: `${parsedMinor} ${currency}`,
    };
  }

  const major = Math.floor(parsedMinor / 100);
  const minor = String(parsedMinor % 100).padStart(2, '0');
  return {
    amountMinor: parsedMinor,
    currency,
    formattedAmount: `${major}.${minor} ${currency}`,
  };
}

/**
 * Strictly projects an untrusted billing or quota webhook payload down to an allowlist-only,
 * zero-PII operational summary. Customer addresses, card PAN/last4/CVC/fingerprints, IBANs,
 * phone numbers, customer names, and email addresses are never read or forwarded.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} envelope
 */
export function extractRedactedBillingSummary(eventName, envelope) {
  if (!SUPPORTED_BILLING_EVENTS.includes(eventName)) {
    throw new ExtensionSdkError('UNSUPPORTED_BILLING_EVENT', `Unsupported billing event "${eventName}".`);
  }

  const dataWrapper = /** @type {Record<string, unknown> | undefined} */ (
    typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
      ? envelope.data
      : undefined
  );
  const obj = /** @type {Record<string, unknown>} */ (
    typeof dataWrapper?.object === 'object' && dataWrapper.object !== null && !Array.isArray(dataWrapper.object)
      ? dataWrapper.object
      : envelope
  );
  const metadata = /** @type {Record<string, unknown>} */ (
    typeof obj.metadata === 'object' && obj.metadata !== null && !Array.isArray(obj.metadata)
      ? obj.metadata
      : typeof envelope.metadata === 'object' && envelope.metadata !== null && !Array.isArray(envelope.metadata)
        ? envelope.metadata
        : {}
  );

  // 1. Workspace slug (strict lowercase kebab-case starting with a letter; never an email or numeric ID)
  const rawWorkspace = String(
    metadata.workspace_slug ?? metadata.workspaceSlug ?? obj.workspaceSlug ?? envelope.workspaceSlug ?? 'unassigned-workspace'
  )
    .trim()
    .toLowerCase();
  const workspaceSlug = SAFE_WORKSPACE_SLUG_PATTERN.test(rawWorkspace) ? rawWorkspace : 'unassigned-workspace';

  // 2. Plan tier (strict identifier)
  const rawPlan = String(
    metadata.plan_tier ?? metadata.planTier ?? obj.planTier ?? obj.plan?.nickname ?? envelope.planTier ?? 'standard'
  ).trim();
  const planTier = SAFE_PLAN_TIER_PATTERN.test(rawPlan) ? rawPlan.toLowerCase() : 'standard';

  // 3. Synthetic/provider event identifier (strict prefix + alphanumeric, never free text)
  const rawEventId = String(envelope.id ?? obj.id ?? 'evt_synthetic').trim();
  const eventId = SAFE_EVENT_ID_PATTERN.test(rawEventId) ? rawEventId : 'evt_redacted';

  // 4. Quota threshold payload vs monetary billing payload
  if (eventName === 'quota.threshold_reached') {
    const rawMetric = String(obj.metric ?? metadata.quota_metric ?? 'workspace_storage_gb')
      .trim()
      .toLowerCase();
    const quotaMetric = SAFE_QUOTA_METRIC_PATTERN.test(rawMetric) ? rawMetric : 'workspace_quota';
    const rawPct = Number(obj.usagePercent ?? obj.usage_percent ?? metadata.usage_percent ?? 80);
    if (!Number.isFinite(rawPct) || rawPct < 0 || rawPct > 1000) {
      throw new ExtensionSdkError('INVALID_QUOTA_PERCENT', 'Quota usagePercent must be between 0 and 1000.');
    }
    const usagePercent = Math.round(rawPct * 10) / 10;
    const status = usagePercent >= 95 ? 'critical' : usagePercent >= 80 ? 'warning' : 'threshold_reached';

    return Object.freeze({
      event: eventName,
      eventId,
      workspaceSlug,
      planTier,
      status,
      currency: null,
      amountMinor: null,
      formattedAmount: null,
      quotaMetric,
      quotaUsagePercent: usagePercent,
      piiRedacted: true,
    });
  }

  const rawMinor =
    obj.amount_paid ??
    obj.amount_due ??
    obj.amount_total ??
    obj.amountMinor ??
    envelope.amountMinor ??
    0;
  const rawCurrency = obj.currency ?? envelope.currency ?? 'EUR';
  const amountInfo = formatBillingAmount(rawMinor, rawCurrency);

  const defaultStatusByEvent = {
    'checkout.session.completed': 'completed',
    'invoice.paid': 'paid',
    'invoice.payment_failed': 'payment_failed',
    'customer.subscription.updated': 'active',
  };
  const candidateStatus = String(obj.status ?? defaultStatusByEvent[eventName] ?? 'open')
    .trim()
    .toLowerCase();
  const status =
    eventName === 'invoice.payment_failed'
      ? 'payment_failed'
      : ALLOWED_BILLING_STATUSES.includes(candidateStatus)
        ? candidateStatus
        : defaultStatusByEvent[eventName];

  return Object.freeze({
    event: eventName,
    eventId,
    workspaceSlug,
    planTier,
    status,
    currency: amountInfo.currency,
    amountMinor: amountInfo.amountMinor,
    formattedAmount: amountInfo.formattedAmount,
    quotaMetric: null,
    quotaUsagePercent: null,
    piiRedacted: true,
  });
}

/**
 * Computes a timestamped `t=<unix>,v1=<hex>` HMAC-SHA256 billing webhook signature header
 * over `${timestamp}.${rawBody}`.
 *
 * @param {string} secret
 * @param {number | string} timestampSeconds
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signBillingWebhookPayload(secret, timestampSeconds, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Billing webhook secret must be at least 16 characters.');
  }
  const ts = String(timestampSeconds);
  if (!TIMESTAMP_DIGITS_PATTERN.test(ts) || !Number.isSafeInteger(Number(ts))) {
    throw new WebhookVerificationError('INVALID_TIMESTAMP', 'Billing webhook timestamp must be a non-negative safe integer.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const digest = createHmac('sha256', secret)
    .update(ts, 'utf8')
    .update('.', 'utf8')
    .update(bodyBuf)
    .digest('hex');
  return `t=${ts},v1=${digest}`;
}

/**
 * Verifies a timestamped `t=<unix>,v1=<hex>` signature header (`Stripe-Signature` or `X-Billing-Signature`)
 * using constant-time `timingSafeEqual` across `v1` candidates and a strict replay skew window.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   nowUnixSeconds?: number,
 *   maxSkewSeconds?: number,
 * }} params
 */
export function verifyBillingWebhookSignature({
  secret,
  rawBody,
  signatureHeader,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Billing webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Billing webhook body is empty or exceeds the byte limit.');
  }

  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing timestamped t=...,v1=... signature header.');
  }

  let tsRaw = '';
  /** @type {string[]} */
  const v1Candidates = [];
  const parts = signatureHeader.split(',');
  if (parts.length > 16) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Malformed billing signature header.');
  }

  for (const rawPart of parts) {
    const eqIdx = rawPart.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = rawPart.slice(0, eqIdx).trim();
    const val = rawPart.slice(eqIdx + 1).trim();
    if (key === 't' && !tsRaw) {
      tsRaw = val;
    } else if (key === 'v1' && HEX_SHA256_PATTERN.test(val)) {
      v1Candidates.push(val.toLowerCase());
    }
  }

  if (!TIMESTAMP_DIGITS_PATTERN.test(tsRaw)) {
    throw new WebhookVerificationError('MISSING_TIMESTAMP', 'Missing or non-numeric t= timestamp in billing signature.');
  }
  if (v1Candidates.length === 0) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'No valid 64-hex v1= digest found in billing signature.');
  }

  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(nowUnixSeconds - ts) > maxSkewSeconds) {
    throw new WebhookVerificationError('TIMESTAMP_OUT_OF_RANGE', 'Billing webhook timestamp outside allowed replay window.');
  }

  const expectedBuf = createHmac('sha256', secret)
    .update(tsRaw, 'utf8')
    .update('.', 'utf8')
    .update(bodyBuf)
    .digest();

  let matchedHex = null;
  for (const candidateHex of v1Candidates) {
    const candidateBuf = Buffer.from(candidateHex, 'hex');
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, candidateBuf)) {
      matchedHex = candidateHex;
    }
  }

  if (!matchedHex) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Billing t=...,v1=... HMAC-SHA256 verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Billing webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Billing webhook payload must be a JSON object.');
  }

  const eventName = String(payload.type ?? payload.event ?? '').trim();
  if (!SUPPORTED_BILLING_EVENTS.includes(eventName)) {
    throw new WebhookVerificationError(
      'INVALID_EVENT',
      `Unsupported billing event "${eventName}"; expected one of: ${SUPPORTED_BILLING_EVENTS.join(', ')}.`
    );
  }

  return {
    event: eventName,
    timestamp: ts,
    payload: /** @type {Record<string, unknown>} */ (payload),
    replayToken: `t=${ts},v1=${matchedHex}`,
  };
}

/**
 * Executes the `/billing-ops` slash command (`summary`, `quotas`, `policy`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   authorizedOpsChannels?: readonly string[],
 * }} input
 */
export function handleBillingOpsCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_billing_ops';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_ops';
  const authorizedChannels = input.authorizedOpsChannels ?? DEFAULT_AUTHORIZED_OPS_CHANNELS;
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/billing-ops ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!BILLING_OPS_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_BILLING_SUBCOMMAND',
      `Unsupported /billing-ops subcommand "${subcommand}"; expected: ${BILLING_OPS_SUBCOMMANDS.join(', ')}.`
    );
  }

  const rawWorkspace = String(parsed.flags.workspace ?? parsed.args[0] ?? 'studio-alpha')
    .trim()
    .toLowerCase();
  const workspaceSlug = SAFE_WORKSPACE_SLUG_PATTERN.test(rawWorkspace) ? rawWorkspace : 'studio-alpha';
  const isAuthorizedChannel = authorizedChannels.includes(channelId);

  if ((subcommand === 'summary' || subcommand === 'quotas') && !isAuthorizedChannel) {
    throw new ExtensionSdkError(
      'UNAUTHORIZED_BILLING_CHANNEL',
      `Channel "${channelId}" is not in authorizedOpsChannels; billing summaries are restricted to ops channels.`
    );
  }

  if (subcommand === 'summary') {
    return {
      text: `[Billing Ops] Redacted subscription & invoice status for workspace \`${workspaceSlug}\` requested by <@${actorId}> (PII redaction enforced).`,
      ephemeral: true,
      subcommand: 'summary',
      workspaceSlug,
      piiRedacted: true,
    };
  }

  if (subcommand === 'quotas') {
    return {
      text: `[Quota Ops] Infrastructure quota threshold watch active for workspace \`${workspaceSlug}\` in <#${channelId}>.`,
      ephemeral: true,
      subcommand: 'quotas',
      workspaceSlug,
      piiRedacted: true,
    };
  }

  if (subcommand === 'policy') {
    return {
      text: `[Billing Privacy Policy] Strict PII redaction active — emails, addresses, phone numbers, card PAN/last4, and IBANs are stripped before channel emission.`,
      ephemeral: true,
      subcommand: 'policy',
      authorizedOpsChannels: [...authorizedChannels],
      piiRedacted: true,
    };
  }

  return {
    text: `[Billing & Quota Ops] Bridge ready (PII redaction enforced; authorized ops channels: ${authorizedChannels.map((c) => `\`${c}\``).join(', ')}) — subcommands: \`summary\`, \`quotas\`, \`policy\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    piiRedacted: true,
  };
}

export const billingOpsCommand = defineSlashCommand({
  name: '/billing-ops',
  description: 'Inspect redacted workspace plan, invoice status, or quota thresholds in authorized ops channels',
  scopes: ['ephemeral:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleBillingOpsCommand({ args, channelId, actorId }),
});

export const slashCommand = billingOpsCommand;

/**
 * Processes a verified billing or quota webhook event, enforcing authorized ops channel routing
 * and strict allowlist-only PII redaction.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   authorizedOpsChannels: readonly string[],
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processBillingEvent(eventName, payload, state) {
  const { defaultChannelId, authorizedOpsChannels, client } = state;
  const targetChannel =
    typeof payload.channelId === 'string' && payload.channelId.trim()
      ? payload.channelId.trim()
      : defaultChannelId;

  if (!authorizedOpsChannels.includes(targetChannel)) {
    throw new ExtensionSdkError(
      'UNAUTHORIZED_BILLING_CHANNEL',
      `Refusing to emit billing ops card to unauthorized channel "${targetChannel}".`
    );
  }

  const summary = extractRedactedBillingSummary(eventName, payload);
  const badgeMap = {
    'checkout.session.completed': '[CHECKOUT COMPLETED]',
    'invoice.paid': '[INVOICE PAID]',
    'invoice.payment_failed': '[PAYMENT FAILED]',
    'customer.subscription.updated': '[SUBSCRIPTION UPDATED]',
    'quota.threshold_reached': '[QUOTA THRESHOLD]',
  };
  const badge = badgeMap[eventName] ?? '[BILLING OPS]';

  const text =
    eventName === 'quota.threshold_reached'
      ? `${badge} Workspace \`${summary.workspaceSlug}\` (plan: \`${summary.planTier}\`) reached **${summary.quotaUsagePercent}%** on \`${summary.quotaMetric}\` [status=${summary.status}]`
      : `${badge} Workspace \`${summary.workspaceSlug}\` · Plan \`${summary.planTier}\` · Amount **${summary.formattedAmount}** · Status \`${summary.status}\``;

  const idempotencyKey = `billing:${eventName}:${summary.workspaceSlug}:${summary.eventId}:${summary.status}`;
  const blocks = [
    {
      type: 'billing_ops_redacted_card',
      event: summary.event,
      eventId: summary.eventId,
      workspaceSlug: summary.workspaceSlug,
      planTier: summary.planTier,
      status: summary.status,
      currency: summary.currency,
      amountMinor: summary.amountMinor,
      formattedAmount: summary.formattedAmount,
      quotaMetric: summary.quotaMetric,
      quotaUsagePercent: summary.quotaUsagePercent,
      piiRedacted: true,
    },
  ];

  if (client) {
    const delivery = await client.postChannelMessage({
      channelId: targetChannel,
      text,
      blocks,
      idempotencyKey,
    });

    let incident = null;
    if (
      (eventName === 'invoice.payment_failed' || summary.status === 'critical') &&
      typeof client.upsertIncidentCard === 'function'
    ) {
      incident = await client.upsertIncidentCard({
        channelId: targetChannel,
        externalIncidentId: `billing:${summary.workspaceSlug}:${summary.event}`,
        title:
          eventName === 'invoice.payment_failed'
            ? `Invoice payment failed for workspace ${summary.workspaceSlug}`
            : `Quota critical (${summary.quotaUsagePercent}%) for workspace ${summary.workspaceSlug}`,
        severity: eventName === 'invoice.payment_failed' ? 'high' : 'medium',
        status: 'open',
        summary: text,
        service: 'billing-ops',
      });
    }

    return {
      posted: true,
      channelId: targetChannel,
      summary,
      idempotencyKey,
      delivery,
      incident,
    };
  }

  return {
    posted: false,
    channelId: targetChannel,
    summary,
    idempotencyKey,
    text,
    blocks,
  };
}

/**
 * Creates a webhook handler supporting both canonical Kodera `x-kodera-signature-256`
 * deliveries and timestamped `Stripe-Signature` / `X-Billing-Signature` (`t=...,v1=...`) webhooks.
 *
 * @param {{
 *   secret: string,
 *   billingSecret?: string,
 *   defaultChannelId?: string,
 *   authorizedOpsChannels?: readonly string[],
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createBillingWebhooksHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const billingSecret = config.billingSecret ?? config.secret;
  const authorizedOpsChannels = config.authorizedOpsChannels ?? DEFAULT_AUTHORIZED_OPS_CHANNELS;
  const defaultChannelId = config.defaultChannelId ?? authorizedOpsChannels[0] ?? 'chan_billing_ops';
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  if (!authorizedOpsChannels.includes(defaultChannelId)) {
    throw new ExtensionSdkError(
      'UNAUTHORIZED_BILLING_CHANNEL',
      `defaultChannelId "${defaultChannelId}" must belong to authorizedOpsChannels.`
    );
  }

  /** @type {Map<string, number>} */
  const nativeSeenTokens = new Map();
  /** @type {Map<string, number>} */
  const nativeSeenEventIds = new Map();

  const pruneNativeReplay = (nowSec) => {
    for (const [tok, ts] of nativeSeenTokens.entries()) {
      if (nowSec - ts > maxSkewSeconds) nativeSeenTokens.delete(tok);
    }
    for (const [evtId, ts] of nativeSeenEventIds.entries()) {
      if (nowSec - ts > maxSkewSeconds) nativeSeenEventIds.delete(evtId);
    }
  };

  const stateBase = {
    defaultChannelId,
    authorizedOpsChannels,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'checkout.session.completed': (payload, { client }) =>
        processBillingEvent('checkout.session.completed', payload, { ...stateBase, client }),
      'invoice.paid': (payload, { client }) =>
        processBillingEvent('invoice.paid', payload, { ...stateBase, client }),
      'invoice.payment_failed': (payload, { client }) =>
        processBillingEvent('invoice.payment_failed', payload, { ...stateBase, client }),
      'customer.subscription.updated': (payload, { client }) =>
        processBillingEvent('customer.subscription.updated', payload, { ...stateBase, client }),
      'quota.threshold_reached': (payload, { client }) =>
        processBillingEvent('quota.threshold_reached', payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleBillingOpsCommand({
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_ops'),
          authorizedOpsChannels,
        }),
    },
  });

  return async function handleIncomingBillingWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const billingSig =
      getHeaderValue(req.headers, 'stripe-signature') ??
      getHeaderValue(req.headers, 'x-billing-signature');

    if (koderaSig !== undefined || billingSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const { event, timestamp, payload, replayToken } = verifyBillingWebhookSignature({
      secret: billingSecret,
      rawBody: req.rawBody,
      signatureHeader: billingSig,
      nowUnixSeconds: nowSec,
      maxSkewSeconds,
    });

    const providerEventId =
      typeof payload.id === 'string' && SAFE_EVENT_ID_PATTERN.test(payload.id.trim())
        ? payload.id.trim()
        : undefined;

    pruneNativeReplay(nowSec);
    if (
      nativeSeenTokens.has(replayToken) ||
      (providerEventId !== undefined && nativeSeenEventIds.has(providerEventId))
    ) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate billing webhook delivery rejected.');
    }
    if (nativeSeenTokens.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Billing replay cache is full.');
    }
    nativeSeenTokens.set(replayToken, timestamp);
    if (providerEventId !== undefined) {
      nativeSeenEventIds.set(providerEventId, timestamp);
    }

    const activeClient = req.client ?? config.client;
    const result = await processBillingEvent(event, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: 200,
      event,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createBillingWebhooksHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  billingOpsCommand,
  handleBillingOpsCommand,
  redactBillingText,
  formatBillingAmount,
  extractRedactedBillingSummary,
  signBillingWebhookPayload,
  verifyBillingWebhookSignature,
  createBillingWebhooksHandler,
  createExtensionWebhookHandler,
};

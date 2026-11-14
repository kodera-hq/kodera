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
const CALCOM_HEX_SIG_PATTERN = /^(?:sha256=)?([0-9a-fA-F]{64})$/;
const ISO_8601_OFFSET_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_BOOKING_UID_PATTERN = /^[A-Za-z0-9_.-]{2,128}$/;
const SAFE_VOICE_ROOM_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MEETING_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_BOOKING_THREADS = 1024;

export const SUPPORTED_CALCOM_EVENTS = Object.freeze([
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
  'MEETING_STARTED',
]);

export const SCHEDULE_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'upcoming',
  'room',
  'booking',
  'status',
]);

export const DEFAULT_ALLOWED_CALCOM_HOSTS = Object.freeze([
  'app.cal.com',
  'cal.com',
  'cal.example.org',
  'schedule.example.com',
]);

export const DEFAULT_KODERA_VOICE_ROOM = 'office-hours';
export const DEFAULT_KODERA_WORKSPACE_URL = 'https://workspace.example.org';

/**
 * Validates and normalizes the `calcom` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateCalcomManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateCalcomManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 * Also scrubs email-containing tokens so raw participant addresses do not leak into room cards.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeCalcomText(rawValue, fallback = '', maxLength = 200) {
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
      .map((token) => (token.includes('@') && token.includes('.') ? '[redacted-email]' : token))
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
 * Validates an ISO-8601 start/end timestamp window with explicit timezone (`Z` or `±HH:MM`)
 * and normalizes both bounds to canonical UTC ISO strings.
 *
 * @param {unknown} rawStartTime
 * @param {unknown} rawEndTime
 * @returns {{ startIsoUtc: string, endIsoUtc: string, durationMinutes: number }}
 */
export function validateIsoUtcWindow(rawStartTime, rawEndTime) {
  const startRaw = typeof rawStartTime === 'string' ? rawStartTime.trim() : '';
  const endRaw = typeof rawEndTime === 'string' ? rawEndTime.trim() : '';

  if (!ISO_8601_OFFSET_PATTERN.test(startRaw) || !ISO_8601_OFFSET_PATTERN.test(endRaw)) {
    throw new ExtensionSdkError(
      'INVALID_BOOKING_TIMESTAMP',
      'Booking startTime and endTime must be ISO-8601 timestamps with explicit UTC (Z) or numeric offset.'
    );
  }

  const startMs = Date.parse(startRaw);
  const endMs = Date.parse(endRaw);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new ExtensionSdkError('INVALID_BOOKING_TIMESTAMP', 'Booking timestamps could not be parsed as valid dates.');
  }
  if (endMs <= startMs) {
    throw new ExtensionSdkError('INVALID_BOOKING_WINDOW', 'Booking endTime must be strictly after startTime.');
  }
  const durationMs = endMs - startMs;
  if (durationMs > MAX_MEETING_DURATION_MS) {
    throw new ExtensionSdkError('INVALID_BOOKING_WINDOW', 'Booking window cannot exceed 24 hours.');
  }

  return {
    startIsoUtc: new Date(startMs).toISOString(),
    endIsoUtc: new Date(endMs).toISOString(),
    durationMinutes: Math.max(1, Math.round(durationMs / 60_000)),
  };
}

/**
 * Validates a Kodera voice room slug and workspace origin, producing a structured jump action.
 *
 * @param {{
 *   roomSlug?: unknown,
 *   workspaceBaseUrl?: unknown,
 * }} [options]
 */
export function buildKoderaVoiceRoomJump(options = {}) {
  const rawSlug = typeof options.roomSlug === 'string' && options.roomSlug.trim()
    ? options.roomSlug.trim().toLowerCase()
    : DEFAULT_KODERA_VOICE_ROOM;
  if (!SAFE_VOICE_ROOM_PATTERN.test(rawSlug)) {
    throw new ExtensionSdkError(
      'INVALID_VOICE_ROOM',
      `Invalid Kodera voice room slug "${rawSlug}"; expected lowercase kebab-case.`
    );
  }

  const rawBase = typeof options.workspaceBaseUrl === 'string' && options.workspaceBaseUrl.trim()
    ? options.workspaceBaseUrl.trim()
    : DEFAULT_KODERA_WORKSPACE_URL;
  const validatedBase = validateEndpointUrl(rawBase, { allowLocalhostHttp: false });
  const parsedBase = new URL(validatedBase);
  const jumpUrl = validateEndpointUrl(`${parsedBase.origin}/voice/${encodeURIComponent(rawSlug)}`, {
    allowLocalhostHttp: false,
  });

  return {
    type: 'voice_room_jump',
    roomSlug: rawSlug,
    roomLabel: `🔊 ${rawSlug}`,
    label: `Join 🔊 ${rawSlug}`,
    jumpUrl,
  };
}

/**
 * Validates an external Cal.com booking link against SSRF vectors and an explicit host allowlist.
 *
 * @param {unknown} rawUrl
 * @param {readonly string[]} [allowedHosts]
 * @returns {string}
 */
export function validateCalcomUrl(rawUrl, allowedHosts = DEFAULT_ALLOWED_CALCOM_HOSTS) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), { allowLocalhostHttp: false });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const normalizedAllowlist = allowedHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  if (!normalizedAllowlist.includes(host)) {
    throw new ExtensionSdkError(
      'UNTRUSTED_CALCOM_HOST',
      `Cal.com URL host "${host}" is outside the configured allowlist.`
    );
  }
  return validated;
}

/**
 * Computes a Cal.com `X-Cal-Signature-256` hex HMAC-SHA256 digest over exact raw UTF-8 bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signCalcomWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Cal.com webhook secret must be at least 16 characters.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return createHmac('sha256', secret).update(bodyBuf).digest('hex');
}

/**
 * Verifies a native Cal.com `X-Cal-Signature-256` header over exact raw bytes in constant time
 * using `timingSafeEqual` and validates the trigger event and optional `createdAt` skew.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   nowUnixSeconds?: number,
 *   maxSkewSeconds?: number,
 * }} params
 */
export function verifyCalcomWebhookSignature({
  secret,
  rawBody,
  signatureHeader,
  nowUnixSeconds,
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Cal.com webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Cal.com webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? CALCOM_HEX_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed X-Cal-Signature-256 header.');
  }

  const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Cal.com X-Cal-Signature-256 verification failed.');
  }

  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Cal.com webhook body is not valid UTF-8 JSON.');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Cal.com webhook payload must be a JSON object.');
  }

  const triggerEvent = String(envelope.triggerEvent ?? envelope.type ?? envelope.event ?? '').trim();
  if (!SUPPORTED_CALCOM_EVENTS.includes(triggerEvent)) {
    throw new WebhookVerificationError(
      'INVALID_EVENT',
      `Unsupported Cal.com triggerEvent "${triggerEvent}"; expected one of: ${SUPPORTED_CALCOM_EVENTS.join(', ')}.`
    );
  }

  if (typeof envelope.createdAt === 'string' && nowUnixSeconds !== undefined) {
    const createdRaw = envelope.createdAt.trim();
    if (!ISO_8601_OFFSET_PATTERN.test(createdRaw)) {
      throw new WebhookVerificationError('INVALID_TIMESTAMP', 'Cal.com createdAt must be a valid ISO-8601 timestamp.');
    }
    const createdSec = Math.floor(Date.parse(createdRaw) / 1000);
    if (!Number.isFinite(createdSec) || Math.abs(nowUnixSeconds - createdSec) > maxSkewSeconds) {
      throw new WebhookVerificationError(
        'TIMESTAMP_OUT_OF_RANGE',
        'Cal.com createdAt timestamp is outside the allowed replay window.'
      );
    }
  }

  return {
    event: triggerEvent,
    payload: /** @type {Record<string, unknown>} */ (envelope),
    signature: actualBuf.toString('hex'),
  };
}

/**
 * Executes the `/schedule` slash command (`upcoming`, `room`, `booking`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   defaultVoiceRoom?: string,
 *   workspaceBaseUrl?: string,
 * }} input
 */
export function handleScheduleCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_schedule';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_organizer';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/schedule ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!SCHEDULE_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_SCHEDULE_SUBCOMMAND',
      `Unsupported /schedule subcommand "${subcommand}"; expected: ${SCHEDULE_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  const voiceJump = buildKoderaVoiceRoomJump({
    roomSlug: parsed.flags.room ?? input.defaultVoiceRoom ?? DEFAULT_KODERA_VOICE_ROOM,
    workspaceBaseUrl: input.workspaceBaseUrl ?? DEFAULT_KODERA_WORKSPACE_URL,
  });

  if (subcommand === 'upcoming') {
    const horizon = sanitizeCalcomText(parsed.flags.window ?? parsed.args[0] ?? 'today', 'today', 32);
    return {
      text: `[Cal.com Schedule] Upcoming **${horizon}** bookings in <#${channelId}> routed to **${voiceJump.roomLabel}** (${voiceJump.jumpUrl}) for <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'upcoming',
      horizon,
      voiceRoom: voiceJump,
    };
  }

  if (subcommand === 'room') {
    return {
      text: `[Cal.com Voice Target] Bookings in <#${channelId}> jump to **${voiceJump.roomLabel}** → ${voiceJump.jumpUrl}`,
      ephemeral: false,
      subcommand: 'room',
      voiceRoom: voiceJump,
    };
  }

  if (subcommand === 'booking') {
    const rawUid = String(parsed.flags.uid ?? parsed.args[0] ?? 'bk_ref_001').trim();
    if (!SAFE_BOOKING_UID_PATTERN.test(rawUid)) {
      throw new ExtensionSdkError('INVALID_BOOKING_UID', `Invalid Cal.com booking uid "${rawUid}".`);
    }
    return {
      text: `[Cal.com Booking] Inspecting booking \`${rawUid}\` linked to **${voiceJump.roomLabel}** (${voiceJump.jumpUrl}).`,
      ephemeral: true,
      subcommand: 'booking',
      uid: rawUid,
      voiceRoom: voiceJump,
    };
  }

  return {
    text: `[Cal.com] Scheduling bridge ready in <#${channelId}> (default room: **${voiceJump.roomLabel}**) — subcommands: \`upcoming\`, \`room\`, \`booking\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    voiceRoom: voiceJump,
  };
}

export const scheduleCommand = defineSlashCommand({
  name: '/schedule',
  description: 'Inspect upcoming booking windows, configure a Kodera voice room jump target, or check scheduling status',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleScheduleCommand({ args, channelId, actorId }),
});

export const slashCommand = scheduleCommand;

/**
 * Formats and dispatches Cal.com scheduling events (`BOOKING_CREATED`, `BOOKING_RESCHEDULED`,
 * `BOOKING_CANCELLED`, `MEETING_STARTED`) into structured meeting cards with a Kodera voice room jump action.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} envelope
 * @param {{
 *   defaultChannelId: string,
 *   defaultVoiceRoom: string,
 *   workspaceBaseUrl: string,
 *   allowedHosts: readonly string[],
 *   bookingThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processCalcomEvent(eventName, envelope, state) {
  const { defaultChannelId, defaultVoiceRoom, workspaceBaseUrl, allowedHosts, bookingThreads, client } = state;
  const inner = /** @type {Record<string, unknown>} */ (
    typeof envelope.payload === 'object' && envelope.payload !== null && !Array.isArray(envelope.payload)
      ? envelope.payload
      : envelope
  );

  const rawUid = String(inner.uid ?? inner.bookingUid ?? envelope.uid ?? '').trim();
  if (!SAFE_BOOKING_UID_PATTERN.test(rawUid)) {
    throw new ExtensionSdkError('INVALID_BOOKING_UID', `Cal.com booking uid "${rawUid}" is missing or malformed.`);
  }

  const windowInfo = validateIsoUtcWindow(inner.startTime, inner.endTime);
  const title = sanitizeCalcomText(inner.title ?? inner.eventTitle ?? 'Scheduled Session', 'Scheduled Session', 140);
  const organizerObj = /** @type {Record<string, unknown> | undefined} */ (
    typeof inner.organizer === 'object' && inner.organizer !== null ? inner.organizer : undefined
  );
  const organizer = sanitizeCalcomText(organizerObj?.name ?? inner.organizerName ?? 'Host', 'Host', 60);
  const attendeesList = Array.isArray(inner.attendees) ? inner.attendees : [];
  const attendeeCount = attendeesList.length;

  const voiceRoom = buildKoderaVoiceRoomJump({
    roomSlug: inner.voiceRoomSlug ?? envelope.voiceRoomSlug ?? defaultVoiceRoom,
    workspaceBaseUrl,
  });

  const rawBookingUrl = inner.bookingUrl ?? inner.url;
  const bookingUrl =
    typeof rawBookingUrl === 'string' && rawBookingUrl.trim()
      ? validateCalcomUrl(rawBookingUrl, allowedHosts)
      : validateCalcomUrl(`https://app.cal.com/booking/${encodeURIComponent(rawUid)}`, allowedHosts);

  const cancellationReason =
    eventName === 'BOOKING_CANCELLED'
      ? sanitizeCalcomText(inner.cancellationReason ?? 'Cancelled by participant', 'Cancelled by participant', 140)
      : null;

  const badgeMap = {
    BOOKING_CREATED: '[BOOKING CREATED]',
    BOOKING_RESCHEDULED: '[BOOKING RESCHEDULED]',
    BOOKING_CANCELLED: '[BOOKING CANCELLED]',
    MEETING_STARTED: '[MEETING LIVE]',
  };
  const badge = badgeMap[eventName] ?? '[SCHEDULE UPDATE]';
  const channelId = String(envelope.channelId ?? inner.channelId ?? defaultChannelId);

  const actionSuffix =
    eventName === 'BOOKING_CANCELLED'
      ? `Reason: ${cancellationReason}`
      : `Jump to Kodera room **${voiceRoom.roomLabel}**: ${voiceRoom.jumpUrl}`;

  const text =
    `${badge} **${title}** (\`${rawUid}\`) · Host: **${organizer}** · Participants: \`${attendeeCount + 1}\`\n` +
    `UTC Window: \`${windowInfo.startIsoUtc}\` → \`${windowInfo.endIsoUtc}\` (${windowInfo.durationMinutes} min)\n` +
    `${actionSuffix}\n${bookingUrl}`;

  const idempotencyKey = `calcom:${eventName}:${rawUid}:${windowInfo.startIsoUtc}`;
  const cardBlock = {
    type: 'calcom_meeting_card',
    event: eventName,
    uid: rawUid,
    title,
    organizer,
    attendeeCount,
    startIsoUtc: windowInfo.startIsoUtc,
    endIsoUtc: windowInfo.endIsoUtc,
    durationMinutes: windowInfo.durationMinutes,
    cancellationReason,
    bookingUrl,
    actions: eventName === 'BOOKING_CANCELLED' ? [] : [voiceRoom],
  };
  const blocks = [cardBlock];

  const rememberThread = (uid, threadId) => {
    if (bookingThreads.size >= MAX_BOOKING_THREADS && !bookingThreads.has(uid)) {
      const oldest = bookingThreads.keys().next().value;
      if (oldest !== undefined) bookingThreads.delete(oldest);
    }
    bookingThreads.set(uid, threadId);
  };

  if (client) {
    const existingThread = bookingThreads.get(rawUid);
    if (existingThread && eventName !== 'BOOKING_CREATED') {
      const delivery = await client.postThreadReply({
        channelId,
        threadRootId: existingThread,
        text,
        blocks,
        idempotencyKey,
      });
      return {
        posted: true,
        threaded: true,
        event: eventName,
        uid: rawUid,
        startIsoUtc: windowInfo.startIsoUtc,
        endIsoUtc: windowInfo.endIsoUtc,
        durationMinutes: windowInfo.durationMinutes,
        voiceRoom,
        idempotencyKey,
        delivery,
      };
    }

    const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
    if (typeof delivery.id === 'string') {
      rememberThread(rawUid, delivery.id);
    }
    return {
      posted: true,
      threaded: false,
      event: eventName,
      uid: rawUid,
      startIsoUtc: windowInfo.startIsoUtc,
      endIsoUtc: windowInfo.endIsoUtc,
      durationMinutes: windowInfo.durationMinutes,
      voiceRoom,
      idempotencyKey,
      delivery,
    };
  }

  return {
    posted: false,
    event: eventName,
    uid: rawUid,
    startIsoUtc: windowInfo.startIsoUtc,
    endIsoUtc: windowInfo.endIsoUtc,
    durationMinutes: windowInfo.durationMinutes,
    voiceRoom,
    idempotencyKey,
    text,
    blocks,
  };
}

/**
 * Creates a webhook handler supporting both canonical Kodera `x-kodera-signature-256`
 * envelopes and native Cal.com `X-Cal-Signature-256` webhooks with replay protection.
 *
 * @param {{
 *   secret: string,
 *   calcomSecret?: string,
 *   defaultChannelId?: string,
 *   defaultVoiceRoom?: string,
 *   workspaceBaseUrl?: string,
 *   allowedHosts?: readonly string[],
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createCalcomWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const calcomSecret = config.calcomSecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_schedule';
  const defaultVoiceRoom = config.defaultVoiceRoom ?? DEFAULT_KODERA_VOICE_ROOM;
  const workspaceBaseUrl = config.workspaceBaseUrl ?? DEFAULT_KODERA_WORKSPACE_URL;
  const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_CALCOM_HOSTS;
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  // Fail fast if configured voice room or workspace origin violates SSRF rules
  buildKoderaVoiceRoomJump({ roomSlug: defaultVoiceRoom, workspaceBaseUrl });

  /** @type {Map<string, string>} */
  const bookingThreads = new Map();
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
    defaultVoiceRoom,
    workspaceBaseUrl,
    allowedHosts,
    bookingThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      BOOKING_CREATED: (payload, { client }) => processCalcomEvent('BOOKING_CREATED', payload, { ...stateBase, client }),
      BOOKING_RESCHEDULED: (payload, { client }) =>
        processCalcomEvent('BOOKING_RESCHEDULED', payload, { ...stateBase, client }),
      BOOKING_CANCELLED: (payload, { client }) =>
        processCalcomEvent('BOOKING_CANCELLED', payload, { ...stateBase, client }),
      MEETING_STARTED: (payload, { client }) => processCalcomEvent('MEETING_STARTED', payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleScheduleCommand({
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_organizer'),
          defaultVoiceRoom,
          workspaceBaseUrl,
        }),
    },
  });

  return async function handleIncomingCalcomWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const calSig = getHeaderValue(req.headers, 'x-cal-signature-256');

    if (koderaSig !== undefined || calSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId = getHeaderValue(req.headers, 'x-cal-delivery-id') ?? getHeaderValue(req.headers, 'x-request-id');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Cal.com delivery identifier must be bounded ASCII.');
    }

    const { event, payload, signature } = verifyCalcomWebhookSignature({
      secret: calcomSecret,
      rawBody: req.rawBody,
      signatureHeader: calSig,
      nowUnixSeconds: req.nowUnixSeconds ?? req.nowSeconds,
      maxSkewSeconds,
    });

    pruneNativeReplay(nowSec);
    if (nativeSeenSignatures.has(signature) || (deliveryId !== undefined && nativeSeenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate Cal.com webhook delivery rejected.');
    }
    if (nativeSeenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Cal.com replay cache is full.');
    }
    nativeSeenSignatures.set(signature, nowSec);
    if (deliveryId !== undefined) {
      nativeSeenDeliveries.set(deliveryId, nowSec);
    }

    const activeClient = req.client ?? config.client;
    const result = await processCalcomEvent(event, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: 200,
      event,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createCalcomWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  scheduleCommand,
  handleScheduleCommand,
  validateIsoUtcWindow,
  buildKoderaVoiceRoomJump,
  signCalcomWebhookPayload,
  verifyCalcomWebhookSignature,
  createCalcomWebhookHandler,
  createExtensionWebhookHandler,
};

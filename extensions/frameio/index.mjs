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
const FRAMEIO_SIG_PATTERN = /^v0=([0-9a-fA-F]{64})$/;
const TIMESTAMP_DIGITS_PATTERN = /^(0|[1-9]\d{0,15})$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ASSET_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ASSET_THREADS = 1024;
const MAX_OTIO_MARKERS = 64;
const MAX_OTIO_DEPTH = 12;
const MAX_SMPTE_FRAME_NUMBER = 86_400 * 60 * 24;

export const SUPPORTED_FRAMEIO_EVENTS = Object.freeze([
  'comment.created',
  'comment.completed',
  'asset.ready',
  'review_link.created',
]);

export const DAILIES_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'timecode',
  'otio',
  'reviews',
  'status',
]);

export const SUPPORTED_SMPTE_FPS = Object.freeze([
  23.976,
  24,
  25,
  29.97,
  30,
  60,
]);

export const DEFAULT_ALLOWED_FRAMEIO_HOSTS = Object.freeze([
  'app.frame.io',
  'next.frame.io',
  'reviews.example.org',
  'dailies.example.com',
]);

/**
 * Validates and normalizes the `frameio` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateFrameioManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateFrameioManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeStudioText(rawValue, fallback = '', maxLength = 240) {
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
    if (ch === '*' || ch === '`' || ch === '~' || ch === '[' || ch === ']') {
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
 * Normalizes supported studio frame rates (`23.976`, `24`, `25`, `29.97`, `30`, `60`).
 *
 * @param {unknown} rawFps
 * @returns {{ fps: number, nominalBase: 24 | 25 | 30 | 60, supportsDropFrame: boolean }}
 */
export function resolveStudioFrameRate(rawFps) {
  const num = Number(rawFps);
  if (!Number.isFinite(num) || num <= 0) {
    throw new ExtensionSdkError('INVALID_FPS', `Frame rate must be a positive number (received "${String(rawFps)}").`);
  }
  if (Math.abs(num - 23.976) < 0.01) {
    return { fps: 23.976, nominalBase: 24, supportsDropFrame: false };
  }
  if (num === 24) {
    return { fps: 24, nominalBase: 24, supportsDropFrame: false };
  }
  if (num === 25) {
    return { fps: 25, nominalBase: 25, supportsDropFrame: false };
  }
  if (Math.abs(num - 29.97) < 0.01) {
    return { fps: 29.97, nominalBase: 30, supportsDropFrame: true };
  }
  if (num === 30) {
    return { fps: 30, nominalBase: 30, supportsDropFrame: false };
  }
  if (num === 60) {
    return { fps: 60, nominalBase: 60, supportsDropFrame: false };
  }
  throw new ExtensionSdkError(
    'UNSUPPORTED_FPS',
    `Unsupported SMPTE frame rate "${num}"; supported rates: ${SUPPORTED_SMPTE_FPS.join(', ')}.`
  );
}

/**
 * Formats an integer frame number into canonical SMPTE 12M timecode:
 * - Non-drop-frame (`HH:MM:SS:FF`) for `23.976`, `24`, `25`, `29.97` (when `dropFrame: false`), `30`, `60`.
 * - Drop-frame (`HH:MM:SS;FF`) for `29.97` (default `dropFrame: true`, dropping `;00` and `;01`
 *   on every minute boundary except every 10th minute: `17982` frames per 10-minute block).
 *
 * @param {unknown} rawFrame
 * @param {unknown} rawFps
 * @param {{ dropFrame?: boolean, startHourOffset?: number }} [options]
 * @returns {{
 *   timecode: string,
 *   frame: number,
 *   fps: number,
 *   dropFrame: boolean,
 *   separator: ':' | ';',
 * }}
 */
export function formatSmpteTimecode(rawFrame, rawFps = 24, options = {}) {
  const frame = Number(rawFrame);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame > MAX_SMPTE_FRAME_NUMBER) {
    throw new ExtensionSdkError(
      'INVALID_FRAME_NUMBER',
      `Frame number must be an integer between 0 and ${MAX_SMPTE_FRAME_NUMBER}.`
    );
  }

  const startHourOffset = options.startHourOffset ?? 0;
  if (!Number.isSafeInteger(startHourOffset) || startHourOffset < 0 || startHourOffset > 23) {
    throw new ExtensionSdkError('INVALID_TIMECODE_OFFSET', 'startHourOffset must be an integer between 0 and 23.');
  }

  const rateInfo = resolveStudioFrameRate(rawFps);
  const useDropFrame =
    options.dropFrame !== undefined
      ? Boolean(options.dropFrame)
      : rateInfo.fps === 29.97;

  if (useDropFrame && !rateInfo.supportsDropFrame) {
    throw new ExtensionSdkError(
      'INVALID_DROP_FRAME',
      `Drop-frame SMPTE timecode is only valid for 29.97 fps (received ${rateInfo.fps} fps).`
    );
  }

  let displayFrameCount = frame;
  if (useDropFrame) {
    // SMPTE 12M 29.97 drop-frame: 17,982 frames per 10 minutes, 1,798 frames per non-tenth minute.
    const framesPerTenMin = 17_982;
    const framesPerMin = 1_798;
    const tenMinBlocks = Math.floor(frame / framesPerTenMin);
    const rem = frame % framesPerTenMin;
    const extraMinutes = rem >= 2 ? Math.floor((rem - 2) / framesPerMin) : 0;
    displayFrameCount = frame + 18 * tenMinBlocks + 2 * extraMinutes;
  }

  const base = rateInfo.nominalBase;
  const ff = displayFrameCount % base;
  const totalSeconds = Math.floor(displayFrameCount / base);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60) + startHourOffset;

  const pad2 = (n) => String(n).padStart(2, '0');
  const separator = useDropFrame ? ';' : ':';
  const timecode = `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${separator}${pad2(ff)}`;

  return {
    timecode,
    frame,
    fps: rateInfo.fps,
    dropFrame: useDropFrame,
    separator,
  };
}

/**
 * Extracts and summarizes OpenTimelineIO (`OTIO`) markers from a `Timeline.1`, `Track.1`, `Clip.1`,
 * or `Marker.2` JSON object with bounded recursion depth and marker count.
 *
 * @param {unknown} rawOtio
 * @param {{ defaultFps?: number, dropFrame?: boolean }} [options]
 */
export function summarizeOtioMarkers(rawOtio, options = {}) {
  if (!rawOtio || typeof rawOtio !== 'object' || Array.isArray(rawOtio)) {
    throw new ExtensionSdkError('INVALID_OTIO_DOCUMENT', 'OpenTimelineIO payload must be a JSON object.');
  }

  /** @type {Array<{ name: string, color: string, comment: string, frame: number, fps: number, timecode: string }>} */
  const markers = [];
  const defaultFps = options.defaultFps ?? 24;

  /**
   * @param {unknown} node
   * @param {number} depth
   */
  function visit(node, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_OTIO_DEPTH || markers.length >= MAX_OTIO_MARKERS) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (markers.length >= MAX_OTIO_MARKERS) break;
        visit(item, depth + 1);
      }
      return;
    }

    const rec = /** @type {Record<string, unknown>} */ (node);
    const schema = typeof rec.OTIO_SCHEMA === 'string' ? rec.OTIO_SCHEMA : '';

    if (schema.startsWith('Marker.')) {
      const range = /** @type {Record<string, unknown> | undefined} */ (
        typeof rec.marked_range === 'object' && rec.marked_range !== null ? rec.marked_range : undefined
      );
      const startTime = /** @type {Record<string, unknown> | undefined} */ (
        typeof range?.start_time === 'object' && range.start_time !== null ? range.start_time : undefined
      );
      const rawRate = startTime?.rate ?? defaultFps;
      const rateInfo = resolveStudioFrameRate(rawRate);
      const rawVal = Number(startTime?.value ?? 0);
      const frame = Number.isFinite(rawVal) && rawVal >= 0 ? Math.round(rawVal) : 0;
      const formatted = formatSmpteTimecode(frame, rateInfo.fps, {
        ...(options.dropFrame !== undefined ? { dropFrame: options.dropFrame } : {}),
      });
      markers.push({
        name: sanitizeStudioText(rec.name, 'Marker', 80),
        color: sanitizeStudioText(rec.color, 'GREEN', 24).toUpperCase(),
        comment: sanitizeStudioText(rec.comment, '', 160),
        frame: formatted.frame,
        fps: formatted.fps,
        timecode: formatted.timecode,
      });
      return;
    }

    if (Array.isArray(rec.markers)) {
      visit(rec.markers, depth + 1);
    }
    if (rec.tracks && typeof rec.tracks === 'object') {
      visit(rec.tracks, depth + 1);
    }
    if (Array.isArray(rec.children)) {
      visit(rec.children, depth + 1);
    }
  }

  const root = /** @type {Record<string, unknown>} */ (rawOtio);
  const timelineName = sanitizeStudioText(root.name, 'Timeline', 100);
  visit(root, 0);

  const byColor = /** @type {Record<string, number>} */ ({});
  for (const m of markers) {
    byColor[m.color] = (byColor[m.color] ?? 0) + 1;
  }

  const previewLines = markers.slice(0, 5).map((m) => {
    const suffix = m.comment ? ` — ${m.comment}` : '';
    return `[${m.timecode}] (${m.color}) ${m.name}${suffix}`;
  });

  return {
    timelineName,
    markerCount: markers.length,
    byColor,
    markers,
    summaryText:
      markers.length === 0
        ? `OTIO timeline "${timelineName}": 0 markers`
        : `OTIO timeline "${timelineName}": ${markers.length} marker${markers.length === 1 ? '' : 's'} · ${previewLines.join(' | ')}`,
  };
}

/**
 * Validates a Frame.io review or studio HTTPS URL against SSRF vectors and an explicit host allowlist.
 *
 * @param {unknown} rawUrl
 * @param {readonly string[]} [allowedHosts]
 * @returns {string}
 */
export function validateFrameioUrl(rawUrl, allowedHosts = DEFAULT_ALLOWED_FRAMEIO_HOSTS) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), { allowLocalhostHttp: false });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const normalizedAllowlist = allowedHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  if (!normalizedAllowlist.includes(host)) {
    throw new ExtensionSdkError(
      'UNTRUSTED_FRAMEIO_HOST',
      `Frame.io URL host "${host}" is outside the configured allowlist.`
    );
  }
  return validated;
}

/**
 * Computes a Frame.io `X-Frameio-Signature` (`v0=<hex>`) over `v0:${timestamp}:${rawBody}`.
 *
 * @param {string} secret
 * @param {number | string} timestampSeconds
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signFrameioWebhookPayload(secret, timestampSeconds, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Frame.io webhook secret must be at least 16 characters.');
  }
  const ts = String(timestampSeconds);
  if (!TIMESTAMP_DIGITS_PATTERN.test(ts) || !Number.isSafeInteger(Number(ts))) {
    throw new WebhookVerificationError('INVALID_TIMESTAMP', 'Frame.io timestamp must be a non-negative safe integer.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const digest = createHmac('sha256', secret)
    .update(`v0:${ts}:`, 'utf8')
    .update(bodyBuf)
    .digest('hex');
  return `v0=${digest}`;
}

/**
 * Verifies a native Frame.io timestamped webhook (`X-Frameio-Request-Timestamp` + `X-Frameio-Signature`)
 * in constant time using `timingSafeEqual`.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   timestampHeader: string | undefined,
 *   nowUnixSeconds?: number,
 *   maxSkewSeconds?: number,
 * }} params
 */
export function verifyFrameioWebhookSignature({
  secret,
  rawBody,
  signatureHeader,
  timestampHeader,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Frame.io webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Frame.io webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? FRAMEIO_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed X-Frameio-Signature header.');
  }
  const tsRaw = typeof timestampHeader === 'string' ? timestampHeader.trim() : '';
  if (!TIMESTAMP_DIGITS_PATTERN.test(tsRaw)) {
    throw new WebhookVerificationError('MISSING_TIMESTAMP', 'Missing or non-numeric X-Frameio-Request-Timestamp header.');
  }
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(nowUnixSeconds - ts) > maxSkewSeconds) {
    throw new WebhookVerificationError('TIMESTAMP_OUT_OF_RANGE', 'Frame.io webhook timestamp outside allowed replay window.');
  }

  const expectedBuf = createHmac('sha256', secret)
    .update(`v0:${tsRaw}:`, 'utf8')
    .update(bodyBuf)
    .digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Frame.io HMAC-SHA256 signature verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Frame.io webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Frame.io webhook payload must be a JSON object.');
  }

  const eventName = String(payload.type ?? payload.event ?? '').trim();
  if (!SUPPORTED_FRAMEIO_EVENTS.includes(eventName)) {
    throw new WebhookVerificationError(
      'INVALID_EVENT',
      `Unsupported Frame.io event "${eventName}"; expected one of: ${SUPPORTED_FRAMEIO_EVENTS.join(', ')}.`
    );
  }

  return {
    event: eventName,
    timestamp: ts,
    payload: /** @type {Record<string, unknown>} */ (payload),
    signature: `v0=${actualBuf.toString('hex')}`,
  };
}

/**
 * Executes the `/dailies` slash command (`timecode`, `otio`, `reviews`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleDailiesCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_dailies';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_editor';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/dailies ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!DAILIES_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_DAILIES_SUBCOMMAND',
      `Unsupported /dailies subcommand "${subcommand}"; expected: ${DAILIES_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  if (subcommand === 'timecode') {
    const rawFrame = parsed.flags.frame ?? parsed.args[0] ?? '0';
    const rawFps = parsed.flags.fps ?? '24';
    const dropFlag =
      parsed.flags['drop-frame'] !== undefined
        ? String(parsed.flags['drop-frame']).toLowerCase() === 'true'
        : undefined;
    const formatted = formatSmpteTimecode(Number(rawFrame), Number(rawFps), {
      ...(dropFlag !== undefined ? { dropFrame: dropFlag } : {}),
    });
    return {
      text: `[SMPTE Timecode] Frame \`${formatted.frame}\` @ \`${formatted.fps}fps\`${formatted.dropFrame ? ' (DF)' : ' (NDF)'} → **\`${formatted.timecode}\`**`,
      ephemeral: true,
      subcommand: 'timecode',
      ...formatted,
    };
  }

  if (subcommand === 'otio') {
    const timeline = sanitizeStudioText(parsed.flags.timeline ?? parsed.args[0] ?? 'Edit_v04', 'Edit_v04', 80);
    const fpsInfo = resolveStudioFrameRate(parsed.flags.fps ?? 24);
    return {
      text: `[OTIO Markers] Timeline **${timeline}** (\`${fpsInfo.fps}fps\`) marker inspector ready in <#${channelId}> for <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'otio',
      timeline,
      fps: fpsInfo.fps,
    };
  }

  if (subcommand === 'reviews') {
    const project = sanitizeStudioText(parsed.flags.project ?? parsed.args[0] ?? 'Feature_Cut', 'Feature_Cut', 80);
    return {
      text: `[Dailies Reviews] Active review queue for **${project}** in <#${channelId}> requested by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'reviews',
      project,
    };
  }

  return {
    text: `[Frame.io & OTIO] Dailies bridge ready in <#${channelId}> — subcommands: \`timecode\`, \`otio\`, \`reviews\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
  };
}

export const dailiesCommand = defineSlashCommand({
  name: '/dailies',
  description: 'Format SMPTE timecodes, summarize OTIO markers, or inspect dailies reviews',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleDailiesCommand({ args, channelId, actorId }),
});

export const slashCommand = dailiesCommand;

/**
 * Formats and dispatches Frame.io studio events (`comment.created`, `comment.completed`,
 * `asset.ready`, `review_link.created`) to `#dailies` or `#review` channels.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   allowedHosts: readonly string[],
 *   assetThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processFrameioEvent(eventName, payload, state) {
  const { defaultChannelId, allowedHosts, assetThreads, client } = state;
  const resource = /** @type {Record<string, unknown>} */ (
    typeof payload.resource === 'object' && payload.resource !== null ? payload.resource : payload
  );
  const assetObj = /** @type {Record<string, unknown>} */ (
    typeof payload.asset === 'object' && payload.asset !== null ? payload.asset : resource
  );
  const commentObj = /** @type {Record<string, unknown>} */ (
    typeof payload.comment === 'object' && payload.comment !== null ? payload.comment : resource
  );

  const rawAssetId = String(
    assetObj.id ?? commentObj.asset_id ?? payload.assetId ?? resource.id ?? 'asset_1'
  ).trim();
  if (!SAFE_ASSET_ID_PATTERN.test(rawAssetId)) {
    throw new ExtensionSdkError('INVALID_ASSET_ID', `Invalid Frame.io asset identifier "${rawAssetId}".`);
  }

  const assetName = sanitizeStudioText(
    assetObj.name ?? payload.assetName ?? 'Untitled_Shot.mov',
    'Untitled_Shot.mov',
    120
  );
  const projectName = sanitizeStudioText(
    payload.project?.name ?? payload.projectName ?? 'Studio_Dailies',
    'Studio_Dailies',
    80
  );
  const author = sanitizeStudioText(
    payload.user?.name ?? commentObj.owner?.name ?? payload.author ?? 'Supervisor',
    'Supervisor',
    60
  );
  const channelId = String(payload.channelId ?? defaultChannelId);
  const otioSummary =
    payload.otio && typeof payload.otio === 'object' && !Array.isArray(payload.otio)
      ? summarizeOtioMarkers(payload.otio)
      : null;

  const rememberAssetThread = (assetKey, threadId) => {
    if (assetThreads.size >= MAX_ASSET_THREADS && !assetThreads.has(assetKey)) {
      const oldest = assetThreads.keys().next().value;
      if (oldest !== undefined) assetThreads.delete(oldest);
    }
    assetThreads.set(assetKey, threadId);
  };

  if (eventName === 'comment.created' || eventName === 'comment.completed') {
    const rawFrame = Number(commentObj.frame ?? payload.frame ?? 0);
    const rawFps = commentObj.fps ?? assetObj.fps ?? payload.fps ?? 24;
    const dropOption =
      typeof (commentObj.drop_frame ?? payload.dropFrame) === 'boolean'
        ? { dropFrame: Boolean(commentObj.drop_frame ?? payload.dropFrame) }
        : {};
    const tc = formatSmpteTimecode(rawFrame, rawFps, dropOption);
    const commentId = sanitizeStudioText(String(commentObj.id ?? `${rawAssetId}-f${tc.frame}`), 'c1', 80);
    const annotation = sanitizeStudioText(
      commentObj.annotation_summary ?? payload.annotationSummary ?? '',
      '',
      120
    );
    const bodyText = sanitizeStudioText(
      commentObj.text ?? payload.text ?? 'Timecode review note',
      'Timecode review note',
      280
    );
    const reviewUrl = validateFrameioUrl(
      commentObj.review_url ?? payload.reviewUrl ?? `https://app.frame.io/player/${encodeURIComponent(rawAssetId)}?frame=${tc.frame}`,
      allowedHosts
    );

    const badge = eventName === 'comment.completed' ? '[NOTE COMPLETED]' : '[DAILIES NOTE]';
    const annotationSuffix = annotation ? ` · Annotation: ${annotation}` : '';
    const otioLine = otioSummary ? `\n${otioSummary.summaryText}` : '';
    const text =
      `${badge} \`${tc.timecode}\` (frame ${tc.frame} @ ${tc.fps}fps) on **${assetName}** by **${author}**\n` +
      `${bodyText}${annotationSuffix}${otioLine}\n${reviewUrl}`;
    const idempotencyKey = `frameio:${eventName}:${rawAssetId}:${commentId}`;
    const blocks = [
      {
        type: 'frameio_timecode_comment_card',
        event: eventName,
        assetId: rawAssetId,
        assetName,
        projectName,
        commentId,
        author,
        timecode: tc.timecode,
        frame: tc.frame,
        fps: tc.fps,
        dropFrame: tc.dropFrame,
        annotationSummary: annotation || null,
        body: bodyText,
        otioMarkerCount: otioSummary?.markerCount ?? 0,
        url: reviewUrl,
      },
    ];

    if (client) {
      const existingThread = assetThreads.get(rawAssetId);
      if (existingThread && eventName === 'comment.completed') {
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
          assetId: rawAssetId,
          timecode: tc.timecode,
          frame: tc.frame,
          fps: tc.fps,
          idempotencyKey,
          delivery,
        };
      }
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      if (typeof delivery.id === 'string') {
        rememberAssetThread(rawAssetId, delivery.id);
      }
      return {
        posted: true,
        threaded: false,
        event: eventName,
        assetId: rawAssetId,
        timecode: tc.timecode,
        frame: tc.frame,
        fps: tc.fps,
        idempotencyKey,
        delivery,
      };
    }

    return {
      posted: false,
      event: eventName,
      assetId: rawAssetId,
      timecode: tc.timecode,
      frame: tc.frame,
      fps: tc.fps,
      otioSummary,
      idempotencyKey,
      text,
      blocks,
    };
  }

  if (eventName === 'asset.ready') {
    const rawFps = assetObj.fps ?? payload.fps ?? 24;
    const durationFrames = Number(assetObj.frames ?? payload.durationFrames ?? 0);
    const tc = formatSmpteTimecode(Math.max(0, durationFrames), rawFps);
    const codec = sanitizeStudioText(assetObj.codec ?? payload.codec ?? 'ProRes 422 HQ', 'ProRes 422 HQ', 48);
    const resolution = sanitizeStudioText(assetObj.resolution ?? payload.resolution ?? '3840x2160', '3840x2160', 32);
    const assetUrl = validateFrameioUrl(
      assetObj.view_url ?? payload.reviewUrl ?? `https://app.frame.io/player/${encodeURIComponent(rawAssetId)}`,
      allowedHosts
    );
    const otioLine = otioSummary ? `\n${otioSummary.summaryText}` : '';
    const text =
      `[ASSET READY] **${assetName}** (${projectName}) · Duration \`${tc.timecode}\` @ ${tc.fps}fps · ${resolution} ${codec}${otioLine}\n${assetUrl}`;
    const idempotencyKey = `frameio:asset.ready:${rawAssetId}`;
    const blocks = [
      {
        type: 'frameio_asset_card',
        assetId: rawAssetId,
        assetName,
        projectName,
        durationTimecode: tc.timecode,
        fps: tc.fps,
        resolution,
        codec,
        otioMarkerCount: otioSummary?.markerCount ?? 0,
        url: assetUrl,
      },
    ];

    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      if (typeof delivery.id === 'string') {
        rememberAssetThread(rawAssetId, delivery.id);
      }
      return { posted: true, event: eventName, assetId: rawAssetId, durationTimecode: tc.timecode, idempotencyKey, delivery };
    }
    return { posted: false, event: eventName, assetId: rawAssetId, durationTimecode: tc.timecode, otioSummary, idempotencyKey, text, blocks };
  }

  if (eventName === 'review_link.created') {
    const linkObj = /** @type {Record<string, unknown>} */ (
      typeof payload.review_link === 'object' && payload.review_link !== null ? payload.review_link : resource
    );
    const linkId = sanitizeStudioText(String(linkObj.id ?? rawAssetId), rawAssetId, 80);
    const linkTitle = sanitizeStudioText(linkObj.name ?? payload.title ?? `${projectName} Review`, `${projectName} Review`, 120);
    const expiresAt = sanitizeStudioText(linkObj.expires_at ?? payload.expiresAt ?? 'no-expiry', 'no-expiry', 40);
    const reviewUrl = validateFrameioUrl(
      linkObj.short_url ?? linkObj.url ?? payload.reviewUrl ?? `https://app.frame.io/reviews/${encodeURIComponent(linkId)}`,
      allowedHosts
    );
    const text = `[REVIEW LINK] **${linkTitle}** shared by **${author}** (expires: \`${expiresAt}\`)\n${reviewUrl}`;
    const idempotencyKey = `frameio:review_link.created:${linkId}`;
    const blocks = [
      {
        type: 'frameio_review_link_card',
        linkId,
        title: linkTitle,
        projectName,
        author,
        expiresAt,
        url: reviewUrl,
      },
    ];

    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, event: eventName, linkId, idempotencyKey, delivery };
    }
    return { posted: false, event: eventName, linkId, idempotencyKey, text, blocks };
  }

  return { posted: false, ignored: true, reason: 'unhandled_frameio_event', event: eventName };
}

/**
 * Creates a webhook handler supporting both canonical Kodera `x-kodera-signature-256`
 * deliveries and native Frame.io `X-Frameio-Signature` (`v0=<hex>`) timestamped webhooks.
 *
 * @param {{
 *   secret: string,
 *   frameioSecret?: string,
 *   defaultChannelId?: string,
 *   allowedHosts?: readonly string[],
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createFrameioDailiesWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const frameioSecret = config.frameioSecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_dailies';
  const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_FRAMEIO_HOSTS;
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, string>} */
  const assetThreads = new Map();
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
    assetThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'comment.created': (payload, { client }) => processFrameioEvent('comment.created', payload, { ...stateBase, client }),
      'comment.completed': (payload, { client }) => processFrameioEvent('comment.completed', payload, { ...stateBase, client }),
      'asset.ready': (payload, { client }) => processFrameioEvent('asset.ready', payload, { ...stateBase, client }),
      'review_link.created': (payload, { client }) => processFrameioEvent('review_link.created', payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        dailiesCommand.handler({
          command: 'dailies',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_editor'),
        }),
    },
  });

  return async function handleIncomingFrameioWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const frameioSig = getHeaderValue(req.headers, 'x-frameio-signature');

    if (koderaSig !== undefined || frameioSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId = getHeaderValue(req.headers, 'x-frameio-delivery') ?? getHeaderValue(req.headers, 'x-request-id');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Frame.io delivery identifier must be bounded ASCII.');
    }

    const { event, timestamp, payload, signature } = verifyFrameioWebhookSignature({
      secret: frameioSecret,
      rawBody: req.rawBody,
      signatureHeader: frameioSig,
      timestampHeader: getHeaderValue(req.headers, 'x-frameio-request-timestamp'),
      nowUnixSeconds: nowSec,
      maxSkewSeconds,
    });

    pruneNativeReplay(nowSec);
    if (nativeSeenSignatures.has(signature) || (deliveryId !== undefined && nativeSeenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate Frame.io webhook delivery rejected.');
    }
    if (nativeSeenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Frame.io replay cache is full.');
    }
    nativeSeenSignatures.set(signature, timestamp);
    if (deliveryId !== undefined) {
      nativeSeenDeliveries.set(deliveryId, timestamp);
    }

    const activeClient = req.client ?? config.client;
    const result = await processFrameioEvent(event, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: result.ignored ? 202 : 200,
      event,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createFrameioDailiesWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  dailiesCommand,
  handleDailiesCommand,
  formatSmpteTimecode,
  summarizeOtioMarkers,
  signFrameioWebhookPayload,
  verifyFrameioWebhookSignature,
  createFrameioDailiesWebhookHandler,
  createExtensionWebhookHandler,
};

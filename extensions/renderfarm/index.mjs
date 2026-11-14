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
const RENDER_SIG_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;
const TIMESTAMP_DIGITS_PATTERN = /^(0|[1-9]\d{0,15})$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHOT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const WORKER_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_JOB_THREADS = 1024;
const MAX_FRAME_COUNT = 1_000_000;

export const SUPPORTED_RENDERFARM_EVENTS = Object.freeze([
  'job.started',
  'job.completed',
  'job.failed',
  'task.oom_killed',
]);

export const RENDER_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'queue',
  'shot',
  'workers',
  'status',
]);

const DEADLINE_EVENT_MAP = Object.freeze({
  OnJobStarted: 'job.started',
  OnJobFinished: 'job.completed',
  OnJobFailed: 'job.failed',
  OnTaskOomKilled: 'task.oom_killed',
});

/**
 * Validates and normalizes the `renderfarm` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateRenderfarmManifest(input = rawManifest, options = {}) {
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
    throw new ExtensionSdkError('INVALID_MANIFEST_ID', `Invalid renderfarm manifest id "${rawId}".`);
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

export const extensionManifest = validateRenderfarmManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeRenderText(rawValue, fallback = '', maxLength = 240) {
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
 * Parses a studio frame range expression such as `"1001-1120"`, `"1001-1120x2"`, or `"1001,1005,1010-1020"`.
 *
 * @param {unknown} rawRange
 * @returns {{
 *   normalized: string,
 *   startFrame: number,
 *   endFrame: number,
 *   totalFrames: number,
 * }}
 */
export function parseFrameRange(rawRange) {
  const input = String(rawRange ?? '').trim();
  if (!input || input.length > 128) {
    throw new ExtensionSdkError('INVALID_FRAME_RANGE', 'Frame range must be a bounded non-empty string (e.g. "1001-1120").');
  }

  const segments = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0 || segments.length > 16) {
    throw new ExtensionSdkError('INVALID_FRAME_RANGE', `Invalid frame range "${input}".`);
  }

  let minFrame = Number.POSITIVE_INFINITY;
  let maxFrame = Number.NEGATIVE_INFINITY;
  let totalFrames = 0;
  const normalizedSegments = [];

  for (const seg of segments) {
    const singleMatch = /^(\d{1,7})$/.exec(seg);
    if (singleMatch) {
      const f = Number(singleMatch[1]);
      minFrame = Math.min(minFrame, f);
      maxFrame = Math.max(maxFrame, f);
      totalFrames += 1;
      normalizedSegments.push(String(f));
      continue;
    }

    const spanMatch = /^(\d{1,7})-(\d{1,7})(?:x([1-9]\d{0,3}))?$/i.exec(seg);
    if (!spanMatch) {
      throw new ExtensionSdkError('INVALID_FRAME_RANGE', `Malformed frame range segment "${seg}".`);
    }
    const start = Number(spanMatch[1]);
    const end = Number(spanMatch[2]);
    const step = spanMatch[3] ? Number(spanMatch[3]) : 1;
    if (end < start || end - start > MAX_FRAME_COUNT) {
      throw new ExtensionSdkError('INVALID_FRAME_RANGE', `Frame range "${seg}" has invalid bounds.`);
    }
    minFrame = Math.min(minFrame, start);
    maxFrame = Math.max(maxFrame, end);
    totalFrames += Math.floor((end - start) / step) + 1;
    normalizedSegments.push(step > 1 ? `${start}-${end}x${step}` : `${start}-${end}`);
  }

  if (totalFrames < 1 || totalFrames > MAX_FRAME_COUNT) {
    throw new ExtensionSdkError('INVALID_FRAME_RANGE', 'Total frame count exceeds studio bounds.');
  }

  return {
    normalized: normalizedSegments.join(','),
    startFrame: minFrame,
    endFrame: maxFrame,
    totalFrames,
  };
}

/**
 * Formats per-frame render time in seconds (`42.3s/frame`, `2m 14.5s/frame`, `1h 04m 12s/frame`).
 *
 * @param {unknown} rawSeconds
 * @returns {{ seconds: number, formatted: string }}
 */
export function formatAverageFrameTime(rawSeconds) {
  const sec = Number(rawSeconds);
  if (!Number.isFinite(sec) || sec < 0 || sec > 86_400 * 7) {
    throw new ExtensionSdkError('INVALID_RENDER_DURATION', 'Average frame time must be a non-negative number of seconds.');
  }
  if (sec < 60) {
    return { seconds: Number(sec.toFixed(1)), formatted: `${sec.toFixed(1)}s/frame` };
  }
  if (sec < 3600) {
    const mins = Math.floor(sec / 60);
    const rem = (sec - mins * 60).toFixed(1);
    return { seconds: Number(sec.toFixed(1)), formatted: `${mins}m ${rem}s/frame` };
  }
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = Math.round(sec % 60);
  return {
    seconds: Number(sec.toFixed(1)),
    formatted: `${hrs}h ${String(mins).padStart(2, '0')}m ${String(rem).padStart(2, '0')}s/frame`,
  };
}

/**
 * Validates a render-worker hostname according to RFC 1123 labels (`blade-gpu-04` or `node07.farm.studio.example`).
 *
 * @param {unknown} rawHostname
 * @returns {string}
 */
export function validateWorkerHostname(rawHostname) {
  if (typeof rawHostname !== 'string') {
    throw new ExtensionSdkError('INVALID_WORKER_HOSTNAME', 'Worker hostname must be a string.');
  }
  const trimmed = rawHostname.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253) {
    throw new ExtensionSdkError('INVALID_WORKER_HOSTNAME', 'Worker hostname must be 1..253 ASCII characters.');
  }
  const labels = trimmed.split('.');
  for (const label of labels) {
    if (!WORKER_LABEL_PATTERN.test(label)) {
      throw new ExtensionSdkError('INVALID_WORKER_HOSTNAME', `Invalid worker hostname "${trimmed}".`);
    }
  }
  return trimmed;
}

/**
 * Sanitizes a render output directory URI or studio vault path:
 * - Validates `https://` links through `validateEndpointUrl` (stripping query tokens and embedded credentials).
 * - Accepts clean `s3://bucket/path` or POSIX studio mount paths (`/mnt/renders/...`, `/renders/...`) while
 *   forbidding `..` path traversal, home-directory leakage (`/Users/<name>` or `/home/<name>`), `http://`,
 *   `file://`, `javascript:`, or Windows UNC/credential paths.
 *
 * @param {unknown} rawUri
 * @returns {string}
 */
export function sanitizeRenderOutputUri(rawUri) {
  if (typeof rawUri !== 'string' || !rawUri.trim()) {
    throw new ExtensionSdkError('INVALID_OUTPUT_URI', 'Render output URI must be a non-empty string.');
  }
  const trimmed = rawUri.trim();
  if (trimmed.length > 512 || /[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new ExtensionSdkError('INVALID_OUTPUT_URI', 'Render output URI contains control characters or whitespace.');
  }
  if (trimmed.includes('..') || trimmed.includes('\\')) {
    throw new ExtensionSdkError('INVALID_OUTPUT_URI', 'Path traversal or backslash segments are forbidden in output URIs.');
  }

  if (trimmed.startsWith('https://')) {
    const validated = validateEndpointUrl(trimmed, { allowLocalhostHttp: false });
    const parsed = new URL(validated);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  }

  if (trimmed.startsWith('s3://')) {
    const withoutScheme = trimmed.slice('s3://'.length);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9_./-]+$/.test(withoutScheme)) {
      throw new ExtensionSdkError('INVALID_OUTPUT_URI', 'Malformed s3:// render vault URI.');
    }
    return `s3://${withoutScheme}`;
  }

  if (trimmed.startsWith('/')) {
    if (/^\/(?:Users|home|etc|proc|sys|root|var\/run)(?:\/|$)/i.test(trimmed)) {
      throw new ExtensionSdkError('INVALID_OUTPUT_URI', 'Local user home or system paths are forbidden in render output URIs.');
    }
    if (!/^\/(?:mnt|renders|studio|volumes|projects)\/[A-Za-z0-9_./-]+$/.test(trimmed)) {
      throw new ExtensionSdkError(
        'INVALID_OUTPUT_URI',
        'POSIX render output path must reside under /mnt, /renders, /studio, /volumes, or /projects.'
      );
    }
    return trimmed;
  }

  throw new ExtensionSdkError(
    'INVALID_OUTPUT_URI',
    `Unsupported render output URI scheme in "${trimmed.slice(0, 32)}".`
  );
}

/**
 * Validates a studio shot code (`SEQ010_SH040`, `EP02-SH110`).
 *
 * @param {unknown} rawShot
 * @returns {string}
 */
export function validateShotCode(rawShot) {
  const shot = String(rawShot ?? '').trim();
  if (!SHOT_CODE_PATTERN.test(shot) || shot.includes('..')) {
    throw new ExtensionSdkError('INVALID_SHOT_CODE', `Invalid studio shot code "${shot}".`);
  }
  return shot;
}

/**
 * Normalizes either a Blender Flamenco or Thinkbox Deadline webhook payload into a single typed structure.
 *
 * @param {Record<string, unknown>} payload
 */
export function normalizeRenderJobPayload(payload) {
  const isDeadline =
    typeof payload.EventType === 'string' ||
    typeof payload.JobId === 'string' ||
    typeof payload.SlaveName === 'string';

  const rawEvent = isDeadline
    ? DEADLINE_EVENT_MAP[String(payload.EventType ?? '')] ?? String(payload.event ?? payload.type ?? '')
    : String(payload.event ?? payload.type ?? '');

  if (!SUPPORTED_RENDERFARM_EVENTS.includes(rawEvent)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_RENDER_EVENT',
      `Unsupported render farm event "${rawEvent}"; expected: ${SUPPORTED_RENDERFARM_EVENTS.join(', ')}.`
    );
  }

  const jobObj = /** @type {Record<string, unknown>} */ (
    typeof payload.job === 'object' && payload.job !== null ? payload.job : payload
  );
  const settingsObj = /** @type {Record<string, unknown>} */ (
    typeof jobObj.settings === 'object' && jobObj.settings !== null ? jobObj.settings : {}
  );
  const taskObj = /** @type {Record<string, unknown>} */ (
    typeof payload.task === 'object' && payload.task !== null ? payload.task : {}
  );
  const workerObj = /** @type {Record<string, unknown>} */ (
    typeof payload.worker === 'object' && payload.worker !== null ? payload.worker : {}
  );

  const scheduler = isDeadline ? 'deadline' : String(payload.scheduler ?? 'flamenco').toLowerCase() === 'deadline' ? 'deadline' : 'flamenco';
  const jobId = String(jobObj.id ?? payload.JobId ?? payload.jobId ?? 'job_1').trim();
  if (!SAFE_JOB_ID_PATTERN.test(jobId)) {
    throw new ExtensionSdkError('INVALID_JOB_ID', `Invalid render job id "${jobId}".`);
  }

  const shotCode = validateShotCode(
    settingsObj.shot_code ?? payload.shotCode ?? payload.ExtraInfo0 ?? jobObj.shot ?? 'SEQ010_SH010'
  );
  const jobName = sanitizeRenderText(
    jobObj.name ?? payload.JobName ?? `${shotCode}_beauty_v01`,
    `${shotCode}_beauty_v01`,
    120
  );
  const engine = sanitizeRenderText(
    settingsObj.engine ?? jobObj.type ?? payload.Plugin ?? 'cycles',
    'cycles',
    40
  );
  const frameRange = parseFrameRange(
    settingsObj.frames ?? payload.frameRange ?? payload.FramesList ?? '1001-1120'
  );
  const avgFrameTime = formatAverageFrameTime(
    payload.avgFrameSeconds ??
      jobObj.avg_frame_seconds ??
      payload.AverageFrameTimeSeconds ??
      taskObj.duration_seconds ??
      0
  );
  const workerHost = validateWorkerHostname(
    workerObj.hostname ?? workerObj.name ?? payload.workerHostname ?? payload.SlaveName ?? 'render-node-01'
  );
  const rawOutput = Array.isArray(payload.OutputDirectories)
    ? payload.OutputDirectories[0]
    : settingsObj.render_output_root ?? payload.outputUri ?? `/renders/${shotCode}`;
  const outputUri = sanitizeRenderOutputUri(rawOutput);
  const failedFrame =
    taskObj.frame !== undefined || payload.failedFrame !== undefined
      ? Number(taskObj.frame ?? payload.failedFrame)
      : null;
  const peakMemoryGiB =
    taskObj.peak_memory_gib !== undefined || payload.peakMemoryGiB !== undefined
      ? Number(taskObj.peak_memory_gib ?? payload.peakMemoryGiB)
      : null;
  const errorDetail = sanitizeRenderText(
    taskObj.error ?? jobObj.error ?? payload.ErrorMessage ?? '',
    '',
    200
  );

  return {
    scheduler,
    event: rawEvent,
    jobId,
    shotCode,
    jobName,
    engine,
    frameRange,
    avgFrameTime,
    workerHost,
    outputUri,
    failedFrame: Number.isSafeInteger(failedFrame) && failedFrame >= 0 ? failedFrame : null,
    peakMemoryGiB: Number.isFinite(peakMemoryGiB) && peakMemoryGiB > 0 ? Number(peakMemoryGiB.toFixed(1)) : null,
    errorDetail,
  };
}

/**
 * Signs a render farm webhook (`sha256=<hex>` over `${timestamp}.${rawBody}`).
 *
 * @param {string} secret
 * @param {number | string} timestampSeconds
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signRenderfarmWebhookPayload(secret, timestampSeconds, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Render farm webhook secret must be at least 16 characters.');
  }
  const ts = String(timestampSeconds);
  if (!TIMESTAMP_DIGITS_PATTERN.test(ts) || !Number.isSafeInteger(Number(ts))) {
    throw new WebhookVerificationError('INVALID_TIMESTAMP', 'Render farm timestamp must be a non-negative integer.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const digest = createHmac('sha256', secret)
    .update(`${ts}.`, 'utf8')
    .update(bodyBuf)
    .digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verifies a native Flamenco / Deadline webhook (`X-Renderfarm-Timestamp` + `X-Renderfarm-Signature`)
 * in constant time via `timingSafeEqual`.
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
export function verifyRenderfarmWebhookSignature({
  secret,
  rawBody,
  signatureHeader,
  timestampHeader,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Render farm webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Render farm webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? RENDER_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed X-Renderfarm-Signature header.');
  }
  const tsRaw = typeof timestampHeader === 'string' ? timestampHeader.trim() : '';
  if (!TIMESTAMP_DIGITS_PATTERN.test(tsRaw)) {
    throw new WebhookVerificationError('MISSING_TIMESTAMP', 'Missing or non-numeric X-Renderfarm-Timestamp header.');
  }
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(nowUnixSeconds - ts) > maxSkewSeconds) {
    throw new WebhookVerificationError('TIMESTAMP_OUT_OF_RANGE', 'Render farm webhook timestamp outside replay window.');
  }

  const expectedBuf = createHmac('sha256', secret)
    .update(`${tsRaw}.`, 'utf8')
    .update(bodyBuf)
    .digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Render farm HMAC-SHA256 signature verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Render farm webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Render farm webhook payload must be a JSON object.');
  }

  return {
    timestamp: ts,
    payload: /** @type {Record<string, unknown>} */ (payload),
    signature: `sha256=${actualBuf.toString('hex')}`,
  };
}

/**
 * Executes the `/render` slash command (`queue`, `shot`, `workers`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleRenderCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_render_wrangling';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_td';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/render ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!RENDER_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_RENDER_SUBCOMMAND',
      `Unsupported /render subcommand "${subcommand}"; expected: ${RENDER_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  if (subcommand === 'shot') {
    const shotCode = validateShotCode(parsed.flags.shot ?? parsed.args[0] ?? 'SEQ010_SH040');
    const range = parseFrameRange(parsed.flags.frames ?? '1001-1120');
    return {
      text: `[Render Shot] **${shotCode}** frames \`${range.normalized}\` (${range.totalFrames} frames) inspected by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'shot',
      shotCode,
      frameRange: range,
    };
  }

  if (subcommand === 'workers') {
    const pool = sanitizeRenderText(parsed.flags.pool ?? 'gpu-optix', 'gpu-optix', 48);
    return {
      text: `[Render Workers] Pool \`${pool}\` node health summary requested in <#${channelId}> by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'workers',
      pool,
    };
  }

  if (subcommand === 'queue') {
    const scheduler = String(parsed.flags.scheduler ?? 'flamenco').toLowerCase();
    if (!['flamenco', 'deadline', 'all'].includes(scheduler)) {
      throw new ExtensionSdkError('INVALID_SCHEDULER', `Unsupported scheduler "${scheduler}".`);
    }
    return {
      text: `[Render Queue] Scheduler \`${scheduler}\` queue summary requested by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'queue',
      scheduler,
    };
  }

  return {
    text: `[Render Farm] Flamenco & Deadline monitor ready in <#${channelId}> — subcommands: \`queue\`, \`shot\`, \`workers\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
  };
}

export const renderCommand = defineSlashCommand({
  name: '/render',
  description: 'Inspect Flamenco or Deadline render queue status, shot progress, or worker nodes',
  scopes: ['messages:write', 'incidents:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleRenderCommand({ args, channelId, actorId }),
});

export const slashCommand = renderCommand;

/**
 * Formats and dispatches normalized render farm events to Kodera channels and incident cards.
 *
 * @param {Record<string, unknown>} rawPayload
 * @param {{
 *   defaultChannelId: string,
 *   dashboardOrigin: string,
 *   jobThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processRenderfarmEvent(rawPayload, state) {
  const { defaultChannelId, dashboardOrigin, jobThreads, client } = state;
  const norm = normalizeRenderJobPayload(rawPayload);
  const channelId = String(rawPayload.channelId ?? defaultChannelId);
  const dashboardUrl = validateEndpointUrl(
    String(rawPayload.jobUrl ?? `${dashboardOrigin}/jobs/${encodeURIComponent(norm.jobId)}`),
    { allowLocalhostHttp: false }
  );

  const rememberJobThread = (jobKey, threadId) => {
    if (jobThreads.size >= MAX_JOB_THREADS && !jobThreads.has(jobKey)) {
      const oldest = jobThreads.keys().next().value;
      if (oldest !== undefined) jobThreads.delete(oldest);
    }
    jobThreads.set(jobKey, threadId);
  };

  const idempotencyKey = `renderfarm:${norm.scheduler}:${norm.jobId}:${norm.event}:${norm.failedFrame ?? 'all'}`;

  if (norm.event === 'job.failed' || norm.event === 'task.oom_killed') {
    const severity = norm.event === 'task.oom_killed' ? 'critical' : 'high';
    const label = norm.event === 'task.oom_killed' ? 'RENDER OOM KILLED' : 'RENDER JOB FAILED';
    const frameTag = norm.failedFrame !== null ? ` (frame ${norm.failedFrame})` : '';
    const memTag = norm.peakMemoryGiB !== null ? ` · Peak RAM/VRAM: ${norm.peakMemoryGiB} GiB` : '';
    const errLine = norm.errorDetail ? `\nReason: ${norm.errorDetail}` : '';
    const title = `[${label}] ${norm.shotCode} — ${norm.jobName}${frameTag}`.slice(0, 200);
    const summary =
      `Scheduler: ${norm.scheduler} (${norm.engine}) · Frames: ${norm.frameRange.normalized} (${norm.frameRange.totalFrames}) · Avg: ${norm.avgFrameTime.formatted}\n` +
      `Worker: ${norm.workerHost}${memTag} · Output: ${norm.outputUri}${errLine}`;

    if (client) {
      const delivery = await client.postIncidentCard({
        channelId,
        title,
        severity,
        summary,
        externalUrl: dashboardUrl,
        status: 'open',
        idempotencyKey,
      });
      return {
        posted: true,
        incident: true,
        ...norm,
        severity,
        idempotencyKey,
        delivery,
      };
    }
    return {
      posted: false,
      incident: true,
      ...norm,
      severity,
      title,
      summary,
      idempotencyKey,
    };
  }

  const badge = norm.event === 'job.completed' ? '[RENDER COMPLETED]' : '[RENDER STARTED]';
  const text =
    `${badge} **${norm.shotCode}** (${norm.jobName}) · \`${norm.frameRange.normalized}\` (${norm.frameRange.totalFrames} frames) · ` +
    `Avg \`${norm.avgFrameTime.formatted}\` on \`${norm.workerHost}\` [${norm.scheduler}/${norm.engine}]\n` +
    `Output: \`${norm.outputUri}\` · ${dashboardUrl}`;
  const blocks = [
    {
      type: 'renderfarm_job_card',
      scheduler: norm.scheduler,
      event: norm.event,
      jobId: norm.jobId,
      shotCode: norm.shotCode,
      jobName: norm.jobName,
      engine: norm.engine,
      frameRange: norm.frameRange.normalized,
      totalFrames: norm.frameRange.totalFrames,
      avgFrameTime: norm.avgFrameTime.formatted,
      workerHost: norm.workerHost,
      outputUri: norm.outputUri,
      url: dashboardUrl,
    },
  ];

  if (client) {
    const existingThread = jobThreads.get(norm.jobId);
    if (existingThread && norm.event === 'job.completed') {
      const delivery = await client.postThreadReply({
        channelId,
        threadRootId: existingThread,
        text,
        blocks,
        idempotencyKey,
      });
      return { posted: true, threaded: true, ...norm, idempotencyKey, delivery };
    }
    const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
    if (typeof delivery.id === 'string') {
      rememberJobThread(norm.jobId, delivery.id);
    }
    return { posted: true, threaded: false, ...norm, idempotencyKey, delivery };
  }

  return { posted: false, ...norm, idempotencyKey, text, blocks };
}

/**
 * Creates a render farm webhook handler supporting canonical Kodera `x-kodera-signature-256`
 * deliveries and native Flamenco / Deadline `X-Renderfarm-Signature` webhooks.
 *
 * @param {{
 *   secret: string,
 *   renderfarmSecret?: string,
 *   defaultChannelId?: string,
 *   dashboardOrigin?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createRenderfarmWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const renderfarmSecret = config.renderfarmSecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_render_wrangling';
  const dashboardOrigin = validateEndpointUrl(
    config.dashboardOrigin ?? 'https://flamenco.studio.example',
    { allowLocalhostHttp: false }
  ).replace(/\/$/, '');
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, string>} */
  const jobThreads = new Map();
  /** @type {Map<string, number>} */
  const seenSignatures = new Map();
  /** @type {Map<string, number>} */
  const seenDeliveries = new Map();

  const pruneReplay = (nowSec) => {
    for (const [sig, ts] of seenSignatures.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenSignatures.delete(sig);
    }
    for (const [deliv, ts] of seenDeliveries.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenDeliveries.delete(deliv);
    }
  };

  const stateBase = {
    defaultChannelId,
    dashboardOrigin,
    jobThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'job.started': (payload, { client }) => processRenderfarmEvent({ ...payload, event: 'job.started' }, { ...stateBase, client }),
      'job.completed': (payload, { client }) => processRenderfarmEvent({ ...payload, event: 'job.completed' }, { ...stateBase, client }),
      'job.failed': (payload, { client }) => processRenderfarmEvent({ ...payload, event: 'job.failed' }, { ...stateBase, client }),
      'task.oom_killed': (payload, { client }) => processRenderfarmEvent({ ...payload, event: 'task.oom_killed' }, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        renderCommand.handler({
          command: 'render',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_td'),
        }),
    },
  });

  return async function handleIncomingRenderfarmWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const farmSig = getHeaderValue(req.headers, 'x-renderfarm-signature');

    if (koderaSig !== undefined || farmSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId = getHeaderValue(req.headers, 'x-renderfarm-delivery');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Render farm delivery ID must be bounded ASCII.');
    }

    const { timestamp, payload, signature } = verifyRenderfarmWebhookSignature({
      secret: renderfarmSecret,
      rawBody: req.rawBody,
      signatureHeader: farmSig,
      timestampHeader: getHeaderValue(req.headers, 'x-renderfarm-timestamp'),
      nowUnixSeconds: nowSec,
      maxSkewSeconds,
    });

    pruneReplay(nowSec);
    if (seenSignatures.has(signature) || (deliveryId !== undefined && seenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate render farm webhook delivery rejected.');
    }
    if (seenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Render farm replay cache is full.');
    }
    seenSignatures.set(signature, timestamp);
    if (deliveryId !== undefined) {
      seenDeliveries.set(deliveryId, timestamp);
    }

    const activeClient = req.client ?? config.client;
    const result = await processRenderfarmEvent(payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: 200,
      event: result.event,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createRenderfarmWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  renderCommand,
  handleRenderCommand,
  parseFrameRange,
  formatAverageFrameTime,
  validateWorkerHostname,
  sanitizeRenderOutputUri,
  normalizeRenderJobPayload,
  signRenderfarmWebhookPayload,
  verifyRenderfarmWebhookSignature,
  createRenderfarmWebhookHandler,
  createExtensionWebhookHandler,
};

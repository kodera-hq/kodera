import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const MANIFEST_SCHEMA_VERSION = 'kodera.extension.v1';
export const SIGNATURE_HEADER = 'x-kodera-signature-256';
export const TIMESTAMP_HEADER = 'x-kodera-timestamp';
export const EVENT_HEADER = 'x-kodera-event';
export const DELIVERY_ID_HEADER = 'x-kodera-delivery-id';
export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const DEFAULT_TOLERANCE_SECONDS = DEFAULT_MAX_SKEW_SECONDS;
export const MAX_WEBHOOK_REPLAY_ENTRIES = 4096;
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export const ALLOWED_EXTENSION_SCOPES = Object.freeze([
  'messages:write',
  'ephemeral:write',
  'channels:read',
  'webhooks:incoming',
  'incidents:write',
  'threads:write',
  'commands:register',
]);

export const EXTENSION_SCOPES = ALLOWED_EXTENSION_SCOPES;

export const EXTENSION_EVENTS = Object.freeze([
  'command.invoked',
  'message.created',
  'message.deleted',
  'release.published',
  'ci.workflow_failed',
  'incident.opened',
  'incident.acknowledged',
  'incident.resolved',
]);

export const INCIDENT_SEVERITIES = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

export const INCIDENT_STATUSES = Object.freeze([
  'open',
  'investigating',
  'acknowledged',
  'mitigated',
  'resolved',
]);

const MAX_TEXT_LENGTH = 4000;
const MAX_TITLE_LENGTH = 200;
const MAX_CHANNEL_ID_LENGTH = 128;
const MAX_COMMAND_RAW_LENGTH = 2048;
const MAX_COMMAND_TOKENS = 64;
const FORBIDDEN_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class WebhookVerificationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

export class ExtensionSdkError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'ExtensionSdkError';
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/**
 * Checks whether an IPv4 octet tuple falls into any loopback, link-local,
 * RFC1918 private, CGNAT, multicast, broadcast, or reserved range.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} _d
 * @param {boolean} allowLoopback
 * @returns {string | null} Rejection reason or null if public
 */
function classifyIpv4Range(a, b, c, _d, allowLoopback) {
  if (a === 127) {
    return allowLoopback ? null : 'Loopback IPv4 range (127.0.0.0/8) is forbidden.';
  }
  if (a === 0) {
    return 'Unspecified IPv4 range (0.0.0.0/8) is forbidden.';
  }
  if (a === 10) {
    return 'Private RFC1918 IPv4 range (10.0.0.0/8) is forbidden.';
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return 'Carrier-grade NAT IPv4 range (100.64.0.0/10) is forbidden.';
  }
  if (a === 169 && b === 254) {
    return 'Link-local / cloud metadata IPv4 range (169.254.0.0/16) is forbidden.';
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return 'Private RFC1918 IPv4 range (172.16.0.0/12) is forbidden.';
  }
  if (a === 192 && b === 0 && c === 0) {
    return 'IETF reserved IPv4 range (192.0.0.0/24) is forbidden.';
  }
  if (a === 192 && b === 168) {
    return 'Private RFC1918 IPv4 range (192.168.0.0/16) is forbidden.';
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return 'Benchmarking IPv4 range (198.18.0.0/15) is forbidden.';
  }
  if (a >= 224) {
    return 'Multicast and reserved IPv4 ranges (224.0.0.0/4+) are forbidden.';
  }
  return null;
}

/**
 * Expands a normalized IPv6 address literal into 8 16-bit integer groups.
 *
 * @param {string} ipv6
 * @returns {number[] | null}
 */
function expandIpv6Groups(ipv6) {
  let addr = ipv6;
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) {
    addr = addr.slice(0, zoneIdx);
  }
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4Part = addr.slice(lastColon + 1);
    const v4Segments = v4Part.split('.');
    if (v4Segments.length !== 4) return null;
    const nums = v4Segments.map((s) => Number(s));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = ((nums[0] << 8) | nums[1]).toString(16);
    const low = ((nums[2] << 8) | nums[3]).toString(16);
    addr = `${addr.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if ((halves.length === 1 && left.length !== 8) || missing < 0) {
    return null;
  }
  const full = [...left, ...Array(missing).fill('0'), ...right];
  if (full.length !== 8) return null;
  const groups = [];
  for (const part of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push( Number.parseInt(part, 16));
  }
  return groups;
}

/**
 * Validates an outbound or webhook endpoint URL against SSRF vectors.
 *
 * Enforces HTTPS (unless `allowLocalhostHttp: true` for local loopback testing),
 * forbids embedded credentials (`user:pass@`), and rejects loopback (`localhost`,
 * `127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), RFC1918
 * private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT
 * (`100.64.0.0/10`), unique-local IPv6 (`fc00::/7`), site-local IPv6 (`fec0::/10`),
 * 6to4 (`2002::/16`), and every IPv4-mapped (`::ffff:0:0/96`) or IPv4-translated
 * (`::ffff:0:0:0/96`) IPv6 target.
 *
 * @param {string} rawUrl
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 * @returns {string} Canonical validated URL string
 */
export function validateEndpointUrl(rawUrl, options = {}) {
  const allowLocalhostHttp = Boolean(options?.allowLocalhostHttp);
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new ExtensionSdkError('INVALID_URL', 'Endpoint URL must be a non-empty string.');
  }

  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ExtensionSdkError('INVALID_URL', 'Malformed endpoint URL.');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new ExtensionSdkError('SSRF_EMBEDDED_CREDENTIALS', 'Endpoint URL must not contain embedded credentials.');
  }

  const rawHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!rawHost) {
    throw new ExtensionSdkError('INVALID_URL', 'Endpoint URL must include a valid hostname.');
  }

  const unbracketedHost =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  const isLocalhostName =
    unbracketedHost === 'localhost' ||
    unbracketedHost.endsWith('.localhost') ||
    unbracketedHost === '127.0.0.1' ||
    unbracketedHost === '::1';

  if (parsed.protocol !== 'https:') {
    if (!(allowLocalhostHttp && parsed.protocol === 'http:' && isLocalhostName)) {
      throw new ExtensionSdkError(
        'SSRF_INSECURE_PROTOCOL',
        `Endpoint URL must use https: protocol (received ${parsed.protocol}).`
      );
    }
  }

  if (
    unbracketedHost === 'localhost' ||
    unbracketedHost.endsWith('.localhost') ||
    unbracketedHost.endsWith('.local') ||
    unbracketedHost.endsWith('.internal') ||
    unbracketedHost.endsWith('.arpa')
  ) {
    if (allowLocalhostHttp && (unbracketedHost === 'localhost' || unbracketedHost.endsWith('.localhost'))) {
      return parsed.toString();
    }
    throw new ExtensionSdkError(
      'SSRF_FORBIDDEN_HOST',
      `Endpoint hostname "${unbracketedHost}" resolves to a local or internal domain.`
    );
  }

  if (rawHost.includes('%')) {
    throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'IPv6 zone identifiers are forbidden in endpoint URLs.');
  }

  const ipVersion = isIP(unbracketedHost);
  if (ipVersion === 4) {
    const octets = unbracketedHost.split('.').map((part) => Number(part));
    const reason = classifyIpv4Range(
      octets[0],
      octets[1],
      octets[2],
      octets[3],
      allowLocalhostHttp && unbracketedHost === '127.0.0.1'
    );
    if (reason) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', reason);
    }
    return parsed.toString();
  }

  if (ipVersion === 6 || rawHost.startsWith('[')) {
    const groups = expandIpv6Groups(unbracketedHost);
    if (!groups) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', `Invalid IPv6 literal: ${unbracketedHost}`);
    }
    const isAllZeroTop80 =
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0;

    // Unspecified ::
    if (isAllZeroTop80 && groups[5] === 0 && groups[6] === 0 && groups[7] === 0) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'Unspecified IPv6 address (::) is forbidden.');
    }

    // Loopback ::1
    if (isAllZeroTop80 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
      if (!allowLocalhostHttp) {
        throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'Loopback IPv6 address (::1) is forbidden.');
      }
      return parsed.toString();
    }

    // IPv4-mapped ::ffff:0:0/96, whatever IPv4 address it carries: the socket reaches that IPv4
    // address, so a mapped literal only dresses an IPv4 target as IPv6. An endpoint names it directly.
    if (isAllZeroTop80 && groups[5] === 0xffff) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'IPv4-mapped IPv6 range (::ffff:0:0/96) is forbidden.');
    }

    // IPv4-translated ::ffff:0:w.x.y.z (::ffff:0:0:0/96, RFC 2765): the same disguise, one group earlier.
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0xffff &&
      groups[5] === 0
    ) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'IPv4-translated IPv6 range (::ffff:0:0:0/96) is forbidden.');
    }

    // 6to4 2002::/16 embeds an IPv4 address (2002:wwxx:yyzz::) that a relay may route to.
    if (groups[0] === 0x2002) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', '6to4 IPv6 range (2002::/16) is forbidden.');
    }

    // Site-local fec0::/10: deprecated (RFC 3879) but still routed inside some networks.
    if ((groups[0] & 0xffc0) === 0xfec0) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'Site-local IPv6 range (fec0::/10) is forbidden.');
    }

    // IPv4-compatible ::w.x.y.z (deprecated): judged by the IPv4 address it carries.
    if (isAllZeroTop80 && groups[5] === 0x0000) {
      const a = (groups[6] >> 8) & 0xff;
      const b = groups[6] & 0xff;
      const c = (groups[7] >> 8) & 0xff;
      const d = groups[7] & 0xff;
      const reason = classifyIpv4Range(a, b, c, d, false);
      if (reason) {
        throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', `IPv4-mapped IPv6 address rejected: ${reason}`);
      }
    }

    // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
    if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
      const a = (groups[6] >> 8) & 0xff;
      const b = groups[6] & 0xff;
      const c = (groups[7] >> 8) & 0xff;
      const d = groups[7] & 0xff;
      const reason = classifyIpv4Range(a, b, c, d, false);
      if (reason) {
        throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', `NAT64-embedded IPv4 address rejected: ${reason}`);
      }
    }

    // Unique local fc00::/7 (fc00:: - fdff::)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'Unique-local IPv6 range (fc00::/7) is forbidden.');
    }

    // Link-local fe80::/10
    if ((groups[0] & 0xffc0) === 0xfe80) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'Link-local IPv6 range (fe80::/10) is forbidden.');
    }

    // Multicast ff00::/8
    if ((groups[0] & 0xff00) === 0xff00) {
      throw new ExtensionSdkError('SSRF_FORBIDDEN_IP', 'Multicast IPv6 range (ff00::/8) is forbidden.');
    }

    return parsed.toString();
  }

  // Non-IP hostname must contain at least one dot (blocks single-label internal DNS names like "redis" or "metadata")
  if (!unbracketedHost.includes('.')) {
    throw new ExtensionSdkError(
      'SSRF_FORBIDDEN_HOST',
      `Single-label internal hostname "${unbracketedHost}" is forbidden.`
    );
  }

  return parsed.toString();
}

/**
 * Validates and freezes a Kodera extension manifest (`kodera-extension.json`),
 * enforcing schema version, least-privilege scopes, event declarations, and
 * SSRF validation on `webhookUrl`.
 *
 * @param {Record<string, unknown>} manifest
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 * @returns {Readonly<{
 *   schemaVersion: string,
 *   id: string,
 *   name: string,
 *   version: string,
 *   description: string,
 *   scopes: readonly string[],
 *   events: readonly string[],
 *   webhookUrl?: string,
 *   commands: readonly Readonly<{ name: string, description: string }>[],
 * }>}
 */
export function validateManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ExtensionSdkError('INVALID_MANIFEST', 'Extension manifest must be a non-null JSON object.');
  }

  const schemaVersion = manifest.schemaVersion ?? MANIFEST_SCHEMA_VERSION;
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_SCHEMA',
      `Unsupported manifest schemaVersion "${String(schemaVersion)}"; expected "${MANIFEST_SCHEMA_VERSION}".`
    );
  }

  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(manifest.id)) {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_ID',
      'Manifest "id" must be a lowercase kebab-case slug (2-63 chars).'
    );
  }

  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0 || manifest.name.length > 80) {
    throw new ExtensionSdkError('INVALID_MANIFEST_NAME', 'Manifest "name" must be a non-empty string (<= 80 chars).');
  }

  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new ExtensionSdkError('INVALID_MANIFEST_VERSION', 'Manifest "version" must be a valid SemVer string.');
  }

  if (
    typeof manifest.description !== 'string' ||
    manifest.description.trim().length === 0 ||
    manifest.description.length > 500
  ) {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_DESCRIPTION',
      'Manifest "description" must be a non-empty string (<= 500 chars).'
    );
  }

  if (!Array.isArray(manifest.scopes) || manifest.scopes.length === 0) {
    throw new ExtensionSdkError('INVALID_MANIFEST_SCOPES', 'Manifest "scopes" must be a non-empty array.');
  }

  /** @type {string[]} */
  const normalizedScopes = [];
  const seenScopes = new Set();
  for (const scope of manifest.scopes) {
    if (typeof scope !== 'string' || !ALLOWED_EXTENSION_SCOPES.includes(scope)) {
      throw new ExtensionSdkError(
        'INVALID_MANIFEST_SCOPES',
        `Unsupported extension scope "${String(scope)}"; allowed: ${ALLOWED_EXTENSION_SCOPES.join(', ')}.`
      );
    }
    if (seenScopes.has(scope)) {
      throw new ExtensionSdkError('INVALID_MANIFEST_SCOPES', `Duplicate extension scope "${scope}".`);
    }
    seenScopes.add(scope);
    normalizedScopes.push(scope);
  }

  const rawEvents = Array.isArray(manifest.events) ? manifest.events : [];
  /** @type {string[]} */
  const normalizedEvents = [];
  for (const evt of rawEvents) {
    if (typeof evt !== 'string' || !EXTENSION_EVENTS.includes(evt)) {
      throw new ExtensionSdkError(
        'INVALID_MANIFEST_EVENTS',
        `Unsupported extension event "${String(evt)}"; allowed: ${EXTENSION_EVENTS.join(', ')}.`
      );
    }
    if (!normalizedEvents.includes(evt)) {
      normalizedEvents.push(evt);
    }
  }

  let validatedWebhookUrl;
  if (manifest.webhookUrl !== undefined) {
    if (typeof manifest.webhookUrl !== 'string') {
      throw new ExtensionSdkError('INVALID_URL', 'Manifest "webhookUrl" must be a string when provided.');
    }
    validatedWebhookUrl = validateEndpointUrl(manifest.webhookUrl, options);
  }

  const rawCommands = Array.isArray(manifest.commands) ? manifest.commands : [];
  const normalizedCommands = rawCommands.map((cmd) => {
    if (!cmd || typeof cmd !== 'object') {
      throw new ExtensionSdkError('INVALID_MANIFEST_COMMAND', 'Each manifest command entry must be an object.');
    }
    const record = /** @type {Record<string, unknown>} */ (cmd);
    const rawCmdName = typeof record.name === 'string' ? record.name : '';
    if (!/^\/?[a-z0-9][a-z0-9-]{1,31}$/.test(rawCmdName)) {
      throw new ExtensionSdkError(
        'INVALID_MANIFEST_COMMAND',
        `Invalid command name "${rawCmdName}" in manifest.`
      );
    }
    const cleanName = rawCmdName.startsWith('/') ? rawCmdName.slice(1) : rawCmdName;
    const desc = typeof record.description === 'string' ? record.description.trim() : '';
    if (!desc || desc.length > 200) {
      throw new ExtensionSdkError(
        'INVALID_MANIFEST_COMMAND',
        `Command "${cleanName}" requires a non-empty description (<= 200 chars).`
      );
    }
    return Object.freeze({ name: cleanName, description: desc });
  });

  const result = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: manifest.id,
    name: manifest.name.trim(),
    version: manifest.version,
    description: manifest.description.trim(),
    scopes: Object.freeze(normalizedScopes),
    events: Object.freeze(normalizedEvents),
    ...(validatedWebhookUrl ? { webhookUrl: validatedWebhookUrl } : {}),
    commands: Object.freeze(normalizedCommands),
  };

  return Object.freeze(result);
}

/**
 * Normalizes a string, Node `Buffer`, or Web `Uint8Array` into a `Buffer`.
 * @param {string | Uint8Array} rawBody
 * @returns {Buffer}
 */
function toBodyBuffer(rawBody) {
  const length = typeof rawBody === 'string'
    ? Buffer.byteLength(rawBody, 'utf8')
    : rawBody instanceof Uint8Array ? rawBody.byteLength : undefined;
  if (length !== undefined && length > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Webhook body exceeds the byte limit.');
  }
  if (Buffer.isBuffer(rawBody)) {
    return rawBody;
  }
  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody);
  }
  if (typeof rawBody === 'string') {
    return Buffer.from(rawBody, 'utf8');
  }
  throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
}

/**
 * Case-insensitively reads a header from a Fetch `Headers` instance or plain Node `IncomingHttpHeaders` object.
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string} name
 * @returns {string | undefined}
 */
export function getHeaderValue(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (typeof (/** @type {Headers} */ (headers)).get === 'function') {
    return (/** @type {Headers} */ (headers)).get(lower) ?? undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * Computes a Kodera `v1=<hex>` HMAC-SHA256 signature over `${timestamp}.${rawBody}`.
 *
 * @param {string} secret Shared webhook signing secret (`whsec_...`)
 * @param {number | string} timestampUnixSeconds Unix timestamp in seconds
 * @param {string | Uint8Array} rawBody Exact raw HTTP request body
 * @returns {string}
 */
export function signWebhookPayload(secret, timestampUnixSeconds, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook secret must be at least 16 characters.');
  }
  const ts = String(timestampUnixSeconds);
  if (!/^(0|[1-9]\d{0,15})$/.test(ts) || !Number.isSafeInteger(Number(ts))) {
    throw new WebhookVerificationError('INVALID_TIMESTAMP', 'Webhook timestamp must be a canonical non-negative safe integer.');
  }
  const bodyBuf = toBodyBuffer(rawBody);
  const mac = createHmac('sha256', secret)
    .update(ts, 'utf8')
    .update('.', 'utf8')
    .update(bodyBuf)
    .digest('hex');
  return `v1=${mac}`;
}

/**
 * Verifies an incoming Kodera webhook request using constant-time HMAC comparison and replay skew bounds.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   timestampHeader: string | undefined,
 *   nowUnixSeconds?: number,
 *   maxSkewSeconds?: number,
 * }} params
 * @returns {Record<string, unknown>}
 */
export function verifyWebhookRequest({
  secret,
  rawBody,
  signatureHeader,
  timestampHeader,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds < 0
    || !Number.isSafeInteger(maxSkewSeconds) || maxSkewSeconds < 0
    || maxSkewSeconds > DEFAULT_MAX_SKEW_SECONDS) {
    throw new WebhookVerificationError('INVALID_CLOCK', 'Webhook clock and tolerance must be bounded non-negative integers.');
  }
  if (!signatureHeader || !signatureHeader.startsWith('v1=')) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed x-kodera-signature-256 header.');
  }
  if (!timestampHeader || !/^(0|[1-9]\d{0,15})$/.test(timestampHeader)) {
    throw new WebhookVerificationError('MISSING_TIMESTAMP', 'Missing or non-numeric x-kodera-timestamp header.');
  }

  const ts = Number(timestampHeader);
  if (!Number.isSafeInteger(ts) || Math.abs(nowUnixSeconds - ts) > maxSkewSeconds) {
    throw new WebhookVerificationError('TIMESTAMP_OUT_OF_RANGE', 'Webhook timestamp outside allowed replay window.');
  }

  const bodyBuf = toBodyBuffer(rawBody);
  const expected = signWebhookPayload(secret, ts, bodyBuf);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'Webhook HMAC-SHA256 signature verification failed.');
  }

  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf);
    parsed = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'Webhook payload is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Webhook payload must be a JSON object.');
  }
  return parsed;
}

/**
 * Alias/helper for verifying webhook signatures with either `{ secret, rawBody, signatureHeader, timestampHeader }`
 * or `{ secret, payload, signature, timestamp, toleranceSeconds, nowSeconds }`.
 *
 * @param {{
 *   secret: string,
 *   rawBody?: string | Uint8Array,
 *   payload?: string | Uint8Array,
 *   signatureHeader?: string,
 *   signature?: string,
 *   timestampHeader?: string | number,
 *   timestamp?: string | number,
 *   nowUnixSeconds?: number,
 *   nowSeconds?: number,
 *   maxSkewSeconds?: number,
 *   toleranceSeconds?: number,
 * }} params
 * @returns {Record<string, unknown>}
 */
export function verifyWebhookSignature(params) {
  const rawBody = params.rawBody ?? params.payload ?? '';
  const signatureHeader = params.signatureHeader ?? params.signature;
  const rawTs = params.timestampHeader ?? params.timestamp;
  const timestampHeader = rawTs !== undefined ? String(rawTs) : undefined;
  const nowUnixSeconds = params.nowUnixSeconds ?? params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkewSeconds = params.maxSkewSeconds ?? params.toleranceSeconds ?? DEFAULT_MAX_SKEW_SECONDS;

  return verifyWebhookRequest({
    secret: params.secret,
    rawBody,
    signatureHeader,
    timestampHeader,
    nowUnixSeconds,
    maxSkewSeconds,
  });
}

/**
 * Creates a reusable, replay-protected webhook handler that verifies HMAC-SHA256
 * signatures, enforces timestamp tolerance, tracks authenticated signatures and delivery IDs to block replay
 * attacks within the skew window, and dispatches events to registered handlers.
 *
 * @param {{
 *   secret: string,
 *   maxSkewSeconds?: number,
 *   toleranceSeconds?: number,
 *   maxReplayEntries?: number,
 *   handlers?: Record<string, (payload: Record<string, unknown>, ctx: {
 *     event: string,
 *     deliveryId: string | undefined,
 *     timestamp: number,
 *     headers: Headers | Record<string, string | string[] | undefined>,
 *     client?: ReturnType<typeof createExtensionClient>,
 *   }) => Promise<unknown> | unknown>,
 *   onEvent?: (payload: Record<string, unknown>, ctx: {
 *     event: string,
 *     deliveryId: string | undefined,
 *     timestamp: number,
 *     headers: Headers | Record<string, string | string[] | undefined>,
 *     client?: ReturnType<typeof createExtensionClient>,
 *   }) => Promise<unknown> | unknown,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} options
 */
export function createWebhookHandler(options) {
  if (!options || typeof options.secret !== 'string' || options.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const secret = options.secret;
  const maxSkewSeconds = options.maxSkewSeconds ?? options.toleranceSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = options.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;
  if (!Number.isSafeInteger(maxSkewSeconds) || maxSkewSeconds < 0 || maxSkewSeconds > DEFAULT_MAX_SKEW_SECONDS) {
    throw new WebhookVerificationError('INVALID_CLOCK', 'Webhook tolerance must be an integer between zero and the maximum skew.');
  }
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1 || maxReplayEntries > MAX_WEBHOOK_REPLAY_ENTRIES) {
    throw new WebhookVerificationError('INVALID_REPLAY_CAPACITY', 'Webhook replay capacity is outside the supported bounds.');
  }
  const handlers = options.handlers ?? {};
  const onEvent = options.onEvent;
  const defaultClient = options.client;

  /** @type {Map<string, { timestamp: number, deliveryId?: string }>} authenticated signature -> metadata */
  const seenSignatures = new Map();
  /** @type {Map<string, string>} delivery ID -> authenticated signature */
  const seenDeliveries = new Map();
  /** @type {number | undefined} */
  let latestClock;

  /**
   * @param {number} nowUnixSeconds
   */
  function pruneSeenDeliveries(nowUnixSeconds) {
    for (const [signature, entry] of seenSignatures.entries()) {
      if (nowUnixSeconds - entry.timestamp > maxSkewSeconds) {
        seenSignatures.delete(signature);
        if (entry.deliveryId !== undefined) seenDeliveries.delete(entry.deliveryId);
      }
    }
  }

  /**
   * @param {{
   *   rawBody: string | Uint8Array,
   *   headers: Headers | Record<string, string | string[] | undefined>,
   *   nowUnixSeconds?: number,
   *   nowSeconds?: number,
   *   client?: ReturnType<typeof createExtensionClient>,
   * }} req
   */
  return async function handleWebhook(req) {
    const nowUnixSeconds = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const signatureHeader = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const timestampHeader = getHeaderValue(req.headers, TIMESTAMP_HEADER);
    const headerEvent = getHeaderValue(req.headers, EVENT_HEADER);
    const deliveryId = getHeaderValue(req.headers, DELIVERY_ID_HEADER);

    const payload = verifyWebhookRequest({
      secret,
      rawBody: req.rawBody,
      signatureHeader,
      timestampHeader,
      nowUnixSeconds,
      maxSkewSeconds,
    });

    if (latestClock !== undefined && nowUnixSeconds < latestClock) {
      throw new WebhookVerificationError('INVALID_CLOCK', 'Webhook handler clock must not move backwards.');
    }
    if (deliveryId !== undefined && (typeof deliveryId !== 'string' || deliveryId.length < 1
      || deliveryId.length > 255 || /[\s\x00-\x1f\x7f]/u.test(deliveryId))) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'Webhook delivery ID must be bounded printable metadata.');
    }

    const eventName = payload.type ?? payload.event;
    if (typeof eventName !== 'string' || eventName.length < 1 || eventName.length > 128
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(eventName)
      || (payload.type !== undefined && payload.event !== undefined && payload.type !== payload.event)
      || (headerEvent !== undefined && headerEvent !== eventName)) {
      throw new WebhookVerificationError('INVALID_EVENT', 'Webhook event must be bound to consistent authenticated payload metadata.');
    }

    // Even a refused replay must not prune history and then permit clock rollback.
    latestClock = nowUnixSeconds;
    pruneSeenDeliveries(nowUnixSeconds);
    // The delivery ID and event headers are not in the v1 HMAC transcript. A new or
    // removed ID must never turn the same authenticated transcript into a new event.
    const signature = /** @type {string} */ (signatureHeader);
    if (seenSignatures.has(signature) || (deliveryId !== undefined && seenDeliveries.has(deliveryId))) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate authenticated webhook delivery rejected.');
    }
    if (seenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Webhook replay guard is full; no live entry was evicted.');
    }
    seenSignatures.set(signature, { timestamp: Number(timestampHeader), deliveryId });
    if (deliveryId !== undefined) seenDeliveries.set(deliveryId, signature);

    const context = {
      event: eventName,
      deliveryId,
      timestamp: Number(timestampHeader),
      headers: req.headers,
      client: req.client ?? defaultClient,
    };

    const specificHandler = Object.prototype.hasOwnProperty.call(handlers, eventName)
      ? handlers[eventName]
      : undefined;

    if (typeof specificHandler === 'function') {
      const result = await specificHandler(payload, context);
      return { ok: true, status: 200, event: eventName, deliveryId, result };
    }
    if (typeof onEvent === 'function') {
      const result = await onEvent(payload, context);
      return { ok: true, status: 200, event: eventName, deliveryId, result };
    }

    return { ok: true, status: 202, event: eventName, deliveryId, result: { ignored: true } };
  };
}

/**
 * Declares a typed, least-privilege slash-command extension manifest and handler.
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   scopes?: readonly string[],
 *   handler: (ctx: { command: string, args: string, channelId: string, actorId: string }) => Promise<{ text: string, ephemeral?: boolean }> | { text: string, ephemeral?: boolean }
 * }} definition
 */
export function defineSlashCommand(definition) {
  if (!definition || !/^\/?[a-z0-9][a-z0-9-]{1,31}$/.test(definition.name)) {
    throw new Error('Invalid slash command name; expected lowercase alphanumeric slug (2-32 chars).');
  }
  const normalizedName = definition.name.startsWith('/') ? definition.name.slice(1) : definition.name;
  if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
    throw new Error('Slash command description is required.');
  }
  if (typeof definition.handler !== 'function') {
    throw new Error('Slash command handler function is required.');
  }
  const scopes = [...(definition.scopes ?? ['messages:write'])];
  if (scopes.length === 0 || scopes.some((s) => !ALLOWED_EXTENSION_SCOPES.includes(s))) {
    throw new Error(`Invalid extension scope; allowed scopes: ${ALLOWED_EXTENSION_SCOPES.join(', ')}`);
  }
  return Object.freeze({
    name: normalizedName,
    description: definition.description.trim(),
    scopes: Object.freeze(scopes),
    handler: definition.handler,
  });
}

/**
 * Tokenizes a raw slash-command string while respecting double and single quotes.
 *
 * @param {string} input
 * @returns {string[]}
 */
function tokenizeCommandLine(input) {
  /** @type {string[]} */
  const tokens = [];
  let current = '';
  /** @type {'"' | "'" | null} */
  let quote = null;
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
        if (tokens.length > MAX_COMMAND_TOKENS) {
          throw new ExtensionSdkError(
            'COMMAND_TOO_MANY_TOKENS',
            `Command invocation exceeds maximum of ${MAX_COMMAND_TOKENS} tokens.`
          );
        }
      }
      continue;
    }
    current += ch;
  }

  if (quote !== null) {
    throw new ExtensionSdkError('COMMAND_UNCLOSED_QUOTE', 'Command invocation contains an unclosed quote.');
  }
  if (current.length > 0) {
    tokens.push(current);
    if (tokens.length > MAX_COMMAND_TOKENS) {
      throw new ExtensionSdkError(
        'COMMAND_TOO_MANY_TOKENS',
        `Command invocation exceeds maximum of ${MAX_COMMAND_TOKENS} tokens.`
      );
    }
  }
  return tokens;
}

/**
 * Parses a slash command invocation string (e.g. `/command subcommand --flag=value arg1`)
 * into `{ command, subcommand, args, flags }` with strict input length limits and
 * prototype-pollution protection (`Object.create(null)` flags).
 *
 * @param {string} rawText
 * @returns {Readonly<{
 *   command: string,
 *   subcommand: string | null,
 *   args: readonly string[],
 *   flags: Record<string, string | boolean>,
 * }>}
 */
export function parseCommandInvocation(rawText) {
  if (typeof rawText !== 'string') {
    throw new ExtensionSdkError('INVALID_COMMAND_INPUT', 'Command invocation must be a string.');
  }
  if (rawText.length > MAX_COMMAND_RAW_LENGTH) {
    throw new ExtensionSdkError(
      'COMMAND_INPUT_TOO_LONG',
      `Command invocation exceeds ${MAX_COMMAND_RAW_LENGTH} characters.`
    );
  }

  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) {
    throw new ExtensionSdkError('INVALID_COMMAND_PREFIX', 'Slash command invocation must start with "/".');
  }

  const tokens = tokenizeCommandLine(trimmed);
  if (tokens.length === 0) {
    throw new ExtensionSdkError('INVALID_COMMAND_INPUT', 'Slash command invocation cannot be empty.');
  }

  const rawCommand = tokens[0].slice(1).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(rawCommand)) {
    throw new ExtensionSdkError(
      'INVALID_COMMAND_NAME',
      `Invalid slash command "${rawCommand}"; expected lowercase alphanumeric slug (2-32 chars).`
    );
  }

  /** @type {Record<string, string | boolean>} */
  const flags = Object.create(null);
  /** @type {string[]} */
  const positionals = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('--') && token.length > 2) {
      const eqIdx = token.indexOf('=');
      const rawKey = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const val = eqIdx === -1 ? true : token.slice(eqIdx + 1);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rawKey)) {
        if (FORBIDDEN_PROTOTYPE_KEYS.has(rawKey)) {
          throw new ExtensionSdkError('FORBIDDEN_FLAG_NAME', `Forbidden flag name "${rawKey}".`);
        }
        throw new ExtensionSdkError('INVALID_FLAG_NAME', `Invalid flag name "${rawKey}".`);
      }
      if (FORBIDDEN_PROTOTYPE_KEYS.has(rawKey)) {
        throw new ExtensionSdkError('FORBIDDEN_FLAG_NAME', `Forbidden flag name "${rawKey}".`);
      }
      flags[rawKey] = val;
    } else if (token.startsWith('-') && !token.startsWith('--') && token.length > 1) {
      const shortKey = token.slice(1);
      if (!/^[a-zA-Z0-9]{1,16}$/.test(shortKey) || FORBIDDEN_PROTOTYPE_KEYS.has(shortKey)) {
        throw new ExtensionSdkError('INVALID_FLAG_NAME', `Invalid short flag "${shortKey}".`);
      }
      flags[shortKey] = true;
    } else {
      positionals.push(token);
    }
  }

  const subcommand = positionals.length > 0 ? positionals[0] : null;
  const args = positionals.length > 1 ? positionals.slice(1) : [];

  return Object.freeze({
    command: rawCommand,
    subcommand,
    args: Object.freeze(args),
    flags: Object.freeze(flags),
  });
}

/**
 * Validates channel/thread identifiers and idempotency keys.
 *
 * @param {string} value
 * @param {string} fieldName
 */
function assertSafeIdentifier(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_CHANNEL_ID_LENGTH) {
    throw new ExtensionSdkError(
      'INVALID_PARAMETER',
      `${fieldName} must be a non-empty string (<= ${MAX_CHANNEL_ID_LENGTH} chars).`
    );
  }
  if (/[\r\n\0]/.test(value)) {
    throw new ExtensionSdkError('INVALID_PARAMETER', `${fieldName} must not contain control characters.`);
  }
}

/**
 * Validates message text bounds.
 *
 * @param {string} text
 * @param {string} fieldName
 */
function assertBoundedText(text, fieldName = 'text') {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ExtensionSdkError('INVALID_PARAMETER', `${fieldName} must be a non-empty string.`);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ExtensionSdkError(
      'PAYLOAD_TOO_LARGE',
      `${fieldName} exceeds maximum length of ${MAX_TEXT_LENGTH} characters.`
    );
  }
}

/**
 * Resolves and validates an `Idempotency-Key` header value.
 *
 * @param {string | undefined} key
 * @returns {string}
 */
function resolveIdempotencyKey(key) {
  if (key === undefined) {
    return randomUUID();
  }
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 255 || /[\r\n\0]/.test(key)) {
    throw new ExtensionSdkError(
      'INVALID_IDEMPOTENCY_KEY',
      'idempotencyKey must be a non-empty printable string (<= 255 chars).'
    );
  }
  return key.trim();
}

/**
 * Creates a typed outbound Kodera extension client with SSRF validation,
 * payload bounds enforcement, bearer authentication, idempotency keys, and
 * request timeouts.
 *
 * @param {{
 *   baseUrl: string,
 *   token: string,
 *   fetchImpl?: typeof globalThis.fetch,
 *   timeoutMs?: number,
 *   allowLocalhostHttp?: boolean,
 * }} config
 */
export function createExtensionClient(config) {
  if (!config || typeof config !== 'object') {
    throw new ExtensionSdkError('INVALID_CLIENT_CONFIG', 'Extension client configuration object is required.');
  }

  const validatedBase = validateEndpointUrl(config.baseUrl, {
    allowLocalhostHttp: Boolean(config.allowLocalhostHttp),
  }).replace(/\/$/, '');

  if (typeof config.token !== 'string' || config.token.trim().length < 8 || /[\r\n\0\s]/.test(config.token)) {
    throw new ExtensionSdkError(
      'INVALID_CLIENT_TOKEN',
      'Extension client token must be a non-empty bearer token string without whitespace.'
    );
  }

  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ExtensionSdkError('INVALID_FETCH_IMPL', 'A valid fetch implementation is required.');
  }

  const timeoutMs = config.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) {
    throw new ExtensionSdkError('INVALID_TIMEOUT', 'timeoutMs must be an integer between 50 and 60000.');
  }

  /**
   * @param {string} path
   * @param {Record<string, unknown>} body
   * @param {string | undefined} idempotencyKey
   */
  async function sendJsonPost(path, body, idempotencyKey) {
    const resolvedKey = resolveIdempotencyKey(idempotencyKey);
    const url = `${validatedBase}${path}`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
        'idempotency-key': resolvedKey,
        'user-agent': 'kodera-extension-sdk/0.1.0',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new ExtensionSdkError(
        'EXTENSION_API_ERROR',
        `Kodera extension API request failed with HTTP ${response.status}.`,
        response.status
      );
    }

    const data = /** @type {Record<string, unknown>} */ (await response.json());
    return data;
  }

  return Object.freeze({
    /**
     * Posts a structured message to a Kodera channel.
     *
     * @param {{
     *   channelId: string,
     *   text: string,
     *   blocks?: readonly Record<string, unknown>[],
     *   idempotencyKey?: string,
     * }} params
     */
    async postChannelMessage({ channelId, text, blocks = [], idempotencyKey }) {
      assertSafeIdentifier(channelId, 'channelId');
      assertBoundedText(text, 'text');
      if (!Array.isArray(blocks) || blocks.length > 50) {
        throw new ExtensionSdkError('INVALID_BLOCKS', 'blocks must be an array of at most 50 items.');
      }
      return sendJsonPost(
        `/api/v1/extensions/channels/${encodeURIComponent(channelId)}/messages`,
        { channelId, text, blocks },
        idempotencyKey
      );
    },

    /**
     * Posts a follow-up reply inside an existing channel thread.
     *
     * @param {{
     *   channelId: string,
     *   threadRootId: string,
     *   text: string,
     *   blocks?: readonly Record<string, unknown>[],
     *   idempotencyKey?: string,
     * }} params
     */
    async postThreadReply({ channelId, threadRootId, text, blocks = [], idempotencyKey }) {
      assertSafeIdentifier(channelId, 'channelId');
      assertSafeIdentifier(threadRootId, 'threadRootId');
      assertBoundedText(text, 'text');
      if (!Array.isArray(blocks) || blocks.length > 50) {
        throw new ExtensionSdkError('INVALID_BLOCKS', 'blocks must be an array of at most 50 items.');
      }
      return sendJsonPost(
        `/api/v1/extensions/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadRootId)}/replies`,
        { channelId, threadRootId, text, blocks },
        idempotencyKey
      );
    },

    /**
     * Posts a structured incident card to a Kodera channel.
     *
     * @param {{
     *   channelId: string,
     *   title: string,
     *   severity: 'critical' | 'high' | 'medium' | 'low' | 'info',
     *   summary: string,
     *   externalUrl?: string,
     *   status?: 'open' | 'investigating' | 'acknowledged' | 'mitigated' | 'resolved',
     *   idempotencyKey?: string,
     * }} params
     */
    async postIncidentCard({
      channelId,
      title,
      severity,
      summary,
      externalUrl,
      status = 'open',
      idempotencyKey,
    }) {
      assertSafeIdentifier(channelId, 'channelId');
      if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
        throw new ExtensionSdkError(
          'INVALID_PARAMETER',
          `Incident title must be a non-empty string (<= ${MAX_TITLE_LENGTH} chars).`
        );
      }
      if (!INCIDENT_SEVERITIES.includes(severity)) {
        throw new ExtensionSdkError(
          'INVALID_SEVERITY',
          `Incident severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}.`
        );
      }
      assertBoundedText(summary, 'summary');
      if (!INCIDENT_STATUSES.includes(status)) {
        throw new ExtensionSdkError(
          'INVALID_STATUS',
          `Incident status must be one of: ${INCIDENT_STATUSES.join(', ')}.`
        );
      }
      let safeExternalUrl;
      if (externalUrl !== undefined) {
        // Outbound incident card links must always be safe public https: URLs
        safeExternalUrl = validateEndpointUrl(externalUrl, { allowLocalhostHttp: false });
      }
      return sendJsonPost(
        `/api/v1/extensions/channels/${encodeURIComponent(channelId)}/incidents`,
        {
          channelId,
          title: title.trim(),
          severity,
          summary,
          ...(safeExternalUrl ? { externalUrl: safeExternalUrl } : {}),
          status,
        },
        idempotencyKey
      );
    },
  });
}

/**
 * Creates a deterministic in-memory test harness for testing webhook extensions
 * end-to-end with signed deliveries, replay simulation, clock injection, and
 * recorded outbound client calls in zero network milliseconds.
 *
 * @param {{
 *   secret?: string,
 *   handler: (req: {
 *     secret: string,
 *     rawBody: string,
 *     headers: Record<string, string>,
 *     nowUnixSeconds: number,
 *     nowSeconds: number,
 *     client: ReturnType<typeof createExtensionClient>,
 *   }) => Promise<unknown> | unknown,
 *   nowSeconds?: number,
 *   nowUnixSeconds?: number,
 *   baseUrl?: string,
 *   token?: string,
 * }} options
 */
export function createExtensionTestHarness(options) {
  if (!options || typeof options.handler !== 'function') {
    throw new ExtensionSdkError('INVALID_HARNESS_OPTIONS', 'Test harness requires a handler function.');
  }

  const secret = options.secret ?? 'whsec_test_harness_0123456789abcdef';
  const baseUrl = options.baseUrl ?? 'https://api.kodera.io';
  const token = options.token ?? 'kdr_ext_test_token_0123456789abcdef';
  let currentNow = options.nowUnixSeconds ?? options.nowSeconds ?? 1_762_520_000;
  let seq = 0;

  /**
   * @type {Array<{
   *   id: string,
   *   method: string,
   *   url: string,
   *   path: string,
   *   headers: Record<string, string>,
   *   body: Record<string, unknown>,
   *   idempotencyKey: string,
   *   timestamp: number,
   * }>}
   */
  const recordedCalls = [];

  /** @type {typeof globalThis.fetch} */
  const mockFetch = async (input, init) => {
    seq += 1;
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(urlStr);
    const rawHeaders = /** @type {Record<string, string>} */ (init?.headers ?? {});
    const normalizedHeaders = /** @type {Record<string, string>} */ ({});
    for (const [k, v] of Object.entries(rawHeaders)) {
      normalizedHeaders[k.toLowerCase()] = String(v);
    }
    const parsedBody =
      typeof init?.body === 'string' ? /** @type {Record<string, unknown>} */ (JSON.parse(init.body)) : {};
    const id = `msg_test_${seq}`;

    recordedCalls.push({
      id,
      method: init?.method ?? 'POST',
      url: urlStr,
      path: parsedUrl.pathname,
      headers: normalizedHeaders,
      body: parsedBody,
      idempotencyKey: normalizedHeaders['idempotency-key'] ?? '',
      timestamp: currentNow,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        id,
        threadRootId: parsedBody.threadRootId ?? id,
        createdAt: currentNow,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  };

  const client = createExtensionClient({
    baseUrl,
    token,
    fetchImpl: mockFetch,
  });

  /**
   * Sends a signed webhook delivery into the extension handler under test.
   *
   * @param {{
   *   event?: string,
   *   payload: Record<string, unknown>,
   *   deliveryId?: string,
   *   timestampSeconds?: number,
   *   secretOverride?: string,
   *   rawBodyOverride?: string,
   *   headersOverride?: Record<string, string>,
   * }} delivery
   */
  async function sendWebhook(delivery) {
    seq += 1;
    const deliveryId = delivery.deliveryId ?? `deliv_${seq}`;
    const eventName =
      delivery.event ??
      (typeof delivery.payload?.type === 'string' ? delivery.payload.type : undefined) ??
      (typeof delivery.payload?.event === 'string' ? delivery.payload.event : undefined) ??
      'webhook.event';
    // Producers bind event routing to the authenticated body, never only a header.
    const payload = delivery.payload?.type === undefined && delivery.payload?.event === undefined
      ? { ...delivery.payload, type: eventName } : delivery.payload;
    const rawBody = delivery.rawBodyOverride ?? JSON.stringify(payload);
    const ts = delivery.timestampSeconds ?? currentNow;
    const sig = signWebhookPayload(delivery.secretOverride ?? secret, ts, rawBody);

    /** @type {Record<string, string>} */
    const headers = {
      [SIGNATURE_HEADER]: sig,
      [TIMESTAMP_HEADER]: String(ts),
      [EVENT_HEADER]: eventName,
      [DELIVERY_ID_HEADER]: deliveryId,
      ...(delivery.headersOverride ?? {}),
    };

    const response = await options.handler({
      secret,
      rawBody,
      headers,
      nowUnixSeconds: currentNow,
      nowSeconds: currentNow,
      client,
    });

    return {
      deliveryId,
      timestamp: ts,
      signature: sig,
      headers,
      rawBody,
      response,
    };
  }

  return Object.freeze({
    client,
    recordedCalls,
    calls: recordedCalls,
    outbox: recordedCalls,
    getNow() {
      return currentNow;
    },
    /** @param {number} seconds */
    advanceTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new ExtensionSdkError('INVALID_TIME_ADVANCE', 'advanceTime requires a non-negative number of seconds.');
      }
      currentNow += seconds;
      return currentNow;
    },
    /** @param {number} unixSeconds */
    setTime(unixSeconds) {
      if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
        throw new ExtensionSdkError('INVALID_TIMESTAMP', 'setTime requires a non-negative integer timestamp.');
      }
      currentNow = unixSeconds;
      return currentNow;
    },
    clearRecordedCalls() {
      recordedCalls.length = 0;
    },
    sendWebhook,
    deliver: sendWebhook,
  });
}

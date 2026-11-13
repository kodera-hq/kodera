/** Additive rotation verification; the legacy primary transcript and verifier stay unchanged. */
import { verifyWebhookRequest, WebhookVerificationError } from './index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRACE = 86400;
/** @param {string} code @returns {never} */
const fail = code => { throw new WebhookVerificationError(code, 'Rotating webhook binding refused.'); };

/**
 * @typedef {{generation: string, secret?: string}} CurrentKey
 * @typedef {{generation: string, secret: string, expiresAt: number}} PreviousKey
 * @typedef {{rawBody: string | Uint8Array, signatureHeader?: string, previousSignatureHeader?: string,
 * timestampHeader?: string, eventHeader?: string, deliveryIdHeader?: string,
 * organisationId: string, installationId: string, current: CurrentKey, previous?: PreviousKey,
 * nowUnixSeconds?: number, maxSkewSeconds?: number}} RotationOptions
 */
/**
 * Verify trusted installation/generation configuration and the exact raw-body signature.
 * current.secret may be absent while a receiver installs the next key during bounded grace.
 * Previous-key expiry is trusted receiver configuration, never inferred from incoming headers.
 * @param {RotationOptions} options
 * @returns {Record<string, any>}
 */
export function verifyRotatingWebhookRequest(options) {
  const { rawBody, signatureHeader, previousSignatureHeader, timestampHeader,
    eventHeader, deliveryIdHeader, organisationId, installationId,
    current, previous, nowUnixSeconds = Math.floor(Date.now() / 1000), maxSkewSeconds = 300 } = options;
  if (!UUID.test(organisationId) || !UUID.test(installationId) || !current || !UUID.test(current.generation)
    || !Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds < 0) fail('ROTATION_CONFIGURATION');
  if ((typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array))
    || !/^v1=[a-f0-9]{64}$/.test(signatureHeader ?? '')
    || (previousSignatureHeader !== undefined && !/^v1=[a-f0-9]{64}$/.test(previousSignatureHeader))) fail('ROTATION_SIGNATURE');
  const bytes = Buffer.from(rawBody);
  if (bytes.length > 128 * 1024 || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('ROTATION_BODY');
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { fail('ROTATION_BODY'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || body.schema !== 'kodera.extension.delivery.v2' || body.organisation_id !== organisationId
    || body.installation_id !== installationId || body.key_generation !== current.generation
    || !UUID.test(body.delivery_id) || body.delivery_id !== deliveryIdHeader || body.type !== eventHeader
    || typeof body.type !== 'string' || !/^[a-f0-9]{64}$/.test(body.event_sha256)) fail('ROTATION_SCOPE');
  const hasPrevious = Object.hasOwn(body, 'previous_key_generation') || Object.hasOwn(body, 'grace_expires_at');
  if (hasPrevious && (!previous || !UUID.test(previous.generation) || previous.generation === current.generation
    || body.previous_key_generation !== previous.generation || body.grace_expires_at !== previous.expiresAt
    || !Number.isSafeInteger(previous.expiresAt) || nowUnixSeconds >= previous.expiresAt
    || previous.expiresAt - nowUnixSeconds > GRACE)) fail('ROTATION_GRACE');
  /** @param {string | undefined} secret @param {string | undefined} signature */
  const verify = (secret, signature) => {
    if (typeof secret !== 'string' || typeof signature !== 'string') return false;
    try {
      verifyWebhookRequest({ secret, rawBody, signatureHeader: signature, timestampHeader, nowUnixSeconds, maxSkewSeconds });
      return true;
    } catch { return false; }
  };
  if (verify(current.secret, signatureHeader)) return body;
  if (hasPrevious && previous && verify(previous.secret, previousSignatureHeader)) return body;
  fail('ROTATION_SIGNATURE');
}

/** Bounded per-installation replay guard. Persist delivery ids at the receiver for durable effects.
 * @param {Omit<RotationOptions, 'rawBody'>} configuration
 */
export function createRotatingWebhookVerifier(configuration) {
  /** @type {Map<string, {until: number}>} */
  const seen = new Map();
  /** @param {Partial<RotationOptions> & Pick<RotationOptions, 'rawBody'>} options */
  return options => {
    const merged = { ...options, ...configuration };
    const body = verifyRotatingWebhookRequest(merged);
    const now = merged.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
    const skew = merged.maxSkewSeconds ?? 300;
    for (const [id, entry] of seen) if (entry.until < now) seen.delete(id);
    const key = `${body.organisation_id}:${body.installation_id}:${body.delivery_id}`;
    if (seen.has(key)) fail('ROTATION_REPLAY');
    if (seen.size >= 4096) fail('ROTATION_REPLAY_CAPACITY');
    seen.set(key, { until: Number(merged.timestampHeader) + skew });
    return body;
  };
}

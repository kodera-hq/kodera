/** Opaque first-frame tickets; their application key never enters a URL. */
import { createHmac, timingSafeEqual } from 'node:crypto'

export class TicketRefused extends Error {
  constructor(code = 4401) { super('collaboration ticket refused'); this.code = code }
}
const fields = ['v', 'organisation', 'document', 'membership', 'identity', 'issuer', 'subject', 'role', 'issued', 'expires', 'nonce'].sort()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
function decoded(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new TicketRefused()
  const value = Buffer.from(text, 'base64url')
  if (value.toString('base64url') !== text) throw new TicketRefused()
  return value
}
export function verify(token, key, now = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof token !== 'string' || token.length > 4096) throw new TicketRefused()
  const parts = token.split('.')
  if (parts.length !== 2) throw new TicketRefused()
  const expected = createHmac('sha256', key).update(parts[0]).digest()
  const signature = decoded(parts[1])
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new TicketRefused()
  let claims
  try { claims = JSON.parse(decoded(parts[0]).toString('utf8')) } catch { throw new TicketRefused() }
  if (!claims || Array.isArray(claims) || Object.keys(claims).sort().join() !== fields.join() || claims.v !== 1 ||
      !Number.isSafeInteger(claims.issued) || !Number.isSafeInteger(claims.expires) ||
      claims.expires <= now || claims.issued > now + 5 || claims.expires <= claims.issued || claims.expires - claims.issued > 300 ||
      !['editor', 'viewer'].includes(claims.role) ||
      !['organisation', 'document', 'membership', 'identity', 'nonce'].every(name => typeof claims[name] === 'string' && uuid.test(claims[name])) ||
      !['issuer', 'subject'].every(name => typeof claims[name] === 'string' && claims[name].length > 0 && claims[name].length <= 2048 && !/[\u0000-\u0020\u007f]/.test(claims[name])) ||
      claims.subject.length > 255 || !/^[\x21-\x7e]+$/.test(claims.subject)) throw new TicketRefused()
  return Object.freeze(claims)
}
export function bind(claims, { organisation, document, role }) {
  if (claims.organisation !== organisation || claims.document !== document || claims.role !== role) throw new TicketRefused(4403)
}

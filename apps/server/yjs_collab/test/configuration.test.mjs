import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { configuration } from '../configuration.mjs'
function settings() {
  return {DATABASE_URL: 'postgresql://unit:' + randomBytes(24).toString('base64url') + '@db:5432/core', KODERA_COLLAB_TICKET_KEY: randomBytes(32).toString('base64url'), KODERA_COLLAB_ALLOWED_ORIGINS: 'https://community.example.org'}
}
test('native service requires explicit application settings and exact HTTPS origins', () => {
  assert.equal(configuration(settings()).port, 8098)
  for (const patch of [
    {KODERA_COLLAB_TICKET_KEY: ''}, {KODERA_COLLAB_TICKET_KEY: randomBytes(16).toString('base64url')},
    {KODERA_COLLAB_ALLOWED_ORIGINS: 'https://*.example.org'}, {KODERA_COLLAB_ALLOWED_ORIGINS: 'https://community.example.org/'},
    {KODERA_COLLAB_ALLOWED_ORIGINS: 'http://community.example.org'}, {KODERA_COLLAB_PORT: '0'},
    {DATABASE_URL: 'https://example.org'}, {SCW_SECRET_KEY: randomBytes(32).toString('hex')},
  ]) assert.throws(() => configuration({...settings(), ...patch}), /collaboration configuration refused/)
})

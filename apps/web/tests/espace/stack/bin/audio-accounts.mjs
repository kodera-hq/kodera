#!/usr/bin/env node
// The two Matrix accounts audio rooms need (DESIGN §2.1, Core room_access/README.md), on the
// running stack: the tenant agent's administrator, which creates rooms and writes their policy,
// and room-access's own account (@kodera-rooms, as Core and Fleet name it), whose token the
// service runs with. Writes both tokens into .runtime/config. Run by bin/up.sh when CORE_SRC is set; safe to
// run again.

import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'config')
const text = readFileSync(envPath, 'utf8')
const env = Object.fromEntries(
  text
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const base = `http://127.0.0.1:${env.SYNAPSE_PORT}`

async function call(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

/** Registers the account through the shared secret, or finds it already there. */
async function ensure(localpart, password, admin) {
  const { json: nonce } = await call('/_synapse/admin/v1/register')
  const mac = createHmac('sha1', env.SYNAPSE_REGISTRATION_SECRET)
    .update(`${nonce.nonce}\0${localpart}\0${password}\0${admin ? 'admin' : 'notadmin'}`)
    .digest('hex')
  const { status, json } = await call('/_synapse/admin/v1/register', {
    method: 'POST',
    body: { nonce: nonce.nonce, username: localpart, password, admin, mac },
  })
  if (status !== 200 && json?.errcode !== 'M_USER_IN_USE') {
    throw new Error(`registering ${localpart}: ${status} ${JSON.stringify(json)}`)
  }
  return `@${localpart}:kodera.test`
}

const agentId = await ensure('kodera-agent', env.AGENT_PASSWORD, true)
const agentLogin = await call('/_matrix/client/v3/login', {
  method: 'POST',
  body: {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: agentId },
    password: env.AGENT_PASSWORD,
    refresh_token: false,
  },
})
if (agentLogin.status !== 200) throw new Error(`agent sign-in: ${agentLogin.status}`)
// A service account's token must not expire under it: Synapse's admin login issues one that
// does not, where a password login here expires within the hour.
const serviceToken = async (userId) => {
  const { status, json } = await call(
    `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/login`,
    { token: agentLogin.json.access_token, method: 'POST', body: {} }
  )
  if (status !== 200) throw new Error(`admin login for ${userId}: ${status}`)
  return json.access_token
}
// The agent creates every channel's room and joins every member: Synapse's per-user limits
// (room creation allows a burst of about ten) would refuse an organisation's channels part way.
// Lifted for the agent alone, as a tenant's bootstrap must (Fleet synapse profile, SA-01).
const lifted = await call(
  `/_synapse/admin/v1/users/${encodeURIComponent(agentId)}/override_ratelimit`,
  {
    token: agentLogin.json.access_token,
    method: 'POST',
    body: { messages_per_second: 0, burst_count: 0 },
  }
)
if (lifted.status !== 200) throw new Error(`lifting the agent's rate limits: ${lifted.status}`)
const roomAccessId = await ensure('kodera-rooms', env.AGENT_PASSWORD, false)
// Synapse refuses an administrator's admin login as itself: the agent's token is its own sign-in,
// which expires within the hour; run this again for a longer session.
const tokens = {
  AGENT_MATRIX_TOKEN: agentLogin.json.access_token,
  ROOM_ACCESS_MATRIX_TOKEN: await serviceToken(roomAccessId),
}

let next = text
for (const [name, value] of Object.entries(tokens)) {
  const line = `${name}=${value}`
  next = new RegExp(`^${name}=.*$`, 'm').test(next)
    ? next.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${next.replace(/\n?$/, '\n')}${line}\n`
}
writeFileSync(envPath, next)
console.log(`audio accounts ready: ${agentId}, ${roomAccessId}`)

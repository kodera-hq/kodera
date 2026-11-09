#!/usr/bin/env node
// Proves the stack behaves as the pilot needs before any Espace test relies on it
// (docs/dev/ESPACE_STACK.md). Each check names the design rule it stands for; every check runs,
// and the script exits non-zero if any failed. Run it after bin/up.sh: `node tests/espace/stack/smoke.mjs`.

import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(here, '.runtime', 'config'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const base = `http://127.0.0.1:${env.SYNAPSE_PORT}`

let failed = false
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed = true
}

async function call(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

/** A user, through the shared-secret admin registration (open registration is off). */
async function register(localpart) {
  const password = randomBytes(12).toString('hex')
  const { json: nonce } = await call('/_synapse/admin/v1/register')
  const mac = createHmac('sha1', env.SYNAPSE_REGISTRATION_SECRET)
    .update(`${nonce.nonce}\0${localpart}\0${password}\0notadmin`)
    .digest('hex')
  const { status, json } = await call('/_synapse/admin/v1/register', {
    method: 'POST',
    body: { nonce: nonce.nonce, username: localpart, password, admin: false, mac },
  })
  if (status !== 200) throw new Error(`registering ${localpart}: ${status} ${JSON.stringify(json)}`)
  return { userId: json.user_id, password }
}

async function login(user, refreshToken = true) {
  return call('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: user.userId },
      password: user.password,
      ...(refreshToken ? { refresh_token: true } : {}),
    },
  })
}

const run = randomBytes(3).toString('hex')
const alice = await register(`alice-${run}`)
const bob = await register(`bob-${run}`)

// DESIGN §2.4: access tokens expire and are refreshed.
const aliceLogin = await login(alice)
check(
  'login issues a refreshable, expiring access token',
  aliceLogin.status === 200 &&
    typeof aliceLogin.json.refresh_token === 'string' &&
    typeof aliceLogin.json.expires_in_ms === 'number' &&
    aliceLogin.json.expires_in_ms <= 5 * 60 * 1000,
  `expires_in_ms=${aliceLogin.json?.expires_in_ms}`
)
const refreshed = await call('/_matrix/client/v3/refresh', {
  method: 'POST',
  body: { refresh_token: aliceLogin.json.refresh_token },
})
check(
  'a refresh token buys a new access token',
  refreshed.status === 200 && refreshed.json.access_token !== aliceLogin.json.access_token
)
const aliceToken = refreshed.json.access_token
const bobToken = (await login(bob)).json.access_token

// DESIGN §2.4, enforced by the homeserver: a client that asks for no refresh token still gets
// a token that expires.
const plainLogin = await login(bob, false)
check(
  'a login without a refresh token still gets an expiring access token',
  plainLogin.status === 200 &&
    plainLogin.json.refresh_token === undefined &&
    typeof plainLogin.json.expires_in_ms === 'number' &&
    plainLogin.json.expires_in_ms <= 60 * 60 * 1000,
  `expires_in_ms=${plainLogin.json?.expires_in_ms}`
)

// DESIGN §2.4: members sign in through the organisation's Keycloak realm, and only there.
const flows = await call('/_matrix/client/v3/login')
const sso = flows.json?.flows?.find((flow) => flow.type === 'm.login.sso')
check(
  'sign-in is offered through one identity provider',
  sso?.identity_providers?.length === 1,
  JSON.stringify(sso?.identity_providers ?? null)
)
const redirect = await fetch(
  `${base}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(`${env.CONSOLE_ORIGIN}/espace/callback`)}`,
  { redirect: 'manual' }
)
const authorize = new URL(redirect.headers.get('location') ?? 'about:blank')
const realm = `http://127.0.0.1:${env.KEYCLOAK_PORT}/realms/acme-sa`
check(
  "the SSO redirect goes to the realm's authorization endpoint, with PKCE",
  redirect.status === 302 &&
    `${authorize.origin}${authorize.pathname}` === `${realm}/protocol/openid-connect/auth` &&
    authorize.searchParams.get('client_id') === 'synapse' &&
    authorize.searchParams.get('code_challenge_method') === 'S256',
  `status ${redirect.status} ${authorize.origin}${authorize.pathname}`
)

// Profiles are read by members only.
const profile = await call(`/_matrix/client/v3/profile/${encodeURIComponent(alice.userId)}`)
check(
  'a profile is not readable without signing in',
  profile.status === 401 && profile.json?.errcode === 'M_MISSING_TOKEN',
  `status ${profile.status} ${profile.json?.errcode}`
)

// The media server answers, so a later audio-room test fails on the room, not on the stack.
const livekit = await fetch(`http://127.0.0.1:${env.LIVEKIT_PORT}/`).catch(() => undefined)
check('LiveKit answers', livekit?.status === 200, `status ${livekit?.status}`)

// DESIGN §2.6b: no federation listener.
const federation = await call('/_matrix/federation/v1/version')
const keys = await call('/_matrix/key/v2/server')
check(
  'no federation or server-key endpoint is served',
  [federation, keys].every(
    (answer) => answer.status === 404 && answer.json?.errcode === 'M_UNRECOGNIZED'
  ),
  `federation ${federation.status} ${federation.json?.errcode}, keys ${keys.status} ${keys.json?.errcode}`
)

// DESIGN §2.5: rooms are created without end-to-end encryption.
const room = await call('/_matrix/client/v3/createRoom', {
  token: aliceToken,
  method: 'POST',
  body: { name: `smoke ${run}`, preset: 'private_chat', invite: [bob.userId] },
})
const roomId = room.json.room_id
const encryptionOf = (id) =>
  call(`/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.encryption/`, {
    token: aliceToken,
  })
const encryption = await encryptionOf(roomId)
// A positive control: the same read finds encryption where it was asked for, so a 404 above
// means "no encryption", not a wrong path.
const encrypted = await call('/_matrix/client/v3/createRoom', {
  token: aliceToken,
  method: 'POST',
  body: {
    preset: 'private_chat',
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
  },
})
const control = await encryptionOf(encrypted.json.room_id)
check(
  'a new room is not end-to-end encrypted',
  encryption.status === 404 && encryption.json?.errcode === 'M_NOT_FOUND' && control.status === 200,
  `status ${encryption.status} ${encryption.json?.errcode}, control ${control.status}`
)

// A message reaches the other member through /sync, which the Console's client runs.
await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
  token: bobToken,
  method: 'POST',
  body: {},
})
await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${run}`, {
  token: aliceToken,
  method: 'PUT',
  body: { msgtype: 'm.text', body: `hello ${run}` },
})
const sync = await call('/_matrix/client/v3/sync?timeout=0', { token: bobToken })
const timeline = sync.json?.rooms?.join?.[roomId]?.timeline?.events ?? []
check(
  "a message reaches the other member's /sync",
  timeline.some((event) => event.content?.body === `hello ${run}`)
)

// Ruling 3: media only through the authenticated endpoints.
const upload = await fetch(`${base}/_matrix/media/v3/upload?filename=smoke.txt`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'text/plain' },
  body: `media ${run}`,
}).then((response) => response.json())
const mediaPath = upload.content_uri.replace('mxc://', '')
const unauthenticated = await call(`/_matrix/media/v3/download/${mediaPath}`)
const authenticated = await call(`/_matrix/client/v1/media/download/${mediaPath}`, {
  token: bobToken,
})
check(
  'media is served only through the authenticated endpoint',
  unauthenticated.status === 404 && authenticated.status === 200,
  `unauthenticated ${unauthenticated.status}, authenticated ${authenticated.status}`
)

// DESIGN §2.1 item 4, Core ADR-0018 "History after removal": a member who leaves, is removed or
// is banned cannot page back through the history. Synapse forgets the room a few milliseconds
// after the departure, in the background, so each case polls for the 403 within a deadline and
// checks that nothing posted after the departure reaches them on the way (docs/dev/ESPACE_STACK.md,
// "The consistency window").
const FORGET_DEADLINE_MS = 2000
const departures = {
  left: (id) =>
    call(`/_matrix/client/v3/rooms/${encodeURIComponent(id)}/leave`, {
      token: bobToken,
      method: 'POST',
      body: {},
    }),
  'was removed': (id) =>
    call(`/_matrix/client/v3/rooms/${encodeURIComponent(id)}/kick`, {
      token: aliceToken,
      method: 'POST',
      body: { user_id: bob.userId, reason: 'access changed in Kodera' },
    }),
  'was banned': (id) =>
    call(`/_matrix/client/v3/rooms/${encodeURIComponent(id)}/ban`, {
      token: aliceToken,
      method: 'POST',
      body: { user_id: bob.userId },
    }),
}
for (const [departure, depart] of Object.entries(departures)) {
  const tag = `${departure.replace(' ', '-')}-${run}`
  const { json: created } = await call('/_matrix/client/v3/createRoom', {
    token: aliceToken,
    method: 'POST',
    body: { name: `history ${tag}`, preset: 'private_chat', invite: [bob.userId] },
  })
  const id = encodeURIComponent(created.room_id)
  const joined = await call(`/_matrix/client/v3/rooms/${id}/join`, {
    token: bobToken,
    method: 'POST',
    body: {},
  })
  const before = await call(`/_matrix/client/v3/rooms/${id}/send/m.room.message/before-${tag}`, {
    token: aliceToken,
    method: 'PUT',
    body: { msgtype: 'm.text', body: `before ${tag}` },
  })
  const departed = await depart(created.room_id)
  const start = performance.now()
  const after = await call(`/_matrix/client/v3/rooms/${id}/send/m.room.message/after-${tag}`, {
    token: aliceToken,
    method: 'PUT',
    body: { msgtype: 'm.text', body: `after ${tag}` },
  })
  const afterId = after.json?.event_id
  const setUp =
    joined.status === 200 &&
    before.status === 200 &&
    departed.status === 200 &&
    typeof afterId === 'string'
  let history
  let reads = 0
  // Answers of 200 that held the earlier message: a positive control, so "nothing after it" is
  // read from a real history, not from an empty or misparsed answer.
  let clamped = 0
  const seen = []
  for (;;) {
    history = await call(`/_matrix/client/v3/rooms/${id}/messages?dir=b&limit=50`, {
      token: bobToken,
    })
    reads += 1
    if (setUp) {
      for (const path of [`event/${afterId}`, `context/${afterId}?limit=0`]) {
        const read = await call(`/_matrix/client/v3/rooms/${id}/${path}`, { token: bobToken })
        if (read.status === 200) seen.push(`/${path.split('/')[0]}`)
      }
    }
    const bodies = (history.json?.chunk ?? []).map((e) => e.content?.body)
    if (bodies.includes(`after ${tag}`)) seen.push('the history')
    if (history.status === 200 && !bodies.includes(`before ${tag}`)) {
      seen.push('a history without the earlier message')
    }
    if (history.status === 200 && bodies.includes(`before ${tag}`)) clamped += 1
    if (history.status === 403 || performance.now() - start > FORGET_DEADLINE_MS) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const elapsed = Math.round(performance.now() - start)
  check(
    `a member who ${departure} cannot read the history`,
    setUp && history.status === 403,
    !setUp
      ? `set-up failed: join ${joined.status}, before ${before.status}, departure ${departed.status}, after ${after.status}`
      : history.status === 403
        ? `403 after ${elapsed} ms, ${reads} reads`
        : `status ${history.status} at the ${FORGET_DEADLINE_MS} ms deadline`
  )
  check(
    `nothing posted after a member ${departure} reaches them`,
    setUp && seen.length === 0,
    seen.length === 0
      ? `${clamped} answers of 200 held only what came before`
      : `seen through ${[...new Set(seen)].join(' and ')}`
  )
}

// Leaving the organisation deactivates the account (Core ADR-0018; the tenant agent's member
// set). That is synchronous: the member's tokens are dead when the admin call returns, so no
// window opens at all, and they cannot sign in again. smoke.selftest.sh proves each clause on its
// own: an account left active, a refresh with another member's live refresh token, and a sign-in
// as another active member each fail this check.
const adminPassword = randomBytes(12).toString('hex')
const { json: adminNonce } = await call('/_synapse/admin/v1/register')
const admin = await call('/_synapse/admin/v1/register', {
  method: 'POST',
  body: {
    nonce: adminNonce.nonce,
    username: `admin-${run}`,
    password: adminPassword,
    admin: true,
    mac: createHmac('sha1', env.SYNAPSE_REGISTRATION_SECRET)
      .update(`${adminNonce.nonce}\0admin-${run}\0${adminPassword}\0admin`)
      .digest('hex'),
  },
})
const carol = await register(`carol-${run}`)
const carolLogin = (await login(carol)).json
const carolInvited = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
  token: aliceToken,
  method: 'POST',
  body: { user_id: carol.userId },
})
const carolJoined = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
  token: carolLogin.access_token,
  method: 'POST',
  body: {},
})
// The tenant agent's own call (tenant_agent/synapse.py).
const deactivated = await call(`/_synapse/admin/v2/users/${encodeURIComponent(carol.userId)}`, {
  token: admin.json?.access_token,
  method: 'PUT',
  body: { deactivated: true },
})
const carolHistory = await call(
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=10`,
  { token: carolLogin.access_token }
)
const carolRefresh = await call('/_matrix/client/v3/refresh', {
  method: 'POST',
  body: { refresh_token: carolLogin.refresh_token },
})
const carolAgain = await login(carol)
check(
  'a member who leaves the organisation loses their tokens at once and cannot sign in',
  carolInvited.status === 200 &&
    carolJoined.status === 200 &&
    deactivated.status === 200 &&
    carolHistory.status === 401 &&
    carolHistory.json?.errcode === 'M_UNKNOWN_TOKEN' &&
    carolRefresh.status === 401 &&
    // Synapse 1.163 clears a deactivated account's password, and refuses its password sign-in
    // as it refuses a wrong password: M_FORBIDDEN, measured. One code, as closure.mjs pins it,
    // so an upgrade that answers otherwise is seen. The code alone does not say why; the 200 an
    // active member gets does (smoke.selftest.sh signs another member in to prove it).
    carolAgain.status === 403 &&
    carolAgain.json?.errcode === 'M_FORBIDDEN',
  `joined ${carolJoined.status}, deactivate ${deactivated.status}, history ${carolHistory.status} ${carolHistory.json?.errcode}, refresh ${carolRefresh.status} ${carolRefresh.json?.errcode}, sign-in ${carolAgain.status} ${carolAgain.json?.errcode}`
)

process.exit(failed ? 1 : 0)

#!/usr/bin/env node
// Removal closure, without a browser (docs/dev/ESPACE_STACK.md, "Audio rooms and removal,
// locally"). Core's real tenant agent (agent.py, from CORE_SRC) makes a text and an audio channel
// for three members, then takes one out of the channels (G2.7) and another out of the
// organisation (G2.5, Synapse's side), and each removal is measured from the agent call's start
// against what the removed member can still do: their membership, their room token from Core's
// room-access behind the edge, their history and their session. Every check runs; the script
// exits 1 if any failed and 2 if the audio profile is not up.
// `node tests/espace/stack/closure.mjs`, after `CORE_SRC=… bash tests/espace/stack/bin/up.sh`.

import { execFile, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// The self-test runs a mutated copy from elsewhere and points it back here.
const here = process.env.ESPACE_STACK_DIR ?? dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(here, '.runtime', 'config'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const base = `http://127.0.0.1:${env.SYNAPSE_PORT}`
const edge = `http://127.0.0.1:${env.EDGE_PORT || 8009}`
const livekitBase = `http://127.0.0.1:${env.LIVEKIT_PORT}`
const SERVER = 'kodera.test'
// room-access's account, as Core and Fleet name it.
const ROOM_ACCESS = `@kodera-rooms:${SERVER}`
// G2.7 and G2.5: a removal is in force everywhere within 5 s; Synapse forgets a left room's
// history within 2 s of the leave (forget_rooms_on_leave). A member reactivated at once is back
// in their rooms within the same 5 s.
const CLOSURE_MS = 5000
const FORGET_MS = 2000

let failed = false
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed = true
}
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : 'never')
const sleep = (wait) => new Promise((resolve) => setTimeout(resolve, wait))

async function request(url, { token, method = 'GET', body, headers = {} } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
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
    return { status: response.status, json, headers: response.headers }
  } catch (error) {
    return { status: 0, json: undefined, error }
  }
}
const call = (path, options) => request(`${base}${path}`, options)
const q = encodeURIComponent

// -- the stack -----------------------------------------------------------------------------------

// Without a Matrix token, room-access answers 401 behind the edge; nginx alone would answer 502.
const probe = await request(`${edge}/_kodera/rooms/token`, { method: 'POST', body: {} })
if (probe.status !== 401) {
  console.error(
    `closure: the audio profile is not up (${edge}/_kodera/rooms/token answered ${probe.status || 'nothing'}).\n` +
      'Start it with: CORE_SRC=<a Core checkout> bash tests/espace/stack/bin/up.sh'
  )
  process.exit(2)
}

// The Core checkout room-access runs from, unless named.
const coreSrc = process.env.CORE_SRC || join(here, '..', '..', '..', '..', 'server')

// Core's tenant agent needs PyJWT, at Core's pin (pyproject.toml) and its wheel's hash (uv.lock).
const PYJWT =
  'PyJWT==2.15.1 --hash=sha256:42d59d631f7768a1028a64c7ff581a9bf7519804daf91fc5b6c56e30eec5e193'
const venv = join(here, '.venv')
const python = join(venv, 'bin', 'python')
const run = randomBytes(4).toString('hex')
const stateDir = join(here, '.agent-state', run)
mkdirSync(stateDir, { recursive: true })
if (!existsSync(python)) execFileSync('python3', ['-m', 'venv', venv])
try {
  execFileSync(python, ['-c', 'import jwt'], { stdio: 'ignore' })
} catch {
  writeFileSync(join(stateDir, 'requirements.txt'), `${PYJWT}\n`)
  execFileSync(python, [
    '-m',
    'pip',
    'install',
    '--quiet',
    '--disable-pip-version-check',
    '--require-hashes',
    '--only-binary=:all:',
    '-r',
    join(stateDir, 'requirements.txt'),
  ])
}

/** A user, through the shared-secret admin registration (open registration is off). */
async function register(localpart, admin = false) {
  const password = randomBytes(12).toString('hex')
  const { json: nonce } = await call('/_synapse/admin/v1/register')
  const mac = createHmac('sha1', env.SYNAPSE_REGISTRATION_SECRET)
    .update(`${nonce.nonce}\0${localpart}\0${password}\0${admin ? 'admin' : 'notadmin'}`)
    .digest('hex')
  const { status, json } = await call('/_synapse/admin/v1/register', {
    method: 'POST',
    body: { nonce: nonce.nonce, username: localpart, password, admin, mac },
  })
  if (status !== 200) throw new Error(`registering ${localpart}: ${status} ${JSON.stringify(json)}`)
  return { subject: localpart, userId: json.user_id, password }
}

const login = (userId, password, refreshToken = true) =>
  call('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      refresh_token: refreshToken,
    },
  })

// The agent's own sign-in, so that its token is fresh whatever the fixture configuration holds.
const agentLogin = await login(`@kodera-agent:${SERVER}`, env.AGENT_PASSWORD, false)
if (agentLogin.status !== 200) throw new Error(`agent sign-in: ${agentLogin.status}`)
const agentToken = agentLogin.json.access_token

const execAgent = promisify(execFile)
/** Core's tenant agent, through agent.py: the handler's outcome as it printed it (agent.py exits
 * 1 on an outcome other than `succeeded`, and still prints it), or the error it died with. */
async function agent(...args) {
  try {
    const { stdout } = await execAgent(python, [join(here, 'agent.py'), ...args], {
      env: {
        ...process.env,
        CORE_SRC: coreSrc,
        AGENT_MATRIX_TOKEN: agentToken,
        AGENT_STATE_DIR: stateDir,
      },
    })
    return JSON.parse(stdout)
  } catch (error) {
    try {
      return JSON.parse(error.stdout)
    } catch {
      // not an outcome: the error below
    }
    return {
      error: String(error.stderr || error.message)
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | '),
    }
  }
}

/** The member's room token, from room-access behind the edge, as the Console asks for it. */
async function roomToken(user, roomId, { native = false } = {}) {
  return request(`${edge}/_kodera/rooms/token`, {
    token: user.token,
    method: 'POST',
    body: { room_id: roomId },
    headers: native ? {} : { Origin: env.CONSOLE_ORIGIN },
  })
}

const membership = async (roomId, userId) =>
  (
    await call(`/_matrix/client/v3/rooms/${q(roomId)}/state/m.room.member/${q(userId)}`, {
      token: agentToken,
    })
  ).json?.membership

const SYNC_FILTER = q(JSON.stringify({ room: { timeline: { limit: 50 } } }))
const sync = (user, since, timeout = 0) =>
  call(
    `/_matrix/client/v3/sync?timeout=${timeout}&filter=${SYNC_FILTER}${since ? `&since=${q(since)}` : ''}`,
    {
      token: user.token,
    }
  )
const bodies = (answer, roomId) =>
  (answer.json?.rooms?.join?.[roomId]?.timeline?.events ?? []).map((event) => event.content?.body)
let sent = 0
const post = (user, roomId, body) =>
  call(`/_matrix/client/v3/rooms/${q(roomId)}/send/m.room.message/${run}-${(sent += 1)}`, {
    token: user.token,
    method: 'PUT',
    body: { msgtype: 'm.text', body },
  })

/** LiveKit's server API, with an admin token signed by the stack's key. */
function livekitToken(video) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: env.LIVEKIT_API_KEY, sub: 'closure', nbf: now - 5, exp: now + 60, video })}`
  return `${unsigned}.${createHmac('sha256', env.LIVEKIT_API_SECRET).update(unsigned).digest('base64url')}`
}
const twirp = (method, body, video) =>
  request(`${livekitBase}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    body,
    token: livekitToken(video),
  })
const claims = (jwt) =>
  JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString() || 'null')
const livekitRoom = (roomId) =>
  `kodera-${createHash('sha256').update(roomId).digest('hex').slice(0, 32)}`

/** Polls each probe on its own until it holds or the deadline passes: name → ms from `started`
 * to the answer that showed it (an upper bound), or undefined. */
async function until(started, deadline, probes) {
  const seen = {}
  await Promise.all(
    Object.entries(probes).map(async ([name, probe]) => {
      while (performance.now() - started < deadline) {
        if (await probe()) {
          seen[name] = performance.now() - started
          return
        }
        await sleep(50)
      }
    })
  )
  return seen
}

// -- three members, two channels -----------------------------------------------------------------

// Keycloak-style subjects; the agent maps each to @{subject}:kodera.test, as Synapse's OIDC
// mapping does.
const [alice, bob, carol, dave, outsider] = await Promise.all(
  [0, 1, 2, 3, 4].map(() => register(randomUUID()))
)
for (const user of [alice, bob, carol, dave, outsider]) {
  const session = await login(user.userId, user.password)
  user.token = session.json.access_token
  user.refresh = session.json.refresh_token
}
const everyone = [alice, bob, carol, dave].map((user) => user.subject)

const members = await agent('members', ...everyone)
check(
  'the member set naming the four members is applied',
  members.status === 'succeeded' && members.artefacts?.users_deactivated === 0,
  members.error ??
    `${[members.status, members.detail].filter(Boolean).join(' ')}, revision ${members.revision}`
)

const textId = randomUUID()
const audioId = randomUUID()
const channel = (id, kind, subjects) => ({
  channel_id: id,
  kind,
  name: kind === 'text' ? 'Général' : 'Salon audio',
  topic: '',
  archived: false,
  read_only: false,
  listen_only: false,
  audience: 'listed',
  members: subjects,
  denied: [],
  exempt: [],
  notices: [],
})
function channelSet(revision, subjects) {
  const path = join(stateDir, `channel-set-${revision}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      revision,
      all_members: everyone,
      channels: [channel(textId, 'text', subjects), channel(audioId, 'audio', subjects)],
    })
  )
  return path
}

const created = await agent('apply', channelSet(1, everyone))
check(
  "the agent makes both channels' rooms",
  created.status === 'succeeded' &&
    created.channels_applied === 2 &&
    created.failed?.length === 0 &&
    created.waiting === 0,
  created.error ??
    `${created.status}, applied ${created.channels_applied}, failed ${JSON.stringify(created.failed)}, waiting ${created.waiting}`
)
const textRoom = created.rooms?.[textId] ?? '!missing'
const audioRoom = created.rooms?.[audioId] ?? '!missing'

// The agent joins room-access to each audio room as it creates it (Core's fix for the first
// tokens of a new room): invited only, room-access refused every token until its next pass. Read
// first, before room-access's own pass (every 2 s) could accept an invite and hide the defect.
const accessMembership = await membership(audioRoom, ROOM_ACCESS)
check(
  'room-access is joined to the new audio room when the agent returns',
  accessMembership === 'join',
  `membership ${accessMembership}`
)

const aliases = await Promise.all(
  [textId, audioId].map((id) =>
    call(`/_matrix/client/v3/directory/room/${q(`#kodera-ch-${id}:${SERVER}`)}`, {
      token: alice.token,
    })
  )
)
check(
  "each channel's room is found under its alias",
  aliases[0].json?.room_id === textRoom && aliases[1].json?.room_id === audioRoom,
  aliases.map((answer) => answer.status).join(', ')
)

// The agent joins members through the admin API; an invite left pending is accepted, as the
// Console would.
let accepted = 0
for (const user of [alice, bob, carol, dave]) {
  const invited = (await sync(user)).json?.rooms?.invite ?? {}
  for (const roomId of [textRoom, audioRoom].filter((id) => id in invited)) {
    await call(`/_matrix/client/v3/rooms/${q(roomId)}/join`, {
      token: user.token,
      method: 'POST',
      body: {},
    })
    accepted += 1
  }
}
const joined = await Promise.all(
  [textRoom, audioRoom].map(async (roomId) =>
    Object.keys(
      (await call(`/_matrix/client/v3/rooms/${q(roomId)}/joined_members`, { token: agentToken }))
        .json?.joined ?? {}
    )
  )
)
check(
  'the four members are joined to both rooms',
  joined.every((users) => [alice, bob, carol, dave].every((user) => users.includes(user.userId))),
  `invites accepted by members: ${accepted}`
)

const policy = (
  await call(`/_matrix/client/v3/rooms/${q(audioRoom)}/state/io.kodera.room.policy/`, {
    token: agentToken,
  })
).json
const levels = (
  await call(`/_matrix/client/v3/rooms/${q(audioRoom)}/state/m.room.power_levels/`, {
    token: agentToken,
  })
).json
check(
  'the audio room carries its policy, and room-access the occupancy level only',
  policy?.kind === 'audio' &&
    policy?.archived === false &&
    levels?.users?.[ROOM_ACCESS] === 10 &&
    levels?.events?.['io.kodera.room.occupancy'] === 10 &&
    levels?.kick > 10,
  `policy ${JSON.stringify(policy)}, room-access ${levels?.users?.[ROOM_ACCESS]}`
)

// -- what each member can do -------------------------------------------------------------------

const before = (await sync(bob)).json?.next_batch
const hello = `hello ${run}`
await post(alice, textRoom, hello)
let received = false
for (let tries = 0; tries < 5 && !received; tries += 1) {
  received = bodies(await sync(bob, before, 1000), textRoom).includes(hello)
}
check("alice's message reaches bob's /sync", received)

const expectedRoom = livekitRoom(audioRoom)
for (const [name, user] of Object.entries({ alice, bob, carol })) {
  const grant = await roomToken(user, audioRoom)
  const video = claims(grant.json?.token)?.video
  check(
    `room-access grants ${name} a token for the audio room's call only`,
    grant.status === 200 &&
      grant.json?.listen_only === false &&
      grant.headers?.get('access-control-allow-origin') === env.CONSOLE_ORIGIN &&
      video?.room === expectedRoom &&
      video?.roomJoin === true &&
      claims(grant.json?.token)?.sub?.startsWith(`${user.userId}|`),
    `status ${grant.status}, room ${video?.room}`
  )
}
const stranger = await roomToken(outsider, audioRoom)
check('an outsider is refused a token (403)', stranger.status === 403, `status ${stranger.status}`)
// Apps I-6: a native LiveKit client sends no Origin, and gets the same grant, with no CORS header.
const nativeGrant = await roomToken(alice, audioRoom, { native: true })
check(
  'a native client, sending no Origin, gets a room token too',
  nativeGrant.status === 200 &&
    typeof nativeGrant.json?.token === 'string' &&
    nativeGrant.json?.listen_only === false &&
    nativeGrant.headers?.get?.('access-control-allow-origin') == null,
  `status ${nativeGrant.status}`
)
const textGrant = await roomToken(alice, textRoom)
check('a text channel has no call (403)', textGrant.status === 403, `status ${textGrant.status}`)

const listed = await twirp('ListRooms', { names: [expectedRoom] }, { roomList: true })
const present = await twirp(
  'ListParticipants',
  { room: expectedRoom },
  { roomAdmin: true, room: expectedRoom }
)
check(
  "LiveKit holds the audio room's call after a grant, named for the Matrix room",
  listed.json?.rooms?.[0]?.metadata === audioRoom && present.status === 200,
  `ListRooms ${listed.status}, ListParticipants ${present.status} (${present.json?.participants?.length ?? '?'} participants)`
)
console.log(
  'NOTE  a participant cannot join a LiveKit call without WebRTC here: the call-level removal ' +
    '(the agent and room-access removing a removed member from a live call) is proven in the browser phase'
)

// -- G2.7: bob is taken out of both channels ----------------------------------------------------

const bobSince = (await sync(bob)).json?.next_batch
const remaining = everyone.filter((subject) => subject !== bob.subject)
const removal = channelSet(2, remaining)
const removalStart = performance.now()
const applying = agent('apply', removal).then((result) => ({
  result,
  at: performance.now() - removalStart,
}))
const removed = await until(removalStart, CLOSURE_MS, {
  textKick: async () => (await membership(textRoom, bob.userId)) === 'leave',
  audioKick: async () => (await membership(audioRoom, bob.userId)) === 'leave',
  token: async () => (await roomToken(bob, audioRoom)).status === 403,
  history: async () =>
    (
      await call(`/_matrix/client/v3/rooms/${q(textRoom)}/messages?dir=b&limit=10`, {
        token: bob.token,
      })
    ).status === 403,
})
const reapplied = await applying
check(
  "channel removal: the agent's application succeeds",
  reapplied.result.status === 'succeeded' &&
    reapplied.result.channels_applied === 2 &&
    reapplied.result.failed?.length === 0,
  reapplied.result.error ??
    `${reapplied.result.status}, returned after ${ms(reapplied.at)}, removed from calls ${reapplied.result.removed_from_calls}`
)
check(
  'channel removal: bob is kicked from both rooms',
  removed.textKick !== undefined && removed.audioKick !== undefined,
  `text ${ms(removed.textKick)}, audio ${ms(removed.audioKick)}`
)
check(
  "channel removal: bob's room token is refused (403)",
  removed.token !== undefined,
  ms(removed.token)
)
check(
  "channel removal: bob cannot read the text channel's history (403) within 2 s of the kick",
  removed.history !== undefined && removed.history - removed.textKick <= FORGET_MS,
  `${ms(removed.history)} (${ms(Math.max(0, removed.history - removed.textKick))} after the kick)`
)
const after = `after ${run}`
await post(alice, textRoom, after)
const carolSince = (await sync(carol)).json?.next_batch
await post(alice, textRoom, `${after} (2)`)
const carolSees = bodies(await sync(carol, carolSince, 2000), textRoom).includes(`${after} (2)`)
const bobSync = await sync(bob, bobSince, 1000)
check(
  'channel removal: nothing alice posts afterwards reaches bob',
  bobSync.status === 200 && !JSON.stringify(bobSync.json).includes(after) && carolSees,
  `bob's /sync ${bobSync.status}, carol received it: ${carolSees}`
)
const carolGrant = await roomToken(carol, audioRoom)
check(
  'channel removal: carol keeps her room token',
  carolGrant.status === 200,
  `status ${carolGrant.status}`
)
const slowest = Math.max(
  ...['textKick', 'audioKick', 'token', 'history'].map((name) => removed[name] ?? Infinity)
)
check('channel removal: closed within 5 s of the application', slowest <= CLOSURE_MS, ms(slowest))

// -- G2.5, Synapse's side: carol is taken out of the organisation ------------------------------

const offboardStart = performance.now()
const deactivating = agent('deactivate', carol.subject).then((result) => ({
  result,
  at: performance.now() - offboardStart,
}))
const gone = await until(offboardStart, CLOSURE_MS, {
  session: async () => {
    const answer = await call('/_matrix/client/v3/account/whoami', { token: carol.token })
    return answer.status === 401 && answer.json?.errcode === 'M_UNKNOWN_TOKEN'
  },
  token: async () => (await roomToken(carol, audioRoom)).status === 401,
})
const offboarded = await deactivating
const account = await call(`/_synapse/admin/v2/users/${q(carol.userId)}`, { token: agentToken })
check(
  'organisation removal: the agent deactivates carol',
  offboarded.result.status === 'succeeded' &&
    offboarded.result.artefacts?.users_deactivated === 1 &&
    account.json?.deactivated === true,
  offboarded.result.error ??
    `${[offboarded.result.status, offboarded.result.detail].filter(Boolean).join(' ')}, returned after ${ms(offboarded.at)}`
)
check(
  "organisation removal: carol's access token is refused (401 M_UNKNOWN_TOKEN)",
  gone.session !== undefined,
  ms(gone.session)
)
const refresh = await call('/_matrix/client/v3/refresh', {
  method: 'POST',
  body: { refresh_token: carol.refresh },
})
check(
  "organisation removal: carol's refresh token is refused",
  refresh.status === 401,
  `status ${refresh.status} ${refresh.json?.errcode}, at ${ms(performance.now() - offboardStart)}`
)
check(
  "organisation removal: carol's room token request is refused (401)",
  gone.token !== undefined,
  ms(gone.token)
)
// Synapse 1.163's deactivation also clears the password, so a password sign-in is refused as a
// wrong password is: 403 M_FORBIDDEN, measured, and pinned as smoke.mjs pins it. One code, not
// either of two: an upgrade that answers otherwise (M_USER_DEACTIVATED, say) fails here and in
// smoke, and the comment is read again. The code proves only that this sign-in fails; the
// deactivation is proven by the account read, asserted here again. Members sign in through the
// realm, whose refusal is the browser phase's.
const again = await login(carol.userId, carol.password)
const reread = await call(`/_synapse/admin/v2/users/${q(carol.userId)}`, { token: agentToken })
check(
  'organisation removal: carol cannot sign in again, her account deactivated',
  again.status === 403 &&
    again.json?.errcode === 'M_FORBIDDEN' &&
    reread.json?.deactivated === true,
  `status ${again.status} ${again.json?.errcode}, deactivated ${reread.json?.deactivated}, at ${ms(performance.now() - offboardStart)}`
)
const parted = await until(offboardStart, CLOSURE_MS, {
  text: async () => (await membership(textRoom, carol.userId)) === 'leave',
  audio: async () => (await membership(audioRoom, carol.userId)) === 'leave',
})
check(
  'organisation removal: carol has left both rooms',
  parted.text !== undefined && parted.audio !== undefined,
  `text ${ms(parted.text)}, audio ${ms(parted.audio)}`
)
const offboardMs = Math.max(
  gone.session ?? Infinity,
  gone.token ?? Infinity,
  parted.text ?? Infinity,
  parted.audio ?? Infinity
)
check(
  'organisation removal: closed within 5 s of the deactivation',
  offboardMs <= CLOSURE_MS,
  ms(offboardMs)
)

// -- Reactivation racing Synapse's background room-leave -----------------------------------------
//
// Synapse parts a deactivated account from its rooms in a background loop
// (users_pending_deactivation), and reactivating it does not take it off that list. dave is taken
// out of the organisation and put back at once, through Core's released path, and the channel
// set is applied again: the parter must not leave him out of his rooms afterwards.

const raceStart = performance.now()
const raceOut = await agent('deactivate', dave.subject)
const outAt = performance.now() - raceStart
const raceBack = await agent('members', ...everyone.filter((subject) => subject !== carol.subject))
const backAt = performance.now() - raceStart
const beforeApply = await Promise.all(
  [textRoom, audioRoom].map((roomId) => membership(roomId, dave.userId))
)
const rejoining = await agent('apply', channelSet(3, [alice.subject, dave.subject]))
const appliedAt = performance.now() - raceStart
check(
  'reactivation: the agent deactivates dave, then reactivates him as released',
  raceOut.status === 'succeeded' &&
    raceOut.artefacts?.users_deactivated === 1 &&
    raceBack.status === 'succeeded' &&
    raceBack.artefacts?.users_reactivated === 1,
  raceBack.error ??
    `deactivate ${raceOut.status} after ${ms(outAt)}, members ${[raceBack.status, raceBack.detail].filter(Boolean).join(' ')} ` +
      `(reactivated ${raceBack.artefacts?.users_reactivated}) after ${ms(backAt)}`
)
check(
  'reactivation: the channel set applied again succeeds',
  rejoining.status === 'succeeded' && rejoining.failed?.length === 0,
  rejoining.error ??
    `${rejoining.status}, after ${ms(appliedAt)}, dave before it: text ${beforeApply[0]}, audio ${beforeApply[1]}`
)
// From the channel set's return to 5 s after the deactivation, every answer must be `join`: the
// parter's leave, if it comes after the agent's join, shows as one answer that is not, however
// briefly it lasts. The last answer is read at or after the 5 s.
const strays = []
let settled
for (;;) {
  const elapsed = performance.now() - raceStart
  settled = await Promise.all(
    [textRoom, audioRoom].map((roomId) => membership(roomId, dave.userId))
  )
  for (const [index, value] of settled.entries()) {
    if (value !== 'join')
      strays.push(`${index === 0 ? 'text' : 'audio'} ${value} at ${ms(elapsed)}`)
  }
  if (elapsed >= CLOSURE_MS) break
  await sleep(50)
}
check(
  'reactivation: 5 s on, dave is joined to both rooms',
  strays.length === 0,
  `text ${settled[0]}, audio ${settled[1]}; after the channel set: ${strays.length === 0 ? 'join only' : strays.slice(0, 4).join(', ')} ` +
    `(before it: text ${beforeApply[0]}, audio ${beforeApply[1]}; it returned after ${ms(appliedAt)})`
)
// Deactivation deleted dave's sessions and cleared his password: a new session, as the realm's
// sign-in would give him, through the admin API's sign-in on his behalf.
const daveBack = await request(`${base}/_synapse/admin/v1/users/${q(dave.userId)}/login`, {
  token: agentToken,
  method: 'POST',
  body: {},
})
dave.token = daveBack.json?.access_token
const daveGrant = await roomToken(dave, audioRoom)
check(
  'reactivation: dave gets a room token again (200)',
  daveBack.status === 200 && daveGrant.status === 200,
  `session ${daveBack.status}, room token ${daveGrant.status}`
)
const welcome = `welcome back ${run}`
await post(alice, textRoom, welcome)
let daveReads = false
let daveHistory
for (let tries = 0; tries < 10 && !daveReads; tries += 1) {
  daveHistory = await call(`/_matrix/client/v3/rooms/${q(textRoom)}/messages?dir=b&limit=10`, {
    token: dave.token,
  })
  daveReads = (daveHistory.json?.chunk ?? []).some((event) => event.content?.body === welcome)
  if (!daveReads) await sleep(100)
}
check(
  'reactivation: dave reads what is posted afterwards',
  daveReads,
  `history ${daveHistory?.status} ${daveHistory?.json?.errcode ?? ''}`.trim()
)

rmSync(stateDir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)

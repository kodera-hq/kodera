/// <reference lib="dom" />
// Two members in one audio room, each in their own browser, against the real stack: Synapse,
// Core's room-access behind the edge, LiveKit, and Core's real tenant agent making the channel
// and later taking a member out of it (G2.7), then a third member out of the organisation
// mid-call (G2.5): the media half closure.mjs cannot prove without WebRTC. docs/dev/ESPACE_STACK.md, "Two browsers in one audio room". Run with
// `npx playwright test -c playwright.espace.config.ts`, after `CORE_SRC=… bash tests/espace/stack/bin/up.sh`.

import { execFile, execFileSync } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { SPEAKING_LEVEL } from '@/features/espace/useMicActivity'
import type { CallSnapshot } from '@/features/espace/audio/call'
import type { AudioStats, Transition } from './harness'

const stack = join(dirname(fileURLToPath(import.meta.url)), '..', 'stack')
const env: Record<string, string> = Object.fromEntries(
  readFileSync(join(stack, '.runtime', 'config'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const SERVER = 'kodera.test'
const synapse = `http://127.0.0.1:${env['SYNAPSE_PORT']}`
/** The homeserver's origin as the Console names it: the edge, which serves room-access too. */
const homeserver = `http://127.0.0.1:${env['EDGE_PORT'] || 8009}`
// G2.7 and G2.5: a member taken out of a channel, or out of the organisation, is out of its call
// within 5 s.
const CLOSURE_MS = 5000
const HEARD_MS = 10_000
const AUDIO_LEVEL = 0.01

// Chromium loops this deterministic mono tone. Its WAV carries no metadata;
// all audio still crosses the real LiveKit peer connection and receiver.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${join(stack, '..', 'audio', 'tone.wav')}`,
    ],
  },
})

interface Member {
  subject: string
  userId: string
  password: string
  token: string
}

async function call(
  path: string,
  { token, method = 'GET', body }: { token?: string; method?: string; body?: unknown } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${synapse}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}
const q = encodeURIComponent

async function login(userId: string, password: string): Promise<string> {
  const { status, json } = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: { type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password },
  })
  if (status !== 200) throw new Error(`signing ${userId} in: ${status}`)
  return json['access_token'] as string
}

/** A member through the shared-secret registration, localpart = subject, as closure.mjs does. */
async function register(): Promise<Member> {
  const subject = randomUUID()
  const password = randomBytes(12).toString('hex')
  const nonce = (await call('/_synapse/admin/v1/register')).json['nonce'] as string
  const mac = createHmac('sha1', env['SYNAPSE_REGISTRATION_SECRET']!)
    .update(`${nonce}\0${subject}\0${password}\0notadmin`)
    .digest('hex')
  const { status, json } = await call('/_synapse/admin/v1/register', {
    method: 'POST',
    body: { nonce, username: subject, password, admin: false, mac },
  })
  if (status !== 200) throw new Error(`registering ${subject}: ${status}`)
  const userId = json['user_id'] as string
  return { subject, userId, password, token: await login(userId, password) }
}

// -- Core's tenant agent, through agent.py (as closure.mjs runs it) ------------------------------

const PYJWT =
  'PyJWT==2.15.1 --hash=sha256:42d59d631f7768a1028a64c7ff581a9bf7519804daf91fc5b6c56e30eec5e193'
const python = join(stack, '.venv', 'bin', 'python')
const stateDir = join(stack, '.agent-state', `audio-${randomBytes(4).toString('hex')}`)

function coreSource(): string {
  if (process.env['CORE_SRC']) return process.env['CORE_SRC']
  return join(stack, '..', '..', '..', '..', 'server')
}

function agentPython(): void {
  mkdirSync(stateDir, { recursive: true })
  if (!existsSync(python)) execFileSync('python3', ['-m', 'venv', join(stack, '.venv')])
  try {
    execFileSync(python, ['-c', 'import jwt'], { stdio: 'ignore' })
  } catch {
    writeFileSync(join(stateDir, 'requirements.txt'), `${PYJWT}\n`)
    execFileSync(python, [
      ...['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--require-hashes'],
      ...['--only-binary=:all:', '-r', join(stateDir, 'requirements.txt')],
    ])
  }
}

const execAgent = promisify(execFile)
/** The handler's outcome as agent.py printed it; it exits 1, and still prints it, on a failure. */
async function agent(agentToken: string, ...args: string[]): Promise<Record<string, unknown>> {
  let stdout: string
  try {
    ;({ stdout } = await execAgent(python, [join(stack, 'agent.py'), ...args], {
      env: {
        ...process.env,
        CORE_SRC: coreSource(),
        AGENT_MATRIX_TOKEN: agentToken,
        AGENT_STATE_DIR: stateDir,
      },
    }))
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? ''
    if (!stdout.trim().startsWith('{')) throw error
  }
  return JSON.parse(stdout) as Record<string, unknown>
}

const channelId = randomUUID()
function channelSet(revision: number, all: Member[], members: Member[]): string {
  const path = join(stateDir, `channel-set-${revision}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      revision,
      all_members: all.map((member) => member.subject),
      channels: [
        {
          channel_id: channelId,
          kind: 'audio',
          name: 'Salon audio',
          topic: '',
          archived: false,
          read_only: false,
          listen_only: false,
          audience: 'listed',
          members: members.map((member) => member.subject),
          denied: [],
          exempt: [],
          notices: [],
        },
      ],
    })
  )
  return path
}

// -- the browsers ----------------------------------------------------------------------------------

/** One member's browser: its own context, the harness page, the member's token handed in. */
async function open(browser: Browser, member: Member): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/tests/espace/audio/harness.html')
  await page.waitForFunction(() => window.espaceHarness !== undefined)
  await page.evaluate((options) => window.espaceHarness.start(options), {
    homeserver,
    accessToken: member.token,
  })
  return [context, page]
}

/** Joins from a click on the page, and resolves with the click's time. */
async function joinFrom(page: Page, roomId: string): Promise<number> {
  await page.evaluate((id) => window.espaceHarness.arm(id), roomId)
  await page.click('#join')
  return page.evaluate(() => window.espaceHarness.joined())
}

const snapshot = (page: Page): Promise<CallSnapshot> =>
  page.evaluate(() => window.espaceHarness.snapshot())
const history = (page: Page): Promise<Transition[]> =>
  page.evaluate(() => window.espaceHarness.history())
const stats = (page: Page): Promise<AudioStats> => page.evaluate(() => window.espaceHarness.stats())
const sleep = (wait: number) => new Promise((resolve) => setTimeout(resolve, wait))

/** The first transition at or after `since` that satisfies `check`, waited for up to `timeout`. */
async function transition(
  page: Page,
  check: (state: Transition) => boolean,
  timeout: number,
  since = 0
): Promise<Transition | undefined> {
  const deadline = Date.now() + timeout
  for (;;) {
    const found = (await history(page)).find((state) => state.at >= since && check(state))
    if (found !== undefined || Date.now() > deadline) return found
    await sleep(25)
  }
}

/** Two samples `gap` apart: what grew in between. */
async function flow(page: Page, gap = 1000) {
  const first = await stats(page)
  await sleep(gap)
  const second = await stats(page)
  const remote = second.remote.map((track) => {
    const before = first.remote.find((earlier) => earlier.trackId === track.trackId)
    return {
      ...track,
      bytes: track.bytesReceived - (before?.bytesReceived ?? 0),
      energy: track.totalAudioEnergy - (before?.totalAudioEnergy ?? 0),
    }
  })
  return { sent: second.bytesSent - first.bytesSent, remote }
}

/** Polls until `page` receives its first audio bytes, then until a 1 s window shows it hearing
 * one remote track and sending its own, or `deadline` passes; with when each happened. */
async function hears(page: Page, deadline: number) {
  let firstBytes: number | undefined
  while (firstBytes === undefined && Date.now() < deadline) {
    if ((await stats(page)).remote.some((track) => track.bytesReceived > 0)) firstBytes = Date.now()
    else await sleep(50)
  }
  let last = await flow(page)
  while (Date.now() < deadline) {
    const [track] = last.remote
    if (last.remote.length === 1 && track!.bytes > 0 && track!.playing && last.sent > 0) break
    last = await flow(page)
  }
  return { ...last, firstBytes, heardAt: Date.now() }
}

/** The same positive receive assertion is used against a muted sender. */
async function audible(page: Page, who: string, timeout = 5000): Promise<void> {
  const initial = await stats(page)
  await expect
    .poll(
      async () => {
        const current = await stats(page)
        return (
          current.remote.length === 1 &&
          current.remote.some((track) => {
            const before = initial.remote.find((sample) => sample.trackId === track.trackId)
            return (
              before !== undefined &&
              track.bytesReceived > before.bytesReceived &&
              track.totalAudioEnergy > before.totalAudioEnergy &&
              track.audioLevel > AUDIO_LEVEL &&
              track.playing
            )
          })
        )
      },
      { message: `${who} receives audible remote audio`, timeout, intervals: [100] }
    )
    .toBe(true)
}

const measured: string[] = []
/** Printed together once the file is done, whatever failed. */
function measure(line: string): void {
  measured.push(line)
}

test.describe.configure({ mode: 'serial' })

let alice: Member
let bob: Member
let carol: Member
let outsider: Member
let agentToken: string
let roomId: string
const contexts: BrowserContext[] = []
let alicePage: Page
let bobPage: Page

/** Accepts the member's pending invite to the room, if the agent left one, as the Console would. */
async function accept(member: Member, room: string): Promise<void> {
  const invited = (await call('/_matrix/client/v3/sync?timeout=0', { token: member.token })).json[
    'rooms'
  ] as { invite?: Record<string, unknown> } | undefined
  if (invited?.invite?.[room] !== undefined) {
    await call(`/_matrix/client/v3/rooms/${q(room)}/join`, {
      token: member.token,
      method: 'POST',
      body: {},
    })
  }
}

test.beforeAll(async ({ browser }) => {
  agentPython()
  agentToken = await login(`@kodera-agent:${SERVER}`, env['AGENT_PASSWORD']!)
  ;[alice, bob, carol, outsider] = await Promise.all([
    register(),
    register(),
    register(),
    register(),
  ])
  const everyone = [alice!, bob!]
  // carol is in the organisation from the start, and joins the channel for the G2.5 test.
  const members = await agent(
    agentToken,
    'members',
    ...[alice!, bob!, carol!].map((member) => member.subject)
  )
  expect(members).toMatchObject({ status: 'succeeded', artefacts: { users_deactivated: 0 } })
  const created = await agent(agentToken, 'apply', channelSet(1, everyone, everyone))
  expect(created).toMatchObject({
    status: 'succeeded',
    channels_applied: 1,
    failed: [],
    // No member left waiting to be joined (Core's tenant agent names them, a set, not a count).
    waiting: [],
  })
  roomId = (created['rooms'] as Record<string, string>)[channelId]!
  // The agent joins members through the admin API; an invite left pending is accepted, as the
  // Console would.
  for (const member of everyone) await accept(member, roomId)
  const joined = (
    await call(`/_matrix/client/v3/rooms/${q(roomId)}/joined_members`, { token: agentToken })
  ).json['joined'] as Record<string, unknown>
  expect(Object.keys(joined)).toEqual(expect.arrayContaining(everyone.map((m) => m.userId)))

  // Vite's dev server optimises livekit-client on the first page that imports it, and reloads
  // that page when it is done: a throwaway page takes that reload, not a member's.
  const warm = await browser.newPage()
  await warm.goto('/tests/espace/audio/harness.html')
  await warm.waitForFunction(() => window.espaceHarness !== undefined)
  await sleep(1500)
  await warm.close()

  for (const member of [alice!, bob!]) {
    const [context, page] = await open(browser, member)
    contexts.push(context)
    if (member === alice) alicePage = page
    else bobPage = page
  }
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  rmSync(stateDir, { recursive: true, force: true })
  console.log(`\n${measured.map((line) => `MEASURED  ${line}`).join('\n')}`)
})

test('alice, alone in the room, sees her own microphone level, and none once muted', async () => {
  const click = await joinFrom(alicePage, roomId)
  const connected = await transition(alicePage, (s) => s.status === 'connected', 10_000, click)
  expect(connected, 'reaches connected').toBeDefined()
  expect((await snapshot(alicePage)).participants).toEqual([alice.userId])
  // Whose ring her own level draws: her Matrix id, read from room-access's LiveKit identity.
  expect((await snapshot(alicePage)).self).toBe(alice.userId)
  // Chromium's fake microphone beeps: the level is read in this browser, with no one to hear it.
  const micLevel = () => alicePage.evaluate(() => window.espaceHarness.micLevel())
  let loudest = 0
  await expect
    .poll(
      async () => {
        loudest = Math.max(loudest, await micLevel())
        return loudest
      },
      { timeout: 5_000, intervals: [50] }
    )
    .toBeGreaterThan(SPEAKING_LEVEL)
  measure(
    `alice alone: loudest microphone level ${loudest.toFixed(3)} (speaking from ${SPEAKING_LEVEL})`
  )

  await alicePage.evaluate(() => window.espaceHarness.mute(true))
  expect(await alicePage.evaluate(() => window.espaceHarness.microphone())).toBe('ended')
  for (let sample = 0; sample < 20; sample += 1) {
    expect(await micLevel(), 'muted, the meter reads nothing').toBe(0)
    await sleep(50)
  }
  await alicePage.evaluate(() => window.espaceHarness.leave())
  expect(await micLevel()).toBe(0)
})

test('both members join the room and see each other', async () => {
  const clicks = await Promise.all([joinFrom(alicePage, roomId), joinFrom(bobPage, roomId)])
  for (const [index, page] of [alicePage, bobPage].entries()) {
    const connected = await transition(
      page,
      (state) => state.status === 'connected',
      10_000,
      clicks[index]
    )
    expect(connected, 'reaches connected').toBeDefined()
    measure(
      `${index === 0 ? 'alice' : 'bob'} click to connected: ${connected!.at - clicks[index]!} ms`
    )
  }
  await expect
    .poll(async () => (await snapshot(alicePage)).participants, { timeout: 10_000 })
    .toEqual(expect.arrayContaining([alice.userId, bob.userId]))
  await expect
    .poll(async () => (await snapshot(bobPage)).participants, { timeout: 10_000 })
    .toEqual(expect.arrayContaining([alice.userId, bob.userId]))
  for (const page of [alicePage, bobPage]) {
    expect(await snapshot(page)).toMatchObject({ status: 'connected', muted: false, roomId })
  }
})

test('they hear each other', async () => {
  const deadline = Date.now() + HEARD_MS
  const pages = [alicePage, bobPage]
  const [connected, results] = await Promise.all([
    Promise.all(
      pages.map(
        async (page) => (await history(page)).find((state) => state.status === 'connected')!.at
      )
    ),
    Promise.all(pages.map((page) => hears(page, deadline))),
  ])
  for (const [index, name] of ['alice', 'bob'].entries()) {
    const heard = results[index]!
    expect(heard.remote, `${name} receives one remote audio track`).toHaveLength(1)
    const [track] = heard.remote
    expect(track!.bytes, `${name}'s remote track: bytes received grow over 1 s`).toBeGreaterThan(0)
    expect(track!.energy, `${name} hears sound, not silence`).toBeGreaterThan(0)
    expect(track!.playing, `${name}'s remote track plays in an <audio> element`).toBe(true)
    expect(heard.sent, `${name}'s microphone: bytes sent grow over 1 s`).toBeGreaterThan(0)
    expect(heard.firstBytes, `${name} receives audio bytes`).toBeDefined()
    measure(
      `${name} connected to first audio bytes ${heard.firstBytes! - connected[index]!} ms, ` +
        `to a 1 s window heard ${heard.heardAt - connected[index]!} ms ` +
        `(${track!.bytes} B/s received, ${heard.sent} B/s sent)`
    )
  }
})

test('automated two-person audio proof: sound, real speaking rings, mute mutation and leave', async () => {
  const startedAt = Date.now()
  // The proof also runs by title in the existing CI job: it must not depend
  // on the preceding serial cases having joined the two members already.
  await Promise.all(
    [alicePage, bobPage].map(async (page) => {
      const state = await snapshot(page)
      if (state.status !== 'connected' || state.roomId !== roomId) await joinFrom(page, roomId)
    })
  )
  for (const page of [alicePage, bobPage]) {
    await expect
      .poll(async () => (await snapshot(page)).participants, { timeout: 5000 })
      .toEqual(expect.arrayContaining([alice.userId, bob.userId]))
  }
  const aliceName = 'Audio Alice'
  const bobName = 'Audio Bob'
  for (const [member, name] of [
    [alice, aliceName],
    [bob, bobName],
  ] as const) {
    const result = await call(`/_matrix/client/v3/profile/${q(member.userId)}/displayname`, {
      token: member.token,
      method: 'PUT',
      body: { displayname: name },
    })
    expect(result.status, 'synthetic member has a stable name for their real face').toBe(200)
  }
  await Promise.all(
    [alicePage, bobPage].map((page) =>
      page.evaluate((id) => window.espaceHarness.showView(id), channelId)
    )
  )
  // Both the occupancy and the ring are the product view's, fed by real
  // Matrix /sync and LiveKit's active-speaker events. No product hook is added.
  const face = (page: Page, name: string) =>
    page
      .getByRole('list', { name: 'Dans Salon audio', exact: true })
      .getByRole('listitem')
      .filter({ has: page.getByText(name, { exact: true }) })
  const ring = (page: Page, name: string) => face(page, name).locator('[data-speaking]')
  try {
    await Promise.all([audible(alicePage, 'alice'), audible(bobPage, 'bob')])
    await expect(
      ring(alicePage, bobName),
      "bob's face rings while alice hears his tone"
    ).toBeVisible()
    await expect(
      ring(bobPage, aliceName),
      "alice's face rings while bob hears her tone"
    ).toBeVisible()
    const shadow = (page: Page, name: string) =>
      face(page, name)
        .locator('[role="img"]')
        .evaluate((element) => getComputedStyle(element).boxShadow)
    const aliceSpeakingShadow = await shadow(bobPage, aliceName)
    expect(aliceSpeakingShadow, "alice's speaking ring has a rendered CSS shadow").not.toBe('none')
    expect(
      await shadow(alicePage, bobName),
      "bob's speaking ring has a rendered CSS shadow"
    ).not.toBe('none')

    await alicePage.evaluate(() => window.espaceHarness.mute(true))
    await expect(
      ring(bobPage, aliceName),
      "alice's speaking ring turns off when she mutes"
    ).toHaveCount(0)
    await expect(face(bobPage, aliceName), 'muting keeps the participant in the room').toBeVisible()
    await expect
      .poll(() => shadow(bobPage, aliceName), { message: "alice's rendered ring changes on mute" })
      .not.toBe(aliceSpeakingShadow)
    // Drain in-flight frames, then prove that the positive receive assertion
    // really refuses silence with its own diagnostic. Bytes alone can grow
    // for comfort noise, so they cannot establish that the other side hears.
    await expect
      .poll(async () => (await flow(bobPage, 250)).remote.every((track) => track.energy === 0), {
        timeout: 5000,
      })
      .toBe(true)
    await expect(audible(bobPage, 'muted-sender mutation', 1200)).rejects.toThrow(
      'muted-sender mutation receives audible remote audio'
    )
    await alicePage.evaluate(() => window.espaceHarness.mute(false))
    await audible(bobPage, 'bob after unmute')
    await expect(ring(bobPage, aliceName)).toBeVisible()

    await bobPage.evaluate(() => window.espaceHarness.leave())
    await expect(
      face(alicePage, bobName),
      "bob's real face disappears after he leaves"
    ).toHaveCount(0)
    await expect
      .poll(async () => (await snapshot(alicePage)).participants, { timeout: 5000 })
      .not.toContain(bob.userId)
  } finally {
    await alicePage.evaluate(() => window.espaceHarness.mute(false))
    // Restore the shared serial suite's two-member call for its existing
    // revocation and device proofs, then stop the two extra Matrix stores.
    if ((await snapshot(bobPage)).status !== 'connected') await joinFrom(bobPage, roomId)
    await Promise.all(
      [alicePage, bobPage].map((page) => page.evaluate(() => window.espaceHarness.hideView()))
    )
  }
  const elapsed = Date.now() - startedAt
  measure(`automated two-person proof added ${elapsed} ms (budget 120000 ms)`)
  expect(elapsed, 'two-person proof stays within the two-minute added job budget').toBeLessThan(
    120_000
  )
})

test('alice mutes, and bob hears her go silent', async () => {
  const before = await flow(bobPage)
  expect(before.remote[0]!.energy).toBeGreaterThan(0)
  const mutedAt = Date.now()
  await alicePage.evaluate(() => window.espaceHarness.mute(true))
  expect(await snapshot(alicePage)).toMatchObject({ status: 'connected', muted: true })
  // Muting stops the microphone's track (LiveKit's stopMicTrackOnMute), which is what turns the
  // browser's recording indicator off; WebRTC then sends nothing, whose energy is zero.
  expect(await alicePage.evaluate(() => window.espaceHarness.microphone())).toBe('ended')
  let after = await flow(bobPage)
  while (after.remote[0]!.energy > 0 && Date.now() - mutedAt < 5000) after = await flow(bobPage)
  expect(after.remote[0]!.energy, "bob hears no sound from alice's track").toBe(0)
  measure(
    `bob hears alice silent within ${Date.now() - mutedAt} ms of the mute ` +
      `(energy ${before.remote[0]!.energy.toFixed(4)} → 0, ${before.remote[0]!.bytes} → ${after.remote[0]!.bytes} B/s)`
  )

  await alicePage.evaluate(() => window.espaceHarness.mute(false))
  expect(await snapshot(alicePage)).toMatchObject({ status: 'connected', muted: false })
  expect(await alicePage.evaluate(() => window.espaceHarness.microphone())).toBe('live')
  const unmutedAt = Date.now()
  let again = await flow(bobPage)
  while (again.remote[0]!.energy === 0 && Date.now() - unmutedAt < 5000) {
    again = await flow(bobPage)
  }
  expect(again.remote[0]!.energy, 'bob hears alice again after she unmutes').toBeGreaterThan(0)
})

test('an outsider is refused', async ({ browser }) => {
  const [context, page] = await open(browser, outsider)
  contexts.push(context)
  await joinFrom(page, roomId)
  expect(await snapshot(page)).toMatchObject({ status: 'failed', problem: 'forbidden', roomId })
  expect((await stats(page)).remote).toHaveLength(0)
})

test('bob, taken out of the channel mid-call, is out of the call within 5 s (G2.7)', async () => {
  const start = Date.now()
  const applying = agent(agentToken, 'apply', channelSet(2, [alice, bob], [alice]))
  const [ended, alone] = await Promise.all([
    transition(bobPage, (state) => state.status === 'ended', CLOSURE_MS + 5000, start),
    transition(
      alicePage,
      (state) => state.status === 'connected' && !state.participants.includes(bob.userId),
      CLOSURE_MS + 5000,
      start
    ),
  ])
  const applied = await applying
  const returned = Date.now() - start
  // The agent removes bob from the call itself, unless room-access's guard was quicker.
  expect(applied).toMatchObject({ status: 'succeeded', channels_applied: 1, failed: [] })
  expect(ended, "bob's call ends").toBeDefined()
  expect(ended!.problem, 'as a removal').toBe('removed')
  expect(alone, "alice's participants no longer list bob").toBeDefined()
  measure(
    `removal: apply start to bob ended ${ended!.at - start} ms, to alice's roster without bob ` +
      `${alone!.at - start} ms (the agent returned after ${returned} ms, ` +
      `removed_from_calls ${String(applied['removed_from_calls'])})`
  )
  expect(ended!.at - start).toBeLessThanOrEqual(CLOSURE_MS)
  expect(alone!.at - start).toBeLessThanOrEqual(CLOSURE_MS)
  expect((await snapshot(alicePage)).participants).toEqual([alice.userId])

  await joinFrom(bobPage, roomId)
  expect(await snapshot(bobPage)).toMatchObject({ status: 'failed', problem: 'forbidden', roomId })
})

test('carol, taken out of the organisation mid-call, is out of the call within 5 s (G2.5)', async ({
  browser,
}) => {
  const added = await agent(agentToken, 'apply', channelSet(3, [alice, bob, carol], [alice, carol]))
  expect(added).toMatchObject({ status: 'succeeded', channels_applied: 1, failed: [] })
  await accept(carol, roomId)
  const [context, carolPage] = await open(browser, carol)
  contexts.push(context)
  const clicked = await joinFrom(carolPage, roomId)
  const connected = await transition(
    carolPage,
    (state) => state.status === 'connected',
    10_000,
    clicked
  )
  expect(connected, "carol's call reaches connected").toBeDefined()
  await expect
    .poll(async () => (await snapshot(alicePage)).participants, { timeout: 10_000 })
    .toEqual(expect.arrayContaining([alice.userId, carol.userId]))

  // Core's member set, with carol inactive: the agent deactivates her account, then its roster
  // guard removes every inactive member from every call.
  const start = Date.now()
  const deactivating = agent(agentToken, 'deactivate', carol.subject)
  const [ended, alone] = await Promise.all([
    transition(carolPage, (state) => state.status === 'ended', CLOSURE_MS + 5000, start),
    transition(
      alicePage,
      (state) => state.status === 'connected' && !state.participants.includes(carol.userId),
      CLOSURE_MS + 5000,
      start
    ),
  ])
  const outcome = await deactivating
  const returned = Date.now() - start
  expect(outcome, 'the member set deactivates carol').toMatchObject({
    status: 'succeeded',
    artefacts: { users_deactivated: 1 },
  })
  expect(ended, "carol's call ends").toBeDefined()
  expect(alone, "alice's participants no longer list carol").toBeDefined()
  measure(
    `organisation removal: deactivation start to carol ended ${ended!.at - start} ms ` +
      `(${String(ended!.problem)}), to alice's roster without carol ${alone!.at - start} ms ` +
      `(the agent returned after ${returned} ms, participants_removed ` +
      `${String((outcome['artefacts'] as Record<string, unknown>)['participants_removed'])})`
  )
  expect(ended!.problem, 'as a removal').toBe('removed')
  expect(ended!.at - start, "carol's call ended within 5 s").toBeLessThanOrEqual(CLOSURE_MS)
  expect(alone!.at - start, 'alice saw her go within 5 s').toBeLessThanOrEqual(CLOSURE_MS)
  expect((await snapshot(alicePage)).participants).toEqual([alice.userId])

  // Her Matrix session is over: room-access refuses her token (401), and so would a refresh.
  await joinFrom(carolPage, roomId)
  expect(await snapshot(carolPage)).toMatchObject({
    status: 'failed',
    problem: 'unauthenticated',
    roomId,
  })
  expect((await stats(carolPage)).remote).toHaveLength(0)
})

test('alice, back with a microphone that is not plugged in, gets the default, then picks another', async () => {
  const listed = await alicePage.evaluate(() => window.espaceHarness.devices())
  measure(
    `alice's browser lists ${listed.inputs.length} microphones, ${listed.outputs.length} outputs`
  )
  // Chromium's fake devices: at least two microphones to choose between.
  expect(listed.inputs.length).toBeGreaterThanOrEqual(2)
  // An earlier visit chose a headset, unplugged since; the page is opened again.
  await alicePage.evaluate(async () => {
    await window.espaceHarness.leave()
    window.espaceHarness.remember({ input: 'a-headset-unplugged-since', output: null })
    window.espaceHarness.restart()
  })
  const click = await joinFrom(alicePage, roomId)
  expect(await transition(alicePage, (s) => s.status === 'connected', 10_000, click)).toBeDefined()
  await expect
    .poll(async () => (await snapshot(alicePage)).inputMissing, { timeout: 5_000 })
    .toBe(true)
  expect(await snapshot(alicePage)).toMatchObject({ muted: false })
  expect((await snapshot(alicePage)).problem).toBeUndefined()
  const micLevel = () => alicePage.evaluate(() => window.espaceHarness.micLevel())
  // The default captures, and is heard: the call goes on as if nothing were chosen.
  await expect.poll(micLevel, { timeout: 5_000, intervals: [50] }).toBeGreaterThan(SPEAKING_LEVEL)
  // Kept for when it is back.
  expect(await alicePage.evaluate(() => window.espaceHarness.remembered())).toEqual({
    input: 'a-headset-unplugged-since',
    output: null,
  })

  // She picks the second microphone: the call captures from it at once, and remembers it.
  const second = listed.inputs[1]!.id
  await alicePage.evaluate((id) => window.espaceHarness.chooseInput(id), second)
  await expect
    .poll(() => alicePage.evaluate(() => window.espaceHarness.inputDevice()), { timeout: 5_000 })
    .toBe(second)
  expect((await snapshot(alicePage)).inputMissing).toBe(false)
  await expect.poll(micLevel, { timeout: 5_000, intervals: [50] }).toBeGreaterThan(SPEAKING_LEVEL)
  expect(await alicePage.evaluate(() => window.espaceHarness.remembered())).toEqual({
    input: second,
    output: null,
  })
  measure(`alice switched microphones in the call, to ${second.slice(0, 8)}…, and is heard`)
})

test('alice, in later calls of the same page, gets the default she asks for, and the default for one unplugged', async () => {
  const listed = await alicePage.evaluate(() => window.espaceHarness.devices())
  const second = listed.inputs[1]!.id
  const micLevel = () => alicePage.evaluate(() => window.espaceHarness.micLevel())
  const inputDevice = () => alicePage.evaluate(() => window.espaceHarness.inputDevice())
  const leave = () => alicePage.evaluate(() => window.espaceHarness.leave())

  // Back to the default between calls. The page's one LiveKit room still remembers the second
  // microphone it was switched to: a capture that asked for nothing would get that one.
  await leave()
  await alicePage.evaluate(() => window.espaceHarness.chooseInput(null))
  let click = await joinFrom(alicePage, roomId)
  expect(await transition(alicePage, (s) => s.status === 'connected', 10_000, click)).toBeDefined()
  await expect.poll(inputDevice, { timeout: 5_000 }).not.toBeNull()
  expect(await inputDevice()).not.toBe(second)
  await expect.poll(micLevel, { timeout: 5_000, intervals: [50] }).toBeGreaterThan(SPEAKING_LEVEL)

  // The second again, in the call, then one that is not plugged in for the next call.
  await alicePage.evaluate((id) => window.espaceHarness.chooseInput(id), second)
  await expect.poll(inputDevice, { timeout: 5_000 }).toBe(second)
  await leave()
  await alicePage.evaluate(() => window.espaceHarness.chooseInput('a-headset-unplugged-since'))
  click = await joinFrom(alicePage, roomId)
  expect(await transition(alicePage, (s) => s.status === 'connected', 10_000, click)).toBeDefined()
  await expect
    .poll(async () => (await snapshot(alicePage)).inputMissing, { timeout: 5_000 })
    .toBe(true)
  expect(await snapshot(alicePage)).toMatchObject({ muted: false })
  // The default, not the second microphone the room was last switched to.
  await expect.poll(inputDevice, { timeout: 5_000 }).not.toBeNull()
  expect(await inputDevice()).not.toBe(second)
  await expect.poll(micLevel, { timeout: 5_000, intervals: [50] }).toBeGreaterThan(SPEAKING_LEVEL)
  measure(
    `alice's later calls capture the default (${(await inputDevice())!.slice(0, 8)}…), not ${second.slice(0, 8)}…`
  )
})

test('alice leaves', async () => {
  await alicePage.evaluate(() => window.espaceHarness.leave())
  expect(await snapshot(alicePage)).toMatchObject({ status: 'idle', roomId: null })
  expect(await alicePage.locator('audio').count()).toBe(0)
})

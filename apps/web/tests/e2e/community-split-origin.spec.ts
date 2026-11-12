// The public community, built with `package-real.py`'s real-identity settings, against five
// distinct local origins (split-origin contract B5, `split-origin/stack.ts`): every call the page
// makes must go to the one origin that serves it — sign-in and tokens to the identity provider,
// Core to the API origin, discovery to the static origin, Synapse, its SSO and the room-access
// call to the homeserver origin, signalling to LiveKit — with strict CORS and no cookie, and the
// static origin must never be asked for a backend path. The last test is the refusal self-test:
// a relative backend call and a call to a foreign origin are made on purpose and must be caught.

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { splitOriginViolations, type ObservedRequest } from './split-origin/ledger'
import {
  AUDIO_ROOM,
  DOMAIN,
  FOREIGN_ORIGIN,
  LIVEKIT_TOKEN,
  ORIGINS,
  SERVER_NAME,
  startSplitStack,
  type SplitStack,
} from './split-origin/stack'

test.describe.configure({ mode: 'serial' })
// A cold module graph is compiled on first use; the flows below each wait on several hops.
test.setTimeout(90_000)

let stack: SplitStack
let context: BrowserContext
let page: Page
const observed: ObservedRequest[] = []

async function splitContext(
  browser: Browser,
  into: ObservedRequest[]
): Promise<{ context: BrowserContext; page: Page }> {
  const created = await browser.newContext({
    proxy: { server: stack.proxy },
    // The stack's certificate is generated for this run and trusted by nothing.
    ignoreHTTPSErrors: true,
    locale: 'fr-FR',
    serviceWorkers: 'block',
  })
  created.on('request', (request) => into.push({ url: request.url() }))
  const opened = await created.newPage()
  opened.on('websocket', (socket) => into.push({ url: socket.url() }))
  return { context: created, page: opened }
}

/** Runs a module of the page's own graph, as the page itself would import it. */
function inPage<T>(target: Page, source: string, args: unknown): Promise<T> {
  return target.evaluate(
    `(async (args) => { const load = (path) => import(path); ${source} })(${JSON.stringify(args)})`
  ) as Promise<T>
}

const hitsOn = (server: string, path?: string) =>
  stack.hits.filter((hit) => hit.server === server && (path === undefined || hit.path === path))

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  stack = await startSplitStack()
  // Prove readiness in a disposable context: the dev server compiles the graph on first use, and
  // pulling the lazily imported modules here keeps any re-optimisation out of the flows below.
  const warm = await splitContext(browser, [])
  try {
    await warm.page.goto(`${ORIGINS.spa}/community/workspace`)
    await expect(warm.page.getByRole('heading', { name: 'Kodera Community' })).toBeVisible({
      timeout: 60_000,
    })
    await inPage(
      warm.page,
      `await load('/src/features/espace/audio/call.ts'); await load('/src/auth/matrix.ts');
       await load('/src/features/espace/homeserver.ts');
       await load('/src/features/support/communitySupportClient.ts'); return true`,
      null
    )
  } finally {
    await warm.context.close()
  }
  stack.hits.length = 0
  ;({ context, page } = await splitContext(browser, observed))
})

test.afterAll(async () => {
  await context?.close()
  await stack?.close()
})

test('sign-in and Core calls cross to their own origins, never the static one', async () => {
  // The static origin redirects `/` to the community, whose welcome is the auth gate.
  await page.goto(`${ORIGINS.spa}/`)
  await expect(page.getByRole('heading', { name: 'Kodera Community' })).toBeVisible()
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  // Provider discovery, the authorize round trip, the code exchange, then Core with the token.
  await expect
    .poll(() => hitsOn('api', '/api/v1/me').filter((hit) => hit.method === 'GET').length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  await expect(page).toHaveURL(`${ORIGINS.spa}/community/workspace`)

  const token = hitsOn('auth', '/realms/community/protocol/openid-connect/token')
  expect(token.filter((hit) => hit.method === 'POST')[0]?.origin).toBe(ORIGINS.spa)
  expect(
    hitsOn('auth', '/realms/community/protocol/openid-connect/auth').length,
    'the authorize step is a navigation to the provider'
  ).toBe(1)
  for (const hit of hitsOn('api').filter((entry) => entry.method !== 'OPTIONS')) {
    expect(hit.origin, `${hit.method} ${hit.path}`).toBe(ORIGINS.spa)
    expect(hit.authorization, `${hit.method} ${hit.path}`).toMatch(/^Bearer at-/)
  }
})

test('discovery, Matrix SSO, token login, refresh, room access and LiveKit reach the homeserver origins', async () => {
  const found = await inPage<{ serverName: string; baseUrl: string; target: string }>(
    page,
    `const { resolveHomeserver } = await load('/src/features/espace/homeserver.ts');
     const { beginMatrixSignIn } = await load('/src/auth/matrix.ts');
     const found = await resolveHomeserver('community', { matrixDomain: args.domain });
     let target = '';
     beginMatrixSignIn(found.baseUrl, '/community/workspace', { navigate: (url) => { target = url } });
     return { ...found, target };`,
    { domain: DOMAIN }
  )
  expect(found.serverName).toBe(SERVER_NAME)
  expect(found.baseUrl).toBe(ORIGINS.matrix)
  const sso = new URL(found.target)
  expect(sso.origin + sso.pathname).toBe(`${ORIGINS.matrix}/_matrix/client/v3/login/sso/redirect`)
  expect(new URL(sso.searchParams.get('redirectUrl') ?? '').origin).toBe(ORIGINS.spa)
  expect(hitsOn('spa', '/.well-known/matrix/client')).toHaveLength(1)

  // The real page leaves for Synapse's SSO and comes back to the Console's callback, which
  // restores the identity session silently and exchanges the login token on the homeserver.
  await page.goto(found.target)
  await expect(page).toHaveURL(`${ORIGINS.spa}/community/workspace`, { timeout: 30_000 })
  const login = hitsOn('matrix', '/_matrix/client/v3/login').filter((hit) => hit.method === 'POST')
  expect(login).toHaveLength(1)
  expect(login[0]?.origin).toBe(ORIGINS.spa)

  const status = await inPage<string>(
    page,
    `const { getMatrixSession } = await load('/src/auth/matrix.ts');
     const { createCallController } = await load('/src/features/espace/audio/call.ts');
     const session = getMatrixSession();
     if (session === undefined) return 'no-session';
     const call = createCallController({
       homeserver: session.baseUrl,
       serverName: args.serverName,
       tokens: {
         current: () => session.accessToken,
         renew: async (stale) => (await session.refresh(session.refreshToken)).accessToken,
       },
     });
     await call.join(args.room).catch(() => undefined);
     return call.getSnapshot ? call.getSnapshot().status : 'joined';`,
    { serverName: SERVER_NAME, room: AUDIO_ROOM }
  )
  expect(status).not.toBe('no-session')

  const grants = hitsOn('matrix', '/_kodera/rooms/token').filter((hit) => hit.method === 'POST')
  // The first grant met an expired token; the refreshed one was accepted.
  expect(grants).toHaveLength(2)
  expect(
    hitsOn('matrix', '/_matrix/client/v3/refresh').filter((h) => h.method === 'POST')
  ).toHaveLength(1)
  for (const grant of grants) {
    expect(grant.origin).toBe(ORIGINS.spa)
    expect(grant.cookie).toBe(false)
    expect(grant.authorization).toMatch(/^Bearer mat-/)
  }
  await expect.poll(() => hitsOn('livekit').filter((hit) => hit.upgrade).length).toBeGreaterThan(0)
  const signalling = observed.filter((entry) => entry.url.startsWith(`${ORIGINS.livekit}/rtc`))
  expect(signalling.length).toBeGreaterThan(0)
  expect(new URL(signalling[0]!.url).searchParams.get('access_token')).toBe(LIVEKIT_TOKEN)
})

test('a #support ticket is submitted to the Core API origin', async () => {
  const receipt = await inPage<{ confirmation: string }>(
    page,
    `const { createCommunitySupportTicket } = await load('/src/features/support/communitySupportClient.ts');
     return createCommunitySupportTicket('Synthetic subject', 'Synthetic body', 'fr', crypto.randomUUID());`,
    null
  )
  expect(receipt.confirmation).toBe('ticket-created')
  const posted = hitsOn('api', '/api/v1/community/support/tickets').filter(
    (h) => h.method === 'POST'
  )
  expect(posted).toHaveLength(1)
  expect(posted[0]?.origin).toBe(ORIGINS.spa)
  expect(posted[0]?.cookie).toBe(false)
})

test('the whole run kept to the split-origin map, with no cookie and no refused origin', async () => {
  const calls = observed.filter((entry) => !stack.isDevChannel(entry.url))
  expect(calls.length).toBeGreaterThan(20)
  expect(splitOriginViolations(calls, ORIGINS)).toEqual([])
  expect(
    stack.hits.filter(
      (hit) =>
        hit.server === 'spa' && /^\/(api|realms|_matrix|_kodera|_synapse)(\/|$)/.test(hit.path)
    )
  ).toEqual([])
  expect(stack.hits.filter((hit) => hit.server !== 'spa' && hit.cookie)).toEqual([])
  expect(stack.hits.filter((hit) => hit.server === 'foreign')).toEqual([])
  expect(stack.corsRefusals).toEqual([])
  expect(stack.refusedHosts).toEqual([])
})

test('refusal self-test: a relative backend call and a foreign origin are caught', async ({
  browser,
}) => {
  const leaks: ObservedRequest[] = []
  const probe = await splitContext(browser, leaks)
  try {
    await probe.page.goto(`${ORIGINS.spa}/community/workspace`)
    await expect(probe.page.getByRole('heading', { name: 'Kodera Community' })).toBeVisible()
    const statuses = await probe.page.evaluate(async () => {
      const status = (call: Promise<Response>) => call.then((r) => r.status).catch(() => 0)
      return [
        await status(fetch('/api/v1/me')),
        await status(fetch('/_kodera/rooms/token', { method: 'POST' })),
        await status(fetch('https://unmapped.example.invalid/')),
      ]
    })
    // The static origin refuses backend paths; the proxy refuses an unmapped host.
    expect(statuses).toEqual([503, 503, 0])
    expect(
      splitOriginViolations(
        leaks.filter((entry) => !stack.isDevChannel(entry.url)),
        ORIGINS
      )
    ).toEqual([
      'same-origin backend call: /api/v1/me',
      'same-origin backend call: /_kodera/rooms/token',
      'disallowed origin: https://unmapped.example.invalid/',
    ])
    expect(stack.refusedHosts).toContain('unmapped.example.invalid:443')

    // Strict CORS is what makes the green runs above mean something: a page on any other origin
    // cannot read Core or the room-access call.
    await probe.page.goto(`${FOREIGN_ORIGIN}/`)
    const foreign = await probe.page.evaluate(
      async ({ api, matrix }) => {
        const read = (call: Promise<Response>) => call.then(() => 'read').catch(() => 'blocked')
        return [
          await read(fetch(`${api}/api/v1/me`, { headers: { Authorization: 'Bearer x' } })),
          await read(
            fetch(`${matrix}/_kodera/rooms/token`, {
              method: 'POST',
              headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
              body: '{}',
              credentials: 'omit',
            })
          ),
        ]
      },
      { api: ORIGINS.api, matrix: ORIGINS.matrix }
    )
    expect(foreign).toEqual(['blocked', 'blocked'])
    expect(stack.corsRefusals.map((hit) => `${hit.server} ${hit.method} ${hit.path}`)).toEqual([
      'api OPTIONS /api/v1/me',
      'matrix OPTIONS /_kodera/rooms/token',
    ])
  } finally {
    await probe.context.close()
  }
})

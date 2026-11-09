// Espace's sign-in (src/auth/matrix.ts) against the real Synapse and Keycloak of the stack: the
// whole round trip a browser makes, Keycloak's own sign-in form included, then the session in
// Espace's store. What a mock of SSO would never show: Synapse's whitelist, its single-use login
// tokens, its device reuse, and the Matrix ID it derives from Keycloak's `sub`.

import { logger } from 'matrix-js-sdk/lib/logger.js'
import { describe, expect, it } from 'vitest'
import {
  beginMatrixSignIn,
  completeMatrixSignIn,
  MATRIX_CALLBACK_PATH,
  MatrixSignInFailed,
  RefreshRefused,
  refreshMatrixToken,
  signOutOfMatrix,
} from '@/auth/matrix'
import { EspaceStore } from '@/features/espace/matrix/store'
import {
  baseUrl,
  consoleOrigin,
  eventually,
  memoryStorage,
  person,
  throughKeycloak,
  type Person,
} from './stack'
;(logger as unknown as { setLevel: (level: 'silent') => void }).setLevel('silent')

const callback = `${consoleOrigin}${MATRIX_CALLBACK_PATH}`

/** One browser: its two storages, and the address bar Synapse last sent it to. */
function browser() {
  return {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    replaced: [] as string[],
  }
}

async function signIn(tab = browser(), who?: Person, returnTo = '/espace/general') {
  const member = who ?? (await person('ada'))
  let started = ''
  beginMatrixSignIn(baseUrl, returnTo, {
    consoleOrigin,
    sessionStorage: tab.sessionStorage,
    navigate: (url) => (started = url),
  })
  const landed = await throughKeycloak(started, member)
  const result = await completeMatrixSignIn(landed, member.sub, {
    ...tab,
    replaceUrl: (url) => tab.replaced.push(url),
  })
  return { ...result, landed, tab, member }
}

async function whoami(accessToken: string) {
  const response = await fetch(`${baseUrl}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("Espace's sign-in through Keycloak", () => {
  it("comes back to the Console without Synapse's confirmation page, and drops the login token from the address bar", async () => {
    const { session, returnTo, landed, tab } = await signIn()
    expect(new URL(landed).searchParams.get('loginToken')).not.toBeNull()
    expect(tab.replaced).toEqual([callback])
    expect(returnTo).toBe('/espace/general')
    expect((await whoami(session.accessToken)).body).toMatchObject({
      user_id: session.userId,
      device_id: session.deviceId,
    })
  })

  it("derives the Matrix ID from Keycloak's stable sub, not from the username", async () => {
    const { session, member } = await signIn()
    expect(session.userId).toBe(`@${member.sub}:kodera.test`)
  })

  it('keeps only the device id, and signs in again on the same device', async () => {
    const tab = browser()
    const ada = await person('ada')
    const first = await signIn(tab, ada)
    expect(tab.sessionStorage.length).toBe(0)
    expect(tab.localStorage.length).toBe(1)
    const stored = tab.localStorage.getItem(tab.localStorage.key(0)!)!
    expect(stored).toBe(first.session.deviceId)
    // Nothing secret in either storage: no access or refresh token.
    for (const storage of [tab.sessionStorage, tab.localStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const value = storage.getItem(storage.key(index)!)!
        expect(value).not.toContain(first.session.accessToken)
        expect(value).not.toContain(first.session.refreshToken)
      }
    }
    const second = await signIn(tab, ada)
    expect(second.session.deviceId).toBe(first.session.deviceId)
    expect(second.session.accessToken).not.toBe(first.session.accessToken)
  })

  it('refuses a login token used twice', async () => {
    const tab = browser()
    let started = ''
    beginMatrixSignIn(baseUrl, '/', {
      consoleOrigin,
      sessionStorage: tab.sessionStorage,
      navigate: (url) => (started = url),
    })
    const ada = await person('ada')
    const landed = await throughKeycloak(started, ada)
    const state = new URL(landed).searchParams.get('state')!
    await completeMatrixSignIn(landed, ada.sub, { ...tab, replaceUrl: () => undefined })
    // The same callback again, as if replayed, with its round trip recorded anew.
    tab.sessionStorage.setItem(
      'kodera.web.espace.signin',
      JSON.stringify({ state, baseUrl, returnTo: '/' })
    )
    await expect(
      completeMatrixSignIn(landed, ada.sub, { ...tab, replaceUrl: () => undefined })
    ).rejects.toMatchObject({ problem: 'refused' })
  })

  it('refuses a callback this tab did not start, before asking Synapse anything', async () => {
    const { landed, member } = await signIn()
    let asked = 0
    const other = browser()
    const failure = completeMatrixSignIn(landed, member.sub, {
      ...other,
      replaceUrl: () => undefined,
      fetch: (input, init) => {
        asked += 1
        return fetch(input, init)
      },
    })
    await expect(failure).rejects.toBeInstanceOf(MatrixSignInFailed)
    await expect(failure).rejects.toMatchObject({ problem: 'unexpected-callback' })
    expect(asked).toBe(0)
  })

  it("refuses the Matrix account of whoever else holds the browser's Keycloak session", async () => {
    const tab = browser()
    const console_member = await person('ada')
    const other = await person('bob')
    let started = ''
    beginMatrixSignIn(baseUrl, '/', {
      consoleOrigin,
      sessionStorage: tab.sessionStorage,
      navigate: (url) => (started = url),
    })
    const landed = await throughKeycloak(started, other)
    let issued = ''
    const failure = completeMatrixSignIn(landed, console_member.sub, {
      ...tab,
      replaceUrl: () => undefined,
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        if (String(input).endsWith('/login')) {
          issued = ((await response.clone().json()) as { access_token: string }).access_token
        }
        return response
      },
    })
    await expect(failure).rejects.toMatchObject({ problem: 'other-person' })
    // The token Synapse issued to the other person is dead already.
    expect(issued).not.toBe('')
    expect((await whoami(issued)).status).toBe(401)
  })

  it('refreshes against Synapse, and reports a refused refresh token as such', async () => {
    const { session } = await signIn()
    const next = await session.refresh(session.refreshToken)
    expect((await whoami(next.accessToken)).status).toBe(200)
    await expect(refreshMatrixToken(baseUrl, 'syr_not_a_token')).rejects.toBeInstanceOf(
      RefreshRefused
    )
  })

  it("gives Espace's store a session it syncs with", async () => {
    const { session } = await signIn()
    const store = new EspaceStore(session)
    try {
      await store.start()
      await eventually(store, (s) => expect(s.status).toBe('live'))
    } finally {
      store.stop()
    }
  })

  it('signs the device out of Synapse and forgets it', async () => {
    const { session, tab } = await signIn()
    await signOutOfMatrix(session.baseUrl, session.accessToken, { localStorage: tab.localStorage })
    expect((await whoami(session.accessToken)).status).toBe(401)
    expect(tab.localStorage.length).toBe(0)
  })
})

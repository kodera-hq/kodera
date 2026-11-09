// The members an integration test signs in as, created on the running stack through the
// shared-secret admin API (open registration is off). Reads tests/espace/stack/.runtime/config, which
// bin/up.sh writes.

import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { refreshMatrixToken } from '@/auth/matrix'
import type { EspaceSession, EspaceSnapshot, EspaceStore } from '@/features/espace/matrix/store'

const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL('../stack/.runtime/config', import.meta.url)), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
export const baseUrl = `http://127.0.0.1:${env['SYNAPSE_PORT']}`
/** Where the Console runs in development: in Synapse's `sso.client_whitelist`. */
export const consoleOrigin = env['CONSOLE_ORIGIN']!

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as Record<string, unknown>
  if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${JSON.stringify(json)}`)
  return json
}

/** Synapse's own refresh (`/v3/refresh`), as the Console's sign-in calls it. */
export const refresh = (refreshToken: string) => refreshMatrixToken(baseUrl, refreshToken)

/** Each member's password, by user id: what `signInAgain` signs in with. */
const passwords = new Map<string, string>()

/** A new member, signed in with a refreshable token, as Espace's sign-in will be (design §2.4). */
export async function member(name: string): Promise<EspaceSession> {
  const localpart = `${name}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(12).toString('hex')
  const nonce = (await (await fetch(`${baseUrl}/_synapse/admin/v1/register`)).json()) as {
    nonce: string
  }
  const mac = createHmac('sha1', env['SYNAPSE_REGISTRATION_SECRET']!)
    .update(`${nonce.nonce}\0${localpart}\0${password}\0notadmin`)
    .digest('hex')
  const registered = await post('/_synapse/admin/v1/register', {
    nonce: nonce.nonce,
    username: localpart,
    password,
    admin: false,
    mac,
  })
  passwords.set(registered['user_id'] as string, password)
  return signIn(registered['user_id'] as string, password)
}

/**
 * The same member signed in once more, on a new device, as a browser opening the workspace is.
 * A second store on the first session's device is not that: within two minutes Synapse answers
 * its first /sync from the cache of the first store's, and every event then arrives as new.
 */
export function signInAgain(session: EspaceSession): Promise<EspaceSession> {
  return signIn(session.userId, passwords.get(session.userId)!)
}

async function signIn(userId: string, password: string): Promise<EspaceSession> {
  const login = await post('/_matrix/client/v3/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: userId },
    password,
    refresh_token: true,
  })
  return {
    baseUrl,
    refresh,
    userId: login['user_id'] as string,
    deviceId: login['device_id'] as string,
    accessToken: login['access_token'] as string,
    refreshToken: login['refresh_token'] as string,
  }
}

/** Waits until the store's snapshot satisfies `check`, which asserts with `expect`; fails with
 * the last assertion's message after 15 s. Usable in hooks as well as tests. */
export async function eventually(
  store: EspaceStore,
  check: (snapshot: EspaceSnapshot) => void
): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      check(store.getSnapshot())
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const keycloak = `http://127.0.0.1:${env['KEYCLOAK_PORT']}`

/** A member of the organisation's realm. `sub` is Keycloak's id for them. */
export interface Person {
  username: string
  password: string
  sub: string
}

/** A new person in the realm, created through Keycloak's admin API. */
export async function person(name: string): Promise<Person> {
  const grant = await fetch(`${keycloak}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: env['KEYCLOAK_ADMIN_PASSWORD']!,
    }).toString(),
  })
  if (!grant.ok) throw new Error(`Keycloak admin sign-in: ${grant.status}`)
  const { access_token: admin } = (await grant.json()) as { access_token: string }
  const username = `${name}-${randomBytes(3).toString('hex')}`
  const password = randomBytes(12).toString('hex')
  const created = await fetch(`${keycloak}/admin/realms/acme-sa/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      email: `${username}@acme-sa.test`,
      emailVerified: true,
      firstName: name,
      lastName: 'Test',
      enabled: true,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  })
  if (created.status !== 201) throw new Error(`Keycloak user: ${created.status}`)
  const sub = created.headers.get('location')!.split('/').at(-1)!
  return { username, password, sub }
}

/**
 * What the browser does between `beginMatrixSignIn` and the Console's callback: follows Synapse
 * to Keycloak, signs in there as `person` through Keycloak's own form, and follows the redirects
 * back. Returns the URL Synapse finally sends the browser to.
 *
 * @param start the SSO URL `beginMatrixSignIn` navigated to
 */
export async function throughKeycloak(start: string, person: Person) {
  // Keycloak and Synapse share 127.0.0.1, and cookies ignore the port: one jar does.
  const jar = new Map<string, string>()
  const go = async (url: string, init: RequestInit = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), cookie },
    })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0]!
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
    }
    return response
  }
  const follow = async (response: Response): Promise<Response | string> => {
    for (let hop = 0; hop < 10; hop += 1) {
      if (response.status < 300 || response.status >= 400) return response
      const next = new URL(response.headers.get('location')!, response.url || undefined).href
      if (next.startsWith(`${consoleOrigin}/`)) return next
      response = await go(next)
    }
    throw new Error('too many redirects')
  }
  const form = await follow(await go(start))
  if (typeof form === 'string') return form
  const action = /action="([^"]+)"/.exec(await form.text())?.[1]?.replaceAll('&amp;', '&')
  if (action === undefined) throw new Error(`no sign-in form: ${form.status}`)
  const back = await follow(
    await go(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: person.username,
        password: person.password,
      }).toString(),
    })
  )
  if (typeof back !== 'string') throw new Error(`not sent back to the Console: ${back.status}`)
  return back
}

/** A `Storage` in memory, standing for the browser's in Node. */
export function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

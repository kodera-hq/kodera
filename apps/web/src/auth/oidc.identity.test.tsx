import { QueryClient } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { User, UserManager } from 'oidc-client-ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthProvider'
import { OidcAuthAdapter } from './oidc'
import { createCurrentUserLoader } from '../app/currentUser'

const coreFetch = vi.fn()
const issuer = 'https://id.example.test/realms/acme-sa'

function expectAuthorityCancellation(value: unknown): void {
  const failure = value as { name?: unknown; message?: unknown }
  expect(
    (failure.name === 'AbortError' && failure.message === 'Credential authority ended.') ||
      failure.message === 'CancelledError'
  ).toBe(true)
}
const live = (profile: Record<string, unknown>, token = 'token') =>
  new User({
    access_token: token,
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    profile: profile as User['profile'],
  })
async function ready(profile: Record<string, unknown> = { iss: issuer, sub: 'User:Opaque/1' }) {
  vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(live(profile))
  const adapter = new OidcAuthAdapter()
  await adapter.signIn('acme-sa')
  await adapter.handleCallback()
  return adapter
}
beforeEach(() => {
  sessionStorage.clear()
  coreFetch.mockReset()
  vi.stubGlobal('fetch', coreFetch)
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.example.test/api/v1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
function Probe() {
  const auth = useAuth()
  return <p data-testid="identity-generation">{auth.generation}</p>
}
describe('active processed SDK identity', () => {
  it('exposes an exact opaque issuer/subject pair without normalization', async () => {
    const adapter = await ready()
    expect(adapter.getUser()).toMatchObject({ identity: { issuer, subject: 'User:Opaque/1' } })
    expect(adapter.getUser()).not.toHaveProperty('accessToken')
    await adapter.signOut()
  })
  it.each([
    {},
    { iss: issuer },
    { sub: 'subject' },
    { iss: issuer + '/', sub: 'subject' },
    { iss: issuer, sub: '' },
    { iss: issuer, sub: 'é' },
    { iss: issuer, sub: 'a'.repeat(256) },
    { iss: issuer, sub: 42 },
    { iss: ['other', issuer], sub: 'subject' },
  ])('does not infer capability from incomplete or mismatched profile %j', async (profile) => {
    vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
    vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(live(profile))
    const remove = vi.spyOn(UserManager.prototype, 'removeUser').mockResolvedValue()
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    await expect(adapter.handleCallback()).rejects.toThrow('Invalid sign-in identity')
    expect(adapter.getSnapshot().status).toBe('unauthenticated')
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getUser()).toBeUndefined()
    expect(remove).toHaveBeenCalled()
    await adapter.signOut()
  })
  it.each(['same', 'subject', 'issuer', 'missing'] as const)(
    'keeps private context only for same-identity renewal (%s)',
    async (change) => {
      const adapter = await ready()
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      client.setQueryData(['private'], { secret: 'old-user-data' })
      render(
        <AuthProvider adapter={adapter} onSessionEnded={() => client.clear()}>
          <Probe />
        </AuthProvider>
      )
      const generation = adapter.getSnapshot().generation
      const credentialGeneration = adapter.getSnapshot().credentialGeneration
      let finish!: (response: Response) => void
      let signal!: AbortSignal
      coreFetch.mockImplementation((request: Request) => {
        signal = request.signal
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      })
      const load = createCurrentUserLoader(adapter, client)
      const pending = load().catch((error: unknown) => error)
      await waitFor(() => expect(signal).toBeDefined())
      const profile =
        change === 'missing'
          ? {}
          : {
              iss: change === 'issuer' ? 'https://another.example.test/realms/acme-sa' : issuer,
              sub: change === 'subject' ? 'different-subject' : 'User:Opaque/1',
            }
      const renewed = live(profile, 'new-token')
      const notification = vi.fn()
      adapter.onRenewed(notification)
      vi.spyOn(UserManager.prototype, 'signinSilent').mockImplementationOnce(async function (
        this: UserManager
      ) {
        await this.events.load(renewed)
        return renewed
      })
      await act(async () => {
        expect(await adapter.renew()).toBe(change === 'same')
      })
      expect(notification).toHaveBeenCalledTimes(change === 'same' ? 1 : 0)
      const changed = change !== 'same'
      expect(adapter.getSnapshot().status).toBe(changed ? 'unauthenticated' : 'ready')
      expect(adapter.getSnapshot().generation).toBe(generation + Number(changed))
      expect(adapter.getSnapshot().credentialGeneration).toBe(credentialGeneration + 1)
      expect(screen.getByTestId('identity-generation')).toHaveTextContent(
        String(generation + Number(changed))
      )
      expect(signal.aborted).toBe(true)
      expect(client.getQueryData(['private'])).toEqual(
        changed ? undefined : { secret: 'old-user-data' }
      )
      finish(Response.json({ id: 'old-person', identities: [], organisations: [] }))
      const result = await pending
      expectAuthorityCancellation(result)
      expect(client.getQueryData(['me', generation, credentialGeneration])).toBeUndefined()
      await act(async () => {
        await adapter.signOut()
      })
    }
  )
})

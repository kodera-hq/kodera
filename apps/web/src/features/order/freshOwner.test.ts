import { describe, expect, it, vi } from 'vitest'
import type { AuthAdapter, AuthSessionSnapshot } from '../../auth/AuthAdapter'
import type { components } from '../../api/schema'
import { createFreshOrderContextReader } from './freshOwner'

const issuer = 'https://id.example.test/realms/acme-sa'
const orgId = '00000000-0000-4000-8000-000000000001'
const membershipId = '00000000-0000-4000-8000-000000000002'
const identityId = '00000000-0000-4000-8000-000000000003'
function fixture() {
  let token: string | undefined = 'token'
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa', identity: { issuer, subject: 'user' } },
  }
  const listeners = new Set<() => void>()
  const adapter: Pick<AuthAdapter, 'getSnapshot' | 'getAccessToken' | 'subscribe'> = {
    getSnapshot: () => snapshot,
    getAccessToken: () => token,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const me: components['schemas']['Me'] = {
    id: 'person',
    email: 'person@example.test',
    locale: 'fr',
    staff: false,
    identities: [
      { id: identityId, issuer, realm: 'acme-sa', subject: 'user', email: 'person@example.test' },
    ],
    organisations: [
      {
        organisation: { id: orgId, slug: 'acme-sa', name: 'Acme' },
        membership_id: membershipId,
        identity_id: identityId,
        state: 'active',
        role: 'org_owner',
      },
    ],
  }
  const request = vi.fn(async (_signal: AbortSignal) => me)
  const read = createFreshOrderContextReader(adapter, request)
  return {
    read,
    request,
    me,
    replace: () => {
      token = undefined
      snapshot = {
        status: 'unauthenticated',
        generation: 2,
        credentialGeneration: 2,
        user: undefined,
      }
      listeners.forEach((fn) => fn())
    },
  }
}
describe('fresh order ownership', () => {
  it('requests fresh Core membership on every entry rather than reusing a successful snapshot', async () => {
    const { read, request, me } = fixture()
    expect(
      (await read({ organisationSlug: 'acme-sa', signal: new AbortController().signal })).owner
        .organisationId
    ).toBe(orgId)
    me.organisations[0]!.state = 'removed'
    await expect(
      read({ organisationSlug: 'acme-sa', signal: new AbortController().signal })
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each(['session', 'route'] as const)(
    'cancels and rejects late ownership after %s ends',
    async (mode) => {
      const { read, request, me, replace } = fixture()
      let resolve!: (value: typeof me) => void
      request.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      const controller = new AbortController()
      const pending = read({ organisationSlug: 'acme-sa', signal: controller.signal }).catch(
        (error: unknown) => error
      )
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
      const signal = request.mock.calls[0]![0]
      if (mode === 'session') replace()
      else controller.abort()
      resolve(me)
      expect(await pending).toMatchObject({ name: 'AbortError' })
      expect(signal.aborted).toBe(true)
    }
  )
})

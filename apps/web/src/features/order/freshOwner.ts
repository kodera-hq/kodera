import type { AuthAdapter } from '../../auth/AuthAdapter'
import { authAdapter } from '../../auth/oidc'
import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'
import { resolveOrderOwner } from './owner'

type Me = components['schemas']['Me']

/** The order's owner could not be established from fresh Core data. The
 * order route's own error screen is for this, and only this: a 401 or a
 * render error is the console's general one (`./routes.tsx`). */
export class OrderOwnershipUnavailable extends Error {
  constructor(options?: { cause: unknown }) {
    super('Order ownership is unavailable.', options)
    this.name = 'OrderOwnershipUnavailable'
  }
}
type SessionReader = Pick<AuthAdapter, 'getSnapshot' | 'getAccessToken' | 'subscribe'>

/** Every order entry obtains new authority data; no shared /me cache is proof. */
export function createFreshOrderContextReader(
  adapter: SessionReader,
  requestMe: (signal: AbortSignal) => Promise<Me | undefined>
) {
  return async ({
    organisationSlug,
    signal,
  }: {
    organisationSlug: string
    signal: AbortSignal
  }) => {
    const session = adapter.getSnapshot()
    const token = adapter.getAccessToken()
    const controller = new AbortController()
    const current = () =>
      adapter.getSnapshot().status === 'ready' &&
      adapter.getSnapshot().generation === session.generation &&
      token !== undefined &&
      adapter.getAccessToken() === token
    const cancelled = () => {
      controller.abort()
    }
    if (!current() || session.user?.identity === undefined || signal.aborted)
      throw new OrderOwnershipUnavailable()
    const unsubscribe = adapter.subscribe(() => {
      if (!current()) cancelled()
    })
    signal.addEventListener('abort', cancelled, { once: true })
    try {
      const me = await requestMe(controller.signal)
      if (!current() || signal.aborted || controller.signal.aborted)
        throw new DOMException('Order context ended.', 'AbortError')
      if (me === undefined) throw new OrderOwnershipUnavailable()
      // Slug selects a fresh Core membership; it never becomes a storage owner.
      const memberships = me.organisations.filter(
        (entry) => entry.organisation.slug === organisationSlug
      )
      const membership = memberships[0]
      if (memberships.length !== 1 || membership === undefined)
        throw new OrderOwnershipUnavailable()
      const owner = resolveOrderOwner({
        session: adapter.getSnapshot(),
        me,
        meGeneration: session.generation,
        organisationId: membership.organisation.id,
        membershipId: membership.membership_id,
      })
      if (owner === undefined) throw new OrderOwnershipUnavailable()
      return { owner, me, membership }
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', cancelled)
    }
  }
}

export const loadFreshOrderContext = createFreshOrderContextReader(authAdapter, async (signal) => {
  const { data } = await coreApi().GET('/me', { signal })
  return data
})

import type { AuthAdapter } from '../../auth/AuthAdapter'
import { authAdapter } from '../../auth/oidc'
import { loadFreshOrderContext, OrderOwnershipUnavailable } from '../order/freshOwner'
import type { OrderOwner } from '../order/owner'

export interface ExpectedClaimOwner {
  readonly organisationId: string
  readonly organisationSlug: string
  readonly issuer: string
  readonly subject: string
  readonly generation: number
}

type SessionReader = Pick<AuthAdapter, 'getSnapshot' | 'getAccessToken' | 'subscribe'>

export function createFreshClaimOwnerReader(
  adapter: SessionReader,
  read: typeof loadFreshOrderContext
) {
  return async (
    input: ExpectedClaimOwner,
    signal: AbortSignal
  ): Promise<OrderOwner | undefined> => {
    if (input === null || typeof input !== 'object') return undefined
    const expected = Object.freeze({
      organisationId: input.organisationId,
      organisationSlug: input.organisationSlug,
      issuer: input.issuer,
      subject: input.subject,
      generation: input.generation,
    })
    if (
      typeof expected.organisationId !== 'string' ||
      expected.organisationId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        expected.organisationId
      ) ||
      typeof expected.organisationSlug !== 'string' ||
      expected.organisationSlug.length === 0 ||
      typeof expected.issuer !== 'string' ||
      expected.issuer.length === 0 ||
      typeof expected.subject !== 'string' ||
      expected.subject.length === 0 ||
      !Number.isSafeInteger(expected.generation) ||
      expected.generation < 0
    )
      return undefined
    const token = adapter.getAccessToken()
    const current = () => {
      const session = adapter.getSnapshot()
      return (
        session.status === 'ready' &&
        session.generation === expected.generation &&
        session.user?.identity?.issuer === expected.issuer &&
        session.user.identity.subject === expected.subject &&
        token !== undefined &&
        token.length !== 0 &&
        adapter.getAccessToken() === token &&
        !signal.aborted
      )
    }
    if (!current()) return undefined
    try {
      const fresh = await read({ organisationSlug: expected.organisationSlug, signal })
      if (!current()) return undefined
      if (fresh.owner.organisationId !== expected.organisationId) return undefined
      if (fresh.membership.organisation.slug !== expected.organisationSlug) return undefined
      if (fresh.membership.role !== 'org_owner') return undefined
      return fresh.owner
    } catch (error) {
      if (!current()) return undefined
      if (
        error instanceof OrderOwnershipUnavailable ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        return undefined
      throw error
    }
  }
}

export const loadFreshClaimOwner = createFreshClaimOwnerReader(authAdapter, loadFreshOrderContext)

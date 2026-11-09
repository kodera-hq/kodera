// Placing an order opens only where the first-owner journey is built in (`VITE_FIRST_OWNER_JOURNEY`,
// docs/specs/09-owner-claim.md), until that journey ships. Written as a literal comparison so a
// build without the flag keeps the held screen and nothing else.
import type { OrderRequest } from './mutations'

export const SUBMISSION_HELD = import.meta.env.VITE_FIRST_OWNER_JOURNEY !== '1'

/** The order being placed from a draft, for as long as the page lives. Never stored: the saved
 * draft holds only what the person typed (`editableStorage.ts`).
 * - `key` and `body`: what was sent, kept together while the outcome is unknown, so a retry
 *   resends exactly the same request (Core replays a committed one; a changed body under the same
 *   key would be refused).
 * - `orderId`: the order it created.
 * - `unresolved`: Core answered in a way that says an order may already exist (the slug is taken,
 *   the key was reused, the DPA is already accepted). No further order is sent from this page. */
export interface OrderSubmission {
  readonly key?: string | undefined
  readonly body?: OrderRequest | undefined
  readonly orderId?: string | undefined
  readonly unresolved?: boolean | undefined
}

const submissions = new Map<string, OrderSubmission>()

export function orderSubmission(draftId: string): OrderSubmission {
  return submissions.get(draftId) ?? {}
}

export function recordSubmission(draftId: string, patch: OrderSubmission): void {
  submissions.set(draftId, { ...orderSubmission(draftId), ...patch })
}

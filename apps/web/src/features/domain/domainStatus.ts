// How the state of an address is shown in the list
// (docs/specs/domain-addresses-list.md). Read from `Domain.state` alone:
// "the console reads them; it never derives a state of its own from the
// certificate or the records" (docs/specs/04-domain.md §6).
//
// Exhaustive on purpose: a state the contract adds or drops at a repin is a
// compile error here, not a row with no label.

import type { components } from '../../api/schema'
import type { MessageKey } from '../../i18n'
import type { StatusPillState } from '../../ui/StatusPill/StatusPill'

export type DomainState = components['schemas']['DomainState']

export interface StatePresentation {
  pill: StatusPillState
  labelKey: MessageKey
}

// The catalogue has four words for seven states. The pill says whose move it
// is: while a line is awaited at the customer's registrar the address is
// « En attente de configuration »; while the next step is ours it is
// « Vérification en cours ».
const AWAITING_CUSTOMER: StatePresentation = {
  pill: 'neutral',
  labelKey: 'console.domain.list.status-pending',
}
const IN_PROGRESS: StatePresentation = {
  pill: 'info',
  labelKey: 'console.domain.list.status-verifying',
}

export const STATE_PRESENTATION: Record<DomainState, StatePresentation> = {
  pending: AWAITING_CUSTOMER,
  nonce_issued: AWAITING_CUSTOMER,
  txt_verified: IN_PROGRESS,
  dns_pending: AWAITING_CUSTOMER,
  certificate_issued: IN_PROGRESS,
  live: { pill: 'success', labelKey: 'console.domain.list.status-active' },
  failed: { pill: 'danger', labelKey: 'console.domain.list.status-failed' },
}

export function isDomainState(value: unknown): value is DomainState {
  return typeof value === 'string' && Object.hasOwn(STATE_PRESENTATION, value)
}

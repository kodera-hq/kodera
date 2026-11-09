// Maps a `StatusComponent` onto the console's own three-name vocabulary
// (docs/specs/02-status.md §9: "the three names are 'Site web', 'Appels
// vidéo', 'Console'") and pill state — the API's own `name` field is
// staff-facing English ("Calls") and is never rendered; the customer only
// ever reads a catalogue label keyed by `key`.

import type { components } from '@/api/schema'
import type { MessageKey } from '@/i18n'
import type { StatusPillState } from '@/ui/StatusPill/StatusPill'

export type StatusComponent = components['schemas']['StatusComponent']
export type ComponentState = StatusComponent['state']

const LABEL_KEY: Record<StatusComponent['key'], MessageKey> = {
  web: 'console.status.overview.label-component-web',
  calls: 'console.status.overview.label-component-calls',
  documents: 'console.status.overview.label-component-documents',
  console: 'console.status.overview.label-component-console',
  identity: 'console.status.overview.label-component-identity',
  mail: 'console.status.overview.label-component-mail',
}

/** The component's name, in the catalogue's own customer vocabulary. */
export function componentNameKey(key: StatusComponent['key']): MessageKey {
  return LABEL_KEY[key]
}

const STATE_LABEL_KEY: Record<ComponentState, MessageKey> = {
  operational: 'console.status.overview.status-component-operational',
  degraded: 'console.status.overview.status-component-degraded',
  // The catalogue has one word for both outage severities — "Interrompu" —
  // the customer distinction the design draws is working vs. not, not the
  // staff distinction between a partial and a major outage.
  partial_outage: 'console.status.overview.status-component-down',
  major_outage: 'console.status.overview.status-component-down',
  maintenance: 'console.status.overview.status-component-maintenance',
}

const PILL_STATE: Record<ComponentState, StatusPillState> = {
  operational: 'success',
  degraded: 'warning',
  partial_outage: 'danger',
  major_outage: 'danger',
  maintenance: 'neutral',
}

/**
 * A state outside the five the contract declares is never rendered as
 * operational (docs/specs/02-status.md §8, the validation-rule table): a
 * value this module does not recognise reads as "État inconnu" on a neutral
 * pill, both here for the defensive case a future contract value would hit.
 */
export function componentStateLabelKey(state: string): MessageKey {
  return (
    (STATE_LABEL_KEY as Partial<Record<string, MessageKey>>)[state] ??
    'console.status.overview.status-component-unknown'
  )
}

export function componentPillState(state: string): StatusPillState {
  return (PILL_STATE as Partial<Record<string, StatusPillState>>)[state] ?? 'neutral'
}

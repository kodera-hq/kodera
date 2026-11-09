// The shell's one banner slot (docs/specs/00-shell-and-login.md §4.5):
// "At most one banner at a time, chosen by this precedence: offline →
// session about to expire → platform incident affecting this tenant →
// dunning (invoice overdue) → capacity ≥ 90 % → maintenance announced."
// Kept pure and framework-free so the precedence itself — the part a wrong
// reading of the spec gets subtly wrong — is unit-tested directly rather
// than only through a rendered component.

import type { components } from '../api/schema'

export type StatusSummary = components['schemas']['OrganisationStatusSummary']
export type StatusComponent = components['schemas']['StatusComponent']

export type BannerKind =
  'offline' | 'session-expiring' | 'incident' | 'dunning' | 'capacity' | 'maintenance'

export interface BannerDecisionInput {
  offline: boolean
  sessionExpiring: boolean
  statusSummary: StatusSummary | undefined
  /** Components whose incident the page on screen is already announcing in
   * its own banner (`./incidentBannerClaim.tsx`). An incident on one of these
   * is not repeated in the slot; the precedence continues below it. An
   * incident on any other component keeps the slot. */
  incidentsShownByPage?: readonly string[]
}

export type BannerDecision =
  | { kind: 'offline' }
  | { kind: 'session-expiring' }
  | { kind: 'incident'; component: StatusComponent }
  | { kind: 'dunning' }
  | { kind: 'capacity' }
  | { kind: 'maintenance' }

const INCIDENT_OVERALL_STATES = new Set(['degraded', 'partial_outage', 'major_outage'])

function firstAffectedComponent(summary: StatusSummary): StatusComponent | undefined {
  return summary.components.find((component) => INCIDENT_OVERALL_STATES.has(component.state))
}

/**
 * The one function the shell's status banner renders from. Returns
 * `undefined` when nothing in the precedence applies — the state matrix's
 * "Default" row, no banner at all.
 */
export function decideBanner(input: BannerDecisionInput): BannerDecision | undefined {
  if (input.offline) return { kind: 'offline' }
  if (input.sessionExpiring) return { kind: 'session-expiring' }

  const summary = input.statusSummary
  if (summary === undefined) return undefined

  if (INCIDENT_OVERALL_STATES.has(summary.overall)) {
    const component = firstAffectedComponent(summary)
    // `overall` reports the incident even when no single component's own
    // `state` in this page's list is one of the three affected values (a
    // platform-scope incident this organisation's own components do not
    // carry, say) — the banner still has to name SOMETHING, and the first
    // component in the list reads better than nothing does.
    const named = component ?? summary.components[0]
    if (named !== undefined && !(input.incidentsShownByPage ?? []).includes(named.key)) {
      return { kind: 'incident', component: named }
    }
  }

  const dunningState = summary.billing?.dunning_state
  if (dunningState !== undefined && dunningState !== 'current') return { kind: 'dunning' }

  const capacity = summary.capacity
  if (capacity !== null && capacity !== undefined) {
    const overThreshold = [capacity.seats, capacity.participants, capacity.storage].some(
      (dimension) => dimension.pct >= capacity.threshold_pct
    )
    if (overThreshold || capacity.upgrade_prompt) return { kind: 'capacity' }
  }

  if (summary.overall === 'maintenance' || summary.maintenance !== null) {
    if (summary.maintenance !== null && summary.maintenance !== undefined)
      return { kind: 'maintenance' }
  }

  return undefined
}

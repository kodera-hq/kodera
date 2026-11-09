// The overall pill and banner decision for a live tenant (docs/specs/
// 02-status.md §4.2, §4.3, §8). Driven by the `components[]` embedded in
// `GET /tenants/{tenant_id}/status` — always available with the main call,
// unlike the separate `/status/components` fetch the components CARD reads,
// which can fail on its own (§12 acceptance test 7) without breaking the
// pill or the banner.

import type { StatusComponent } from './components'

export type OverallState = 'healthy' | 'degraded' | 'stale' | 'unknown'

/**
 * §8: a stale heartbeat is never rendered as an outage — it wins over
 * whatever the embedded components say, since a stale agent means the
 * console cannot trust those readings either.
 */
export function overallState(
  components: readonly StatusComponent[],
  agentStale: boolean
): OverallState {
  if (agentStale) return 'stale'
  if (components.length === 0) return 'unknown'
  if (
    components.some(
      (component) => Object.hasOwn(SEVERITY, component.state) && component.state !== 'operational'
    )
  )
    return 'degraded'
  return components.some((component) => !Object.hasOwn(SEVERITY, component.state))
    ? 'unknown'
    : 'healthy'
}

const SEVERITY: Record<StatusComponent['state'], number> = {
  major_outage: 4,
  partial_outage: 3,
  degraded: 2,
  maintenance: 1,
  operational: 0,
}

/** The single worst-off component, for the banner and the pill's own
 * "{component} perturbé" text — `undefined` when every component is
 * operational. */
export function worstComponent(
  components: readonly StatusComponent[]
): StatusComponent | undefined {
  let worst: StatusComponent | undefined
  for (const component of components) {
    if (!Object.hasOwn(SEVERITY, component.state)) continue
    if (worst === undefined || SEVERITY[component.state] > SEVERITY[worst.state]) {
      worst = component
    }
  }
  return worst?.state === 'operational' ? undefined : worst
}

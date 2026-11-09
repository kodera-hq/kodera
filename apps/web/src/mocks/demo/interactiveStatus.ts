// The narrated incident fixture stays available to scenario tests. The interactive demo
// starts operational, with a consistent summary, component list and tenant status.
import { isDemoActive } from '../../app/interactiveDemo'
import * as seed from './seed'

export function demoStatusComponents(now: Date) {
  const components = seed.statusComponents(now)
  if (!isDemoActive(seed.DEMO_SLUG)) return components
  return components.map((component) => ({
    ...component,
    state: 'operational' as const,
    message_key: `status.${component.key}.operational`,
    incident_ref: null,
  }))
}

export function demoStatusSummary(now: Date) {
  const summary = seed.statusSummary(now)
  return isDemoActive(seed.DEMO_SLUG)
    ? {
        ...summary,
        overall: 'operational' as const,
        components: demoStatusComponents(now),
        open_incident_ids: [],
      }
    : summary
}

export function demoTenantStatus(now: Date) {
  const status = seed.tenantStatus(now)
  return { ...status, components: demoStatusComponents(now) }
}

export function demoIncidents(now: Date) {
  return isDemoActive(seed.DEMO_SLUG) ? [] : [seed.incident(now)]
}

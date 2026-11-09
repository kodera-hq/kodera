// The nine events of `docs/specs/02-status.md` §11, typed against this
// area's own property shapes so a call site gets a compile error for a
// misspelt bucket rather than a silently wrong payload. `track()` itself
// (`src/analytics/track.ts`) keeps a plain string name, so no area's event
// catalogue sits in a file every other area also edits.
//
// No personal data in any property here — §11: "no URL of the customer's own
// domain, no slug, no user identity". `component` is the status component's
// own key, never an address; every other property is a count, a bucket or a
// closed enum.

import { track } from '@/analytics/track'

export type TenantState = 'provisioning' | 'live' | 'degraded' | 'stale' | 'unknown'
export type ElapsedBucket = '<1h' | '1-4h' | '4-24h' | '>24h'
export type TrackedApp = 'visio' | 'docs' | 'login'
export type CapacityBucket = '90-95' | '95-100' | 'at-limit'
export type CapacityCta = 'plans' | 'talk'
export type SupportReason = 'stale' | 'step-failed' | 'late' | 'incident'

export function trackStatusViewed(tenantState: TenantState): void {
  track('status_viewed', { tenant_state: tenantState })
}

export function trackProvisioningStepSeen(stepIndex: number, elapsedBucket: ElapsedBucket): void {
  track('status_provisioning_step_seen', {
    step_index: stepIndex,
    elapsed_bucket: elapsedBucket,
  })
}

export function trackAppUrlCopied(app: TrackedApp): void {
  track('status_app_url_copied', { app })
}

export function trackAppOpened(app: TrackedApp): void {
  track('status_app_opened', { app })
}

export function trackIncidentOpened(component: string): void {
  track('status_incident_opened', { component })
}

export function trackCapacityThresholdShown(bucket: CapacityBucket): void {
  track('status_capacity_threshold_shown', { bucket })
}

export function trackCapacityCtaClicked(cta: CapacityCta): void {
  track('status_capacity_cta_clicked', { cta })
}

export function trackSupportFromStatus(reason: SupportReason): void {
  track('status_support_from_status', { reason })
}

export function trackHistoryOpened(): void {
  track('status_history_opened', {})
}

// The eight events of docs/specs/08-home.md §11, typed against this
// screen's own property shapes so a call site gets a compile error for a
// misspelt bucket rather than a silently-dropped event. `track()` itself
// (src/analytics/track.ts) stays a plain `(event: string, properties) =>
// void` so no area's event catalogue lives in a file every other area's
// builder also has to edit.
//
// No personal data in any property here: no email, no display name, no
// organisation name, no custom domain, no slug — every property below is a
// count, a bucket or a closed enum.

import { track } from '../../analytics/track'

export type TenantState = 'provisioning' | 'active' | 'degraded'
export type CapacityBucket = 'under-90' | '90-99' | 'at-limit'
export type InvitationsBucket = '1-4' | '5-19' | '20+'
export type CardLink = 'capacity' | 'invoice' | 'availability' | 'contract' | 'support'
export type HomeApp = 'visio' | 'docs'
export type CardErrorReason = 'unavailable' | 'forbidden' | 'offline'

export function trackHomeViewed(tenantState: TenantState, cardsRendered: number): void {
  track('home_viewed', { tenant_state: tenantState, cards_rendered: cardsRendered })
}

export function trackInvitationsBannerShown(bucket: InvitationsBucket): void {
  track('home_invitations_banner_shown', { bucket })
}

export function trackInvitationsResent(attempted: number, succeeded: number, failed: number): void {
  track('home_invitations_resent', { attempted, succeeded, failed })
}

export function trackCapacityStateShown(bucket: CapacityBucket): void {
  track('home_capacity_state_shown', { bucket })
}

export function trackCardLinkClicked(card: CardLink): void {
  track('home_card_link_clicked', { card })
}

export function trackAppOpened(app: HomeApp): void {
  track('home_app_opened', { app })
}

export function trackAppUrlCopied(app: HomeApp): void {
  track('home_app_url_copied', { app })
}

export function trackCardErrorShown(card: string, reason: CardErrorReason): void {
  track('home_card_error_shown', { card, reason })
}

/** `capacity.participants.pct` → the bucket §11 asks `home_capacity_state_shown`
 * to carry. Pure so it is testable without mounting the capacity card. */
export function capacityBucket(pct: number): CapacityBucket {
  if (pct >= 100) return 'at-limit'
  if (pct >= 90) return '90-99'
  return 'under-90'
}

/** How many pending invitations last sent more than 72 hours ago the banner counts,
 * bucketed the same way `home_invitations_banner_shown` reports it. */
export function invitationsBucket(count: number): InvitationsBucket {
  if (count >= 20) return '20+'
  if (count >= 5) return '5-19'
  return '1-4'
}

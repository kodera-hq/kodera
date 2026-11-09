// The three discovery events of `docs/specs/00-shell-and-login.md` §11,
// typed against this area's own property shapes so a call site gets a
// compile error for a misspelt reason rather than a silently wrong payload.
// `track()` itself (`src/analytics/track.ts`) keeps a plain string name, so
// no area's event catalogue sits in a file every other area also edits.
//
// No personal data in any property here: no email address, no display name,
// no organisation name, no slug. `kind` says which FORM was submitted, never
// what was typed into it, and `count` is a number of choices offered.

import { track } from '../../analytics/track'

export type DiscoveryKind = 'email' | 'slug'
export type DiscoveryFailureReason = 'domain-unknown' | 'slug-unknown' | 'rate-limited'

export function trackDiscoverySubmitted(kind: DiscoveryKind): void {
  track('login_discovery_submitted', { kind })
}

export function trackDiscoveryFailed(kind: DiscoveryKind, reason: DiscoveryFailureReason): void {
  track('login_discovery_failed', { kind, reason })
}

export function trackOrganisationChosen(count: number): void {
  track('login_organisation_chosen', { count })
}

// The four shell-level events of `docs/specs/00-shell-and-login.md` §11 —
// the ones raised by the frame every area renders inside rather than by any
// one area: the status banner, the organisation switcher, the session-expiry
// dialog and the help affordance. `src/features/<area>/analytics.ts` is where
// an area declares its own; this is the same layer for the shell, which is
// not a feature directory but is an area all the same.
//
// No personal data: a banner kind, a count of memberships, a dialog outcome,
// and for `help_opened` the area and screen names the console itself uses —
// never an organisation name or slug.

import { track } from '../analytics/track'

export type StatusBannerKind = 'offline' | 'incident' | 'dunning' | 'capacity' | 'maintenance'
export type SessionExpiryOutcome = 'extended' | 'signed-out' | 'ignored'

export function trackStatusBannerShown(kind: StatusBannerKind): void {
  track('status_banner_shown', { kind })
}

export function trackOrganisationSwitched(membershipCount: number): void {
  track('organisation_switched', { membership_count: membershipCount })
}

export function trackSessionExpiryDialogShown(outcome: SessionExpiryOutcome): void {
  track('session_expiry_dialog_shown', { outcome })
}

/** §11 names this event; no screen raises it yet. It is declared here so the
 * first one to grow a help affordance calls the shell's own function rather
 * than inventing a second spelling of the same event. */
export function trackHelpOpened(area: string, screen: string): void {
  track('help_opened', { area, screen })
}

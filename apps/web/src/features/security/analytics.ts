// The three enrolment events of `docs/specs/00-shell-and-login.md` §11.
// They live here rather than under `features/login` because the guide they
// come from is a security screen a signed-in person is held on, not part of
// the sign-in flow itself.
//
// No personal data: `method` is the factor kind, `step` is the point in the
// guide that was abandoned, `attempts` is a count. Nothing identifies who.

import { track } from '../../analytics/track'

export type MfaMethod = 'passkey' | 'totp'

export function trackEnrolmentStarted(method: MfaMethod): void {
  track('mfa_enrolment_started', { method })
}

export function trackEnrolmentCompleted(method: MfaMethod, attempts: number): void {
  track('mfa_enrolment_completed', { method, attempts })
}

export function trackEnrolmentAbandoned(method: MfaMethod, step: string): void {
  track('mfa_enrolment_abandoned', { method, step })
}

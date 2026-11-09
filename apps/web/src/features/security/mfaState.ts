// A local flag is a demonstration convenience, never proof of a real factor.
// Keep the literal build-time conditions here as well as on the lazy screen:
// forged storage must be ignored even if the production route is opened directly.
const MFA_ENROLLED_KEY = 'kodera.web.mfa.enrolledLocally'

export function isMfaEnrolledLocally(): boolean {
  if (import.meta.env.VITE_AUTH_MODE === 'mock' && import.meta.env.VITE_ENABLE_MSW === '1') {
    return window.sessionStorage.getItem(MFA_ENROLLED_KEY) === '1'
  }
  return false
}

export function markMfaEnrolledLocally(): void {
  if (import.meta.env.VITE_AUTH_MODE === 'mock' && import.meta.env.VITE_ENABLE_MSW === '1') {
    window.sessionStorage.setItem(MFA_ENROLLED_KEY, '1')
  }
}

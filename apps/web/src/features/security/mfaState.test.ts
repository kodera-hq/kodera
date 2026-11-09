import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMfaEnrolledLocally, markMfaEnrolledLocally } from './mfaState'

const LOCAL_FLAG = 'kodera.web.mfa.enrolledLocally'
afterEach(() => {
  vi.unstubAllEnvs()
  sessionStorage.clear()
})

describe('MFA local simulation boundary', () => {
  it.each([
    ['oidc', '0'],
    ['oidc', '1'],
    ['mock', '0'],
  ])('rejects forged enrollment for auth=%s, MSW=%s', (auth, msw) => {
    vi.stubEnv('VITE_AUTH_MODE', auth)
    vi.stubEnv('VITE_ENABLE_MSW', msw)
    sessionStorage.setItem(LOCAL_FLAG, '1')
    expect(isMfaEnrolledLocally()).toBe(false)
    sessionStorage.clear()
    markMfaEnrolledLocally()
    expect(sessionStorage.getItem(LOCAL_FLAG)).toBeNull()
  })

  it('permits local completion only for the explicit mock plus MSW configuration', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'mock')
    vi.stubEnv('VITE_ENABLE_MSW', '1')
    expect(isMfaEnrolledLocally()).toBe(false)
    markMfaEnrolledLocally()
    expect(isMfaEnrolledLocally()).toBe(true)
  })
})

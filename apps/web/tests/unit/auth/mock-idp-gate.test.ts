import { describe, expect, it } from 'vitest'
import { mockIdpEnabled } from '@/auth/mock-idp-gate'

// The security boundary ADR-0007 calls out by name: "anything reachable in a
// production build that fabricates an authorization code would be a real
// vulnerability, so the gate is a test of its own, not a comment." This is
// that test — the pure decision, isolated from the router and from
// `import.meta.env`, so it cannot pass by accident of some other module's
// state.
describe('mockIdpEnabled', () => {
  it('is true only when MSW is enabled AND the auth mode is mock', () => {
    expect(mockIdpEnabled(true, 'mock')).toBe(true)
  })

  it('is false when MSW is enabled but the auth mode is oidc', () => {
    expect(mockIdpEnabled(true, 'oidc')).toBe(false)
  })

  it('is false when the auth mode is mock but MSW is disabled', () => {
    expect(mockIdpEnabled(false, 'mock')).toBe(false)
  })

  it('is false when neither condition holds', () => {
    expect(mockIdpEnabled(false, 'oidc')).toBe(false)
  })
})

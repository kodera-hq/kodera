import { describe, expect, it } from 'vitest'
import { messagingDemoEnabled } from '@/features/messaging/demo-gate'

// The messaging demo preview is a picture of Tchap, the La Suite messaging
// service kodera.io integrates — not a messenger this repository
// implements. A fictional conversation reachable inside a customer's own
// production console would claim a product that does not exist here, so the
// decision is a test of its own rather than a comment, isolated from the
// router and from `import.meta.env` so it cannot pass by accident of some
// other module's state.
describe('messagingDemoEnabled', () => {
  it('is true only when MSW is enabled AND the auth mode is mock', () => {
    expect(messagingDemoEnabled(true, 'mock')).toBe(true)
  })

  it('is false when MSW is enabled but the auth mode is oidc', () => {
    expect(messagingDemoEnabled(true, 'oidc')).toBe(false)
  })

  it('is false when the auth mode is mock but MSW is disabled', () => {
    expect(messagingDemoEnabled(false, 'mock')).toBe(false)
  })

  it('is false when neither condition holds', () => {
    expect(messagingDemoEnabled(false, 'oidc')).toBe(false)
  })
})

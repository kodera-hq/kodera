import type { AuthMode } from '../config'

/**
 * Whether `/__mock-idp/authorize` and the MSW auth handlers may register.
 *
 * ADR-0007: "anything reachable in a production build that fabricates an
 * authorization code would be a real vulnerability" — a page that always
 * shows a "Continuer" button and hands back a code is exactly that. Both
 * conditions are required: `authMode` alone would still ship the route
 * whenever someone flips `VITE_ENABLE_MSW` on to point the mock build at a
 * real Core API for another reason, and `mswEnabled` alone would ship it
 * whenever the mock build talks to a real identity provider.
 *
 * Kept as a pure function, isolated from `import.meta.env` and from the
 * router, so the security boundary itself (`tests/unit/auth/mock-idp-gate.test.ts`)
 * cannot pass by accident of some other module's state.
 */
export function mockIdpEnabled(enableMsw: boolean, mode: AuthMode): boolean {
  return enableMsw && mode === 'mock'
}

// A test-only escape hatch for `session-expiry` (docs/specs/
// 00-shell-and-login.md §4.7, acceptance test 6): "a session whose refresh
// fails while a form is filled." The mocked realm's tokens are five minutes
// long (`src/mocks/auth.ts`'s `EXPIRES_IN_S`) and nothing in this build can
// make Keycloak's own clock run faster, so an end-to-end spec needs a way to
// make the CURRENT session look expired without a page reload — a reload
// would also discard the very form state the test exists to prove survives.
//
// Gated exactly like `mockIdpEnabled` (`src/auth/mock-idp-gate.ts`), and for
// the same reason: a function reachable in a production build that forges a
// signed-out session on demand is a real vulnerability, not a convenience.

import { authAdapter } from './oidc'

export interface KoderaTestHooks {
  /** Clears the in-memory session and fires a `focus` event, which is what
   * `SessionExpiryProvider`'s own silent-refresh check listens for
   * (`src/auth/sessionExpiry.tsx`) — the same signal a real failed refresh
   * would produce, without waiting for one. */
  expireSession: () => Promise<void>
}

declare global {
  interface Window {
    __koderaTestHooks__?: KoderaTestHooks
  }
}

export function installTestHooks(): void {
  window.__koderaTestHooks__ = {
    expireSession: async () => {
      await authAdapter.signOut()
      window.dispatchEvent(new Event('focus'))
    },
  }
}

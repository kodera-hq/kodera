// The seam ADR-0007 draws: the rest of the application sees only this
// interface, never oidc-client-ts directly. A reviewer can check the
// boundary by grep — an import of the library outside `src/auth/` is wrong,
// and so is a screen that reaches for a token any other way
// (docs/dev/API_CLIENT.md: short-lived, in memory, never in `localStorage`,
// never in a log or an error report).
//
// `src/auth/oidc.ts` implements this against the real identity provider;
// `src/auth/mock-idp.tsx` and `src/mocks/auth.ts` are what the SAME
// implementation talks to under `VITE_AUTH_MODE=mock` — the mock swaps out
// the identity provider, not this interface (ADR-0007's whole point).

/** Processed SDK claims bound to the configured provider; not server authorization. */
export interface AuthIdentity {
  readonly issuer: string
  readonly subject: string
}

export interface AuthUser {
  readonly identity?: AuthIdentity
  readonly realm: string
}

export type AuthCallbackResult = 'interactive' | 'silent'

export interface AuthSessionSnapshot {
  readonly status: 'pending' | 'ready' | 'unauthenticated'
  readonly user: AuthUser | undefined
  readonly generation: number
  /** Changes only when usable access-token bytes change or disappear. */
  readonly credentialGeneration: number
}

/** The two protected popup sign-ins: the first-owner claim, and an invitation's acceptance
 * (docs/specs/12-invitation-accept.md). Both keep their secret in the opener's memory. */
export type ProtectedSignInPurpose = 'owner-claim' | 'invitation'

export interface OwnerClaimAuthContext {
  readonly purpose: ProtectedSignInPurpose
  readonly intentId: string
  readonly organisationId: string
  readonly organisationSlug: string
  readonly realm: string
}

export interface ProtectedAuthOperation {
  readonly completed: Promise<void>
  cancel(): void
}

export interface OwnerClaimAuthCapability {
  begin(context: OwnerClaimAuthContext): ProtectedAuthOperation
  notifyCallback(): Promise<void>
}

export interface AuthAdapter {
  readonly ownerClaimAuth?: OwnerClaimAuthCapability

  /** Stable until a session notification; tokens still come from getAccessToken. */
  getSnapshot: () => AuthSessionSnapshot
  subscribe: (listener: () => void) => () => void
  /** One lazy silent SSO attempt per session generation. */
  restoreSession: () => Promise<boolean>

  /** The current access token, or `undefined` when no session is live. */
  getAccessToken: () => string | undefined

  /** Absolute access-token expiry in milliseconds, when known. */
  getExpiresAt: () => number | undefined

  /** Renews through the identity SDK; false means no valid renewed session. */
  renew: () => Promise<boolean>

  /** Notifications belong only to the current adapter session. */
  onRenewed: (callback: () => void) => () => void
  onRenewalFailed: (callback: () => void) => () => void

  /** The signed-in user, or `undefined` when no session is live. */
  getUser: () => AuthUser | undefined

  /**
   * Starts the login round-trip against `realm`'s tenant authority
   * (ADR-0002): the browser leaves the page. Never resolves on success —
   * the round-trip continues at `/auth/callback`.
   */
  signIn: (realm: string, options?: { registration?: boolean }) => Promise<void>

  /**
   * Dispatches the SDK transaction: interactive login starts a session; a
   * silent callback only notifies its parent, which owns the exchange.
   */
  handleCallback: () => Promise<AuthCallbackResult>

  /** Ends the local session. Logout is Keycloak's concern (ADR-0007); this
   * only clears what the console itself holds. */
  signOut: () => Promise<void>

  /**
   * Registers a callback fired shortly before the access token expires
   * (`session-expiry`, docs/specs/00-shell-and-login.md §4.7). Returns an
   * unsubscribe function.
   */
  onExpiring: (callback: () => void) => () => void
}

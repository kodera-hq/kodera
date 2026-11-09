// The real identity-provider client (ADR-0007). Nothing outside `src/auth/`
// imports `oidc-client-ts` — see `AuthAdapter.ts` for the boundary this
// implements. Under `VITE_AUTH_MODE=mock` this SAME class runs, against the
// mock identity provider (`src/auth/mock-idp.tsx`, `src/mocks/auth.ts`): the
// point of ADR-0007 is that only the identity provider is swapped, never this
// code.

import {
  ErrorResponse,
  InMemoryWebStorage,
  OidcClient,
  UserManager,
  WebStorageStateStore,
} from 'oidc-client-ts'
import type { User } from 'oidc-client-ts'
import { keycloakUrl, oidcClientId } from '../config'
import type {
  AuthAdapter,
  AuthCallbackResult,
  AuthIdentity,
  AuthSessionSnapshot,
  AuthUser,
  OwnerClaimAuthCapability,
  OwnerClaimAuthContext,
  ProtectedAuthOperation,
  ProtectedSignInPurpose,
} from './AuthAdapter'

// The realm is discovered per login (ADR-0002), so it cannot be fixed at
// construction; this is what survives the full-page redirect to carry it to
// `handleCallback`. `sessionStorage`, not `localStorage`: it is interaction
// state, the same tier oidc-client-ts's own PKCE `stateStore` uses below —
// never the access token, which stays in memory only.
const REALM_KEY = 'kodera.web.auth.realm'

function redirectUri(): string {
  return `${window.location.origin}/auth/callback`
}

// A stored hint can select one admitted realm segment under the configured
// provider. It can never supply an origin, traversal, query or fragment.
const isRealmHint = (value: string | null): value is string =>
  value !== null && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)

function readRealmHint(): string | undefined {
  try {
    const value = window.sessionStorage.getItem(REALM_KEY)
    return isRealmHint(value) ? value : undefined
  } catch {
    return undefined
  }
}

// Core accepts a login (auth_time) at most 320 s old at its decision and final read, so a claim
// commits within 330 s while Core's read-to-commit lag stays within its 10 s target, which is not
// enforced. Every protected sign-in, a claim's or an invitation's, is a new login; ordinary
// sign-ins reuse the SSO session.
export const OWNER_CLAIM_MAX_AGE_S = 0

function claimRedirectUri(): string {
  const base = import.meta.env.BASE_URL
  if (typeof base !== 'string' || !base.startsWith('/') || !base.endsWith('/'))
    throw new Error('Invalid protected callback base.')
  const url = new URL(`${base}auth/claim-callback`, window.location.origin)
  if (url.origin !== window.location.origin || url.search || url.hash)
    throw new Error('Invalid protected callback location.')
  return url.href
}

const isProtectedPurpose = (value: unknown): value is ProtectedSignInPurpose =>
  value === 'owner-claim' || value === 'invitation'

function isOwnerClaimPurpose(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return isProtectedPurpose(Object.getOwnPropertyDescriptor(value, 'purpose')?.value)
}

function claimContext(value: unknown): OwnerClaimAuthContext {
  const keys = ['purpose', 'intentId', 'organisationId', 'organisationSlug', 'realm'] as const
  if (typeof value !== 'object' || value === null || Reflect.ownKeys(value).length !== keys.length)
    throw new Error('Invalid owner-claim context.')
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      /[\r\n]/.test(descriptor.value)
    )
      throw new Error('Invalid owner-claim context.')
  }
  const context = value as OwnerClaimAuthContext
  if (
    !isProtectedPurpose(context.purpose) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(context.intentId) ||
    context.organisationId.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      context.organisationId
    ) ||
    !isRealmHint(context.organisationSlug) ||
    !isRealmHint(context.realm)
  )
    throw new Error('Invalid owner-claim context.')
  return Object.freeze({
    purpose: context.purpose,
    intentId: context.intentId,
    organisationId: context.organisationId,
    organisationSlug: context.organisationSlug,
    realm: context.realm,
  })
}

function sameClaim(left: OwnerClaimAuthContext | undefined, right: OwnerClaimAuthContext): boolean {
  return (
    left !== undefined &&
    left.purpose === right.purpose &&
    left.intentId === right.intentId &&
    left.organisationId === right.organisationId &&
    left.organisationSlug === right.organisationSlug &&
    left.realm === right.realm
  )
}

// The provider answered and refused, and no retry can succeed: an expired or
// revoked refresh token, a silent answer that needs the person (interaction,
// consent, account choice), or a request the provider will never accept.
// `login_required` is not proof: blocked third-party cookies produce it while the
// SSO session lives, and a retry can succeed. A changed subject never reaches
// here as `login_required` (see `validateSubOnSilentRenew` below). Anything else
// keeps the token for its own remaining life only.
const REFUSALS = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'account_selection_required',
  'access_denied',
  'invalid_token',
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'invalid_request',
])
const isRefusal = (error: unknown): boolean =>
  error instanceof ErrorResponse && error.error !== null && REFUSALS.has(error.error)

// A consumer's failure must neither change the session outcome nor stop the
// other consumers; it is rethrown on its own task so it still gets reported.
function notify(callbacks: Set<() => void>): void {
  for (const callback of [...callbacks]) {
    try {
      callback()
    } catch (error: unknown) {
      setTimeout(() => {
        throw error
      })
    }
  }
}

interface ClaimOperation {
  context: OwnerClaimAuthContext | undefined
  manager: UserManager | undefined
  controller: AbortController | undefined
  readonly generation: number
  readonly handle: ProtectedAuthOperation
  pending: boolean
}

interface ClaimCallback {
  url: string | undefined
  readonly result: Promise<void>
}

function managerFor(realm: string, protectedClaim = false): UserManager {
  return new UserManager({
    authority: `${keycloakUrl()}/realms/${realm}`,
    client_id: oidcClientId(),
    redirect_uri: redirectUri(),
    ...(protectedClaim ? { popup_redirect_uri: claimRedirectUri(), loadUserInfo: false } : {}),
    response_type: 'code',
    scope: 'openid profile email',
    // The access token lives in memory only, never in `localStorage`
    // (docs/dev/API_CLIENT.md) — only the PKCE interaction state has to
    // survive the redirect, and that alone goes to `sessionStorage`.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    // One adapter-owned renewal promise coordinates expiry, focus and manual
    // requests. SDK auto-renew would bypass it and race refresh-token rotation.
    automaticSilentRenew: false,
    accessTokenExpiringNotificationTimeInSeconds: 120,
    // The SDK would report another person's silent session as `login_required`.
    // Let it through so #acceptRenewedUser's issuer/subject check signs out.
    validateSubOnSilentRenew: false,
  })
}

export class OidcAuthAdapter implements AuthAdapter {
  #manager: UserManager | undefined
  #user: User | undefined
  #identity: AuthIdentity | undefined
  #realm: string | undefined
  #snapshot: AuthSessionSnapshot = {
    status: 'pending',
    user: undefined,
    generation: 0,
    credentialGeneration: 0,
  }
  #publishedAccessToken: string | undefined
  #listeners = new Set<() => void>()
  #restoration: Promise<boolean> | undefined
  #signIn: { realm: string; request: Promise<void> } | undefined
  #expiringCallbacks = new Set<() => void>()
  #unwire: (() => void) | undefined
  #renewedCallbacks = new Set<() => void>()
  #renewalFailedCallbacks = new Set<() => void>()
  #renewal: Promise<boolean> | undefined
  #refused: UserManager | undefined
  #callback: { url: string; result: Promise<AuthCallbackResult> } | undefined
  #claim: ClaimOperation | undefined
  #claimCallback: ClaimCallback | undefined

  readonly ownerClaimAuth: OwnerClaimAuthCapability = Object.freeze({
    begin: (context: OwnerClaimAuthContext) => this.#beginOwnerClaim(context),
    notifyCallback: () => this.#notifyOwnerClaim(),
  })

  getSnapshot = (): AuthSessionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #publish(status: AuthSessionSnapshot['status'], newGeneration = false): void {
    const accessToken = this.getAccessToken()
    const credentialChanged = accessToken !== this.#publishedAccessToken
    this.#publishedAccessToken = accessToken
    this.#snapshot = {
      status,
      // A refused credential keeps the public identity mounted for the expiry
      // dialog, but its credential generation still advances synchronously.
      user: status === 'ready' ? (this.getUser() ?? this.#snapshot.user) : undefined,
      generation: this.#snapshot.generation + (newGeneration ? 1 : 0),
      credentialGeneration: this.#snapshot.credentialGeneration + (credentialChanged ? 1 : 0),
    }
    for (const listener of this.#listeners) listener()
  }

  restoreSession(): Promise<boolean> {
    if (this.#claim?.pending) return Promise.resolve(false)
    if (this.getAccessToken() !== undefined) return Promise.resolve(true)
    if (this.#snapshot.status === 'ready' || this.#snapshot.status === 'unauthenticated')
      return Promise.resolve(false)
    if (this.#restoration !== undefined) return this.#restoration
    const realm = readRealmHint()
    if (realm === undefined) {
      this.#publish('unauthenticated')
      this.#restoration = Promise.resolve(false)
      return this.#restoration
    }
    this.#retireManager()
    this.#user = undefined
    this.#realm = realm
    const manager = managerFor(realm)
    this.#manager = manager
    this.#wireEvents(manager)
    this.#publish('pending', true)
    // Share the existing renewal owner; callbacks and focus must never rotate
    // credentials through a second SDK request during restoration.
    const request = this.renew().then((restored) => {
      if (this.#manager !== manager) return false
      if (!restored) {
        this.#retireManager()
        this.#publish('unauthenticated')
      }
      return restored
    })
    this.#restoration = request
    return request
  }

  getAccessToken(): string | undefined {
    return this.#user !== undefined && !this.#user.expired ? this.#user.access_token : undefined
  }

  getExpiresAt(): number | undefined {
    return this.#user?.expires_at === undefined ? undefined : this.#user.expires_at * 1000
  }

  renew(): Promise<boolean> {
    if (this.#claim?.pending) return Promise.resolve(false)
    const manager = this.#manager
    if (manager === undefined || this.#refused === manager) return Promise.resolve(false)
    if (this.#renewal !== undefined) return this.#renewal
    const request = (async () => {
      let refused = false
      try {
        const user = await manager.signinSilent()
        if (this.#manager === manager && this.#acceptRenewedUser(user)) {
          // A consumer may have ended or replaced the session while notified.
          if (this.#manager !== manager) return false
          this.#renewal = undefined
          return true
        }
      } catch (error: unknown) {
        refused = isRefusal(error)
      }
      if (this.#manager !== manager) {
        // Late work of a retired session: the SDK may have stored fresh tokens
        // in that manager. Drop them; publish and notify nothing.
        void manager.removeUser().catch(() => {})
        return false
      }
      this.#renewal = undefined
      if (refused) this.#endCredential(manager)
      notify(this.#renewalFailedCallbacks)
      return false
    })()
    this.#renewal = request
    return request
  }

  // The provider's session is over, so this credential is too: no request can
  // obtain the access token any more, and the SDK drops the refresh and ID
  // tokens. The snapshot stays ready so the expired dialog can re-authenticate
  // in place (docs/specs/00-shell-and-login.md §4.7, session-renewal-state.md).
  #endCredential(manager: UserManager): void {
    this.#refused = manager
    this.#user = undefined
    this.#publish('ready')
    void manager.removeUser().catch(() => {})
  }

  onRenewed(callback: () => void): () => void {
    this.#renewedCallbacks.add(callback)
    return () => {
      this.#renewedCallbacks.delete(callback)
    }
  }

  onRenewalFailed(callback: () => void): () => void {
    this.#renewalFailedCallbacks.add(callback)
    return () => {
      this.#renewalFailedCallbacks.delete(callback)
    }
  }

  #acceptRenewedUser(user: User | null): boolean {
    if (
      user === null ||
      !user.access_token ||
      user.expires_at === undefined ||
      !Number.isFinite(user.expires_at) ||
      user.expires_at * 1000 <= Date.now()
    )
      return false
    const nextIdentity = this.#processedIdentity(user)
    const changed = this.#user !== user
    const identityChanged =
      this.#identity !== undefined &&
      (nextIdentity === undefined ||
        this.#identity.issuer !== nextIdentity.issuer ||
        this.#identity.subject !== nextIdentity.subject)
    if (identityChanged) {
      // Router loader data outlives QueryClient entries. Do not publish a new
      // ready identity alongside the previous route's membership and role.
      // Existing unauthenticated route handling removes that protected tree.
      void this.signOut().catch(() => {})
      return false
    }
    this.#user = user
    this.#identity = nextIdentity
    if (changed) this.#publish('ready')
    if (changed) notify(this.#renewedCallbacks)
    return true
  }

  getUser(): AuthUser | undefined {
    const token = this.getAccessToken()
    const realm = this.#realm
    if (token === undefined || realm === undefined) return undefined
    return {
      realm,
      ...(this.#identity === undefined ? {} : { identity: this.#identity }),
    }
  }

  #processedIdentity(
    user: User,
    authority = this.#manager?.settings?.authority
  ): AuthIdentity | undefined {
    // The SDK preserves these protocol claims but does not check issuer equality
    // on its ID-token processing path. Compare against this manager's authority,
    // never a stored realm hint, email, token decode or new provider endpoint.
    const issuer = user.profile?.iss
    const subject = user.profile?.sub
    if (
      authority === undefined ||
      issuer !== authority ||
      typeof subject !== 'string' ||
      subject.length === 0 ||
      subject.length > 255 ||
      [...subject].some((character) => character.charCodeAt(0) > 127)
    )
      return undefined
    return Object.freeze({ issuer, subject })
  }

  async signIn(realm: string): Promise<void> {
    if (!isRealmHint(realm)) throw new Error('Invalid realm identifier.')
    if (this.#signIn?.realm === realm && this.#snapshot.status === 'pending')
      return this.#signIn.request
    this.#retireManager()
    this.#user = undefined
    this.#realm = realm
    this.#restoration = Promise.resolve(false)
    const generation = this.#snapshot.generation + 1
    // Publish the replacement boundary before storage or SDK setup can throw.
    // Queue setup so concurrent callers share the request before it starts.
    const request = Promise.resolve()
      .then(() => {
        if (this.#snapshot.generation !== generation) return
        window.sessionStorage.setItem(REALM_KEY, realm)
        const manager = managerFor(realm)
        this.#manager = manager
        this.#wireEvents(manager)
        return manager.signinRedirect()
      })
      .catch((error: unknown) => {
        if (this.#snapshot.generation === generation) {
          this.#retireManager()
          this.#user = undefined
          this.#realm = undefined
          this.#restoration = Promise.resolve(false)
          try {
            window.sessionStorage.removeItem(REALM_KEY)
          } catch {
            // Storage policy must not preserve an authenticated UI snapshot.
          }
          this.#publish('unauthenticated')
        }
        throw error
      })
    this.#signIn = { realm, request }
    this.#publish('pending', true)
    await request
  }

  handleCallback(): Promise<AuthCallbackResult> {
    if (this.#claim?.pending)
      return Promise.reject(new Error('Protected parent is already active.'))
    // React StrictMode can mount callback effects twice. A transaction's code
    // is single-use, so both callers share its result until this manager retires.
    const url = window.location.href
    if (this.#callback !== undefined) {
      return this.#callback.url === url
        ? this.#callback.result
        : Promise.reject(new Error('No matching pending callback. Start again from /login.'))
    }
    const realm = readRealmHint()
    if (realm === undefined) {
      return Promise.reject(new Error('No pending sign-in. Start again from /login.'))
    }
    const manager = this.#manager ?? managerFor(realm)
    if (this.#manager === undefined) this.#publish('pending', true)
    if (this.#claim?.pending)
      return Promise.reject(new Error('Protected parent is already active.'))
    this.#realm = realm
    this.#manager = manager
    if (this.#unwire === undefined) this.#wireEvents(manager)
    const generation = this.#snapshot.generation
    const result = (async (): Promise<AuthCallbackResult> => {
      if (new URL(url).searchParams.has('state')) {
        const inspected = await new OidcClient(
          manager.settings,
          manager.metadataService
        ).readSigninResponseState(url, false)
        if (isOwnerClaimPurpose(inspected.state.data))
          throw new Error('Use the protected owner-claim callback.')
      }
      if (this.#manager !== manager || this.#snapshot.generation !== generation)
        throw new Error('The sign-in was cancelled before its callback started.')
      // The SDK reads the stored request type. Silent callbacks notify the
      // parent through its navigator; only that parent exchanges the code.
      const user = await manager.signinCallback(url)
      if (this.#manager !== manager) {
        void manager.removeUser().catch(() => {})
        throw new Error('The sign-in was cancelled before its callback completed.')
      }
      if (user === undefined) return 'silent'
      this.#user = user
      this.#identity = this.#processedIdentity(user)
      this.#publish('ready')
      return 'interactive'
    })()
    this.#callback = { url, result }
    return result
  }

  async signOut(): Promise<void> {
    const claim = this.#claim
    if (claim !== undefined) return this.#signOutClaim(claim)
    const manager = this.#manager
    this.#user = undefined
    let retired = true
    let failure: unknown
    try {
      this.#retireManager()
    } catch (error: unknown) {
      retired = false
      failure = error
    }
    // Even SDK cleanup failure must drop the SDK-held tokens and close the
    // observed UI/route boundary.
    const removed = manager?.removeUser()
    this.#realm = undefined
    this.#publish('unauthenticated', true)
    try {
      window.sessionStorage.removeItem(REALM_KEY)
    } catch {
      // Storage policy does not prevent ending the in-memory session.
    }
    if (retired) return removed
    // Report the retirement failure, not a secondary removal one.
    await removed?.catch(() => {})
    throw failure
  }

  async #signOutClaim(claim: ClaimOperation): Promise<void> {
    const manager = this.#manager
    const errors: unknown[] = []
    this.#user = undefined
    try {
      this.#retireManager()
    } catch (error: unknown) {
      errors.push(error)
    }
    this.#realm = undefined
    try {
      this.#publish('unauthenticated', true)
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      window.sessionStorage.removeItem(REALM_KEY)
    } catch {
      this.#restoration = Promise.resolve(false)
    }
    try {
      await claim.handle.completed
    } catch (error: unknown) {
      if (error instanceof AggregateError) errors.push(error)
    }
    if (manager !== undefined) {
      try {
        await manager.removeUser()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Protected signout cleanup failed.')
  }

  onExpiring(callback: () => void): () => void {
    this.#expiringCallbacks.add(callback)
    return () => {
      this.#expiringCallbacks.delete(callback)
    }
  }

  #beginOwnerClaim(input: OwnerClaimAuthContext): ProtectedAuthOperation {
    const context = claimContext(input)
    if (this.#claim?.pending && sameClaim(this.#claim.context, context)) return this.#claim.handle
    this.#user = undefined
    try {
      this.#retireManager()
    } catch (primary: unknown) {
      this.#realm = undefined
      try {
        this.#publish('unauthenticated', true)
      } catch (cleanup: unknown) {
        throw new AggregateError([primary, cleanup], 'Protected setup and cleanup failed.')
      }
      throw primary
    }
    this.#realm = context.realm
    this.#restoration = Promise.resolve(false)
    const generation = this.#snapshot.generation + 1
    const controller = new AbortController()
    const completed = Promise.resolve().then(async () => {
      let manager: UserManager | undefined
      let failed = false
      let primary: unknown
      const cleanup: unknown[] = []
      try {
        if (this.#claim !== operation || !operation.pending)
          throw new Error('Owner-claim sign-in cancelled.')
        window.sessionStorage.setItem(REALM_KEY, context.realm)
        const authority = `${keycloakUrl()}/realms/${context.realm}`
        const clientId = oidcClientId()
        const callbackUri = claimRedirectUri()
        manager = managerFor(context.realm, true)
        operation.manager = manager
        this.#manager = manager
        this.#wireEvents(manager)
        const user = await manager.signinPopup({
          state: context,
          popupSignal: controller.signal,
          // A new login for both: Core decides a claim on a recent one, and an invitation is
          // accepted by whoever signs in, never by a session already open in this browser.
          max_age: OWNER_CLAIM_MAX_AGE_S,
          // Without it the SDK notices a closed popup and still waits for its answer, and the
          // page that opened it waits with it, for ever. It reads `window.closed`, which is true
          // across a Cross-Origin-Opener-Policy: under one, on the console or the realm's pages,
          // every popup sign-in aborts after 0.5 s. The serving test refuses the header here;
          // the realm's pages are Keycloak's.
          popupAbortOnClose: true,
        })
        const identity = this.#processedIdentity(user, authority)
        if (
          identity === undefined ||
          manager.settings.authority !== authority ||
          manager.settings.client_id !== clientId ||
          manager.settings.popup_redirect_uri !== callbackUri ||
          !sameClaim(claimContext(user.state), context) ||
          !user.access_token ||
          user.expires_at === undefined ||
          !Number.isFinite(user.expires_at) ||
          user.expires_at * 1000 <= Date.now()
        )
          throw new Error('Invalid protected sign-in result.')
        if (!this.#isCurrentClaim(operation)) throw new Error('Owner-claim sign-in cancelled.')
        this.#user = user
        this.#identity = identity
        this.#realm = context.realm
        operation.pending = false
        operation.context = undefined
        operation.manager = undefined
        operation.controller = undefined
        this.#claim = undefined
        this.#publish('ready')
      } catch (error: unknown) {
        failed = true
        primary = error
      }
      if (failed) {
        if (
          this.#claim === operation ||
          (manager !== undefined &&
            this.#manager === manager &&
            this.#snapshot.generation === generation)
        ) {
          this.#user = undefined
          try {
            this.#retireManager()
          } catch (error: unknown) {
            cleanup.push(error)
          }
          this.#realm = undefined
          try {
            this.#publish('unauthenticated')
          } catch (error: unknown) {
            cleanup.push(error)
          }
        }
        if (manager !== undefined) {
          try {
            await manager.removeUser()
          } catch (error: unknown) {
            cleanup.push(error)
          }
        }
      }
      operation.pending = false
      operation.context = undefined
      operation.manager = undefined
      operation.controller = undefined
      if (failed && cleanup.length) {
        const secondary =
          cleanup.length === 1
            ? cleanup[0]
            : new AggregateError(cleanup, 'Protected sign-in cleanup failed.')
        throw new AggregateError([primary, secondary], 'Protected sign-in and cleanup failed.')
      }
      if (failed) throw primary
    })
    void completed.catch(() => {})
    const handle: ProtectedAuthOperation = Object.freeze({
      completed,
      cancel: () => this.#cancelOwnerClaim(operation),
    })
    const operation: ClaimOperation = {
      context,
      manager: undefined,
      controller,
      generation,
      handle,
      pending: true,
    }
    this.#claim = operation
    try {
      this.#publish('pending', true)
    } catch (primary: unknown) {
      const cleanup: unknown[] = []
      if (this.#claim === operation) {
        try {
          this.#retireManager()
        } catch (error: unknown) {
          cleanup.push(error)
        }
        this.#realm = undefined
        try {
          this.#publish('unauthenticated')
        } catch (error: unknown) {
          cleanup.push(error)
        }
      }
      if (cleanup.length) {
        const secondary =
          cleanup.length === 1
            ? cleanup[0]
            : new AggregateError(cleanup, 'Protected publication cleanup failed.')
        throw new AggregateError([primary, secondary], 'Protected publication and cleanup failed.')
      }
      throw primary
    }
    return handle
  }

  #cancelOwnerClaim(operation: ClaimOperation): void {
    if (this.#claim !== operation) return
    const errors: unknown[] = []
    this.#user = undefined
    try {
      this.#retireManager()
    } catch (error: unknown) {
      errors.push(error)
    }
    this.#realm = undefined
    try {
      this.#publish('unauthenticated', true)
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      window.sessionStorage.removeItem(REALM_KEY)
    } catch {
      this.#restoration = Promise.resolve(false)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
      throw new AggregateError(errors, 'Protected cancellation cleanup failed.')
  }

  #isCurrentClaim(operation: ClaimOperation): boolean {
    return (
      this.#claim === operation &&
      operation.pending &&
      operation.context !== undefined &&
      operation.manager !== undefined &&
      this.#manager === operation.manager &&
      this.#realm === operation.context.realm &&
      this.#snapshot.generation === operation.generation &&
      operation.controller !== undefined &&
      !operation.controller.signal.aborted
    )
  }

  #notifyOwnerClaim(): Promise<void> {
    if (this.#claim?.pending)
      return Promise.reject(new Error('Protected parent is already active.'))
    if (this.#claimCallback !== undefined) {
      return this.#claimCallback.url === window.location.href
        ? this.#claimCallback.result
        : Promise.reject(new Error('No matching protected callback.'))
    }
    const realm = readRealmHint()
    if (realm === undefined) return Promise.reject(new Error('No pending protected sign-in.'))
    const manager = this.#manager ?? managerFor(realm, true)
    this.#manager = manager
    this.#realm = realm
    const result = Promise.resolve().then(async () => {
      try {
        // Every retirement clears the URL, so this also fences sign-out and replacement.
        if (callback.url === undefined || this.#claimCallback !== callback)
          throw new Error('Protected callback cancelled.')
        // A popup's sessionStorage is copied when it opens, before the SDK stores
        // the request state, so nothing here may read the state store. The parent's
        // signinPopup validates state and PKCE, and #beginOwnerClaim the context.
        const response = new URL(callback.url)
        if (
          response.origin + response.pathname !== claimRedirectUri() ||
          !response.searchParams.get('state') ||
          !(response.searchParams.get('code') || response.searchParams.get('error'))
        )
          throw new Error('Invalid protected callback state.')
        await manager.signinPopupCallback(callback.url)
      } finally {
        callback.url = undefined
        if (this.#claimCallback === callback) this.#claimCallback = undefined
      }
    })
    const callback: ClaimCallback = { url: window.location.href, result }
    this.#claimCallback = callback
    void result.catch(() => {})
    return result
  }

  #wireEvents(manager: UserManager): void {
    const expiring = () => {
      if (this.#manager !== manager) return
      if (this.#claim !== undefined && this.#claim.pending) return
      notify(this.#expiringCallbacks)
      void this.renew()
    }
    const loaded = (user: User) => {
      if (this.#manager !== manager) return
      if (this.#claim?.pending) return
      this.#acceptRenewedUser(user)
    }
    const expired = () => {
      if (this.#manager !== manager) return
      if (this.#claim?.pending) return
      // A transient renewal failure preserves the credential only for its
      // remaining lifetime. Once the SDK observes actual expiry, publish the
      // unavailable-token boundary even if the shared renewal is still in
      // flight; a later fresh result will publish the next credential.
      if (this.#user === undefined || this.getAccessToken() !== undefined) return
      this.#user = undefined
      this.#publish('ready')
      notify(this.#renewalFailedCallbacks)
    }
    manager.events.addAccessTokenExpiring(expiring)
    manager.events.addAccessTokenExpired(expired)
    manager.events.addUserLoaded(loaded)
    this.#unwire = () => {
      manager.events.removeAccessTokenExpiring(expiring)
      manager.events.removeAccessTokenExpired(expired)
      manager.events.removeUserLoaded(loaded)
    }
  }

  #retireManager(): UserManager | undefined {
    const manager = this.#manager
    const claim = this.#claim
    this.#claim = undefined
    if (claim !== undefined) {
      claim.pending = false
      claim.context = undefined
      claim.manager = undefined
      const controller = claim.controller
      claim.controller = undefined
      controller?.abort(new Error('Owner-claim sign-in cancelled.'))
    }
    if (this.#claimCallback !== undefined) this.#claimCallback.url = undefined
    this.#claimCallback = undefined
    this.#manager = undefined
    this.#identity = undefined
    this.#renewal = undefined
    this.#refused = undefined
    this.#restoration = undefined
    this.#signIn = undefined
    this.#callback = undefined
    this.#unwire?.()
    this.#unwire = undefined
    manager?.stopSilentRenew()
    return manager
  }
}

/**
 * The one adapter instance for the life of the application. `AuthProvider`
 * wraps this for React; `src/app/routeTree.ts` reads it directly in route
 * guards (`beforeLoad`), which run outside the React tree and have no other
 * way to ask "is there a session" before a route commits to rendering.
 */
export const authAdapter: AuthAdapter = new OidcAuthAdapter()

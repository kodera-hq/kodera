// The identity SDK (`oidc-client-ts`), fetched when a sign-in needs it rather than delivered with
// the application.
//
// A first visit shows `/login` without it: `restoreSession` finds no realm to restore and never
// builds a `UserManager`. The SDK arrives when the adapter is first asked for something only it
// can do — restoring a session this tab already had, starting a sign-in, answering a callback.
// `src/auth/oidc.ts` is the only module that calls into this one, so "nothing outside `src/auth/`
// imports `oidc-client-ts`" (ADR-0007) still reads the same way.
//
// `scripts/check-bundle-budget.mjs` fails a build whose entry holds the SDK.

import type * as Sdk from 'oidc-client-ts'

export type OidcSdk = typeof Sdk

let loaded: OidcSdk | undefined
let request: Promise<void> | undefined

/** Whether the SDK is here, so an adapter method can go on without yielding. */
export function oidcSdkLoaded(): boolean {
  return loaded !== undefined
}

/** The SDK. Only for a path that has already waited for `loadOidcSdk`. */
export function oidcSdk(): OidcSdk {
  if (loaded === undefined) throw new Error('The identity SDK was used before it was loaded.')
  return loaded
}

/** Fetches the SDK once. A failed fetch is forgotten, so the next caller tries again. */
export function loadOidcSdk(): Promise<void> {
  if (loaded !== undefined) return Promise.resolve()
  request ??= import('oidc-client-ts').then(
    (sdk) => {
      loaded = sdk
    },
    (error: unknown) => {
      request = undefined
      throw error
    }
  )
  return request
}

// The unit suite reads the adapter's transitions in the very task that causes them, which only
// holds with the SDK in hand: it is fetched before any test can construct an adapter. A literal
// comparison, so a build folds this away and the SDK stays a separate, deferred file.
if (import.meta.env.MODE === 'test') await loadOidcSdk()

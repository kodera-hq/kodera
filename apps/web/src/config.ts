// The single reader of the environment for values the console computes with.
// Nothing else touches `import.meta.env` for those.
//
// Anything Vite exposes must start with `VITE_` and is inlined into the bundle at
// build time, so it is public by construction: no secret is ever read here, and the
// console holds none (README.md). A misspelt or unset name is `undefined` at runtime
// rather than an error, which is why every required variable is read through
// `required()` and fails with its own name in the message.
//
// Each variable below is read as `import.meta.env.VITE_X` — a static property
// access, not `import.meta.env[name]` with a variable key. Vite's env-replace
// plugin only substitutes the literal build-time value for the former; a
// computed key survives into the bundle as a real property lookup, which is
// exactly what let PR #35's production build still throw
// `VITE_CORE_API_URL is not set` style errors aside — worse, it let two
// modules that must never ship (`src/app/mock-idp-route.tsx`,
// `src/mocks/browser.ts`) stay statically reachable, because the `if` that
// was supposed to exclude them could only be evaluated at runtime, never
// folded away at build time. `src/app/routeTree.ts` and `src/main.tsx`
// deliberately read `import.meta.env.VITE_ENABLE_MSW` / `VITE_AUTH_MODE`
// again, inline, right next to the dynamic `import()` they guard, rather
// than calling into this file — see the comment there for why.
const read = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const required = (value: unknown, name: string): string => {
  const v = read(value)
  if (v === undefined) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in; a Vite variable that is ` +
        'absent is `undefined` at runtime, not an error, so this is the only place it can be caught.'
    )
  }
  return v
}

/**
 * The one backend the console is allowed to call (ADR-0003), version prefix included:
 * `http://localhost:8000/api/v1`.
 */
export const coreApiUrl = (): string =>
  required(import.meta.env.VITE_CORE_API_URL, 'VITE_CORE_API_URL')

/**
 * Keycloak base URL. No realm: tenant admins authenticate against their own tenant
 * realm, resolved at runtime from the organisation slug or the email domain (ADR-0002).
 */
export const keycloakUrl = (): string =>
  required(import.meta.env.VITE_KEYCLOAK_URL, 'VITE_KEYCLOAK_URL')

/** Whether to serve the Core API from the generated mocks instead of the network. */
export const mswEnabled = (): boolean => read(import.meta.env.VITE_ENABLE_MSW) === '1'

const AUTH_MODES = ['oidc', 'mock'] as const

export type AuthMode = (typeof AUTH_MODES)[number]

/**
 * `oidc` talks to the real identity provider through `src/auth/oidc.ts`. `mock`
 * selects the test identity provider behind the same `AuthAdapter` interface
 * (ADR-0007) — the mock IdP route and its MSW handlers only ever register when
 * this is `mock`, which is also why an unrecognised value is refused here rather
 * than silently falling through to one of the two.
 */
export const authMode = (): AuthMode => {
  const value = required(import.meta.env.VITE_AUTH_MODE, 'VITE_AUTH_MODE')
  if ((AUTH_MODES as readonly string[]).includes(value)) return value as AuthMode
  throw new Error(`VITE_AUTH_MODE must be "oidc" or "mock", got "${value}".`)
}

/**
 * The console's public OIDC client id. Public like every `VITE_` value; PKCE is
 * what makes a public client safe (ADR-0007).
 */
export const oidcClientId = (): string =>
  required(import.meta.env.VITE_OIDC_CLIENT_ID, 'VITE_OIDC_CLIENT_ID')

/**
 * The domain every organisation's Matrix server name sits under (console ADR-0012):
 * `{organisation slug}.{matrix domain}`, `kodera.io` in production. Unset, the Console offers no
 * live Espace, only the workspace's layout. Validated where it is used
 * (`src/features/espace/homeserver.ts`), so a mistyped value is shown, not thrown at boot.
 */
export const matrixDomain = (): string | undefined => read(import.meta.env.VITE_MATRIX_DOMAIN)

/**
 * The DNS name a tenant's address sits under: Core gives a tenant `https://{slug}.{tenant domain}`
 * (kodera-core `KODERA_TENANT_APP_URLS`), and the order's contacts step previews that address
 * (`src/features/order/tenantAddress.ts`). `staging.kodera.io` on staging. Unset, the order names
 * no domain rather than a wrong one. Validated where it is used, like the matrix domain.
 */
export const tenantDomain = (): string | undefined => read(import.meta.env.VITE_TENANT_DOMAIN)

/**
 * The local stack's homeserver, a plain-HTTP origin on this machine, used in place of discovery.
 * Read in a development build only: `import.meta.env.DEV` is the literal `false` in a production
 * build, so the minifier drops the read and the value never reaches the bundle
 * (`scripts/check-production-bundle.sh`).
 */
export const espaceDevHomeserver = (): string | undefined =>
  import.meta.env.DEV ? read(import.meta.env.VITE_ESPACE_DEV_HOMESERVER) : undefined

/**
 * The local stack's Matrix server name, the part after `:` in its users' IDs: `kodera.test` when
 * unset (`tests/espace/stack/synapse/homeserver.yaml.tmpl`). Used with `espaceDevHomeserver` only,
 * and read in a development build only, like it.
 */
export const espaceDevServerName = (): string | undefined =>
  import.meta.env.DEV ? read(import.meta.env.VITE_ESPACE_DEV_SERVER_NAME) : undefined

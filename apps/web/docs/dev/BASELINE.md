# Tech baseline

**Frozen: the architecture paragraph and stack table, the pins that lag on purpose, and the Environment list.** A change to any of them is an ADR, not a pull request — Environment already works this way in practice (ADR-0007 added `VITE_AUTH_MODE` and `VITE_OIDC_CLIENT_ID` to the list below; ADR-0002's "no realm" note lives on the `VITE_KEYCLOAK_URL` line). Commands and What is not here yet are status text, not frozen: they change as work ships, without an ADR.

The console is a React single-page application talking to the Core API (ADR-0003). Espace's chat talks to the workspace's Synapse instead (ADR-0011). It holds no secret, no business rule, and no customer personal data in logs.

## The stack, and why each piece

| Piece | Choice | Why this one |
|---|---|---|
| Runtime | **Node 22** | Pinned in `.nvmrc`, `engines.node`, and read from `.nvmrc` by CI. Not 20: the build passes there and the unit tests cannot start at all — jsdom's undici fails to boot a Vitest worker with `webidl.util.markAsUncloneable is not a function`. That is the exact shape of failure this repo is built to make loud. |
| Package manager | **npm** | Declared in `packageManager`, with `package-lock.json` committed. Every install, locally and in CI, is `npm ci` against that lockfile — `npm install` resolves a fresh tree and would make a run unreproducible without saying so. No second manager, no second lockfile. |
| Build | **Vite** | Fast dev server, and `vite preview` serves a real production bundle, which is what the end-to-end suite runs against. |
| Language | **TypeScript, strict** | Two projects: `tsconfig.json` for what runs in a browser (`src/`, the jsdom test setup), `tsconfig.node.json` for what runs in Node (the config files, the unit tests that read the repository off disk, the Playwright suite). Splitting them is what keeps Node globals out of application code. Plus `noUncheckedIndexedAccess` (an array lookup is `T \| undefined`, which is what it actually is) and `exactOptionalPropertyTypes`. Path alias `@/*` → `src/*`, declared in both `tsconfig.json` and `vite.config.ts`; the two must agree, since TypeScript resolves aliases on its own and a missing Vite alias typechecks fine and fails at bundle time. |
| UI | **React 19** | Shared with the hub, so one set of habits across both front-ends. |
| Styling | **Tailwind 4** with the preset from `@kodera/design-tokens` (ADR-0004), loaded through `@config` (ADR-0008) | One source of truth for colour, spacing, radius and type, shared with the hub. This repo declares no value of its own. **No inline hex, ever.** The package is a git dependency pinned to a commit, not to a branch: a branch re-resolves on every fresh install and the palette would change underneath a run of the same commit. |
| Fonts | **@fontsource**, self-hosted and bundled | Plus Jakarta Sans (static, 400/500/600/700) and IBM Plex Mono (400/500, and 500 is the heaviest mono weight the console draws), imported by `src/index.css`. The static package is the one that declares the family under the name the tokens preset asks for; the variable package declares "Plus Jakarta Sans Variable", which nothing matches. `tests/e2e/fonts.spec.ts` asserts in a browser that every rendered weight comes from a bundled face. This row records `DESIGN_SYSTEM.md` (design of record) under ADR-0004's token package — it is not a decision of its own. A webfont fetched from a CDN is a request to a host the console may not talk to (ADR-0003) and leaks a page view to it on every load. |
| Components | **Radix Primitives**, shadcn-style local copies in `src/ui/` | Behaviour (focus trap, roving tabindex, `aria-*`, dismiss) from Radix; appearance from our tokens; the copies are ours and reviewable. Added one package at a time, with the primitive that needs it: `@radix-ui/react-slot` is here for `Button`'s `asChild`, and nothing else is. |
| Stories | **Storybook** + the accessibility addon | The component inventory with its full state matrix, and the axe gate that goes with it. Console only (ADR-0004). |
| Unit tests | **Vitest** + Testing Library + jsdom | Queried the way a user finds things: role and accessible name. |
| End-to-end | **Playwright** against **MSW** | Never against a live Core API. See [TESTING.md](TESTING.md). |
| Routing | **TanStack Router**, code-based route tree (ADR-0005) | Typed path params for `/{org}/…` and zod-validated search params, so a wrong `?tab=` is an error and not a default tab. One `routes.ts` per area under `src/features/<area>/`, aggregated in `src/app/routeTree.ts`; no generated route tree, which would be one file every builder conflicts on. |
| Server state | **TanStack Query** (ADR-0005) | Owns every server read: the specs' polling intervals, retries, cache and invalidation after a mutation, expressed as configuration rather than as an effect per screen. Mutations go through `src/api/mutations.ts`. |
| Forms | **react-hook-form** + **zod** (ADR-0006) | One schema per form, and the same schemas validate search params. Validation timing from the spec via `mode`; `zodResolver` wrapped exactly once in `src/ui/Form`. Every error message is a catalogue key, never a sentence. |
| OIDC client | **oidc-client-ts** behind `src/auth/AuthAdapter` (ADR-0007) | The realm is discovered at runtime (ADR-0002), so the authority cannot be fixed at construction. Authorization code + PKCE, access token in memory only. Nothing outside `src/auth/` imports the library. |
| API client | **openapi-typescript** from the pinned Core API spec | Generated, never hand-written. See [API_CLIENT.md](API_CLIENT.md). |
| Copy | **i18next** + react-i18next | Message catalogues, French default, English second. See [I18N.md](I18N.md). |
| Lint | **ESLint** flat config + typescript-eslint + react-hooks + **jsx-a11y** | Accessibility is a gate, so the subset a linter can see is enforced by a linter. |
| Format | **Prettier** + `prettier-plugin-tailwindcss` | Class order is mechanical; nobody should review it. |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on 5173. |
| `npm run build` | Typecheck, then bundle. |
| `npm run preview` | Serve the built bundle on 4173 — what the end-to-end suite drives. |
| `npm run lint` | ESLint over the repo. |
| `npm run format` / `npm run format:check` | Write / verify formatting. `format:check` is the CI gate. |
| `npm run typecheck` | Both projects: application (`tsconfig.json`) and tooling (`tsconfig.node.json`). |
| `npm run test` | Vitest, once. No `passWithNoTests`: a suite that finds nothing must be loud. |
| `npm run test:e2e` | Playwright against a preview build with MSW. |
| `npm run storybook` / `npm run build-storybook` | Component inventory, with the axe addon. Telemetry is off. |
| `npm run api:generate` | Regenerate the Core API client and the base MSW handlers into `src/api/` and `src/mocks/generated/`. See [API_CLIENT.md](API_CLIENT.md) for the pinned inputs and regeneration checks. |

## Pins that lag on purpose

Two dependencies are deliberately not on their newest major. Each has a reason, and each should be revisited when the reason goes away — not before.

| Pin | Newest | Why we stay |
|---|---|---|
| `eslint` 9 | 10 | `eslint-plugin-jsx-a11y` still declares `eslint` `^9` as its peer. On 10, `npm install` fails outright with `ERESOLVE` — verified, not assumed. This is the pin with a clock on it: the 9.x line is deprecated upstream and gets no further patches, security ones included, which npm says on every install (`npm warn deprecated eslint@9.x: This version is no longer supported`). Move the moment the plugin widens its peer range; if it does not, replacing the plugin becomes the cheaper option. |
| `typescript` 5 | — | `typescript-eslint` 8 declares `typescript >=4.8.4 <6.1.0`, so that peer range is the ceiling whatever has been released since. Ahead of it, linting stops type-checking and says nothing useful about why. |

## Environment

`.env.example` carries names and shapes, never values. Everything a browser sees is prefixed `VITE_` and is **public**: it is inlined into the bundle at build time. A misspelt `VITE_` name is `undefined` at runtime and never an error, which is why every variable is documented there and asserted in `tests/unit/toolchain.test.ts`.

- `VITE_CORE_API_URL` — the one backend the console may call.
- `VITE_KEYCLOAK_URL` — Keycloak base URL. No realm: tenant admins authenticate against their own tenant realm, resolved at runtime from the organisation slug or email domain (ADR-0002).
- `VITE_ENABLE_MSW` — `1` boots the mock worker instead of the network.
- `VITE_AUTH_MODE` — `oidc` or `mock`. `mock` selects the test identity provider behind the same `AuthAdapter` interface (ADR-0007).
- `VITE_OIDC_CLIENT_ID` — the console's public OIDC client id. Public like every `VITE_` value; PKCE is what makes a public client safe.
- `VITE_MATRIX_DOMAIN` — the domain every organisation's Matrix server name sits under, `{slug}.{domain}`; unset, no live Espace is offered (ADR-0012).
- `VITE_TENANT_DOMAIN` — the DNS name a tenant's address sits under, `{slug}.{domain}`, the same value as Core's `KODERA_TENANT_APP_URLS` templates; the order previews the address from it. Unset, the order names no domain.
- `VITE_ESPACE_DEV_HOMESERVER` — development builds only: the local Espace stack's loopback homeserver, used in place of discovery (ADR-0012).
- `VITE_ESPACE_DEV_SERVER_NAME` — development builds only, with the override above: the local stack's Matrix server name, `kodera.test` when unset (ADR-0012).
- `VITE_MOCK_UNSERVED` — mock builds only, with `VITE_ENABLE_MSW=1`: `1` shows the screens whose Core operations are not served yet, which the pilot hides ([CAPABILITIES.md](CAPABILITIES.md)). Ignored by any build that talks to a real Core.

## What is not here yet

- **The application entry has landed.** `index.html` and `src/main.tsx` exist, `npm run build` bundles a real production artefact, and `npm run test:e2e` drives it with Playwright (W0-8). Order forms consume `react-hook-form` and the shared `zod` schemas (ADR-0006).
- **Login and session flows exist as client code.** Realm discovery, organisation switching, status banners, session-expiry recovery and MFA enrolment are exercised against mocked services. The generated client is wired, but live Core and identity integration remain release gates. MFA enrolment is demonstration-only in the explicit mock/MSW build: passkeys show unsupported and TOTP is simulated. Non-mock builds show enrolment unavailable until identity integration exists. The staff login entry exists; the full staff workspace remains pending. See the shell/login specification and [API_CLIENT.md](API_CLIENT.md) for the contracts and implementation boundaries.
- **Security opens a placeholder; Language remains pending.** The shared account list routes Security to an honest unavailable screen. The desktop Language item remains the explicitly pending product item; the mobile sheet omits it.
- **Federation's tab redirect is not implemented.** `/{org}/federation` is its own stub rather than resolving to `/{org}/domain?tab=federation` as the delivered design specifies. The domain screen now lists the organisation's addresses (`docs/specs/domain-addresses-list.md`) and draws no tab strip while the second tab is a placeholder; the strip, `?tab=` and the redirect arrive together, with the first federation screen, in `src/features/domain/DomainScreen.tsx`.
- **Appearance is delivered.** The preference page offers automatic, light, dark and black modes using tokens v0.1.1. A local preference and pre-paint selector apply the theme before rendering; automatic follows the system preference. Hosting must still serve `/theme.js` with `Cache-Control: no-cache` before deployment. See the [public asset contract](../../public/README.md) and [Appearance specification](../specs/10-appearance.md).
- **No component-tier tokens.** The tokens package reserves the `component` group and leaves it empty. `Button` and `TextField` compose semantic tokens; the first component token arrives when a primitive needs a value the semantic tier cannot express — the destructive button's border is the current candidate.
- **No z-index ladder and no breakpoints.** Not in the tokens package either, so Tailwind's defaults apply.
- **No ruleset protects the tokens package's tags.** `package.json` names the tag `v0.1.1` (`github:kodera-hq/kodera#v0.1.1`), and `package-lock.json` records the commit it pointed at when the pin was taken, `09b2aa4e73e068798643197fcb7ee7bdb5089390`. `kodera-design-tokens` has no ruleset, so the tag could be moved. `npm ci` installs the lockfile's commit, not the tag, and that commit is what keeps a run reproducible.

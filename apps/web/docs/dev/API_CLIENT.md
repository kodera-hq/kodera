# The Core API client

Every capability the console needs is an endpoint in `kodera-core`, authorised server-side (ADR-0003). The one exception is Espace's chat. It talks to the workspace's Synapse with the member's own Matrix token, through `src/auth/matrix.ts` and `src/features/espace/matrix/` only (ADR-0011). Otherwise the console makes no direct call to Keycloak's admin API, Scaleway, Stripe, Qonto, or a tenant VM, and has no backend-for-frontend in this repository.

## Contract first

The contract is hand-authored and version-tagged in `kodera-core`:

```
kodera-server/contracts/core-api.openapi.yaml
```

Core's own CI diffs its generated spec against that file and fails on divergence, and `oasdiff` gates breaking changes. The console consumes the published spec; it never writes it. A console feature that needs a field starts as a spec change in `kodera-core`, not as a richer mock here.

## Generation

`npm run api:generate` (`scripts/api/generate.ts`, run directly by Node 22) does four things:

1. verifies `contracts/core-api.openapi.yaml` against the `sha256` in `contracts/contract.lock.json`, and stops if they disagree;
2. runs `openapi-typescript` over it into `src/api/schema.d.ts`;
3. writes one example response per operation into `src/mocks/generated/examples.ts` — status, declared headers, and the example body of the first 2xx response, with `$ref`s resolved (on the response itself as much as on its schema) and `allOf` composed, so a `CursorPage` collection answers a page with a row in it rather than the empty page the envelope's own example carries;
4. writes the base MSW handlers (`src/mocks/generated/handlers.ts`) and the problem registry (`src/api/generated/problems.ts`, re-exported from `src/mocks/generated/problems.ts` for the mock layer) from the same document.

The registry lives under `src/api/generated/` rather than `src/mocks/generated/` because `src/api/client.ts` needs it outside any mock, to tell a registered problem from an unregistered one — that is production code reading contract knowledge, not mock knowledge. The re-export keeps every import written against the mock path working.

The generator never invents a value. A schema with no `example` makes it **exit 1 naming the schema**: the examples are the mocks, so a missing one is a bug in the contract and is reported to `kodera-core`, not patched here. The same rule is why `problem()` in `src/mocks/problem.ts` takes a `ProblemType` and not a string — an overlay cannot invent an error the API never emits.

A schema that carries **more than one** example answers with the one the console has named for it in `EXAMPLE_CHOICES` (`scripts/api/spec.ts`) — `RealmDiscoveryResult` answers its `zero` example, `Workspace` its `initialised` one — recognised by what it says, never by its place in the list. Taking the first would let a reorder in `kodera-core` swap a screen's base answer with the regeneration check still green. A schema with several examples and no named choice, or a choice that does not pick out exactly one, makes the generator **exit 1**; `tests/unit/api/example-choices.test.ts` holds every choice to the pinned contract and proves a reorder changes nothing.

`scripts/api/generate.selftest.sh` proves both refusals can fire, by running the generator over fixtures with an example removed and with a lock that does not match. It runs in CI as part of `tests/unit/api/regen-clean.test.ts`.

Generated files are committed, and are:

- excluded from Prettier and ESLint — reformatting them makes every regeneration look like a diff;
- **never hand-edited**. A hand-edit survives exactly until the next regeneration, and the drift check below is what catches it before then.

## Pinning, and the drift check

The contract is **vendored, not fetched**: `contracts/core-api.openapi.yaml` is a verbatim copy of the file in `kodera-core`, and `contracts/contract.lock.json` records where it came from, its `info.version`, and its `sha256`. The copy is never edited here; the hash check is what makes that enforceable rather than a convention.

The pin is contract 0.28.0 at the immutable annotated tag `contracts/v0.28.0`, which points at `dda01115f7683c07e9ff33c967dfae95ef8379af` in `kodera-core`. The annotated tag object is `7fd004090806125f1788f9cb0dba3d199ce34781`; the verbatim contract SHA-256 is `d2f92b7be023bca8c4a3d287e9564087cf92116b5090c4d2bfa2e708fd3e4e2e`. For contracts 0.12.0 and 0.13.0, `ref` was briefly a commit SHA until Core tagged them; it has been a tag since, as it was up to `contracts/v0.11.0`. `contracts/README.md` says how to bump it.

Two CI checks keep the pin honest, both guarding failures that are otherwise silent:

| Check | Fails when | What it prevents | Status |
|---|---|---|---|
| **Regeneration is clean** | Regenerating from the pinned spec produces a diff against the committed types, examples or handlers | A hand-edit to generated code, or a stale artefact left behind by a PR that changed the pin but not the output. | In CI, `tests/unit/api/regen-clean.test.ts`. |
| **Version drift** | The pinned version is more than one minor behind what `kodera-core` publishes | The console sitting on an old contract indefinitely, passing its whole suite against mocks generated from a spec the API no longer implements — until a request 404s in production. | **Not in place.** It was deferred until Core published a second contract tag, which it has; nothing compares the current tagged contract recorded above with the newest version Core publishes. |

The second is the one that matters, and it is the one not yet in place. Everything in this repository's test suite is measured against the mock; if the mock is generated from a stale contract, a green pipeline means only that the console agrees with its own memory of the API. Until the check exists, that gap is closed by hand: whoever bumps the pin re-reads `contracts/CONSOLE_RECONCILIATION.md` in `kodera-core`.

## Using the client

- `src/config.ts` is the only reader of `import.meta.env`; `src/api/client.ts` is the only module that builds a request. `coreApi()` returns the typed `openapi-fetch` client, memoised per base URL and built on first use so a missing `VITE_` variable fails with the variable's name in the message.
- Except for the explicitly gated owner-claim consume dispatch in ADR-0010, writes go through `mutate()` in `src/api/mutations.ts` (ADR-0005), which sets the `application/merge-patch+json` media type a `PATCH` declares. Every `PATCH` requires `If-Match` (`docs/api/CONVENTIONS.md` §10, closed by `CONSOLE_RECONCILIATION` §5.6): `mutate()`'s `concurrency` argument is **required** for a `patch` call — a missing token is a type error, not a request that reaches the network — and `concurrencyToken(entity)` reads it off the `etag` of whatever was last read. Absent, the API answers `428 precondition-required`; stale, `412 precondition-failed` with the current tag on `ApiProblem.currentEtag`, to re-read against.
- A non-2xx is **thrown**, not returned: `ApiProblem` for a problem document, `NetworkError` when the API cannot be reached. `ApiProblem.type` is `null` when the response is not one of the 36 registered types; nothing maps an unknown failure onto a type the registry does not contain.
- Production `fetch` references retain ESLint's `no-restricted-globals` restriction, except for the exact-client replacement boundary in ADR-0010. This is not a claim that the original global-only rule proves every member access or network origin safe.
- Errors are RFC 9457 problem documents. Map `type` to a message-catalogue key; never render `detail` raw, and never render a status code at a customer ([I18N.md](I18N.md)).
- Money arrives as minor units (integer cents). Convert once, at the formatting boundary.
- Mutating endpoints take an `Idempotency-Key`; a retried order or invitation must not create a second one.
- The token is short-lived and lives in memory. Nothing about it goes to `localStorage`, to a log, or to an error report — error reporting runs with PII scrubbing.

## Owner-claim consume dispatch exception

ADR-0010 accepts one consume-only exception to ADR-0005, effective only after the actual
configured enforcement and source-bound acceptance pass. This policy package does not add
the operation: the current client still has zero native callsites. The later application
implementation and its acceptance are a separate gate before any caller can use it.

Only `consumeOwnerClaim` in `src/api/client.ts` may use the single private synchronous
`invokeOwnerClaimNative` callsite. It must derive the existing configured Core origin/prefix
and fixed consume endpoint, preserve generated request/result/header types and explicit
caller-owned original key/body/current bearer, and perform final currentness after
materialization immediately before native invocation. It returns nonthenable response work;
immutable outbound arguments must not survive across an await or completion callback.
Retirement clears application-owned request/attempt/controller roots. Abort is not proof
that the backend did not commit.

The operation may not allocate a key, retry automatically, accept a caller URL/verb/fetch
implementation, or introduce a second client, provider, endpoint, secret store or journey.
It preserves omission/null/empty/value semantics and existing ApiProblem/NetworkError
handling without logging secret material or exporting an outbound Request. Deliberate
same-live-intent retry and deliberate retired-intent recovery remain distinct; unknown
prior outcome requires authority readback, not an automatic new-key retry.

The exact-client local `kodera/owner-claim-native-fetch` rule permits zero or one direct
native callsite in that private top-level synchronous nongenerator function and refuses
the named alias/runtime-typeof/member/global-object/shadow/runtime-export escape forms.
Its client-only noInlineConfig setting prevents inline suppression. Every other production
path retains its original fetch restriction. The configured rule governs native reference
placement, not arbitrary dataflow, URL safety, reference retirement or business authority:
actual-client source/wire/currentness/root tests must qualify those separately. A1 must
require exactly one real native callsite; A0 deliberately allows the existing zero-site client.

`tests/unit/api/native-consume-policy.test.ts` uses the actual ESLint configuration and
public API with three positives, eleven exact refusal inputs/fresh restorations and a
separate disabled-guard health refusal/recovery. Parsed strings never execute a request.
The exception changes no read/query, ordinary mutation, ADR-0003 or ADR-0007 boundary.
It does not adopt keeper/popup UX, protected auth, copied-tab ownership, live realm/proof/
serving/operator readiness or a release. All other writes continue through `mutate()`.

## Owner-claim transient responses

`consumeOwnerClaim` declares a bounded `503 service-unavailable` with `Retry-After: 1`, `Cache-Control: no-store` and a registered RFC 9457 Problem body. The Core contract says this admission failure is not stored and has no replay marker; wait the declared interval before deliberately retrying the same logical key and body. The existing client raises `ApiProblem` with `retryAfterS` and the request ID; it does not automatically retry the request. This differs from `owner-claim-contact-unverified`: after verifying the contact, retry with a **new logical key**, because the original eligible business refusal is recorded.

`tests/unit/api/contract-consumer-alignment.test.ts` checks the immutable provenance, declared response and generated recovery guidance, preserved operation/mock inventory, and actual client request preservation under a scoped synthetic 503. It also invokes the TypeScript compiler at runtime to check the actual generated response and to refuse isolated missing-503 and widened-Retry types. Hosted Typecheck includes this module through `tsconfig.node.json`; runtime diagnostics separately execute the in-memory mutations. Existing regeneration checks remain authoritative for generated byte parity. These consumer checks do not establish live identity/MFA, server-side replay/authority, an onboarding UI or a customer release.

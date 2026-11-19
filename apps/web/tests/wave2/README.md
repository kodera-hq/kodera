# Wave 2 deterministic harness

Status: Implemented harness; live-service and renderer qualification pending

The harness is test tooling. Live execution also requires light themes to declare their native `color-scheme` explicitly; full renderer qualification remains pending.

## Entry points

- `persona1-journey.spec.ts`: Mailpit-owned first-owner claim and separate member acceptance, current membership, fragment retirement and retained workspace sessions.
- `persona2-concurrent-rbac.spec.ts`: three isolated actors; bidirectional Matrix send/peer-sync event correlation; denied outsider join; concurrent document edits and durable read; ordered ETag race, exact 412/428, and foreign document/session 404.
- `persona4-visual-a11y-r5.spec.ts`: twelve S11 cells on one retained owner page, twelve L01 cells, fonts/token bindings, WCAG 2.2 tags, keyboard checks, reviewed viewport snapshots, and a separate configured EU consent/cancellation scenario.

The manifest contains all S01–S32, L01–L22 and A01–A13 descriptors, plus three landing dialogs. A manifest row is not an executed assertion. Mock-only and explicit-refusal oracle branches are labelled. Unknown localized article paths stay null; identity action URLs require owned transactions. No route or protocol is invented for an email or local panel.

The entrypoints do not yet qualify the complete blueprint: attachment transport, D1 decoded media, equal Yjs state-vector digests/reconnect, final membership revocation, Wave 10 operation witnesses, all remaining surface/state matrices and identity-origin baselines need additional runtime scenarios. The existing document scenario verifies DOM convergence plus persisted content, without claiming state-vector equality.

## Runtime inputs

Run from `apps/web/` against externally promoted services; this configuration starts no server or container:

```sh
npx playwright test --config playwright.wave2.config.ts
```

Set `KODERA_WAVE2_WEB_ORIGIN`, `KODERA_WAVE2_LANDING_ORIGIN`, `KODERA_WAVE2_AUTH_ORIGIN` and `KODERA_WAVE2_API_ORIGIN`. Only canonical HTTPS origins or explicit HTTP loopback origins are admitted. Defaults are reserved example hosts, never a deployment assumption.

Supply operator-owned JSON fixtures inside the ignored `tests/wave2/runtime/` directory through:

- `KODERA_WAVE2_PERSONA1_INPUT`
- `KODERA_WAVE2_PERSONA2_INPUT`
- `KODERA_WAVE2_PERSONA4_INPUT`
- `KODERA_WAVE2_R5_INPUT`

`KODERA_WAVE2_INPUT` is a fallback for an individually selected scenario. Each authentication scenario needs fresh independent identities; reusing one identity across scenarios refuses. No environment file is loaded. Resolved fixture paths must remain inside this web workspace and retain a `.json` extension, including after symlink resolution.

`Wave2Input` and `ActorInput` in `world.ts` are the fixture contract. They include:

- An exact 40-character release revision, admitted realm, homeserver origin and optional configured `livekitOrigin`. Opening probes require `release.json.web_revision`, the realm's public OIDC issuer, and an unauthenticated JSON 401 from the configured Core `/api/v1/me`. That explicit request-context probe is distinct from anonymous SPA navigation.
- An optional actor-specific `homeserverOrigin`, validated as an exact canonical origin, overrides the shared homeserver for authority capture, rate accounting and sync witnesses. Production tenant isolation uses a separate homeserver for C. Before transmitting authority, separate homeservers must share a non-empty parent Matrix domain, otherwise `WAVE2_FOREIGN_DOMAIN_BOUNDARY` refuses before any request or allocation. C must receive both a `502 M_UNKNOWN` when joining the foreign room through its own homeserver with the target host in `server_name`, and a `401 M_UNKNOWN_TOKEN` when presenting its token directly to A/B’s homeserver. Each response needs its own network template; only the local join attempt reserves a local-join allocation. Shared-homeserver fixtures retain the original single `403 M_FORBIDDEN` check.
- Synthetic `.test` accounts with existing provider factors, actor-specific realm, authoritative organization IDs/roles, measured setup join counts and exact allowed network templates. A/B share one organization; C belongs only to another. Setup must start with authoritative empty rate buckets. Provisioning/admin traffic must be independently counted by its execution owner; the browser ledger cannot discover prior server-side work.
- Owned Mailpit messages stopped before claim consumption/invitation acceptance. The fixture's `seedJoins` counts prior setup only; browser and Core claim/invitation/redemption attempts are metered separately, including denied joins. Exact scenario totals must include both.
- Authoritative channel/document fixtures, a synthetic `visual.clockEpochMs` and stable DOM selectors. Visual clocks freeze only wall-clock rendering; timers continue normally. Language selectors operate the actual UI. `visual.tabOrder` starts at the document start and accepts either a shared selector array or a map keyed by `375`, `768` and `1440`. Each keyboard check resets focus. Viewport screenshots precede keyboard checks; skip-link checks restore the original URL and scroll position.
- A configured test capture key and the exact consent person/workspace scope for R5. Keys, snapshots, credentials and source content remain in fixture memory, outside receipts.

Network templates must include automatic bootstrap/sync/API traffic and separately named refusal responses. Required actions also have explicit status/content assertions. Expected counts default to one; use `min: 0` for admitted optional traffic and `max: 0` for prohibited calls. Exact fixture paths can use `fixturePath()` to encode each identity segment. Queries and required response keys have independent guards.

Build the first-owner entry with `VITE_FIRST_OWNER_JOURNEY=1` for Persona 1 and keep `VITE_ENABLE_MSW=0`. A tenant must expose its real messaging application through Core's configured application URL templates before the console offers its workspace link. Tenant sign-in starts with the organisation field; the shared entry may ask for an email first. Channel selection enters the connected workspace before looking for its channel links, while retaining the same page.

S11 requires an editable composer, mounted timeline messages, visible font samples and `document.fonts.ready` before measuring, and waits for two rendering frames after each viewport change so responsive rendering settles before the unchanged visual oracles run.

Persona 1 waits for the selected channel's usable composer before checking its exact claim/invitation and Matrix join allocation; the workspace shell alone can precede that join. For language controls inside settings, `visual.languageSection` and `visual.languageClose` identify the actual section and close button so each visual cell measures the restored workspace.

Mailpit scans use the recipient search endpoint and verify exact recipient ownership again before opening a message. Results are paginated in fifty-message pages, including older matching messages. A bounded scan that cannot finish refuses with a sanitized error instead of treating a truncated listing as an empty mailbox.

## Determinism and confidentiality

One worker, zero retries, blocked service workers, reduced motion, zero pixel tolerance, and no automatic traces/videos/screenshots. Review and commit renderer-pinned decoded-image baselines separately; generating a snapshot is not a passing comparison. Fonts are local, declared descriptors are loaded, visible text and pseudo-elements are scanned, and Chromium verifies actual custom glyph faces including French punctuation. An absent-family `document.fonts.check()` result is not used as proof; explicit loaded-face inventory supplies the negative control. Identity mono assets remain operator pending.

R5 intercepts and locally fulfills valid EU collection requests. Its request ledger counts attempts before route decisions, checks complete headers, rejects other service origins, and witnesses local consent plus native AbortSignal cancellation. This proves browser dispatch behavior, not remote storage or erasure. All subsequent capture POSTs are held until release or context close, and every held request must abort immediately on revocation. The scenario waits for a held dispatch fact before revoking consent; the immediate cancellation assertion still reads directly after the handler. Only held capture requests are admitted R1 cancellation exceptions; the consent ledger enters the revoked phase before the UI action. Landing retains its independent zero-third-party gate.

Cookie/local-storage snapshots are memory-only. They do not restore in-memory Core/Matrix authority or session language. Primary scenarios retain each actor's actual page; an explicit storage-state restore remains separately counted. Rate reservations stop planned excess; observed SDK attempts, denied joins and seed memberships count conservatively. No quota refill, limit override or retry is assumed.

Only marker/status information reaches the reporter. Startup and teardown remove implicit failure contexts, including output left by interrupted runs. Screenshots are explicit synthetic-fixture viewport comparisons. Receipts accept plain JSON and refuse bearer values, token-shaped strings, fragments, signed-storage signatures and capture keys, including encoded forms.

## Fast checks

With workspace dependencies restored, run from the repository root:

```sh
npx tsc --noEmit -p apps/web/tsconfig.wave2.json
```

Then from `apps/web/`:

```sh
npx eslint tests/wave2 tests/unit/wave2-oracles.test.ts playwright.wave2.config.ts
npx vitest run --config tests/wave2/vitest.config.ts tests/unit/wave2-oracles.test.ts
```

The isolated oracle configuration avoids application/React/MSW setup:

```sh
npx vitest run --config tests/wave2/vitest.config.ts tests/unit/wave2-oracles.test.ts
```

These self-tests exercise pure validators, event hooks, route barriers, native cancellation and controlled DOM metrics. They launch no Playwright browser and are not browser-layout qualification. The suite also checks the independent telemetry schema against the source literal and rejects fixed-delay waits anywhere in the Wave 2 modules/configuration and their transitive relative helpers. Shared-address login accounting persists across tests in the worker; normal cleanup never resets it.

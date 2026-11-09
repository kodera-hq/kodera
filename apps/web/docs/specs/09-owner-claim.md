# 09 — Owner claim

**Status:** Draft, not gated. A first connected journey is built behind `VITE_FIRST_OWNER_JOURNEY`
(off by default; see the changelog) · **Owner:** zôÖma

A stub. It fixes what the page a claim link lands on is for, how a person reaches it, the states it
must tell apart and the Core operations it uses, so that [`01-order.md`](01-order.md) can name the
step that comes before every first order. Wireframes, copy keys, overlays and the final acceptance
tests are written when the page is designed. The page is not built, and this file is not listed in
`scripts/spec-gate.json`; it joins that list in the pull request that lands the screen and its
tests, not before.

**Where it sits.** A new customer's organisation comes to exist through staff, never through the
console, and the order opens only for that organisation's owner ([`01-order.md`](01-order.md) §3):

1. The buyer requests access. The access request is a person asking for access to Kodera; staff
   review it and run the intake.
2. Staff run the assisted intake: `createOrganisation` creates the organisation in `prospect`, with
   no membership for anyone, staff included, and starts its bootstrap — the organisation's realm,
   then the binding of the intended person's identity in it.
3. Once that binding is ready, a claim is issued to that identity and a claim link reaches the
   person. **This page** is where the link lands.
4. The person, now `org_owner` of an `active` organisation, orders ([`01-order.md`](01-order.md)).

This applies owner decision B0d — staff-assisted intake creates a non-active organisation with no
staff membership, and the intended verified person claims first ownership — whose protocol of
record is `design specification` `plans/complete-mock/FIRST_SLICE_SPEC.md` §P1, carried by Core
contract 0.11.0.

## 1. Goal

Let the person Kodera prepared an organisation for prove that it is them and take ownership of it,
so that they can order.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The person named as intended owner at the intake: the CEO, or the office manager acting
for them, who asked for access and has just received the claim link. They know their work email
address. They do not know what a realm, a `prospect` organisation or a claim token is, and they
should never need to.

**Alone test: not assessed yet.** It is assessed when the page is designed, on at least these
three conditions:

1. One click on the link leads to the organisation's own sign-in, with the second factor the realm
   requires offered the way `00-shell-and-login.md` §4.4 offers it.
2. Every refusal names one next step the person can take without calling anyone — except where
   only Kodera can act, and then the page says so and gives the reference to quote.
3. The page never reads as "you are not allowed": a claim that is spent, expired or bound to
   someone else is explained as exactly that.

## 3. Entry points

| Entry | URL |
|---|---|
| The claim link delivered to the intended owner | Configured claim base followed by `/{organisation_id}/{slug}`, with the opaque claim secret only in the fragment |

No other entry. The page is not linked from the shell, the login or the order. A person who opens
`/{org}/order` before claiming is pointed to their claim link ([`01-order.md`](01-order.md) §12,
not-yet-gated scenario B), once that recognition is implemented.

The selected invitation is one click: Core's outbox mail carries nonsecret organisation UUID and
slug in the route, and the opaque claim secret only in the fragment. For a configured
`https://console.example/prefix/claim` base the route is
`https://console.example/prefix/claim/{organisation_id}/{slug}#<opaque-secret>`. The UUID is
canonical and the slug is validated by Core; the deployment prefix is preserved. These identifiers
may appear in URLs, history and server logs; neither authenticates the person. No public
discovery lookup, token decoding or fabricated membership supplies the organisation or realm.
Full organisation identity and masked recipient are rendered only from authoritative responses.

Before verified cleanup, only the navigation HTML response and at most ONE same-origin,
self-contained external first-party bootstrap JavaScript response are permitted. That bootstrap
has no imports, redirects, preload dependencies or inline code. No theme, icon, manifest,
stylesheet, app chunk, worker, telemetry, API or provider fetch, SDK/app loading or execution
may start before cleanup succeeds. The fragment is captured once and removed immediately with
`history.replaceState`; the bootstrap verifies removal before releasing any other work. Failure
stops transport without a fallback. This is the explicit document/bootstrap exception to the
earlier literal before-any-request wording, not permission for eventual cleanup. The token is never logged,
sent to analytics or error reporting, put in a query, return-to slot, cookie, OIDC state or
localStorage. Claim and callback documents require actual served `Referrer-Policy: no-referrer`,
strict CSP, no inline script, no third-party resources, admitted Core/realm-only connections and
`frame-ancestors 'none'`. A React effect or meta tag is not proof of served headers or early cleanup.

One same-origin sessionStorage key may hold a bounded envelope across one sign-in
redirect. Its maximum eligibility age is ten minutes from the original entry, non-sliding;
equality is expired. At every entry, continuation, take, explicit retry and dispatch, check
the original age and current lifecycle, trusted identity and owner generation.
The original eligibility deadline must never renew. Delete the envelope on return before SDK
and application requests and on failure; refusal or failure to delete stops this transport.

Retire application-held secret references synchronously at selected supported lifecycle events.
Schedule deadline retirement while JavaScript can execute. Physical reference retirement cannot
execute while the browser event loop or OS/process is stalled or suspended.
No exact wall-clock physical deletion during that absence of execution is promised.
On resumption, retire/refuse before any further delivery or dispatch.
No forensic heap, garbage-collector, swap, network-buffer or disk-erasure guarantee is claimed.

Copied-tab prevention of additional secret-bearing POSTs remains mandatory.
Normal redirect absence is not a browser-stall exception.
This execution limitation neither qualifies the envelope's copy ownership nor adopts a new
transport journey, store, coordinator, endpoint or recovery protocol.
The exact consume key/body tuple then lives only in memory. No extra secret storage, extended
lifetime or second secret redirect is allowed. Fresh entry, callback, cancellation/logout,
collision, duplicated tab, back/BFCache and late-response handling require acceptance before
mounting this flow. The interactive claim sign-in uses the distinct same-origin
`/auth/claim-callback`, preserving the configured deployment prefix. Its registered redirect URI
contains no invitation secret; ordinary OAuth code/state handling remains the installed SDK's
responsibility and is not safe to log. This protected callback keeps `frame-ancestors 'none'`.
The existing `/auth/callback` keeps ordinary interactive/silent behavior separate: a silent iframe
must never load the claim callback, drain its envelope or consume the parent's return destination.
The distinct path selects document handling, never authenticates the person or replaces SDK
transaction, cancellation or generation checks. On interactive return, the bootstrap reads,
deletes and verifies deletion of the envelope, transferring it only to memory before releasing
SDK/app loading or requests. Refusal or failure to delete stops transport. The exact registered
URI/client/realm must be coordinated with the provider custodian before connection; no provider
configuration, serving runtime, host or deployment is authorized by these selected rules.

## 4. Screens

Not designed. One screen, `landing`, shell-less like `login`, because the person holds no
organisation role to build a shell from. Its expected course, written as behaviour until a
wireframe exists:

1. The page lands with the claim token.
2. After accepted early capture, sign in through the configured admitted issuer and the
   organisation's own realm using the bounded one-redirect envelope (§3). The claim token
   authorises; current trusted issuer/subject/contact/MFA authenticate and authorise the person.
3. Back from sign-in, delete the envelope before SDK/application requests, then read
   `getOrganisationBootstrap` and match the authoritative UUID/slug/realm context before consent.
   A hint cannot select an arbitrary issuer or disclose another intended recipient.
4. When the claim is ready, explicit consent posts `consumeOwnerClaim` with the frozen exact
   key/body for this attempt (§5). Mounting, timers, reconnect and focus never consume.
5. After `200`, a fresh `/me` must establish the same current identity's exact organisation
   and `org_owner` membership before continuing to existing `/{org}/order`. A remembered
   result, cached membership or `409 consumed` is not sufficient. Read failure stays unresolved.
6. Order keeps separate explicit customer legal acceptance and its deliberate submission hold.
   Independent recorder confirmation and fresh authoritative workspace readiness remain later
   prerequisites; claim success never creates or initializes a workspace.

Components, once designed, come from the existing vocabulary: `Card`, `Button`, `Banner` and
`Empty/loading/confirm` in the delivered set; `Card`, `Button`, `InlineAlert`, `Banner`,
`DefinitionList` and `Skeleton` among the console primitives. No new component is expected.

## 5. State matrix

The states the page must tell apart, and where each comes from. The wording is intent, not copy.

| State | How the page knows | The person is told | Next action offered |
|---|---|---|---|
| Valid, ready to claim | Bootstrap `organisation_state: prospect`, `identity_mapping.state: ready`, `claim.state: issued` | Which organisation they are about to own | Confirm, which posts `consumeOwnerClaim` |
| Not ready yet | Bootstrap `realm.state` or `identity_mapping.state` is `pending` or `running`; `claim.state: not_issued` | Their organisation is still being prepared | Wait; the page checks again |
| Preparation failed | Bootstrap `realm.state` or `identity_mapping.state` is `failed` | Kodera has to act before they can continue | Contact support, with the request reference |
| Expired | Bootstrap `claim.state: expired`, or `410 owner-claim-expired` | The link has expired | Ask for a new link |
| Revoked | Bootstrap `claim.state: revoked`, or `410 owner-claim-revoked` | The link no longer works | Ask for a new link |
| Already claimed | Bootstrap `claim.state: consumed`; `409 owner-claim-consumed`; `409 invalid-state-transition` with `allowed_states: [prospect]` | The organisation already has its owner | Sign in normally |
| Wrong person | `403 owner-claim-identity-mismatch` | The link was issued to another account of this organisation, without saying which | Sign out and sign in with the account the link was sent to; no retry |
| Verification required: second factor | `403 mfa-required`, which Core also answers when the login is more than 320 s old at its decision or its final read | A second factor is needed first | Retire the attempt; correct trusted proof, then deliberately reopen the original invitation for a new attempt, never retain this secret for a second redirect |
| Verification required: contact | `403 owner-claim-contact-unverified` | Their address has to be verified first | Retire the attempt; verify contact through trusted authentication, then deliberately reopen the original invitation for a new attempt |
| Unknown link | `404 not-found` | The link is not valid — never whether it once was | Check the link, or contact support |
| Claim consumed, ownership read pending | `200` with `OwnerClaimResult` | Their claim was accepted; current ownership is being checked | Fresh `/me` verifies matching current `org_owner` before existing Order |
| Temporary contention | Exact consume `503 service-unavailable` with body `retry_after_s: 1` | Wait briefly, then retry deliberately | After one second, allow explicit same-key/body retry; no automatic resend |
| Unresolved attempt | Lost response, lost in-memory tuple, absent membership or failed authoritative read | The previous outcome is not established | Explicit current ownership readback, normal sign-in, or deliberate original-invitation/support restart; never infer no commit |

**Keys and retries.** Core authenticates and authorises current state before replaying a stored
status/body for the same logical key and exact body, including refusals. Optional `display_name`
presence and value are part of that frozen body. One in-flight request is allowed; double action
cannot generate another intent. Identity, organisation, generation or intent changes fence late
responses and retire the old attempt.

- An uncertain network result is not proof of no commit. While the exact in-memory tuple exists,
  only deliberate retry may reuse its same key/body under current trusted authentication. Never
  silently allocate a new key or change the body to guess an outcome.
- Known temporary contention is the consume operation's exact registered `503 service-unavailable`
  with body `retry_after_s: 1`. Respect the one-second minimum before enabling explicit retry;
  reaching that time never sends a request. HTTP acceptance separately checks `Retry-After: 1`,
  body delay 1 and `Cache-Control: no-store`, and that this response is not stored. The existing
  typed client exposes body-derived `ApiProblem.retryAfterS`, not response headers or a replay bit.
  Unknown/wrong-type/malformed-delay 503s cannot be relabelled this known response.
- After a recorded contact/MFA refusal the old key still denotes that refusal. Retire the
  secret-bearing attempt, correct proof through trusted authentication, then deliberately reopen
  the original invitation for a new bounded entry and key. No simulated proof, automatic new-key
  retry or second redirect carrying the retained secret is permitted. Wrong-account correction
  follows the same retirement/restart rule and never reveals the intended recipient.
- The selected recovery is conservative unresolved/readback/original-invitation or support
  restart. If reload or required cleanup loses the in-memory tuple, do not reconstruct or persist
  it. A failed read or absent membership does not prove the earlier operation failed. Stay
  unresolved; offer current authoritative readback, normal login and a deliberate original-link
  or support restart. No new reconciliation endpoint or seamless recovery is assumed.
- A same-operation in-flight `409` waits its declared retry delay before deliberate same-key/body
  retry. A changed-body idempotency conflict is distinct and cannot become a new-key retry loop.
- Expired and revoked claims cannot be retried. Already-consumed history or a new-key
  `409 owner-claim-consumed` grants no access; only fresh current ownership can open Order.

The eight states of `README.md` §2, for the one screen:

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `landing` | Valid, ready to claim | `Skeleton` while sign-in returns and the bootstrap loads | Not reachable: the bootstrap view always carries a state | The bootstrap read fails → cause and retry | Claimed, then the order | Not reachable: the claim is one transaction, all of it or none | Wrong person, or a missing second factor or verified contact, as above | `Banner`; confirm disabled with the reason; the page checks again when the connection returns |

## 6. Core API calls

| Method | Path | Operation · roles | Fields sent | Fields read |
|---|---|---|---|---|
| `GET` | `/api/v1/organisations/{organisation_id}/bootstrap` | `getOrganisationBootstrap` · `bootstrap`, `staff_operator`, `staff_support` | — | `organisation_state`, `slug`, `intake{ intended_owner_email_masked }`, `realm{ state }`, `identity_mapping{ state }`, `claim{ state, expires_at, consumed_at, revoked_at }` |
| `POST` | `/api/v1/owner-claims/actions/consume` | `consumeOwnerClaim` · `bootstrap`, `org_owner` | `Idempotency-Key`; `token`, `display_name?` | `organisation{ id, slug, name, state }`, `membership{ id, role, source }` |
| `GET` | `/api/v1/me` | `getMe` · organisation roles, once the claim has succeeded | — | `organisations[]{ organisation{ id, slug }, role }` |

Notes.

- **The claim token authorises; it never authenticates.** The bearer token from the organisation's
  realm authenticates. A spent token cannot authenticate a retry; only the same logical request
  can be replayed.
- **The claim accepts no terms.** Staff assistance never stands in for the customer's own
  acceptance: the terms and the DPA are accepted in the order's `agreements` step, by the owner
  this page creates.
- **The console never calls `createOrganisation`.** It is the staff intake
  (`CONSOLE_RECONCILIATION.md` §3.9), and no staff principal holds a customer membership at any
  point.
- The bootstrap view carries no secret: no token, no verifier, and the intended owner's address
  masked.
- Core's accepted configurable claim lifetime defaults to 72 hours and is capped at seven days;
  the page renders authoritative `expires_at`. This is separate from ten-minute browser transport.
  Only issued claims expire; consumed and revoked history stays terminal. An on-time consumed
  claim can be independently confirmed later.
- The qualified pinned contract now carries `getOrganisationBootstrap`, `consumeOwnerClaim`,
  the `bootstrap` role and registered claim problems. Generated consumer alignment is implemented;
  the entry screen, secret transport, trusted auth integration and attempt recovery are not.
- Existing Order components/API wrappers can be reused, but `AgreementsStep.tsx` deliberately
  keeps `SUBMISSION_HELD=true`. Removing that hold requires a separately reviewed immutable
  purchase-intent, customer legal acceptance and uncertain-outcome recovery slice; no route bypass.
  The target keeps two separate explicit customer CGV and DPA acceptance choices, distinct from
  claim consent; this specification does not claim the existing held wizard implements them.
- Independent intake-recorder confirmation is not a customer checkbox. Fresh workspace readiness,
  explicit initialization and a fresh workspace read remain separate from claim/Order success.

## 7. MSW scenario overlays

None declared yet. The page needs one per state of §5; proposed names, following
`<area>.<condition>`: `claim.issued`, `claim.not-ready`, `claim.preparation-failed`,
`claim.expired`, `claim.revoked`, `claim.consumed`, `claim.identity-mismatch`,
`claim.mfa-required`, `claim.contact-unverified`, `claim.unknown-token`.

## 8. Validation rules

None: the page has no field. The console passes the token to Core unchanged and does not judge its
format; Core alone decides whether it resolves.

## 9. Error copy rules

Cause, then next action, as everywhere. Three rules specific to this page:

- A link that does not resolve never says whether it existed, as Core does not.
- A claim bound to someone else is worded as a sign-in with the wrong account, never as a refusal
  of ownership, and never names or unmasks the intended owner.
- An expired or revoked link is not retried; the person is told to ask for a new one.

Copy keys are added to both catalogues when the page is designed. This stub names none.

## 10. Accessibility

The baseline of `README.md` applies. Beyond it: focus moves to the state's heading when sign-in
returns and after each answer from Core; the "not ready yet" re-check announces a change of state
once, in a polite live region, and nothing while the state stays the same; the confirm button keeps
its accessible name while busy.

## 11. Analytics events

None yet. When added, they carry no token, no email address, no organisation name or slug, and
nothing derived from the token: a state name or a problem type suffix at most.

## 12. Acceptance tests

Proposed, not gated. The overlays are the proposed names of §7.

1. **Given** an issued claim and the intended owner signed in with a second factor
   (`claim.issued`),
   **when** they confirm,
   **then** a fresh matching current `/me` owner read opens existing Order while submission stays held.
   `claim/landing: makes the intended person the owner and continues to the order`

2. **Given** an expired claim (`claim.expired`),
   **when** the page loads after sign-in,
   **then** it says the link has expired, offers to ask for a new one, and shows no confirm button.
   `claim/landing: explains an expired link and offers to ask for a new one`

3. **Given** a claim already consumed (`claim.consumed`),
   **when** the person opens the link,
   **then** the page says the organisation already has its owner and offers to sign in normally.
   `claim/landing: sends a person to sign in when the organisation already has its owner`

4. **Given** a person signed in with an account other than the intended owner's
   (`claim.identity-mismatch`),
   **when** they confirm,
   **then** the page asks them to sign in with the account the link was sent to, without revealing
   it, and no membership is created.
   `claim/landing: asks a different signed-in person to use the invited account`

5. **Given** a signed-in intended owner whose sign-in carries no second factor
   (`claim.mfa-required`),
   **when** they confirm,
   **then** it retires the secret-bearing attempt and offers trusted proof correction followed by
   deliberate original-invitation restart, with no retained-secret second redirect or automatic POST.
   `claim/landing: retires the refused attempt before trusted proof correction and invitation restart`

6. **Given** an issued claim (`claim.issued`),
   **when** the person claims using the keyboard alone,
   **then** every step is reachable, focus lands on each new state's heading, and the claim
   succeeds.
   `claim/landing: claims ownership with the keyboard alone`

## 13. Out of scope for launch

- Revoking and reissuing a claim from the console. Not planned in the console: reissue is a staff
  act, and its operation is still open in the contract (`CONSOLE_RECONCILIATION.md` §6.5).
- Creating an organisation from the console. Not planned: it is not part of the decided sequence
  (decision register ORG-INTAKE), in which the staff intake creates the organisation. Public
  self-service intake remains an open product decision (`FIRST_SLICE_SPEC.md` §P1). This
  specification does not decide where access is requested.
- A staff view of bootstrap progress. Not part of the customer console's specifications.
- Handing ownership to someone else after the claim: that is membership management in
  `03-people.md`, not this page.

## Remaining integration and design prerequisites

Organisation addressing and conservative recovery are selected above; delivery, fragment-only
transport, the one-key/one-redirect/ten-minute envelope and terminal-history lifetime are settled.
Earlier alternatives are historical and do not govern this implementation.

1. Allocate exact Core link/mail/config paths and qualify UUID/slug route generation and actual
   mail delivery. The currently configured global link is not yet the selected per-organisation
   link. No deployment, mailbox test or new credential follows from this specification.
2. Implement and qualify the selected document/bootstrap cleanup order and distinct interactive
   claim callback before mounting the entry. Coordinate its registered provider URI/client/realm
   and choose the actual source-serving placement separately. Actual no-referrer/CSP evidence is
   required; source-server HTTP, controlled browser and deployed operator proof remain distinct.
   A mock, prototype, React effect, meta tag or development server is not deployed-header evidence.
3. Inventory and verify the trusted issuer/subject/contact/MFA integration without inventing local
   proof, public prospect discovery or another identity backend. Match fresh bootstrap/current
   owner context and fence cancellation, revocation, generation changes and late responses.
4. Define final French message catalogue keys, wireframes and source-bound acceptance for loading,
   pending/failed preparation, mismatch, terminal status, unresolved/restart and retry. The screen
   remains unbuilt and not gated until those tests and its exact source allocation land together.
5. Identify the approved new-link/support action. Reissue remains a staff act; this page invents
   no reissue/status API, support address, unclaimed-prospect deadline or automatic purchase.

Future acceptance must cover absent/failed ownership reads after lost attempt, double activation,
lost response, exact key/body retry and optional-field presence, changed intent/identity/generation,
one-second explicit retry, no background POST, one-key lifetime/deletion failures, no second secret
redirect, terminal history, fresh owner-to-Order and preserved submission hold. Each startup/auth/
router/catalogue slice needs runnable initial failures and meaningful isolated mutations before
implementation, independent final-source review and its own exact source/CI evidence. Header,
provider, mail and recorder qualification stay distinct from controlled MSW/browser fixtures.

## Changelog

- The owner-claim sign-in popup alone requests `max_age=0` (`OWNER_CLAIM_MAX_AGE_S` in
  `src/auth/oidc.ts`), so every claim is a new login: Core accepts a login at most 320 s old (by
  `auth_time`) at its decision and again at its final read, so a claim commits within 330 s while
  Core's read-to-commit lag stays within its 10 s target, which is not enforced. Every claim needs
  a recent login because the provider repeats a session's original `amr` for hours. Ordinary sign-ins keep reusing the SSO session.
  - Before the confirm posts, the page checks how long ago the sign-in popup returned, on its own
    monotonic clock (`performance.now()`); with `max_age=0` that return is the login. At 300 s or
    more, nothing is sent and the page returns to « Se connecter » with the invitation still held,
    as when a dispatch never starts. The device's wall clock and the token's `auth_time` are not
    read, so a wrong device clock cannot hold the confirm back. The 300 s leaves 20 s of margin
    under Core's 320 s. This check is advisory; Core's is the authority.
  - A login Core still finds too old is refused as `403 mfa-required`, which this page already
    treats as final: the existing message, no second sign-in and no automatic retry.

- The journey behind `VITE_FIRST_OWNER_JOURNEY` now runs to its end: claim, then Order, where the
  order is placed with the accepted CGV and DPA (01-order.md §6), then « Créer votre espace de
  travail ». `tests/e2e/journey/first-owner.spec.ts` covers it in one test.

- A first connected journey, behind the build flag `VITE_FIRST_OWNER_JOURNEY` (off by default, and
  absent from a build without it: `scripts/check-production-bundle.sh`). It is composed from the
  pieces already merged, with no new layer:
  - **Entry.** `src/entry-bootstrap.ts` captures the fragment once and verifies it is gone. It
    hands the secret to `boot()` in memory; no envelope is written.
  - **Sign-in.** The landing (`src/features/owner-claim/ClaimScreen.tsx`) signs in through the
    protected popup (`ownerClaimAuth.begin`), then reads the bootstrap and checks the organisation
    id and slug. While the popup is open, the page says « Une fenêtre de connexion est ouverte.
    Terminez la connexion dans cette fenêtre. » and offers « Annuler », which closes the popup
    (`cancel()`) and offers « Se connecter » again. A popup that comes back after it was cancelled
    changes nothing.
  - **Consume.** One explicit confirm posts `consumeOwnerClaim` through `dispatchOwnerClaim`,
    under `createClaimAttempt`. A deliberate retry reuses the same key and body.
  - **After a `200`.** A fresh `/me` must show `org_owner` (`loadFreshClaimOwner`). The person is
    then sent to `/{org}/order`, as §3 says. There the CGV and DPA are accepted before anything
    is created; the lead ruled that there is no workspace without them. Claim success still creates
    nothing, and Order's submission hold is unchanged until `placeOrder` is connected.
  - **Not yet covered.** Copy is the `console.claim.landing.*` keys. The overlay is `claim.issued`.
    `tests/e2e/journey/first-owner.spec.ts` covers the issued path and the missing-secret stop.
    The other §5 states have copy and mapping but no acceptance test yet. That is why this page
    stays out of `scripts/spec-gate.json`.

- Follows Core contract 0.11.0, whose only change is the organisation slug's minimum length, five
  characters where it was two (owner decision SLUG-MIN-ANSWER). Nothing on this page depends on
  that length: the page reads the slug the bootstrap returns and never validates one.

- Follows Core contract 0.10.0, whose `consumeOwnerClaim` description settles the replay question
  this stub had left to Core: a stored response is replayed verbatim under its key, a refusal as
  much as a `200`, and a new attempt uses a new key — the rule "Keys and retries" already applied.

- Initial stub: the page's purpose and place after the staff intake, its entry, the states it must
  tell apart, the two Core operations of the first-owner claim in contract 0.9.1, proposed
  acceptance tests, and the open decisions it waits on. Not gated.

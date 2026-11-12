# Native sign-in

Status: AppAuth sign-in against an organisation realm, the session in the Keychain, and Core's `/api/v1/me`, implemented. Proven by host tests on Linux and macOS, unsigned Debug and Release device builds, and a simulator walk against the local Core e2e stack with `KODERA_OFFLINE_ACCESS` off: organisation search, sign-in with password and one-time code, the member and organisation from `/me`, relaunch resume, sign-out (Keycloak then holds no session for the client, and the next sign-in asks for credentials), an unknown identifier, and an identity Core does not know (403, the Console screen). With offline access on, against a lab realm that includes the I-2b change: sign-in creates one offline session for `kodera-ios`; after its online session ended, a relaunch resumed without a password through the offline token; and sign-out ended that offline session while the member's `kodera-android` offline session stayed.

**Status:** Active specification

## Flow

1. **Organisation entry.** The member types their organisation's identifier. `CoreDiscoveryClient` asks Core for the realm with `discoverRealm` (`POST /api/v1/auth/discover`, contract `contracts/v0.26.0`), on its own anonymous path: an ephemeral session per lookup, bound to the configured Core origin, with no bearer, cookie, cache or redirect. It is not `CoreRequester`, which attaches the session's bearer and sends only `GET`. The body is exactly one of `{"slug"}` (a canonical 5–20 character slug) or `{"email"}` (the contract's ASCII email pattern; the screen sends a slug). Every lookup sends `Content-Type: application/json` and a fresh `Idempotency-Key`, which Core checks before any quota charge and then discards, and never `Origin` or `Sec-Fetch-Site`, on which Core refuses a browser's cross-site request. The answer is the contract's three shapes: zero results ("no organisation found", never an error), one organisation (its `realm`, `issuer`, `openid_configuration_url` and `organisation`), or 2–20 `candidates`, from which the member picks one. A slug lookup's single answer must be that slug's organisation. Each documented problem has its own outcome: 400 `malformed-request` and `idempotency-key-missing`, 403 `forbidden`, 413 `payload-too-large`, 415 `unsupported-media-type` and 422 `validation-error` are a refused request; 429 `rate-limited` is "try again later"; 500 `internal-error` and 503 `service-unavailable` are "service unavailable"; no answer is a network error. Quotas count per IP and looked-up value, so nothing retries a lookup: a quota answer is shown, and the member searches again later. `DiscoveryPresentation` names these entry states. Development builds can also offer the local realm from `KODERA_DEV_ISSUER` (see [DEVELOPMENT.md](DEVELOPMENT.md)).
2. **Trust check.** `IssuerAdmission.admit` (KoderaDomain) accepts the issuer only if it is exactly a configured origin followed by `/realms/{slug}`, with nothing else added: no other port, path, user info, encoding or case. The configured origins come only from build settings, never from a form, a deep link or a response. Discovery (`CoreDiscoveryConfiguration`, `DiscoveryTrust`) and sign-in use the same origin validator, `IssuerAdmission.validateOrigin`, so a Debug build discovers against a loopback Core too. Plain-HTTP `http://localhost:PORT` and `http://127.0.0.1:PORT` origins are accepted only in Debug builds (`LoopbackPolicy`, decided by `#if DEBUG`). Both discovery (`TrustPolicy.validateDiscovery` calls `IssuerAdmission.admit` on every discovered issuer and candidate) and `KoderaSignInService.signIn` run this check, and an issuer that fails it never reaches the browser: discovery refuses the whole answer, so the screen offers no sign-in.
3. **AppAuth** (`openid/AppAuth-iOS`, pinned `exact: "3.0.0"` in `packages/KoderaAuth`):
   - `OIDAuthorizationService.discoverConfiguration` on the admitted issuer. The discovery document must name that same issuer, and its authorization and token endpoints must be on the issuer's origin.
   - The authorization code flow with PKCE S256. AppAuth generates `state`, `nonce` and the verifier. Scope is `openid`, plus `offline_access` when the build sets `KODERA_OFFLINE_ACCESS = YES` (see [Session lifetime](#session-lifetime)); the client's default scopes come from Keycloak.
   - `OIDAuthorizationService.present(_:presenting:prefersEphemeralSession: false)`, which uses `ASWebAuthenticationSession` through `OIDExternalUserAgentIOS`. AppAuth checks `state`.
   - RFC 9207, before the code is exchanged: when the discovery document advertises `authorization_response_iss_parameter_supported` (Keycloak does), the response must carry `iss`; when it carries one, it must equal the admitted issuer.
   - The code exchange (`OIDAuthorizationService.perform(_:originalAuthorizationResponse:)`), including AppAuth's ID token checks (issuer, audience, expiry, nonce). An ID token is required, so those checks always run. When the sign-in fails after the exchange (no access or ID token, an unauthorized state, an archive that cannot be written), what the provider issued is dropped, not revoked (see **Revocation** below).
   - No wait is unbounded. Each identity request has a 15-second idle and a 60-second total limit. `ASWebAuthenticationSession` reports a cancel when the sheet is closed, and a browser step with no callback after 10 minutes is cancelled.
   - Every AppAuth request (discovery, code exchange, refresh) goes out on one session set at startup with `OIDURLSessionProvider.setSession`: ephemeral, with no cache, cookies or credential storage, and a delegate that refuses every redirect. Revocation uses the same policy.
4. **Storage.** `OIDAuthState` is archived with `NSSecureCoding` into one Keychain item (`KeychainTokenStore`): a generic password with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and `kSecAttrSynchronizable` false. It is never synchronised to iCloud and never restored onto another device. A rotated grant is written with `SecItemUpdate`, and added only when there is no item. A Keychain item survives deleting the app, so the first launch after an install (no `io.kodera.app.session.installed` marker in UserDefaults, which the app's deletion removes) wipes it before anything is restored, then sets the marker; if that wipe fails, nothing is restored and the member is told the session could not be kept. Tokens are never logged or shown. The access token leaves `KoderaAuth` only as the bearer of a Core request. The code and the refresh token go only to the token and revocation endpoints, which the discovery check and `Revocation.request` keep on the admitted issuer's origin, over a session that follows no redirect.
5. **Launch.** A progress indicator shows while `resume()` restores the stored session, re-admits its issuer, and makes one silent forced refresh. A refused refresh (revoked, member removed, expired) purges everything and returns to sign-in. If the identity provider is unreachable, the session is kept.
6. **Core.** Every authorised Core request goes through one path, `CoreRequester` (KoderaClient), and `CoreMeClient` calls `GET /api/v1/me` through it, keeping only the mapping of `/me`'s answer. The requester is bound to the configured Core origin, validated once by `IssuerAdmission.validateOrigin` when it is built, and a Core client names only a path on it. A path that could leave the origin (no leading `/`, an empty segment such as `//host`, a `.` or `..` segment, or any character outside RFC 3986's unreserved set, so `@`, `\`, `:`, `%` and every encoded variant) is refused before any token is asked for, so the bearer only ever goes to that origin. The app builds one requester per signed-in session and hands it to every Core client of that session. When the app lets go of it (it leaves the session, or replaces the requester), it invalidates it. A request started afterwards asks for no token and sends nothing (`.transport(.other)`, as Android's closed requester). A request in flight stops at its next check: before the forced refresh, before each send, and before a local session end, so it sends no retry and a late second 401 ends no session. A request already sent is not cancelled: its answer still comes back. An answer over the size limit is its own outcome, a protocol violation for `/me`. The requester sends `Authorization: Bearer` on its own ephemeral session with no cookies or cache, and never follows a redirect. A 401 gets exactly one forced refresh and one retry. A second 401 ends the session on this device: the Keychain item is wiped and nothing is revoked. Each token carries the session that served it, and the second 401 ends that session only: one that arrives after a sign-out and a new sign-in leaves the new session alone, and a fetch cancelled by then (the member signed out) ends nothing. A 403 is "no organisation yet" (`MemberUnavailable`): the requester does not retry it, and it is never a dead end. Core's `/me` gives the same generic `forbidden` to an owner whose claim is not consumed yet and to anyone without an active membership, so the app shows one message for both: no organisation yet, and if you were asked to set one up, finish on the web, then check again. It offers **Check again** and sign-out, and no link out of the app: the app is a companion, the Console is where an organisation's commercial pages live, and sign-in is the only page the app opens in a browser. `KODERA_CONSOLE_ORIGIN` is still read and validated (`ConsoleOrigin.admit`: the validator of every other origin, so HTTPS, or loopback in a Debug build only), and held without a consumer; `check-app-resources.py` refuses any call in `App/` that opens a page. Finishing a claim on the web changes Core's answer, so the app fetches `/me` again once each time the scene becomes active and on Check again, and a 200 then shows the member. The session's `OrganisationChannelsLoader` (KoderaClient) owns foreground reads and settled explicit retries as one `/me` → workspace revalidation chain, suppresses duplicate or queued retries while its current chain is loading, refuses obsolete data through the complete current-read fence, and separately reduces terminal receipts by opaque owner and exact requester even after read cancellation or that requester's closure (see [Inline organisation channels](#inline-organisation-channels)). `AppConfiguration.read` (KoderaAuth) reads the build settings with the policy the app passes it, the Console origin included; `AppConfiguration.bundled()` passes the build's own. An owner consumes their claim in the Console only, never in the app. A verified token whose subject Core does not know, or knows as disabled or deleted, gets 403 with the problem type `identity-unknown` and no `WWW-Authenticate` (Core #284, `contracts/v0.28.0`), so it lands on the same "no organisation yet" screen: no refresh, no retry, no session end. On the simulator, against the local Core e2e stack at a Core that includes #284, a realm user Core does not know reached that screen. An empty `display_name` counts as none, and the email is shown instead. `/me` fields the app does not show (`mfa_enrolled`, which Core omits for app tokens, among them) are not required.
7. **Sign-out.** It waits up to 5 seconds for a refresh in flight, so the grant it revokes is the one that refresh rotated to. Then the Keychain item is wiped, and the refresh token (the offline token, when offline access is on) is revoked (RFC 7009) at the discovery document's `revocation_endpoint`, if there is one and it is on the issuer's origin. The app returns to organisation entry. A sign-in that starts during that wait takes the sign-out over: it wipes the grant and revokes it before the browser opens, when no new grant exists yet, and the sign-out then has nothing left to do. A refresh signs out only on a real refusal: AppAuth marks the state unauthorized after an OAuth error from the token endpoint, and the error is not `temporarily_unavailable` or `server_error`. A malformed or captive-portal response, an ID token refused for clock skew, or an unreachable provider keeps the session. A grant that cannot be unarchived is wiped.

   With refresh-token rotation, "keeps the session" is not a promise when the provider did answer. If Keycloak issued a new refresh token and the app then rejected the response locally (clock skew on the refreshed ID token, a malformed body), the old token is already spent: the next refresh presents it, Keycloak refuses it (and, with reuse detection, ends the session), and the member is signed out and must sign in again. Only a refresh that never reached the provider leaves the stored token usable.

   A wipe that fails is never silent. Sign-out, a refused refresh and launch report it ("you are signed out, but the session could not be erased from this device"). The service never restores that copy in the same process, and the app clears the first-launch marker, so the next launch wipes the item before it restores anything and restores nothing if that wipe fails too. A sign-in that starts while a grant is held (in memory, or such a leftover copy) wipes it before the browser opens, and does not revoke it; a sign-in refused because its grant is for another issuer, or whose grant the Keychain cannot keep, drops that grant the same way. When that wipe fails and the sign-in does not complete, nothing has overwritten the old copy, so the sign-in reports it (`SignInFailure.sessionNotWiped`) and the app clears the first-launch marker in the same way. A sign-in also waits, at most 15 seconds, for a sign-out's revocation still in flight before the browser opens (see **Revocation**).

**Revocation.** Revoking a refresh or offline token in Keycloak (26.0.7, `TokenRevocationEndpoint`) detaches this client from every session the member has, on all their devices. It deletes their offline tokens for this client only when the revoked token is itself an offline token. So only the explicit sign-out revokes (including one a new sign-in takes over); every other path (a replaced or leftover grant, a failed sign-in, a grant for another issuer, a refused refresh, a rotation that lands after sign-out, Core's second 401) wipes its tokens on this device and asks the provider nothing. Because the revocation reaches every session, a sign-in waits for one still in flight before it opens the browser, so a late revocation cannot end the session it is about to create. The wait is capped at 15 seconds and the revocation request itself at 10 seconds in total, as on Android, so the app never opens the browser while its own revocation is still in flight. A revocation the server received but processes later than that can still end the new session.

A grant that is dropped without revocation stays valid at Keycloak until it expires: 30 minutes idle or 10 hours at most for an ordinary session, 14 days idle or 90 days at most for an offline one. Each replaced or failed sign-in therefore leaves an orphaned server session behind. It is harmless unless the token was copied off the device, since this device no longer holds it.

Per-client sign-out rule: sign-out ends the member's sessions of this app on all their Apple devices; the Android app is another client and stays signed in, and signing out of every Kodera app at once is a later item; the button label is clarified in a later UX pass. That pass must also name one more effect: where the app was a Keycloak session's only client, Keycloak ends that session with it, so the sign-out also ends the member's Keycloak browser session on their other devices.

Refreshes run one at a time, because Keycloak rotates refresh tokens and detects reuse. Every sign-in and sign-out bumps a generation, so a refresh that lands after a sign-out cannot bring the session back, and neither a refusal that lands late nor Core's second 401 for a token an earlier session served can wipe the session that replaced it.

**Session ended.** `addSessionEndedListener(_:)` on the sign-in service registers a listener that is told once for each session the service ends, with a `SessionEnded` event. Its `session` is the ended session's identity: the generation the service fences on, which is also the `session` that session's access tokens carried (`AccessToken.session`). Every wipe that ends a session bumps the generation, so two sessions ended in one process never share an identity. Its `cause` names the path, with the same names as Android's `SessionEndCause`:

- `explicitSignOut`: the explicit sign-out, or a sign-in that takes over a sign-out still waiting for a refresh (that sign-in revokes the grant). The only cause that revokes.
- `refreshRefused`: the provider refused a refresh.
- `endedByServer`: Core's second 401 (`endSessionLocally(servedBy:)`).
- `replaced`: a sign-in that replaces a held session, in memory or a readable stored copy. It is told before the browser opens, so before the new session is held.
- `unusableStoredCopy`: `restore()` found a stored copy it cannot use (unreadable, or for an issuer this build no longer admits).
- `other`: a rotated grant the Keychain cannot keep.

A call the generation fence turns away (a late refusal, a stale 401, a sign-out a new sign-in overtook) ends nothing and tells no one. So does a wipe with nothing held: a retry of a wipe that failed in this process (by `restore()` or by a sign-in), a sign-out with nothing signed in, a sign-in whose own grant the Keychain refused. Two wipes are not reported at all: the `FirstLaunch` wipe (after a reinstall, and on the launch after a failed wipe), which runs before the service and outside it, and a sign-in over a stored copy it cannot read, which overwrites that copy without wiping it. The listener runs on the service's actor, synchronously, once the tokens are gone from memory and the Keychain wipe has been tried, so it must not block. A2 registers one to end the Matrix session and purge its store. Android's `addSessionEndedListener` is told the same events, once per ended session, at the wipe; Android also wipes a stored copy it cannot read when a sign-in replaces it, and reports it as `REPLACED`.

The owner chose a **non-ephemeral** session. The system browser keeps its cookies, so saved passwords and passkeys work. iOS shows its "wants to use … to sign in" prompt before the sheet opens. Whether a second sign-in reuses a *live* Keycloak browser session is expected, not yet measured (A2 measures it). After sign-out it does not: revocation ends the app's client sessions, and the next sign-in asked for credentials again (measured on the simulator against the local Core e2e stack). Logging out in the browser (`end_session_endpoint`) would need a second browser sheet, so it is left out for now.

The redirect URI is `io.kodera.app:/oauth2redirect`, an RFC 8252 §7.1 private-use scheme that matches the bundle ID. The app sets it, and no configuration can change it. `ASWebAuthenticationSession` catches the callback itself. The scheme is therefore deliberately absent from `CFBundleURLTypes`: registering it would only let other apps or links deliver crafted callbacks. `check-app-resources.py` refuses `CFBundleURLTypes`.

## Code

| Piece | Where |
| --- | --- |
| Issuer and origin admission | `packages/KoderaDomain/Sources/KoderaDomain/IssuerAdmission.swift` |
| `SignInService` (`signIn(issuer:)`, `restore()`, `resume()`, `freshAccessToken()`, `signOut()`, `addSessionEndedListener(_:)`), `SignInConfiguration` | `packages/KoderaAuth/Sources/KoderaAuth/SignInService.swift` |
| Session owner: trust check, persistence, one refresh at a time, generation fence, wipe on refusal | `KoderaSignInService.swift` |
| AppAuth, behind `AuthorizationBackend`; RFC 9207, refresh outcomes | `AppAuthBackend.swift` |
| RFC 7009 revocation, `HardenedSession` | `Revocation.swift` |
| `TokenStore`: Keychain, and in memory for tests; the reinstall wipe | `TokenStore.swift`, `FirstLaunch.swift` |
| The Core request path (bearer, 401 refresh and retry, 403, transport, `invalidate()`) and `AccessTokenProvider` | `packages/KoderaClient/Sources/KoderaClient/CoreRequester.swift` |
| `/me` client: the mapping of Core's `Me` | `packages/KoderaClient/Sources/KoderaClient/CoreMeClient.swift` |
| Interface | `App/AppSessionModel.swift`, `App/SignedInView.swift`, `App/OrganisationEntryView.swift` |

Only `AppAuthBackend` imports AppAuth. Tests run `KoderaSignInService` against a scripted backend, with no browser and no network. KoderaAuth builds for Apple platforms only, so the Linux job tests KoderaDomain and KoderaClient and the macOS job tests all three.

## The native client in each realm

The client is the I-2 configuration agreed with the identity lane. `dev/keycloak/realm/kodera-dev.json` mirrors it, and carries the `kodera-android` client too: it is the same realm as kodera-android's `dev/keycloak`, apart from its source label.

- `clientId` `kodera-ios`: a public client, standard flow only (no implicit flow, no direct-access grants, no device or CIBA grants). PKCE S256 is required.
- Redirect URI and post-logout redirect URI are exactly `io.kodera.app:/oauth2redirect`. There are no web origins.
- `fullScopeAllowed` is false and `consentRequired` is false.
- Default client scopes are exactly `basic, acr, profile, email, web-origins`. The one optional scope is `offline_access` (I-2b), in the dev realm and in organisation realms qualified on the merged identity realm tooling #65 tree and applied by the operator. Only `kodera-ios` and `kodera-android` carry it, and only as an optional scope: `console`, `synapse` and every other client carry it neither way, and the realm template's checker refuses each of those with its own mutation. In those organisation realms the `offline_access` realm role is back in `default-roles-<realm>`, so the client scope lists are the gate (lead ruling, decision 64); the staff realm keeps it out. An offline token needs that role in the token, and `fullScopeAllowed` is false, so the role is mapped into both native clients' scope. Without the role in scope, Keycloak refuses the code exchange with "Offline tokens not allowed for the user or client" (measured on the dev realm).
- Protocol mappers: `oidc-audience-mapper` adds `kodera-server` to the access token, and `oidc-amr-mapper` sets `amr` (Core checks `amr ∋ otp` on some writes). There is no `kodera_mfa_enrolled` mapper, because claiming an organisation stays in the web Console.

Production issuers have the shape `https://{host}/realms/{org-slug}`. Locally the issuer is `http://localhost:8080/realms/kodera-dev`; the container binds both `127.0.0.1` and `[::1]`, so `localhost` does not stall on IPv6.

## Session lifetime

Keycloak caps a client session at the realm's SSO session (`ssoSessionIdleTimeout` 30 minutes, `ssoSessionMaxLifespan` 10 hours in the template), so without offline access the app's refresh token lives as long as that, and then a refused refresh returns to sign-in. Owner decision 40 gives the native clients `offline_access` as an optional client scope (apps only, never Console): offline sessions idle 14 days (`offlineSessionIdleTimeout` 1209600) and live at most 90 days (`offlineSessionMaxLifespanEnabled`, `offlineSessionMaxLifespan` 7776000), and refresh tokens rotate with reuse detection (`revokeRefreshToken` true, `refreshTokenMaxReuse` 0). Organisation realms that include the I-2b change offer it, and the app requests it when the build sets `KODERA_OFFLINE_ACCESS = YES`: qualified release and staging builds may set it outside the repository after the gates above pass, and `Config/Local.xcconfig.example` sets it for the dev realm. A member who does not open the app for 14 days, or 90 days after signing in, signs in again. Either way the offline or ordinary refresh token stays in the Keychain item, launch refreshes silently, and a refused refresh purges everything.

Two things end offline sessions early. An explicit sign-out revokes the offline token, which deletes the member's offline sessions for this app on all their devices; the other Kodera app's sessions are not affected (decision 47, per client). Removing a member from the organisation (Core #272) disables the realm user and revokes their consents, which deletes their offline sessions, and Core's sweep re-asserts it; the app's next refresh is refused and it returns to sign-in.

## Configuration

The client ID, the admitted issuer origins, the Core origin, the Console origin and the offline-access switch are Info.plist entries whose values are only build-setting references (`$(KODERA_IOS_CLIENT_ID)`, `$(KODERA_ISSUER_ORIGINS)`, `$(KODERA_CORE_ORIGIN)`, `$(KODERA_DEV_ISSUER)`, `$(KODERA_OFFLINE_ACCESS)`, `$(KODERA_CONSOLE_ORIGIN)`). `Config/Kodera.xcconfig` declares them all empty, includes the untracked `Config/Local.xcconfig`, and then empties `KODERA_DEV_ISSUER` for Release. A build with no values (CI, for example) shows "not configured". `check-app-resources.py` refuses: a literal in Info.plist; a value in the committed base file, an include that is not a line of its own, or a missing or misplaced Release override; anything but loopback values (and `YES`/`NO`) in `Config/Local.xcconfig.example`; a `KODERA_` setting in `project.yml` or any other `.xcconfig`; and, in any `App/**/*.swift`, an `http(s)://` literal, a client ID literal, or a string literal passed to a deployment constructor or argument. CI builds the app in Debug and in Release. Staging and release values are supplied outside the repository.

## Workspace structure client

`CoreWorkspaceClient` (`KoderaClient`) reads the member-visible tree with
`fetch(organisationId:) async`: `GET /api/v1/organisations/{organisation_id}/workspace`, through
the same session-owned `CoreRequester` as `/me`. Supply an organisation from the current
membership; Core authorises and filters it again. Invalid identifiers refuse before any token
or request, and a response for a different organisation is refused.

`WorkspaceOutcome.loaded` carries an ordered `WorkspaceSnapshot`: setup and initialisation
state, nullable workspace ID, categories and uncategorised channels. Stored names and open
template keys are preserved. Channel metadata includes text/audio kind, active/archived
lifecycle and pending/ready/failed room state; ready establishes neither current Matrix
access nor a provider session. Required fields, closed enums, UUID/type/null/state constraints,
duplicate JSON keys and Unicode scalar text bounds are checked without returning a partial tree.

Session outcomes preserve the requester's one-refresh/one-retry 401 policy, 403 without retry
or sign-out, and the iOS `signedOutNotWiped` warning when a local wipe failed. Failures are
safe typed not-found, service, identity, protocol or transport outcomes. Reads are unconditional
and uncached, without `If-None-Match`; unsolicited 304 is a protocol failure, and no prior tree
substitutes for a refused read. The client owns no requester lifecycle, cache, token or provider
connection. A consumer must fence an already-sent answer against its session before presentation.

The inherited 65,536-byte logical body bound rejects a larger otherwise-valid response; it is
not a streaming allocation guarantee, since the existing URLSession transport buffers before
checking it. The focused host entry is `swift test --force-resolved-versions --filter
CoreWorkspaceClientTests` from `packages/KoderaClient`. The valid UTF-8 byte boundaries are
65,536 accepted and 65,537 refused through decoder and transport. Linux cannot exercise the
fixture's redirect callback; the corresponding test runs in the existing macOS job.

This API now feeds the inline read-only organisation channels interface. Host tests, unsigned builds and this documentation
do not establish a current live workspace, channel content, device UX, offline proof or staging
readiness, and change none of the offline rollout gates.

## Inline organisation channels

`OrganisationChannelsLoader` is the MainActor presentation coordinator used by the actual app model.
It owns one current-or-most-recent session record and uses the existing `/me` and workspace readers on
one session requester. Exactly one authoritative `/me` membership must match the admitted session realm;
zero or ambiguous matches send no workspace request. Each real signed-in foreground entry clears old
metadata and runs one `/me` then workspace chain. Repeated active notifications and taps while loading
send no duplicate or queued follow-up. Refusal waits for explicit retry or another genuine foreground
entry; retry begins with `/me`. Root lifecycle forwarding is stable across child-view phase replacement.

Data, chaining and ordinary failures require the current owner, read ticket, unique organisation,
foreground/read state and exact live requester. Session value equality and cancellation alone do not
establish current publication authority. Background/read shutdown drops data authority, not terminal
responsibility. Terminal `signedOut`/`signedOutNotWiped` receipts from both readers are reduced BEFORE
that data fence using the captured opaque app owner and exact requester, even when the old task is
cancelled or its requester was closed by an earlier ordinary end.

The bounded terminal record is monotonic: none, ordinary end, then failed wipe. End and stronger warning
are independently delivered once. If a newer same-owner read reports ordinary end first, a delayed old
read's failed wipe still upgrades the warning after `core` is gone. Reversing their order cannot downgrade
it. Explicit sign-out completion uses its pre-await owner context and cannot clear a stronger warning.
Only the explicit user action revokes; terminal receipts do not request, refresh or revoke. A genuine
accepted new session retires prior terminal authority even with identical public issuer/realm fields.
No global SDK listener, guessed SDK identity, token-store policy or FirstLaunch implementation changes.

The app wrapper synchronously maps accepted coordinator effects to phase/notice and the existing
`sessionNotWiped()`/`FirstLaunch.requireWipe` path, without an additional phase/ticket/open-requester gate
or Task hop. Authentication completions are forwarded with coordinator-issued operation contexts;
the coordinator preserves an already stronger warning until a genuine new enter. It never clears a
committed FirstLaunch marker. Ordinary signed-out UI alone does not retire the last terminal record.

The screen uses current tokens/fonts, one ScrollView, plain wrapping rows and no channel actions. A linked
room is metadata, not current Matrix/media access. Unknown wire room state/304 refuses the entire response,
not an unknown row or empty authorised view. A stable retry control remains present during progress;
one transition-only announcement source covers profile/channels status, excluding spinner and list.

Focused host acceptance is `swift test --force-resolved-versions --filter OrganisationChannelsLoaderTests`
from `packages/KoderaClient`. Controlled typed results and the real requester/readers above a synthetic
AccessTokenProvider exercise both terminal orders, closed-owner upgrades and genuine-session exclusion.
They are not actual Keychain/SDK persistence-race executions. Complete data-fence/terminal negative
mutation comparisons require separate executed evidence; written tests are not sensitivity proof.
Existing CI compiles the app and executes package tests, not app-model/SwiftUI unit tests. Source/build
review follows the thin mapping, while actual FirstLaunch/Keychain integration, VoiceOver, keyboard,
Dynamic Type, narrow/iPad layouts, insets and foreground focus/scroll remain separately unmeasured.
No signing, staging, provider/runtime, release or offline enablement follows from this slice.

## Unwired current identity reader

`CurrentCoreIdentityClient` observes the minimal current identity projection through the existing
`CoreRequester`. It changes no App screen, SDK owner or provider authentication. Its public main-actor
`OwnerPort` must capture one truthful immutable local source marker, exact borrowed requester, existing
Domain `AdmittedIssuer` and target organisation UUID, and check that binding synchronously. Port calls
are pure, bounded, throwing and nonreentrant; a swallowed reentry violation still fails the outer call.
Admitted issuer syntax is not authenticated identity or requester provenance. Future App code must use
public `IssuerAdmission.admit` with the protected sign-in configuration's origins/loopback policy;
Client does not import Auth. External marker lifetime nonreuse is a port precondition. The reader checks
its retained record/presented handles and carries no historical marker ledger.

`acceptCurrentOwner` mints an opaque owner handle. `prepareRead` returns a read handle before loading;
`startRead` rechecks the current owner/full snapshot/private ticket/live requester/data eligibility and
port before any worker, then starts once and notifies with that handle. Invalid owned prepared reads
settle that same handle without work; foreign handles remain untouched. Every identity/unavailable
publication checks the complete current owner/read/loading/open-requester/port predicate. A genuinely
new source marker retires the old owner even when all public fields match. Logical cancel/end/close
never closes the borrowed requester or physically cancels shared SDK work. Later reads require an
explicit call; there is no automatic retry or cached identity fallback.

Terminal results use a separate owner/requester-tagged monotonic lane BEFORE data, ticket, cancellation,
read-shutdown, requester-open and execution-failure checks. The most-recent owner can upgrade ordinary
end to `signedOutNotWiped` after its reads/requester close; weaker/duplicate results cannot downgrade or
recreate events. Genuine G2 excludes newly arriving G1 receipts. Each owner retains at most one Ended
and one RequireWipe event, with independent explicit acknowledgement bits. Both are committed before
callbacks; a throwing Ended observer cannot suppress the wipe event's independent callback attempt.
`closeReads` permanently shuts data reads but preserves terminal authority; `endOwner` preserves it too;
`retireOwner`/new accepted ownership removes admission authority. None revokes or signs out the SDK.

Public `OwnerHandle.terminalReceipt` and `acknowledgeTerminal(event)` remain usable without the reader,
including after an exceptional completion or callback-reentrant G2. Retired handles can inspect and
acknowledge committed events but admit none new; another owner/reader's event cannot be acknowledged.
`ReadHandle.owner` retains that bounded record even when completion throws. These handles retain an
identity token, not the reader; no reader-owned receipt archive or destructive disposal API exists.
The eventual App must consume pending wipe warnings and exceptional completions; this is still unwired.

`ReadHandle.waitForCompletion()` is stable for multiple awaiters and waits for start/loading notification,
the actual requester/decode worker to terminate, final main-actor reduction/publication or drop, and final
callbacks. Cancel/end/read shutdown cannot settle it early; an awaiter's cancellation cannot cancel it.
Throwing ports/observers and scheduling-seam errors complete exceptionally with typed primary/secondary
causes, never raw error UI copy. A callback commits state before reentry; old finalisation never overwrites
a newer owner. An already decoded terminal obligation survives a postdecode scheduling-seam failure.

One read makes one logical `requester.get(/api/v1/me)`, preserving its existing 401 refresh/retry policy;
it is not one HTTP request. Only 200 is decoded. The consumed projection requires canonical person id,
`staff=false`, unique identity ids/exact issuers, canonical realms and exact 1–255 visible ASCII subjects.
Subjects preserve case/punctuation. Memberships are capped at100 with unique organisation ids; all
current-realm memberships count before eligibility. Exactly one active target must link by exact
`identity_id` to the captured issuer/realm. Missing links are ineligible; explicit null/malformed/dangling
or contradictory links are protocol failures. No array-order/email/JWT/provider-account fallback exists.
Unused display fields are ignored while global strict JSON checks still apply. Existing StrictJSON
supplies the 65,536-byte logical body/depth/UTF-8/duplicate/trailing checks; this is not streaming-memory
qualification. Existing typed transport/status/terminal mappings are preserved, including failed wipe.

Focused host acceptance is `swift test --force-resolved-versions --filter CurrentCoreIdentityClientTests`
from `packages/KoderaClient`. The new tests use the real requester/strict decoder and an internal async
postdecode scheduling gate to hold decoded Old while New completes, then release/acknowledge Old.
That gate supplies no typed fetch result or transport bypass and changes no shared fixture/API.
Tests were authored before implementation; no absent-feature semantic red, local native execution or
physical guard-removal sensitivity is claimed. Normal hosted Linux and NON-DRAFT Darwin Domain/Client/
Auth plus unsigned Debug/Release builds supply qualification; draft macOS skips cannot prove those gates.
Actual App binding, Keychain/FirstLaunch warning consumption, provider/device/offline/signed release and
store distribution remain separate gates. This reader establishes no provider authority.

## Not yet proven

- The reinstall wipe on a device.
- Whether a second browser sheet reuses a live Keycloak session (A2).
- Against a running Keycloak: that a sign-out on one device ends the app's sessions on the member's others, and that the paths that only wipe leave them alone.
- Staging, after I-3. Device UX, account switching and accessibility on real devices.

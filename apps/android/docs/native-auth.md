# Native sign-in

Status: AppAuth organisation sign-in, the session sealed on the device, and Core's `/api/v1/me` are implemented. Host tests, unsigned debug and release builds, and merged-manifest checks pass. The recorded Android emulator walkthrough against the local Core e2e stack at `7dc4129` (APK `cd57b39`, offline access off) passed organisation discovery, password and TOTP sign-in, `/me` 200, relaunch resume, sign-out, and the unknown-identity 403 Console screen. The earlier local Keycloak walk also covered refused refresh, interrupted sign-in and an unreachable provider. Offline-on step 7 remains unmeasured.

**Status:** Active specification

## Flow

1. **Organisation entry.** The member types their organisation's identifier. `CoreDiscoveryClient` asks Core for the realm with `discoverRealm` (`POST /api/v1/auth/discover`, contract `contracts/v0.26.0`), on its own anonymous path: an OkHttp client bound to the configured Core origin with no bearer, cookie jar, cache, redirect or retry. It is not `CoreRequester`, which attaches the session's bearer and sends only `GET`. The body is exactly one of `{"slug"}` (a canonical 5–20 character slug) or `{"email"}` (the contract's ASCII email pattern; the screen sends a slug). Every lookup sends `Content-Type: application/json` and a fresh `Idempotency-Key`, which Core checks before any quota charge and then discards, and never `Origin` or `Sec-Fetch-Site`, on which Core refuses a browser's cross-site request. The answer is the contract's three shapes: zero results ("no organisation found", never an error), one organisation (its `realm`, `issuer`, `openid_configuration_url` and `organisation`), or 2–20 `candidates`, from which the member picks one. A slug lookup's single answer must be that slug's organisation. Each documented problem has its own outcome: 400 `malformed-request` and `idempotency-key-missing`, 403 `forbidden`, 413 `payload-too-large`, 415 `unsupported-media-type` and 422 `validation-error` are a refused request (`RequestRejection`); 429 `rate-limited` is "try again later"; 500 `internal-error` and 503 `service-unavailable` are "service unavailable"; no answer is a network error. Quotas count per IP and looked-up value, so nothing retries a lookup: a quota answer is shown, and the member searches again later. `DiscoveryPresentation` names these entry states. Debug builds can also offer the local realm from `kodera.devIssuer` (see [DEVELOPMENT.md](DEVELOPMENT.md)).
2. **Trust check.** `IssuerAdmission.admit` (`:domain`) accepts the issuer only if it is exactly a configured origin followed by `/realms/{slug}`, with nothing else added: no other port, path, user info, encoding or case. The configured origins come only from build configuration, never from a form, a deep link or a response. Discovery (`DiscoveryTrust`) and sign-in use the same origin validator, `IssuerAdmission.validateOrigin`. Plain-HTTP `http://localhost:PORT` and `http://127.0.0.1:PORT` origins pass only in debug builds: the `LoopbackPolicy` comes from `DevelopmentBuild`, which exists once in `app/src/debug` (admit) and once in `app/src/release` (refuse). Both discovery (`TrustPolicy.validateDiscovery` calls `IssuerAdmission.admit` on every discovered issuer and candidate) and `KoderaSignInService.signIn` run the check, and an issuer that fails it never reaches the browser: discovery refuses the whole answer, so the screen offers no sign-in.
3. **AppAuth** (`net.openid:appauth`, pinned `0.11.1` in `app/build.gradle.kts`):
   - `AuthorizationServiceConfiguration.fetchFromIssuer` on the admitted issuer. The discovery document must name that same issuer, and its authorization and token endpoints must be on the issuer's origin (`DiscoveredEndpoints.check`).
   - The authorization code flow with PKCE S256 (a request whose challenge method is not `S256` is refused). AppAuth generates `state`, `nonce` and the verifier. Scope is `openid`, plus `offline_access` when the build sets `kodera.offlineAccess=true` (see [Session lifetime](#session-lifetime)); the client's default scopes come from Keycloak. `/me` does not need `mfa_enrolled`, which Core omits for app tokens.
   - A Custom Tab chosen by AppAuth's default browser matching, with the browser's normal, shared session. The redirect comes back through AppAuth's `RedirectUriReceiverActivity`.
   - No wait is unbounded. A sign-in claims the browser step (`BrowserStep`) before discovery and holds it until after the code exchange. While it signs in, the screen offers Cancel, which ends it at whatever step it is; tokens an exchange already issued are dropped, not revoked (see [Revocation](#revocation)). A fresh Activity (not restored from saved state) that carries no browser answer cancels the sign-in too, since it can never receive the result an earlier instance waited for, and the member is told the sign-in was interrupted. A browser step with no answer after 10 minutes is cancelled, as on iOS. Only a step whose browser is open takes an answer: a result left over from an earlier sign-in is never read as this one's.
   - The response's `state` must be the request's. RFC 9207: when the discovery document advertises `authorization_response_iss_parameter_supported` (Keycloak does), a response without `iss` is refused; otherwise an absent `iss` is accepted. A present `iss` must equal the admitted issuer. All before the code is exchanged. On a state mismatch AppAuth itself logs both state values at WARN (library behaviour); they are single-use and bound to a request that is then refused.
   - The code exchange, including AppAuth's ID token checks (issuer, audience, expiry, nonce). An access token and an ID token are required, so those checks always run. If the exchange yields a state AppAuth does not call authorized, or lacks either token, the sign-in fails and whatever it did issue is dropped, not revoked.
   - Every AppAuth connection goes through `LoopbackAwareConnections`: HTTPS, or plain HTTP to an admitted loopback origin in a debug build only; no redirect is followed and nothing is cached. AppAuth's own issuer HTTPS check is skipped only where loopback is admitted.
   - These decisions are pure functions over strings (`AppAuthChecks`, `ConnectionPolicy`), host-tested in `:app`, each test asserting the exact refusal.
   - Each AppAuth step is one HTTP exchange, bounded by the connection's 15 s connect and read timeouts; the worker waits 45 s for its answer. A late refresh answer is not dropped: its rotated state is kept for that grant and used by its next refresh or sign-out revocation (lost if the process dies first), unless that grant has been signed out, when it is dropped. After any other end (a replaced grant, a refused refresh, Core's second 401) the slot is not cleared: the rotated state stays on the heap, keyed by a grant nothing presents again, until a later late answer replaces it or the process ends. It is unreachable, not erased. Tokens from a late code exchange are dropped, not revoked.
4. **Storage.** The `AuthState` JSON is sealed with AES-256-GCM (`EncryptedFileTokenStore`, `:client`) under a key generated inside the Android Keystore (`KeystoreSessionKeys`), which cannot be exported. The file is `filesDir/session/core-session.bin`. `res/xml/data_extraction_rules.xml` and `res/xml/backup_rules.xml` exclude that directory from cloud backup and device-to-device transfer, and `allowBackup` is false; `SessionStorageTests` reads both rule files and the path the store resolves. Sign-out attempts to destroy the key, then deletes the file. Retained ciphertext is unreadable only if key destruction succeeded. A failed wipe ends the in-memory session; on the same service instance, each subsequent `restore()` retries cleanup and returns null for that call even if cleanup succeeds, so `resume()` does not refresh the ended grant. Cleanup retries emit no additional session-ended signal. A successful new interactive sign-in stores and admits a new session normally, and untouched cold restore is unchanged. If both key destruction and file deletion fail, the still-valid retained grant may be restored by a new service instance: the retry/refusal flag is not durable storage. That cross-process failure remains unresolved; host tests do not qualify real Keystore or device durability. A file that cannot be opened (tampered, or its key gone), or an `AuthState` AppAuth cannot read back, is wiped rather than crashing the launch. The key has no `setUnlockedDeviceRequired`: a refresh while the device is locked would fail to open the file and wipe the session. Tokens are never logged or shown, and leave `:client` and the AppAuth adapter only as the bearer of a Core request.
5. **Launch.** The session owner is process-wide (`SessionController`): one AppAuth adapter and one `KoderaSignInService`, so one refresh lock and one in-memory session per process, whatever Activities come and go. Launch shows progress while `restore()` reads the sealed session back and re-admits its issuer, without the network, then enters the signed-in screen at once, offline included. The one silent forced refresh runs behind it. A refused refresh purges everything, and the "session ended" signal returns to sign-in. If the identity provider is unreachable, the session is kept.
6. **Core.** Every authorised Core request goes through one path, `CoreRequester` (`:client`), and `CoreMeClient` calls `GET /api/v1/me` through it, keeping only the mapping of `/me`'s answer. The requester is bound to the configured Core origin, validated once by `IssuerAdmission.validateOrigin` when it is built, and a Core client names only a path on it. A path that could leave the origin (no leading `/`, an empty segment such as `//host`, a `.` or `..` segment, or any character outside RFC 3986's unreserved set, so `@`, `\`, `:`, `%` and every encoded variant) is refused before any token is asked for, so the bearer only ever goes to that origin. The app builds one requester per signed-in session, so one OkHttp client and connection pool, hands it to every Core client of that session, and closes it once when the session ends. A request started after that asks for no token and sends nothing. One in flight stops at its next check: before the forced refresh, before each send, and before a local session end, so it sends no retry and a late second 401 ends no session. A request already sent is not cancelled: its answer still comes back. Entering a session also closes any requester still open first, so no path into a session can leave an earlier client and pool behind it. The requester sends `Authorization: Bearer` over OkHttp with no cookies, cache, authenticator or retries, and it never follows a redirect. A 401 gets exactly one forced refresh and one retry. A second 401 ends the session that token was issued in, wiped on this device and not revoked, and only that one: a sign-in that replaced it meanwhile is left alone, and a caller whose thread was interrupted by then ends nothing. A 403 is "no organisation yet" (`MemberState.NoOrganisationYet`): the requester does not retry it, and it is never a dead end. Core's `/me` gives the same generic `forbidden` to an owner whose claim is not consumed yet and to anyone without an active membership, so the app shows one message for both: no organisation yet, and if you were asked to set one up, finish on the web, then check again. It offers **Check again** and sign-out, and no link out of the app: the app is a companion, the Console is where an organisation's commercial pages live, and sign-in is the only page the app opens in a browser. `kodera.consoleOrigin` is still read and validated (`ConsoleOrigin.admit` in `:domain`: the validator of every other origin, so HTTPS, or loopback in a debug build only), and held without a consumer; `check-app-resources.py` refuses any call in shipped app code that opens a page (`ACTION_VIEW`, `startActivity`, a Custom Tab, a web view). Finishing a claim on the web changes Core's answer, so the app fetches `/me` again once each time it returns to the foreground (the Activity's resume) and on Check again (`SessionController.checkMemberAgain`), and a 200 then shows the member. Both act only from the settled "no organisation yet" state: a fetch in flight shows progress, so neither sends a second request during one, and no answer fetches again on its own. An owner consumes their claim in the Console only, never in the app. A verified token whose subject Core does not know, or knows as disabled or deleted, gets 403 with the problem type `identity-unknown` and no `WWW-Authenticate` (Core #284, `contracts/v0.28.0`), so it lands on the same "no organisation yet" screen: no refresh, no retry, no session end. The iOS app showed that screen for such an identity against the local Core e2e stack; this app maps every 403 the same way.
7. **Sign-out.** The interface returns to organisation entry at once. Sign-out is the only call that revokes (see [Revocation](#revocation)). It first waits up to 5 seconds for a refresh in flight, so the token it revokes is the one that refresh rotated to. The local session is then wiped, and the refresh token revoked (RFC 7009) at the discovery document's `revocation_endpoint`, if there is one and it is on the issuer's origin. A sign-in that starts during that wait takes the sign-out over: it wipes the session and revokes its grant before the browser opens, when no new grant exists yet, and the sign-out, fenced like the second 401, then does nothing. A refresh signs out only on a real refusal: AppAuth marks the state unauthorized after an OAuth error from the token endpoint, and the error is not `temporarily_unavailable` or `server_error`. A malformed response, an ID token refused for clock skew, or an unreachable provider keeps the session, but when the provider did answer, only until the next refresh: with rotation and `refreshTokenMaxReuse` 0, the discarded response carried the rotated refresh token, so the next refresh, with the old one, is refused and signs out.

A sign-in that finds a session still held (in memory, or a stored copy) wipes it before the browser opens, so features holding derived data hear that it ended. It is not revoked, unless a sign-out is still waiting to end it (above). A sign-in also waits, at most 15 seconds, for a sign-out's revocation still in flight before the browser opens (see [Revocation](#revocation)).

### Revocation

Only an explicit sign-out calls the revocation endpoint (or the sign-in that takes one over). Keycloak (read in 26.0.7, `TokenRevocationEndpoint.revokeClient()`) revokes a refresh or offline token by detaching this client from every session the member has, on every device. It deletes the member's offline tokens for the client only when the revoked token is itself an offline token. Any other revocation would therefore sign the member out of this app on their other devices (the iOS app is another client and is not affected). So these paths wipe locally and make no revocation call: a session a new sign-in replaces, or a leftover stored copy; a failed, refused or cancelled code exchange, a late one included; a grant issued for another issuer; a grant that could not be stored; a rotation that lands after its session ended (signed out or replaced), from the service or the adapter's late-answer slot; Core's second 401 (`endSession`); a refused refresh. Because the revocation reaches every session, a sign-in waits for one still in flight before it opens the browser, so a late revocation cannot end the session it is about to create.

The tokens those paths drop stay valid at Keycloak until they expire or the member signs out: 30 minutes idle or 10 hours at most for an ordinary session, 14 days idle or 90 days at most for an offline one. Each replaced or failed sign-in therefore leaves an orphaned server session behind. Nothing on this device presents those tokens again (a late rotation may still sit unreachable in the adapter's slot, above), so it is harmless unless a token was copied off the device.

A consequence to know: **sign-out itself ends this app on every device of the member**, not only this one; the iOS app is another client and stays signed in. Per-client sign-out rule: sign-out ends the member's sessions of this app on all their devices, and signing out of every Kodera app at once is a later item; the button label is clarified in a later UX pass. That pass must also name one more effect: where the app was a Keycloak session's only client, Keycloak ends that session with it, so the sign-out also ends the member's Keycloak browser session on their other devices.


Refreshes run one at a time, because Keycloak rotates refresh tokens and detects reuse. Every sign-in and sign-out bumps a generation, so a refresh that lands after a sign-out cannot bring the session back, and a refusal that lands late cannot wipe the session that replaced it.

**Session ended.** `addSessionEndedListener` on the sign-in service registers a listener that is told once for each session the service ends, with a `SessionEnded` event. Its `session` is the ended session's identity: the generation the service fences on, which is also the `session` that session's access tokens carried (`AccessToken.session`). Every wipe that ends a session bumps the generation, so two sessions ended in one process never share an identity. Its `cause` names the path, with the same names as iOS's `SessionEndCause`:

- `EXPLICIT_SIGN_OUT`: the explicit sign-out, or a sign-in that takes over a sign-out still waiting for a refresh (that sign-in revokes the grant). The only cause that revokes.
- `REFRESH_REFUSED`: the provider refused a refresh.
- `ENDED_BY_SERVER`: Core's second 401 (`endSession`).
- `REPLACED`: a sign-in that replaces a held session, in memory or a stored copy (readable or not). It is told before the browser opens, so before the new session is held.
- `UNUSABLE_STORED_COPY`: `restore()` found a stored copy it cannot use (unsealable, unreadable, or for an issuer this build no longer admits).
- `OTHER`: a rotated grant the store cannot keep.

A call the generation fence turns away (a late refusal, a stale 401, a sign-out a new sign-in overtook) ends nothing and tells no one. So does a wipe with nothing held: a sign-out with nothing signed in, a sign-in whose own grant the store refused, and a retry of a wipe that failed in this process (by `restore()` or by a sign-in), whose session was reported when the first wipe failed. The listener runs at the wipe, on the thread that wiped, while it holds the service's lock: once the tokens are gone from memory and the store's wipe has been tried, and before anything else can run on the service. So it must not block and must not call the service. `SessionController` registers one that posts to the main thread and returns the interface to sign-in, unless the cause is `REPLACED` (the sign-in that replaced the session sets the phase itself) or the interface is not signed in. Because the signal is told at the wipe and the main thread runs its tasks in order, it never reaches a signed-in phase late, from a session that phase replaced. A2 registers one to end the Matrix session and purge its store. iOS's listener is told the same events, once per ended session, at the wipe; iOS does not wipe or report a stored copy it cannot read when a sign-in overwrites it.

If the process dies while the browser is open, the request, its verifier and its nonce die with it. The result then arrives with no sign-in waiting, and the member is told "Sign-in interrupted, try again"; the app does not finish the exchange from the result intent. The notice is not shown while another sign-in is in flight (that one's outcome speaks), and a successful sign-in or restored session clears it.

The Custom Tab shares the browser's cookies. A second sign-in while Keycloak's browser session is live reuses it, with no login form: measured on the `kodera-api36` emulator. After sign-out, the next sign-in asked for credentials and OTP again: measured on the emulator and on the iOS simulator, and conditional. Sign-out's revocation ends this client's sessions for the member; the browser's SSO session survives while another client in the same browser, such as Console, still holds it, and then the next sign-in may not ask. Logging out in the browser (`end_session_endpoint`) is left out for now.

The redirect URI is `io.kodera.app:/oauth2redirect`, an RFC 8252 §7.1 private-use scheme. `SignInConfiguration.REDIRECT_URI` fixes it in code. `manifestPlaceholders["appAuthRedirectScheme"] = "io.kodera.app"` fixes the scheme of AppAuth's redirect receiver, and is never derived from `applicationId`. The merged-manifest allowlist admits that one exported activity with exactly VIEW, DEFAULT, BROWSABLE and `<data android:scheme="io.kodera.app"/>`. Residual risk, accepted in I-2: another app can claim the same scheme, and PKCE stops it redeeming a code.

## Code

| Piece | Where |
| --- | --- |
| Issuer and origin admission, `LoopbackPolicy` | `domain/.../IssuerAdmission.kt`, `TrustPolicy.kt` (`DiscoveryTrust`) |
| `SignInService` (`signIn`, `restore`, `resume`, `accessToken`, `signOut`) | `client/.../SignIn.kt` |
| Session owner: trust check, persistence, one refresh at a time, generation fence, wipe on refusal | `client/.../KoderaSignInService.kt` |
| `AuthorizationBackend`, `DiscoveredEndpoints` | `client/.../AuthorizationBackend.kt` |
| `TokenStore`: sealed file, and in memory for tests | `client/.../TokenStore.kt` |
| RFC 7009 revocation | `client/.../Revocation.kt` |
| The Core request path (bearer, 401 refresh and retry, 403, transport) and `AccessTokenProvider` | `client/.../CoreRequester.kt` |
| `/me` client: the mapping of Core's `Me` | `client/.../CoreMeClient.kt` |
| AppAuth adapter, error mapping, connections | `app/.../auth/AppAuthBackend.kt` |
| Keystore key and session location | `app/.../auth/SessionStorage.kt` |
| AppAuth adapter's security decisions, as pure functions | `app/.../auth/AppAuthChecks.kt` (`AppAuthChecks`, `ConnectionPolicy`, `LateRotations`) |
| The one browser step, its cancel and its bound | `app/.../auth/BrowserStep.kt` |
| Process-wide session owner and interface | `app/.../session/SessionController.kt`, `SignedInScreen.kt`, `entry/OrganisationEntryScreen.kt`, `MainActivity.kt` |

Only `AppAuthBackend.kt` imports AppAuth. AppAuth is an Android library, so its adapter sits in `:app`; everything it hides behind lives in the plain-JVM `:client` module, where the tests run without an emulator, Robolectric, a browser or a network. `:app`'s own host tests cover the AppAuth error mapping, every check in `AppAuthChecks` and `ConnectionPolicy`, the late-rotation slot, the browser step's cancel and bound, the session controller's cancel, stranded-sign-in and notice paths (over a fake browser step and the real `KoderaSignInService`), the connection settings (no redirect, no cache), the session path against the backup rules, and, in `app/src/testRelease`, that a release build refuses loopback and has no development issuer. The places inside `AppAuthBackend.authorize` and `freshAccessToken` that call those checks are not host-tested: they need AppAuth's Android classes, and an instrumented test is a later item.

## The native client in each realm

The client is the I-2 configuration agreed with the identity lane, with bounded offline session lifetime. `dev/keycloak/realm/kodera-dev.json` mirrors it:

- `clientId` `kodera-android`: a public client, standard flow only (no implicit flow, no direct-access grants, no device or CIBA grants). PKCE S256 is required.
- Redirect URI and post-logout redirect URI are exactly `io.kodera.app:/oauth2redirect`. There are no web origins.
- `fullScopeAllowed` is false and `consentRequired` is false.
- Default client scopes are exactly `basic, acr, profile, email, web-origins`. The one optional scope is `offline_access` (I-2b), in the dev realm and in organisation realms qualified on the merged identity realm tooling #65 tree and applied by the operator. Only `kodera-ios` and `kodera-android` carry it, and only as an optional scope: `console`, `synapse` and every other client carry it neither way, and the realm template's checker refuses each of those with its own mutation. In those organisation realms the `offline_access` realm role is back in `default-roles-<realm>`, so the client scope lists are the gate (lead ruling, decision 64); the staff realm keeps it out. An offline token needs that role in the token, and `fullScopeAllowed` is false, so the role is mapped into both native clients' scope. Without the role in scope, Keycloak refuses the code exchange with "Offline tokens not allowed for the user or client" (measured on the emulator against the dev realm).
- Offline sessions: idle 14 days (`offlineSessionIdleTimeout` 1209600), max 90 days (`offlineSessionMaxLifespanEnabled`, `offlineSessionMaxLifespan` 7776000). Refresh tokens rotate with reuse detection (`revokeRefreshToken` true, `refreshTokenMaxReuse` 0).
- Protocol mappers: `oidc-audience-mapper` adds `kodera-server` to the access token, and `oidc-amr-mapper` sets `amr` (Core checks `amr ∋ otp` on some writes). There is no `kodera_mfa_enrolled` mapper, because claiming an organisation stays in the web Console.

The dev realm file is the same as kodera-ios's, but for its `koderaRealmSource` label.

### Session lifetime

Keycloak caps a client session at the realm's SSO session, so without offline access the app's refresh token lives as long as that, and then a refused refresh returns to sign-in. Owner decision 40 gives the native clients `offline_access` as an optional client scope (apps only, never Console). Organisation realms that include the I-2b change offer it, and the app requests it when the build sets `kodera.offlineAccess=true`: qualified release and staging builds may set it outside the repository after the gates above pass, and `config/local.properties.example` sets it for the dev realm. A member who does not open the app for 14 days, or 90 days after signing in, signs in again. Either way the refresh token stays in the sealed file, launch refreshes silently, and a refused refresh purges everything.

Two things end offline sessions early. An explicit sign-out revokes the offline token, which deletes the member's offline sessions for this app on all their devices; the other Kodera app's sessions are not affected (decision 47, per client). Removing a member from the organisation (Core #272) disables the realm user and revokes their consents, which deletes their offline sessions, and Core's sweep re-asserts it; the app's next refresh is refused and it returns to sign-in.

Production issuers have the shape `https://{host}/realms/{org-slug}`. Locally the issuer is `http://localhost:8080/realms/kodera-dev`, the same one the iOS app uses: the emulator reaches the host's Keycloak through `adb reverse`, so Keycloak advertises the same issuer to both.

## Configuration

The client ID, the admitted issuer origins, the Core origin, the Console origin and the offline-access switch are `BuildConfig` fields fed only by Gradle properties: `kodera.clientId`, `kodera.issuerOrigins` (space-separated), `kodera.coreOrigin`, `kodera.consoleOrigin`, `kodera.offlineAccess` (exactly `true` turns it on), and, for debug builds, `kodera.devIssuer`. Set them with `-P`, in `~/.gradle/gradle.properties`, or in the untracked `local.properties` (copy `config/local.properties.example`). A build with none (CI's) shows "not configured". `check-app-resources.py` refuses: a URL literal in any app Kotlin, XML or Gradle file; a client ID, or a string passed to a deployment constructor, in app Kotlin; any string literal in `DeploymentConfiguration.kt`; a `KODERA_` build field fed by anything but its own property, or declared twice; a `kodera.*` property in the committed `gradle.properties`; and anything but loopback values (and `true`/`false`) in the example. That a release build never admits loopback and carries no development issuer is `app/src/testRelease`'s test; the one text rule refuses the literal `ADMIT_FOR_DEVELOPMENT` in app Kotlin outside `src/debug` and the test source sets, where code asks `LoopbackPolicy.admitsLoopback` instead. Staging and release values are supplied outside the repository.

Debug builds name `@xml/debug_loopback_cleartext` (in `app/src/debug`), which allows cleartext to `localhost` and `127.0.0.1` only, with the platform's default trust anchors. The release manifest names no network security configuration; CI checks both merged manifests.

## Workspace structure client

`CoreWorkspaceClient` (`:client`) reads the member-visible tree with `fetch(organisationId)`:
`GET /api/v1/organisations/{organisation_id}/workspace`, using the same session-owned
`CoreRequester` as `/me`. Call it off the main thread and supply an organisation from the
current membership; Core authorises and filters the view again. The client refuses an invalid
identifier before asking for a token, and refuses a response for a different organisation.

`WorkspaceOutcome.Loaded` carries the ordered `WorkspaceSnapshot`: setup and initialisation
state, nullable workspace ID, categories and uncategorised channels. Stored names and open
template keys are preserved. Channel metadata includes text/audio kind, active/archived
lifecycle and pending/ready/failed room state. A ready room establishes neither current Matrix
access nor a provider session. The decoder enforces required fields, closed enums, UUID and
text bounds, duplicate-key refusal and the requester's bounded body. It returns no partial tree.

`SignedOut` and `Unavailable` preserve the requester's session policy: one forced refresh on
401, no retry or sign-out on 403, and safe not-found, service, identity, protocol or transport
failures. Reads are unconditional and uncached, without `If-None-Match`; an unsolicited 304 is
a protocol failure. No prior view substitutes for a later refused read. The client owns no
requester or token, and does not close the session's requester. A consumer must fence an
already-sent answer against its session before presenting it.

The signed-in screen wires this reader to an inline read-only organisation channels section.
The controller retains the ID only when exactly one current `/me` membership matches the
admitted session realm; zero or ambiguous matches send no workspace request. A signed-in
resumed entry runs one `/me` then channels chain, clearing previous metadata before `/me`.
Duplicate resume/tap work is suppressed while that chain loads, with no queued retry or
response-driven loop. A settled refusal waits for an explicit retry or a later genuine
foreground entry. Retry starts with `/me`, not a cached organisation label.

Background, revalidation, new session (including the same issuer/realm), sign-out, replacement,
ended session and controller close invalidate the publication binding. Every answer is checked
on the main thread against the generation, read ticket, target organisation and same live
requester before it can change state. Already-sent calls may finish; this is logical stale-result
refusal, not physical wire cancellation or instant membership-revocation proof. An unknown
wire room state refuses the entire response as protocol failure, never an unknown row or a
partial tree. A 304 is invalid-response handling, not empty success or a cached view.

The screen uses existing native tokens/fonts, one scrolling container and safe-drawing insets,
with sign-out before metadata and explicit refusal retry before any list. During `/me`, only
profile progress is announced; channels progress/terminal status has a separate status-only
polite region and a silent spinner. Names wrap as plain text, with no channel button/chevron,
provider, call, initialisation or setup action. Linked room metadata establishes no current
provider access. The view makes no Matrix or media connection.

Controller host acceptance is `:app:testDebugUnitTest --tests
io.kodera.android.session.SessionControllerTests`, including held decoded answers crossing
same-realm/same-organisation reentry. Actual composite-publication-fence removal sensitivity
requires its own executed comparison; the written test is not that evidence. Keyboard/D-pad,
TalkBack announcements/focus, large-font long lists, narrow screens, scrolling and system
insets remain explicitly unmeasured until a separately admitted emulator/device run. This
change supplies no staging, signing, release or offline-access rollout evidence.

The reader's focused host acceptance is `:client:test --tests
io.kodera.android.client.CoreWorkspaceClientTests`, using synthetic metadata and the existing
bounded transport fixture. Host evidence does not establish a current live workspace,
channel content, device UX or staging readiness, and changes none of the offline rollout gates.

## Current identity projection reader

`CurrentCoreIdentityClient` is an unwired `:client` reader of `GET /api/v1/me`. It produces a
plain `CoreIdentity` observation for one current organisation, preserving the exact Core
subject, including case and punctuation. It creates no authentication certificate, Matrix
account or provider session, and changes no existing screen or session owner.

Its `OwnerPort` must capture one coherent real owner instance, exact borrowed `CoreRequester`,
accepted `Session` and target organisation UUID, and synchronously check that full binding.
Capture/currentness must be pure, bounded and nonreentrant. A retired owner marker must never
be reused. The protected sign-in configuration admits the issuer and checks its realm; this
syntax check cannot establish that an arbitrary requester belongs to that session. Core's
person projection can contain identities from linked issuers, so a body cannot detect a caller
falsely pairing another issuer's session with this requester. Successful replies do not carry
the serving SDK generation. Real App owner-port coherence and retirement remain unproved.

All lifecycle methods, state reads, owner-port updates and delivery tasks use the same supplied
serial context. `acceptCurrentOwner()` returns an opaque local owner handle; `beginRead(handle)`
clears prior identity and starts one worker. Duplicate loading reads share a handle. A later
explicit read fetches again, with no cached fallback or automatic retry. Cancellation/end
retire only the matching local read/owner; close permanently retires this reader. They never
close the borrowed requester/executors, revoke a grant or interrupt shared SDK work. Every
resolved, unavailable and SignedOut publication checks the complete private owner/read ticket,
live requester, issuer/realm/target and current owner port before synchronous state replacement.
Logical retirement does not physically cancel a sent request or instantly revoke membership.

Workers must execute off the serial context. Both supplied executors must execute accepted work
once eventually or reject synchronously; silent discard and worker CallerRuns are unsupported.
The per-read observer runs only for loading/final read state after internal state is committed.
It may accept/begin a new owner, cancel/end an old read or close the reader. Old finalisation
cannot overwrite that reentry. A throwing/reentrant owner port closes only this reader; a
throwing observer clears only its still-current read without recursively notifying itself.

`ReadHandle.completion` is a read-only stage. Its normal disposition distinguishes Delivered
(identity, unavailable or SignedOut) from Dropped; neither means identity success. It settles
only after the begin notification has returned, the actual worker callable has terminated,
and final queued reduction/drop and observer have finished or posting was explicitly rejected.
Worker/observer/owner-port throws and executor rejection complete it exceptionally, retaining
the first cause and secondary failures. Consumers must handle exceptional completion; actual
App consumption is deferred. Delivery rejection never invokes an observer on the worker:
the next serial state read/lifecycle entry safely reconciles only that still-current handle.
Exception text and response/subject data are not presentation or log copy.

The stable completion facade explicitly implements the 38 original API24 `CompletionStage`
members. It is not a mutable future; every `toCompletableFuture()` returns a fresh isolated
`thenApply` dependent. Completing, cancelling or obtruding a copy cannot settle the private
operation, change another copy or replace its true value/exception. Newer platform completion
APIs are not invoked by this facade. The host suite inspects the actual compiled ReadHandle,
facade and emitted completion helpers against a bounded platform member/signature allowlist.
Compiled original API31, newer-default, unknown member and unknown signature witnesses must
be refused without invoking them. This guards the inspected completion surface and does not
establish API26 device runtime or certify unrelated application bytecode.

Only status200 is parsed, through the existing requester's65,536-byte bound and StrictJson's
UTF-8, depth12, decoded-key uniqueness, surrogate and trailing-token checks. The minimal
projection consumes canonical root person id, staff=false, identities and organisations.
Every identity has unique canonical id and exact issuer, canonical realm and1–255 printable
ASCII subject. Every membership validates its organisation id/slug, nullable optional realm,
closed state and optional nonnull canonical identity_id. Realm strings equal their slug.
All current-realm memberships are counted before target/active filtering: ambiguity refuses
the whole answer. Exactly one active target must link to the exact session issuer/realm
identity. Missing links are ineligible; contradictory links are protocol failures. No array
order, email, person id, MFA or JWT fallback selects an identity.

Unused email/name/role/membership_id/display fields are intentionally ignored, including their
types; this is not full Me conformance. Ignored values still pass global JSON checks. The
existing requester retains bearer confinement, one401 refresh/retry and serving-generation
end policy.403 never retries/signs out;429/5xx are service failures; redirect/304/404 and other
unexpected statuses are protocol failures. No new token lookup or authority is introduced.

Focused host acceptance is `:client:test --tests
io.kodera.android.client.CurrentCoreIdentityClientTests`. The authored suite covers real bounded
transport/decoder selection, held decoded old identity across same-public-field new ownership,
whole-operation completion, executor/callback failures and reentry. Normal hosted CI supplies
execution qualification; no local compiler/test run or guard-removal sensitivity is claimed by
the authored tests. Device, live provider, App owner wiring, offline rollout and release gates
remain open.

## Not yet proven

- Android offline-on step 7: sign-in, resume after the online session ends, and per-client offline-session sign-out. The passed basic Core walk used offline access off.
- The Keystore store on a device: host tests seal and open the file with a software AES key; the Keystore key itself runs only on a device.
- The Cancel action, a stranded sign-in cancelled by a fresh Activity, the 10-minute bound, and rotation mid-flow: host-tested or compiled, not yet run on a device. TalkBack reading: not yet shown.
- Staging, after I-3. Device UX, account switching and accessibility on real devices.

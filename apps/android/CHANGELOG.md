# Changelog

## Unreleased

- Preserve consumed BLE duty across failed same-organisation provisioning, retire replaced scan windows before new radio operations, and keep an admitted call controllable when another push is refused. These paths are qualified with local fake adapters; device radio and native call qualification remain pending.

- Adopt the `ciel` (light) and `cielNuit` (dark) generated design-token palettes and frost glass panel materials (`CielGlassCard`, `CielBadgePill`, IBM Plex Mono bindings) across the entry, signed-in, voice/telecom, passkey, community and `#proximity` surfaces without modifying generated `KoderaTokens.kt`.
- Add the canonical three-category `community.kodera.io` workspace structure (`Community`, `Core Kodera`, `Design Partners`) with private-by-default internal room guards, federated Matrix partner badges (`Element`, `Tchap`, `Cinny`), universal Matrix invitation URI builder/parser (`matrix:r/...`, `matrix.to`, `#alias:domain`, `@localpart:domain`), `ChannelInviteCoordinator` and in-app clipboard `ChannelInviteSheet`.
- Add `PayloadFreePushEnvelope`, `CallSessionState` and `TelecomPushCoordinator` enforcing Core's payload-free `UnifiedPush` and `FCM` wakeup invariant (refusing any push payload carrying room titles, caller labels or message bodies) and driving deterministic `Idle -> WakeupPending -> Ringing -> Connecting -> Connected -> OnHold -> Ended/Rejected` `ConnectionService` transitions while keeping `AndroidManifest.xml` permissions and exported components unchanged.
- Add universal ES256 (`P-256`, COSE alg `-7`) WebAuthn / Android `CredentialManager` `PasskeyDeviceBinding` and `PasskeySessionCoordinator` with zero AAGUID lock-in (supporting hardware FIDO2 keys `0x05`, Android Keystore biometrics / Google Password Manager `0x0D`/`0x1D`, and self-hosted Vaultwarden / Bitwarden `"Citadel"` passkeys `0x0D`/`0x1D` while enforcing WebAuthn Level 3 `BS=1, BE=0` `0x15` rejection, RP ID hash, origin fence, low-S signatures and non-zero counter monotonicity).
- Add `ProximityBeaconV2` (`KP\x02` 27-byte rotating ephemeral beacon held byte-for-byte to `packages/kodera-rs/vectors/proximity-beacon-v2.txt`), HKDF-SHA256 / HMAC-SHA256 derivation, bounded per-window replay cache, `ProximityDutyCycleBudget` and `ProximityV2CheckInController` with explicit foreground opt-in consent and strict separation between online Matrix room relays and local BLE radio frames.
- Refresh native design tokens from the monorepo source and align local document bounds across clients.
- Rename the `#urgence` channel to `#proximity` (translated in the French catalogue) in code and copy, and state on its card that it is not an emergency service. The frame v1 wire bytes are unchanged and now held to vectors shared with the Rust core.
- Show check-ins under a pseudonymous handle, picked by the member or derived from the sender key inside the organisation, never a name; equal handles in a roster carry a key fingerprint.
- Remove the Open the Console action: the app is a companion and links to no page outside sign-in. The resource check now refuses commercial wording, prices, billing providers, billing addresses and any page opened from app code.

Status: Kodera for Android is in development; no store release is recorded here.

## Unreleased

### Fixed

- Verify and sign emergency frames on Android 8 to 12, whose platform provider has no Ed25519: the platform provider is used where it has Ed25519 and a bundled BouncyCastle lightweight implementation otherwise, with the same RFC 8032 bytes either way.

- Reject nil entity identifiers before session or network admission, bound voice/Docs scope metadata and rendered names/titles as valid scalar UTF-8, and retain only validated bounded snapshots of caller-supplied rosters and pad lists. Fence disposed or replaced emergency-card actions by their current organisation while preserving the signed wire protocol; align the bilingual around-me antenna heading above the workspace channels.

### Added

- Scoped local theme sharing, profile and permission simulation, and bounded Markdown drafts with bilingual preferences controls. Canonical pure-black monogram, three theme modes and four curated palettes are previewed locally; the default app supplies no fabricated member or document.

- Scoped local channel polls with bounded validated options, deterministic single/multi-choice preview voting, closed-poll refusal, stale-context fencing and bilingual accessible controls. The default app has no poll service, remote votes or persisted result.

- Scoped native sound preferences and bilingual preview controls with strict pack identifiers, explicit mute, volume and call-ducking policy. All output values are local estimates; no sound engine, hardware output, storage or media connection is added.

- Read-only bilingual Docs workspace card and scoped local metadata controller with strict HTTPS URL admission, bounded sorted pad lists and stale-preview refusal. No Docs API, navigation, document creation or authenticated collaboration is provisioned.

- Bilingual voice control dock and organisation/channel-scoped local preview controller with bounded participant indicators, deafen-implies-mute behavior and stale-callback refusal. The default dock explicitly has no live transport, microphone capture or remote audio; leaving, stopping and switching scope clear preview state.

- Signed emergency-frame v1 codec and rotating organisation beacon, a bounded transport-independent relay controller, and a bilingual #urgence check-in card. Provisioned callers can queue verified local check-ins; the default app explicitly remains unprovisioned, without a radio adapter or delivery claim.

- Read-only organisation channels on the signed-in screen: ordered categories and text/audio channel metadata with pending, linked or failed room labels, without channel, call or initialisation actions. Membership is revalidated before each signed-in foreground read and explicit retry. Previous metadata clears on revalidation, background and session end; late answers are bound to their session generation, read, organisation and requester. Sign-out and refusal retry precede long metadata. Keyboard, TalkBack, large-font and device qualification remain separate from host tests.

- Native organisation-entry screen, domain models and anonymous discovery client, built with a plain Gradle build and wrapper and tested in CI.
- Organisation discovery follows Core's `discoverRealm` contract (`contracts/v0.26.0`): lookups by slug or email, every documented problem as its own outcome (403 `forbidden` included), and entry states for "no organisation found", "try again later" after a quota answer, a connection problem, and several matching organisations.
- Sign-in with AppAuth: authorization code with PKCE S256 in a Custom Tab, against an issuer admitted from protected build configuration, with RFC 9207 `iss` required when the provider advertises it; the session is sealed with an Android Keystore AES-GCM key and kept out of backup and device transfer. `offline_access` is requested only when the build sets `kodera.offlineAccess=true`.
- One session owner per process: a cold start, offline included, opens the signed-in screen at once and refreshes behind it; a session that ends anywhere returns to sign-in and raises a "session ended" signal.
- The "session ended" signal is told once per ended session, at the wipe, with the ended session's identity and why it ended (explicit sign-out, refused refresh, Core's second 401, a replaced session, an unusable stored copy, or a rotated grant the store cannot keep), as on iOS. It is no longer told after every wipe, nor after the call that ended the session returns; a session a sign-in replaces is reported before the browser opens, and the signed-in screen leaves it to that sign-in.
- "Sign-in interrupted, try again" when the browser step outlives the app's process, and progress while the session is restored.
- A Cancel action while signing in. A sign-in no Activity can finish is cancelled as interrupted, and the browser step is cancelled after 10 minutes without an answer.
- Only an explicit sign-out revokes the refresh token. A replaced session, a failed or cancelled sign-in, a late rotation and Core refusing a fresh token wipe the session on this device and revoke nothing, since Keycloak's revocation ends the member's sessions for this client on every device.
- Signed-in screen showing the member's name and organisation from Core's `/api/v1/me`, with "Core unavailable" and "no access" states, and sign-out (refresh token revoked, session wiped).
- A local Keycloak (`dev/keycloak/`) with the `kodera-dev` realm and the `kodera-android` client, for development only.

### Changed

- Bind accepted sign-in/restore, launch refresh and Core requests to one service-issued owner receipt. Delayed old requests cannot borrow a replacement grant, publish its old results or end the replacement session, even when their public issuer and realm match. Already-admitted exchanges may finish with their original token; provider/device and Release App composition qualification remain separate.

- After a failed session wipe, the same sign-in service retries cleanup and refuses restore/resume for that call, without another session-ended signal. Normal cold restore and new interactive sign-in remain available; retained key/file material can still be restored by a new service instance.
- Core's 403 on `/me` is no longer a dead end: one "no organisation yet" message covers an owner still to finish setup and anyone without an active membership, with **Open the Console** (the browser at the `kodera.consoleOrigin` Gradle property, HTTPS only in release builds, hidden when unset) and sign-out.
- The "no organisation yet" state has a way back after the Console: **Check again**, and `/me` is fetched again when the app returns to the foreground, so an owner who finished their claim reaches the signed-in screen without signing out. Never while a fetch is in flight, and never in a loop.
- The Console opens in the browser AppAuth selects for sign-in (the intent names its package), with the plain intent only when no browser is found, and a short message when nothing can open it.
- Deployment values (Core origin, issuer origins, client ID, offline access) come from Gradle properties compiled into `BuildConfig`; the committed build stays unconfigured. CI also builds the unsigned release variant.
- A discovered issuer goes through `IssuerAdmission.admit`, the check sign-in runs, so one outside the configured origins refuses the answer before any sign-in is offered.
- Progress spinners use `accentInk` (at least 3:1 on every surface) and are silent to TalkBack next to their text.
- The interrupted-sign-in notice no longer shows while a sign-in is in flight, and clears on a successful sign-in.
- The dev realm grants `dev.member` the `offline_access` role and maps it into both native clients, so a build with `kodera.offlineAccess=true` signs in.
- A sign-in started while a sign-out still waits for a refresh revokes the old session itself before the browser opens, so that sign-out is no longer lost; and a sign-in waits for a sign-out's revocation still in flight, so it cannot end the new session.
- Every Core request is bound to the configured Core origin: Core clients name only a path, a path that could leave the origin is refused before any token is fetched, and one requester (one OkHttp client and pool) serves the whole session and is closed when it ends.

- Replace the inherited project-template presentation with Kodera's current product scope and native platform direction.
- Separate default-branch content, the proposed native foundation and the authentication/device work still in progress.
- Remove unused project-generation, web-hosting and cross-platform build scaffolding; use native contribution, review and release guidance.

### Removed

- The hand-rolled PKCE, authorization request and callback primitives, the launch-attempt owner and the external dispatcher, replaced by AppAuth.

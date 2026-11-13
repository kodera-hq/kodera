# Changelog

## Unreleased

- Adopt the `ciel` (light) and `cielNuit` (dark) generated design-token palettes across the entry, signed-in, call, passkey, community and `#proximity` surfaces.
- Add the canonical three-category `community.kodera.io` workspace structure (`Community`, `Core Kodera`, `Design Partners`) with localized FR/EN audience subtitles, federated partner badges, universal Matrix invitation URI builder/parser (`matrix.to`, `matrix:` URIs, `#alias:domain`, `@user:domain`), `ChannelInviteCoordinator` and clipboard-only `ChannelInviteSheet`.
- Add `PayloadFreePushEnvelope`, `CallSessionState` and `CallKitPushCoordinator` enforcing Core's payload-free VoIP push invariant and deterministic `idle -> ringing -> connecting -> active -> muted/held -> ended/failed` transitions without adding unqualified background modes to `Info.plist`.
- Add `PasskeyDeviceBinding` and `ASAuthorizationPlatformPublicKeyCredential` assertion bridging in `KoderaAuth` aligned with `kodera-rs` `passkey_binding` (strict `clientDataJSON`, ES256 UP+UV `0x05` flags, monotonic counter and bounded challenge expiry), plus `ProximityBeaconV2` vector-verified codecs, duty-cycle/battery bounds and foreground opt-in consent separating online Matrix room relays from local BLE radio check-ins.
- Refresh native design tokens from the monorepo source and align local document bounds across clients.
- Rename the `#urgence` channel to `#proximity` (translated in the French catalogue) in code and copy, and state on its card that it is not an emergency service. The frame v1 wire bytes are unchanged and now held to vectors shared with the Rust core.
- Show check-ins under a pseudonymous handle, picked by the member or derived from the sender key inside the organisation, never a name; equal handles in a roster carry a key fingerprint.
- Remove the Open the Console action: the app is a companion and links to no page outside sign-in. The resource check now refuses commercial wording, prices, billing providers, billing addresses and any page opened from app code.

Status: Kodera for iOS is in development; no store release is recorded here.

## Unreleased

### Added

- Explicit local workspace studio for validated shareable themes, profile/rank policy arithmetic and bounded Markdown drafts with escaped export. A current text-channel scope and explicit preview activation are required; no remote authority, collaboration or persistence is provided.

- Organisation/text-channel-scoped single/multiple-choice poll preview with bounded immutable option projections, one local voter, closed-poll mutation refusal, fenced callbacks and a translated token-based card. The app loads no poll and submits or saves no votes.

- Organisation-scoped local sound preferences with strict native pack identifiers, explicit mute and call-ducking policy, stale-context refusal and a bilingual token-styled card. The current app leaves controls unavailable and produces no audio or persisted preferences.

- Scoped Docs metadata preview state and stale-callback coordinator with strict public HTTPS URL policy and a bilingual read-only signed-in card. The default app remains unprovisioned and loads, edits and opens no documents.

- Organisation/channel-scoped voice call preview reducer with bounded participant metadata, mute/deafen invariants and stale-callback fences. The signed-in audio card explicitly reports unavailable live transport and disables controls; no microphone, remote audio or provider connection is created.

- Dependency-free emergency v1 frame/beacon codecs, Apple-platform Ed25519 signing/verification, and a bounded, organisation-provisioned relay coordinator seam. The signed-in screen can prepare an explicitly local-only check-in draft. Radio transport, trusted provisioning, peer delivery, physical-device qualification and emergency reliability are not implemented or claimed.

- Inline read-only organisation channels with ordered category/text/audio/room metadata, explicit retry and sign-out ahead of long lists. Foreground entry revalidates `/me`; old data cannot overwrite a new read or session. A late same-session failed-wipe result upgrades an ordinary end exactly once, preserving the existing next-launch wipe warning; a genuinely newer session excludes old effects. No channel, call, initialisation or provider action. Device accessibility/lifecycle qualification remains separate from host tests and unsigned builds.

- Native organisation-entry screen with anonymous discovery, in French and English, using the Kodera design tokens and fonts.
- Organisation discovery follows Core's `discoverRealm` contract (`contracts/v0.26.0`): lookups by slug or email, every documented problem as its own outcome (403 `forbidden` included), and entry states for "no organisation found", "try again later" after a quota answer, a connection problem, and several matching organisations.
- Sign-in with AppAuth: authorization code with PKCE S256 in a non-ephemeral system browser session, against an issuer admitted from protected build configuration; the session is kept in the Keychain on this device only.
- Signed-in screen showing the member's name and organisation from Core's `/api/v1/me`, with a "Core unavailable" state and sign-out (refresh token revoked, Keychain wiped).
- A local Keycloak (`dev/keycloak/`) with the `kodera-dev` realm and the `kodera-ios` and `kodera-android` clients, for development only, on both loopback address families.
- A session that resumes silently at launch, and returns to sign-in when the provider refuses the refresh; offline sessions (`offline_access`) behind the `KODERA_OFFLINE_ACCESS` build setting, off by default.
- "No access to this organisation" when Core answers 403, without a retry.
- The first launch after a reinstall wipes the session a previous install left in the Keychain.
- A progress indicator while the session resumes at launch.
- A sign-out or refused refresh whose Keychain wipe fails says so, and the next launch wipes the item before restoring anything.
- A sign-in that could not delete the session it replaced, and then did not complete, says so, and the next launch wipes the item before restoring anything.
- Bundle ID `io.kodera.app` and OAuth redirect URI `io.kodera.app:/oauth2redirect`.

### Changed

- Align the local around-me heading with its antenna mark and clear preparation sheets/drafts when their loaded organisation changes. Voice and Docs channel scope identity now preserves exact UTF-8 bytes so equivalent Unicode spellings cannot hide a channel transition. Native entity/session boundaries reject nil UUIDs while bounded format validation stays allocation-free; voice roster deduplication and row keys retain the same exact-byte identity.

- Authorised Core responses now stop accumulation at the existing 65,536-byte limit and request cancellation on overflow, including responses without a trustworthy declared length. The bound covers owned logical body bytes; it does not establish process-memory or physical-device limits.

- Core's 403 on `/me` is no longer a dead end: one "no organisation yet" message covers an owner still to finish setup and anyone without an active membership, with **Open the Console** (the system browser at the `KODERA_CONSOLE_ORIGIN` build setting, HTTPS only in Release, hidden when unset) and sign-out.
- The "no organisation yet" state has a way back after the Console: **Check again**, and `/me` is fetched again when the app returns to the foreground, so an owner who finished their claim reaches the signed-in screen without signing out. Never while a fetch is in flight, and never in a loop.
- The deployment reading moved into KoderaAuth (`AppConfiguration.read`), with the build's loopback policy passed in, so host tests prove the Console origin is checked with it.
- Deployment values (Core origin, issuer origins, client ID) come from build settings substituted into Info.plist; the committed configuration stays empty.
- A discovered issuer goes through `IssuerAdmission.admit`, the check sign-in runs, so one outside the configured origins refuses the answer before any sign-in is offered.
- The signed-in title reads "Connexion active" / "Signed in"; Retry and Cancel use a text colour that meets 4.5:1 in every palette.
- A refresh that fails for a transient reason (malformed or captive-portal response, clock skew, `temporarily_unavailable`) keeps the session instead of signing out.
- Only an explicit sign-out revokes the session at the identity provider, which ends it on every device. A sign-in that replaces a held session, a failed sign-in, a grant for another issuer and Core's second 401 now drop the tokens on this device only (a replaced session before the browser opens), so they no longer sign the member out elsewhere.
- A sign-in started while a sign-out still waits for a refresh revokes the old session itself before the browser opens, so that sign-out is no longer lost; and a sign-in waits for a sign-out's revocation still in flight, so it cannot end the new session.
- Core's second 401 ends only the session that served the refused token, so a late one no longer signs out a session that replaced it.
- A sign-in waits at most 15 seconds for a sign-out's revocation still in flight before the browser opens, as on Android.
- Every Core request is bound to the configured Core origin: Core clients name only a path, a path that could leave the origin is refused before any token is fetched, and one requester serves the whole session.
- Leaving a session invalidates its Core requester: from then on it asks for no token and sends no request. A request already in flight stops at its next check (before the forced refresh, before each send, and before a local session end); a request already sent is not cancelled.
- The sign-in service reports a session it ends to registered listeners, once, with the ended session's identity and why it ended (explicit sign-out, refused refresh, Core's second 401, a replaced session, an unusable stored copy, or a rotated grant the Keychain cannot keep), so features that keep data derived from it can erase that session's data and tell an explicit sign-out from every other end.

- Replace the inherited project-template presentation with Kodera's current product scope and native platform direction.
- Separate default-branch content, the proposed native foundation and the authentication/device work still in progress.

### Removed

- The hand-rolled PKCE request builder, callback parser, transaction store and browser bridge, replaced by AppAuth; KoderaDomain no longer depends on swift-crypto.
- Remove unused project-generation, web-hosting and cross-platform build scaffolding; use native contribution, review and release guidance.

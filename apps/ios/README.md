# Kodera for iOS

The native iOS and iPadOS client for **Kodera**, a collaboration workspace for organisations.

Kodera brings team conversations and calls into one workspace. The first product version targets text channels, audio and video. Collaborative Docs follow in V2. The apps use native interfaces and platform capabilities, with comfort, performance, accessibility and security as design priorities.

## Product and platform

- **This repository:** the Swift and SwiftUI client.
- **Mobile priority:** iOS and Android.
- **Desktop sequence:** macOS, then Windows and Linux, developed separately.
- **Product website:** [kodera.io](https://kodera.io).

## Development status

Status: Native foundation in development; no store release is available.

The actual App session model has an unsigned hosted Debug simulator test harness with synthetic authentication, isolated storage/defaults and per-session HTTP fixtures. It covers launch cleanup, decoded member/workspace composition, cancelled-read cleanup and old sign-out completion across a new session. It does not qualify live providers, physical Keychain/reinstall behavior, late decoded old data, release composition or distribution. See [the harness checks](docs/DEVELOPMENT.md#actual-app-model-harness).

The app (bundle ID `io.kodera.app`) has a native organisation-entry screen, an anonymous discovery client, sign-in with AppAuth (PKCE S256, system browser, Keychain session) and a Core `/api/v1/me` client behind a signed-in screen with inline read-only organisation channel metadata. A foreground read revalidates membership first and discards obsolete data; a delayed failed-wipe result remains attached to its session owner until a genuine new session replaces it. Channels cannot be opened or initialised here. The checked-in build is unconfigured; deployment values come from build settings (see [docs/native-auth.md](docs/native-auth.md)).

Authorised Core requests bound their owned response accumulator to 65,536 bytes. An oversized declared length is refused before body admission; actual incoming bytes are checked before every append, including absent or falsely small lengths. Overflow selects one result and requests cancellation before EOF. This bounds logical `Data.count`, not Foundation buffers, allocation capacity or process memory, and does not promise immediate network shutdown. Host tests separately witness session and fixture-worker drain.

A simulator walkthrough against the local Core e2e stack passed organisation discovery, password and one-time-code sign-in, `/me`, relaunch resume, sign-out and the unknown-identity 403 screen with offline access off. A separate iOS lab walkthrough also proved offline resume and per-client sign-out. See [the recorded scope and rollout gates](docs/native-auth.md). Staging, physical-device validation and store distribution remain open; release offline access remains disabled pending its proof and operator rollout gates. Channel content, audio/video and Docs remain roadmap work. VoiceOver, external keyboard, Dynamic Type, narrow layouts, insets and foreground focus/scroll behaviour of the metadata view remain unmeasured until a separately admitted device run. A host test or unsigned build alone does not establish a working sign-in journey or a shipping app.

## Proximity channel foundation

Status: Local codecs and foreground radio composition implemented; physical radio interoperability and deployed-service acceptance remain unverified.

`#proximity` (`proximity.title` in the catalogue) is an everyday presence channel inside one organisation, with a voluntary, pseudonymous check-in. It is not an emergency service, and the card always says so (`proximity.notice`). It was first named `#urgence`; the frozen v1 wire keeps its historical bytes (header `KE`, signed label `kodera-emergency-v1:`), and `Sources/KoderaDomain/EmergencyFrame.swift` keeps its file name because the reviewed-secrets ledger binds an entry to that path. `ProximityFrameVectorTests` holds the v1 codec to `packages/kodera-rs/vectors/proximity-frame-v1.txt`, and `ProximityBeaconV2VectorTests` holds the 27-byte rotating v2 discovery beacon (`KP\x02`, 5-minute window, 30-second grace, per-window pseudonym and HMAC tag) byte-for-byte to `packages/kodera-rs/vectors/proximity-beacon-v2.txt`.

A check-in is shown under a `ProximityHandle`, never a name: a pseudonym the member picked or one derived from the sender key under the organisation's beacon salt. A handle is a display label, never an identity or an authorisation input. `BLEProximityCoordinator.memberLabels()` judges equal handles over the whole provisioned roster and adds a key fingerprint to each; the fingerprint is keyed with the organisation's beacon salt, so it links nothing across organisations. `ProximityHandleTests` reads `packages/kodera-rs/vectors/proximity-handle-v1.txt`.

`KoderaDomain` implements both the shared proximity frame v1 wire and the rotating `ProximityBeaconV2` codec alongside `ProximityDutyCycleBudget` (bounded scan windows, cooldown intervals at or below 20% active duty cycle, Low Power Mode and 15% battery floors). The existing v1/v2 coordinator seams remain distinct from the voluntary radio session and its `KT` token wire; those codecs do not establish physical delivery.

The signed-in voluntary card obtains one current-epoch MAC capability through the accepted session's bounded Core requester after an explicit consent action. It binds the actual workspace UUID and rejects obsolete owner, workspace and foreground completions. Production provisioning accepts only the canonical six-field epoch lease, never a stable workspace master key. CoreBluetooth advertises the service UUID and reads the 32-byte token through bounded GATT connections; Bluetooth and local-network permission descriptions are localized. Leaving, backgrounding or losing the current session clears volatile provisioning. A selected duration is a consent upper bound of at most two hours: at each 15-minute key boundary the app stops radio use, authenticates again and can resume only within the original consent deadline. A refused or unavailable renewal stays stopped. Offline removal of a member cannot revoke an already issued current-epoch capability instantly; the lease ends strictly at the epoch boundary, without extending it by token clock skew.

The frozen `packages/kodera-rs/vectors/proximity-epoch-lease-v1.json` holds the native MAC frame to the server/Rust wire. Host tests cover expiry, attempted future-epoch use and stale completion fences; they do not qualify physical BLE, live membership revocation or peer delivery. Bonjour currently supplies discovery metadata, not an authenticated QUIC exchange or a measured distance. Direct-message and direct-call buttons remain disabled until real transports are supplied.

Frames are signed plaintext, not encrypted. The v1 signature does not bind an organisation, and TTL is unsigned for relaying. Beacon matching is not sender authority; the supplied roster and signature verifier are mandatory. A trusted provisioner must use organisation-specific signing identities if v1 is used for organisation isolation: reusing a device key in multiple organisation rosters permits a valid plaintext frame to be rebound to another observed beacon. This coordinator cannot inspect other organisations’ rosters or enforce that provisioning rule globally. Bounded replay memory and current-member ordering are not a permanent replay or radio anti-storm guarantee. No outage availability, background delivery, interoperability with physical devices or release readiness is claimed by host unit tests.

## Community workspace, Matrix invitations, CallKit wakeup and passkey binding

Status: Domain models, client coordinators and `ciel` / `cielNuit` SwiftUI surfaces verified in unit and simulator suites; live homeserver, VoIP PushKit relay and associated-domain entitlements remain external.

- **Three-category community structure and Universal Matrix Invitations:** `CommunityWorkspaceBlueprint` models the canonical `community.kodera.io` workspace (`Community`, `Core Kodera`, `Design Partners`) with localized FR/EN audience subtitles and federated partner badges. `UniversalMatrixInvitation` and `ChannelInviteCoordinator` build and parse `https://matrix.to/#/...`, `matrix:r/<alias>:<domain>?action=join`, `matrix:roomid/...`, `matrix:u/...`, canonical `#alias:domain` and `@user:domain` targets while rejecting malformed MXIDs and single-label or numeric hosts. `ChannelInviteSheet` copies links to the clipboard without opening external web pages and reports unprovisioned remote room-invite transports honestly.
- **OS CallKit and payload-free PushKit coordinator:** `PayloadFreePushEnvelope`, `CallSessionState` and `CallKitPushCoordinator` enforce Core's payload-free push invariant (`wakeup_id`, `organisation_id`, `sync_hint` only), rejecting or stripping any relay field carrying room titles, sender names or message plaintext before resolving encrypted call descriptors over the authenticated session and driving `idle -> ringing -> connecting -> active -> muted/held -> ended/failed` transitions (`CXProviderConfiguration.includesCallsInRecents = false`). `App/Info.plist` declares no `UIBackgroundModes` until live VoIP entitlement qualification.
- **Universal passkey assertion verification:** `KoderaAuth` implements `PasskeyDeviceBinding` and `PasskeyPlatformAssertionBridge` (`ASAuthorizationPlatformPublicKeyCredential`) aligned with `kodera-rs` `passkey_binding`, enforcing strict `clientDataJSON` parsing, WebAuthn Level 3 UP+UV authenticator flags (`0x05`, `0x0D`, `0x1D` under `.universal`, or `0x05`-only under `.strictNonBackupable`, rejecting invalid `0x15`, `AT`, `ED`, and RFU bits), monotonic counters, bounded challenge lifetimes and P-256 ES256 signatures.

## Companion scope

The app is a companion to a workspace its organisation already has. It carries no in-app purchase, no pricing or plan wording and no link to a checkout or an upgrade page. The "no organisation yet" state offers Check again and sign-out and no link to the Console; sign-in, inside `KoderaAuth`, is the only page opened in a browser. `scripts/ci/check-app-resources.py` refuses commercial wording or a price in the catalogue and `Info.plist`, such wording, a billing provider, a store purchase API or a billing address in `App/`, `project.yml` and the Swift packages, and any call in `App/` that opens a page. Its self-test reintroduces each case and requires its own refusal.

## Development

Read [the development guide](docs/DEVELOPMENT.md) for the source layout, build and test commands. [AGENTS.md](AGENTS.md) define the project instructions.

Changes use feature branches and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md). Licensing is defined in [LICENSE](LICENSE).

## Voice call dock

The signed-in card binds to current workspace audio-channel metadata and reports that live voice transport is unprovisioned. Controls are disabled; no microphone capture, remote audio, call join or transmission is performed. The dependency-free domain/client reducer supports explicitly local previews with 1–64 unique participant entries, stable ID ordering and mute/deafen preferences. Deafening always mutes; unmuting clears deafen. Opaque owner/generation/scope contexts reject obsolete local metadata callbacks after leave, stop, channel or organisation changes. These contexts are in-process operation fences, not authentication or membership verification, and copies of the value reducer retain ownership. A future real adapter must establish provider authority separately. No device voice, lifecycle or accessibility qualification is claimed by package tests or SDK compilation.

## Docs workspace metadata

The signed-in Docs card uses the current workspace's first active text channel as context and defaults to an explicit unavailable state. It creates no preview pads, loads no documents, opens no URL and grants no document access. The Domain/Client reducer supports explicitly local metadata previews with 1–32 unique pad summaries sorted by update time descending and UTF-8 ID ascending. Clear, leave, stop and scope replacement erase pads; opaque owner/generation/scope contexts reject obsolete local callbacks. Copies of the value reducer retain ownership, so these contexts are operation fences rather than authentication or membership proof.

A separate Docs metadata policy admits only bounded canonical public-DNS HTTPS URLs, with an omitted port or exact `:443`, non-empty ASCII paths and no userinfo, query, fragment, percent escapes, backslashes, dot segments or repeated slashes. This does not alter identity trust, resolve DNS, establish a trusted tenant origin or prove a pad exists. Native paths are not limited to the Desktop planner's `docs`/`pads` slug grammar. A future authenticated Docs adapter must separately establish service and membership authority. Read-only card compilation and package tests do not qualify live collaboration, WebView navigation, document access or physical-device accessibility/lifecycle.

## Local sound preferences

The native reducer uses exactly `givre`, `cristal`, `atelier`, `8bit`, `404` and `silent`. These identifiers follow the current native command contract; older Web catalogue slugs are not aliases and no automatic wire migration is claimed. Preferences default to Givre and volume 80 (0–100 allowed). Effective mute combines the explicit manual preference, Silent and zero volume. Choosing a non-silent pack at zero restores volume 80 while preserving manual mute. Clearing manual mute does not override Silent or zero volume.

Call ducking is a local policy flag, not evidence of an active call. For unmuted preferences it reports −6 dB and a rounded percentage gain (half the integer volume, rounded upward); muted preferences report zero gain and no active attenuation. These values are policy previews, not DSP measurements. Hardware is inactive in every state. There is no playback, synthesis, provider integration or persistence.

Owner/generation/scope contexts fence every preference mutation. Invalid volume leaves state and context unchanged; clear, leave, terminal stop and organisation replacement reset the pack, volume, mute and ducking. Copies of the value reducer retain ownership; its contexts are local operation fences rather than authentication. The signed-in card derives scope only from the current loaded workspace, hides stale scope synchronously and defaults unavailable with disabled controls. Physical-device VoiceOver, layout, lifecycle and actual audio behavior remain unqualified by package tests or SDK compilation.

## Channel poll foundation

Status: One-local-voter preview only; no poll service is provisioned.

`ChannelPollState` validates a trimmed question of 1–280 UTF-8 bytes and 2–10 unique trimmed labels of 1–120 bytes, without controls or format characters. Label and channel identity use exact UTF-8 bytes; no Unicode normalization is applied. Single choice replaces the previous choice and repeated selection is idempotent. Multiple choice toggles each option. `totalVotes` counts the one explicit preview voter only when their ballot is nonempty; selected options have one vote and 100 percent. Multiple selections therefore may sum to more than 100 percent. Shared bounded tally arithmetic rounds nonnegative percentages half up over distinct voters, never selected-option count. No remote counts are invented.

Closed previews refuse further choices and repeated close actions. Trusted owner clear/leave/stop/scope replacement can erase even closed state; terminal stop cannot be revived. Owner/generation/scope contexts fence vote/close callbacks, and obsolete preview disposal cannot clear its replacement. These are value-reducer operation fences, not authenticated voting credentials; copies retain ownership. A future service adapter must establish membership, poll identity, authorization, persistence and current remote results separately.

The signed-in card derives context from the current loaded workspace's first active text channel, synchronously hides old scope, and renders question/options as literal text with generated tokens and FR/EN selected/header/count semantics. Default composition creates no preview and displays unavailable copy. No poll is loaded, no vote is submitted or saved and no remote poll can be closed. Package tests and SDK card compilation do not qualify a full app build, installed-device VoiceOver/layout/lifecycle or real poll service behavior.

## Local workspace studio

The signed-in text-channel studio starts unavailable until explicitly opened as a volatile local preview. Theme codes use the strict shared `kodera-theme:v1:` schema and canonical padded base64, with a 2,048-byte total ceiling and four validated RGB presets. Native generated tokens render the selected light/dark/black preview mode; imported custom RGB values color only a contained sample and do not recolor the app shell. Immutable validated RGB values supply the sample components; interactive controls continue to use generated tokens. The monogram tile stays pure black.

Profile rank and channel-policy controls demonstrate local arithmetic only, never service authorization. Private owner/generation/scope contexts reject stale operations, and channel changes hide the previous draft before clearing it. Display/role fields admit at most64 UTF-8 bytes and document titles120 UTF-8 bytes, a conservative subset of character-count bounds. Markdown bodies admit at most64 KiB, render as literal text and export deterministic quoted frontmatter; no HTML, document server, persistence or remote editing is enabled. Host unit tests and installed-SDK card typechecks remain distinct from full app and physical-device accessibility qualification.

Native codec fixtures qualify the exact native v1 schema only. The existing Web encoder omits `id`, which the strict native schema requires, so legacy Web-to-native import is not qualified by these tests.

## Local lifecycle audit coverage

The host client suite exercises an integrated local preview journey across workspace preferences, themes, Docs, polls, sound and voice, then replaces its organisation and refuses captured old callbacks. Voice and Docs channel scopes compare exact UTF-8 bytes, so canonical-equivalent Unicode spellings do not mask a channel transition. Native entity and session boundaries reject nil UUIDs; the format-only UUID helper retains its narrower syntax contract and checks length before iterating without allocating a copy. These are local reducer and contract tests, not live service, radio, simulator UI or device accessibility qualification.

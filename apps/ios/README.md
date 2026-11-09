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

## Emergency continuity foundation

Status: Local codec/coordinator and preparation UI; radio delivery is not implemented.

`KoderaDomain` implements the shared emergency v1 wire and rotating beacon. Apple platforms use CryptoKit Ed25519; unsupported hosts refuse verification rather than accept an unverified signature. `KoderaClient` exposes a bounded, transport-abstracted coordinator requiring an explicitly supplied organisation salt and allowed device roster. No server provisioning contract or native BLE adapter is wired into the app. The signed-in around-me card uses an antenna heading and can prepare and replace a local-only check-in draft. A current loaded organisation and a captured preparation context are required; metadata loss, organisation replacement, departure and late callbacks cannot retain or overwrite another organisation’s draft. It never reports a sent check-in or confirmed safety status.

Frames are signed plaintext, not encrypted. The v1 signature does not bind an organisation, and TTL is unsigned for relaying. Beacon matching is not sender authority; the supplied roster and signature verifier are mandatory. A trusted provisioner must use organisation-specific signing identities if v1 is used for organisation isolation: reusing a device key in multiple organisation rosters permits a valid plaintext frame to be rebound to another observed beacon. This coordinator cannot inspect other organisations’ rosters or enforce that provisioning rule globally. Bounded replay memory and current-member ordering are not a permanent replay or radio anti-storm guarantee. No outage availability, background delivery, interoperability with physical devices or release readiness is claimed by host unit tests.

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

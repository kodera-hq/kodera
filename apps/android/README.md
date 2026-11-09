# Kodera for Android

The native Android phones and tablets client for **Kodera**, a collaboration workspace for organisations.

Kodera brings team conversations and calls into one workspace. The first product version targets text channels, audio and video. Collaborative Docs follow in V2. The apps use native interfaces and platform capabilities, with comfort, performance, accessibility and security as design priorities.

## Product and platform

- **This repository:** the Kotlin and Jetpack Compose client.
- **Mobile priority:** iOS and Android.
- **Desktop sequence:** macOS, then Windows and Linux, developed separately.
- **Product website:** [kodera.io](https://kodera.io).

## Development status

Status: Native foundation in development; no store release is available.

The app (`io.kodera.app`) has a native organisation-entry screen, an anonymous discovery client, sign-in with AppAuth (PKCE S256, Custom Tabs, a session sealed with an Android Keystore key) and a Core `/api/v1/me` client behind a signed-in screen with read-only organisation channel metadata. Each signed-in foreground entry revalidates membership before reading channels; obsolete answers cannot replace the current view. Channels cannot be opened or initialised from this screen. The checked-in build is unconfigured; deployment values come from Gradle properties (see [docs/native-auth.md](docs/native-auth.md)). Core requests and launch refresh are bound to the exact service-issued accepted owner, so a delayed request cannot borrow a replacement session’s grant. Debug controller HTTP tests and client TLS tests qualify source behavior separately; the current-identity reader remains unwired and Release App transport composition remains unqualified.

An emulator walkthrough against the local Core e2e stack passed organisation discovery, password and one-time-code sign-in, `/me`, relaunch resume, sign-out and the unknown-identity 403 screen with offline access off. Android offline-on step 7 was not run and remains unmeasured. See [the recorded scope and rollout gates](docs/native-auth.md). Staging, physical-device validation and store distribution remain open; release offline access remains disabled pending its proof and operator rollout gates. Channel content, audio/video and Docs remain roadmap work. The inline metadata view still needs actual keyboard/D-pad, TalkBack, large-font, narrow-screen and system-inset qualification; controller host tests and unsigned builds do not establish those results. A host test or unsigned build alone does not establish a working sign-in journey or a shipping app.

## Development

Read [the development guide](docs/DEVELOPMENT.md) for the source layout and the build and test commands. [AGENTS.md](AGENTS.md) define the project instructions.

Changes use feature branches and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md). Licensing is defined in [LICENSE](LICENSE).

## Emergency protocol foundation

Status: Implemented locally; radio and device qualification remain open.

`domain/EmergencyFrame.kt` implements the shared v1 signed plaintext format and rotating organisation beacon. `client/BleEmergencyMeshController.kt` verifies the authorised roster and Ed25519 signature (the platform provider from Android 13, a bundled BouncyCastle lightweight implementation below it) before replay admission or state updates, and bounds relay/replay storage. A provisioned caller can supply `EmergencyCheckInSession` to the signed-in Compose card; the ordinary Core session does not provision a device key, organisation salt or emergency roster. The default app therefore says it is unprovisioned and exposes no pretend send action. A real BLE transport, protected provisioning and persistence, Android provider support, background operation, cross-device delivery and accessibility on physical devices are not qualified by host tests. Signed frames provide authentication, not confidentiality or a guarantee of help.

## Voice control foundation

Status: Local preview only; live voice is not provisioned.

`VoiceCallState` and `VoiceCallController` provide deterministic organisation/channel-scoped local preferences with a 64-participant maximum. Deafen forces mute; unmuting clears deafen. Preview updates require an opaque context bound to the controller, scope and generation; leave, stop and every scope switch invalidate that context and erase the roster/preferences. This is an in-process preview capability, not provider authentication, channel membership, microphone permission or media authority. A future real adapter must establish all of those independently. No state in this implementation represents capture, transmission or remote playback.

The signed-in voice dock defaults to explicit transport-unavailable copy and disabled controls. A caller can inject a `VoiceCallDockSession` for a local preview only when its organisation and active audio channel match currently loaded workspace metadata. The observer clears the visible preview immediately when its context expires, and disposing its card clears only its own preview lifetime. There is no join-call button or transport adapter in this change. Native accessibility, lifecycle on physical devices and real service/media integration remain unqualified by host tests and Kotlin compilation.

## Docs workspace foundation

Status: Read-only local metadata preview; collaborative Docs service is not provisioned.

`DocsWorkspaceState` and `DocsWorkspaceController` hold 1–32 unique pads in an organisation/text-channel scope, sorted by update timestamp descending and ID ascending. Input size is checked before traversal/copy, and snapshots are defensively owned and read-only. Pad URLs require canonical HTTPS public-FQDN syntax, a lowercase alphabetic TLD of at least two letters, omitted or exact `:443`, no credentials/query/fragment, and nonempty ASCII-unreserved paths without dot segments or repeated slashes. Percent escapes and backslashes are refused before URI parsing to avoid encoded or normalized path ambiguity. This is a conservative syntax policy, not DNS resolution, host ownership, authenticated service discovery or document-access verification. Existing authentication trust policy is unchanged.

Preview contexts bind controller ownership, generation and scope. Invalid updates leave state untouched; leave, terminal stop and every scope switch clear pads and invalidate prior contexts. UI subscriptions clear expired previews and unsubscribe on disposal; an obsolete card cannot clear a replacement preview. Configured scope remains metadata after clear. Preview contexts are local operation fences, not provider credentials or membership proof.

The signed-in card accepts an injected session only for the current loaded organisation and an active text channel. Default app composition supplies no preview and reports that Docs is unavailable. Titles and admitted host/path metadata are read-only text: no network request, automatic browser/WebView, link action, creation or editing is implemented. Physical-device lifecycle, TalkBack/layout and real authenticated Docs service integration remain unqualified by JVM tests and Kotlin compilation.


## Sound preference foundation

Status: Local policy preview only; no renderer, hardware output or persistence is provisioned.

`SoundPackId` strictly admits `givre`, `cristal`, `atelier`, `8bit`, `404` and `silent`. These native identifiers follow the current native contract; existing Web renderer identifiers are unchanged and no automatic alias conversion is supplied. `SoundPreferencesState` defaults to Givre and 80 percent volume, validates volume from 0 to 100, and exposes the active pack, effective mute, call-ducking policy, estimated integer gain and active attenuation. Effective mute combines manual mute, the silent pack and zero volume. Clearing manual mute does not make a silent pack or zero volume audible. Selecting a non-silent pack at zero volume restores 80 percent while preserving manual mute.

Call ducking is an explicit local policy flag, not a real-call detector. Audible values use a minus six decibel estimate, rounded to `(volumePercent + 1) / 2`; muted values have zero gain and zero active attenuation. The volume and attenuation fields describe policy only, even in an unprovisioned or stopped snapshot. `isAudioHardwareActive` is always false. No synthesis, playback, speaker, microphone, media transmission or preference storage occurs.

The controller requires an opaque owner/generation/organisation context for every preference mutation. Invalid input preserves the current state/context; leave, terminal stop and scope replacement reset all preferences and invalidate old handles. Scope remains correlation metadata after clear. Observers are capped at 64 and released on disposal; an obsolete card cannot clear its replacement preview. These handles are local operation fences, not authentication or media authority.

The signed-in card accepts an injected preview only for the currently loaded workspace organisation. Default app composition supplies none and displays explicit unavailable copy. Generated tokens and FR/EN TalkBack labels distinguish manual mute from effective silence and estimated policy from real audio. JVM tests and Kotlin compilation do not qualify installed-device accessibility, lifecycle, audio output or real provider integration.

## Channel poll preview

Status: One local preview voter; no poll backend or remote result source is provisioned.

`ChannelPollState` validates canonical organisation/channel context and 1–280 UTF-8-byte questions, bounds option count to 2–10 before a fixed indexed copy, then validates the retained unique 1–120-byte labels. Text must be trimmed, nonblank and free of control/format characters or malformed UTF-16. Label identity is exact; no Unicode normalization silently merges labels. Snapshots are immutable and defensively owned. Single-choice reselect is idempotent and a different choice replaces it; multi-choice toggles each selection. A nonempty local ballot counts as one voter regardless of the number of selections. Per-option percentages use half-up rounding against voters with nonempty ballots; multi-choice percentages can sum above 100. No remote count is fabricated.

Closed polls reject voting and repeated close without changing results. Trusted owner leave, stop or scope replacement can always erase the preview; stop is terminal. Owner/generation/scope contexts fence every preview mutation, including closure, and stale handles cannot follow or clear replacement previews. Observers are bounded to 64 and released on disposal. Contexts and canonical IDs are local correlation fences, not authenticated membership, author roles or real voting authority.

The signed-in card accepts an injected preview only for the currently loaded organisation and active text channel. Default composition supplies none. Generated tokens and FR/EN semantics group each option action with its literal label and local count, using radio or checkbox behavior as appropriate. No endpoint, account, network vote, persistence or provider permission is added. JVM tests and Kotlin compilation do not qualify installed-device TalkBack/layout/lifecycle or a real server poll flow.

## Local workspace preferences

The Domain theme codec uses exact `kodera-theme:v1:` codes capped at2,048 UTF-8 bytes, canonical padded standard base64, strict unique/known JSON fields, five bounded canonical RGB tokens and four curated palettes. Theme names/authors use1–64 UTF-8 bytes. The canonical monogram vector is ported from the existing white mark; its tile is always pure black, independently of custom palettes. The card previews admitted palette values locally and retains generated typography/spacing for controls.

`KoderaUserProfile` and `ChannelIamPolicy` are local simulation values, not authenticated identity or authorization. User IDs must be canonical non-nil UUIDs; display/role names use1–64 UTF-8 bytes as a conservative subset of character limits. Read is prerequisite for every other right; poll/connector flags remain independently gated. The controller starts unprovisioned with no profile or document. The current loaded workspace can opt into an explicit offline synthetic-guest preview for its first active text channel; a supplied preview handle is also supported. No preview starts before this action. Every operation is fenced by its organisation/channel, owner and generation. Leaving, stopping or switching scope erases private preview values and invalidates captured handles. Scope replacement/disposal stops the old local owner. The signed-in card only accepts a matching currently loaded organisation and active text channel; it never derives privileges from editable rank text.

`DocsPadDraft` retains at most65,536 UTF-8 bytes of literal Markdown, starts at a positive revision, rejects overflow transactionally and exports deterministic quoted YAML frontmatter. Titles are1–120 UTF-8 bytes; body newlines/tabs remain allowed, while malformed surrogate/control/format text refuses. There is no HTML renderer, remote document service, sync, persistence or authenticated write operation. Imported theme and draft text are data, never executed. Actual TalkBack, large-font layouts, keyboard/device lifecycle and service integration require separate interactive qualification.

## Local audit boundaries

Entity and session admission requires canonical non-nil UUIDs; the format-only helper remains separate. Voice and Docs local scope metadata retains the existing256-byte bound, rejecting malformed UTF-16, controls and format characters before UTF-8 retention. This local metadata bound differs by one byte from the iOS255-byte helper; actual Core entity channel IDs are canonical UUIDs. Emergency-card actions use a disposable current-organisation lease before message-ID generation or queue mutation. The around-me label and antenna do not change signed emergency wire v1.

Emergency v1 authenticates signed plaintext, not tenant intent or confidential content. Organisation beacons are public filtering tags and are outside the signature transcript. If a signing key is admitted by two organisations, retagging a valid frame with the second public beacon remains admissible there. Live provisioning therefore needs organisation-distinct signing keys or a reviewed future organisation-bound wire format; ordinary Core membership does not establish radio authority. Host JVM and compiler checks do not qualify physical BLE, device TalkBack or delivery.

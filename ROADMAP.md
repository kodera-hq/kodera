# Kodera Product & Engineering Roadmap

Status: Active (Status-driven — see [AGENTS.md](./AGENTS.md), Rule 7)

**The authoritative roadmap is the backlog of `kodera-hq/kodera`: its issues and its GitHub Project.** This page is a summary of it, grouped by track and carrying a status, never a date. Where this page and the Project disagree, the Project is right and this page is to be corrected. What already ships is described in [`README.md`](./README.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Kodera is a public open-core monorepo: nothing listed here is held back from the open-source tree unless it is named under Track 6.

## Track 1 — Foundation & Open-Core Monorepo (`Status: Implemented`)

- [x] Unified `@kodera/*` monorepo (`apps/`, `packages/`, `extensions/`, `deploy/community/`, `ee/`)
- [x] `@kodera/design-tokens` ("Cobalt × Kodera — givre") with automated contrast & grammar CI gates
- [x] `kodera-server` OpenAPI 3.1 contract-first control plane (`0.61.0`), ADR-0003 secret isolation & `room_access` sidecar
- [x] Matrix-backed channels and LiveKit audio rooms in the web client, governed by `kodera-synapse-policy`
- [x] `kodera-rs` zero-unsafe Rust core (`UuidV7`, `Ed25519` traits, OpenMLS/Megolm primitives, `SFrame` v1 media framing, `KVKB1` key-backup envelope validation, durable device/session state, universal ES256 passkey binding, `#proximity` frame v1/v2 codecs)
- [x] `@kodera/extension-sdk` (`0.2.0`) HMAC-signed webhooks, declarative `kodera.widget.v1` sandboxed cards, `create-kodera-extension` scaffolder CLI, and 23 reference implementations (the `/hello` starter plus 22 domain connectors) with a generated catalogue
- [x] Hardened `deploy/community` profile (Synapse on PostgreSQL, federation closed by default, rate limits, no public agent API), checked on every change
- [x] End-to-end fresh-volume cold-start verification of `deploy/community` in CI, with measured runtime and memory footprint
- [x] Companion self-host maintenance CLI (`deploy/community/kodera-ctl`) for ordered, health-gated upgrades with pre-quiesce image staging, write-quiesced atomic `0700`/`0600` PostgreSQL snapshots and automatic rollback, paired with the headless STUN/TURN UDP diagnostic probe (`deploy/community/webrtc_probe.py`) ([operations guide](./docs/self-hosting/kodera-ctl-and-webrtc-probe.md))

## Track 2 — Collaboration, Governance & Workspace Lifecycle (`Status: Implemented in tree; hosted Community cutover promoted`)

- [x] Direct messages and bounded group conversations, file and image upload, and message search in the web client
- [x] Camera video and screen sharing in rooms. LiveKit alone carries voice and video.
- [x] Public local Community rooms using Matrix's native join rules and control-plane moderation
- [x] Canonical-realm Community self-signup and default membership; optional TOTP is configured in the operator's identity provider
- [x] Native Docs & Collections: a block editor inside `apps/web` (ProseMirror/Tiptap and Yjs, MIT-licensed, no GPL add-on), PostgreSQL document permissions and a Yjs sync service, page trees, wikilinks, backlinks, search, and typed Collections (`Table`, `Kanban` and `List` views)
- [x] Workspace moderation, reusable invite links, scoped attachments, text-only unfurling, notification history and payload-free Web Push
- [x] Transactional workspace quotas, cardless SMB self-serve (`POST /api/v1/workspaces/self-serve`, `<= 5` seats, `5 GiB` storage, `< 5 s` creation-to-chat on shared OIDC realm), Factur-X `380`/`381` PDF/A-3 + XML deterministic invoice ledger, VIES VAT evidence, supervised dunning, Stripe billing webhook verification, and GDPR Art. 17/20 signed exports and erasure (`KODERA_BILLING_ENABLED=false` on self-hosted Community)
- [x] Extension runtime v2 in the control plane: scoped workspace installation, key rotation, reconciliation, dual-key HMAC signed webhook/slash-command delivery with pinned-IP SSRF guards, bounded `Slack` / `Discord` / `Notion` importers with streaming 64 KiB archive decompression, magic-byte MIME validation, zero-mutation dry-run simulation, verified-email member matching (zero privilege escalation), idempotent Matrix room/thread history replay, and bounded live coexistence bridges on non-confidential channels
- [x] `Kodera Passport`: signed PKCE cross-workspace magic-link sign-in, multi-organisation workspace switcher and account-erasure integration alongside per-realm OIDC + WebAuthn passkeys
- [x] Default-off sovereign `ai_gateway` (`KODERA_AI_GATEWAY_ENABLED=false`) with three-tier opt-in (`org -> channel -> member`), EU-sovereign `MistralAdapter` / SSRF-guarded self-hosted / HKDF-SHA256 AEAD-sealed `ByomAdapter`, and triple-layer `403` confidential/E2EE/unclassified refusal across control plane, `room_access` and `kodera-synapse-policy`
- [x] Signature audio & call experience: zero-allocation `KoderaVoiceVisualizer` (`AudioWorklet` + `AnalyserNode` fallback), async voice notes (`audio/ogg`, `audio/webm`, `audio/mp4`) with confidential-room capture guardrails and opt-in `ai_gateway` transcription, localized `/poll` timeline & live-call `PollCard` overlay, and `AudioDock` procedural soundboard
- [x] Messages mode and workspace administration: discreet Pro/Messages icon switcher, full-page master/detail messaging with mobile back navigation, arrivals precedence across web/server/native, and workspace logo, display name, landing channel, default mode and member preferences ([specification](./docs/specs/H2_6_MESSAGES_WORKSPACE_ADMIN.md))
- [x] Community workspace monetization: workspace boosts & hosting credits with EU OSS 27-state VAT and Factur-X `380`/`381` invoices/credit notes, plus Stripe Connect VIP passes and DAC7 `DPI2` annual seller reporting (web-only settlement; zero mobile in-app purchase)
- [x] Ephemeral AI translation & live call captions: viewer-ephemeral written channel translation (`8` EU languages) and multi-party consent-gated LiveKit call captions (`LiveCallCaptionSession` state machine, auto-pause on unconsented join, immediate stop on withdrawal, zero transcript persistence) ([specification](./docs/specs/H3_2_LIVE_TRANSLATION.md))
- [x] Sovereign smart calendar, zero-PII booking & whiteboard: CalDAV calendar sync with pinned-IP SSRF guards and HKDF-AEAD sealed credentials, public zero-PII `.ics` booking pages, and collaborative Yjs `<canvas>` whiteboard
- [x] Workspace cybersecurity posture advisor: deterministic `0–100` posture score across six weighted governance, sovereign AI, alert-routing, extension key-rotation, least-privilege role, and confidential-room checks with 1-click safe remediations
- [x] Sandboxed extension widgets, scaffolder CLI & marketplace (`v0.2.0` track): declarative `kodera.widget.v1` channel cards rendered inside script-isolated `sandbox=""` containers with control-plane `invokeChannelWidgetAction` relay and confidential-room refusal, zero-dependency `create-kodera-extension` scaffolder CLI, and web-only extension marketplace listings, checkout, and workspace installation
- [x] Workspace custom emojis, *Send Later*, personal reminders, waiting-room ambience & *Kodera Labs* (`v0.2.0` track): pure-Python RIFF/WebP metadata-sanitized custom emojis (`:shortcode:`), idempotent scheduled channel/thread messages and personal reminders with confidential-room refusal and delivery-time membership/policy/erasure revalidation, procedural waiting-room ambience with speech ducking, per-member *Kodera Labs* workspace toggles, and CSP-safe `blob:` composer & inline channel image attachment previews
- [x] Media socket initialization preserves a live signing worker during tenant-agent reapply, with signal-safe graceful worker shutdown
- [x] Hosted Community tenant promotion, identity-provider cutover to `auth.kodera.io` and release evidence
- [x] Automated isolated backup/restore rehearsal (`deploy/community/kodera_ctl.py rehearse-restore`, transactional outbound disarm, GDPR Art. 17 erasure replay across Passport/E2EE/EE domains, S3 object reconciliation, billing signatory scrub and audit-ledger commitment re-seal); subsequent exact-release live deployment acceptance remains operator-gated

## Track 3 — Native Clients (`Status: Foundations implemented; native transports and distribution in progress`)

- [x] Companion client foundations in `apps/ios` (SwiftUI) and `apps/android` (Jetpack Compose) with *Dark Precision* / *Light Givre* design parity, native Matrix room messaging (`m.login.token` SSO, bounded `/sync`, replies, edits, redactions, single-grapheme reactions, Core-scoped attachments), golden-vector-verified `PacketDispatcher` and `KDV1` session vault parity across `kodera-rs`, Swift (`CryptoKit`) and Kotlin (`javax.crypto`) (`vectors/mobile-ffi-v1.txt`), CallKit / `ConnectionService` call seams, payload-free push wakeup integration and universal WebAuthn passkeys (no in-app purchase and no pricing screen)
- [ ] Remote Matrix room-invitation delivery, real audio/video/call media adapters and linked native Rust client binaries (unmangled C-ABI exports remain gated while `#![forbid(unsafe_code)]` is in force)
- [x] Native mobile VoIP call admission, CallKit/Telecom runtimes, `kodera-rs` ring deduplication and live Matrix active-call room sync
- [ ] End-to-end native push delivery and device/provider qualification
- [x] Reproducible native candidate verification and reviewed SPDX SBOM provenance gates across desktop and mobile targets
- [x] Web Push notifications that wake the web client without carrying message text
- [x] Origin-fenced `tao`/`wry` native desktop host and Tauri-compatible IPC bridge (`@kodera/desktop`) with `kodera://` / `matrix:` deep-links, tray/mute and media-capture controls, opt-in Push-to-Talk with focus-loss release safety, persistent OS keychain backend (`security` / `secret-tool` / `PasswordVault`) with atomic `0600` metadata index and zeroized RAM cache, macOS Hardened Runtime entitlements/`notarytool` and Windows `signtool.exe` release-signing hooks, and direct GitHub Releases multi-OS desktop (`.dmg`, `.AppImage`, `.deb`, `.msi`, `-setup.exe`) and Android (`.apk`) distribution workflow with `SHA256SUMS.txt`
- [x] Automated self-host stack deployment and preflight orchestration inside the Kodera Desktop self-host wizard
- [ ] Operator certificate provisioning for OS-notarised macOS and Authenticode-signed Windows public installers, background iOS PushKit provisioning, and published Apple App Store / Google Play companion listings

## Track 4 — Confidential Rooms & Federation (`Status: Transport & device primitives shipped; group coordinators in progress`)

- [x] Cryptographic primitives, device lifecycle, durable session state, modern `openmls_*` crypto-provider generation, `wasm32` browser device-proof bindings and LiveKit media-frame encryption seams in `packages/kodera-rs` (scoped OpenMLS RFC 9420 and Vodozemac Megolm), paired with atomic browser IndexedDB confidential vault storage (`apps/web/src/features/confidential/`), and default-off `/api/v1/organisations/{organisation_id}/confidential/*` opaque envelope and HPKE KeyPackage relay (introduced in `0.47.0`/`0.51.0`; current contract `0.61.0`)
- [x] Revisioned bilateral `PartnerChannelAgreement` bridges and isolated `single_channel_guest` grants with live Matrix/media revocation checks and a required edge scope gate
- [x] Opt-in open Matrix federation (`KODERA_FEDERATION_MODE=open`, closed by default on `deploy/community`) alongside explicit partner-room federation governance in `packages/synapse-policy` (`0.1.8`)
- [x] Refusal of plaintext fallback and room-store quarantine for unavailable confidential or unclassified sessions (#180)
- [x] Worker-isolated attachment/Pages/LiveKit media cryptographic capabilities (#169, #177, #182), local SAS device comparison and `KVKB1` encrypted local key archives (#183)
- [x] Operator-gated server confidential room/session discovery, consecutive MLS epoch provisioning and proof-bound cross-signing publication
- [x] Operator-gated server opaque `KVKB1` key-backup publication, monotonic epoch rotation and soft-zeroed discard (`0.60.0`; current contract `0.61.0`; client `deviceSigner` publication wiring `Planned`)
- [ ] Durable browser/native MLS group integration, native key management and interoperable LiveKit media qualification

## Track 5 — `#proximity` (`Status: Broker & foreground radio layers shipped; physical two-device qualification open`)

- [x] `#proximity` signed frame v1 frozen wire format and v2 rotating frame codec in `packages/kodera-rs`, with replay guards and mobile async duty-cycle fences
- [x] Voluntary `#proximity` check-in over RAM-only Unix socket `/run/proximity/broker.sock` (`python -m apps.proximity.broker_rpc`), 15-minute rotating HKDF-SHA256 epoch leases, and foreground iOS (`CoreBluetooth` / `Network.framework`) and Android (`BLE GATT` / `NSD`) radio adapter layers ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)). It is not an emergency service.
- [ ] Physical two-device `mDNS + QUIC` and `BLE GATT` radio interoperability qualification

## Track 6 — Managed Hosting & Enterprise (`Status: Implemented in tree; live operator activation gated`)

- [x] Enterprise Edition (`ee/`): SAML 2.0 corporate federation, SCIM 2.0 provisioning, and `Ed25519`-signed compliance audit exports ([`ee/README.md`](./ee/README.md))
- [x] Commercial price schedules (`PRO2-S`/`PRO2-M`/`PRO2-L` right-sized Sovereign tiers), Autopilot warm-pool governance (`<= 3` pre-warmed cells with automated Stripe settlement claim + cold fallback), enterprise purchase-order settlement, per-tenant FinOps COGS attribution reconciliation, and operator SRE diagnostics (`GET /staff/v1/read/sre`, `manage.py sre_status`) ([`ee/billing`](./ee/billing/README.md))
- [ ] Live payment-provider endpoint activation and external managed-fleet tenant provisioning

The generic invoice ledger and the payment engine already in `apps/server` stay open source; see [`GOVERNANCE.md`](./GOVERNANCE.md).

## Track 7 — Universal Zero-Knowledge & End-to-End Encryption by Default (`Status: In progress`)

- [x] Three-tier conversation encryption policy & room-boundary model (`v0.2.0` track): `tier-3-standard-channel` workspace channels (`#arrivals`, `#general`) remain server-readable by design for newcomer history and connector compatibility without a misleading padlock; `tier-1-default-e2ee` default `1:1`/group DM E2EE remains `Planned` below (ordinary DMs are server-readable private rooms today); `tier-2-opt-in-confidential` channels and rooms (`🔒`) enforce fail-closed refusal of plaintext fallback, server AI, scheduled messages, reminders and plaintext server indexing while full end-to-end client UX remains `Planned`
- [ ] Full retirement of clear-text homeserver room storage across universal MLS/Megolm group coordinators, plus client `deviceSigner` (`KVKB1` server publication) and epoch-key (`KDE1` confidential Pages) UI wiring
- [x] Worker-isolated client AEAD capabilities for confidential Yjs document updates/snapshots and attachments; protected sessions refuse plaintext fallback
- [x] Worker-isolated LiveKit `SFrame` v1 E2EE media framing (`kodera-rs` + browser WebWorker transforms), fail-closed `room_access` confidential call admission, SAS device comparison and user-held encrypted `KVKB1` local key archives
- [x] Operator-gated server confidential room/session discovery and trusted epoch provisioning
- [x] Server-side encrypted collaboration relay admission (`KDE1` opaque envelope framing, epoch-bound `docs_collab_fence` verification and fail-closed WebSocket `4403` refusal on unsealed frames; client epoch-key wiring `Planned`)
- [x] Operator-gated proof-bound server cross-signing publication
- [x] Server-side operator-gated opaque `KVKB1` key-backup publication, monotonic epoch rotation and local browser WebWorker recovery primitives (client `deviceSigner` server publication and native client key-backup wiring `Planned`)
- [ ] Mandatory `kodera-rs` cryptographic store binding across `apps/ios` and `apps/android`, and end-to-end media encryption (`SFrame` / MLS epoch keys) on all LiveKit voice, video and screen-sharing sessions
- [x] Metadata minimisation and client-local encrypted full-text search (`kodera.espace-vault.v1` v2 `search_index` shards, non-extractable `HMAC-SHA-256` blind term tags, synchronous `#180` quarantine eviction and zero query network egress) so confidential search indexes never exist in plaintext on the server

## Milestone Summary (`Status: Foundations implemented; universal E2EE & store signing in progress`)

The [collaboration status](./docs/specs/collaboration-status.md) records the repository boundaries and separates merged source code from operator-run cutover and distribution gates:

- **Core Billing & Governance (`Implemented`):** typed Collections, transactional quotas, Factur-X `380`/`381` ledger, VIES validation and GDPR Art. 17/20 export and erasure. Community self-hosting remains independent of billing.
- **Native Foundations (`Foundations implemented; mobile transports and distribution open`):** `kodera-rs` OpenMLS/Megolm/Passkey/proximity codecs, reproducible native SBOM gates, `tao`/`wry` native desktop host + Tauri-compatible bridge and iOS/Android companion implementations.
- **Extensions, Importers & Federation (`Implemented`):** extension runtime v2, 23 reference implementations, `Slack`/`Discord`/`Notion` importers, bounded partner-room and opt-in open federation controls, developer docs + `llms.txt`, and multi-surface security hardening.
- **Self-Host Cold-Start, Enterprise & Proximity (`Implemented in tree; hosted Community promoted; signing & group-integration gates open`):** `deploy/community` fresh-volume cold-start footprint gate, Zero-Trust `/staff/v1/*` surface and `.well-known` discovery, Desktop self-host stack deployment, `Kodera Passport` cross-workspace magic-link PKCE sign-in, Enterprise `ee/` (`SAML 2.0`, `SCIM 2.0`, `Ed25519` audit exports, `ee/billing/`), `kodera-rs` `wasm32` browser device-proof bindings, modern `openmls_*` crypto-provider generation, default-off confidential envelope relay, atomic browser confidential local-state vault, RAM-only `#proximity` check-in broker + 15-minute HKDF epoch leases + foreground native BLE/mDNS layers, and multi-OS release workflow; durable group integration, physical two-device radio qualification, and signing gates remain open.
- **`v0.2.0` Workspace Experience, Confidentiality Primitives & SMB Self-Serve (`Implemented in tree; universal E2EE and native media qualification in progress`):** refusal of plaintext fallback and room quarantine, worker-isolated attachment/Pages/LiveKit `SFrame` v1 media cryptographic primitives, fail-closed `room_access` confidential media admission, worker SAS device comparison, `KVKB1` encrypted local key archives, partner bridges and single-channel guest grants, Messages mode and workspace administration, isolated `kodera_ctl.py rehearse-restore` rehearsal and Enterprise FinOps attribution, Community boosts/VIP Connect/DAC7, ephemeral AI translation & consent-gated call captions, sovereign CalDAV smart calendar/zero-PII booking/Yjs whiteboard, cybersecurity posture advisor, sandboxed extension widgets/scaffolder CLI/web marketplace, sanitized WebP custom emojis, *Send Later*, personal reminders, waiting-room ambience & *Kodera Labs*, server opaque `KVKB1` key-backup routes, `KDE1` encrypted Yjs collaboration server relay admission, client-local encrypted full-text search & 3-tier encryption boundaries, and cardless SMB self-serve (`<= 5` seats, `5 GiB`, `< 5 s`) + right-sized `PRO2-S`/`M`/`L` Sovereign WarmPool settlement & operator SRE summary (`OpenAPI 0.61.0`) are implemented. End-to-end confidential client UX, native MLS group/key integration and universal homeserver encryption remain Planned.

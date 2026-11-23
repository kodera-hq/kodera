# Kodera Product & Engineering Roadmap

Status: Active (Status-driven — see [AGENTS.md](./AGENTS.md), Rule 7)

**The authoritative roadmap is the backlog of `kodera-hq/kodera`: its issues and its GitHub Project.** This page is a summary of it, grouped by track and carrying a status, never a date. Where this page and the Project disagree, the Project is right and this page is to be corrected. What already ships is described in [`README.md`](./README.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Kodera is a public open-core monorepo: nothing listed here is held back from the open-source tree unless it is named under Track 6.

## Track 1 — Foundation & Open-Core Monorepo (`Status: Implemented`)

- [x] Unified `@kodera/*` monorepo (`apps/`, `packages/`, `extensions/`, `deploy/community/`, `ee/`)
- [x] `@kodera/design-tokens` ("Cobalt × Kodera — givre") with automated contrast & grammar CI gates
- [x] `kodera-server` OpenAPI 3.1 contract-first control plane (`0.53.0`), ADR-0003 secret isolation & `room_access` sidecar
- [x] Matrix-backed channels and LiveKit audio rooms in the web client, governed by `kodera-synapse-policy`
- [x] `kodera-rs` zero-unsafe Rust core (`UuidV7`, `Ed25519` traits, OpenMLS/Megolm primitives, durable device/session state, universal ES256 passkey binding, `#proximity` frame v1/v2 codecs)
- [x] `@kodera/extension-sdk` HMAC-signed webhooks and 23 reference implementations (the `/hello` starter plus 22 domain connectors) with a generated catalogue
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
- [x] Transactional workspace quotas, Factur-X `380`/`381` PDF/A-3 + XML deterministic invoice ledger, VIES VAT evidence, supervised dunning, Stripe billing webhook verification, and GDPR Art. 17/20 signed exports and erasure (`KODERA_BILLING_ENABLED=false` on self-hosted Community)
- [x] Extension runtime v2 in the control plane: scoped workspace installation, key rotation, reconciliation, dual-key HMAC signed webhook/slash-command delivery with pinned-IP SSRF guards, and bounded `Slack` / `Discord` / `Notion` importers
- [x] `Kodera Passport`: signed PKCE cross-workspace magic-link sign-in, multi-organisation workspace switcher and account-erasure integration alongside per-realm OIDC + WebAuthn passkeys
- [x] Hosted Community tenant promotion, identity-provider cutover to `auth.kodera.io` and release evidence
- [ ] Backup/restore rehearsal and subsequent exact-release deployment acceptance

## Track 3 — Native Clients (`Status: Foundations implemented; native transports and distribution in progress`)

- [x] Companion client foundations in `apps/ios` (SwiftUI) and `apps/android` (Jetpack Compose) with *Dark Precision* / *Light Givre* design parity, native Matrix room messaging (`m.login.token` SSO, bounded `/sync`, replies, edits, redactions, single-grapheme reactions, Core-scoped attachments), golden-vector-verified `PacketDispatcher` and `KDV1` session vault parity across `kodera-rs`, Swift (`CryptoKit`) and Kotlin (`javax.crypto`) (`vectors/mobile-ffi-v1.txt`), CallKit / `ConnectionService` call seams, payload-free push wakeup integration and universal WebAuthn passkeys (no in-app purchase and no pricing screen)
- [ ] Remote Matrix room-invitation delivery, real audio/video/call media adapters and linked native Rust client binaries (unmangled C-ABI exports remain gated while `#![forbid(unsafe_code)]` is in force)
- [ ] End-to-end native push delivery and device/provider qualification
- [x] Reproducible native candidate verification and reviewed SPDX SBOM provenance gates across desktop and mobile targets
- [x] Web Push notifications that wake the web client without carrying message text
- [x] Origin-fenced Tauri v2 desktop shell and bridge (`@kodera/desktop`) with `kodera://` / `matrix:` deep-links, tray/mute and media-capture controls, opt-in Push-to-Talk with focus-loss release safety, persistent OS keychain backend (`security` / `secret-tool` / `PasswordVault`) with atomic `0600` metadata index and zeroized RAM cache, macOS Hardened Runtime entitlements/`notarytool` and Windows `signtool.exe` release-signing hooks, and direct GitHub Releases multi-OS desktop (`.dmg`, `.AppImage`, `.deb`, `.msi`, `-setup.exe`) and Android (`.apk`) distribution workflow with `SHA256SUMS.txt`
- [x] Automated self-host stack deployment and preflight orchestration inside the Kodera Desktop self-host wizard
- [ ] Operator certificate provisioning for OS-notarised macOS and Authenticode-signed Windows public installers, background iOS PushKit provisioning, and published Apple App Store / Google Play companion listings

## Track 4 — Confidential Rooms & Federation (`Status: Transport & device primitives shipped; group coordinators in progress`)

- [x] Cryptographic primitives, device lifecycle, durable session state, modern `openmls_*` crypto-provider generation, `wasm32` browser device-proof bindings and LiveKit media-frame encryption seams in `packages/kodera-rs` (scoped OpenMLS RFC 9420 and Vodozemac Megolm), paired with atomic browser IndexedDB confidential vault storage (`apps/web/src/features/confidential/`), and default-off `/api/v1/organisations/{organisation_id}/confidential/*` opaque envelope and HPKE KeyPackage relay (`0.51.0`)
- [x] Opt-in open Matrix federation (`KODERA_FEDERATION_MODE=open`, closed by default on `deploy/community`) alongside explicit partner-room federation governance in `packages/synapse-policy` (`0.1.6`)
- [x] Refusal of plaintext fallback and room-store quarantine for unavailable confidential or unclassified sessions (#180)
- [x] Worker-isolated attachment/Pages/LiveKit media cryptographic capabilities (#169, #177, #182), local SAS device comparison and `KVKB1` encrypted local key archives (#183)
- [ ] Server-side confidential room/session discovery and trusted epoch provisioning; server cross-signing and backup publication
- [ ] Durable browser/native group integration, native key management and interoperable LiveKit media qualification

## Track 5 — `#proximity` (`Status: Broker & foreground radio layers shipped; physical two-device qualification open`)

- [x] `#proximity` signed frame v1 frozen wire format and v2 rotating frame codec in `packages/kodera-rs`, with replay guards and mobile async duty-cycle fences
- [x] Voluntary `#proximity` check-in over RAM-only Unix socket `/run/proximity/broker.sock` (`python -m apps.proximity.broker_rpc`), 15-minute rotating HKDF-SHA256 epoch leases, and foreground iOS (`CoreBluetooth` / `Network.framework`) and Android (`BLE GATT` / `NSD`) radio adapter layers ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)). It is not an emergency service.
- [ ] Physical two-device `mDNS + QUIC` and `BLE GATT` radio interoperability qualification

## Track 6 — Managed Hosting & Enterprise (`Status: Implemented in tree; live operator activation gated`)

- [x] Enterprise Edition (`ee/`): SAML 2.0 corporate federation, SCIM 2.0 provisioning, and `Ed25519`-signed compliance audit exports ([`ee/README.md`](./ee/README.md))
- [x] Commercial price schedules, Autopilot warm-pool governance and enterprise purchase-order settlement ([`ee/billing`](./ee/billing/README.md))
- [ ] Live payment-provider endpoint activation and external managed-fleet tenant provisioning

The generic invoice ledger and the payment engine already in `apps/server` stay open source; see [`GOVERNANCE.md`](./GOVERNANCE.md).

## Track 7 — Universal Zero-Knowledge & End-to-End Encryption by Default (`Status: In progress`)

- [ ] Universal client-side end-to-end encryption (MLS / Megolm) across **all** channels, direct messages and threads by default, retiring clear-text homeserver room storage so the operator holds zero readable message content
- [x] Worker-isolated client AEAD capabilities for confidential Yjs document updates/snapshots and attachments; protected sessions refuse plaintext fallback
- [x] Worker-isolated LiveKit media transforms, SAS device comparison and user-held encrypted `KVKB1` local key archives
- [ ] Server confidential room/session discovery, encrypted collaboration relay admission and trusted epoch provisioning
- [ ] Server cross-signing/backup publication and key management/rotation across browser and native clients
- [ ] Mandatory `kodera-rs` cryptographic store binding across `apps/ios` and `apps/android`, and end-to-end media encryption (`SFrame` / MLS epoch keys) on all LiveKit voice, video and screen-sharing sessions
- [ ] Metadata minimisation and client-local encrypted full-text search so search indexes never exist in plaintext on the server

## Wave Summary (`Status: Waves 4–9 implemented or finishing; Wave 10 in progress`)

The [collaboration status](./docs/specs/collaboration-status.md) records the Wave 2B through Wave 10 repository boundaries and separates merged source code from operator-run cutover and distribution gates:

- **Wave 4 (`Implemented`):** typed Collections, transactional quotas, Factur-X `380`/`381` ledger, VIES validation and GDPR Art. 17/20 export and erasure. Community self-hosting remains independent of billing.
- **Wave 5 (`Foundations implemented; mobile transports and distribution open`):** `kodera-rs` OpenMLS/Megolm/Passkey/proximity codecs, reproducible native SBOM gates, Tauri v2 desktop shell/bridge and iOS/Android companion implementations.
- **Wave 6 & 7 (`Implemented`):** extension runtime v2, 23 reference implementations, `Slack`/`Discord`/`Notion` importers, bounded partner-room and opt-in open federation controls, developer docs + `llms.txt`, and multi-surface security hardening.
- **Wave 8 & 9 (`Implemented in tree; hosted Community promoted; signing & group-integration gates open`):** `deploy/community` fresh-volume cold-start footprint gate, Zero-Trust `/staff/v1/*` surface and `.well-known` discovery, Desktop self-host stack deployment, `Kodera Passport` cross-workspace magic-link PKCE sign-in, Enterprise `ee/` (`SAML 2.0`, `SCIM 2.0`, `Ed25519` audit exports, `ee/billing/`), `kodera-rs` `wasm32` browser device-proof bindings, modern `openmls_*` crypto-provider generation, default-off `0.47.0` confidential envelope relay, atomic browser confidential local-state vault, RAM-only `#proximity` check-in broker + 15-minute HKDF epoch leases + foreground native BLE/mDNS layers, and multi-OS release workflow; durable group integration, physical two-device radio qualification, backup rehearsal and signing gates remain open.
- **Wave 10 (`In progress`):** refusal of plaintext fallback and room quarantine, worker-isolated attachment/Pages/LiveKit media cryptographic capabilities, worker SAS device comparison and `KVKB1` encrypted local key archives are implemented. Server confidential room/session discovery, trusted epoch provisioning, cross-signing/backup publication, native integration and browser/codec qualification remain open. Universal encryption by default is still Planned.

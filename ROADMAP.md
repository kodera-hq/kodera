# Kodera Product & Engineering Roadmap

Status: Active (Status-driven — see [AGENTS.md](./AGENTS.md), Rule 7)

**The authoritative roadmap is the backlog of `kodera-hq/kodera`: its issues and its GitHub Project.** This page is a summary of it, grouped by track and carrying a status, never a date. Where this page and the Project disagree, the Project is right and this page is to be corrected. What already ships is described in [`README.md`](./README.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Kodera is a public open-core monorepo: nothing listed here is held back from the open-source tree unless it is named under Track 6.

## Track 1 — Foundation & Open-Core Monorepo (`Status: In Progress`)

- [x] Unified `@kodera/*` monorepo (`apps/`, `packages/`, `extensions/`, `deploy/community/`, `ee/`)
- [x] `@kodera/design-tokens` ("Cobalt × Kodera — givre") with automated contrast & grammar CI gates
- [x] `kodera-server` OpenAPI 3.1 contract-first control plane, ADR-0003 secret isolation & `room_access` sidecar
- [x] Matrix-backed channels and LiveKit audio rooms in the web client, governed by `kodera-synapse-policy`
- [x] `kodera-rs` zero-unsafe Rust core (`UuidV7`, `Ed25519` traits, OpenMLS/Megolm primitives, universal ES256 passkey binding, `#proximity` frame v1/v2 codecs)
- [x] `@kodera/extension-sdk` HMAC-signed webhooks, the `/hello` starter and 22 reference implementations with a generated catalogue
- [x] Hardened `deploy/community` profile (Synapse on PostgreSQL, federation closed by default, rate limits, no public agent API), checked on every change
- [ ] End-to-end cold-start verification of `deploy/community` on a clean host, with a measured footprint

## Track 2 — Collaboration, Governance & Workspace Lifecycle (`Status: Implemented through Wave 8; cutover in progress`)

- [x] Direct messages and bounded group conversations, file and image upload, and message search in the web client
- [x] Camera video and screen sharing in rooms. LiveKit alone carries voice and video.
- [x] Public local Community rooms using Matrix's native join rules and control-plane moderation
- [x] Canonical-realm Community self-signup and default membership; optional TOTP is configured in the operator's identity provider
- [x] Native Docs & Collections: a block editor inside `apps/web` (ProseMirror/Tiptap and Yjs, MIT-licensed, no GPL add-on), PostgreSQL document permissions and a Yjs sync service, page trees, wikilinks, backlinks, search, and typed Collections (`Table`, `Kanban` and `List` views)
- [x] Workspace moderation, reusable invite links, scoped attachments, text-only unfurling, notification history and payload-free Web Push
- [x] Transactional workspace quotas, Factur-X `380`/`381` PDF/A-3 + XML deterministic invoice ledger, VIES VAT evidence, supervised dunning, and GDPR Art. 17/20 signed exports and erasure (`KODERA_BILLING_ENABLED=false` on self-hosted Community)
- [x] Extension runtime v2 in the control plane: manifest registration, workspace installation, dual-key HMAC signed webhook/slash-command delivery with pinned-IP SSRF guards, and bounded `Slack` / `Discord` / `Notion` importers
- [ ] Human Community production cutover, backup/restore rehearsal and exact-release acceptance
- [ ] `Kodera Passport`: cross-workspace magic-link sign-in beyond per-realm OIDC + WebAuthn passkeys

## Track 3 — Native Clients (`Status: In Progress`)

- [x] Companion client foundations in `apps/ios` (SwiftUI) and `apps/android` (Jetpack Compose) with `ciel` design parity, Matrix room/invitation models, CallKit / `ConnectionService` call seams, payload-free push integration and universal WebAuthn passkeys (no in-app purchase and no pricing screen)
- [x] Reproducible native candidate verification and SPDX SBOM provenance gates across desktop and mobile targets
- [x] Web Push notifications that wake the web client without carrying message text
- [x] Origin-fenced Tauri v2 desktop bridge (`@kodera/desktop`) with `kodera://` / `matrix:` deep-links, tray controls, opt-in Push-to-Talk, OS keychain integration, local self-host preflight, and direct GitHub Releases multi-OS desktop (`.dmg`, `.AppImage`, `.deb`, `.msi`, `-setup.exe`) and Android (`.apk`) distribution with `SHA256SUMS.txt`
- [ ] OS-notarised desktop installers for macOS and Windows, and published Apple App Store / Google Play companion listings
- [ ] Automated provider deployment inside the Kodera Desktop self-host wizard

## Track 4 — Encryption & Federation (`Status: Partially Implemented / Deferred`)

- [x] Cryptographic primitives in `packages/kodera-rs` (scoped OpenMLS RFC 9420 and Vodozemac Megolm) and explicit partner-room federation governance in `packages/synapse-policy` (`v0.1.5`)
- [ ] End-to-end encrypted confidential rooms across web and native clients, and encrypted LiveKit media frames
- [ ] Open Matrix federation across arbitrary homeservers (the Community homeserver remains closed by default)

## Track 5 — `#proximity` (`Status: Codec Shipped / Radio Planned`)

- [x] `#proximity` signed frame v1 frozen wire format and v2 rotating frame codec in `packages/kodera-rs`, with replay guards and mobile async duty-cycle fences
- [ ] Physical local Wi-Fi (`mDNS + QUIC`) and `BLE GATT` radio adapters and check-in UI ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)). It is not an emergency service.

## Track 6 — Managed Hosting & Enterprise (`Status: Planned`)

- [ ] Enterprise Edition (`ee/`): SAML 2.0 / OIDC corporate federation, SCIM 2.0 sync, audit exports
- [ ] Managed-hosting automation for the shared cloud and dedicated tenants, and commercial price schedules ([`ee/billing`](./ee/billing/README.md))

The generic invoice ledger and the payment engine already in `apps/server` stay open source; see [`GOVERNANCE.md`](./GOVERNANCE.md).

## Waves 4–8 (`Status: Implemented on main / Wave 8; operator gates in progress`)

The [collaboration status](./docs/specs/collaboration-status.md) records the completed Wave 2B through Wave 7 repository boundaries and separates merged source code from operator-run cutover and distribution gates:

- **Wave 4 (`Implemented`):** typed Collections, transactional quotas, Factur-X `380`/`381` ledger, VIES validation and GDPR Art. 17/20 export and erasure. Community self-hosting remains independent of billing.
- **Wave 5 (`Implemented in tree; store/installer signing pending`):** `kodera-rs` OpenMLS/Megolm/Passkey/proximity codecs, reproducible native SBOM gates, Tauri v2 desktop shell/bridge and iOS/Android companion implementations.
- **Wave 6 & 7 (`Implemented`):** extension runtime v2, 22 reference implementations, `Slack`/`Discord`/`Notion` importers, bounded partner-room federation policy, developer docs + `llms.txt`, and multi-surface security hardening.
- **Wave 8 (`In Progress — Direct Releases & Surface Polish`):** direct GitHub Releases desktop & mobile asset links (`kodera-desktop-macos-universal.dmg`, `kodera-desktop-linux-x86_64.AppImage`, `kodera-desktop-linux-amd64.deb`, `kodera-desktop-windows-x64.msi`, `kodera-desktop-windows-x64-setup.exe`, `kodera-android.apk`, `SHA256SUMS.txt`), runnable desktop packaging, `.well-known` discovery, and landing/identity polish; OS notarisation and store publication remain operator-gated.

# Kodera Product & Engineering Roadmap

Status: Active (Status-driven — see [AGENTS.md](./AGENTS.md), Rule 7)

**The authoritative roadmap is the backlog of `kodera-hq/kodera`: its issues and its GitHub Project.** This page is a summary of it, grouped by track and carrying a status, never a date. Where this page and the Project disagree, the Project is right and this page is to be corrected. What already ships is described in [`README.md`](./README.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Kodera is a public open-core monorepo: nothing listed here is held back from the open-source tree unless it is named under Track 6.

## Track 1 — Foundation & Open-Core Monorepo (`Status: In Progress`)

- [x] Unified `@kodera/*` monorepo (`apps/`, `packages/`, `extensions/`, `deploy/community/`, `ee/`)
- [x] `@kodera/design-tokens` ("Cobalt × Kodera — givre") with automated contrast & grammar CI gates
- [x] `kodera-server` OpenAPI 3.1 contract-first control plane, ADR-0003 secret isolation & `room_access` sidecar
- [x] Matrix-backed channels and LiveKit audio rooms in the web client, governed by `kodera-synapse-policy`
- [x] `kodera-rs` zero-unsafe Rust core (`UuidV7`, `Ed25519` traits, crypto provider seam, `#proximity` frame v1 codec)
- [x] `@kodera/extension-sdk` HMAC-signed webhooks, the `/hello` starter and reference implementations with a generated catalogue
- [x] Hardened `deploy/community` profile (Synapse on PostgreSQL, federation closed, rate limits, no public agent API), checked on every change
- [ ] End-to-end cold-start verification of `deploy/community` on a clean host, with a measured footprint

## Track 2 — Collaboration (`Status: Planned`)

- [ ] Direct messages, file and image upload, and message search in the web client
- [ ] Camera video and screen sharing in rooms. LiveKit alone carries voice and video.
- [ ] Public community rooms, using Matrix's native join rules
- [ ] Community self-signup with an optional TOTP second factor
- [ ] Native Docs: a block editor inside `apps/web` (ProseMirror/Tiptap and Yjs, MIT-licensed, no GPL add-on) with a small Yjs sync service. No third-party office suite, and no server-coupled bridge from a chat thread to a document.
- [ ] An extension runtime in the control plane: registering a manifest, installing an extension for a workspace, delivering signed webhooks
- [ ] `Kodera Passport`: optional Passkey / Magic-Link sign-in across workspaces
- [ ] Slack / Discord channel & history importer for workspace migrations

## Track 3 — Native Clients (`Status: Planned`)

- [ ] Mobile v1.0 for iOS and Android: a companion app, with no in-app purchase and no pricing screen
- [ ] Bindings connecting `packages/kodera-rs` to `apps/ios` (SwiftUI) and `apps/android` (Jetpack Compose)
- [ ] Push notifications that wake the app without carrying message text
- [ ] Tauri v2 Desktop (`@kodera/desktop`) with a running shell and installers for macOS, Windows and Linux
- [ ] A local self-host wizard inside Kodera Desktop

## Track 4 — Encryption & Federation (`Status: Deferred`)

- [ ] End-to-end encrypted confidential rooms (OpenMLS, RFC 9420) and encrypted LiveKit media frames
- [ ] Matrix federation between workspaces and with other homeservers

Both are planned and not shipped. Until then channels are not end-to-end encrypted and the homeserver is closed.

## Track 5 — `#proximity` (`Status: RFC / Planned`)

- [ ] `#proximity`: an everyday proximity channel with a voluntary, pseudonymous check-in (named zones first, optional short-lived coordinates), over local Wi-Fi (`mDNS + QUIC`) and `BLE GATT` ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)). It is not an emergency service. Its frame v1 wire format is frozen.

## Track 6 — Managed Hosting & Enterprise (`Status: Planned`)

- [ ] Enterprise Edition (`ee/`): SAML 2.0 / OIDC corporate federation, SCIM 2.0 sync, audit exports
- [ ] Managed-hosting automation for the shared cloud and dedicated tenants, and commercial price schedules ([`ee/billing`](./ee/billing/README.md))

The generic invoice ledger and the payment engine already in `apps/server` stay open source; see [`GOVERNANCE.md`](./GOVERNANCE.md).

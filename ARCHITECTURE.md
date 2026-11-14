# Kodera Architecture

Status: Active

Kodera is a **multi-workspace, open-core collaboration platform**: a control plane that owns who may be where, a Matrix homeserver and a LiveKit SFU that carry the conversations, and clients that talk to all three. This document describes what the repository contains today and says so where a part is only planned. Decisions are recorded as ADRs, indexed in [`docs/adr/`](./docs/adr/README.md); a bare `ADR-NNNN` below is the server's (`SRV-ADR-NNNN`).

## 1. Core Architectural Invariants

1. **One chain of authority: control plane, then Matrix room, then media (`ADR-0018`).**
   `apps/server` owns the tree of workspaces, categories and channels, typed document Collections, quotas, Factur-X billing ledger, GDPR export/erasure lifecycles, and the rules of who may read or post. Every channel, text or audio, is one Matrix room on the workspace's Synapse; the tenant agent creates the rooms and converges their membership to what the control plane decided. An audio room's media access derives from membership of its Matrix room: the `room_access` service checks it and mints a short-lived LiveKit token for that room only. [`packages/synapse-policy`](./packages/synapse-policy/README.md) runs inside Synapse and refuses whatever would route around this from another Matrix client.

2. **Identifiers that do not leak the transport (`ADR-0009`, `packages/kodera-rs`).**
   The control plane, the web client's URLs and the clients' models address workspaces and channels by **RFC 9562 `UuidV7`** identifiers, not by raw Matrix room IDs (`!opaque:domain`). Channels are backed by Synapse today. The same identifiers address `#proximity` frames and cryptographic room scopes in `packages/kodera-rs`.

3. **Channels are readable by the homeserver today; cryptographic room primitives are staged in `kodera-rs`.**
   - **Today:** channels are encrypted in transit (TLS at the edge) and stored by the homeserver in clear, which is what lets a new member read history and an extension post, and what Matrix message search relies on. The policy module refuses `m.room.encryption` in standard rooms, keeps open homeserver federation closed by default, and bounds explicit partner-room federation (`packages/synapse-policy` `v0.1.5`) behind atomic ACL and governor locks.
   - **Status: Deferred across clients.** `packages/kodera-rs` implements scoped OpenMLS (RFC 9420) and Vodozemac Megolm primitives alongside ES256 universal passkey binding, while end-to-end encrypted confidential rooms across clients and encrypted LiveKit media frames remain deferred until cross-client acceptance ships.

4. **One codebase, a self-host profile first.**
   - **Community profile (`deploy/community/`):** a single-node Docker Compose stack (`Caddy + Kodera Server + PostgreSQL 17 + Valkey 8 + Synapse on its own PostgreSQL + LiveKit`, `KODERA_EDITION=community`, `KODERA_BILLING_ENABLED=false`). It runs no identity provider: the server trusts the OIDC issuers listed in `KODERA_AUTH_TRUST`, the web client signs in at `KODERA_OIDC_PROVIDER_ORIGIN`, and Synapse signs members in through the same realm. Caddy routes the API, the Matrix client API, the room-access token endpoint, Yjs collaboration and LiveKit signalling; the agent API and open Matrix federation are not reachable from the internet. [`packages/create-kodera`](./packages/create-kodera/README.md) ships a checked copy of the same stack. Clean-host install time and footprint remain to be measured.
   - **Managed topology. Status: External to this repository.** The control plane models organisations, tenants and an identity realm per organisation (`ADR-0006`), while infrastructure orchestration lives outside the public monorepo. Enterprise modules (`ee/`) are reserved and hold no code yet.

5. **Defense-in-Depth Secret Isolation (`ADR-0003` & `ADR-0018`):**
   - `apps/server/config/environment.py` inspects `os.environ` before Django settings load and **refuses to start** if infrastructure credentials (`SCW_*`, `AWS_*`, `TF_*`, `SSH_*`, `KUBECONFIG`) or unadmitted secret-shaped variables are present.
   - LiveKit SFU signing credentials are isolated inside the dedicated `room_access` process (`python -m room_access`) and never enter the main WSGI API worker environment. In the Community profile, Synapse's database credential and the tenant agent's tokens are isolated the same way; GDPR exports use `O_NOFOLLOW` descriptor checks inside `PrivateVolume`.
   - In `apps/desktop`, the origin-fenced Tauri v2 bridge and self-host preflight wrap provider tokens in `RedactedApiToken` (redacted `Debug` and `Display`), store credentials in the OS keychain and perform local validation without automated cloud provisioning.

6. **`#proximity` (`RFC-0001`). Status: v1/v2 codecs shipped; physical radio adapters planned.**
   `#proximity` is an everyday proximity channel with a voluntary, pseudonymous check-in; it is not an emergency service. `packages/kodera-rs` implements the frozen signed frame v1 wire format (`118 B` of fixed header and `Ed25519` signature, `<= 256 B` per frame) and the v2 rotating frame codec, signature verification, bounded replay guards, priority relay queue and transport seam. Physical `mDNS + QUIC` and `BLE GATT` hardware radio adapters remain planned ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)).

## 2. Clients

- **`apps/web`** is the full production web client and customer console: Matrix-backed channels (threads, reactions, typing, presence), LiveKit audio, camera video and screen sharing, private direct conversations, checked attachments, text-only link previews, payload-free Web Push, native collaborative Pages, typed Collections (`Table`, `Kanban`, `List`), extension catalogue, Factur-X billing console, quota gauges and GDPR Art. 17/20 workflows. It talks to the control plane through the OpenAPI contract in [`packages/api-contract`](./packages/api-contract), to Synapse with the member's own Matrix session, and to LiveKit with the token `room_access` minted.
- **`apps/ios` and `apps/android`** are native SwiftUI and Jetpack Compose companion clients (no in-app purchase and no pricing screen). They consume `@kodera/design-tokens` (`ciel` parity), implement Matrix room and invitation flows, CallKit and Android `ConnectionService` call integration, payload-free push handling, universal WebAuthn passkey policies and async radio/call lifecycle fences; App Store and Google Play distribution awaits operator signing.
- **`apps/desktop`** links `kodera-rs` and implements the origin-fenced Tauri v2 desktop bridge (`kodera://` and `matrix:` deep-links, system tray, opt-in Push-to-Talk, OS keychain integration and local self-host preflight); signed macOS/Windows/Linux installers await release notarisation.

## 3. Extensions & Importers

[`packages/extension-sdk`](./packages/extension-sdk/README.md) defines the manifest, the signed-webhook envelope and the slash-command helpers, [`extensions/`](./extensions/README.md) holds 22 reference implementations tested against its harness, and `apps/server` implements the outbound extension runtime v2 (manifest registration, workspace installation, dual-key HMAC delivery and pinned-IP SSRF protection) alongside bounded `Slack`, `Discord` and `Notion` workspace importers.

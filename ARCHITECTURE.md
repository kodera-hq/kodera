# Kodera Architecture

Status: Active

Kodera is a **multi-workspace, open-core collaboration platform**: a control plane that owns who may be where, a Matrix homeserver and a LiveKit SFU that carry the conversations, and clients that talk to all three. This document describes what the repository contains today and says so where a part is only planned. Decisions are recorded as ADRs, indexed in [`docs/adr/`](./docs/adr/README.md); a bare `ADR-NNNN` below is the server's (`SRV-ADR-NNNN`).

## 1. Core Architectural Invariants

1. **One chain of authority: control plane, then Matrix room, then media (`ADR-0018`).**
   `apps/server` owns the tree of workspaces, categories and channels and the rules of who may read or post. Every channel, text or audio, is one Matrix room on the workspace's Synapse; the tenant agent creates the rooms and converges their membership to what the control plane decided. An audio room's media access derives from membership of its Matrix room: the `room_access` service checks it and mints a short-lived LiveKit token for that room only. [`packages/synapse-policy`](./packages/synapse-policy/README.md) runs inside Synapse and refuses whatever would route around this from another Matrix client.

2. **Identifiers that do not leak the transport (`ADR-0009`, `packages/kodera-rs`).**
   The control plane, the web client's URLs and the clients' models address workspaces and channels by **RFC 9562 `UuidV7`** identifiers, not by raw Matrix room IDs (`!opaque:domain`). Channels are backed by Synapse today. The same identifiers are meant to address confidential rooms and `#proximity` frames once those exist.

3. **Channels are readable by the homeserver, not end-to-end encrypted.**
   - **Today:** channels are encrypted in transit (TLS at the edge) and stored by the homeserver in clear, which is what lets a new member read history and an extension post, and what server-side search (Status: Planned) will rely on. The policy module refuses `m.room.encryption` in every room.
   - **Status: Deferred.** End-to-end encryption and Matrix federation are not shipped. `kodera-rs` carries only the provider seam and envelope metadata (`MlsCiphertextEnvelope`, `OpenMlsDraft`) for a future OpenMLS (RFC 9420) provider; no MLS provider and no media-frame keys for LiveKit exist. The homeserver is closed: no federation listener, an empty federation whitelist.

4. **One codebase, a self-host profile first.**
   - **Community profile (`deploy/community/`):** a single-node Docker Compose stack (`Caddy + Kodera Server + PostgreSQL 17 + Valkey 8 + Synapse on its own PostgreSQL + LiveKit`, `KODERA_EDITION=community`, `KODERA_BILLING_ENABLED=false`). It runs no identity provider: the server trusts the OIDC issuers listed in `KODERA_AUTH_TRUST`, the web client signs in at `KODERA_OIDC_PROVIDER_ORIGIN`, and Synapse signs members in through the same realm. Caddy routes the API, the Matrix client API, the room-access token endpoint and LiveKit signalling; the agent API and Matrix federation are not reachable from the internet. [`packages/create-kodera`](./packages/create-kodera/README.md) ships a checked copy of the same stack. No footprint or install time is measured yet.
   - **Managed topology. Status: Planned.** The control plane models organisations, tenants and an identity realm per organisation (`ADR-0006`), but its provisioning worker registers no job kind, so nothing in this repository provisions a managed tenant. Enterprise modules (`ee/`) are reserved and hold no code.

5. **Defense-in-Depth Secret Isolation (`ADR-0003` & `ADR-0018`):**
   - `apps/server/config/environment.py` inspects `os.environ` before Django settings load and **refuses to start** if infrastructure credentials (`SCW_*`, `AWS_*`, `TF_*`, `SSH_*`, `KUBECONFIG`) or unadmitted secret-shaped variables are present.
   - LiveKit SFU signing credentials are isolated inside the dedicated `room_access` process (`python -m room_access`) and never enter the main WSGI API worker environment. In the Community profile, Synapse's database credential and the tenant agent's tokens are isolated the same way.
   - In `apps/desktop`, the self-host preflight wraps a provider token in `RedactedApiToken` (redacted `Debug` and `Display`) and validates it locally. It performs no provider request and no deployment today; a future provider adapter is not built.

6. **`#proximity` (`RFC-0001`). Status: Planned beyond its codec.**
   `#proximity` is an everyday proximity channel with a voluntary, pseudonymous check-in; it is not an emergency service. `packages/kodera-rs` implements the signed frame v1 wire format (`118 B` of fixed header and `Ed25519` signature, `<= 256 B` per frame), signature verification, a bounded replay guard, a priority relay queue and the transport seam. That wire format is frozen. No `mDNS + QUIC` or `BLE GATT` radio adapter exists in any client, and no check-in API or screen ships ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)).

## 2. Clients

- **`apps/web`** is the only client that carries conversations today: the customer console, Matrix-backed channels (threads, reactions, typing, presence) and audio rooms over LiveKit (microphone audio). It talks to the control plane through the OpenAPI contract in [`packages/api-contract`](./packages/api-contract), to Synapse with the member's own Matrix session, and to LiveKit with the token `room_access` minted.
- **`apps/ios` and `apps/android`** are native clients in development. They consume the design tokens and hold native models and protocol code; they have no Matrix or LiveKit transport yet and do not link `kodera-rs`. Version 1.0 is a companion app with no in-app purchase and no pricing screen.
- **`apps/desktop`** links `kodera-rs` and exposes Rust seams; it has no running window.

## 3. Extensions

[`packages/extension-sdk`](./packages/extension-sdk/README.md) defines the manifest, the signed-webhook envelope and the slash-command helpers, and [`extensions/`](./extensions/README.md) holds reference implementations tested against its harness. Status: Planned for the runtime. The control plane has no extension registry, installer or webhook delivery yet.

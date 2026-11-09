# Kodera Architecture

Status: Active

Kodera is engineered as a **multi-workspace, sovereign, open-core collaboration platform** combining consumer-grade responsiveness with defense-in-depth operational security.

## 1. Core Architectural Invariants

1. **Canonical `UuidV7` Transport Seam (`packages/kodera-rs`):**
   Client state, URLs, and domain models address workspaces, channels, and messages via **RFC 9562 `UuidV7`** identifiers rather than leaking raw Matrix room IDs (`!opaque:domain`) into UI components. This allows standard searchable channels (backed by Synapse + `kodera-synapse-policy` today), end-to-end encrypted confidential rooms (**OpenMLS RFC 9420**), and offline emergency broadcasts (`#urgence`) to coexist cleanly behind one client interface.

2. **Hybrid E2EE & Searchability Pragmatism:**
   - **Standard Team Channels:** Encrypted in transit (TLS 1.3) and at rest, enabling instant server-side full-text search, webhook/bot integrations (`@kodera/extension-sdk`), and instant history onboarding for new teammates.
   - **Confidential Rooms, DMs & Voice/Video Media:** **OpenMLS (RFC 9420)** group key agreement is the design target. Today `kodera-rs` carries only the provider seam and envelope metadata (`MlsCiphertextEnvelope`, `OpenMlsDraft`); no MLS provider and no media-frame keys for LiveKit ship yet.

3. **Two Deployment Topologies, One Codebase:**
   - **Community Profile (`deploy/community/`):** Single-node Docker Compose stack (`Caddy + Kodera Server + PostgreSQL 17 + Valkey 8 + Synapse + LiveKit`, `KODERA_EDITION=community`). It runs no identity provider: the server trusts the OIDC issuers listed in `KODERA_AUTH_TRUST`, and the web client signs in at `KODERA_OIDC_PROVIDER_ORIGIN`, an issuer the operator runs. No footprint or install time is measured yet.
   - **Managed Cloud & Enterprise Topology (`kodera.io` & `ee/`):** Multi-tenant control plane with dedicated per-organisation identity realms, SAML/OIDC federation, SCIM provisioning, and isolated media/messaging nodes.

4. **Defense-in-Depth Secret Isolation (`ADR-0003` & `ADR-0018`):**
   - `apps/server/config/environment.py` inspects `os.environ` before Django settings load and **refuses to start** if infrastructure credentials (`SCW_*`, `AWS_*`, `TF_*`, `SSH_*`, `KUBECONFIG`) or unadmitted secret-shaped variables are present.
   - LiveKit SFU signing credentials are isolated inside the dedicated `room_access` process (`python -m room_access`) and never enter the main WSGI API worker environment.
   - In `apps/desktop`, the self-host preflight wraps a provider token in `RedactedApiToken` (redacted `Debug` and `Display`) and validates it locally. It performs no provider request and no deployment today; a future provider adapter is not built.

5. **Physical Blackout Lifeline (`#urgence`, `RFC-0001`):**
   Organisations can pre-provision rotating `HMAC-SHA256` proximity beacons and `Ed25519` member device keys while online. Today `packages/kodera-rs` implements the signed `EmergencyFrame` wire format (`118 B` fixed header + `Ed25519` signature overhead, `<= 256 B` total frame), signature verification seam, bounded replay cache (`EmergencyReplayGuard`), priority relay queue (`EmergencyMeshQueue`), and `ProximityTransport` trait; the physical `mDNS + QUIC` / `BLE GATT` store-and-forward radio adapter (`TTL <= 6`) is a Phase D target architecture under active build-out (matching `README.md`).

# Kodera Product & Engineering Roadmap

Status: Active (Status-driven — see [AGENTS.md](./AGENTS.md), Rule 7)

Kodera ships iteratively across four tracks without artificial feature-crippling in the open-source core.

## Track 1 — Foundation & Open-Core Monorepo (`Status: In Progress`)

- [x] Unified `@kodera/*` monorepo (`apps/`, `packages/`, `extensions/`, `deploy/community/`, `ee/`)
- [x] `@kodera/design-tokens` ("Cobalt × Kodera — givre") with automated contrast & grammar CI gates
- [x] `kodera-server` OpenAPI 3.1 contract-first control plane, ADR-0003 secret isolation & `room_access` sidecar
- [x] `kodera-rs` zero-unsafe Rust core (`UuidV7`, `Ed25519` traits, `OpenMLS` envelope seam, `#urgence` wire codec)
- [x] `@kodera/extension-sdk` HMAC-signed webhooks & `/hello` starter extension
- [ ] End-to-end cold-start verification of `deploy/community` on clean Scaleway / Hetzner VPS targets

## Track 2 — Frictionless Multi-Workspace UX & Desktop (`Status: Planned`)

- [ ] `Kodera Passport` optional global Passkey / Magic-Link onboarding for 1-click multi-server switching
- [ ] Tauri v2 Desktop (`@kodera/desktop`) installers for macOS, Windows, and Linux (`~12 MB`)
- [ ] Interactive local 1-Click VPS Self-Host wizard inside Kodera Desktop (Scaleway, Hetzner, Hostinger, OVHcloud)
- [ ] Slack / Discord channel & history importer for workspace migrations

## Track 3 — Native Mobile & OpenMLS Confidential Rooms (`Status: Planned`)

- [ ] UniFFI bindings connecting `packages/kodera-rs` to `apps/ios` (SwiftUI) and `apps/android` (Jetpack Compose)
- [ ] OpenMLS (RFC 9420) confidential channels & LiveKit WebRTC E2EE voice/video frame encryption
- [ ] Push notification privacy relay (wake-only payloads without plaintext message exposure)

## Track 4 — Physical Resilience (`#urgence`) & Enterprise Governance (`Status: RFC / Planned`)

- [ ] `#urgence` offline building lifeline over local Wi-Fi (`mDNS + QUIC`) and `BLE GATT` ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md))
- [ ] Enterprise Edition (`ee/`): SAML 2.0 / OIDC corporate federation, SCIM 2.0 sync, SIEM audit exports, and `Kodera Autopilot` managed self-host agent

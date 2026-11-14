<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./apps/web/public/kodera-mark-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="./apps/web/public/kodera-mark-slate.svg">
    <img alt="Kodera" src="./apps/web/public/kodera-mark-slate.svg" width="64" height="64">
  </picture>
</p>

<h1 align="center">Kodera</h1>

<p align="center">
  <strong>An open-core workspace for teams and communities: channels, threads and always-open audio rooms.</strong><br>
  Built on Matrix and LiveKit, hosted in Europe or on your own infrastructure.
</p>

<p align="center">
  <a href="./deploy/community/README.md">Self-Host (Docker Compose)</a> ·
  <a href="./ARCHITECTURE.md">Architecture</a> ·
  <a href="./ROADMAP.md">Roadmap</a> ·
  <a href="./docs/adr/README.md">Decisions (ADR index)</a> ·
  <a href="./docs/rfcs/RFC-0001-emergency-ble-channel.md">RFC-0001 (<code>#proximity</code>)</a> ·
  <a href="./CONTRIBUTING.md">Contribute</a> ·
  <a href="https://kodera.io">kodera.io</a>
</p>

---

> **Status: Developer Preview (`v0.x`).** Pre-`v1.0`, under active development. This page says what the repository contains today and marks everything else **Planned**. The list of planned work, and its order, is the [roadmap](./ROADMAP.md); the authoritative backlog is this repository's issues and its GitHub Project.

## What works today

- **Channels in the web client.** Text channels with threads, replies, reactions, typing and presence, backed by a Matrix homeserver (Synapse) that a Kodera policy module keeps under the control plane's rules.
- **Always-open audio and video rooms.** Join over a LiveKit SFU, with camera video, screen sharing and who-is-in-the-room shown in the channel list. The web client publishes and plays microphone audio.
- **Direct conversations and media.** Private one-to-one and bounded group conversations, message search, checked file uploads and downloads, text-only link previews, notification history and payload-free Web Push are implemented in the web client and server.
- **Native collaborative Pages and typed Collections.** Workspace documents have a page tree, document roles, Markdown/Tiptap block editing, wikilinks, backlinks, search, a Yjs collaboration service with persisted updates and snapshots, and typed Collections (`Table`, `Kanban` and `List` views).
- **Community membership, moderation and lifecycle controls.** Canonical-realm self-signup, reusable invitation links, public local rooms, private staff/partner categories, reports, workspace moderation, transactional workspace quotas, Factur-X `380`/`381` PDF/A-3 + XML billing documents, VIES VAT evidence and GDPR Art. 17/20 signed exports and erasure are implemented. An operator still prepares and verifies the identity provider and promotes the real Community tenant.
- **A control plane with a contract.** `apps/server` (Django) owns organisations, members, roles, workspaces, channel access, quotas, billing ledger and GDPR workflows behind an OpenAPI 3.1 contract (`0.44.2`), from which the web client's API types are generated.
- **Sign-in through OpenID Connect and WebAuthn passkeys.** The server trusts the issuers you list; the web client signs in at your identity provider, Synapse signs members in through the same realm, and `kodera-rs` + native clients support universal ES256 passkey binding without authenticator lock-in. The web client's "Create an account" sends a new person to the identity provider's own registration page.
- **A self-host profile.** [`deploy/community`](./deploy/community/README.md): a single-node Docker Compose stack with Synapse on PostgreSQL, federation closed by default, rate limits set and the agent API off the internet. `scripts/ci/check-community-deploy.py` holds it to that on every change.
- **Extension SDK, outbound runtime v2 and workspace importers.** [`@kodera/extension-sdk`](./packages/extension-sdk/README.md) defines signed webhooks and slash commands; `apps/server` registers manifests, installs workspace extensions and dispatches dual-key HMAC webhooks with pinned-IP SSRF guards; [`extensions/`](./extensions/README.md) carries 22 reference implementations, alongside bounded `Slack`, `Discord` and `Notion` importers.
- **Native desktop, mobile and Rust foundations.** [`packages/kodera-rs`](./packages/kodera-rs) provides `UuidV7`, `Ed25519` identity, scoped OpenMLS/Megolm primitives, ES256 passkey binding and `#proximity` frame v1/v2 codecs; `apps/desktop` implements the origin-fenced Tauri v2 bridge (`kodera://` / `matrix:`, tray, PTT, OS keychain) and `apps/ios` + `apps/android` implement `ciel` companion workspace, invitation, call-kit and payload-free push layers.
- **One design system.** [`@kodera/design-tokens`](./packages/design-tokens) is the single source of colour, type and motion for the web and native clients, with contrast gates in CI.

## What is not there yet

Status: Planned. The [roadmap](./ROADMAP.md) orders the remaining work. The [collaboration status](./docs/specs/collaboration-status.md) distinguishes shipped code from operator-run cutover and distribution gates.

- **Cross-client end-to-end encrypted rooms and open Matrix federation.** Channels are encrypted in transit and stored by the homeserver in clear today; while `kodera-rs` implements OpenMLS/Megolm primitives and `packages/synapse-policy` supports explicit partner-room federation rules, end-to-end encrypted confidential rooms across clients, encrypted LiveKit media frames and open homeserver federation remain deferred.
- **Cross-workspace magic-link sign-in** ("Kodera Passport"). Accounts and second factors (optional TOTP on Community, WebAuthn passkeys) live in the identity provider realm you operate.
- **Signed desktop installers and mobile store releases.** Notarised macOS/Windows/Linux desktop installers and published Apple App Store / Google Play companion builds (v1.0 has no in-app purchase and no pricing screen) await operator signing and store submission.
- **Physical `#proximity` radio adapters.** `#proximity` is an everyday proximity channel with a voluntary, pseudonymous check-in; its v1/v2 signed frame codecs and replay guards exist in `kodera-rs`, while physical `mDNS + QUIC` and `BLE GATT` radio hardware adapters remain planned. It is not an emergency service ([`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)).
- **Clean-host footprint measurements and Enterprise modules.** Clean-host install time and memory measurements for `deploy/community` are pending, and [`ee/`](./ee) holds its licence and READMEs with SAML 2.0 / SCIM 2.0 code still planned.

---

## Editions and pricing

| Edition | For | What you get | Price |
| :--- | :--- | :--- | :--- |
| **Community / Self-Host** | Developers, communities and teams who run their own server | Everything in the open-source tree, on your infrastructure: [`deploy/community`](./deploy/community/README.md). You bring an OIDC issuer and operate the stack. | **0 €** |
| **Team / Pro** | Teams who want it hosted | A workspace on the shared European cloud, with strict per-seat quotas. | **5 € excl. VAT per seat per month, billed annually** (6 € billed monthly) |
| **Sovereign / Enterprise** | Organisations that need their own tenant | A dedicated tenant, with custom terms. | **From 290 € excl. VAT per month**, or custom |

Community is what this repository builds and tests. Team / Pro and Sovereign / Enterprise are commercial offers of Samouraï Coop at [kodera.io](https://kodera.io): their price schedules and managed-hosting automation are not in the open-source tree ([`ee/billing`](./ee/billing/README.md)), and self-hosting never requires billing (`KODERA_BILLING_ENABLED=false`). The open-core boundary is in [`GOVERNANCE.md`](./GOVERNANCE.md).

---

## Monorepo Architecture

```mermaid
flowchart TB
  subgraph Clients["Web & Native Clients (Apache-2.0)"]
    WEB["`apps/web
React 19 + Vite + Tailwind`"]
    DESK["`apps/desktop
Tauri v2 bridge & self-host preflight`"]
    IOS["`apps/ios
SwiftUI companion client`"]
    AND["`apps/android
Kotlin + Jetpack Compose companion client`"]
  end

  subgraph Shared["Shared Packages & SDKs (Apache-2.0)"]
    RS["`packages/kodera-rs
UuidV7 · Ed25519 · OpenMLS/Megolm · passkeys · proximity`"]
    TOK["`packages/design-tokens
Cobalt × Kodera`"]
    API["`packages/api-contract
OpenAPI 3.1 Specs`"]
    SDK["`packages/extension-sdk
Signed Webhooks & Slash Commands`"]
  end

  subgraph Backend["Control Plane & Real-Time Media"]
    SRV["`apps/server (AGPL-3.0-or-later)
Django 6 · ADR-0003 Secret Isolation · Room Access`"]
    SYN["`Synapse + packages/synapse-policy
Closed homeserver, policy-governed rooms`"]
    LK["`LiveKit SFU
Audio, video and screen sharing`"]
    EE["`ee/ (Commercial License)
Planned enterprise modules`"]
  end

  WEB --> TOK & API
  WEB --> SYN & LK
  DESK --> RS
  IOS & AND --> TOK
  SRV --> API & SYN & LK
  EE -. "KODERA_EDITION=enterprise (planned)" .-> SRV
```

| Path | Package / Target | License | Description |
| :--- | :--- | :--- | :--- |
| [`apps/web`](./apps/web) | `@kodera/web` | `Apache-2.0` | Customer console and workspace web client |
| [`apps/desktop`](./apps/desktop) | `@kodera/desktop` | `Apache-2.0` | Origin-fenced Tauri v2 desktop bridge, deep-links, tray/PTT controls, OS keychain and local self-host preflight |
| [`apps/ios`](./apps/ios) | `KoderaiOS` | `Apache-2.0` | Native SwiftUI companion client (`ciel` parity, CallKit, PushKit, universal passkeys) |
| [`apps/android`](./apps/android) | `KoderaAndroid` | `Apache-2.0` | Native Kotlin / Jetpack Compose companion client (`ciel` parity, `ConnectionService`, UnifiedPush/FCM, universal passkeys) |
| [`apps/server`](./apps/server) | `kodera-server` | `AGPL-3.0-or-later` | Control plane API, extension runtime v2, billing/GDPR jobs, `room_access` and `tenant_agent` |
| [`packages/kodera-rs`](./packages/kodera-rs) | `kodera-rs` | `Apache-2.0` | Zero-unsafe Rust core (`UuidV7`, `Ed25519` device identity, OpenMLS/Megolm primitives, ES256 passkey binding, `#proximity` v1/v2 frame codecs) |
| [`packages/design-tokens`](./packages/design-tokens) | `@kodera/design-tokens` | `Apache-2.0` | Single source of truth for colour, typography and contrast gates |
| [`packages/api-contract`](./packages/api-contract) | `@kodera/api-contract` | `Apache-2.0` | Canonical OpenAPI 3.1 specifications |
| [`packages/extension-sdk`](./packages/extension-sdk) | `@kodera/extension-sdk` | `Apache-2.0` | Zero-dependency SDK for HMAC-signed webhooks and slash commands |
| [`packages/synapse-policy`](./packages/synapse-policy) | `kodera-synapse-policy` | `AGPL-3.0-or-later` | Matrix Synapse room-governance module |
| [`packages/create-kodera`](./packages/create-kodera) | `create-kodera` | `Apache-2.0` | Configuration generator that ships the same stack as `deploy/community`; local pre-release, not published |
| [`extensions`](./extensions/README.md) | `@kodera/ext-*` | `Apache-2.0` | Reference implementations built on the SDK; start from [`hello-webhook`](./extensions/hello-webhook) |
| [`deploy/community`](./deploy/community) | Docker Compose | `Apache-2.0` | Self-hosted stack (`Caddy + Postgres 17 + Valkey 8 + Synapse on its own Postgres + LiveKit`), bring your own OIDC issuer |
| [`ee`](./ee) | Enterprise Edition | [`ee/LICENSE`](./ee/LICENSE) | Reserved for commercial enterprise modules (Copyright Samouraï Coop); no code yet |

Architecture decisions are indexed in [`docs/adr/`](./docs/adr/README.md).

---

## Quickstart

### 1. Self-Host Community Edition

```bash
git clone https://github.com/kodera-hq/kodera.git
cd kodera/deploy/community
cp .env.example .env
# Populate KODERA_DOMAIN, your OIDC issuer (KODERA_OIDC_PROVIDER_ORIGIN, KODERA_AUTH_TRUST),
# hex secrets (openssl rand -hex 32) and 32-byte seal keys (openssl rand -base64 32 | tr '+/' '-_')
python3 ../../scripts/ci/check-community-deploy.py --preflight .env
docker compose up -d
```

The stack runs no identity provider: read [`deploy/community/README.md`](./deploy/community/README.md) first, in particular "Sign-in" and "Matrix sign-in". No installation time or footprint has been measured for it.

### 2. Develop Locally (Pick Only the Layer You Need)

```bash
# Extension SDK & reference extensions (zero backend required)
npm ci --ignore-scripts && npm run test:sdk

# Shared Rust core & desktop preview
cargo fmt --all -- --check && cargo clippy --locked --workspace --all-targets -- -D warnings && cargo test --locked --workspace && npm --workspace @kodera/desktop run typecheck

# Design Tokens + Web Client
npm run test:tokens && npm run typecheck && npm run test:web

# Server Control Plane static & contract gates (Python 3.12 + uv; clean env per ADR-0003)
(cd apps/server && uv sync --locked && env -i PATH="$PATH" HOME="$HOME" uv run ruff check . && env -i PATH="$PATH" HOME="$HOME" uv run mypy . && env -i PATH="$PATH" HOME="$HOME" uv run python scripts/ci/check-authz-matrix.py)

# Documentation links, the ADR index and the self-host profile
python3 scripts/ci/check-docs-truth.py && python3 scripts/ci/check-community-deploy.py
```

---

## Security, Governance & Licensing

- **Supply chain:** secrets are refused at server start-up unless admitted by name (`ADR-0003`); GitHub Actions are pinned to commit SHAs; every pull request and every push to `main` is scanned for secrets; a CycloneDX SBOM is generated for the npm workspaces. Signed build provenance (SLSA) is planned and not produced today.
- **Vulnerability Disclosure:** Please report security issues privately via [GitHub Security Advisories](https://github.com/kodera-hq/kodera/security/advisories/new) or `support@kodera.io` — see [`SECURITY.md`](./SECURITY.md).
- **Open-Core Governance:** Read our buyer-based open-core pledge and maintainer rings in [`GOVERNANCE.md`](./GOVERNANCE.md).
- **Licensing & Trademarks:** Client apps, design tokens, contracts, SDKs, community deploy, and Rust core are [`Apache-2.0`](./LICENSE-APACHE); server and Synapse policy are [`AGPL-3.0-or-later`](./LICENSE-AGPL); `ee/` is commercial ([`ee/LICENSE`](./ee/LICENSE)). The **Kodera** name and mark are protected under [`TRADEMARKS.md`](./TRADEMARKS.md).

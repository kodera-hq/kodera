# Project Governance & Open-Core Charter

Status: Active

Kodera is stewarded by **Samouraï Coop** (`https://kodera.io`) as an **Open-Core** project designed for long-term sustainability, European digital sovereignty, and frictionless open-source collaboration.

## 1. Our Buyer-Based Open-Core Principle

We apply a strict **Buyer-Based Open Core** rule so individual users, developer communities, NGOs, and self-hosters never experience artificial limits:

- **Always Open Source (`Apache-2.0` / `AGPL-3.0-or-later`):**
  - Real-time channels, threads, direct messages, file sharing, and search
  - Low-latency voice, video, and screen-sharing rooms (LiveKit WebRTC)
  - Web (`apps/web`), Desktop (`apps/desktop`), iOS (`apps/ios`), and Android (`apps/android`) clients (`Apache-2.0`)
  - Shared Rust core (`packages/kodera-rs`), Design Tokens (`packages/design-tokens`), OpenAPI Contracts (`packages/api-contract`), Extension SDK (`packages/extension-sdk`), and community extensions (`extensions/*`) (`Apache-2.0`)
  - Control plane server (`apps/server`) and Matrix Synapse room-policy module (`packages/synapse-policy`) (`AGPL-3.0-or-later`)
  - Single-node self-hosted stack (`deploy/community/`, `Apache-2.0`)
  - Standard security patches and vulnerability advisories
- **Commercial Enterprise Edition (`ee/`, `LicenseRef-Kodera-EE`):**
  - Capabilities built for corporate CISO, compliance, and multi-entity governance: Multi-Org Federation Hub, SAML 2.0 / OIDC corporate SSO + SCIM 2.0 directory sync, Audit Vault (WORM legal-hold & SIEM exports), Sovereign KMS (BYOK / HSM), and Commercial Billing & Managed Self-Host (`Kodera Autopilot`).

Features already shipped in the open-source tree will **never** be moved into `ee/`.

## 2. Repository Permission Rings

To welcome external contributors and Satellite Team engineers safely from Day 1, `kodera-hq/kodera` enforces three review rings via Branch Rulesets and [`.github/CODEOWNERS`](./.github/CODEOWNERS) (ordered broadest-to-narrowest so Ring 0 overrides always win):

- **Ring 0 — Core Architects & Security Maintainers (`@kodera-hq/security`, `@zxxma`, `@louis14448`):**
  - Exclusive merge authority over `/.github/`, `/ee/`, `/LICENSE*`, `/TRADEMARKS.md`, `/SECURITY.md`, `/GOVERNANCE.md`, `/AGENTS.md`, `/Cargo.toml`, `/Cargo.lock`, `/package.json`, `/package-lock.json`, `/apps/server/`, `/apps/desktop/src-tauri/`, `/packages/kodera-rs/`, `/packages/api-contract/`, `/packages/synapse-policy/`, and `/deploy/community/`.
- **Ring 1 — Trusted Domain Maintainers (`@kodera-hq/maintainers`, `@zxxma`, `@louis14448`):**
  - Review and shepherd changes across `/apps/web/`, `/apps/desktop/` (outside `src-tauri/`), `/apps/ios/`, `/apps/android/`, `/packages/design-tokens/`, and `/packages/extension-sdk/`.
- **Ring 2 — Community & Satellite Contributors:**
  - Submit pull requests via fork or feature branch (`/extensions/*`, UI polish, tests, documentation, bug fixes). Every PR runs automated CI checks without exposing deployment or signing secrets.

## 3. Architectural Changes (`docs/rfcs/`)

Cross-cutting protocol, cryptographic, or API changes begin as a concise RFC in [`docs/rfcs/`](./docs/rfcs/) (see [`RFC-0001`](./docs/rfcs/RFC-0001-emergency-ble-channel.md)) and require approval from at least one Ring 0 maintainer before implementation.

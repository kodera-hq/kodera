# Working in the Kodera Monorepo (`AGENTS.md`)

Status: Active

This file defines repository-wide engineering, security, and contribution rules for human contributors and automated coding assistants working in `kodera-hq/kodera`. Per-package `AGENTS.md` files (where present) add local invariants and never weaken the rules below.

## Repository Layout

- `apps/web/` — `@kodera/web` customer & workspace web client (`Apache-2.0`).
- `apps/desktop/` — `@kodera/desktop` desktop developer preview: Rust backend seams, Tauri configuration and a local self-host preflight; no running shell or provider calls yet (`Apache-2.0`).
- `apps/ios/` — Native SwiftUI iOS client (`Apache-2.0`).
- `apps/android/` — Native Kotlin / Jetpack Compose Android client (`Apache-2.0`).
- `apps/server/` — `kodera-server` Django 6 control plane, room-access, and tenant agent (`AGPL-3.0-or-later`).
- `packages/kodera-rs/` — Shared zero-unsafe Rust core: `UuidV7`, device identity traits, OpenMLS seam, `#urgence` proximity codec (`Apache-2.0`).
- `packages/design-tokens/` — `@kodera/design-tokens` single source of truth for colour, typography, and motion (`Apache-2.0`).
- `packages/api-contract/` — `@kodera/api-contract` canonical OpenAPI 3.1 contracts (`Apache-2.0`).
- `packages/extension-sdk/` — `@kodera/extension-sdk` signed webhook & slash-command SDK (`Apache-2.0`).
- `packages/synapse-policy/` — Matrix Synapse room-policy module (`AGPL-3.0-or-later`).
- `extensions/` — Starter and community extensions (`Apache-2.0`).
- `deploy/community/` — Single-node self-hosted Docker Compose profile (`Apache-2.0`); it brings no identity provider (`KODERA_AUTH_TRUST`, see its README).
- `ee/` — Commercial Enterprise Edition (`LicenseRef-Kodera-EE`, Copyright Samouraï Coop).

## Non-Negotiable Engineering Rules

1. **Language:** English for all code, comments, documentation, commit messages, pull requests, and issues. French (and other locales) lives strictly in user-facing message catalogues.
2. **Design System:** Never hardcode hex colours, raw spacing, or font stacks in client UI code. Always consume `@kodera/design-tokens`.
3. **Secrets & Environment:** Never commit `.env` files, private keys, certificates, or live customer/tenant identifiers. Only `.env.example` templates with placeholder values belong in version control. `apps/server/config/environment.py` enforces `ADMITTED_SECRET_NAMES` at startup (ADR-0003).
4. **Branch & PR Hygiene:** Never push directly to `main`. Open a feature branch (`feat/`, `fix/`, `chore/`, `docs/`) and submit a pull request with a clear specification, acceptance criteria, and test evidence.
5. **Commit Messages & Vendor Neutrality:** Write a concise single-line `why`-focused commit subject. Never add co-author attribution trailers, generator footers, or automated-assistant vendor names anywhere in code, docs, filenames, commits, branches, or PR bodies. Run `python3 .github/scripts/check-vendor-attribution.py .` before every push.
6. **Safety & Supply Chain:** `#![forbid(unsafe_code)]` is enforced in Rust workspace crates (`packages/kodera-rs`, `apps/desktop/src-tauri`). GitHub Actions workflows pin third-party actions to full 40-character commit SHAs with minimal `permissions: contents: read`.
7. **Status Headers Over Deadlines:** Use `Status:` headers in architectural and specification documents rather than speculative calendar deadlines.

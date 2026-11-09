# Contributing to Kodera

Status: Active

Thank you for contributing to Kodera! Whether you are fixing a UI detail, building a slash-command extension, auditing cryptography in `kodera-rs`, or improving self-host docs, we have designed the monorepo so your **first test run takes under 15 minutes**.

## 1. Choose Your Fast-Track Slice

You never need to boot every service at once to work on a single layer:

| What you want to build | Prerequisites | Commands to verify locally |
| :--- | :--- | :--- |
| **Slash-command / Webhook Extension** (`extensions/*`, `packages/extension-sdk`) | Node.js `22.22.2+` LTS (`.nvmrc`) | `npm ci --ignore-scripts && npm run test:sdk` |
| **Design Tokens** (`packages/design-tokens`) | Node.js `22.22.2+` LTS (`.nvmrc`) | `npm --workspace @kodera/design-tokens run test` |
| **Web Client** (`apps/web`) | Node.js `22.22.2+` LTS (`.nvmrc`) | `npm ci --ignore-scripts && npm run typecheck && npm run test:web` |
| **Rust Core & Desktop Shell** (`packages/kodera-rs`, `apps/desktop`) | Rust `>= 1.82`, Node `22.22.2+` LTS | `cargo fmt --all -- --check && cargo clippy --locked --workspace --all-targets -- -D warnings && cargo test --locked --workspace && npm --workspace @kodera/desktop run typecheck` |
| **Server Static & Contract Gates** (`apps/server`, zero Docker) | Python `3.12`, `uv` | `(cd apps/server && uv sync --locked && env -i PATH="$PATH" HOME="$HOME" uv run ruff check . && env -i PATH="$PATH" HOME="$HOME" uv run mypy . && env -i PATH="$PATH" HOME="$HOME" uv run python scripts/ci/check-authz-matrix.py)` |
| **Server Full DB Test Suite** (`apps/server`, Docker `test-db`) | Python `3.12`, `uv`, Docker | `(cd apps/server && uv sync --locked && make test-db && make test)` |

> **Note on `ADR-0003` Clean Environment:** `apps/server` refuses ambient `SSH_*`, `AWS_*`, `SCW_*`, `SOPS_*`, `AGE_*`, `TF_*`, and `GOOGLE_*` variables by design so infrastructure credentials can never leak into application processes. Use `env -i PATH="$PATH" HOME="$HOME"` when invoking `uv run` in `apps/server`.

For role-based onboarding paths, see [`ONBOARDING.md`](./ONBOARDING.md).

## 2. Pull Request Workflow & Standards

1. Read [`AGENTS.md`](./AGENTS.md) for codebase invariants (design tokens, secret isolation, English-only code/docs).
2. Create a topic branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, or `chore/<topic>`.
3. Add or update unit/acceptance tests covering your change. Every preflight or CI script must include a mutation self-test proving it fails on broken input.
4. Run `python3 .github/scripts/check-vendor-attribution.py .` and `python3 .github/scripts/check-required-clauses.py .` before pushing.
5. Open a Pull Request filling out the specification, acceptance criteria, local verification output, and licensing confirmation.

## 3. Licensing & Contributor Grant

- Contributions to `Apache-2.0` directories (`apps/web`, `apps/desktop`, `apps/ios`, `apps/android`, `packages/kodera-rs`, `packages/design-tokens`, `packages/api-contract`, `packages/extension-sdk`, `extensions/*`, `deploy/community/*`) are governed by Section 5 of the Apache License, Version 2.0 ("inbound = outbound").
- Contributions to `AGPL-3.0-or-later` server components (`apps/server`, `packages/synapse-policy`) are licensed under `AGPL-3.0-or-later` and include a non-exclusive, perpetual, royalty-free grant to Samouraï Coop to distribute the contribution across Kodera's open-source and commercial editions as documented in [`GOVERNANCE.md`](./GOVERNANCE.md).

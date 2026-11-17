# Contributor & Team Onboarding Guide (`ONBOARDING.md`)

Status: Active

This 1-page map helps Core engineers, Satellite Team contributors, and external open-source developers become productive in under 15 minutes without needing production credentials or a full multi-service cluster.

## Toolchain Prerequisites

- **Node.js:** `.nvmrc` pins the `22` line; `package.json` `engines` accepts `^22.22.2 || ^24.15.0 || >=26.0.0` (so `23.x` and `25.x` are refused) — always install via `npm ci --ignore-scripts`
- **Rust:** standalone `packages/kodera-rs` (`--no-default-features`) declares `rust-version = "1.80"` (`rustfmt` + `clippy`); workspace default checks (`cargo check --workspace`, including `kodera-desktop` `tao`/`wry`) require `1.88+`; the opt-in native OpenMLS crypto providers (`openmls_rust_crypto` / `openmls_basic_credential` backports) require `1.94+` (and WASM `browser-bindings` in CI uses `1.100.0`)
- **Python:** `3.12` + `uv` (for `apps/server` and `packages/synapse-policy`)

## Role-Based Entry Points

| Role / Focus | Primary Directories | First Local Check (`< 5 min`, Zero Cloud Credentials) | Good First Contributions |
| :--- | :--- | :--- | :--- |
| **Extensions, Bots & Integrations** *(Satellite & Community)* | `packages/extension-sdk/`, `extensions/` | `npm ci --ignore-scripts && npm run test:sdk` | Build GitHub/GitLab/Linear/Grafana webhook & slash-command extensions in `extensions/` |
| **Frontend, Design System & QA** *(Web & Accessibility)* | `apps/web/`, `packages/design-tokens/` | `npm ci --ignore-scripts && npm run test:tokens && npm run test:web` | UI components consuming `@kodera/design-tokens`, Playwright specs, i18n catalogues |
| **Desktop & Shared Rust Core** *(Tauri v2 & Crypto/BLE)* | `packages/kodera-rs/`, `apps/desktop/` | `cargo fmt --all -- --check && cargo clippy --locked --workspace --all-targets -- -D warnings && cargo test --locked --workspace && npm --workspace @kodera/desktop run typecheck` | Tauri IPC adapters, `RFC-0001` `#proximity` test vectors, desktop UI polish |
| **Native Mobile** *(SwiftUI iOS / Compose Android)* | `apps/ios/`, `apps/android/`, `packages/kodera-rs/` | `(cd apps/ios && python3 scripts/ci/check-app-resources.py) && (cd apps/android && python3 scripts/ci/check-app-resources.py)` | UniFFI bindings to `kodera-rs`, native voice room UI, BLE GATT peripheral/central bridges |
| **Backend, Control Plane & SRE** *(Django 6, Synapse)* | `apps/server/`, `packages/synapse-policy/`, `deploy/community/` | `(cd apps/server && uv sync --locked && env -i PATH="$PATH" HOME="$HOME" uv run ruff check . && env -i PATH="$PATH" HOME="$HOME" uv run mypy . && env -i PATH="$PATH" HOME="$HOME" uv run python scripts/ci/check-authz-matrix.py)` | OpenAPI contract tests, Synapse policy rules, server static & DB suites (`make -C apps/server test-db test`) |

## Golden Rules to Remember

1. **Zero `.env` or live credentials in Git** — copy `.env.example` locally; never commit real keys or customer domains.
2. **ADR-0003 Clean Environment Isolation (`apps/server`)** — `apps/server` intentionally refuses ambient cloud/SSH/SOPS variables (`SSH_*`, `AWS_*`, `SCW_*`, `SOPS_*`, `AGE_*`, `TF_*`, `GOOGLE_*`) at startup. Always run server commands inside a clean environment (`env -i PATH="$PATH" HOME="$HOME" ...`), and start the disposable `fsync=off` test database (`make -C apps/server test-db`) before running `make test-server`.
3. **Tokens-only styling** — never inline hex colours or font names in UI code; import from `@kodera/design-tokens`.
4. **Ring 0 boundaries** — `/.github/`, `/ee/`, `/LICENSE*`, `/TRADEMARKS.md`, `/SECURITY.md`, `/GOVERNANCE.md`, `/AGENTS.md`, `/Cargo.*`, `/package*.json`, `/apps/server/`, `/apps/desktop/src-tauri/`, `/packages/kodera-rs/`, `/packages/api-contract/`, `/packages/synapse-policy/`, and `/deploy/community/` require Core Architect (`Ring 0`) review via [`.github/CODEOWNERS`](./.github/CODEOWNERS).
5. **Pre-push hygiene check** — always run `python3 .github/scripts/check-vendor-attribution.py .` and `python3 .github/scripts/check-required-clauses.py .` before pushing your branch.

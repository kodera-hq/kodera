# Security Policy & Coordinated Vulnerability Disclosure

Status: Active

Security, cryptographic integrity, and European regulatory readiness — including alignment with **EU Cyber Resilience Act (Regulation (EU) 2024/2847, Article 14 & Annex I Part II)** vulnerability handling, CycloneDX 1.6 SBOM transparency, and 40-character SHA-pinned deterministic CI pipelines (with cryptographic SLSA v1.0 build provenance `Planned` on the release roadmap) — are core engineering invariants of Kodera.

## Reporting a Vulnerability (Private Disclosure Only)

**Please do NOT open a public GitHub Issue or Discussion for suspected security vulnerabilities.**

Report vulnerabilities privately through either of our official channels:

1. **GitHub Private Vulnerability Reporting (Preferred):**  
   Submit an encrypted advisory directly at [`https://github.com/kodera-hq/kodera/security/advisories/new`](https://github.com/kodera-hq/kodera/security/advisories/new).
2. **Direct Security Team Email:**  
   Send full reproduction steps, affected component paths, and impact assessment to **`support@kodera.io`**.

### Coordinated Disclosure & Remediation Targets

- **Acknowledgement:** Within **48 hours (2 business days)** of receipt.
- **Triage & Severity Assessment (CVSS v4.0):** Within **5 business days**.
- **Target Remediation Windows (CVSS v4.0):** Critical `<= 7 days`, High `<= 30 days`, Medium `<= 90 days`.
- **Advisory Publication:** Security patches land free of charge and unbundled from commercial feature gates (`CRA Annex I Part II`), with machine-readable GitHub Security Advisories (GHSA / CVE) published once fixes are available for self-hosted operators and deployed on `kodera.io`.
- **EU Cyber Resilience Act (Article 14) Notification:** For commercial and managed Kodera offerings, Samouraï Coop adheres to EU CRA Article 14 actively exploited vulnerability reporting obligations (**24h early warning**, **72h vulnerability notification**, and **14-day final report** to the designated CSIRT coordinator / ENISA Single Reporting Platform).
- **Safe Harbor:** Good-faith security research conducted in compliance with this policy against local `deploy/community` instances — without accessing third-party customer data, degrading `kodera.io` availability, or exfiltrating credentials — is authorized by Samouraï Coop, which waives anti-circumvention / unauthorized-access claims (including French Code pénal Art. 323-1) for compliant research.

## Supported Versions

| Component / Track | Version | Security Fixes |
| :--- | :--- | :--- |
| `main` (Developer Preview) | Rolling `HEAD` | Supported |
| Latest tagged minor release (post-`v1.0`) | Latest `x.y.*` | Supported |
| Older minor releases | `< Latest` | Upgrade required |

## Architectural Security Summary

For the full trust-boundary diagram, STRIDE controls, and cryptographic wire specifications, see [`docs/security/THREAT_MODEL_AND_CRYPTOGRAPHY.md`](./docs/security/THREAT_MODEL_AND_CRYPTOGRAPHY.md) and [`apps/server/docs/security/README.md`](./apps/server/docs/security/README.md):

- **Control-Plane-First IAM:** Customer OIDC JWT verification (`RS256` / `ES256`) runs offline against static `KODERA_AUTH_TRUST` snapshots (while `/staff/v1/*` fetches its staff-realm JWKS over HTTPS in `core/staff_api/auth.py`), mapping `(issuer, subject)` to organisation-scoped PostgreSQL authority in `apps/server` before projecting permissions into `Synapse` (`packages/synapse-policy`), `LiveKit` (`room_access`), and `yjs_collab`.
- **PostgreSQL Least-Privilege Role Split:** Runtime services connect through four non-superuser database roles — `kodera_api` and `kodera_collab` verify their effective privileges against `pg_catalog` at process startup, while `kodera_retention_worker` and `kodera_retention_admission` are grant-scoped SQL roles verified in the test suite — backed by `SET search_path`-hardened `SECURITY DEFINER` scope and immutability triggers.
- **Startup & Sidecar Secret Isolation (`ADR-0003` & `ADR-0018`):** `apps/server/config/environment.py` rejects cloud/IaC credentials (`SCW_*`, `AWS_*`, `TF_*`, `SSH_*`, `SOPS_*`, `AGE_*`) and unadmitted secret variables at startup; `LIVEKIT_API_SECRET` never enters Django WSGI API workers (held only by `apps/server/room_access` for token minting and `apps/server/tenant_agent` for room/participant reconciliation), and secret files load via `O_NOFOLLOW` descriptor walks.
- **Memory-Safe Rust & Worker-Isolated Confidentiality:** `packages/kodera-rs` and `apps/desktop/src-tauri` enforce `#![forbid(unsafe_code)]`; browser confidentiality isolates `MLS` (`RFC 9420`), `SFrame v1` media transforms, `KVKB1` zero-knowledge key backups, and `KDE1` document envelopes inside dedicated WebWorkers alongside `EspaceVault` IndexedDB v2, `KDV1` native vaults, and `#180` sticky fail-closed room quarantine.
- **Clean-Room Open-Core & Tamper-Evident Audit:** `ee/` carries zero static imports from open-source packages (`ee/tests/test_edition_boundary.py`), fails closed in Community mode, and signs Enterprise compliance ledger exports with `Ed25519` over SHA-256 hash chains.
- **Zero-Secret PR CI, CycloneDX 1.6 SBOMs & Mutation Gates:** Pull-request workflows run with `contents: read`, `persist-credentials: false`, and zero custom secrets (`scripts/ci/check-zero-secret-pr-ci.py`), pinning actions to 40-hex SHAs, images to `sha256:` digests, and running `--selftest` mutation suites on security gates (SLSA v1.0 provenance attestations `Planned`).

# Security Policy & Coordinated Vulnerability Disclosure

Status: Active

Security, cryptographic integrity, and European regulatory readiness — including alignment with **EU Cyber Resilience Act (Regulation (EU) 2024/2847, Article 14 & Annex I Part II)** vulnerability handling, CycloneDX SBOM transparency, and SLSA build provenance — are core engineering invariants of Kodera.

## Reporting a Vulnerability (Private Disclosure Only)

**Please do NOT open a public GitHub Issue or Discussion for suspected security vulnerabilities.**

Report vulnerabilities privately through either of our official channels:

1. **GitHub Private Vulnerability Reporting (Preferred):**  
   Submit an encrypted advisory directly at [`https://github.com/kodera-hq/kodera/security/advisories/new`](https://github.com/kodera-hq/kodera/security/advisories/new).
2. **Direct Security Team Email:**  
   Send full reproduction steps, affected component paths, and impact assessment to **`support@kodera.io`**.

### Coordinated Disclosure & Remediation SLAs

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

## Built-In Security & CRA Supply-Chain Controls

- **Memory-Safe Native Core:** `packages/kodera-rs` and `apps/desktop/src-tauri` enforce `#![forbid(unsafe_code)]`.
- **Startup Secret Isolation (`ADR-0003` & `ADR-0018`):** `apps/server/config/environment.py` rejects infrastructure credentials (`SCW_*`, `AWS_*`, `TF_*`, `SSH_*`, `SOPS_*`, `AGE_*`) and unadmitted secret-shaped environment variables before booting WSGI workers, while LiveKit SFU credentials remain isolated inside `room-access`.
- **Automated CycloneDX SBOM & Dependency Auditing:** `.github/workflows/security-sbom.yml` generates machine-readable CycloneDX Software Bills of Materials (`npm sbom --sbom-format=cyclonedx`) alongside locked Python (`uv.lock` / hash-pinned `requirements-test.txt`) and Rust (`Cargo.lock`) component inventories and runs `npm audit` vulnerability checks.
- **Container Digest Pinning & Provenance Architecture:** `.github/workflows/publish-images.yml` tags published container images by exact 40-character Git commit SHA, records verified `sha256:` image digests (`org.opencontainers.image.revision`), and pairs with `.github/workflows/security-sbom.yml` automated CycloneDX SBOM dependency inventory generation and 40-character SHA-pinned GitHub Actions (with cryptographic SLSA v1.0 build-provenance attestation targeted for tagged release artifacts).
- **Immutable CI Pinning:** All GitHub Actions workflows pin actions to full 40-character commit SHAs, disable credential persistence (`persist-credentials: false`), and run under least-privilege `GITHUB_TOKEN` scopes (`contents: read`).

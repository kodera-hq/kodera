# Kodera Enterprise Edition (`ee/`)

Status: Active

This directory holds commercial **Enterprise Edition (`KODERA_EDITION=enterprise`)** capabilities governed by [`ee/LICENSE`](./LICENSE) (Samouraï Coop Commercial License, `LicenseRef-Kodera-EE`).

## Our Buyer-Based Open-Core Principle & Clean-Room Boundary

Kodera follows a strict, transparent boundary inspired by GitLab, Mattermost, and Grafana (see [`GOVERNANCE.md`](../GOVERNANCE.md)):

1. **Clean-Room Isolation:** `ee/` is loaded strictly when `KODERA_EDITION=enterprise`. Open-source packages (`apps/*`, `packages/*`, `extensions/*`, `deploy/community/`) contain zero static imports of `ee/` and run standalone in Community Edition (`KODERA_EDITION=community`, the default) with zero degraded collaboration features. When `KODERA_EDITION=community`, requests to `/api/v1/ee/*` return `403 {"detail": "Enterprise Edition required", "code": "enterprise_edition_required"}`.
2. **Never cripple individual or team collaboration in Community Edition:** Channels, DMs, voice/video rooms, screen-sharing, file sharing, standard security updates, Passkeys, `#urgence` client lifeline, and the Extension SDK live in the open-source tree (`Apache-2.0` / `AGPL-3.0-or-later`) forever.
3. **Enterprise governance, compliance & billing pillars live in `ee/`:** Features built specifically for CISO, procurement, and multi-entity corporate governance require a commercial subscription at **[kodera.io](https://kodera.io)**.

## Implemented Enterprise Edition Modules

- **[`ee/edition.py`](./edition.py) & [`ee/router.py`](./router.py):**
  - Runtime `KODERA_EDITION=enterprise` gate and `/api/v1/ee/*` HTTP dispatcher (`GET /api/v1/ee/status`).
- **[`ee/saml/`](./saml/__init__.py) — SAML 2.0 Corporate Federation & Multi-IdP SSO (`/api/v1/ee/sso/saml/*`):**
  - Tenant-scoped Service Provider metadata (`GET /api/v1/ee/sso/saml/<tenant_slug>/metadata`), multi-IdP discovery (`GET /providers`), HTTP-Redirect `AuthnRequest` + HMAC `RelayState` CSRF binding (`GET|POST /login`), and Assertion Consumer Service (`POST /acs`).
  - Hardened XML security (`ee/saml/xml_security.py`): rejects `DOCTYPE`, `!ENTITY`, processing instructions, comments, XInclude, non-UTF-8 BOMs, and unknown entities prior to parsing; enforces W3C Exclusive XML Canonicalization (`exc-c14n#`), RSA-SHA256 / ECDSA-SHA256 signature verification, XSW1-XSW8 structural defenses, Assertion `ID` replay caching, and tenant-verified email domain enforcement.
- **[`ee/scim/`](./scim/__init__.py) — RFC 7643 / RFC 7644 SCIM 2.0 Provisioning (`/api/v1/ee/scim/v2/*`):**
  - Constant-time SHA-256 hashed per-tenant SCIM bearer tokens with scope enforcement, cross-tenant isolation, and instant token revocation.
  - `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`, `/Users`, and `/Groups` with `application/scim+json` responses, `filter` + `startIndex`/`count` pagination, and Okta / Microsoft Entra ID `PatchOp` compatibility including instant session and membership deprovisioning on `active: false`.
- **[`ee/audit_export/`](./audit_export/__init__.py) — Tamper-Evident Signed Compliance Audit Exports (`/api/v1/ee/compliance/audit-exports/*`):**
  - Append-only SHA-256 hash-chained audit ledger (`prev_hash -> entry_hash`) with detached Ed25519 (and HMAC-SHA256 fallback) manifest signatures over NDJSON and CSV compliance bundles (`SOC2`, `ISO27001`, `SECNUMCLOUD`), streaming export, date/actor filters, PII redaction policy, `/verify` endpoint, and standalone offline CLI verifier:
    ```bash
    PYTHONPATH=. python3 -m ee.audit_export.verify --bundle export.ndjson --manifest manifest.json
    ```
- **[`ee/billing/`](./billing/README.md):** Commercial subscription catalogue and fleet billing boundary.

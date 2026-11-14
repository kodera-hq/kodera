# Kodera Enterprise Edition (`ee/`)

Status: Active

This directory holds commercial **Enterprise Edition (`KODERA_EDITION=enterprise`)** capabilities governed by [`ee/LICENSE`](./LICENSE) (Samouraï Coop Commercial License, `LicenseRef-Kodera-EE`).

## Our Buyer-Based Open-Core Principle & Clean-Room Boundary

Kodera follows a strict, transparent boundary inspired by GitLab, Mattermost, and Grafana (see [`GOVERNANCE.md`](../GOVERNANCE.md)):

1. **Clean-Room Isolation:** `ee/` is loaded strictly when `KODERA_EDITION=enterprise`. Open-source packages (`apps/*`, `packages/*`, `extensions/*`, `deploy/community/`) contain zero static imports of `ee/` and run standalone in Community Edition (`KODERA_EDITION=community`, the default) with zero degraded collaboration features. When `KODERA_EDITION=community`, requests to `/api/v1/ee/*` return `403 {"detail": "Enterprise Edition required", "code": "enterprise_edition_required"}`.
2. **Never cripple individual or team collaboration in Community Edition:** Channels, DMs, voice/video rooms, screen-sharing, file sharing, standard security updates, Passkeys, `#urgence` client lifeline, and the Extension SDK live in the open-source tree (`Apache-2.0` / `AGPL-3.0-or-later`) forever.
3. **Enterprise governance, compliance & billing pillars live in `ee/`:** Features built specifically for CISO, procurement, and multi-entity corporate governance require a commercial subscription at **[kodera.io](https://kodera.io)**.

## Implemented Enterprise Edition Modules

- **[`ee/edition.py`](./edition.py), [`ee/router.py`](./router.py), [`ee/auth.py`](./auth.py) & [`ee/store.py`](./store.py):**
  - Runtime `KODERA_EDITION=enterprise` gate and `/api/v1/ee/*` HTTP dispatcher (`GET /api/v1/ee/status`).
  - Verified Kodera customer Bearer token admission + active `Organisation` and `Membership` (`org_owner` / `org_admin`) authorization (`401` unauthenticated, `403` cross-tenant or insufficient role).
  - Multi-worker PostgreSQL persistence (`ee_*` idempotent tables via `django.db.connection` with zero open-core `apps/server/apps/*/migrations/` pollution) and deterministic HKDF-SHA256 per-tenant signing key derivation across Gunicorn workers and restarts.
- **[`ee/saml/`](./saml/__init__.py) — SAML 2.0 Corporate Federation & Multi-IdP SSO (`/api/v1/ee/sso/saml/*`):**
  - Public SAML 2.0 protocol endpoints (`GET .../metadata`, SP-initiated `GET|POST .../login`, and IdP-signed `POST .../acs`) plus Bearer-authenticated tenant admin IdP management (`GET|POST .../providers`).
  - Hardened XML security (`ee/saml/xml_security.py`): rejects `DOCTYPE`, `!ENTITY`, processing instructions, comments, XInclude, non-UTF-8 BOMs, and unknown entities prior to parsing; enforces W3C Exclusive XML Canonicalization (`exc-c14n#`), RSA-SHA256 / ECDSA-SHA256 signature verification, XSW1-XSW8 structural defenses, PostgreSQL atomic `RelayState` consumption and Assertion `ID` replay caching, and tenant-verified email domain enforcement.
- **[`ee/scim/`](./scim/__init__.py) — RFC 7643 / RFC 7644 SCIM 2.0 Provisioning (`/api/v1/ee/scim/v2/*`):**
  - Constant-time SHA-256 hashed per-tenant SCIM bearer tokens persisted in PostgreSQL with scope enforcement, cross-tenant isolation, and instant multi-worker token revocation.
  - `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`, `/Users`, and `/Groups` with `application/scim+json` responses, linear-time `filter` + `startIndex`/`count` pagination, and Okta / Microsoft Entra ID `PatchOp` compatibility including instant session and membership deprovisioning on `active: false`.
- **[`ee/audit_export/`](./audit_export/__init__.py) — Tamper-Evident Signed Compliance Audit Exports (`/api/v1/ee/compliance/audit-exports/*`):**
  - Authenticated tenant-admin append-only SHA-256 hash-chained audit ledger (`prev_hash -> entry_hash`) with detached Ed25519 (and HMAC-SHA256 fallback) manifest signatures over NDJSON and CSV compliance bundles (`SOC2`, `ISO27001`, `SECNUMCLOUD`), streaming export, date/actor filters, PII redaction by default (`redact_pii=True`, `org_owner` required for unredacted export), server-governed key-pinned `/verify` endpoint, and standalone offline CLI verifier requiring an explicit pinned trust key:
    ```bash
    PYTHONPATH=. python3 -m ee.audit_export.verify --bundle export.ndjson --manifest manifest.json --public-key tenant-ed25519.pub.pem
    ```
- **[`ee/billing/`](./billing/README.md):** Commercial subscription catalogue and fleet billing boundary.

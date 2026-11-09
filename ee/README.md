# Kodera Enterprise Edition (`ee/`)

Status: Active

This directory holds commercial **Enterprise Edition (`KODERA_EDITION=enterprise`)** capabilities governed by [`ee/LICENSE`](./LICENSE) (Samouraï Coop Commercial License).

## Our Buyer-Based Open-Core Principle & Clean-Room Boundary

Kodera follows a strict, transparent boundary inspired by GitLab, Mattermost, and Grafana:

1. **Clean-Room Isolation:** `ee/` is loaded strictly when `KODERA_EDITION=enterprise`. Open-source packages (`apps/*`, `packages/*`, `extensions/*`, `deploy/community/`) contain zero imports of `ee/` and run standalone in Community Edition with zero degraded collaboration features. All code inside `ee/` is authored cleanly under Samouraï Coop ownership.
2. **Never cripple individual or team collaboration in Community Edition:** Channels, DMs, voice/video rooms, screen-sharing, file sharing, standard security updates, Passkeys, `#urgence` client lifeline, and the Extension SDK live in the open-source tree (`Apache-2.0` / `AGPL-3.0-or-later`) forever.
3. **Enterprise governance, compliance & billing pillars live in `ee/`:** Features built specifically for CISO, procurement, and multi-entity corporate governance require a commercial subscription at **[kodera.io](https://kodera.io)**:
   - **Multi-Org Federation Hub:** governed cross-organisation workspace federation, external guest boundary policies, and partner directory rules
   - **Enterprise Identity (SAML 2.0 / OIDC & SCIM 2.0):** corporate IdP federation, automated group/role lifecycle provisioning, and mandatory hardware MFA / session posture enforcement
   - **Audit Vault:** immutable WORM legal-hold storage, DLP hooks, and SIEM / OpenTelemetry compliance exports
   - **Sovereign KMS:** customer-managed encryption keys (BYOK / HSM envelope encryption) and data-residency enforcement
   - **Commercial Billing & Fleet Autopilot:** commercial subscription catalogue, Stripe / bank-transfer invoicing, seat & tier metering, multi-site `#urgence` crisis console, and Managed Self-Host Autopilot

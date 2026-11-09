# ADR-0002: Tenant admins log in against their own tenant realm

**Status:** Accepted
**Date:** 2026-09-02
**Deciders:** the crew (proposal by zôÖma)

## Context
Core ADR-0006 establishes Keycloak at `id.kodera.io` with one realm per customer organisation and a separate staff realm. The persona buying "one login for every app" is the tenant admin. A design where the console authenticates against a separate `kodera-staff` realm gives that person two accounts: one for the console, one for Visio and later admitted applications, and forces the Core API to map two subjects for delegated administration.

## Decision
- The console authenticates tenant users against **the tenant's realm**, selected by organisation slug or by email domain on the login screen.
- The `kodera-staff` realm is used **only by Kodera staff** (operators, support), with mandatory MFA.
- MFA (passkey or TOTP) is mandatory for every tenant admin. Hosted accounts use email magic link or password of at least 12 characters plus TOTP. SMS is not a login factor.
- The Core API verifies tokens from any tenant realm and derives the organisation from the realm; it never trusts a realm claim supplied by the client.

## Options considered
- Console on the `kodera-staff` realm brokering to each tenant realm: viable, more moving parts, kept as a fallback if realm selection on the login screen proves confusing in the beta.
- Clerk for the console: rejected by the sovereignty stance and the one-IdP rule.

## Consequences
- The login screen needs a realm-discovery step (slug or email domain); the console must handle a user who belongs to several organisations.
- Delegated admin needs no subject mapping: the token's realm is the organisation.

# ADR-0003: The console talks only to the Core API

**Status:** Accepted; superseded in part by ADR-0011 (the workspace's homeserver, for Espace's chat only)
**Date:** 2026-09-02
**Deciders:** the crew (proposal by zôÖma)

## Context
The console needs to create tenants, invite users, verify domains, show invoices, and open support tickets. Each of those touches a different system: Keycloak, Scaleway, DNS, Stripe, Qonto, Zammad, tenant VMs. Calling them from the browser would scatter credentials and authorisation logic across a client that anyone can read.

## Decision
The console has exactly one backend: the Core API in `kodera-server`. Every capability the console needs is an endpoint there, authorised server-side and executed as a job with an audit row where it mutates infrastructure. The console holds only the user's short-lived tokens and no business rule that decides what a tenant may do.

## Options considered
- Direct calls to Keycloak's admin REST API from the console with a delegated token: rejected; it exposes realm-management scopes to the browser and bypasses the audit trail.
- A backend-for-frontend inside this repository: rejected for now; it would duplicate authorisation logic that must live once, in the Core API. Revisit if the API's shape becomes console-hostile.

## Consequences
- The console's end-to-end tests run against a mocked Core API; contract tests between the two repositories keep the mock honest.
- New console features start with a Core API endpoint and its spec.

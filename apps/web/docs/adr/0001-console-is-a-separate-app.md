# ADR-0001: The console is a separate application, not part of the hub

**Status:** Accepted; superseded in part by ADR-0009 (deployment address only)
**Date:** 2026-09-02
**Deciders:** the crew (proposal by zôÖma)

## Context
`kodera-web` is a static, prerendered marketing page on a CDN with no server runtime, no database, and no user model; its sign-in button changes one nav element and nothing else. A customer console is stateful and authenticated: tenants, roles, provisioning status, invoices, domain verification. The hub's tests and prerender checks make it a trustworthy front door; they make it a poor host for an application.

## Decision
The console is its own repository and deployment at `app.kodera.io`. The hub stays static and links into it. The two share the design tokens (one Tailwind token file) and nothing else. The hub's fake "console" mock and its decorative Clerk button are removed once the console exists.

## Options considered
- Grow the console inside the hub: rejected; would throw away a clean landing page to gain nothing, since the hub has no reusable business logic.
- Server-side console inside `kodera-server` (Django templates): rejected; the design bar (Qonto, Revolut) and the FR/EN copy workflow call for a dedicated front-end codebase with its own tests.

## Consequences
- Two front-end codebases share tokens; a token change is a PR in both, guarded by the token test.
- The hub is rehosted in France (Scaleway or Clever Cloud) as part of the sovereignty stance; the console is hosted the same way.

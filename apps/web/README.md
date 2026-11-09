# @kodera/web (`apps/web`)

The customer console of **Kodera**. Its agreed staging and production origins are `https://app.staging.kodera.io` and `https://app.kodera.io`, respectively, both at the root without a deployment prefix. These are deployment targets, not evidence of a deployed Console. This is where an organisation orders a pack, invites its people, manages roles, connects its domain, reads its invoices, sees its status, and asks for help. Built for a non-technical buyer; the design bar is Qonto or Revolut, not an admin panel.

Customer web application (`@kodera/web`) in the Kodera monorepo. Architectural decisions live in [`docs/adr/`](docs/adr/).

## What this repo is

- A React + Vite + TypeScript single-page application, styled with the Kodera design tokens: the `@kodera/design-tokens` package from `kodera-design-tokens`, pinned to a release tag and consumed as a Tailwind preset, never a token file copied in (ADR-0004).
- A client of the **Core API** in `kodera-core` for everything but Espace's chat and audio rooms. Chat talks to the workspace's own Synapse, with the member's own Matrix token (ADR-0011); audio rooms join through LiveKit (ADR-0012). The console never calls Keycloak's admin API, Scaleway, Stripe, Qonto, or any other service on a tenant VM directly (ADR-0003).
- Authentication through Keycloak: tenant admins log in against **their own tenant realm**; Kodera staff use the `kodera-staff` realm (ADR-0002). One login for the CEO, shared by Visio and each application admitted later.

## Administration journeys

| Area | What the customer does |
|---|---|
| Order | Choose pack and tier, accept the DPA (generated per tenant), receive the invoice and a payment link |
| Status | See provisioning progress and, once live, the URLs of every app |
| People | Invite by email or CSV, assign admin or member, remove someone; on-site enrolment via one-time QR token |
| Domain | Connect `visio.acme.fr` with a guided DNS check (TXT nonce, then CNAME or A) |
| Invoices | List, download, pay |
| Support | Open a ticket with tenant context prefilled; see the status banner |
| Federation | Guided setup for Google or Microsoft: exact values and a one-page runbook, with a staff check-in |
| Espace | Read and write in the workspace's text channels; join an audio room |

This table describes administration journeys, not a release commitment. The complete-product scope and release gates are owned by the active internal implementation plan. Real billing, provisioning and account lifecycle operations remain backend dependencies.

## What this repo must never contain

- Secrets of any kind. The console holds only the user's short-lived tokens.
- Business logic that decides what a tenant may do; that lives in the Core API and is enforced there.
- Direct integrations with third-party services. If a feature needs one, the Core API grows an endpoint.
- Analytics or error reporting that captures customer personal data. Error reporting runs with PII scrubbing.

## Development

- Node 22, Vite, TypeScript strict, Tailwind 4, Vitest + Testing Library, Playwright for end-to-end against a mocked Core API.
- Supported browsers: Safari 16.4+, Chrome and Edge 111+, Firefox 128+ — Tailwind 4's floor ([`docs/specs/tailwind-4-migration.md`](docs/specs/tailwind-4-migration.md)).
- Accessibility is a gate: WCAG AA contrast on the token pairs, keyboard navigation on every flow.
- French is the default product language; English second. All copy lives in message catalogues, never inline.
- CI: lint, format, typecheck, unit tests, e2e, visual baselines, Espace against a real Synapse and LiveKit, build, secret scan. Merges require current protected CI, exact-head adversarial review and separate independent CTO verification. There is no standing human reviewer pool; an outstanding requested human review still blocks.
- The frozen stack and its commands are in [`docs/dev/BASELINE.md`](docs/dev/BASELINE.md); testing gates in [`TESTING.md`](docs/dev/TESTING.md), copy rules in [`I18N.md`](docs/dev/I18N.md), the generated Core API client in [`API_CLIENT.md`](docs/dev/API_CLIENT.md).

## Conventions

See [`AGENTS.md`](AGENTS.md). English for code and docs; French only for user-facing copy. Feature branch + pull request, never a direct commit to `main`. One-line commit messages on the why. No attribution trailers.

## Delivery status

Status: Implemented console journeys are tested against a mocked Core API. Home, Order, Status, Invoices and Appearance have specification gates; Aide is implemented. Domain shows the organisation's addresses, read-only, the first slice of its specification; People is implemented against the mocked Core API, and Federation remains a placeholder. Espace (workspace channels, chat, audio rooms) is implemented and runs in CI against a real Synapse and LiveKit; owner claim and invitation acceptance are implemented. The active internal implementation plan owns the remaining product and service work; a passing mock journey does not prove a live customer service.

# Documentation index — kodera-console

**Status:** Accepted · **Owner:** zôÖma

Every document in this repository, what it is for, and who owns it. A new document is added here
in the same pull request that creates it; a document that is not in this table does not exist as
far as review is concerned.

## Decisions — `docs/adr/`

Architecture decision records. One file per decision, numbered, never edited after acceptance
except to change **Status**.

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`adr/README.md`](adr/README.md) | Accepted | zôÖma | Index of the decision records and the rule that governs them |
| [`adr/0000-template.md`](adr/0000-template.md) | Accepted | zôÖma | The template every ADR follows: context, decision, options, consequences |
| [`adr/0001-console-is-a-separate-app.md`](adr/0001-console-is-a-separate-app.md) | Accepted; superseded in part by ADR-0009 (deployment address only) | zôÖma | Separate-application decision remains in force; deployment address superseded by ADR-0009 |
| [`adr/0002-tenant-realm-login.md`](adr/0002-tenant-realm-login.md) | Accepted | zôÖma | Tenant admins authenticate against their own realm; the `kodera-staff` realm is staff-only; MFA is mandatory and SMS is not a factor |
| [`adr/0003-console-talks-only-to-core-api.md`](adr/0003-console-talks-only-to-core-api.md) | Accepted | zôÖma | The console has exactly one backend; no direct call to Keycloak, Scaleway, the payment or banking providers, the ticketing system, or a tenant host |
| [`adr/0004-shared-design-tokens.md`](adr/0004-shared-design-tokens.md) | Accepted | zôÖma | Design tokens as a published package rather than a file copied into two repositories, with the three sync tests that guard it |
| [`adr/0005-routing-and-server-state.md`](adr/0005-routing-and-server-state.md) | Accepted | zôÖma | Typed code-based routes and a query cache own URL and server state |
| [`adr/0006-forms-and-validation.md`](adr/0006-forms-and-validation.md) | Accepted | zôÖma | React Hook Form and zod behind one accessible form boundary |
| [`adr/0007-browser-oidc-client.md`](adr/0007-browser-oidc-client.md) | Accepted | zôÖma | Runtime tenant-realm OIDC through one swappable browser adapter |
| [`adr/0008-tailwind-4-through-the-preset.md`](adr/0008-tailwind-4-through-the-preset.md) | Accepted | zôÖma | Tailwind 4 with the tokens preset loaded unchanged through `@config`; the lagging Tailwind 3 pin lifted |
| [`adr/0009-console-deployment-origins.md`](adr/0009-console-deployment-origins.md) | Accepted | zôÖma | Agreed staging and production Console origins at the root; address-only supersession, not deployment evidence |

## Engineering — `docs/dev/`

How the code in this repository is written, tested, translated, and wired to the Core API.
Written by the engineering-foundation workstream.

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`dev/BASELINE.md`](dev/BASELINE.md) | Proposed | engineering foundation | The frozen stack — Node 22, Vite, TypeScript strict, Tailwind from the shared tokens, Radix primitives copied locally, Storybook — and the project layout that follows from it |
| [`dev/TESTING.md`](dev/TESTING.md) | Proposed | engineering foundation | The test pyramid: Vitest and Testing Library for units, Playwright against MSW for end to end, the accessibility gate, and how the scenario overlays these specs declare are wired in |
| [`dev/I18N.md`](dev/I18N.md) | Proposed | engineering foundation | How the message catalogues in `docs/specs/copy/` become runtime files, the key-parity check, plural and interpolation handling, and the rule that no string is written inline |
| [`dev/DEMO.md`](dev/DEMO.md) | Proposed | engineering foundation | The walkable demo: the one seeded organisation every built screen shares, the `?demo=1` entry point, the six-step script to read while clicking, and the checks that keep the screens agreeing with each other |
| [`dev/API_CLIENT.md`](dev/API_CLIENT.md) | Proposed | engineering foundation | The generated TypeScript client and MSW mocks from the Core API contract, error handling for RFC 9457 problem documents, `Idempotency-Key` and `X-Request-Id`, retry and offline behaviour |

## Product specifications — `docs/specs/`

The screen flows the console implements at launch. Each spec is the contract between product,
design, and the agents that build the screen.

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`specs/README.md`](specs/README.md) | Proposed | zôÖma | How a spec is structured, the eight-state matrix every screen covers, the Playwright-plus-MSW acceptance-test convention, the `console.<area>.<screen>.<key>` message-key convention, the two-level component vocabulary with the delivered design-system names, the three design gaps, and the owner-approved glossary |
| [`specs/00-shell-and-login.md`](specs/00-shell-and-login.md) | Proposed | zôÖma | Realm discovery by email domain or organisation identifier, the multi-organisation switcher, MFA enrolment by passkey or authentication app, the staff realm, session expiry, the delivered six-item sidebar with the switcher and account block inside it, the status banner slot, the help entry |
| [`specs/01-order.md`](specs/01-order.md) | Proposed | zôÖma | The entry condition — an authenticated owner of an organisation that exists, never an organisation created from the order — then ordering a pack and tier from a headcount, contacts and billing details, DPA acceptance with the version recorded, invoice and payment link, the Enterprise quote path |
| [`specs/02-status.md`](specs/02-status.md) | Proposed | zôÖma | The **Applications** screen: provisioning progress in customer language, the application addresses with their fallbacks, the capacity gauge and its upgrade prompt, component health, incidents, seven-day history |
| [`specs/03-people.md`](specs/03-people.md) | Proposed | zôÖma | Invitations by paste or by CSV with per-row partial failure and scoped retry, roles and removal, on-site enrolment sheets with a printable one-time code |
| [`specs/04-domain.md`](specs/04-domain.md) | Proposed | zôÖma | The guided DNS wizard: TXT nonce then CNAME or A, a forwardable instruction sheet, expected-versus-found check results, certificate issuance, the primary-address switch |
| [`specs/05-invoices.md`](specs/05-invoices.md) | Proposed | zôÖma | The invoice list and detail, VAT regimes rendered as issued, one-off payment link with a bank-transfer fallback, the dunning ladder with the customer's own dates |
| [`specs/06-support.md`](specs/06-support.md) | Proposed | zôÖma | The contextual help panel, the ticket form with server-composed and user-editable context, the SLA promise including out of hours, the ticket conversation, the unauthenticated sign-in problem form |
| [`specs/07-federation.md`](specs/07-federation.md) | Proposed | zôÖma | Guided Google and Microsoft setup, rendered as the second tab of Domaine & identité: generated values, a one-page runbook, a write-only secret with the identifier-versus-value guard, the check-in stated as designed, a mandatory test before activation, the automatic-redirect confirmation |
| [`specs/08-home.md`](specs/08-home.md) | Proposed | zôÖma | The **Accueil** dashboard: greeting and health line, capacity gauge with its 90 % marker, next invoice, 30-day availability, the pending-invitations banner and its per-invitation resend, applications, contract and support cards, and the seven contract gaps behind the figures it will not invent |
| [`specs/09-owner-claim.md`](specs/09-owner-claim.md) | Draft | zôÖma | A stub, not gated: the page a claim link lands on, where the intended owner of an organisation the staff intake created verifies their identity and claims first ownership before any order; the states it tells apart, its two Core operations, and the open decisions it waits on |
| [`specs/order-feedback-accessibility.md`](specs/order-feedback-accessibility.md) | Proposed | zôÖma | A supplement to the Order spec: the empty-catalogue message sits at h2 under the plan heading, and the empty and failed catalogue states stay readable and keyboard-operable in narrow portrait, landscape, enlarged-text and long-content layouts |
| [`specs/copy/fr.md`](specs/copy/fr.md) | Proposed | zôÖma | The French message catalogue — the source of truth for meaning — covering every screen, empty state, error and confirmation dialog above |
| [`specs/copy/en.md`](specs/copy/en.md) | Proposed | zôÖma | The English catalogue, translated key for key from the French |
| [`specs/copy/MAPPING.md`](specs/copy/MAPPING.md) | Proposed | zôÖma | The design drop's copy keys mapped onto the catalogue convention, the placeholder normalisation, the drop sections that belong to other surfaces, and the five strings where the catalogue's wording was kept with the reason |

## Tooling migrations

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`specs/vitest-5-migration.md`](specs/vitest-5-migration.md) | Integrated | engineering foundation | Vitest 5 compatibility scope, selected Node runtime and acceptance with refusal proofs |
| [`specs/tailwind-4-migration.md`](specs/tailwind-4-migration.md) | Accepted | engineering foundation | Tailwind 4 with no change in layout, colour or style: plugin choice, supported browsers, every behaviour change and what holds it at Tailwind 3's rendering |

## Repository root

| Doc | Status | Owner | Purpose |
|---|---|---|---|
| [`../README.md`](../README.md) | Accepted | zôÖma | What the console is, the seven launch areas, what the repository must never contain, the milestones |
| [`../AGENTS.md`](../AGENTS.md) | Accepted | zôÖma | The rules that apply to humans and coding agents alike: language, git, product and design bar, boundaries, decisions |
| [`../scripts/check-copy-keys.py`](../scripts/check-copy-keys.py) | Accepted | zôÖma | Checks the two message catalogues against each other and against every key the specifications name: parity, no duplicates, key shape, no missing key |

## Where the rest lives

- **The Core API contract** — `kodera-server/contracts/core-api.openapi.yaml`. The console pins a
  version of it; the generated client and the MSW mocks come from it, and hand-written mock code
  is limited to the scenario overlays each spec declares.
- **Core API conventions, authorisation model, tenant state machine, job catalogue, billing
  model** — `kodera-server/docs/`. The specs here name endpoints and fields; the contract is the
  authority on their exact shape.
- **The design system** — `tokens.json`, the contrast-pair table, `COMPONENTS.md`, `COPY.md` and
  `DESIGN_SYSTEM.md` come from the design workstream's drop and are consumed here through the
  shared token package (ADR-0004). The delivered screens are the visual reference; the component
  and copy tables in that drop are named directly by the specifications, and the three
  primitives it does not define are listed as design gaps in `specs/README.md`.
- **Strategy, pricing, and legal** — the internal pack. Nothing in this repository restates a
  price or a legal clause as fact; the console renders what the Core API returns.

## Changelog

- `specs/tailwind-4-migration.md` and ADR-0008 accepted: Tailwind 4 with the tokens preset
  unchanged and no change in layout, colour or style; the supported-browser floor accepted, and
  two login baselines regenerated for a corner anti-aliasing difference, on the owner's ruling.
- `dev/DEMO.md` added: the walkable demo on one seeded organisation, its entry point and its
  script.
- Accepts and indexes the complete console ADR set after the cross-repository
  identity topology was settled in Core ADR-0006.

- The design drop merged into the specifications: `specs/08-home.md` added for the Accueil
  dashboard, `specs/copy/MAPPING.md` added for the copy key mapping, and the purposes of the
  shell, Applications and Federation rows rewritten to match the delivered information
  architecture.

- Initial version: index covering the decision records, the engineering documents being written
  in parallel, and the launch screen-flow specifications.

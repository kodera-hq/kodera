# Console screen-flow specifications

**Status:** Proposed · **Owner:** zôÖma

These documents are the contract between product, design, and the coding agents that build
`app.kodera.io`. Nothing in the console is written before the screen it belongs to is
specified here, with its states, its Core API calls, its copy keys, and its acceptance tests
(`AGENTS.md`, "Agents build; humans specify and review").

The eight launch areas — Order, Home, Applications, People, Domain, Invoices, Support,
Federation — plus the shell and login, one file each. They are the six items of the delivered
sidebar (Accueil, Applications, Personnes, Domaine & identité, Facturation, Aide), the order flow
an organisation's owner starts from inside the console, and the shell that holds them. A ninth
file, `09-owner-claim.md`, is a draft that is not gated: the page where the intended owner of an
organisation created by the staff intake claims it, which comes before any first order. No
specification describes creating an organisation from the console, because the console does not.

Every "Core API calls" section names paths, parameters, fields and enum values exactly as
`kodera-server/contracts/core-api.openapi.yaml` declares them. Where these specifications and that
file once disagreed, the mapping and the reasoning are recorded in
[`contracts/CONSOLE_RECONCILIATION.md`](https://github.com/kodera-hq/kodera/blob/main/contracts/CONSOLE_RECONCILIATION.md),
which also lists the questions still open for the owner. Read it before adding a call to any spec:
a path invented here is a path that will not exist.

| File | Area | Covers |
|---|---|---|
| [`00-shell-and-login.md`](00-shell-and-login.md) | Shell | Realm discovery, organisation switcher, MFA enrolment, staff realm, session expiry, navigation, status banner, help entry |
| [`01-order.md`](01-order.md) | Order | Entry for an organisation's owner only, pack and tier choice, contacts, DPA acceptance, invoice and payment link |
| [`02-status.md`](02-status.md) | Status | Provisioning progress, app URLs, capacity gauge, component health |
| [`03-people.md`](03-people.md) | People | Invitations by email and CSV, roles, removal, on-site enrolment tokens |
| [`04-domain.md`](04-domain.md) | Domain | Guided DNS wizard: TXT nonce, CNAME or A, certificate, activation |
| [`05-invoices.md`](05-invoices.md) | Invoices | Invoice list, detail, PDF, payment link, dunning state |
| [`06-support.md`](06-support.md) | Support | Ticket creation with tenant context, ticket list, SLA expectations |
| [`07-federation.md`](07-federation.md) | Federation | Guided Google or Microsoft setup, generated values, runbook, test, check-in — rendered as the second tab of Domaine & identité |
| [`08-home.md`](08-home.md) | Home | The Accueil dashboard: capacity gauge, next invoice, 30-day availability, pending-invitations banner, applications, contract and support cards |
| [`09-owner-claim.md`](09-owner-claim.md) | Owner claim | Draft, not gated: the page a claim link lands on, where the intended owner of an organisation the staff intake created claims first ownership before ordering |
| [`10-appearance.md`](10-appearance.md) | Appearance | The theme choice: Automatique (follows the device), light, dark or black, kept in this browser and applied before the first paint; reached from the account menu |
| [`11-workspace.md`](11-workspace.md) | Workspace | The organisation's categories and text channels, a channel's header and empty state, and the setup states before the workspace exists; its own surface, « Espace » on the rail, unreleased until Core serves it |
| [`12-invitation-accept.md`](12-invitation-accept.md) | Invitation acceptance | Draft, not gated: the page an invitation mail links to, where the invited person signs in to the organisation's realm and joins it |
| [`current-token-authority.md`](current-token-authority.md) | Authentication | Credential-generation fencing for `/me`, protected router data and exact current-identity MFA resolution |
| [`copy/fr.md`](copy/fr.md) | Copy | French message catalogue (default language) |
| [`copy/en.md`](copy/en.md) | Copy | English message catalogue |
| [`copy/MAPPING.md`](copy/MAPPING.md) | Copy | Design-drop key → catalogue key, the placeholder normalisation, and the strings where the catalogue's wording was kept |

**Navigation to specification.** Accueil is `08-home.md`, Applications is `02-status.md`,
Personnes is `03-people.md`, Domaine & identité is `04-domain.md` (the "Domaines" tab) together
with `07-federation.md` (the "Connexion (Google / Microsoft)" tab), Facturation is
`05-invoices.md`, and Aide is `06-support.md`. Federation has no navigation item of its own.

---

## 1. How a spec is structured

Every area file uses the same thirteen sections, in this order. A section is never dropped; if
it is genuinely empty, it says "None" and why.

| # | Section | What it must contain |
|---|---|---|
| 1 | **Goal** | One sentence, written from the buyer's side, in the buyer's words. Not a feature list. |
| 2 | **Persona and the "can the CEO do this alone" test** | Who opens this screen, what they know, what they do not know, and a pass/fail statement of the alone test with the reason. |
| 3 | **Entry points** | Every route into the area: navigation item, deep link, email link, banner, empty-state call to action. Each with its URL. |
| 4 | **Screens** | One block per screen: an ASCII wireframe, then the component list using the design-system names. |
| 5 | **State matrix** | The eight states of section 2 below, for every screen, as a table. |
| 6 | **Core API calls** | Method, path, the request fields sent, the response fields read. Nothing the screen does not use. |
| 7 | **MSW scenario overlays** | Named overlays the tests and Storybook need, with the deviation each introduces. |
| 8 | **Validation rules** | Field by field: constraint, when it fires (on blur, on submit), and the copy key of the message. |
| 9 | **Error copy rules** | How this area words failure: cause, then next action. Plus the mapping from API error codes to copy keys. |
| 10 | **Accessibility** | Focus order, keyboard map, live regions, heading outline, anything beyond the baseline. |
| 11 | **Analytics events** | Event name, properties, and the statement that no personal data is carried. |
| 12 | **Acceptance tests** | At least five, Given/When/Then, each with its Playwright test name. |
| 13 | **Out of scope for launch** | What a reader might reasonably expect and will not get. Each item reads "planned after launch", or says it is not planned and why it was excluded by decision. Never a quarter: a date the console cannot hold is a promise it cannot keep. |
| — | **Changelog** | A list at the end of the file, newest first. |

The file opens with `**Status:** Proposed · **Owner:** zôÖma` and closes with the changelog.

### Component names

Screens name components, never HTML, and they name them **twice**: first in the delivered design
system's vocabulary, then in the console primitives that carry them.

**Delivered components** (`design-drop/COMPONENTS.md`, which carries the anatomy, sizes, states
and tokens of each): `Button`, `Text field`, `Status pill`, `Capacity gauge`, `Banner`, `Card`,
`Table`, `Copy-value block`, `Stepper`, `Provisioning timeline`, `Tier card`,
`Empty/loading/confirm`, `Sidebar shell`. Every screen block lists the delivered components it
uses, and a screen that uses none of them is a screen nobody designed.

**Console primitives**, the implementation vocabulary that composes them: `Button`,
`ButtonGroup`, `LinkButton`, `TextField`, `EmailField`, `PasswordField`, `Select`, `Combobox`,
`Checkbox`, `RadioGroup`, `Switch`, `FileDrop`, `Form`, `FieldError`, `Stepper`, `Wizard`,
`Table`, `DataTable`, `Pagination`, `Card`, `PlanCard`, `SummaryPanel`, `Gauge`, `ProgressList`,
`StatusPill`, `Badge`, `Banner`, `InlineAlert`, `Toast`, `CopyableCode`, `CopyableField`,
`Dialog`, `ConfirmDestructive`, `Drawer`, `Tabs`, `Breadcrumb`, `EmptyState`, `Skeleton`,
`Spinner`, `Tooltip`, `DefinitionList`, `Avatar`, `OrgSwitcher`, `HelpEntry`, `QrPanel`,
`DocumentViewer`, `PriceLine`.

A primitive that does not exist in the inventory is a request to the design workstream, marked
in the spec as **new component** with the reason.

### Design gaps

Three primitives the specifications rely on and the delivered design system does not define.
Each is a request back to the design workstream; until it is answered, the specification that
needs it carries its own behavioural description and its own accessibility requirements.

| Primitive | Where it is needed | What is missing |
|---|---|---|
| `QrPanel` | `00-shell-and-login.md` §4.4 (TOTP enrolment), `03-people.md` §4.4 (on-site enrolment sheets) | Anatomy, sizes and quiet-zone rules for a QR image; the pairing with a copyable short code beside it; the text alternative; what it renders when the image fails |
| `ProgressList` | `02-status.md` §4.1 and `08-home.md` §4.1 (provisioning), `05-invoices.md` §4.5 (dunning ladder) | The drop's `Provisioning timeline` covers the running case beautifully; it does not define the **failed** step, the skipped step, or a list with no timestamps, all three of which these screens reach |
| `DocumentViewer` | `01-order.md` §4.3 (reading the Terms and the DPA before accepting) | A scrollable, focusable document region with its own heading outline, a read-progress affordance, and the print and download states |

Two further notes, not gaps but decisions recorded here: the drop's `Tier card` is used only in
the order flow, and the drop's `Sidebar shell` is the whole of the shell's chrome — there is no
separate top bar in the delivered design.

### Glossary — technical term to customer phrase

From `design-drop/COPY.md`, owner-approved, and the authority for these words in both
catalogues. The left column is what the system calls a thing; the right two columns are the only
words a customer ever reads.

| Term | FR | EN |
|---|---|---|
| tenant / instance | votre instance | your instance |
| realm / IdP | la connexion avec vos comptes Google ou Microsoft | sign-in with your Google or Microsoft accounts |
| `max_participants` | participants simultanés, toutes réunions confondues | concurrent participants across all meetings |
| CNAME / TXT | une ligne à ajouter chez votre hébergeur de domaine | a line to add at your domain registrar |
| `fr-par` | hébergé à Paris | hosted in Paris |
| DPA | l'accord de traitement des données (DPA) | the data processing agreement (DPA) |
| provisioning | création de votre instance | setting up your instance |
| SLA credits | crédits en cas d'indisponibilité | credits if we miss our uptime commitment |

Two consequences worth stating, because they overturn earlier rules in this folder:

- **"Instance" is customer vocabulary.** The catalogues used to ban it and write "votre espace".
  The owner-approved copy uses "votre instance" throughout and this glossary makes it the
  customer phrase, so the ban is lifted. Strings written before the drop keep "votre espace",
  which means the same thing; new copy uses "instance".
- **The technical terms on the left may still appear**, but only inside a monospace value the
  customer copies — a `TXT` record type in a table cell — never inside a sentence.

---

## 2. The state matrix every screen must cover

Eight states. A screen that cannot reach a state says "not reachable" and why; it never leaves
a cell blank.

| State | Definition | Rule |
|---|---|---|
| **Default** | Data loaded, the common case. | The state a screenshot in the design file shows. |
| **Loading** | The first fetch has not resolved. | `Skeleton` matching the final layout, never a centred `Spinner` on a full page. A refetch of already-visible data shows a quiet indicator, not a skeleton. |
| **Empty** | The request succeeded and returned nothing. | `EmptyState` with a one-line explanation and exactly one primary action. Never the word "empty". |
| **Error** | The request failed, or a mutation was rejected. | `InlineAlert` at the point of failure, or `Banner` if the whole screen is unusable. Cause, then next action, then a retry affordance. |
| **Success** | A mutation succeeded. | The list or panel updates in place; a `Toast` confirms; the primary action returns to rest. Never a full-page reload. |
| **Partial failure** | A batch or multi-step operation half succeeded. | The successes are shown as done and are **not** re-attempted on retry; the failures are listed by row with their own reason and their own retry. Retry is scoped to the failed subset. |
| **Permission denied** | The caller's role, or their tier, does not allow this. | Role: the action is not rendered at all, and a direct URL shows a `Banner` naming who can do it. Tier: the action is rendered disabled with a `Tooltip` naming the tier and a link to Invoices. Never a raw 403. |
| **Offline** | The browser reports no connection, or every request has failed on the network layer. | A persistent `Banner` in the shell; read-only content already loaded stays visible; submit buttons disable with the reason; the console retries when the connection returns and refreshes the current view. |

Two derived rules that apply everywhere:

- **No colour-only state.** Every status carries a label or an icon as well as a colour.
- **No dead end.** Every error state offers a next step: retry, change something, or open
  support with the context already filled in.

---

## 3. Acceptance-test convention

End-to-end tests are Playwright against MSW. The Core API is never contacted; MSW handlers are
generated from `kodera-server/contracts/core-api.openapi.yaml`, and hand-written code is limited
to **scenario overlays**.

### Layout

```text
e2e/
  00-shell-and-login.spec.ts
  01-order.spec.ts
  ...
  07-federation.spec.ts
mocks/
  generated/              # from the OpenAPI contract, never hand-edited
  overlays/
    shell.session-expired.ts
    order.dpa-unavailable.ts
    status.provisioning-in-progress.ts
    domain.verification-failing.ts
    invoices.overdue.ts
    status.capacity-92.ts
```

### Overlay naming

`<area>.<condition>`, lower-case, hyphenated condition, one file per overlay. The condition is
the world the overlay creates, not the assertion the test makes: `domain.verification-failing`,
not `domain.shows-error`. An overlay is declared in the spec that needs it (section 7) and is
reusable across specs.

A test activates overlays through a helper, never by editing handlers inline:

```ts
await useScenario(page, ['status.provisioning-in-progress', 'shell.single-organisation']);
```

Overlays compose. When two overlays touch the same endpoint the later one wins, and the test
must list them in that order deliberately.

### Test naming

```text
<area>/<screen>: <observable behaviour, present tense, from the user's side>
```

Examples: `order/summary: refuses to submit until the DPA is accepted`,
`domain/verify: explains a missing TXT record and offers to check again`.

Never name a test after the implementation (`calls POST /domains`), never after the state alone
(`error state`). One behaviour per test. The Given/When/Then in the spec maps one-to-one onto
the test body: Given is `useScenario` plus navigation, When is user actions, Then is assertions
on what the user can see.

### Coverage gate

Every spec carries at least five acceptance tests, and among them at least one **error or
partial-failure** test and at least one **keyboard-only** test. Accessibility assertions run
through the axe integration on each screen's default and error states.

---

## 4. Message-catalogue convention

No user-facing string is written inline. Every string is a key in the catalogue, French and
English, and the French file is the source of truth for meaning.

### Key shape

```text
console.<area>.<screen>.<key>
```

- `<area>` — one of `shell`, `login`, `order`, `status`, `people`, `domain`, `invoices`,
  `support`, `federation`, plus `common` for strings genuinely shared across areas.
- `<screen>` — the screen slug used in the spec's section 4, or `_` for area-wide strings.
- `<key>` — dot-free, lower-case, hyphen-separated words, prefixed by its role:

| Prefix | Role | Example |
|---|---|---|
| `title` | Page or section heading | `console.order.summary.title` |
| `subtitle` | Supporting line under a title | `console.order.plan.subtitle` |
| `label` | Field or control label | `console.people.invite.label-emails` |
| `hint` | Help text under a field | `console.domain.verify.hint-ttl` |
| `placeholder` | Input placeholder | `console.login.realm.placeholder-slug` |
| `action` | Button or link text, verb-led | `console.domain.verify.action-check-again` |
| `status` | A state label on a pill or gauge | `console.status.overview.status-running` |
| `empty` | Empty-state body | `console.invoices.list.empty-body` |
| `error` | Error message | `console.domain.verify.error-txt-missing` |
| `warning` | A non-blocking warning | `console.federation.overview.warning-secret-expiring` |
| `confirm` | Confirmation dialog body | `console.people.members.confirm-remove-body` |
| `toast` | Transient confirmation | `console.people.invite.toast-sent` |
| `a11y` | Screen-reader-only text and live-region announcements | `console.status.overview.a11y-progress` |

`common` is the one area with no screens, so its keys are `console.common.<key>` with three
segments; every other area uses all four.

`title`, `action`, `error`, and `confirm` keys are mandatory for any screen that has the
corresponding element. A screen with a destructive action without a `confirm-` key does not pass
review.

### Rules for the strings themselves

- French uses **vouvoiement** throughout, and never addresses the reader as "tu".
- Buttons are **verb-led** and name the outcome: "Envoyer les invitations", not "OK" or
  "Valider".
- Errors state **cause, then next action**, in that order, in one or two sentences.
- Money is written with a no-break space (U+00A0) before the currency sign and a comma decimal
  separator: `5,99 €`, `1 490 €`. English uses `€5.99`.
- Dates are written in full in body copy: `31 décembre 2026` / `31 December 2026`. Tables may
  use the short numeric form. The catalogue carries **format examples only**; the runtime
  formats with `Intl`.
- Interpolation uses named placeholders in braces: `{count}`, `{organisation}`, `{host}`. Plurals
  use ICU `plural` in the catalogue value.
- No product jargon in customer-facing copy: "instance", "realm", "tenant", "provisioning",
  "job" do not appear in French copy. The customer reads "votre espace", "vos comptes",
  "installation en cours".

### Where the catalogues live

`copy/fr.md` and `copy/en.md` in this directory are the specification of the catalogue. The
runtime files (`src/i18n/fr.json`, `src/i18n/en.json`) are generated from them and a CI check
fails when a key exists in one and not the other, or when a key used in code is missing from
both.

`copy/MAPPING.md` maps the design drop's own keys onto this convention, so a string can be
traced from the design file to the runtime key and back.

**Checking the catalogues.** `scripts/check-copy-keys.py` verifies, before any runtime file
exists, that the two catalogues hold the same keys, that no key is defined twice, that every key
matches the shape above, and that every key named in a specification is defined in both
languages. Run it from the repository root:

```sh
python3 scripts/check-copy-keys.py
```

It reports how many defined keys no specification names; that is a count, not a failure, because
a specification often describes a state in prose without naming its key.

---

## 5. Cross-cutting decisions these specs assume

- The console talks only to the Core API (ADR-0003). No screen calls Keycloak's admin API,
  Scaleway, Stripe, Qonto, Zammad, or a tenant host.
- Tenant admins authenticate against their own realm; staff use the `kodera-staff` realm
  (ADR-0002).
- REST conventions from the Core API: `/api/v1/...`, RFC 9457 problem documents whose `type` is a
  **closed registry** the console switches on, cursor pagination, `Idempotency-Key` on every
  `POST` and on no other method, `X-Request-Id` echoed and shown in support tickets, money as a
  `{amount_minor, currency}` object.
- **Resources are addressed by identifier, not by slug.** The browser URL keeps the slug —
  `/{org}/people` reads well and is shareable — and the console resolves it to an
  `organisation_id` once, from `GET /me`. The only slug that reaches the API is the one submitted
  to `POST /auth/discover`, where the caller has nothing else.
- **A collection page carries no total.** `next_cursor` and `has_more` say whether to keep going.
  A screen that genuinely needs a number calls a `count` sub-resource, which has its own rate
  limit; at launch only `memberships/count` exists.
- **The server computes; the console formats.** Totals, VAT amounts, capacity percentages and SLA
  clocks all arrive computed. The console never sums, never divides, and never works out when a
  reply is due.
- Roles are `org_owner`, `org_admin`, `org_billing` and `org_member` on the tenant side, plus
  `staff_operator`, `staff_support` and `staff_security`. The console renders what the role
  allows and the Core API enforces it; the console never decides. `org_billing` reads and pays
  invoices and holds no right over people. Only an owner can change an active membership to or
  from billing or owner; the People specification makes that boundary visible before submit.
- **A capability the pack does not include is read from `entitlements` before it is rendered**, so
  the control is disabled with the name of the pack that unlocks it. A raw `403` is a defect.
- Every screen is judged by "can the CEO of a 120-person construction company do this alone".

---

## Changelog

- Order entry follows the staff-assisted intake: the order flow is described as started by an
  organisation's owner from inside the console rather than as a public flow, and the draft
  owner-claim specification is listed.

- Merged with the delivered design: the eight launch areas and the mapping from the delivered
  sidebar to the specifications, the two-level component vocabulary with the delivered component
  names, the three design gaps, the owner-approved glossary and the two rules it overturns, and
  the copy mapping in `copy/MAPPING.md`.

- Initial version: structure, state matrix, acceptance-test convention, message-key convention.
- Reconciled with the Core API contract: identifier addressing, no totals in a page, server-side
  computation, the four tenant roles, entitlement-driven rendering, and a pointer to
  `contracts/CONSOLE_RECONCILIATION.md`.

# 01 — Order

**Status:** Proposed · **Owner:** zôÖma

**Implementation scope:** the active plan exposes Visio offers only. Docs rows
and examples in this design are retained as future input and MUST NOT become an
available catalogue or selectable order option until the Docs admission gate in
the project roadmap passes.

## 1. Goal

Let an organisation choose the right size of instance, sign the paperwork that its DPO will ask
for, and receive an invoice with a way to pay it — in under ten minutes, without calling anyone.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The CEO, or the office manager acting for them. They know their headcount, their
billing address, their VAT number, and the name of the person who signs. They do not know what
"concurrent participants" means, and they will not read a pricing table that asks them to
convert. Whoever it is holds `org_owner` in an organisation that already exists: they requested
access, staff ran the intake, and they claimed ownership before reaching this flow (§3).

**Alone test: pass**, on four conditions.

1. The tier question is asked in the buyer's unit — **how many people work here** — and the
   console recommends a tier from that, showing the capacity reasoning as a sentence, not a
   formula. The rule, written once here and rendered as a sentence on the screen: the peak is
   about **30 % of the headcount**, and the recommendation is the **first tier whose included
   concurrent participants covers that peak** — rounded up, never down. That tier, and only it,
   carries the "Recommandé · {count} personnes" badge, `{count}` being the headcount entered. When
   no tier covers the peak, no tier is recommended and no card carries the badge: the step
   recommends a quote instead (`console.order.plan.status-recommendation-quote`, "Demander un
   devis"), and the cards stay selectable. Every tier, the largest included, is designed for a
   bounded range, `floor(capacity / 0.3)` at the top. **The top of the largest tier's range is
   the one cutoff** (333 with the launch catalogue, whose largest tier includes 100 participants):
   "Plus de {max} personnes ? Parlons-en.", the quote page's "Au-delà de {max} personnes", the
   wireframe below and the analytics buckets (§11) all read it from the catalogue; none carries a
   number of its own. The buyer can override the recommendation.
2. The DPA is generated for their organisation, readable in the page before acceptance, and
   downloadable as a PDF for the DPO. Acceptance is an explicit checkbox with the version
   recorded, never a pre-ticked box and never buried in a "terms" link.
3. Nothing on the order screen implies the instance appears instantly. The confirmation states
   plainly that the space opens within one business day, and the status screen carries the same
   promise.
4. The annual price is the headline and the monthly price is shown next to it, because that is
   how every price the buyer is comparing against is written.

**Where it still fails.** An organisation that needs a purchase order number before an invoice
can be issued has no field for it in the flow; they use the "billing reference" free-text field
and support checks it. Recorded as a known gap.

## 3. Entry points

**Entry condition.** The order opens only for an authenticated `org_owner` of an organisation that
already exists. Nobody creates an organisation from the order, and no order entry exists before
login. A new customer reaches their first order this way:

1. The buyer requests access. The access request is a person asking for access to Kodera; staff
   review it and run the intake.
2. Staff run the assisted intake. `createOrganisation`, which only `staff_operator` holds, creates
   the organisation in `prospect` with no membership for anyone, staff included.
3. The buyer receives a claim link, signs in to the organisation's own realm with the verification
   it requires, and claims first ownership ([`09-owner-claim.md`](09-owner-claim.md)).
   `consumeOwnerClaim` creates the first `org_owner` membership and moves the organisation to
   `active` in one transaction.
4. The buyer orders, as that organisation's owner, from one of the entries below.

This follows owner decisions B0c and B0d, applied to the console by decision ORG-INTAKE
(`design specification` `plans/complete-mock/README.md`, decision register), and the first-slice
protocol §P1 (`plans/complete-mock/FIRST_SLICE_SPEC.md`), as Core contract 0.11.0 carries them. A signed-in person whose membership is not `org_owner` sees
owner-only guidance instead of the wizard (§12, test 8). A person whose organisation is still
`prospect` holds no membership, so no entry below applies to them; their surface is the claim page
(§12, "Not yet gated").

| Entry | URL |
|---|---|
| From an empty console (organisation active, no subscription) | `/{org}/order` |
| After claiming ownership, the claim page's next step ([`09-owner-claim.md`](09-owner-claim.md), not built) | `/{org}/order` |
| Resume an unfinished order | `/{org}/order/{orderId}` |
| From the capacity gauge at ≥ 90 % (upgrade) | `/{org}/order?upgrade=1&from={currentPlan}` |
| From an expired quote email | `/{org}/order/{orderId}` |
| Enterprise quote, from the `plan` step's "more than {max} people" action (`{max}`: the top of the largest tier's range, §1) | `/{org}/order/{orderId}/quote` |

**Withdrawn entries.** Two entries used to start before login. Neither is part of the decided
sequence (decision register ORG-INTAKE). Whether a public self-service intake exists remains an
open product decision (`FIRST_SLICE_SPEC.md` §P1); this specification assumes none. Each entry has
its own reason:

| Withdrawn entry | Was | Why | Now |
|---|---|---|---|
| From the marketing site pricing page | `/order?plan={code}` | Submitting that order would have had to create the organisation, which the sequence above gives to the staff intake and the owner claim | The access request; the first order starts at `/{org}/order` after the claim |
| From the marketing site "Demander un devis" for Enterprise | `/order?plan=enterprise&mode=quote` | A quote creates a support ticket (§4.5), and `createSupportTicket` has no `anonymous` role: only a signed-in member can send one | The access request; a signed-in member asks for a quote from inside the order (§4.5) |

## 4. Screens

The order is a four-step `Wizard` with a persistent `SummaryPanel`. The step is in the URL
(`/order/{orderId}/plan`, `/contacts`, `/agreements`, `/confirmation`) so a browser refresh and
the back button both behave.

### 4.1 `plan` — size and pack

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  ①Formule  ──  ②Coordonnées  ──  ③Documents  ──  ④Confirmation               │
├───────────────────────────────────────────────┬──────────────────────────────┤
│  Quelle est la taille de votre organisation ? │   Votre commande             │
│  [ 120 ] personnes                            │  ──────────────────────      │
│                                               │   Business                   │
│  Nous recommandons Business.                  │   Visio · 50 participants    │
│  Il est prévu pour 81 à 166 personnes :       │   simultanés                 │
│  environ 30 % de vos équipes en réunion       │                              │
│  en même temps.                               │   Docs         + 99,00 €     │
│                                               │  ──────────────────────      │
│  ┌────────────┐ ┌────────────┐ ┌───────────┐  │   Total       448,00 €/mois  │
│  │ Team       │ │ Business ✓ │ │ Business  │  │   facturé annuellement       │
│  │ 1–80 pers. │ │ 81–166     │ │ Plus      │  │   403,20 €/mois              │
│  │ 134 €/mois │ │ 314 €/mois │ │ 167–333   │  │   soit 4 838,40 €/an HT      │
│  │ annuel     │ │ annuel     │ │ 711 €/mois│  │                              │
│  │ 149 €/mois │ │ 349 €/mois │ │ annuel    │  │   [ Continuer ]              │
│  │ mensuel    │ │ mensuel    │ │           │  │                              │
│  │ [Choisir]  │ │ [Choisi]   │ │ [Choisir] │  │                              │
│  └────────────┘ └────────────┘ └───────────┘  │                              │
│                                               │                              │
│  Plus de 333 personnes ? [ Parler à quelqu'un ]│                             │
│                                               │                              │
│  Options                                      │                              │
│  [x] Docs — documents collaboratifs  +99 €/mois│                             │
│                                               │                              │
│  Paiement                                     │                              │
│  ( ) Mensuel        (•) Annuel — 10 % de moins │                             │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Stepper`, `Text field`
(headcount), `Tier card` ×3 (the recommended one carries the 2 px cobalt border and the
"Recommandé · {count} personnes" pill), `Button` (primary, one per screen), `Empty/loading/
confirm` skeletons.

Console primitives that carry them: `Stepper`, `TextField` (headcount, numeric), `InlineAlert`
(the recommendation sentence), `PlanCard` ×3 as a `RadioGroup` (cards are radio inputs, not
buttons), `LinkButton` (Enterprise → quote), `Checkbox` (add-ons and the non-profit rate),
`RadioGroup` (billing period), `SummaryPanel` with `PriceLine` rows, `Button` (primary
"Continuer"), `Tooltip` on the capacity line.

The recommendation is advisory. Selecting a tier below the recommendation is allowed and shows a
non-blocking `InlineAlert` explaining what happens when the cap is reached.

**Price display rules, from the delivered design.**

- Core's yearly price is the annual total, the amount invoiced. A card never shows it beside
  « /mois ». Billed annually, the headline is the monthly equivalent, the total divided by twelve
  and rounded down to the cent (« 314 € /mois, facturé annuellement »), and the sub-line is the
  total (« soit 3 768 € HT par an »). This division is the one price arithmetic the console does
  (lead's ruling): the grid states its yearly prices that way, and Core's totals are twelve whole
  monthly amounts. Billed monthly, the headline is the monthly price with « /mois » and there is
  no sub-line. The order summary shows the amount invoiced for the period: « Facturé
  annuellement » with the annual total, or « Total mensuel » with the monthly price.
- Every tier the catalogue sells has a card: four (Team, Business, Business Plus, Enterprise)
  stand two by two, then four across once the column holds them; three stand three across.
- A tier sold in one period only (Enterprise, yearly) shows that period's price under either
  setting. Choosing it moves the order to that period, and the other period is disabled with
  « La formule Enterprise est facturée annuellement uniquement. »
- **Docs included.** A plan includes Docs when the catalogue sells its tier with Docs and either
  not without it (Business Plus once Docs ships) or at the same price (Enterprise). For such a
  plan the paid Docs option is not offered: « Docs est inclus dans la formule … : rien à
  ajouter. » stands in its place, the card is priced from the Docs pack and the order takes it.
  Leaving such a plan for one that charges for Docs leaves the option unticked, so nobody pays
  for Docs they did not tick; an option the person ticked themselves stays ticked.
- The order names the plan of the price row the summary shows (`plan_code`, optional in the
  contract), so the plan ordered is the plan the card showed.
- A "Association, ONG, éducation · −15 %" checkbox recalculates every card at once. The
  discounted amount is displayed rounded to the euro — 671,50 € is written 672 € — and the
  console renders whichever price the catalogue returns for that eligibility; it does not apply
  a percentage itself.
- Amounts use the sans face (Plus Jakarta Sans) with tabular figures, through `PlanPrice`, with
  a thin space as the thousands separator and a comma decimal separator, so two cards can be
  compared column by column. No longer monospace: the design system keeps IBM Plex Mono for
  technical values, and in it the euro sign sat a cell away from the number (the P01 reference
  look, `design specification` `design/reference/`).

**Card names and text, from the catalogue.** Each card is one capacity tier, titled by the plan
the catalogue sells it under: the price row's `plan_code` names it, and Core links a plan to a
tier nowhere else, and the match is on the price's `plan_code` and `plan_version`. Tiers
themselves are named « Capacité S » to « Capacité XL »; a card reads its tier's name only if no
listed plan matches. The cards wait for their prices, and the other pack's prices are read
ahead, so ticking Docs never redraws a card under its tier's name. The recommendation
sentence, the card's accessible name and its action name the plan. The plan's `description`
sits under the features, and the card's radio points `aria-describedby` at it; a null or empty
description draws nothing.

### 4.2 `contacts` — who you are

```text
┌───────────────────────────────────────────────┬──────────────────────────────┐
│  Votre organisation                           │   Votre commande             │
│  Raison sociale        [ ACME Construction  ] │   Business + Docs            │
│  Identifiant souhaité  [ acme              ]  │   403,20 €/mois              │
│    votre espace : acme.<domaine>              │   facturé annuellement       │
│  SIREN / n° d'entreprise [ 830485108        ] │                              │
│  N° de TVA (facultatif)  [ FR12830485108    ] │   [ Continuer ]              │
│                                               │                              │
│  Adresse de facturation                       │                              │
│  [ 12 rue des Lilas                         ] │                              │
│  [ 75011 ] [ Paris            ] [ France  ▾ ] │                              │
│  Référence à faire figurer (bon de commande)  │                              │
│  [                                          ] │                              │
│                                               │                              │
│  Contacts                                     │                              │
│  Administrateur   [ marie.dupont@acme.fr    ] │                              │
│  Facturation      [ compta@acme.fr          ] │                              │
│  Sécurité / abus  [ dpo@acme.fr             ] │                              │
│    Ces adresses reçoivent respectivement les  │                              │
│    accès, les factures et les alertes.        │                              │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

Components: `Form`, `TextField` ×8, `Select` (country), `FieldError`, `CopyableField` (the
resulting space address, read-only preview), `SummaryPanel`, `Button`.

The organisation exists before this step: the staff intake recorded its name and slug, and may have
recorded its legal details. The step shows those details from `GET /organisations/{organisation_id}`
as a read-only check: nothing on it creates or changes an organisation, because the order request
carries no organisation field. The legal name, registration and VAT numbers and billing address in
the wireframe are therefore displayed, not edited; a detail that is wrong or missing is changed
outside the order flow, in an organisation settings area that a later specification covers. The
requested identifier, the billing contact and the billing reference remain fields, because the
order request carries them (`tenant`, `billing_contact`). The administrator and security addresses
have no member in `OrderRequest` or in `Organisation` in contract 0.11.0, which is an open contract
gap.

The address preview is `{tenant slug}.{tenant domain}`. Core assigns it: each application's
default URL comes from Core's `KODERA_TENANT_APP_URLS` templates, `https://{slug}.<dns name>`, and
the preview names the domain of the main application's template (`messaging` today). The
console reads the domain at build time from `VITE_TENANT_DOMAIN`, which must carry the same DNS name
(`staging.kodera.io` on staging). Unset or malformed, the field shows no suffix and the hint names
no address (`hint-slug-no-domain`), rather than a domain the tenant will not get.

The requested identifier is the tenant's (`OrderRequest.tenant.slug`), not the organisation's: the
intake reserved the organisation's slug, which names the realm, while the tenant slug is only the
DNS label and the cloud project name (decision register B1). Their lengths: the organisation slug
is 5–20 characters (owner decision SLUG-MIN-ANSWER, which superseded the 2–20 of decision
SLUG-MIN), and the tenant slug is 3–32 characters, a DNS label. Contract 0.11.0 carries exactly
those two rules and no other, spelled as its `pattern` keywords spell them:
`^[a-z0-9][a-z0-9-]{3,18}[a-z0-9](?![\s\S])` on every schema
that names an organisation slug, and `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9](?![\s\S])` on
`OrderRequest.tenant.slug`, `Tenant.slug` and the `slug` parameter of `GET /slug-availability`.
The closing `(?![\s\S])` is not `$`: a JSON Schema pattern matches by search, and `$` would admit
a trailing newline. The form validates the requested identifier with the contract's tenant
pattern itself (§8), so the console cannot refuse a name the API takes or send one it refuses.

### 4.3 `agreements` — the paperwork

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  Documents à accepter                                                (h1)    │
│  Ils sont établis au nom de ACME Construction.                               │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Conditions générales de vente          v2.1   [ Lire ] [ PDF ]         │  │
│  │ Contrat de sous-traitance (RGPD)       v1.4   [ Lire ] [ PDF ]         │  │
│  │   Annexe C — sous-traitants                    [ Lire ]                │  │
│  │ Engagement de service (SLA)            v1.2   [ Lire ] [ PDF ]         │  │
│  │ Charte d'usage                         v1.0   [ Lire ] [ PDF ]         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌── Lecture ──────────────────────────────────────────────────────────────┐ │
│  │ Contrat de sous-traitance — ACME Construction                          │ │
│  │ 1. Rôles des parties …                                                 │ │
│  │ (le document s'affiche ici, défilable)                                 │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  [ ] J'accepte les quatre documents ci-dessus au nom de ACME Construction.   │
│      Signataire : Marie Dupont · marie.dupont@acme.fr                        │
│                                                                              │
│  [ Valider la commande ]                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

Components: `Table` (documents, version, actions), `DocumentViewer` (**new component**: a
scrollable, focusable document region with its own heading outline), `Checkbox` (single
acceptance covering the listed versions), `DefinitionList` (signatory), `Button` (primary,
idempotent submit), `InlineAlert`.

The checkbox is never pre-ticked. Its label names the organisation. The accepted versions are
sent with the acceptance so that a later version cannot be attributed to this signature.

### 4.4 `confirmation`

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  ✅ Commande enregistrée                                             (h1)    │
│  Votre espace sera ouvert sous un jour ouvré. Nous vous écrivons dès         │
│  qu'il est prêt.                                                             │
│                                                                              │
│  Facture F-2026-0142            4 838,40 € HT                                │
│  [ Télécharger la facture ]     [ Payer en ligne ]                           │
│  Ou par virement : les coordonnées figurent sur la facture.                  │
│                                                                              │
│  Pendant ce temps                                                            │
│  → Préparez la liste de vos collaborateurs (modèle CSV)                      │
│  → Réservez votre adresse : visio.acme.fr                                    │
│                                                                              │
│  [ Aller à l'état de mon espace ]                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

Components: `Card`, `DefinitionList`, `Button` (download invoice), `Button` (payment link, opens
the PSP page in a new tab), `LinkButton` ×2 (next steps), `Banner` (if the payment link could not
be created).

**People preparation is available** after successful confirmation at
`/{org}/people/import?from=order`, using the existing collaborators-list catalogue key.
The standalone component requires an explicit owner or administrator role; the order route
remains owner-only. Domain setup stays withheld while that area is read-only. The subtitle
(`console.order.confirmation.subtitle`) remains « Nous vous écrivons à chaque étape. »
When the order cannot be read, the banner's
"Nous écrire" opens Aide with `topic=order` ([`06-support.md`](06-support.md) §4.0), not a bare
e-mail link.

### 4.5 `quote` — Enterprise path

A short form (headcount, country, needs, contact) that creates a support ticket of type `sales`
and shows the expected response time. No prices are shown; Enterprise discounts are never
published.

It is reached from the `plan` step by a signed-in caller. The console has no public quote form: a
prospective customer with no organisation uses the access request instead (§3, withdrawn entries).

Components: `Form`, `TextField`, `Select`, `Button`, `Card` (response-time promise).

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `plan` | Recommendation + three cards | `Skeleton` cards while the catalogue loads | Visible existing plan title + "Les formules sont momentanément indisponibles" + support | Visible existing plan title + full-panel error with retry | Selection persisted to the draft order | n/a | Only `owner` may order; a `member` sees the read-only summary and "Demandez à votre responsable" | Banner; cards readable from cache, "Continuer" disabled |
| `contacts` | The organisation's details as the intake recorded them, read-only; the identifier, billing contact and billing reference editable | `Skeleton` fields | n/a | Field errors inline; slug already taken → field error with three suggestions | Draft saved on blur, step advances | n/a | Same as `plan` | Banner; the draft is kept in memory and saved when the connection returns |
| `agreements` | Four documents, checkbox unticked | `Skeleton` rows + viewer skeleton | n/a | A document fails to render → row shows "Impossible d'afficher" + PDF link + the checkbox stays disabled for that document set | Order submitted → `confirmation` | Acceptance recorded but the invoice could not be issued → order is `accepted`, confirmation shows "Facture en préparation" and no payment button | Same as `plan` | Banner; the submit button is disabled with the reason |
| `confirmation` | Invoice + payment link | `Skeleton` invoice block | n/a | Order lookup fails → "Votre commande est enregistrée" + support link with the order reference | n/a | Invoice present, payment link missing → invoice download shown, payment replaced by transfer instructions and a retry | Direct link to another organisation's order → 404 | Banner; downloads queued |
| `quote` | Empty form | — | n/a | Submit fails → retry + the support address fallback (support@kodera.io, `src/app/supportContact.ts`) | Ticket reference shown | n/a | Any authenticated role may ask for a quote | Banner |

**Resume rule.** A draft order is created on the first change on `plan`. Returning to `/order`
with a draft in progress resumes at the furthest step reached, with a `Banner` saying so and a
"Recommencer" action.

## 6. Core API calls

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/catalog/packs` | `cursor`, `limit` | `data[]{ code, name, apps[], description_key, available }` |
| `GET` | `/api/v1/catalog/plans` | `cursor`, `limit` | `data[]{ code, version, name, description, state, packs[] }`; a card's plan is the one its price row names, by `plan_code` and `plan_version` (§4.1) |
| `GET` | `/api/v1/catalog/capacity-tiers` | `cursor`, `limit` | `data[]{ code, max_participants, storage_included_bytes, designed_for }` |
| `GET` | `/api/v1/catalog/prices` | `pack_code`, `billing_period` | `data[]{ id, plan_code, plan_version, pack_code, capacity_tier_code, billing_period, amount_excl_vat{ amount_minor, currency } }` |
| `GET` | `/api/v1/organisations/{organisation_id}` | — | `id, slug, name, legal_name, state, siren, vat_number, country, billing_email, billing_address` |
| `GET` | `/api/v1/slug-availability` | `slug` | `slug`, `available`, `reason: taken\|reserved\|invalid_format`, `suggestions[]` |
| `GET` | `/api/v1/legal-documents` | `pack_code`, `locale` | `data[]{ code: cgv\|dpa\|sla\|aup, version, locale, title, html_url, sha256, download{ url, expires_at } }` |
| `POST` | `/api/v1/organisations/{organisation_id}/dpa` | `Idempotency-Key`; `pack_code`, `locale` | `id, version, state, sha256, sub_processors[]{ name, role, location, country }, annexes[]` |
| `GET` | `/api/v1/organisations/{organisation_id}/dpa/{dpa_id}/pdf` | — | `url, expires_at, content_type, filename, sha256` |
| `POST` | `/api/v1/organisations/{organisation_id}/orders` | `Idempotency-Key`; `pack_code`, `capacity_tier_code`, `billing_period`, `plan_code?`, `tenant{ slug, name, locale }`, `dpa_acceptance{ dpa_id, accepted, accepted_by_name, accepted_by_role }`, `billing_contact{ email, name, purchase_order_ref }`, `notes?` | `order{ id, state, price_snapshot{…} }`, `subscription{…}`, `tenant{ id, slug, status }`, `invoice{ id, number, total_incl_vat, state }`, `payment_link{ url, expires_at }`, `dpa{…}`, `billing_pending` |
| `GET` | `/api/v1/orders/{order_id}` | — | `id, state, pack_code, capacity_tier_code, billing_period, price_snapshot{…}, dpa_id, subscription_id, invoice_id, tenant_id, purchase_order_ref` |
| `POST` | `/api/v1/invoices/{invoice_id}/payment-link` | `Idempotency-Key`; `return_url`, `locale` | `id, url, state, amount{ amount_minor, currency }, expires_at` |
| `POST` | `/api/v1/support/tickets` | `Idempotency-Key`; `category: other`, `severity: question`, `subject`, `body`, `locale` | `id, state, category, severity, sla{ first_response_target_minutes, first_response_due_at }, external_ref` |

Notes.

- **The order never creates an organisation.** No call above creates one: the organisation-scoped
  calls name an organisation that exists, and `placeOrder` requires it. `createOrganisation` is the
  staff intake and the console never calls it (`CONSOLE_RECONCILIATION.md` §3.9); first ownership
  comes from `consumeOwnerClaim`, on the page [`09-owner-claim.md`](09-owner-claim.md) specifies.
- **The order is one transaction and there is no server-side draft.** The wizard's state lives in
  the browser until the person presses the last button; `POST /organisations/{id}/orders` then
  writes the order, the subscription, the DPA acceptance, the tenant row and the invoice together
  and returns all of them.
- **Submission is held, except where the first-owner journey is built in.** That means
  `VITE_FIRST_OWNER_JOURNEY`, off by default (`src/features/order/submission.ts`). There the order
  carries `legal_acceptances` (contract 0.17.0): the exact CGV, SLA and AUP versions the person
  accepted. Retries follow these rules:
  - The order's `Idempotency-Key` and the exact body sent with it live in memory for the
    page's life (`submission.ts`), never in the saved draft.
  - An uncertain result (no answer, a 5xx, `409 idempotency-key-in-flight`) does not prove no
    commit. A retry resends that same body under that same key; Core replays a committed order
    instead of placing another.
  - A refusal (4xx) is stored by Core under its key, so the corrected request gets a new key and
    a new body. The new body needs a new acceptance.
  - **An order may already exist** when Core answers `409 slug-taken`, `409 idempotency-key-reuse`
    or `422` `dpa_already_accepted`. The page then sends nothing more and says « Une commande
    pourrait déjà avoir été envoyée », with the support address. It never suggests another slug.
    Reconciliation is a person's job, not a new purchase.
  - **One order in flight per organisation** (contract 0.20.0). While another order is `placed` or
    `awaiting_payment`, Core refuses with `409 order-in-progress`. Nothing was placed: the page
    drops the key, reads the organisation's orders again (which stops it, as below), and says
    « Une commande existe déjà pour cette organisation. Contactez-nous », with the support
    address. Support settles it: the
    page's own rule still stops on any order but a `cancelled` one, broader than Core's, which
    lets a `paid` order hold nothing; and cancelling waits for credit notes.
  - A reload loses the key and body, and the draft stays editable. So before any new order, the
    page reads the organisation's orders (`listOrders`). A live one, meaning any state but
    `cancelled`, stops the page with « Une commande existe déjà pour cette organisation.
    Contactez-nous », with the support address: one order per organisation for now (lead's
    ruling; a second tenant is a later feature). An unread list sends nothing. Only a
    pending exact retry passes, since Core replays it if it committed.
  - A version no longer in force (`422`, `/legal_acceptances`, `*_not_in_force`) re-reads the
    documents and clears the acceptance. A DPA no longer in force (`dpa_not_in_force`,
    `dpa_other_pack`) is generated again, and the acceptance tick is bound to the DPA's id too.
  - Only after the order does the confirmation offer « Créer votre espace de travail ». Core
    refuses `initialiseWorkspace` before an order whose DPA is accepted.
- Acceptance of the DPA is a member of the order body, not a call after it: no processing begins
  before it is recorded. `dpa_acceptance.dpa_id` names the exact document version the person read,
  and the server records the clock, the IP and the user agent itself.
- `billing_pending: true` means the invoice or the payment link is still being created upstream.
  It is **not** an error: the confirmation screen says the invoice is on its way.
- **The order does not start provisioning.** `tenant.status` comes back `ordered`; the tenant moves
  to `provisioning` when a Kodera operator releases it. The confirmation copy must not promise
  otherwise — see the open question in the reconciliation document.
- Amounts are minor units with an explicit `currency`; the console formats, it never computes a
  total. Every total on the summary is `price_snapshot`'s, and it is frozen at that instant.
- The VAT sentence is rendered from `vat_regime` through the message catalogue, so the French and
  English summaries match the French and English invoice.
- Payment links are created by the Core API against the payment provider, on the **invoice**; the
  console holds no provider key (ADR-0003).
- **The recommendation is computed from the catalogue, not from a recommendation endpoint.** The
  console reads `capacity-tiers[].concurrent_participants_included` and applies the 30 % rule
  above. It is the one arithmetic the console is allowed to do, because it is advice about a
  purchase and not a figure presented as measured; the sentence on screen states the rule so the
  buyer can check it.

**Contract gaps.** Two things the delivered design shows and the contract does not carry. Neither
is invented as a path here.

| What the design asks for | Why the contract cannot answer it today | What the screen does meanwhile |
|---|---|---|
| **Non-profit rate, −15 %** | `Price` carries `amount_excl_vat` per plan, pack, tier and period, with no eligibility dimension and no discount field, and `OrderRequest` has nowhere to declare it | The checkbox is rendered, the discounted figure is not: the summary keeps the catalogue price and the confirmation says the reduction is applied on the invoice after eligibility is checked |
| **Event pack, 690 €** | No add-on or one-off line exists in `OrderRequest` or `Price` | Not offered in the order; `05-invoices.md` records it as a support request at launch |

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `order.catalogue-default` | Three packs available, Docs included in two, Enterprise quote-only |
| `order.catalogue-unavailable` | Capacity-tier read answers the declared internal-error; owner sees the plan title, existing error and retry |
| `order.catalogue-empty` | Capacity-tier read succeeds with an empty collection; owner sees the plan title and existing support sentence |
| `order.slug-taken` | `slug-availability` returns `available: false`, `reason: taken`, three `suggestions[]` |
| `order.dpa-unavailable` | `legal-documents` returns one row whose `html_url` answers `502` |
| `order.submission-conflict` | The first `orders` call times out; the retry with the same key replays the original `OrderResult` with `Idempotency-Replayed: true` |
| `order.invoice-deferred` | `orders` succeeds with `invoice: null`, `payment_link: null` and `billing_pending: true` |
| `order.payment-link-failed` | `invoices/{invoice_id}/payment-link` returns `502` `upstream-unavailable` |
| `order.tenant-stays-ordered` | `OrderResult.tenant.status` is `ordered` and stays there through three polls |
| `order.member-role` | Caller has `role: member`; ordering is refused with `forbidden` |
| `order.upgrade-from-business` | An active subscription exists; the flow shows proration text and only larger capacity tiers |

## 8. Validation rules

| Field | Rule | When | Copy key |
|---|---|---|---|
| Headcount | Integer 1–100 000 | On blur | `console.order.plan.error-headcount-range` |
| Plan | One selected | On submit | `console.order.plan.error-plan-required` |
| Legal name | 2–120 characters | On blur | `console.order.contacts.error-name-required` |
| Requested slug | The contract's tenant slug pattern, `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9](?![\s\S])`: 3–32 characters, a DNS label — lowercase letters, digits and hyphens, no leading or trailing `-`, consecutive hyphens admitted. A value that fails it is never sent to `slug-availability`, whose `slug` parameter carries the same pattern and refuses anything else with `malformed-request` | On blur | `console.order.contacts.error-slug-format` |
| Non-profit rate | A checkbox only; eligibility is verified by a human before the invoice is issued, never by the form | On submit | `console.order.plan.hint-ngo-verified` |
| Requested slug | Available | Server, debounced 400 ms on blur | `console.order.contacts.error-slug-taken` |
| Registration number | Required; 9 digits when country is France | On blur | `console.order.contacts.error-registration-required` |
| VAT number | Optional; when present, matches the country prefix and is checked server-side | On blur | `console.order.contacts.error-vat-format` |
| Address line 1, postal code, city, country | Required | On blur | `console.order.contacts.error-address-required` |
| Admin email | Required, valid, and not a role-less free-mail address is **not** enforced (many buyers legitimately use one) | On blur | `console.order.contacts.error-email-format` |
| Billing email | Required, valid | On blur | `console.order.contacts.error-email-format` |
| Security email | Required, valid | On blur | `console.order.contacts.error-email-format` |
| Billing reference | Optional, ≤ 60 characters | On blur | `console.order.contacts.error-reference-length` |
| Acceptance checkbox | Ticked | On submit | `console.order.agreements.error-acceptance-required` |
| Document versions | The versions shown are the versions submitted; a mismatch reloads the list | Server | `console.order.agreements.error-version-changed` |

On the `contacts` step the legal name, registration number, VAT number and address rules do not
fire: those details are a read-only check there (§4.2). The rules are kept for the organisation
settings specification that will take them.

## 9. Error copy rules

Cause then next action. Money and legal wording is never softened: an error about VAT says which
field is wrong, not "une erreur est survenue".

| Problem `type` suffix, or condition | Copy key | Next action offered |
|---|---|---|
| `slug-availability` returns `available: false` | `console.order.contacts.error-slug-taken` | The `suggestions[]` as buttons |
| `conflict` on `orders`, `detail` naming the slug | `console.order.contacts.error-slug-taken` | Same, after re-checking availability |
| `order-in-progress` on `orders` | `console.order._.error-order-exists` | Write to support, who settle or cancel the order in flight |
| `legal-documents` row unreachable | `console.order.agreements.error-document-unavailable` | Download the PDF, or retry |
| `conflict` on the DPA `sha256` | `console.order.agreements.error-version-changed` | Reload the documents (one button) |
| `unprocessable-entity` on `pack_code` or `capacity_tier_code` | `console.order.plan.error-plan-unavailable` | Choose another tier, or ask for a quote |
| `validation-failed` with `errors[].pointer` `/vat_number` | `console.order.contacts.error-vat-invalid` | Correct it, or leave it empty and pay French VAT |
| `billing_pending: true` | `console.order.confirmation.error-invoice-deferred` | Nothing to do; the invoice arrives by email; support link |
| `upstream-unavailable` on the payment link | `console.order.confirmation.error-payment-link` | Pay by transfer using the invoice, or retry |
| `dpa-not-accepted` | `console.order.agreements.error-acceptance-required` | Return to the agreements step |
| `forbidden` | `console.order._.error-role`, or `console.order._.error-role-generic` when the owner has no name and Core withholds their address from the caller | Name the owner to ask, or say whom to ask |
| `idempotency-key-reuse` | `console.common.error-unavailable` | Keep submission held and the previous outcome unresolved. Do not infer no commit or start another purchase after reload. Retain an already available original key/body for reconciliation; do not reconstruct a lost tuple or add persistence. Use authoritative readback of a known order reference when available, or contact support. |

## 10. Accessibility

- The `Stepper` is a `nav` with an ordered list; the current step carries `aria-current="step"`.
  Steps already completed are links; future steps are not focusable.
- **Step change.** Each step is a route. When the step changes, keyboard focus moves to the new
  step's own title, its visible `h1`, and the step is announced once, by the wizard's polite
  region: « Étape 2 sur 4 : Organisation. » (`console.order._.a11y-step-announcement`). The
  console's page announcement says nothing for a step
  ([`00-shell-and-login.md`](00-shell-and-login.md) §10). Entering the order from another area is
  announced as a page, « Page Commander votre instance chargée. », with focus on the step's
  title. Every order screen also carries the flow's name in a visually hidden `h1`; it never
  takes focus. The quote request (§4.5) is not a step of the wizard, which is not drawn there:
  going to it and coming back are announced as a page.
- Plan cards are a real `RadioGroup`: `↑`/`↓`/`←`/`→` move between them, `Space` selects, the
  group has a legend, and the price and capacity of each card are inside the accessible name or
  its description, not colour-coded.
- The recommendation sentence is in a polite live region: changing the headcount announces the
  new recommendation once, debounced 600 ms.
- `SummaryPanel` is an `aside` labelled "Votre commande"; total changes are announced politely.
- `DocumentViewer` is a labelled `region` with `tabindex="0"` so it can be scrolled by keyboard;
  its internal headings continue the page outline at `h3`.
- **Focus order (`agreements`):** page `h1` → document table (each row: title, "Lire", "PDF") →
  document viewer → acceptance checkbox → submit. Opening a document with "Lire" moves focus to
  the viewer's heading and does not scroll the page away from the table.
- Submit shows a busy state (`aria-busy`), keeps its accessible name, and never becomes a
  spinner-only control.
- Price formatting uses a no-break space before `€`; screen readers get the currency spelled in
  the accessible description of the total.
- Errors move focus to the first invalid field on submit and the field is described by its error
  via `aria-describedby`.

## 11. Analytics events

No personal data: no names, no emails, no addresses, no company name, no slug.

| Event | Properties |
|---|---|
| `order_started` | `entry` (`console` \| `upgrade`) |
| `order_headcount_entered` | `bucket`: the catalogue tier whose range (§1) holds the headcount, by tier code, or `above-largest` past the top of the largest tier's range (333 with the launch catalogue). Never a hard-coded bound |
| `order_recommendation_shown` | `recommended_plan` |
| `order_plan_selected` | `plan`, `matches_recommendation` (bool), `billing_period` |
| `order_addon_toggled` | `addon`, `enabled` |
| `order_step_completed` | `step` (`plan` \| `contacts` \| `agreements`) |
| `order_slug_rejected` | `reason` (`format` \| `taken`) |
| `order_document_opened` | `document` (`cgv` \| `dpa` \| `sla` \| `aup`) |
| `order_submitted` | `plan`, `billing_period`, `addon_count` |
| `order_submission_failed` | `reason` |
| `order_payment_link_opened` | `method` |
| `order_quote_requested` | `headcount_bucket` |

## 12. Acceptance tests

1. **Given** the default catalogue (`order.catalogue-default`),
   **when** the buyer enters 120 people,
   **then** Business is recommended with a sentence explaining the 81–166 range, Business is
   pre-selected, and the summary shows the annual monthly price as the headline with the monthly
   price beside it.
   `order/plan: recommends a tier from headcount and headlines the annual price`

2. **Given** a buyer on the contacts step and a slug that is taken (`order.slug-taken`),
   **when** they leave the identifier field,
   **then** the field explains that the identifier is already used and offers three alternatives
   that fill the field when chosen.
   `order/contacts: rejects a taken identifier and offers alternatives`

3. **Given** available legal documents, **when** the buyer reaches agreements,
   **then** documents remain readable and purchase submission is visibly held.
   `order/agreements: holds submission while legal documents remain readable`

4. **Given** an unavailable DPA document, **when** the buyer opens it,
   **then** its failure is shown and acceptance remains disabled.
   `order/agreements: blocks acceptance when a document cannot be shown`

5. **Given** the approved purchase hold, **when** documents are accepted,
   **then** no order request is sent and no purchase retry key is generated.
   `order/agreements: does not send a purchase or allocate a retry key during the hold`

6. **Given** a legacy record that may refer to a submitted purchase,
   **when** the buyer returns, **then** its fields are not restored and its
   outcome remains held for reconciliation without changing its old key.
   `order/recovery: holds a legacy possible purchase without restoring its fields`

7. **Given** a validated owner's editable record, **when** silent SSO and a fresh
   Core ownership check complete after reload, **then** that owner's fields resume
   and purchase submission remains disabled.
   `order/recovery: resumes only the same owner editable fields after reload`

8. **Given** a fresh non-owner membership, **when** the caller opens ordering,
   **then** owner-only guidance is shown and no editor or DPA generation mounts.
   `order/plan: shows a member who can place the order instead of a form`

9. **Given** a keyboard-only buyer, **when** they prepare a draft and review its
   documents, **then** the controls remain keyboard accessible and the final
   purchase stays visibly disabled.
   `order/wizard: prepares a held draft with the keyboard alone`

10. **Given** a buyer on the plan step, **when** they continue to the next step with the
    keyboard, **then** focus is on that step's visible title, and the step is announced once, as
    « Étape 2 sur 4 : Organisation. », with no page announcement beside it.
    `order/wizard: announces a step once and moves focus to its visible title`

11. **Given** a signed-in owner with no tenant and a failed catalogue read,
    **when** they follow Commander from Home and the document's silent mock sign-in completes,
    **then** the existing plan title remains a visible h1 above the existing error and retry,
    the hidden flow title is not focused, and no plan or Continue action is offered.
    `order/plan: keeps a visible heading after a catalogue failure`

12. **Given** a signed-in owner with no tenant and a successful empty catalogue,
    **when** they follow Commander from Home and the document's silent mock sign-in completes,
    **then** the existing plan title remains a visible h1 beside the existing support sentence,
    the hidden flow title is not focused, and no retry, plan or Continue action is offered.
    `order/plan: keeps a visible heading with an empty catalogue`

The original final-submit/retry and invoice/payment confirmation journeys remain
future acceptance for the separately reviewed immutable-intent slice. Existing
confirmation component tests still cover their synthetic rendering states; they
are not proof of a currently enabled purchase workflow. This integration does not
promise completed orders, duplicate-free retries or cross-logout recovery.

None of the twelve tests above is withdrawn by the intake decision: each runs as a signed-in owner,
or a signed-in member who is not the owner, of an organisation that exists, which is the entry
condition of §3.

### Not yet gated — entry after the owner claim

These scenarios apply once the claim page ([`09-owner-claim.md`](09-owner-claim.md)) exists. They
are specifications, not declarations: each proposed test name sits inline after its scenario, not
on a line of its own, so `scripts/check-spec-tests.py` does not read it. A scenario moves into the
numbered list above, with its name on its own line, in the pull request that lands its test; the
same pull request adds `claim` to the `entry` values of `order_started` (§11).

- **A. Given** a person whose `consumeOwnerClaim` has just answered `200`, so the organisation is
  `active` and they hold `org_owner`,
  **when** they continue from the claim page,
  **then** the order opens at `plan` for that organisation after a fresh `/me` ownership check, and
  no field offers to create an organisation.
  Proposed name: `order/entry: opens the plan step for the owner who has just claimed the organisation`

- **B. Given** a person signed in to the realm of an organisation still in `prospect`, holding no
  membership,
  **when** they open `/{org}/order` directly,
  **then** neither the wizard nor a DPA request mounts, and they are pointed to their claim link
  rather than shown an error.
  Proposed name: `order/entry: points a person who has not claimed ownership to the claim instead of the wizard`
  Depends on [`09-owner-claim.md`](09-owner-claim.md) open question 4. In contract 0.11.0 the console
  cannot yet recognise such a person: `getMe` does not admit the `bootstrap` principal and requires
  an active membership, and the bootstrap view is addressed by `organisation_id` while this route
  carries a slug.

- **C. Given** no session,
  **when** a withdrawn public entry such as `/order?plan=business` is opened,
  **then** no order form renders and nothing on the page offers to create an organisation.
  Proposed name: `order/entry: offers no order and no organisation creation before login`

## 13. Out of scope for launch

- Self-serve payment method (card on file, SEPA mandate) and recurring collection (planned after launch).
- Proration and mid-term plan changes computed in the console; upgrades at launch are a quote
  and a manual invoice; a subscription engine is planned after launch.
- Electronic signature of the order form inside the console; Yousign is used out of band.
- Unattended provisioning on payment: at launch an operator triggers provisioning; unattended provisioning is planned after launch.
- Credit notes and refunds in the console.
- A VIES lookup shown live in the field; the check is server-side and asynchronous at launch.
- Multi-currency: euros only.
- Starting an order before an organisation exists, from a public page or before login. Not planned:
  it is not part of the decided sequence (decision register ORG-INTAKE), in which the staff intake
  creates the organisation and the intended person claims first ownership (§3). Public self-service
  intake remains an open product decision (`FIRST_SLICE_SPEC.md` §P1); if it is taken, this item is
  revisited.

## Changelog

- An organisation that already has an order is told so plainly, « Une commande existe déjà pour
  cette organisation. Contactez-nous », on the agreements step and on `409 order-in-progress`.
  « Une commande pourrait déjà avoir été envoyée » stays for an outcome the page cannot know.
- Contract 0.20.0: `409 order-in-progress` on `placeOrder` has its own sentence (§6). The order
  cancellation action waits for credit notes in Core: until then every cancel answers
  `409 invoice-issued`.
- The plan step shows Core's yearly price, the annual total, as a monthly equivalent billed
  annually with the total under it; draws all four tiers; does not sell Docs as a paid option on a
  plan that includes it; and the order names its plan (§4.1).
- The plan cards (§4.1) are titled by the catalogue's plan and carry its description; amounts use
  `PlanPrice`, the sans face with tabular figures, instead of monospace.
- Submission opens behind `VITE_FIRST_OWNER_JOURNEY` (§6), against contract 0.17.0's `placeOrder`
  with `legal_acceptances`. The default build keeps the hold, and its acceptance tests 4 and 5
  are unchanged. The first-owner journey test covers the whole path, from claim to order to
  workspace. `AgreementsStep.submission.test.tsx` covers the request and each retry and refusal.

- Restore the People preparation link on successful confirmation with explicit role and
  organisation routing. Domain setup stays withheld; payment and support behavior is unchanged.
- Step change (§10): focus goes to the step's visible title and the wizard's « Étape n sur 4 » is
  the one announcement (owner decision). The console's page announcement used to speak beside it,
  as « Page Console chargée. », with focus on the hidden « Commander votre instance ».
  Acceptance test 10.

- Confirmation: the "Pendant ce temps" links (collaborators list, address) are withheld until
  People and Domain ship, the subtitle drops its promise that colleagues can already be invited, and the order-unavailable "Nous écrire" opens Aide with `topic=order`
  (, owner ruling).

- Journey fixes: when no tier covers the peak, no tier is recommended and the step recommends a
  quote; the largest tier is given its real upper bound instead of "et plus"; the badge counts the
  buyer's headcount, not the tier's capacity.
- The cutoff past which the order is a quote is the top of the largest tier's range, computed from
  the catalogue (333 today): the plan step's link, the quote page's subtitle, the wireframe and
  the headcount analytics bucket no longer carry a hard-coded 330, and the wireframe's ranges are
  the ones the 30 % rule computes. Acceptance test 1 names the computed 81–166; its name is
  unchanged. The quote fallback address is the console's one support address.

- Follows Core contract 0.11.0. The organisation slug is 5–20 characters (owner decision
  SLUG-MIN-ANSWER), no longer 2–20, and §4.2 states it. The tenant slug rule, 3–32, which the
  requested identifier is validated with, is unchanged.

- Follows Core contract 0.10.0. The contract now carries one organisation slug rule (2–20, the
  realm name) and one tenant slug rule (3–32, a DNS label); §4.2 and §8 state them from the
  contract rather than as figures awaiting alignment, and the requested identifier is validated
  with the contract's tenant pattern, which admits consecutive hyphens the form used to refuse.
  A malformed identifier is not sent to `slug-availability`, whose parameter refuses it. `placeOrder`
  admits `org_owner` only — staff assistance ends at the intake — which §7's `order.member-role`
  already shows as the `forbidden` refusal.

- Order entry follows the staff-assisted intake (owner decisions B0c and B0d, decision ORG-INTAKE):
  the two pre-login entries are withdrawn, each with its own reason, the order opens only for an
  authenticated owner of an organisation that exists, the contacts step shows that organisation's
  details as a read-only check and creates or changes none, the slug lengths cite decision SLUG,
  `order_started.entry` loses `pricing`, and the entry after the owner claim is recorded as three
  not-yet-gated scenarios beside the draft `09-owner-claim.md`. All nine gated acceptance tests are
  kept.

- Aligned with the delivered design: the recommendation rule written out (peak ≈ 30 % of the
  headcount, rounded up to the covering tier), the annual-headline and monthly-sub-line price
  display, the non-profit checkbox and its rounding, the slug field narrowed to 32 characters,
  the design-system component names, and the two contract gaps — the non-profit rate and the
  Event pack — that keep figures off the screen rather than approximated.

- Initial version: four-step wizard, capacity-from-headcount recommendation, DPA acceptance with
  version recording, invoice and payment link, Enterprise quote path.
- Reconciled with the Core API contract: the four catalogue resources, one transactional
  `POST /organisations/{organisation_id}/orders` with the DPA acceptance inside it, no server-side
  draft, `GET /slug-availability`, `GET /legal-documents`, the payment link on the invoice, and the
  statement that an order does not start provisioning.

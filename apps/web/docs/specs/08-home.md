# 08 — Home

**Status:** Proposed · **Owner:** zôÖma

**Implementation scope:** the first commercial dashboard receives a Visio-only
application list. Docs examples remain future design input and are not rendered
until the admission gate in the project roadmap passes.

## 1. Goal

In five seconds, tell the person who pays for Kodera whether everything works, what is
waiting for them to do, and what they are about to be charged — without them opening a second
screen.

## 2. Persona and the "can the CEO do this alone" test

**Who.** The buyer, on the morning after the order and every Monday after that. They open the
console the way they open a bank app: to check nothing is wrong. They are not looking for a
feature; they are looking for reassurance and for the one thing they still owe somebody.

**What they do not know.** What a component is, what a percentile is, what "SLA" means, why an
invitation would expire.

**Alone test: pass**, on four conditions.

1. Every number on the screen is a **measured** number that arrives computed from the Core API.
   The console formats and never calculates: no percentage is divided in the browser, no
   availability is averaged, no due date is worked out from a duration.
2. Nothing on the screen is a number the API did not return. A missing figure hides its card;
   it never renders as `0`, `—` or `99,9 %`.
3. The only thing asking for action is the pending-invitations banner, and it carries one verb.
   Everything else is readable and leads somewhere without demanding anything.
4. Before the space exists, Home is the provisioning timeline of `02-status.md` and nothing
   else. A dashboard of empty cards on the first morning is a worse screen than a promise.

**Where it still fails.** The 30-day availability figure and the backup line are the two things
the buyer trusts most and the two the Core API does not yet return in a form the console may
render (see [Contract gaps](#65-contract-gaps)). Until it does, both are absent rather than
approximated, and the card explains that the figure is being measured.

## 3. Entry points

| Entry | URL |
|---|---|
| Navigation "Accueil" | `/{org}/home` |
| Console default screen after login | `/{org}` → `/{org}/home` |
| Logo in the shell header | `/{org}/home` |
| Welcome email "Votre instance est prête" | `/{org}/home?from=welcome` |
| Order confirmation, "Aller à l'accueil" | `/{org}/home?from=order` |
| Invitation reminder email | `/{org}/home#invitations` |

Before the tenant is `active`, every one of these resolves to the provisioning view (§4.1), and
`/{org}/status` remains the deep link for the detailed applications screen.

## 4. Screens

### 4.1 `home` — provisioning

Identical to `02-status.md` §4.1: the six customer-facing provisioning steps, the "sous un jour
ouvré" promise, and the two things the buyer can usefully do while waiting. The dashboard cards
are not rendered at all, because none of their numbers exist yet.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  Merci, Claire. Votre instance se prépare.                        (h1)    │
│  Nous vous écrivons à chaque étape.                                       │
│                                                                           │
│  [ Provisioning timeline — see 02-status.md §4.1 ]                        │
│                                                                           │
│  Pendant ce temps                                                         │
│  → [ Inviter des personnes ]      → [ Préparer votre domaine ]            │
└───────────────────────────────────────────────────────────────────────────┘
```

Components: `Provisioning timeline` (design system) rendered by `ProgressList`, `Card`,
`LinkButton` ×2, `Skeleton`, live region for step transitions.

**People preparation is available** to owners and administrators during initial provisioning:
`/{org}/people/import?from=status`, using `console.order.confirmation.action-prepare-people`.
The Domain setup action remains withheld while that area is read-only.
Every role also gets one "Nous écrire" that opens Aide with `reason=late`, or with
`reason=step-failed` and the step's `job_id` when a step failed, so the failed-step sentence
(« Écrivez-nous pour que nous la reprenions avec vous. ») always has its action beside it.

Navigation rule while provisioning: Applications, Domaine & identité and Facturation are
rendered disabled with a `Tooltip` saying they open when the instance is ready; Personnes and
Aide stay live, because inviting people and asking a question are both useful before go-live.

### 4.2 `home` — default

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  Bonjour Claire                            [ Inviter des personnes ]      │
│  Mardi 2 septembre · tout fonctionne                              (h1)    │
│                                                                           │
│  ┃ 4 invitations attendent depuis plus de 3 jours.        [ Relancer → ] │
│                                                                           │
│  ┌── Capacité · pic 7 jours ──┐┌── Prochaine facture ──┐┌── Disponibilité│
│  │  62 / 100                  ││  711 €                ││  30 jours      │
│  │  ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░│░░     ││  HT / mois · annuel · ││  99,97 %       │
│  │  participants simultanés   ││  prélèvement le       ││  Engagement    │
│  │  · alerte à 90 %           ││  1er octobre          ││  99,5 % tenu   │
│  │                            ││  [ Factures → ]       ││  [ Statut → ]  │
│  └────────────────────────────┘└───────────────────────┘└────────────────┘
│                                                                           │
│  ┌── Applications ──── Sauvegarde cette nuit 03:12 · restauration ─────┐  │
│  │                     testée le 28 août                               │  │
│  │  [V] Visio   visio.acme-construction.fr    ● En ligne   [ Ouvrir ] │  │
│  │  [D] Docs    docs.acme-construction.fr     ● En ligne   [ Ouvrir ] │  │
│  │  [R] Drive                                 Inclus dès disponibilité  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌── Votre contrat ─────────────┐  ┌── David vous répond sous 4 heures ─┐ │
│  │ Business Plus · annuel       │  │ ouvrées                            │ │
│  │ Engagement jusqu'au          │  │ Le contexte de votre instance est  │ │
│  │ 30 septembre 2027            │  │ joint au ticket.                   │ │
│  │ DPA version 1.2  [ Lire ]    │  │ [ Écrire au support ]              │ │
│  └──────────────────────────────┘  └────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

**The support card today.** There is no ticket yet ([`06-support.md`](06-support.md) §4.0), so the
card's second line reads « L'Aide vous indique quoi préciser dans votre message. » rather than
the design's « Le contexte de votre instance est joint au ticket. » (, owner ruling), and
its "Écrire au support" is a router link to Aide.

Components, in the design-system vocabulary of `COMPONENTS.md`: `Sidebar shell` (from the shell
spec), `Banner` (todo variant, cobalt left rule) for the pending invitations, `Card` ×3 in the
metric variant with `Capacity gauge` in the first, `Card` (applications) containing a `Table`
with a `Status pill` per row and a `Copy-value block` per address, `Card` (inverse) for the
contract, `Card` (inverse) for support, `Button` (primary, one per screen: "Inviter des
personnes"), `LinkButton` ×3, `Empty/loading/confirm` skeletons.

Console primitives that carry them: `Gauge`, `Banner`, `Card`, `Table`, `StatusPill`,
`CopyableField`, `DefinitionList`, `Button`, `LinkButton`, `Toast`, `Skeleton`, `Tooltip`.

Rules taken from the delivered design:

- **One primary action per screen.** On Home it is "Inviter des personnes". Every other action
  is a `LinkButton`. Owners and administrators receive the primary shortcut to
  `/{org}/people/invite`; members and billing contacts receive the greeting and health line only.
- The capacity gauge draws the **90 % marker** as a visible tick with a text label, and its
  value is written in monospace with tabular figures, `62 / 100`.
- The applications card carries the backup line in its header, not as a fourth metric card:
  it reassures, it is not a number to watch.
- A planned application is a row with a dashed `Status pill` reading `Inclus · {quarter}`.
  Never "bientôt" without a quarter.
- The contract and support cards are the inverse (slate) card variant, which is what separates
  "about your agreement with us" from "about your service". In the dark and black themes they also
  carry a 1 px `c-border` edge, since the inverse ground is the page's own colour there or nearly
  ([`10-appearance.md`](10-appearance.md) §10).

### 4.3 `home` — pending invitations (todo)

The banner appears when at least one invitation is `pending` and was last sent (`last_sent_at`,
else `created_at`) more than 72 hours ago. 72 hours is about the life of the account set-up link the
realm mails before the invitation (Core's `ACTIONS_LIFESPAN_S`, `apps/outbox/realm_accounts.py`),
so the banner means "these people have not joined within the life of their set-up link", not "you
have invitations". `Relancer` mails the invitation again and, to an account not set up yet, a fresh
set-up link; the clock then starts again from that send. A pending invitation is always under its
14 days: Core reads one past them as `expired`, and an expired one cannot be resent.

`Relancer` resends **every** matching invitation, one `POST` per invitation (the Core API has no
bulk resend; see §6.5). The result is a partial-failure surface: successes disappear from the
count, failures are listed by address with their own retry.

### 4.4 `home` — capacity warning

At `capacity.upgrade_prompt: true` — which the server turns on at `threshold_pct`, 90 by
default — the gauge fill and its label turn amber, the label reads "Proche de la limite", and
the card gains one `LinkButton` to Facturation. It states what happens at the cap before it
offers anything: no dark pattern, no countdown, no red.

At 100 % the fill is red, the label carries the time of the last refused connection, and the
card offers both the plans link and "Nous en parler", which opens Aide with `topic=capacity`
([`06-support.md`](06-support.md) §4.0).

### 4.5 `home` — incident

`overall != operational` turns the subtitle into "incident en cours" with a red `Status pill`,
and the shell's banner slot carries the incident (precedence is in `00-shell-and-login.md` §4.5).
Home itself stays entirely usable: an incident on calls does not hide the invoice card.

### 4.6 `home` — dunning

`billing.dunning_state != current` renders the next-invoice card in the overdue variant with the
customer's own dates, and the shell banner carries the ladder. Home never threatens; the
escalation language belongs to the dunning drawer in `05-invoices.md`.

### 4.7 `home` — « Créez votre espace » (billing off)

Status: Implemented (quick workspace W1, `run-notes/quick-workspace/SPEC.md` §2.1 and §3).

On a deployment that does not bill (`billing_enabled: false` in the status summary, never a build
variable), the owner's home before any tenant exists is `console.home.create.title`
(« Créez votre espace »), `CreateWorkspace` in `src/features/workspace-create/`. Nothing renders
while the summary loads, so « Commander » never flashes. The form:

- **The name** (`label-name`), prefilled with the organisation's name: 1 to 200 characters
  (code points, as Core counts them), not blank, with no "other" character (control, format,
  unassigned, private use, surrogate) and no line or paragraph separator; a no-break space is
  allowed (the Tenant's own rule). A prefilled name that breaks it says so at once.
- **The address** (`label-address`), derived from the name as the owner types (`deriveSlug`:
  lowercase, accents dropped, œ æ ß ø ł đ spelled oe ae ss o l d, every other run of characters
  one hyphen, no hyphen at either end, at most 32 characters) and shown as `‹slug›.‹VITE_TENANT_DOMAIN›` behind « Modifier ». Under 3
  characters, the field opens. Once edited, it stops following the name. « L’adresse est
  définitive. » is always shown with it. « Modifier » and a suggestion put the keyboard in the
  field.
- **The check.** `GET /slug-availability` 300 ms after the last change to the address. Only the
  answer for the address on screen counts. Taken or reserved: the error in the address's live
  region, read out with the free ones offered, and up to three of them as buttons; one picked is
  checked in turn. Every address Core refused at submit stays refused on the page. A failed check
  does not block: Core decides.
- **The documents.** `GET /legal-documents?pack_code=‹workspace_pack_code›&locale=fr`: the CGV and
  the DPA are named with their versions and linked beside the button (`label-documents`,
  `label-document`). Without both, `error-documents-unavailable`, « Réessayer », and no button.
- **One button**, `action-create` (« Créer l’espace — j’accepte les CGV et le DPA »): its words are
  the acceptance, with no checkbox (owner decision). It is enabled while the name and the address
  are valid and the address is not known to be taken or reserved. It is never natively disabled
  while a request runs (the keyboard stays on it): it shows `action-creating` from the press until
  the home shows the tenant, and is shown loading while the documents are read again.

On press: `POST /organisations/{id}/tenants` (`createTenant`) with the versions shown. One
`Idempotency-Key` is kept with its body while the outcome is unknown (a network failure or a 5xx),
so the next press resends the same request; any other body gets a new key. Answers:

| Answer | What the owner sees |
| --- | --- |
| 201 | the home's queries read again, with no navigation (this form is the home, `/{org}/home`): the home then shows the workspace being prepared, where people can be invited. The workspace itself opens from there once the tenant runs (W2). If the read does not show the tenant, `error-not-shown` |
| 409 `slug-taken` | the address field opened and focused, « Cette adresse est déjà prise. », Core's free addresses |
| 422 at `/slug` | the address field opened and focused, « Cette adresse est réservée. » (the form sends only well-formed addresses) |
| 422 at `/name` | the name's `error-name-characters` |
| 422 `cgv_not_in_force` / `dpa_not_in_force` | the documents read again with their new versions, `error-documents-changed`, and a new press needed |
| 409 `tenant-exists` | as for 201 |
| 403 | the membership read again, so the home shows what the role now allows, and `error-failed` |
| 409 `idempotency-key-in-flight` | `error-failed`; the next press resends the same request |
| 409 `billing-enabled` | the summary read again: the order comes back |
| 409 `invalid-state-transition` | `error-not-ready` |
| 503 `service-unavailable` | `error-unavailable` |
| a network failure or a 5xx | `error-failed`; the next press resends the same request |
| anything else | `error-failed` |

A failed background read of the summary keeps the form: only a summary never read shows
`error-discovery-unavailable`.

When the summary names no pack, the owner reads `error-unavailable` and no form. Every other
role reads `empty-title-member` and `console.home.overview.empty-body-unbilled` (« Le propriétaire
de votre organisation crée l’espace. »), with no order. The order's pages (`/{org}/order`) send
the owner to `/{org}/home` while billing is off (`OrderGate`; the bare `/{org}` has no screen); a summary that cannot be read leaves them as
they are, since Core refuses an order itself. Billing on, nothing here changes.

Runnable acceptance: `npm test -- src/features/workspace-create src/features/home/Home.boundary.test.tsx src/features/order/OrderGate.test.tsx tests/unit/api/client.test.ts -t "workspace|address|documents|Créez|bill|order|free names|deriveSlug|form|name|answer|key|Core|home|letters"`.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `home` (provisioning) | Six steps, one running | `Skeleton` timeline | n/a | Progress fetch fails → last known progress, "Impossible d'actualiser", retry | Step transitions announced politely | A step failed → that row marked, support offered with the `job_id`; earlier steps stay done | Every role may read it | `Banner`; last known progress kept, polling paused |
| `home` (default) | Greeting, three metric cards, applications, contract, support | `Skeleton` blocks matching the final layout, never a spinner on a card | Organisation with no tenant and no subscription → `EmptyState` "Aucune instance pour l'instant" + "Commander" (a member reads "Votre espace n'est pas encore prêt", with no action) | Each card owns its error: a failed call renders that card's `InlineAlert` with its own retry, the rest of the page stays usable | Refresh updates in place, timestamp changes quietly | `status-summary` succeeds, `invitations` fails → the three cards render, the banner is absent and a quiet note says the invitations could not be read | `member` sees capacity, applications and support; the invoice card, the contract card and the invitations banner are absent; a direct link to Facturation shows the role banner | Persistent shell `Banner`; cards freeze with "Données du HH:MM"; the resend action disables with the reason |
| `home` (todo banner) | Banner with count and one verb | Banner hidden until the invitation call resolves — it never flashes | No pending invitation older than 72 hours → no banner (not an empty state) | Resend fails for all → `InlineAlert` inside the banner, count unchanged, retry | Banner disappears, `Toast` "{count} invitations renvoyées" | Some resends succeeded → the count drops to the failures, they are listed by address, retry is scoped to them | `member` never sees it | Action disabled with the reason |
| `home` (capacity warning) | Amber gauge, "Proche de la limite", link to Facturation | `Skeleton` gauge | n/a | `capacity: null` → the card is hidden entirely, never a 0 % gauge | Returning below the threshold restores the cobalt gauge with no announcement | n/a | Visible to every role; the Facturation link is absent for `member` | Frozen with its timestamp |
| `home` (incident) | Red pill, subtitle "incident en cours", page usable | as default | n/a | Incident detail unavailable → the pill stays, the link goes to Applications | Recovery restores "tout fonctionne" with a transient `Toast` | Calls degraded, web fine — the normal case | n/a | Offline takes precedence over the incident banner |
| `home` (dunning) | Overdue variant of the invoice card, shell banner | as default | n/a | `dunning` fetch fails → the card falls back to the subscription figures without a state | Payment clears the banner on the next refresh | n/a | `member` sees neither | Frozen |

**Polling.** `GET /organisations/{organisation_id}/status-summary` every 60 s while the tab is
visible; `GET /tenants/{tenant_id}/status` every 10 s while the tenant is `provisioning` and not
at all once it is `active` (Home reads the summary, the Applications screen owns the detail).
Nothing polls while the tab is hidden. Three consecutive failures back off to 5 min and resume
on focus.

## 6. Core API calls

Paths, parameter names, field names and enum values are those of
`kodera-server/contracts/core-api.openapi.yaml`. Home introduces no new endpoint: it composes
calls the other screens already make, which is what keeps it cheap.

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/me` | — | `display_name`, `locale`, `organisations[]{ organisation{ id, slug, name }, role }` |
| `GET` | `/api/v1/organisations/{organisation_id}/status-summary` | — | `tenant_id`, `overall`, `components[]{ key, name, state, since, message_key, incident_ref }`, `capacity{ seats, participants, storage, threshold_pct, upgrade_prompt, suggested_capacity_tier_code, measured_at }`, `billing{ dunning_state, oldest_overdue_invoice_id, amount_due }`, `maintenance{ scheduled_at, duration_s, message_key }`, `open_incident_ids[]`, `measured_at` |
| `GET` | `/api/v1/organisations/{organisation_id}/tenants` | `status`, `limit=1` | `data[]{ id, status }` — only when `status-summary.tenant_id` is null |
| `GET` | `/api/v1/tenants/{tenant_id}/status` | — | `status`, `provisioning_steps[]{ customer_label_key, status, started_at, ended_at, job_id }`, `apps[]{ code, name, url, default_url, custom_domain, state, version }`, `agent{ stale, last_heartbeat_at }` |
| `GET` | `/api/v1/tenants/{tenant_id}/availability` | `days=30` | `data[]{ date, components[]{ key, state, degraded_minutes, down_minutes } }` |
| `GET` | `/api/v1/organisations/{organisation_id}/subscriptions` | `state=active`, `limit=1` | `data[]{ id, pack_code, capacity_tier_code, billing_period, price_snapshot{ total_excl_vat, vat_regime }, current_period_end, next_invoice_at, cancel_at_period_end, price_change_notice_days }` |
| `GET` | `/api/v1/organisations/{organisation_id}/invoices` | `state=issued`, `limit=1` | `data[]{ id, number, state, total_excl_vat, amount_due, due_at }` |
| `GET` | `/api/v1/organisations/{organisation_id}/invitations` | `state=pending`, `limit=100`, `cursor` | `data[]{ id, email, state, created_at, expires_at, sent_count, last_sent_at }`, `next_cursor`, `has_more` |
| `POST` | `/api/v1/invitations/{invitation_id}/actions/resend` | `Idempotency-Key` | `id`, `sent_count`, `last_sent_at` |
| `GET` | `/api/v1/organisations/{organisation_id}/memberships/count` | `state=active` | `count`, `counted_at` |
| `GET` | `/api/v1/organisations/{organisation_id}/entitlements` | `limit=50` | `data[]{ code, enabled, required_pack_code, limit, used }` |
| `GET` | `/api/v1/organisations/{organisation_id}/dpa` | `limit=1` | `data[]{ id, version, accepted_at }` |
| `GET` | `/api/v1/support/help-context` | `area=shell`, `screen=home`, `locale` | `sla{ support_tier, first_response_target_minutes, business_hours_label, next_response_due_at }`, `incident` |

Notes.

- **Money arrives in minor units.** `price_snapshot.total_excl_vat` is a `Money` object,
  `{amount_minor, currency}`. The invoice card renders `711 €` from `{amount_minor: 71100,
  currency: "EUR"}` and never from a float. The delivered design writes amounts in monospace
  with tabular figures; the value is still formatted with `Intl`.
- **The console never divides.** `capacity.participants.pct` is server-computed and
  `upgrade_prompt` — not a threshold the console holds — is what turns the amber state on. The
  design's "alerte à 90 %" is rendered from `threshold_pct`, not hard-coded.
- **The seven-day peak is not in the contract.** `capacity.participants.used` is the current
  measurement, not the seven-day peak the design labels. Until the contract carries a peak, the
  card is labelled "Capacité · maintenant" from `measured_at`, and the peak label is held back
  (§6.5). The gauge itself is unaffected.
- **`components[].key` is a closed set** — `web`, `calls`, `documents`, `console`, `identity`,
  `mail` — and the customer-facing names come from the catalogue, never from `name`, which is
  staff English.
- **Pending invitations are read, not counted.** There is no `invitations/count`; the banner
  pages `invitations?state=pending` and filters on the last send (`last_sent_at`, else
  `created_at`) older than 72 hours. The page
  cap is 100 and `has_more` is rendered as "au moins {count}", never as an invented total.
- **Resend is per invitation.** The design's `POST /invites/resend-all` does not exist; the
  console issues one `POST /invitations/{invitation_id}/actions/resend` per invitation, each
  with its own `Idempotency-Key`, and treats the batch as a partial-failure surface. Resend is
  rate limited per invitation and returns `429` with `retry_after_s`; the button greys with the
  countdown rather than retrying in a loop.
- **Applications are read from the tenant status view.** `apps[].url` is already the custom
  domain when one is live and the `kodera.io` host otherwise, so Home never chooses between
  two addresses.

### 6.5 Contract gaps

Everything Home needs and the Core API contract does not declare. None of these is invented as a
path here; each is a request to `kodera-core` and, until it lands, the corresponding element is
absent from the screen rather than approximated.

| What the design asks for | Why the contract cannot answer it today | What Home does meanwhile |
|---|---|---|
| **30-day availability as one percentage**, with "Engagement 99,5 % tenu" | `GET /tenants/{tenant_id}/availability` returns per-day, per-component `degraded_minutes` and `down_minutes`. Rolling 30 days into one figure is an average, and the console does not compute. There is also no field carrying the SLA commitment itself | The card renders "Mesure en cours" and links to Applications, the console's status source (no external status page, owner ruling). It never shows a computed percentage |
| **Backup line**: last backup time, last restore-drill date | `ProvisioningStepLabel.backups` exists as a step label; no endpoint returns backup or restore-drill facts | The applications card header is omitted rather than filled with a promise |
| **Seven-day capacity peak** | `CapacityGauge` carries `used`, `included` and `pct` at `measured_at`; no peak window | The card is labelled from `measured_at` |
| **Planned applications with a quarter** (`Drive`, `Agenda`, "Inclus dès disponibilité") | `AppCode` includes `drive`, but `TenantApp.state` has no `planned` value and nothing carries an availability quarter | The row is not rendered. A quarter written into the front-end would be exactly the "bientôt" the design system forbids |
| **A named support contact** ("David vous répond sous 4 heures ouvrées") | `HelpContext.sla` carries the tier, the target minutes and the business hours; no contact identity | The card reads the promise without a name, from `first_response_target_minutes` |
| **Count of pending invitations** | Cursor pages carry no total and only `memberships/count` exists | The banner counts what it has paged and says "au moins {count}" when `has_more` |
| **Bulk resend** | No batch resend endpoint | One `POST` per invitation, reported as a partial failure |

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `home.default` | `status-summary` `operational`, `capacity.participants.pct: 62`, one active subscription, no pending invitation |
| `home.provisioning` | `status-summary.tenant_id` set, `tenants/{id}/status` `provisioning` with `apps` running; composes with `status.provisioning-in-progress` |
| `home.pending-invitations` | `invitations?state=pending` returns four invitations created and last sent four days ago, expiring in ten |
| `home.pending-invitations-partial` | The same four, and `actions/resend` returns `429` for the second and `200` for the others |
| `home.capacity-92` | `status-summary.capacity.participants.pct: 92`, `upgrade_prompt: true`, `suggested_capacity_tier_code: L` |
| `home.capacity-at-limit` | `pct: 100`, `upgrade_prompt: true` |
| `home.incident` | `overall: degraded`, `calls` degraded, one entry in `open_incident_ids[]` |
| `home.dunning` | `billing.dunning_state: past_due` with `oldest_overdue_invoice_id` and `amount_due` |
| `home.no-tenant` | `status-summary.tenant_id: null` and `organisations/{id}/tenants` empty |
| `home.invitations-error` | `invitations` returns `503` while every other call succeeds |
| `home.member-role` | `/me` returns `role: member`; the invoice card, the contract card and the banner are absent |
| `home.capacity-null` | `status-summary.capacity: null`; the gauge card is hidden, not zeroed |

Overlays compose with the shell's (`shell.offline`, `shell.status-degraded`) and with
`status.*`; the later one wins on a shared endpoint.

## 8. Validation rules

Home has no form. Four display rules stand in for validation, and all four exist to stop the
screen inventing a number.

| Rule | Behaviour |
|---|---|
| A figure absent from the response | Its card is hidden. Never `0`, never `—`, never a placeholder percentage |
| `capacity: null`, or `included` of 0 | The gauge card is hidden entirely rather than rendering 0 % |
| `has_more: true` on pending invitations | The count is written "au moins {count}"; the console never sums pages it has not fetched |
| An unknown `components[].key` or `apps[].state` | Rendered with the neutral pill and the "État inconnu" label, never as operational |

## 9. Error copy rules

Cause, then next action. Home is the screen a worried person opens, so no card is allowed to
fail silently and none is allowed to fail loudly enough to hide the others.

| Problem `type` suffix, or condition | Copy key | Shown as |
|---|---|---|
| `status-summary` returns `503` | `console.home.overview.error-summary-unavailable` | `InlineAlert` across the three metric cards, with retry, keeping the last values and their timestamp |
| `invitations` returns `503` | `console.home.overview.error-invitations-unavailable` | Quiet note where the banner would be; the rest is untouched |
| `actions/resend` returns `429` | `console.common.error-rate-limited` | Per-address, with the countdown from `retry_after_s` |
| Some resends failed | `console.home.overview.error-resend-partial` | The banner lists the failed addresses with a scoped retry |
| `subscriptions` or `invoices` returns `503` | `console.home.overview.error-invoice-unavailable` | The invoice card alone shows it, with a link to Facturation |
| `forbidden` on the invoice or contract card | — | The card is not rendered at all; a direct link to Facturation shows `console.shell.access.error-role` |
| `agent.stale: true` | `console.status.overview.error-heartbeat-stale` | The applications card says information is no longer arriving; it never claims an outage |
| Availability unavailable or not yet measurable | `console.home.overview.status-availability-measuring` | The availability card, with a link to Applications (`/{org}/status`) |
| Network failure | `console.common.error-offline` | Shell `Banner`; cards freeze with their timestamp |

## 10. Accessibility

- One `h1`: the greeting. The date-and-health line is its subtitle, in a `role="status"` region
  so a change from "tout fonctionne" to "incident en cours" is announced once.
- `Capacity gauge` is a `meter` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax` and an
  accessible name that reads as a sentence: "62 personnes en réunion en même temps sur 100
  possibles". The 90 % marker is a visible tick with a text label, never a colour change alone.
- The banner is `role="status"`, not `role="alert"`: pending invitations are not an emergency.
  Its count is announced once, on load, and again after a resend.
- **Focus order:** skip link → shell (switcher, help, account) → `h1` → primary "Inviter des
  personnes" → banner action → capacity card link → invoice card link → availability card link
  → each application row (address, "Copier", "Ouvrir") → contract card → support card.
- **Keyboard map:** `Enter`/`Space` on "Copier" announces "Adresse copiée" in the polite region;
  "Ouvrir" states in its accessible name that it opens a new tab; `Escape` closes any toast.
- Every `Status pill` carries its state as text as well as colour, and the amber and red
  capacity states carry their own label ("Proche de la limite", "Limite atteinte").
- The applications table has a caption and row headers, and scrolls horizontally inside its own
  container below 768 px rather than making the page scroll.
- Skeletons are `aria-busy` regions, announced once as "Chargement" and never per card.
- Reduced motion: the gauge fills without transition and the toast appears without slide.

## 11. Analytics events

No personal data: no email address, no display name, no organisation name, no custom domain, no
slug. The organisation is a salted, rotating pseudonymous id.

| Event | Properties |
|---|---|
| `home_viewed` | `tenant_state` (`provisioning` \| `active` \| `degraded`), `cards_rendered` (count) |
| `home_invitations_banner_shown` | `bucket` (`1-4`, `5-19`, `20+`) |
| `home_invitations_resent` | `attempted`, `succeeded`, `failed` |
| `home_capacity_state_shown` | `bucket` (`under-90`, `90-99`, `at-limit`) |
| `home_card_link_clicked` | `card` (`capacity` \| `invoice` \| `availability` \| `contract` \| `support`) |
| `home_app_opened` | `app` (`visio` \| `docs`) |
| `home_app_url_copied` | `app` |
| `home_card_error_shown` | `card`, `reason` (`unavailable` \| `forbidden` \| `offline`) |

## 12. Acceptance tests

1. **Given** a healthy organisation (`home.default`),
   **when** the buyer opens the console,
   **then** the greeting, the health line, the capacity gauge, the next invoice and the
   applications are on one screen, and every figure shown appears in the mocked responses.
   `home/overview: shows health, capacity and the next invoice in one screen`

2. **Given** four invitations last sent four days ago (`home.pending-invitations`),
   **when** Home loads and the buyer activates "Relancer",
   **then** one resend call is made per invitation, the banner disappears, and a toast confirms
   the number resent.
   `home/overview: resends invitations that outlived their set-up link`

3. **Given** one of four resends is rate limited (`home.pending-invitations-partial`),
   **when** the buyer activates "Relancer",
   **then** the three successes are not re-attempted, the failed address is listed with its own
   retry and its countdown, and the count reflects only the failure.
   `home/overview: retries only the invitation that failed`

4. **Given** capacity at 92 % (`home.capacity-92`),
   **when** Home loads,
   **then** the gauge is amber, it reads as people out of people, the 90 % marker is described
   in text, and the message states what happens at the cap before offering the plans link.
   `home/overview: explains the capacity limit before offering an upgrade`

5. **Given** a response with no capacity block (`home.capacity-null`),
   **when** Home loads,
   **then** the capacity card is absent and no gauge, no `0` and no percentage is rendered
   anywhere on the page.
   `home/overview: hides a figure it does not have instead of inventing one`

6. **Given** the invitations endpoint fails while everything else succeeds
   (`home.invitations-error`),
   **when** Home loads,
   **then** the three metric cards, the applications and the contract card all render, and only
   the invitations area reports its own problem.
   `home/overview: keeps the page usable when one call fails`

7. **Given** a tenant still provisioning (`home.provisioning`),
   **when** the buyer opens the console,
   **then** Home is the six-step timeline with the one-business-day promise, no dashboard card
   is rendered, and Applications, Domaine & identité and Facturation are disabled with a reason
   while Personnes and Aide stay reachable.
   `home/overview: shows the installation timeline instead of empty cards`

8. **Given** a member-role token (`home.member-role`),
   **when** they open Home,
   **then** the invoice card, the contract card and the invitations banner are absent, capacity
   and applications are visible, and no raw error appears.
   `home/overview: shows a member what their role allows and nothing else`

8b. **Given** a member-role token and an organisation with no tenant (`home.no-tenant`),
   **when** they open Home,
   **then** the empty state reads « Votre espace n'est pas encore prêt » and says an owner or an
   administrator sets it up first; it says nothing about ordering and offers no action.
   `home/overview: tells a member who sets the organisation up, not how to order`

9. **Given** a keyboard-only user on the default Home,
   **when** they tab through the page and copy an application address,
   **then** focus follows the visual order, the copy is announced in the polite region, and no
   control is reachable only by pointer.
   `home/overview: reaches and copies an application address with the keyboard alone`

10. **Given** the browser goes offline (`shell.offline`) while Home is open,
    **when** the connection drops,
    **then** the cards keep their last values with their timestamp, the resend action is
    disabled with the reason, and the view refreshes by itself when the connection returns.
    `home/overview: freezes its figures with a timestamp when the connection drops`

11. **Given** an owner whose successful tenant discovery finds no instance,
    **when** they navigate from Aide to Accueil,
    **then** the existing empty-state title is the one visible h1, the shell announces Accueil
    once, focus moves to that heading without making it a tab stop, and ordering remains available.
    `home/navigation: focuses an empty home after navigation`

12. **Given** tenant summary discovery is unavailable,
    **when** they navigate from Aide to Accueil,
    **then** the existing space-state title is the one visible h1 and receives route focus;
    retry remains available, ordering is absent, and the page is announced once.
    `home/navigation: focuses a home with failed summary discovery`

13. **Given** summary discovery finds no tenant identifier and fallback discovery is unavailable,
    **when** they navigate from Aide to Accueil,
    **then** the existing space-state title is the one visible h1 and receives route focus;
    retry remains available, ordering is absent, and the page is announced once.
    `home/navigation: focuses a home with failed fallback discovery`


## 13. Out of scope for launch

- Any chart or sparkline. The three figures are numbers, and the seven-day table on the
  Applications screen is the whole history at launch.
- A configurable dashboard: no card ordering, no widget picker, no per-user layout.
- Usage per person or per room; capacity is instance-wide only.
- Backup restore triggered from the console; restoring is an operator job with a runbook.
- A "what changed since your last visit" feed (planned after launch).
- The 30-day availability figure and the backup line, until the contract carries them (§6.5).

## Changelog

- The pending-invitations banner (gap report G16) counts invitations last sent more than 72 hours
  ago, about the life of the realm's set-up link, instead of created more than seven days ago: a
  number no mail carried, and a resend did not restart. Its copy says « depuis plus de 3 jours ».

- « Créez votre espace » (§4.7, quick workspace W1): with billing off, the owner creates the
  workspace in one step from the home, and the order's pages send them home. Contract 0.35.0.

- Member empty state: a member of an organisation with no tenant reads who sets it up
  (`console.home.overview.empty-title-member`, `-body-member`), not the owner's ordering copy.

- Restore role-gated People entry points on active and provisioning Home using the existing
  routes and catalogue copy. Domain setup stays withheld.

- Inverse cards outlined in dark and black: the contract and support cards draw a 1 px `c-border`
  edge in those themes, where the inverse ground is the page's own colour or nearly; light
  unchanged (, owner ruling, [`10-appearance.md`](10-appearance.md) §10).

- Support actions land on Aide: the support card's and the lifecycle screen's "Écrire au support"
  and the capacity card's "Nous en parler" open the interim Aide page
  ([`06-support.md`](06-support.md) §4.0) instead of the placeholder (UX audit SH-05), as router
  links; the lifecycle one carries `state`, "Nous en parler" carries `topic=capacity`.
  "Inviter des personnes" and "Préparer votre domaine" are withheld until People and Domain ship
  with contract 0.12.0, and provisioning offers "Nous écrire" instead (, owner ruling).
  The support card no longer mentions a ticket, and the availability card links to Applications
  rather than an external status page.

- Initial version: the Accueil dashboard from the delivered design — greeting and health line,
  capacity gauge with its 90 % marker, next invoice, 30-day availability, pending-invitations
  banner, applications with the backup note, contract and support cards — with the full state
  matrix, the Core API calls it composes from existing operations, the seven contract gaps that
  keep three of those elements off the screen for now, the MSW overlays and the acceptance tests.

# 02 — Status

**Status:** Proposed · **Owner:** zôÖma

**Implementation scope:** current acceptance scenarios contain Visio only. The
screen remains data-driven for later admitted applications, but Docs examples
below do not authorise a Docs profile, entitlement, URL or availability claim.

## 1. Goal

Answer the two questions the buyer actually asks — "is my space ready yet?" and "is it working
right now?" — on one screen, in plain French, without asking them to interpret anything.

## 2. Persona and the "can the CEO do this alone" test

**Who.** Everyone in the organisation who has console access, from the CEO on the day after the
order to the office manager on the morning of a company-wide meeting. It is the screen a person
opens when something is wrong, and the screen they come back to for an address to send round.

In the delivered design this area is called **Applications** in the navigation, because that is
what the buyer is looking for when they open it — the addresses of Visio and Docs, whether they
work, and what is coming. `08-home.md` is the console's front door; this is the detail behind
it, and the two never restate the same number differently: capacity, health and the next invoice
are read from the same server-computed fields on both.

**Alone test: pass**, on four conditions.

1. Between the order and the space being ready, the screen shows **progress with meaning**, not
   a spinner: what is done, what is happening, and when it is expected. It never shows internal
   step names ("tofu apply", "ansible preflight").
2. The URLs of the apps are the biggest thing on the screen once the space is live, each with a
   one-click copy and a "Ouvrir" action, because sharing them is the first thing the buyer does.
3. A degradation is described by what the user cannot do ("les appels vidéo sont perturbés"),
   not by which component is red, and it always carries a next-update time.
4. The capacity gauge reads as people, not as a metric: "47 personnes en réunion en même temps,
   sur 50 possibles". The upgrade prompt appears at 90 % and is never a dark pattern — it states
   what happens at the cap and offers to talk to someone.

**Where it still fails.** A buyer whose provisioning has stalled cannot see why. By design: the
reason is operational. The screen therefore offers a "Nous n'avons pas de nouvelles" state that
opens support with the context attached, rather than an explanation the buyer cannot use.

## 3. Entry points

| Entry | URL |
|---|---|
| Console default screen | `/{org}` → `/{org}/home` (`08-home.md`); this screen is the detail behind it |
| Navigation "Applications" | `/{org}/status` |
| From Accueil, an application row | `/{org}/status#apps` |
| Order confirmation | `/{org}/status?from=order` |
| Welcome email "Votre instance est prête" | `/{org}/status?from=welcome` |
| Status banner "En savoir plus" | `/{org}/status#incident` |
| Capacity banner | `/{org}/status#capacity` |

## 4. Screens

### 4.1 `overview` — provisioning in progress

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  Votre espace est en cours d'installation                        (h1)     │
│  Prêt sous un jour ouvré. Nous vous écrivons dès que c'est fait.          │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ ✅  Commande enregistrée                                            │  │
│  │ ✅  Serveur réservé à Paris                                         │  │
│  │ ⏳  Installation des applications          en cours                 │  │
│  │ ○   Adresses et certificats                                         │  │
│  │ ○   Comptes et connexion                                            │  │
│  │ ○   Sauvegardes et surveillance                                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Pendant ce temps                                                         │
│  → [ Préparer la liste de vos collaborateurs ]                            │
│  → [ Réserver votre adresse visio.acme.fr ]                               │
│                                                                           │
│  Une question ? [ Nous écrire ]                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

The "Pendant ce temps" block offers owners and administrators the existing People import
route, `/{org}/people/import?from=status`, during initial provisioning. Members and billing
contacts receive no preparation action. Domain setup stays withheld while that area is read-only.
"Une question ? Nous écrire" opens Aide with `reason=late` ([`06-support.md`](06-support.md) §4.0).

Components, in the design-system vocabulary of `COMPONENTS.md`: `Provisioning timeline` (rows of
circle, label and right-aligned timestamp; the current step carries a cobalt ring and reads "en
cours · {eta}"), `Card`, `Button`, `Empty/loading/confirm` skeletons.

Console primitives that carry them: `ProgressList` (**new component**: ordered steps with done /
running / pending / failed and an optional per-step note), `Card`, `LinkButton` ×2, `Button`
(support), `Skeleton`, live region for step transitions.

The promise line reads "sous 1 jour ouvré" and never a computed countdown, unless the Core API
returns a measured estimate.

Step labels are a **fixed, customer-facing set of six**, mapped by the console from the job's
internal steps. A job step the console does not recognise rolls into the nearest customer step;
it never appears raw.

### 4.2 `overview` — live

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  ACME Construction                                               (h1)     │
│  ● Tout fonctionne                              Mis à jour il y a 40 s    │
│                                                                           │
│  ┌── Vos applications ────────────────────────────────────────────────┐   │
│  │ Visio    visio.acme.fr             [ Copier ]  [ Ouvrir ↗ ]        │   │
│  │ Docs     docs.acme.fr              [ Copier ]  [ Ouvrir ↗ ]        │   │
│  │ Connexion  id.kodera.io/acme-sa [ Copier ]  [ Ouvrir ↗ ]        │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌── Capacité ─────────────────┐  ┌── État du service ───────────────┐   │
│  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░  94 %   │  │ ● Site web        opérationnel   │   │
│  │  47 personnes en réunion    │  │ ● Appels vidéo    opérationnel   │   │
│  │  en même temps, sur 50      │  │ ● Console         opérationnel   │   │
│  │  Pointe des 7 derniers      │  │ Historique 7 jours →             │   │
│  │  jours : 49                 │  └──────────────────────────────────┘   │
│  │  ⚠ Vous approchez de la     │                                         │
│  │  limite. Au-delà, les       │  ┌── Votre formule ─────────────────┐   │
│  │  nouvelles connexions sont  │  │ Business + Docs                   │   │
│  │  refusées.                  │  │ 50 participants simultanés        │   │
│  │  [ Voir les formules ]      │  │ Prochaine facture : 1er mars 2027 │   │
│  │  [ Nous en parler ]         │  │ [ Voir mes factures ]             │   │
│  └─────────────────────────────┘  └───────────────────────────────────┘   │
│                                                                           │
│  ┌── Prochaine maintenance ──────────────────────────────────────────┐    │
│  │ Mardi 15 h 30 · environ 20 minutes · les appels en cours ne sont  │    │
│  │ pas interrompus.                                                  │    │
│  └───────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Card` per application (glyph,
version, `Status pill`, primary address and fallback address as `Copy-value block`s, "Ouvrir"),
`Capacity gauge` with its 90 % marker, `Status pill` per component, `Banner` (maintenance,
amber), `Card` (plan), `Table` (history), `Button`.

The application cards follow [`application-cards.md`](application-cards.md): one named card per
served application, its optional version and explicit state, with paired address blocks at wide
widths and stacked blocks on narrower screens. Activity metrics and extra actions are deferred
until their contract and behavior exist.

Console primitives that carry them: `StatusPill` (overall and per application), `Card`, `CopyableField` with
`Button` "Ouvrir", `Gauge` (capacity, with a labelled threshold at 90 %), `DefinitionList`
(plan), `Banner` (capacity ≥ 90 %, rendered inside the capacity card rather than the shell slot
when the shell slot is already occupied by an incident), `LinkButton` (history), `Tooltip` (what
"simultané" means).

Rules taken from the delivered design:

- Every application shows **both** addresses: the primary one and the `{slug}.*.kodera.io`
  fallback, labelled "Secours", each with its own copy control. The fallback is never removable
  and never hidden — it is what still works while a custom domain is being verified.
- The capacity gauge turns amber at `threshold_pct` (90 by default, read from the response, not
  held in the front end) with the label "Proche de la limite", and red at 100 % with the time of
  the last refused connection. It is never a bare colour change.
- `capacity: null` (contract 0.30.0) is a tenant whose capacity is not measured yet. The card keeps
  its title and says "Pas encore mesurée"; it shows no gauge and no figure, never a zero.
- A refused-connection count above zero in the seven-day history is written in amber with a link
  to the capacity card, not as a red error: it is a fact about sizing, not a fault.

### 4.3 `overview` — degraded

The three status rows change; the header pill becomes "Appels vidéo perturbés"; a `Banner` above
the cards carries the plain-French message and the next-update time. The apps card stays: a
degraded calls service does not stop someone opening Docs. While this banner is shown, the shell's
banner slot does not repeat the incident for the same component; it shows the next banner in its
precedence, or none (`00-shell-and-login.md` §4.5): one incident is announced once.

```text
│  ⚠ Les appels vidéo sont perturbés depuis 14 h 10.                        │
│    Le site et les documents fonctionnent normalement.                     │
│    Prochaine mise à jour à 15 h 30.       [ Suivre sur la page d'état ↗ ] │
```

### 4.4 `incident-detail` (drawer)

```text
┌── Appels vidéo perturbés ─────────────────────────── [×] ──┐
│ Depuis 14 h 10 · Prochaine mise à jour 15 h 30             │
│                                                            │
│ Ce que vous constatez                                      │
│ Les participants peuvent entrer dans une réunion mais       │
│ l'image se fige pour certains.                             │
│                                                            │
│ Ce que nous faisons                                        │
│ 14 h 25 — Cause identifiée sur le serveur média.           │
│ 14 h 40 — Correction en cours.                             │
│                                                            │
│ [ Ouvrir un ticket ]     [ Page d'état publique ↗ ]        │
└────────────────────────────────────────────────────────────┘
```

**No external status page** (, owner ruling). The console links to no public status
page: the banner's "Suivre sur la page d'état" and the drawer's "Page d'état publique" are not
rendered. This screen is the status source; a public status page, and its address, is a later
decision.

Components: `Drawer`, `DefinitionList`, timeline as an ordered list, `Button` ×2.

### 4.5 `history` — seven days

A compact `Table`: one row per day, three cells (web, calls, console) with a `StatusPill` each
and the minutes of degradation. No graphs at launch.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `overview` (provisioning) | Six steps, one running | `Skeleton` step list | n/a | Progress fetch fails → last known progress with "Impossible d'actualiser" and a retry | Step transitions to done, announced politely | A step failed → that row is marked and the card offers "Nous écrire" with the job reference; earlier steps stay done | Every role may read status | Banner; last known progress kept, polling paused |
| `overview` (live) | Pill, apps, capacity, components, plan | `Skeleton` cards, layout preserved | Organisation with no tenant yet → `EmptyState` "Aucune instance pour l'instant" + "Commander" | `tenants/{tenant_id}/status` fails → each card shows its own inline error; the apps card, which is cached, still renders | Refresh updates in place with a quiet timestamp change | Apps loaded, components fetch failed → components card shows an inline error, the rest is usable | Plan and invoice links hidden for `member`; capacity and apps visible to all | Banner; content frozen with "Données du HH:MM" |
| `overview` (degraded) | Banner + amended pills | as above | n/a | Incident detail unavailable → the banner still shows, the drawer says so and links to the public page | Recovery replaces the banner with a transient "Tout fonctionne à nouveau" toast | Web fine, calls degraded — the normal case for this state | as above | Banner (offline takes precedence over incident) |
| `incident-detail` | Timeline | `Skeleton` timeline | No updates yet → "Nous mettons à jour dès que possible" | Fetch fails → the unavailable sentence and a later retry; the ticket action stays | n/a | n/a | n/a | Drawer opens with cached content |
| `history` | 7 rows | `Skeleton` rows | Fewer than 7 days of data → the rows that exist, with a note | Fetch fails → retry | n/a | Some days missing → those rows read "Données indisponibles" | n/a | Banner |

**Polling.** `GET /api/v1/tenants/{tenant_id}/status` is polled every 30 s while the tab is
visible and the tenant is `active`; every 10 s while it is `provisioning`; never while the tab is
hidden. Polling backs off to 2 min
after three consecutive failures and resumes on focus.

## 6. Core API calls

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/organisations/{organisation_id}/tenants` | `cursor`, `limit`, `status` | `data[]{ id, slug, name, status, pack_code, capacity_tier_code, apps[], created_at }` |
| `GET` | `/api/v1/tenants/{tenant_id}` | — | `id, slug, name, status, status_changed_at, pack_code, capacity_tier_code, apps[], region, default_urls{}, observed{ last_heartbeat_at, stale, agent_version, maintenance }` |
| `GET` | `/api/v1/tenants/{tenant_id}/status` | — | `status`, `status_changed_at`, `message_key`, `provisioning_steps[]{ key, customer_label_key, status, started_at, ended_at, job_id }`, `current_job{ job_id, kind, status }`, `apps[]{ code, name, url, default_url, custom_domain, state, version }`, `capacity{ seats, participants, storage, threshold_pct, upgrade_prompt, suggested_capacity_tier_code, measured_at }`, `components[]`, `agent{ stale, last_heartbeat_at, maintenance }`, `domains[]` |
| `GET` | `/api/v1/status/components` | `tenant_id`, `scope`, `cursor` | `data[]{ id, scope, key, name, state, since, message_key, incident_ref }` |
| `GET` | `/api/v1/status/incidents` | `tenant_id`, `state=open`, `cursor` | `data[]{ id, reference, state, severity, component_keys[], title_key, impact_key, started_at, next_update_at, updates[]{ at, body_key } }` |
| `GET` | `/api/v1/tenants/{tenant_id}/availability` | `days=7` | `data[]{ date, components[]{ key, state, degraded_minutes, down_minutes } }` |
| `GET` | `/api/v1/organisations/{organisation_id}/subscriptions` | `state=active` | `data[]{ id, state, plan_code, pack_code, capacity_tier_code, billing_period, price_snapshot{…}, current_period_end, next_invoice_at, price_change_notice_days }` |

Notes.

- **The tenant lifecycle field is `status`, not `state`**, and its values are the one canonical
  enum: `ordered`, `provisioning`, `ready`, `active`, `upgrading`, `maintenance`, `suspended`,
  `decommissioning`, `deleted`, `failed`. Three enums disagreeing across three documents is the
  condition this contract exists to end; the console does not add a fourth.
- **Staleness is a flag, never a status.** `agent.stale` is `true` after three missed heartbeats
  and the tenant is still `active`. The console shows a secondary "Not reporting" indicator with
  the last-seen time, and the components fall back to probe results.
- `provisioning_steps[].key` is the internal step and the console **never** renders it: it names an
  OpenTofu apply or an Ansible role and changes when the profile changes. The console renders
  `customer_label_key`, a closed enum of six values — `order`, `server`, `apps`, `addresses`,
  `accounts`, `backups` — through `console.status.overview.status-step-<value>`.
- `message_key`, `title_key`, `impact_key` and `body_key` are message-catalogue keys chosen by the
  Core API from closed sets, so incident wording is translated and never a raw operator sentence in
  the customer's screen. An unknown key falls back to a generic sentence for that component.
- Capacity is three server-computed bars (`seats`, `participants`, `storage`), each with `used`,
  `included` and `pct`. The console does not divide, and `upgrade_prompt` — not a threshold the
  console holds — is what turns the prompt on.
- `GET /tenants/{tenant_id}/status` already embeds `components` and `domains`, so the Status screen
  is one request. `/status/components` and `/status/incidents` exist for the shell banner and the
  incident drawer, which are rendered outside this screen.
- `apps[].url` is already the custom domain when one is live and the `kodera.io` host
  otherwise, and `default_url` is always the fallback. The screen renders both from those two
  fields and chooses nothing.

**Contract gaps.** Four things the delivered design shows on this screen and the contract does
not carry. None is invented as a path here; each is a request to `kodera-core`, and until it
lands the element is absent rather than approximated.

| What the design asks for | Why the contract cannot answer it today | What the screen does meanwhile |
|---|---|---|
| **Backup line**: "Sauvegarde cette nuit {time} · restauration testée le {date}" | `ProvisioningStepLabel.backups` is a step label; nothing returns backup or restore-drill facts | The line is omitted. A promise the console cannot measure is exactly what principle 3 of the design system forbids |
| **Planned applications with a quarter** (Drive, Agenda, "Inclus dès disponibilité") | `AppCode` includes `drive`, but `TenantApp.state` has no `planned` value and nothing carries an availability quarter | The row is not rendered. A quarter hard-coded in the front end is a "bientôt" with a date attached |
| **Seven-day usage figures** (meetings held, peak, refused connections) | `CapacityGauge` is a point-in-time measurement; `availability` counts degraded and down minutes, not usage | The capacity card shows the measurement and its timestamp; the usage row is absent |
| **Visio branding** (logo upload, accent colour with a 3:1 contrast check) | No branding endpoint exists on the tenant | Out of scope for launch, below |

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `status.provisioning-in-progress` | `tenants/{id}/status` returns `status: provisioning`, `provisioning_steps` with `apps` running and the two before it `succeeded` |
| `status.provisioning-stalled` | The running step started well over its expected duration; `agent.stale: true` |
| `status.provisioning-failed` | One step in `status: failed` with a `job_id`, tenant `status: failed` |
| `status.live-healthy` | `status: active`, three components operational, `capacity.participants.pct: 34` |
| `status.capacity-92` | `capacity.participants.pct: 92`, `upgrade_prompt: true`, `suggested_capacity_tier_code: L` |
| `status.capacity-at-limit` | `capacity.participants.pct: 100`; joins refused message |
| `status.calls-degraded` | `components[].key: calls` in `degraded`, `status/incidents` returns one open incident with two updates |
| `status.heartbeat-stale` | `agent.stale: true`, `status` still `active`, components fall back to probes |
| `status.no-tenant` | `organisations/{id}/tenants` returns an empty page while a subscription exists |
| `status.components-error` | `status/components` returns `503` while `tenants/{id}/status` succeeds |
| `status.availability-gap` | `availability` returns one day with `state: no_data` |
| `status.fallback-only` | `apps[].custom_domain: null`; both addresses are the `kodera.io` ones |

## 8. Validation rules

The screen is read-only; it has no form. Two display rules stand in for validation:

| Rule | Behaviour |
|---|---|
| Unknown component state | Rendered as "État inconnu" with a neutral pill, never as operational |
| Heartbeat older than three intervals (`stale: true`) | The overall pill becomes "Nous ne recevons plus d'informations", the components card is greyed with the same message, and support is offered. It is never rendered as an outage the customer caused |
| `estimated_ready_at` in the past | The promise line switches to "Cela prend plus de temps que prévu" with the support action, not a negative countdown |
| Capacity `limit` of 0 or missing | The gauge is hidden entirely rather than showing 0 % |

## 9. Error copy rules

Cause, then next action. Never a component name the customer has not been taught: the three
names are "Site web", "Appels vidéo", "Console".

| Problem `type` suffix, or condition | Copy key | Next action |
|---|---|---|
| `status-summary` or `tenants/{id}/status` returns `503` | `console.status.overview.error-summary-unavailable` | Retry, then support (Aide) |
| `agent.stale: true` | `console.status.overview.error-heartbeat-stale` | Open a ticket (context attached) |
| A `provisioning_steps[]` entry in `status: failed` | `console.status.overview.error-step-failed` | Open a ticket with the `job_id` |
| A step still `running` past its expected duration | `console.status.overview.error-provisioning-late` | Open a ticket |
| `status/incidents` returns `503` | `console.status.incident.error-unavailable` | Retry; the drawer's "Ouvrir un ticket" stays available |
| `capacity.participants.pct` at 100 | `console.status.overview.error-capacity-reached` | See plans, or talk to someone |
| `organisations/{id}/tenants` returns an empty page | `console.status.overview.empty-no-tenant` | Place an order |
| `tenant-state-conflict` on any action offered here | `console.status.overview.error-state-conflict` | The banner names the current `status` and what it allows |

## 10. Accessibility

- `ProgressList` is an ordered list; each step exposes its state as text ("terminé", "en cours",
  "à venir", "échec"), not only as an icon. The running step carries `aria-current="step"`.
- Step transitions are announced once, politely: "Étape 3 sur 6 terminée : installation des
  applications." Polling that changes nothing announces nothing.
- `Gauge` is a `meter` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax` and an accessible
  name that reads as a sentence: "47 personnes en réunion en même temps sur 50 possibles, 94 %".
  The 90 % threshold is a visible marker with a text label, not a colour change alone.
- `StatusPill` always pairs a shape or icon with the colour and carries the state as text.
- The overall status is in a `role="status"` region; an incident opening is announced once and
  only once per incident id.
- **Focus order:** `h1` → overall pill (not focusable, read by the region) → apps card (per row:
  URL text, "Copier", "Ouvrir") → capacity card ("Voir les formules", "Nous en parler") →
  components card ("Historique") → plan card ("Voir mes factures") → maintenance card.
- **Keyboard map:** `Enter`/`Space` activate "Copier" and announce "Adresse copiée" in the polite
  region; `Escape` closes the incident drawer and returns focus to its trigger; the drawer traps
  focus while open.
- "Ouvrir ↗" opens a new tab and says so in its accessible name ("Ouvrir Visio dans un nouvel
  onglet").
- The seven-day table has a caption, row headers, and per-cell text; it is scrollable
  horizontally inside its own container on small screens.
- Reduced motion: the running-step indicator is a static marker, not a pulse.

## 11. Analytics events

No personal data: no URL of the customer's own domain, no slug, no user identity.

| Event | Properties |
|---|---|
| `status_viewed` | `tenant_state` (`provisioning` \| `live` \| `degraded` \| `stale`) |
| `status_provisioning_step_seen` | `step_index`, `elapsed_bucket` (`<1h`, `1-4h`, `4-24h`, `>24h`) |
| `status_app_url_copied` | `app` (`visio` \| `docs` \| `login`) |
| `status_app_opened` | `app` |
| `status_incident_opened` | `component` |
| `status_capacity_threshold_shown` | `bucket` (`90-95`, `95-100`, `at-limit`) |
| `status_capacity_cta_clicked` | `cta` (`plans` \| `talk`) |
| `status_support_from_status` | `reason` (`stale` \| `step-failed` \| `late` \| `incident`) |
| `status_history_opened` | — |

## 12. Acceptance tests

1. **Given** provisioning is at step 3 of 6 (`status.provisioning-in-progress`),
   **when** the buyer opens the console,
   **then** they see six named, customer-readable steps with the third running, the "under one
   business day" promise, and no internal step name anywhere on the page.
   `status/overview: shows readable provisioning progress without internal names`

2. **Given** a live tenant (`status.live-healthy`),
   **when** the overview loads,
   **then** the three application addresses are shown, and copying one announces the copy and
   places the address on the clipboard.
   `status/overview: shows the application addresses and copies one`

3. **Given** capacity at 92 % (`status.capacity-92`),
   **when** the overview loads,
   **then** the gauge reads as people out of people, the 90 % threshold is described in text, and
   the message states what happens at the cap before offering the plans link.
   `status/overview: explains the capacity limit before offering an upgrade`

4. **Given** the calls component is degraded with an open incident (`status.calls-degraded`),
   **when** the overview loads,
   **then** one banner says calls are affected and the rest works, names the next update time,
   and opening the detail shows the updates in order.
   `status/overview: describes a calls outage by what the user cannot do`

5. **Given** the tenant heartbeat is stale (`status.heartbeat-stale`),
   **when** the overview loads,
   **then** the screen says information is no longer being received, does not claim an outage,
   and offers a ticket with the context attached.
   `status/overview: distinguishes a stale heartbeat from an outage`

6. **Given** a provisioning step has failed (`status.provisioning-failed`),
   **when** the buyer opens the console,
   **then** the failed step is marked, the completed steps stay completed, and the support action
   carries the job reference into the ticket form.
   `status/overview: marks a failed step and opens support with the reference`

7. **Given** the components endpoint fails while the tenant loads (`status.components-error`),
   **when** the overview renders,
   **then** the applications and capacity cards still work and only the components card shows an
   error with its own retry.
   `status/overview: keeps the page usable when one card fails`

8. **Given** an organisation with a subscription but no tenant (`status.no-tenant`),
   **when** the overview loads,
   **then** an empty state explains the situation and offers exactly one action.
   `status/overview: offers one action when there is no space yet`

9. **Given** a keyboard-only user on a degraded tenant,
   **when** they open and close the incident drawer,
   **then** focus enters the drawer, stays inside it, and returns to the trigger on `Escape`.
   `status/incident: opens and closes the detail with the keyboard alone`

## 13. Out of scope for launch

- Per-room or per-user usage analytics; capacity is instance-wide only.
- Graphs and time-series charts; the seven-day table is the whole history at launch.
- Subscribing to incident notifications from the console. Whether a public status page exists,
  and where, is a later decision; the console links to none.
- Restarting or upgrading the instance from the console; those are operator jobs.
- A maintenance-window preference chosen by the customer (planned after launch).
- Visio branding — logo and accent colour — from the console. The design specifies the panel,
  including the 3:1 contrast check against white and the darkened suggestion when it fails; the
  contract carries no endpoint for it, so it is a support request at launch.
- Export of the audit log from this screen (support request at launch).
- One-click export and delete of the organisation's data (planned after launch).

## Changelog

- Restore People preparation for owners and administrators during initial provisioning.
  Keep Domain setup withheld and preserve persistent support for every role.

- No external status page: the degraded banner's and the incident drawer's links to
  `status.kodera.io` are removed, and the §3 row with them; this screen is the status source,
  and a public status page is a later decision (, owner ruling). The "Pendant ce temps"
  block stays withheld until People and Domain ship, and the failed-step sentence no longer claims
  the team was alerted: « Écrivez-nous pour que nous la reprenions avec vous. » Every support
  action here builds its link through `helpHref` ([`06-support.md`](06-support.md) §4.0); the
  instance-state « Nous écrire » carries `state`, and the provisioning « Nous écrire » is a router
  link.

- Support actions land on Aide: every "Nous écrire", "Ouvrir un ticket" and "Nous en parler" on
  this screen opens the interim Aide page ([`06-support.md`](06-support.md) §4.0), which repeats
  the `reason` and `job_id` they carry. "Nous en parler" on the capacity card carries
  `topic=capacity` instead of `reason=incident`, which the page would have read back to the
  customer as an incident; `status_support_from_status` is unchanged, since that action never
  emitted it.

- Journey fixes: while the degraded banner is on this screen, the shell's slot yields to it, so the
  incident is announced once, with this screen's own next-update time.

- Review fixes: the welcome-email entry point and the no-tenant empty state use the glossary's
  customer word, "instance".

- Aligned with the delivered design: renamed to Applications in the navigation with `08-home.md`
  as the console's front door, both addresses per application with the fallback labelled
  "Secours", the amber-at-`threshold_pct` and red-at-100 % gauge states, the design-system
  component names, and the four contract gaps — backup facts, planned applications, seven-day
  usage and branding — that keep those elements off the screen for now.

- Initial version: provisioning progress with a closed set of customer step labels, live
  overview with app URLs and capacity gauge, degraded state, incident drawer, seven-day history.
- Reconciled with the Core API contract: `GET /tenants/{tenant_id}/status` replaces the separate
  provisioning and component calls, `status` replaces `state` with the canonical tenant enum,
  `customer_label_key` is the closed `ProvisioningStepLabel`, and incidents and availability move
  to `/status/incidents` and `/tenants/{tenant_id}/availability`.

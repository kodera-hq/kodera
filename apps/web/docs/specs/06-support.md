# 06 — Support

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Give the customer one place to ask for help, with everything we need to answer already attached,
and a stated time by which they will hear back.

## 2. Persona and the "can the CEO do this alone" test

**Who.** Whoever is in front of the problem. In the first week that is the office manager with
"je n'arrive pas à me connecter" and "on ne m'entend pas". Later it is the CEO with a billing
question or a request for a document their DPO asked for.

**Alone test: pass**, on four conditions.

1. Help is reachable from every screen without leaving it, and the first thing it offers is the
   answer, not a form: the two or three articles that match the screen the person is on.
2. When a form is needed, the technical context is attached automatically — organisation, tier,
   tenant state, current incident, the last failed request id, browser and connection — and the
   person is **shown** what is attached and can remove it. Nothing is collected silently.
3. The response time is stated before submitting, from the tier's SLA, with the business hours
   spelled out. A person who submits at 19:00 on a Friday is told when they will hear back.
4. When the service is degraded, the help panel says so first and offers to follow the incident
   rather than opening a ticket that duplicates fifty others — while still allowing a ticket.

**Where it still fails.** The person who cannot log in cannot open a ticket from inside the
console. The login screen therefore carries a support link that leads to an unauthenticated form
requiring only an email address and an organisation identifier, and that is the only
unauthenticated write path in the console.

## 3. Entry points

| Entry | URL |
|---|---|
| The `[?]` in the shell header | opens the panel, `?help=1` on the current URL |
| Keyboard shortcut | `Alt+/` |
| Navigation "Aide" | `/{org}/help` |
| New ticket | `/{org}/help/new` |
| Ticket list | `/{org}/help/tickets` |
| A ticket | `/{org}/help/tickets/{ticketId}` |
| Contextual, from an error state | `/{org}/help/new?context={contextToken}` |
| From the status screen | `/{org}/help/new?about=incident&incident={id}` |
| From an invoice | `/{org}/help/new?about=billing&invoice={number}` |
| From the login screen (unauthenticated) | `/help/sign-in-problem` |
| Enterprise quote | `/{org}/help/new?about=sales` |

**Until the ticket write path is served** (§4.0), `/{org}/help` is the interim Aide page and every
support action in the console lands on it. Every one builds its link through one typed builder —
`helpHref` for an imperative navigation, `HelpLink` for a router link
(`src/features/support/helpHref.ts`, `HelpLink.tsx`) — so a misspelt context is a type error, and
reaching help never reloads the console. The page reads that context as the subject of the
customer's message:

| Parameter | Set by |
|---|---|
| `reason` (`stale`, `step-failed`, `late`, `incident`), `job_id` | the status screen (`src/features/status/support.ts`) and Home's provisioning view |
| `state` (`ready`, `upgrading`, `maintenance`, `suspended`, `decommissioning`, `deleted`, `failed`) | the instance-state screens of Home and Applications |
| `invoiceNumber` | an invoice's detail |
| `topic=change-plan` | the subscription |
| `topic=dunning` | the dunning drawer |
| `topic=capacity` | the capacity cards on Home and Applications |
| `topic=order` | the order confirmation, when the order cannot be read |

The `/help/new?about=…` shapes above are the target once the form ships.

## 4. Screens

### 4.0 `help` — the interim page, until the ticket path is served

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  Aide                                                           (h1)      │
│  Une question, un problème : une personne de l'équipe vous répond par     │
│  e-mail.                                                                  │
│  ┌── Écrire à l'assistance ─────────────────┐ ┌── Liens utiles ─────────┐ │
│  │ Écrivez-nous à support@kodera.io. Nous     │ │ Voir l'état de votre    │ │
│  │ vous répondons à l'adresse depuis …      │ │ instance                │ │
│  │ ┌ À indiquer dans votre message ───────┐ │ │ Un service perturbé y   │ │
│  │ │ • Le nom de votre organisation : …   │ │ │ est signalé.            │ │
│  │ │ • Le sujet : Facture INV-2026-0142   │ │ │ Voir vos factures       │ │
│  │ │ • L'heure à laquelle c'est arrivé,   │ │ │ Chaque facture se …     │ │
│  │ │   même approximative                 │ │ └─────────────────────────┘ │
│  │ └──────────────────────────────────────┘ │                             │
│  │ [ Écrire un e-mail ]                     │                             │
│  │ Votre messagerie s'ouvre avec ces        │                             │
│  │ informations déjà indiquées. Ne nous     │                             │
│  │ envoyez jamais votre mot de passe.       │                             │
│  └──────────────────────────────────────────┘                             │
└───────────────────────────────────────────────────────────────────────────┘
```

**Why interim.** Contract 0.11.0 declares the ticket write path (`POST /support/tickets`) and the
two reads the form and the panel stand on (`GET /support/help-context`, `GET
/support/ticket-context`), but the Core API serves none of them yet: kodera-core has no handler for
any `/support/*` operation (measured on its `main` at `2ab0494`). A form would post
into a route that answers nothing. The owner's ruling  is that until then the page
carries only what is true without a support write API.

What the page carries:

- **The support address**, the console's one address (support@kodera.io, `src/app/supportContact.ts`,
  passed to the copy as `{email}`): as text in the sentence (« Nous vous répondons à l'adresse depuis
  laquelle vous écrivez », with no time commitment —, owner ruling), as a copyable field
  (`CopyableField`, for a customer on webmail with no mail app), and as an "Écrire un e-mail" link
  that opens a mail app, if the device has one, with the subject and the body already written. The
  hint under it says so conditionally. Every line of that message is a catalogue sentence; nothing
  is concatenated.
- **What to include**, as the delivered design's placeholder and context line suggest, following
  the subject:

  | Subject | The page asks for | The e-mail's lines |
  |---|---|---|
  | None (the sidebar, Home's support card) | organisation, the page, the time *if it is a problem* | organisation, page, time "le cas échéant", "Votre question, ou ce qui se passe" |
  | A problem (`reason`, `state`, `topic=order`) | organisation, the subject, the time | organisation, subject, time, "Que se passe-t-il ?" |
  | A question (`invoiceNumber`, `topic=change-plan`, `capacity`, `dunning`) | organisation, the subject, the question | organisation, subject, "Votre question" |
- **Links that exist**: the instance's status (`/{org}/status`, every role; « Les perturbations en
  cours y sont signalées. », true on every visit) and the invoices (`/{org}/invoices`, only for the
  roles the sidebar shows Facturation to). No external status page is linked (, owner ruling); whether one exists, and where, is a later decision.

The subject, from the query string (§3):

| Parameter | Copy key |
|---|---|
| `reason=stale` | `console.support.help.about-stale` |
| `reason=step-failed` | `console.support.help.about-step-failed`, or `console.support.help.about-step-failed-reference` with `job_id` |
| `reason=late` | `console.support.help.about-provisioning` |
| `reason=incident` | `console.support.help.about-incident` |
| `state=…` | `console.support.help.about-state-ready`, `-upgrading`, `-maintenance`, `-suspended`, `-decommissioning`, `-deleted`, `-failed` |
| `invoiceNumber` | `console.support.help.about-invoice` |
| `topic=change-plan` | `console.support.help.about-change-plan` |
| `topic=capacity` | `console.support.help.about-capacity` |
| `topic=dunning` | `console.support.help.about-dunning` |
| `topic=order` | `console.support.help.about-order` |

A value the page does not recognise is dropped, never a route error: a customer asking for help
must reach help. The two free values it repeats must look like one — an invoice number
(`[A-Za-z0-9][A-Za-z0-9._/-]{0,39}`) and a job reference (`[A-Za-z0-9-]{1,64}`) — so the page cannot
be made to display a sentence someone wrote into a link.

What the page never carries: a form, a response time, business hours or a phone number. The team
answers the address with no time commitment, and the owner decided there is no phone line
(owner ruling). The delivered design's subject chips, text area, "Envoyer", response-time
sentence, instance status card and FAQ are the target, and return with §4.1 and §4.2 once the
ticket path is served.

Console primitives: `Card` (two), `CopyableField` (the address), `InlineAlert` (a failed copy),
`LinkButton` (primary for the e-mail, tertiary router links for the status and the invoices). No
request of its own.

### 4.1 `panel` — the help entry

```text
┌── Aide ────────────────────────────────────────── [×] ──┐
│                                                          │
│ ⚠ Les appels vidéo sont perturbés depuis 14 h 10.        │
│   [ Suivre l'incident ]                                  │
│                                                          │
│ Sur cette page                                           │
│ → Ajouter une adresse à votre nom                        │
│ → Que faire si la vérification échoue                    │
│ → Où trouver les paramètres DNS chez les principaux      │
│   hébergeurs                                             │
│                                                          │
│ ────────────────────────────────────────────────────     │
│ Vous ne trouvez pas ?                                    │
│ [ Écrire à l'équipe ]                                    │
│ Réponse sous 8 heures ouvrées · du lundi au vendredi,    │
│ 9 h – 18 h (Paris)                                       │
│                                                          │
│ Vos demandes en cours (2) →                              │
└──────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Card`, `Banner` (incident,
amber for maintenance and red for an incident), `Status pill` per component, `Button` (primary,
one per screen), `Empty/loading/confirm`.

Console primitives that carry them: `Drawer` (right side, non-modal on desktop, modal on
mobile), `Banner`, article list as `LinkButton` rows, `Button` (primary), `DefinitionList` (SLA
line), `LinkButton` (open tickets count).

**The instance status block.** The delivered Aide screen carries three status lines — Web (Visio,
Docs), Appels (audio, vidéo) and Connexion — always all three, and never a silent "unknown": a
component whose state has not arrived reads "Vérification…". They map to the contract's closed
component keys `web`, `calls` and `identity`, and their labels come from the catalogue, never
from the API's staff-facing `name`.

**Planned maintenance** is stated with its date, its window and the one thing the customer wants
to know: calls already under way are not cut.

### 4.2 `new` — the ticket form

```text
┌───────────────────────────────────────────────────────────────────────────┐
│  Écrire à l'équipe                                              (h1)      │
│                                                                           │
│  De quoi s'agit-il ?                                                      │
│  [ Connexion et comptes                                            ▾ ]    │
│    Connexion et comptes · Appels vidéo · Documents · Adresse et domaine   │
│    · Facturation · Sécurité · Autre                                       │
│                                                                           │
│  Quel est l'impact ?                                                      │
│  ( ) Personne ne peut travailler                                          │
│  (•) Une partie de l'équipe est gênée                                     │
│  ( ) C'est une question, rien n'est bloqué                                │
│                                                                           │
│  Résumé                                                                   │
│  [ Julie ne reçoit pas son invitation                                 ]   │
│                                                                           │
│  Décrivez ce qui se passe                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ Julie Leroy a été invitée hier, elle ne trouve pas l'e-mail,        │  │
│  │ y compris dans les indésirables.                                    │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│  Dites-nous ce que vous avez déjà essayé, cela nous fait gagner du temps. │
│                                                                           │
│  Pièces jointes (facultatif)                                              │
│  [ Déposer une capture d'écran ]   PNG, JPG ou PDF · 10 Mo maximum        │
│                                                                           │
│  ┌── Informations jointes automatiquement ──────────────────────────────┐ │
│  │ ✓ Organisation et formule (ACME Construction, Business)              │ │
│  │ ✓ État de votre espace (actif, appels perturbés)                     │ │
│  │ ✓ Page depuis laquelle vous écrivez (Personnes)                      │ │
│  │ ✓ Référence de la dernière erreur (a3f9-…)                           │ │
│  │ ✓ Navigateur et système (Firefox 141, Windows 11)                    │ │
│  │ Nous n'ajoutons ni le contenu de vos réunions ni vos documents.       │ │
│  │ [ Modifier ce qui est joint ]                                        │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  Réponse attendue sous 8 heures ouvrées. Vous écrivez en dehors des       │
│  heures ouvrées : première réponse attendue lundi avant 17 h.             │
│                                                                           │
│  [ Envoyer la demande ]                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Text field` (summary and
description), `Card` (the attached context), `Button` (primary), `Banner` (the SLA line),
`Empty/loading/confirm`.

Console primitives that carry them: `Form`, `Select` (category), `RadioGroup` (impact, in the
customer's words — the console maps it to a severity), `TextField` (summary), multi-line
`TextField` (body), `FileDrop` (attachments), `Card` with `Checkbox` rows (the attached context,
all ticked, each removable), `InlineAlert` (SLA and out-of-hours line), `Button`.

The context line the delivered design shows — instance, plan, version, region — is composed
**server-side** through `GET /support/ticket-context`, and the customer reads it rather than
types it. Nothing about another person is attached automatically.

**Contract gap.** The design's confirmation names a person ("{contact} vous répond sous {h}
heures ouvrées"). `HelpContext.sla` carries the support tier, the target minutes and the
business hours, and no contact identity. The screen states the promise and the computed
`next_response_due_at` without a name until the contract carries one.

### 4.3 `tickets` — the list

```text
│  Vos demandes                                                   (h1)      │
│  [ En cours ▾ ]                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ #4821  Julie ne reçoit pas son invitation                           │  │
│  │        Connexion · ● En cours · réponse attendue avant 17 h         │  │
│  │ #4795  Facture de mars                                              │  │
│  │        Facturation · ● Répondu · il y a 2 jours                     │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Table` (or a card list on
mobile), `Status pill`, `Empty/loading/confirm`.

Console primitives that carry them: `DataTable`, `StatusPill`, `Select` (filter), `EmptyState`,
`Skeleton`.

### 4.4 `ticket` — the conversation

Messages in order, oldest first, with the author's side made obvious ("Vous" / "Équipe
Kodera"), the attached context collapsed at the top, a reply box, and the SLA state
("réponse attendue avant 17 h" or "en attente de votre réponse").

Components, in the design-system vocabulary of `COMPONENTS.md`: `Card` per message, `Text
field` (reply), `Status pill`, `Button`.

Console primitives that carry them: `Card` per message, `DefinitionList` (collapsed context),
multi-line `TextField`, `FileDrop`, `Button`, `StatusPill`.

### 4.5 `sign-in-problem` — unauthenticated

```text
│  Vous n'arrivez pas à vous connecter ?                          (h1)      │
│  Votre adresse e-mail      [ marie.dupont@acme.fr              ]          │
│  Identifiant de votre organisation (si vous le connaissez)                │
│                            [ acme-sa                           ]          │
│  Que se passe-t-il ?       [                                   ]          │
│  [ Envoyer ]                                                              │
│  Nous vous répondons à cette adresse. Ne nous envoyez jamais votre        │
│  mot de passe.                                                            │
```

Rate-limited, no organisation context attached (there is no session to derive it from), and it
never reveals whether the address or the organisation exists.

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `help` (interim, §4.0) | Address, what to include, subject from the query string, links | n/a — no request of its own | No subject in the query string → the page asks for the page the customer was on | n/a | n/a | n/a | Every role may read it; the invoices link only for owner, admin and billing | The address stays readable as text; the e-mail link opens the mail app |
| `panel` | Incident (if any) + articles + write | `Skeleton` article rows; the write button is available immediately | No article matches this screen → the section is omitted, not shown empty | Article fetch fails → the section is omitted silently and the write button remains | n/a | Articles load, SLA does not → the SLA line is replaced by "Nous vous répondons dès que possible" | Every role may ask for help | Panel opens; articles from cache; the write button is disabled with the reason |
| `new` | Empty form, context ticked | `Skeleton` context card | n/a | Submit fails → the alert keeps every field, offers retry, and gives the support address (support@kodera.io, `src/app/supportContact.ts`) as the fallback | Ticket reference shown, panel closes, `Toast` | Ticket created but an attachment failed → the ticket is shown with a per-file error and a re-upload action | Every role | Submit disabled; the draft is kept in memory |
| `tickets` | Open tickets | `Skeleton` rows | No ticket → `EmptyState` "Aucune demande pour l'instant" + "Écrire à l'équipe" | Fetch fails → retry | n/a | n/a | A member sees only tickets they opened; owners and admins see the organisation's | Cached list, read-only |
| `ticket` | Messages + reply | `Skeleton` messages | No reply yet → the state line says when one is expected | Reply fails → the text is kept, retry offered | Reply appended, `Toast` | Reply sent, attachment failed → the message is posted, the file shows an error and a retry | as above | Reply disabled |
| `sign-in-problem` | Empty form | n/a | n/a | Rate-limited → "Nous avons déjà reçu votre demande" with the wait; submit failure → the mail address | "Nous vous répondons par e-mail" — never confirms the account exists | n/a | n/a | Submit disabled |

## 6. Core API calls

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/support/help-context` | `area`, `screen`, `locale` | `articles[]{ id, title, url }`, `sla{ support_tier, first_response_target_minutes, business_hours_label, business_hours_timezone, next_response_due_at }`, `incident{ id, title_key, component_keys[], next_update_at }` |
| `GET` | `/api/v1/support/ticket-context` | `area`, `screen`, `request_id?` | `items[]{ code, label_key, value_summary, removable }` — exactly what the ticket will carry |
| `POST` | `/api/v1/support/tickets` | `Idempotency-Key`; `subject`, `body`, `category: calls\|documents\|login\|domain\|billing\|capacity\|security\|other`, `severity: question\|degraded\|blocked\|outage`, `organisation_id?`, `tenant_id?`, `contact_email?`, `locale` | `id, state, category, severity, sla{ first_response_target_minutes, first_response_due_at, next_response_due_at, business_hours_label }, tenant_context{…}, external_ref` |
| `POST` | `/api/v1/support/tickets/{ticket_id}/attachments` | `Idempotency-Key`; multipart `file`, `message_id?` | `id, filename, content_type, size_bytes, state: scanning\|available\|rejected, rejection_code` |
| `GET` | `/api/v1/support/tickets` | `cursor`, `limit`, `organisation_id`, `tenant_id`, `state` | `data[]{ id, subject, category, severity, state: open\|pending_customer\|pending_kodera\|solved\|closed, sla{ next_response_due_at }, message_count, last_message_at, external_ref, updated_at }`, `next_cursor` |
| `GET` | `/api/v1/support/tickets/{ticket_id}` | — | As above, plus `tenant_context{ tenant_slug, tenant_status, pack_code, capacity_tier_code, agent_stale, open_incident_component_keys[], last_job_id }` |
| `GET` | `/api/v1/support/tickets/{ticket_id}/messages` | `cursor`, `limit` | `data[]{ id, author_kind: customer\|staff, author_name, body, attachments[]{ id, filename, state, download }, created_at }` |
| `POST` | `/api/v1/support/tickets/{ticket_id}/messages` | `Idempotency-Key`; `body` | `id, author_kind, created_at` |
| `POST` | `/api/v1/support/sign-in-problems` | `Idempotency-Key`; `email`, `organisation_hint?`, `body`, `locale` | `202`, no body |

Notes.

- The console never calls the ticketing system; the Core API owns that integration (ADR-0003).
  `external_ref` is the helpdesk reference and is `null` until the mirror succeeds; the ticket
  exists either way.
- **Context is server-composed, and the client cannot send it.** `ticket-context` returns exactly
  what the ticket will carry, so the checkbox list is truthful, and the ticket's own
  `tenant_context` is recomputed server-side on creation: whatever a client sends for it is
  ignored, because the context is what routes the ticket and sets the SLA.
- `removable: false` marks the items a ticket cannot be routed without — the organisation and the
  tenant — and the console renders those ticked and disabled. **Sending back the removable codes the
  customer kept is not yet in the contract**; until it is, unticking a removable item hides it from
  the screen and the ticket still carries it. This is the open question in
  [`contracts/CONSOLE_RECONCILIATION.md`](https://github.com/kodera-hq/kodera/blob/main/contracts/CONSOLE_RECONCILIATION.md)
  §5.5, and the screen does not ship with a checkbox that lies.
- No context item ever carries meeting content, document content, a room name or a participant
  list. `value_summary` is already redacted by the API.
- **`category` and `severity` replace the earlier `kind` and `impact`.** `severity` is the
  customer's own read; staff may re-grade it, and the SLA follows the graded value. The console does
  not send a severity it invented and does not promise one.
- `next_response_due_at` is computed server-side from the tier's SLA and the business hours,
  including the out-of-hours case; the console renders it, it never computes it. It is `null` while
  the ticket waits on the customer.
- `sign-in-problems` is unauthenticated and answers `202` with no body for every input, valid or
  not, so it cannot be used to test whether an address or an organisation exists.
- An attachment is scanned before it reaches the helpdesk. `state: scanning` is the normal first
  answer; a `rejected` attachment carries a `rejection_code` and never costs the customer their
  message, because the ticket exists before the attachment does.

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `support.articles-for-domain` | `help-context` with `area=domain` returns three articles |
| `support.no-articles` | `help-context` returns an empty `articles[]` |
| `support.incident-open` | `help-context` returns an `incident` on `calls` |
| `support.sla-business` | `sla.first_response_target_minutes: 480`, `business_hours_label` 09:00-18:00 Europe/Paris |
| `support.sla-out-of-hours` | `sla.next_response_due_at` on the following Monday morning |
| `support.context-full` | `ticket-context` returns five `items[]`, two with `removable: false` |
| `support.ticket-created` | `POST /support/tickets` returns `external_ref` and a populated `sla` |
| `support.ticket-mirror-pending` | `POST /support/tickets` returns `external_ref: null`; the ticket exists |
| `support.attachment-failed` | Ticket created, `attachments` returns `413` `payload-too-large` |
| `support.attachment-scanning` | `attachments` returns `state: scanning` for two polls, then `available` |
| `support.tickets-empty` | `support/tickets` returns an empty page |
| `support.tickets-two-open` | Two tickets, one `pending_customer`, one `pending_kodera` |
| `support.submit-failed` | `POST /support/tickets` returns `503` `service-unavailable` |
| `support.sign-in-rate-limited` | `sign-in-problems` returns `429` with `retry_after_s` |

## 8. Validation rules

| Field | Rule | When | Copy key |
|---|---|---|---|
| Category | Required | On submit | `console.support.new.error-category-required` |
| Impact | Required | On submit | `console.support.new.error-impact-required` |
| Summary | Required, 5–120 characters | On blur | `console.support.new.error-subject-required` |
| Body | Required, ≥ 20 characters | On blur | `console.support.new.error-body-too-short` |
| Body | ≤ 10 000 characters, counter after 9 000 | On input | `console.support.new.error-body-too-long` |
| Body | If it looks like a password or a token was pasted (a long high-entropy string), a non-blocking warning appears | On blur | `console.support.new.hint-secret-detected` |
| Attachment | PNG, JPG, PDF, TXT, LOG | On drop | `console.support.new.error-file-type` |
| Attachment | ≤ 10 MB each, ≤ 5 files | On drop | `console.support.new.error-file-too-large` |
| Context items | At least the organisation stays attached (non-removable) | Enforced by `removable: false` | `console.support.new.hint-context-required` |
| Reply | Required, ≥ 1 character | On submit | `console.support.ticket.error-reply-required` |
| Sign-in email | Required, valid | On submit | `console.support.signin.error-email-required` |
| Sign-in submissions | At most 3 per hour per address | Server | `console.support.signin.error-rate-limited` |

## 9. Error copy rules

Cause, then next action. Support copy has one extra duty: it must never leave the person without
a way to reach a human. Every failure on this screen ends with the support email address.

| Problem `type` suffix, or condition | Copy key | Next action |
|---|---|---|
| `service-unavailable` or `upstream-unavailable` on `POST /support/tickets` | `console.support.new.error-submit-failed` | Retry, then the support address (support@kodera.io, `src/app/supportContact.ts`) with the summary kept |
| `payload-too-large` on an attachment | `console.support.new.error-file-too-large` | Names the limit from `detail`; the ticket is already created |
| `unsupported-media-type`, or `state: rejected` with a `rejection_code` | `console.support.ticket.error-attachment-failed` | Retry the file, or send it by email quoting `external_ref` |
| `not-found` on a ticket | `console.support.ticket.error-not-found` | Back to the list |
| `conflict` on a reply to a `closed` ticket | `console.support.ticket.error-closed` | Open a new ticket; it references this one |
| `rate-limited` on `sign-in-problems` | `console.support.signin.error-rate-limited` | Wait, with the countdown; the email address |
| `service-unavailable` | `console.common.error-unavailable` | the support address (support@kodera.io, `src/app/supportContact.ts`) |

Ticket states map to the console's words: `pending_customer` is "En attente de votre réponse",
`pending_kodera` is "Réponse en cours", `solved` is "Résolu" and stays reopenable by replying.

Out-of-hours copy is never an apology: "Vous écrivez en dehors des heures ouvrées : première
réponse attendue lundi avant 17 h." — and the instant comes from `sla.next_response_due_at`.

Incident copy in the panel offers following the incident **before** offering a ticket, and never
prevents the ticket.

## 10. Accessibility

- The help panel is a `Drawer` labelled "Aide". On desktop it is non-modal: focus moves into it,
  but the page behind stays operable and `Escape` returns focus to the `[?]` button. On mobile it
  is modal and traps focus.
- `Alt+/` opens the panel from anywhere and is announced in the panel's own footer as the way to
  reopen it; the shortcut is disabled while a text field has focus and the user is typing a
  combination the browser owns.
- **Focus order (`new`):** `h1` → category → impact radio group → summary → body → attachments →
  context checkboxes → submit. The SLA sentence is the accessible description of the submit
  button, so a screen-reader user hears the promise before activating it.
- The context card is a `fieldset` with a legend; each item is a checkbox whose label reads as a
  sentence ("Joindre l'état de votre espace : actif, appels perturbés"). The non-removable item is
  rendered as text with an explanation, not as a disabled checkbox.
- Submission announces the reference in a polite region and moves focus to the confirmation
  heading; the reference is selectable text, not only inside a toast.
- The ticket conversation is a list with each message as an `article` carrying its author and
  time in the accessible name; new messages are announced politely once.
- File errors are attached to the file row via `aria-describedby`, never only as a toast.
- The impact radio group uses the customer's sentences as labels; the severity mapping is never
  exposed.
- Reduced motion: the drawer appears without a slide.

## 11. Analytics events

No personal data: no ticket body, no subject, no email, no attachment names.

| Event | Properties |
|---|---|
| `help_panel_opened` | `area`, `screen`, `source` (`button` \| `shortcut` \| `nav` \| `error`) |
| `help_article_opened` | `article_id`, `area` |
| `help_incident_followed` | `component` |
| `support_ticket_started` | `area`, `screen`, `about` |
| `support_context_item_removed` | `code` |
| `support_ticket_submitted` | `category`, `impact`, `attachment_count`, `has_request_id` |
| `support_ticket_failed` | `reason` |
| `support_secret_warning_shown` | — |
| `support_tickets_viewed` | `open_count` |
| `support_reply_sent` | `days_since_last_message_bucket` |
| `support_signin_problem_submitted` | `has_organisation_hint` (bool) |

## 12. Acceptance tests

Tests 1–10 describe the panel and the ticket form (§4.1–4.5) and wait for the ticket write path to
be served. Tests 11–13 describe the interim page (§4.0) and run today in
`tests/e2e/06-support.spec.ts`.

1. **Given** the buyer is on the domain screen with articles available
   (`support.articles-for-domain`),
   **when** they open help,
   **then** the panel offers the three articles for that screen before offering to write, and the
   response time is stated with the business hours.
   `support/panel: offers the articles for the current screen before the form`

2. **Given** an open incident on calls (`support.incident-open`),
   **when** the panel opens,
   **then** the incident is stated first with a way to follow it, and writing a ticket is still
   possible.
   `support/panel: surfaces the incident first without blocking a ticket`

3. **Given** the context endpoint returns five items with one non-removable
   (`support.context-full`),
   **when** the form loads,
   **then** every attached item is listed in plain French, the organisation cannot be removed and
   says why, the others can be unticked, and the sentence about meeting and document content is
   present.
   `support/new: shows exactly what is attached and lets the user remove what is optional`

4. **Given** an out-of-hours submission (`support.sla-out-of-hours`),
   **when** the form is shown,
   **then** it states the day and time of the first expected response rather than only the hour
   count.
   `support/new: states when the answer will come outside business hours`

5. **Given** a valid ticket (`support.ticket-created`),
   **when** it is submitted,
   **then** the reference is shown as selectable text, the response deadline is repeated, and the
   ticket appears in the list.
   `support/new: confirms a ticket with a reference and a deadline`

6. **Given** the ticket is created but the attachment fails (`support.attachment-failed`),
   **when** the submission completes,
   **then** the ticket is confirmed, the file row shows its own error with the limit named, and a
   retry is offered for that file only.
   `support/new: keeps the ticket when an attachment fails`

7. **Given** the submission fails entirely (`support.submit-failed`),
   **when** the buyer submits,
   **then** every field is preserved, a retry is offered, and the support email address is given
   as a fallback.
   `support/new: never loses a written request when submission fails`

8. **Given** a long high-entropy string is pasted in the body,
   **when** the field loses focus,
   **then** a non-blocking warning suggests removing what looks like a password or a key, and
   submission is still possible.
   `support/new: warns about a pasted secret without blocking`

9. **Given** a user on the login screen who cannot sign in
   (`support.sign-in-rate-limited` for the second attempt),
   **when** they submit the unauthenticated form twice,
   **then** the first submission confirms only that an email will be sent, and the second states
   that the request was already received, neither confirming nor denying that the account exists.
   `support/signin: answers without revealing whether the account exists`

10. **Given** a keyboard-only user,
    **when** they open help with the shortcut, read an article title, return, and submit a
    ticket,
    **then** focus enters the panel, `Escape` returns it to the help button, and the response
    promise is announced as part of the submit button's description.
    `support/panel: opens, closes and submits with the keyboard alone`

11. **Given** each support action the console renders, in the state that shows it — the sidebar,
    Home's support card, the capacity cards, the lifecycle and provisioning states, the stale
    heartbeat, the incident drawer, the dunning drawer, an invoice, a failed payment link and the
    subscription,
    **when** the customer uses it,
    **then** the Aide page opens with the support address, never the placeholder, and repeats the
    subject the action carried.
    `support/help: every support action lands on the Aide page`

12. **Given** a customer who arrives from an invoice,
    **when** the page loads,
    **then** it gives the address as text and as a copyable field, asks for the organisation, the
    subject and the question — not the time of a problem — names the invoice as the subject, and
    its e-mail link opens a message to that address with the organisation and the invoice already
    written.
    `support/help: gives the address, what to include and the context the action carried`

13. **Given** a member who arrives with a query string the page does not recognise,
    **when** the page loads,
    **then** it states no response time, business hours or phone number, repeats nothing from the
    query string, and offers no link to invoices.
    `support/help: states no response time, hours or phone number it cannot source`

## 13. Out of scope for launch

- Live chat and a callback request; support is asynchronous at launch.
- A public, searchable knowledge base inside the console; articles link out.
- Customer-facing SLA credit claims filed from the console; credits are claimed by email per the
  SLA schedule.
- Satisfaction surveys after a ticket.
- Screen recording or session replay attached to a ticket — excluded by the no-personal-data
  rule, not deferred.
- Ticket sharing with a non-member (the accountant, the web agency) — planned after launch.
- One-click export and delete of the organisation's data (planned after launch).

## Changelog

- The support team's side of a ticket is labelled « Équipe Kodera » (§4.4), the product's name
  (UX audit OL-14).

- Interim Aide page, review round (, owner ruling): the address is also a copyable
  field and the e-mail hint is conditional; what the page and the e-mail ask for follows the
  subject (problem, question, none); the instance-state actions carry `state` and the order
  confirmation `topic=order`; `category` is dropped (it was never read); every support action
  builds its link through `helpHref` / `HelpLink`, as a router link where it is a link; the status
  link's hint is true on every visit; no external status page anywhere.
- Interim Aide page (§4.0), owner ruling: every support action lands on a page that
  gives the support address as text and as a pre-written e-mail, what to include, the subject the
  action carried, and links to the status and the invoices, instead of the "Cette page n'est pas
  encore disponible" placeholder (UX audit SI-04, OL-16, SH-05). No ticket form: the contract
  declares the write path but the Core API does not serve it yet. The capacity cards' "Nous en
  parler" now carries `topic=capacity` rather than `reason=incident`, and the dunning drawer
  carries `topic=dunning`.

- The support fallback is the console's one support address, support@kodera.io (owner decision
  current baseline), held in `src/app/supportContact.ts` and passed to the copy as `{email}`.

- Aligned with the delivered design: the three always-present instance status lines with
  "Vérification…" instead of a silent unknown, the planned-maintenance sentence, the
  server-composed context line, the design-system component names, and the contract gap behind
  the named support contact.

- Initial version: contextual help panel, ticket form with server-composed and user-editable
  context, SLA statement including out-of-hours, ticket list and conversation, unauthenticated
  sign-in problem form.
- Reconciled with the Core API contract: `category` and `severity` replace `kind` and `impact`,
  ticket states move to `TicketState`, `next_response_by` becomes `sla.next_response_due_at`,
  messages move to their own cursor-paginated collection, and the context a ticket carries is
  recomputed server-side — the user-editable half of it is an open question, recorded as such
  rather than specified as if it worked.

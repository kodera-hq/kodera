# 05 — Invoices

**Status:** Proposed · **Owner:** zôÖma

## 1. Goal

Let the person who pays find every invoice, download it for their accountant, pay the one that
is due, and understand — before anything is cut off — what happens if they do not.

## 2. Persona and the "can the CEO do this alone" test

**Who.** Two people: the CEO, who wants to know what they are paying and whether it is settled,
and the accountant or office manager, whose job is to download a PDF, file it, and pay it. In a
120-person organisation these are rarely the same person and the accountant often has no console
account — so the billing contact receives every invoice by email as well.

**Alone test: pass**, on four conditions.

1. Every invoice is downloadable as a PDF in one click from the list, without opening the detail.
2. The amount shown in the list is the amount to pay, tax included, in the same format as the
   invoice itself. A VAT-exempt or reverse-charge invoice states its regime in words on the row.
3. The payment action is honest about the method. At launch there is no card on file: the button
   opens a one-off payment page, and paying by transfer is always offered next to it, because
   most organisations of this size pay by transfer. Until the invoice contract carries the
   issuer's bank details (0.12.0), the transfer details are the PDF's, and the screen says so
   rather than opening a dialog with none in it (§4.3).
4. Overdue is explained, not just coloured. The row says how many days late, what the next step
   is, and on what date. The dunning ladder is never a surprise.

**Where it still fails.** The accountant cannot get a console account without becoming an
organisation member. At launch they are added as the billing contact and receive the emails;
a billing-only role is a known gap, planned after launch.

## 3. Entry points

| Entry | URL |
|---|---|
| Navigation "Facturation" | `/{org}/invoices` |
| From Accueil, the next-invoice card | `/{org}/invoices` |
| An invoice | `/{org}/invoices/{invoiceId}` |
| From the status screen "Voir mes factures" | `/{org}/invoices` |
| From the order confirmation | `/{org}/invoices/{invoiceId}?from=order` |
| From the dunning banner | `/{org}/invoices/{invoiceId}#pay` |
| From an invoice email | `/{org}/invoices/{invoiceId}?from=email` |
| Plans and current subscription | `/{org}/invoices/subscription` |

## 4. Screens

### 4.1 `list`

The current summary layout follows [`billing-summary-blocks.md`](billing-summary-blocks.md):
subscription facts beside per-invoice payment guidance and a read-only billing address, stacking
at narrow widths. The address is read from `GET /organisations/{organisation_id}` only inside
the existing Billing role guard. Its loading, absent, invalid and retry states do not block
invoice actions. The profile response is bound to the requested organisation before rendering.
No recurring mandate, event-pack sale or inert address-edit control is implied.


```text
┌───────────────────────────────────────────────────────────────────────────────┐
│  Factures                                                          (h1)       │
│                                                                               │
│  ⚠ La facture F-2026-0142 est en retard de 12 jours. Sans règlement avant     │
│    le 5 avril 2027, l'accès sera suspendu.        [ Payer 4 838,40 € ]        │
│                                                                               │
│  ┌── Votre abonnement ──────────────────────────────────────────────────┐     │
│  │ Business + Docs · facturé annuellement                                │     │
│  │ 403,20 € par mois, soit 4 838,40 € par an HT                          │     │
│  │ Prochaine facture : 1er mars 2027        [ Changer de formule ]       │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  [ Toutes ▾ ]                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │ Numéro        Date            Montant TTC   État              Actions │    │
│  ├───────────────────────────────────────────────────────────────────────┤    │
│  │ F-2026-0142   1 mars 2027     5 806,08 €    ● En retard 12 j  [PDF]⋯ │    │
│  │ F-2026-0098   1 mars 2026     5 806,08 €    ● Payée           [PDF]⋯ │    │
│  │ F-2026-0071   12 janv. 2026     594,00 €    ● Payée           [PDF]⋯ │    │
│  │ A-2026-0003   14 janv. 2026    −594,00 €    ● Avoir           [PDF]⋯ │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                              [ Afficher 25 de plus ]          │
└───────────────────────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Banner` (dunning, only when
there is an overdue invoice), `Card` (subscription summary), `Table` (invoice numbers and
amounts in monospace with tabular figures, fixed status column), `Status pill` per state,
`Button`, `Empty/loading/confirm`.

Console primitives that carry them: `Banner`, `Card` with `DefinitionList` and `LinkButton`,
`Select` (state filter), `DataTable`, `StatusPill` per state, `Button` (PDF), row menu (`⋯`:
"Payer en ligne", "Voir le détail"; "Coordonnées bancaires" returns with §4.3), `Pagination` (cursor),
`EmptyState`, `Skeleton`.

Two lines the delivered design puts on this screen and that are facts, not decoration:

- **How payment works until direct debit exists.** Automatic direct debit is planned after
  launch; until then every invoice carries a card or bank-transfer payment link. The sentence
  names no quarter: a date hard-coded in the front end is the "bientôt with a date attached"
  that the design gaps in `02-status.md` and `08-home.md` refuse, and §13 words the same
  deferral for this screen.
- **Who issues the invoice.** Invoices are issued by Samouraï Coop through its banking provider
  in the Factur-X format, which is what a French accountant needs to know before importing them.

An overdue invoice is a red row and a `Banner` with the customer's own dates, in a neutral
voice. The escalation language belongs to the dunning ladder and to the emails, never to this
list.

- The banner's first line says how late the invoice is. It states a day count only when
  `days_overdue` is sent ("en retard de paiement" otherwise, never "0 jours"), and the invoice
  number only when it has one ("Une facture …" otherwise, never its id).
- The second line says what happens next, and only when it is true now. The suspension sentence
  ("Sans règlement avant le {date}, l'accès sera suspendu.") appears only when the ladder carries a
  `suspended` step that is not done and is dated in the future; a past date is never stated as a
  threat.
- While `hold_until` is set and still ahead, a billing dispute has frozen the ladder: the second
  line names the dispute and the date reminders resume (`console.invoices.list.detail-hold`), the
  banner is an information banner, the pay action is secondary, and no suspension is stated. The
  "Échéances de règlement" drawer shows every step not yet done — reminders, the formal notice and
  its penalties, the suspension notice, the suspension — as "En pause" during the dispute, with no
  date, and marks no step as in progress. A `hold_until` already past is over and is never shown.
- A `days_overdue` of 0 is "late today": the banner and the row pill take the no-count wording
  ("en retard de paiement", "En retard"), never "0 jours".

### 4.2 `detail`

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│  ← Factures                                                                   │
│  Facture F-2026-0142                                              (h1)        │
│  ● En retard de 12 jours · échéance le 31 mars 2027                           │
│                                                                               │
│  ┌── À régler ─────────────────────────────────────────────────────────┐      │
│  │ 5 806,08 € TTC                                                       │      │
│  │ [ Payer en ligne ]                                                   │      │
│  │ Le paiement en ligne accepte la carte et le prélèvement SEPA         │      │
│  │ ponctuel. Vous serez redirigée vers notre prestataire de paiement.   │      │
│  │ Vous pouvez aussi régler par virement : les coordonnées figurent     │      │
│  │ sur la facture PDF.                                                  │      │
│  └─────────────────────────────────────────────────────────────────────┘      │
│                                                                               │
│  ┌── Détail ───────────────────────────────────────────────────────────┐      │
│  │ Abonnement Business — 1 mars 2027 → 28 févr. 2028   4 838,40 € HT   │      │
│  │   dont Docs                                          1 188,00 € HT   │      │
│  │ Remise annuelle −10 %                                    incluse     │      │
│  │ ────────────────────────────────────────────────────────────────     │      │
│  │ Total HT                                             4 838,40 €      │      │
│  │ TVA 20 %                                               967,68 €      │      │
│  │ Total TTC                                            5 806,08 €      │      │
│  └─────────────────────────────────────────────────────────────────────┘      │
│                                                                               │
│  Émise le 1 mars 2027 · Référence bon de commande : ACH-2027-118              │
│  [ Télécharger le PDF ]                                                       │
│                                                                               │
│  Un problème avec cette facture ? [ Nous écrire ]                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Status pill`, `Card`,
`Table`, `Copy-value block` (bank details), `Button`.

Console primitives that carry them: `Breadcrumb`, `StatusPill`, `Card` ("À régler", hidden when paid), `Button`
(payment link, opens the PSP in a new tab), the transfer sentence
(`console.invoices.detail.hint-transfer`) where a bank-details `Button` will return with §4.3,
`Table` (lines), `DefinitionList` (totals), `Button` (PDF), `Button` (support with the invoice
number attached).

### 4.3 `bank-details` (dialog) — withheld until contract 0.12.0

**Not offered today** (, owner ruling). The Core API returns no IBAN, no BIC and no
holder (§6), so the dialog could show only the reference and a sentence sending the customer to
the PDF — and when the payment link failed it was promoted to the primary way to pay, under an
error that said the details were "ci-dessous" (UX audit SI-12). Until the issuer's bank details
become an invoice field in contract 0.12.0, the list and the detail offer no bank-details action,
the detail says the transfer details are on the PDF, and the payment-link failure points to the
PDF and to support (§5). No bank data is written into the front end. The dialog below returns,
filled from the contract, with 0.12.0.

```text
┌── Coordonnées bancaires ───────────────────────────────────┐
│ Titulaire   Samouraï Coop                    [ Copier ]    │
│ IBAN        FR76 ****  ****  ****  ****      [ Copier ]    │
│ BIC         QNTOFRP1                         [ Copier ]    │
│ Référence   F-2026-0142                      [ Copier ]    │
│                                                            │
│ Indiquez la référence pour que le règlement soit           │
│ rapproché automatiquement.                                 │
│ [ Copier tout ]                              [ Fermer ]    │
└────────────────────────────────────────────────────────────┘
```

### 4.4 `subscription`

Current plan, capacity, add-ons, billing period, renewal date, the price change rule ("nos tarifs
changent au plus une fois par an, avec 60 jours de préavis"), and one action, "Changer de
formule", which opens a quote request rather than a self-serve change at launch.

The delivered design writes the card as four facts and one list: the monthly amount excluding
VAT, the next charge date, the commitment end date, and what is included — concurrent
participants, Docs, thirty-day backups, the support response time and the 99,5 % service
commitment with its credits. Every one of those is read from the subscription's frozen
`price_snapshot`, `next_invoice_at` and `current_period_end`, so the card cannot drift from the
invoice.

**Changing tier**, once it is self-serve, follows the design's two rules and they are recorded
here now so the quote conversation matches the future screen: an increase takes effect
immediately and its pro-rata amount is shown **before** confirmation; a decrease takes effect at
the end of the commitment and the screen shows that date and no immediate amount. The
`price_change_notice_days` the contract returns is what the notice sentence uses.

### 4.5 `dunning-detail` (drawer, from the banner)

The ladder, rendered as a timeline with the customer's own dates and only the steps that are
still ahead. A step not marked done whose date has already passed reads "En cours" (the ladder has
reached it), never "À venir"; during a dispute hold every step not done reads "En pause", undated
(§4.1):

```text
┌── Échéances de règlement ──────────────────────── [×] ──┐
│ Échéance dépassée le 31 mars 2027                       │
│ ✅ 7 avril — rappel envoyé                              │
│ ⏳ 21 avril — second rappel                             │
│ ○  5 mai — mise en demeure, pénalités de retard et      │
│    indemnité forfaitaire de 40 €                        │
│ ○  30 mai — préavis de suspension (7 jours)             │
│ ○  6 juin — suspension des connexions. Vos données      │
│    sont conservées, les réunions en cours se terminent  │
│    normalement.                                         │
│                                                         │
│ Le règlement rétablit l'accès sous un jour ouvré.       │
│ [ Payer maintenant ]        [ Nous écrire ]             │
└─────────────────────────────────────────────────────────┘
```

Components, in the design-system vocabulary of `COMPONENTS.md`: `Provisioning timeline` (the
ladder, one row per step with its date), `Button` ×2.

Console primitives that carry them: `Drawer`, `ProgressList` (dates), `Button` ×2.

**Contract gaps.** Three things the delivered design shows here and the contract does not carry.

| What the design asks for | Why the contract cannot answer it today | What the screen does meanwhile |
|---|---|---|
| **Self-serve tier change** with a pro-rata amount quoted before confirmation | No plan-change operation exists; `Subscription` is read-only to the console | "Changer de formule" opens a quote request, and the two effective-date rules above are stated in the reply |
| **Event pack** as a one-off add-on | `Price` and `OrderRequest` carry no add-on or one-off line | A support request at launch |
| **Payment-method management** (SEPA mandate, last four digits) | `PaymentLink` is per invoice; no stored payment method exists | The card states how payment works today and that direct debit arrives after launch |

## 5. State matrix

| Screen | Default | Loading | Empty | Error | Success | Partial failure | Permission denied | Offline |
|---|---|---|---|---|---|---|---|---|
| `list` | Subscription card + rows | `Skeleton` card and rows | No invoice yet (order placed, invoice pending) → `EmptyState` "Votre première facture arrive" with the expected date | Fetch fails → table error with retry; the subscription card retries independently | New row appears after a payment is recorded | Invoices load, subscription card fails → the card shows its own error, the table works | `member` does not see the area; direct URL shows the role banner naming the owner | Banner; rows readable from cache, PDF and payment disabled |
| `detail` | Amount, lines, actions | `Skeleton` | n/a | Not found → "Cette facture n'existe pas ou ne vous appartient pas" + back to the list | Payment recorded → the state pill and the "À régler" card update on return | Invoice loads but the PDF link is missing → the lines are shown, the PDF button is disabled with the reason and support is offered | as above | Actions disabled |
| payment | Button ready | Button busy while the link is created | n/a | Link creation fails → the PDF, which carries the transfer details, is promoted to the primary action and comes first, then "Nous écrire" (support, with the invoice number), then a retry; the PDF button under the totals is not repeated while the card offers it; with no PDF either, support is the primary action | New tab opens at the PSP; the console shows "Paiement en cours ?" with a "J'ai payé" refresh | The customer returns without paying → the state is unchanged and the console says nothing was recorded, without accusing them | as above | Payment disabled with the reason |
| `bank-details` | Withheld until contract 0.12.0 (§4.3); then four copyable lines | n/a | n/a | n/a | Copy announced | n/a | as above | Opens from cache |
| `subscription` | Plan summary | `Skeleton` | n/a | Fetch fails → retry | n/a | n/a | as above | Read-only |
| `dunning-detail` | Ladder with dates | `Skeleton` | Not overdue → the drawer is not reachable | Dates unavailable → the generic ladder without dates | n/a | n/a | as above | Cached |

**Payment return.** The PSP redirects back to `/{org}/invoices/{id}?payment=return`. The console
does **not** conclude anything from that parameter; it refetches the invoice and shows whatever
the Core API says, with a "le règlement peut mettre quelques minutes à apparaître" line when the
state is still unpaid.

## 6. Core API calls

| Method | Path | Fields sent | Fields read |
|---|---|---|---|
| `GET` | `/api/v1/organisations/{organisation_id}/invoices` | `cursor`, `limit`, `state` | `data[]{ id, number, state: draft\|issued\|paid\|overdue\|void\|credited, issued_at, due_at, paid_at, currency, vat_regime, total_excl_vat{ amount_minor, currency }, vat_amount{…}, total_incl_vat{…}, amount_due{…}, pdf_available }`, `next_cursor`, `has_more` |
| `GET` | `/api/v1/invoices/{invoice_id}` | — | As above, plus `lines[]{ description, quantity, unit_amount_excl_vat{…}, total_excl_vat{…}, vat_rate_bp, period_start, period_end }`, `subscription_id`, `order_id`, `external_ref` |
| `GET` | `/api/v1/invoices/{invoice_id}/download` | — | `url, expires_at, content_type, filename, sha256, size_bytes` — a short-lived pre-signed link the console opens |
| `GET` | `/api/v1/invoices/{invoice_id}/payment-link` | — | `id, url, state, amount{…}, expires_at`, or `404` when none is active |
| `POST` | `/api/v1/invoices/{invoice_id}/payment-link` | `Idempotency-Key`; `return_url`, `locale` | Same; an invoice that already has an active link returns that link unchanged |
| `GET` | `/api/v1/organisations/{organisation_id}/subscriptions` | `state=active` | `data[]{ id, state, plan_code, pack_code, capacity_tier_code, billing_period, price_snapshot{ unit_amount_excl_vat, total_incl_vat, vat_regime, vat_rate_bp }, current_period_start, current_period_end, next_invoice_at, price_change_notice_days }` |
| `GET` | `/api/v1/organisations/{organisation_id}/dunning` | — | `state`, `ladder: invoice\|card`, `oldest_overdue_invoice_id`, `days_overdue`, `amount_due{…}`, `hold_until`, `steps[]{ state, due_at, done, message_key }` |
| `POST` | `/api/v1/support/tickets` | `Idempotency-Key`; `category: billing`, `severity`, `subject`, `body`, `organisation_id`, `locale` | `id, state, sla{ first_response_target_minutes, first_response_due_at, next_response_due_at }, external_ref` |

Notes.

- Money is always a `{amount_minor, currency}` object; the console formats and never sums. The
  totals on screen are the API's totals: `total_excl_vat`, `vat_amount`, `total_incl_vat` and
  `amount_due`.
- The VAT sentence is rendered from `vat_regime` (`fr_standard`, `eu_reverse_charge`, `exempt`,
  `outside_eu`) through the message catalogue, not from a server sentence. The exact legal wording
  printed on the document is snapshotted on the invoice itself, which is the PDF's job.
- **The PDF is a link, not bytes.** `GET /invoices/{invoice_id}/download` returns a pre-signed URL
  valid for a few minutes; the API never proxies document bytes, and each issuance is audited.
  `pdf_available` says in advance whether the link will resolve.
- **The bank-transfer details are not returned by the API.** The IBAN, the BIC and the transfer
  reference are printed on the invoice PDF, which is where a payer copies them from and where they
  are legally required to be. The console links to the PDF instead of restating them.
- `dunning.state` is the billing model's ladder: `current`, `past_due`, `notice`, `formal_notice`,
  `suspension_notice`, `suspended`, `terminated`. Two email reminders are the same `notice` state at
  different ages; `days_overdue` is what tells them apart, and `steps[]` carries the whole ladder so
  the screen can say what happens next and when.
- Dunning is read from the subscription, never from the tenant status, and the console never infers
  one from the other.
- The console never talks to the payment provider or to the banking provider; it only opens the
  link the Core API returns (ADR-0003).

## 7. MSW scenario overlays

| Overlay | Deviation |
|---|---|
| `invoices.empty` | An active subscription with `next_invoice_at` set, `invoices` returns an empty page |
| `invoices.paid-history` | Six invoices in `state: paid` over two cursor pages |
| `invoices.overdue` | One invoice `overdue`, `dunning.days_overdue: 12`, `dunning.state: notice` |
| `invoices.suspension-imminent` | `dunning.state: suspension_notice`, the next `steps[]` entry due in seven days |
| `invoices.credit-note` | One invoice `state: credited` and a line with a negative `amount_minor` |
| `invoices.reverse-charge` | `vat_regime: eu_reverse_charge`, `vat_amount.amount_minor: 0` |
| `invoices.payment-link-failed` | `POST /invoices/{id}/payment-link` returns `502` `upstream-unavailable` |
| `invoices.payment-return-pending` | After the return the invoice is still `issued` and `amount_due` is unchanged |
| `invoices.pdf-missing` | `pdf_available: false`; `download` returns `404` |
| `invoices.dunning-hold` | `dunning.hold_until` set while a billing dispute is open; the banner names the hold and states no suspension, and the drawer shows the suspension as held |
| `invoices.member-role` | Caller is `member`; the area is not reachable |

## 8. Validation rules

The area is read-only apart from two actions; validation is therefore about what is offered:

| Rule | Behaviour | Copy key |
|---|---|---|
| Payment offered only when `payment.available` and state is `open` or `overdue` | Otherwise the button is absent, not disabled | — |
| A `draft` invoice is never listed | Filtered client-side as a safety net; the API should not return it | — |
| A credit note never offers payment | Its row shows the negative amount and "Avoir" | `console.invoices.list.status-credit-note` |
| A `void` invoice shows as "Annulée" and keeps its PDF | | `console.invoices.list.status-void` |
| `days_overdue` present but state is not `overdue` | Trust `state`, ignore the count | — |
| Amounts are rendered from minor units with `currency`; a missing currency blocks rendering of that row | Row shows "Montant indisponible" and the PDF | `console.invoices.list.error-amount-unavailable` |
| Bank reference | Always the invoice number; copied with the details once §4.3 returns | `console.invoices.bank.hint-reference` |

## 9. Error copy rules

Cause, then next action. Money copy never apologises vaguely: it says what is not available and
what the customer can still do (there is always the PDF, and there is always a transfer).

| Problem `type` suffix, or condition | Copy key | Next action |
|---|---|---|
| `not-found` on an invoice | `console.invoices.detail.error-not-found` | Back to the list |
| `pdf_available: false` | `console.invoices.detail.error-pdf-unavailable` | Support with the invoice number; no retry is offered beside a disabled button |
| The download link cannot be issued (`not-found`, `upstream-unavailable`), a transient failure | `console.invoices.detail.error-pdf-download-failed` (toast, list and detail) | Retry, then support with the invoice number |
| `upstream-unavailable` on the payment link | `console.invoices.detail.error-payment-link` | Download the PDF and pay by transfer with the details on it, or write to support; retry |
| `upstream-unavailable` on the payment link, and no PDF | `console.invoices.detail.error-payment-link-no-pdf` | Write to support with the invoice number; retry |
| The invoice is still `issued` after a payment return | `console.invoices.detail.hint-payment-pending` | Wait a few minutes and refresh; not phrased as a failure |
| `conflict` on a payment link for an invoice already `paid` | `console.invoices.detail.hint-already-paid` | Nothing; the state updates |
| `payment-required` anywhere in the console | `console.invoices._.banner-suspended` | The invoice and its payment link, with the restoration delay stated |
| `forbidden` | `console.invoices._.error-role` | Ask the owner |
| `service-unavailable` | `console.common.error-unavailable` | Retry, support |

Dunning copy is factual and dated, never threatening: it states the date, the consequence, and
that paying restores access within one business day. Suspension copy always states that data is
kept.

## 10. Accessibility

- The invoice table is a real `table` with a caption, column headers, and the invoice number as
  the row header. Amounts are right-aligned with `tabular-nums` and carry an accessible text that
  spells the currency.
- The state pill pairs an icon and text; "En retard de 12 jours" is text, not a colour.
- **Focus order (`list`):** `h1` → dunning banner action → subscription card action → filter →
  table (per row: number link, PDF button, row menu) → "load more".
- **Keyboard map:** `Enter` on a row's number opens the detail; `Escape` closes the bank-details
  dialog and the dunning drawer, returning focus to the trigger; the row menu is arrow-navigable.
- The PDF button announces that it downloads a file ("Télécharger le PDF de la facture
  F-2026-0142"). Downloads never open in the same tab.
- The payment button announces that it opens a new tab and leaves the console for the payment
  provider, in its accessible name.
- The bank-details dialog, once it returns with §4.3: focus lands on the heading, each copy
  button names its field, and "Copier tout" announces what was copied.
- Totals are a `DefinitionList` so each amount is read with its label; the tax line reads the
  rate.
- The dunning ladder is an ordered list with each step's state as text; only the transitions are
  announced, never on every render.
- Long invoice numbers and IBANs wrap rather than overflow; the table scrolls inside its own
  container on small screens.

## 11. Analytics events

No personal data and **no amounts**: amounts are bucketed, never carried raw; no invoice number,
no organisation name.

| Event | Properties |
|---|---|
| `invoices_viewed` | `count_bucket`, `has_overdue` (bool) |
| `invoice_opened` | `state` |
| `invoice_pdf_downloaded` | `state` |
| `invoice_payment_started` | `method`, `state` |
| `invoice_payment_link_failed` | `reason` |
| `invoice_payment_returned` | `state_after` (`paid` \| `open`) |
| `invoice_bank_details_opened` | — (with §4.3) |
| `invoice_bank_details_copied` | `scope` (`field` \| `all`) (with §4.3) |
| `dunning_banner_shown` | `dunning_state` |
| `dunning_detail_opened` | `dunning_state` |
| `subscription_change_requested` | `current_tier` |

## 12. Acceptance tests

1. **Given** an overdue invoice (`invoices.overdue`),
   **when** the list loads,
   **then** one banner states the number of days late and the date access would be suspended, the
   row says the same in text, and the payment action carries the amount.
   `invoices/list: states how late an invoice is and what happens next`

2. **Given** a history of paid invoices (`invoices.paid-history`),
   **when** the list loads,
   **then** every row offers a PDF download without opening the detail, and loading the second
   page keeps the first page's rows.
   `invoices/list: downloads any invoice as a PDF from the list`

3. **Given** a reverse-charge invoice (`invoices.reverse-charge`),
   **when** the detail loads,
   **then** the VAT line shows zero with the reverse-charge sentence rendered verbatim, and the
   total incl. tax equals the total excl. tax.
   `invoices/detail: renders the VAT regime sentence as issued`

4. **Given** the payment link cannot be created (`invoices.payment-link-failed`),
   **when** the buyer presses "Payer en ligne",
   **then** the PDF, which carries the transfer details, becomes the primary way to pay with
   support beside it, a retry is offered, no bank-details action is offered, and no error code is
   shown.
   `invoices/detail: falls back to the PDF and support when the payment link fails`

5. **Given** the buyer returns from the payment provider without a recorded payment
   (`invoices.payment-return-pending`),
   **when** the detail reloads,
   **then** it says the payment may take a few minutes to appear and offers a refresh, and it
   does not claim the payment failed.
   `invoices/detail: does not claim failure when a payment is still settling`

6. **Given** the invoice PDF is missing (`invoices.pdf-missing`),
   **when** the detail loads,
   **then** the lines and totals are still shown, the download is disabled with a reason, and
   support is offered with the invoice number attached.
   `invoices/detail: stays usable when the PDF is unavailable`

7. **Given** suspension is the next step (`invoices.suspension-imminent`),
   **when** the dunning detail is opened,
   **then** the remaining steps are listed with their dates, suspension states that data is kept
   and access returns within one business day of payment.
   `invoices/dunning: shows the remaining steps with their dates`

8. **Given** a credit note (`invoices.credit-note`),
   **when** the list loads,
   **then** the row shows a negative amount labelled as a credit note and offers no payment
   action.
   `invoices/list: shows a credit note without a payment action`

9. **Given** no invoice has been issued yet (`invoices.empty`),
   **when** the list loads,
   **then** an empty state says when the first invoice is expected and offers one action.
   `invoices/list: explains when the first invoice will arrive`

10. **Given** an overdue invoice (`invoices.overdue`),
    **when** the buyer reads its detail and opens its row menu in the list,
    **then** the detail says the transfer details are on the PDF, and neither offers a
    bank-details action the contract cannot fill.
    `invoices/detail: offers no bank details the contract does not carry`

    The keyboard test of the bank-details dialog — focus on the heading, each copy button naming
    its field, the copy announced, `Escape` returning focus to the opener — returns with §4.3.

## 13. Out of scope for launch

- Self-serve payment method: card on file, SEPA mandate, recurring collection (planned after launch).
- Automated dunning inside the console; the ladder is executed by hand at launch and the console
  only displays where the customer stands.
- Proration, mid-term upgrades and downgrades computed in the console (planned after launch).
- Credit notes and refunds initiated by the customer.
- A billing-only role for an accountant without console access (planned after launch).
- Purchase-order workflows and Chorus Pro submission from the console.
- Multi-currency and per-entity billing for a group of companies.
- One-click export and delete of the organisation's data (planned after launch).

## Changelog

- Review round: a failed download keeps its own toast with « Réessayez »
  (`console.invoices.detail.error-pdf-download-failed`), since retrying works there; the missing-PDF
  sentence is only for `pdf_available: false`. On a failed payment link the promoted PDF comes
  first and is not repeated under the totals. The support links are router links to Aide carrying
  `invoiceNumber` (`category` dropped).
- Bank-transfer option withheld until contract 0.12.0 (, owner ruling, UX audit SI-12):
  no "Coordonnées bancaires" action on the list or the detail; the detail says the transfer details
  are on the PDF; a failed payment link promotes the PDF and support instead of a dialog with no
  IBAN; a missing PDF offers support rather than "Réessayez" beside a disabled button. Acceptance
  tests 4 and 10 follow.

- Journey fixes: the detail's line column reads "Montant HT", since every line is `total_excl_vat`
  (`console.invoices.detail.label-column-amount-excl-tax`); TTC stays on the list and the totals.
  The overdue banner states a suspension date only when the ladder carries one, and a dispute hold
  (`hold_until`) replaces the suspension threat with the hold.
- Review fixes: the overdue banner never prints a day count `days_overdue` did not send or an id
  in place of a number, never states a past suspension date, and during an active dispute makes
  the pay action secondary and shows the drawer's suspension as held; an expired hold is ignored.
- Review fixes: during a hold the drawer pauses every step not done, penalties included; outside
  one, a past-dated step not done reads "En cours"; zero overdue days print no count.

- Review fixes: the payment sentence, its contract-gap row and both catalogues state that direct
  debit arrives after launch, with no date attached.

- Aligned with the delivered design: renamed to Facturation in the navigation, the subscription
  card written as four facts and the included list read from the frozen price snapshot, the two
  tier-change effective-date rules recorded ahead of the self-serve screen, the payment and
  issuer sentences with no date attached, the design-system component names, and the three
  contract gaps behind them.

- Initial version: invoice list with dunning banner, detail with lines and VAT regime, one-off
  payment link with bank-transfer fallback, dunning ladder drawer, subscription summary.
- Reconciled with the Core API contract: invoices addressed at `/invoices/{invoice_id}`, the PDF
  returned as a pre-signed `download` link, money as `Money` objects throughout, the subscription
  read from the `subscriptions` collection, and `dunning.state` moved to the billing model's own
  ladder. Bank-transfer details stay on the PDF, which the API does not restate.

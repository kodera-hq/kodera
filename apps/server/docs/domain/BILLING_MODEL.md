# Billing model

**Status:** Proposed · **Owner:** Product seat

What the control plane must get right before the first invoice: a plan that can change without rewriting history, a price frozen at the moment it was agreed, a VAT treatment recorded as evidence rather than recomputed, an invoice that cannot be edited, and a dunning ladder that is a state machine rather than a habit. Core issues the invoice and allocates its number; the payment provider, still to be chosen, collects through a link per invoice (`apps/billing`). The subscription engine comes later. Nothing here depends on that engine existing.

## 1. Plan versioning

`Plan` is keyed `(code, version)`. A published version is immutable in every field that affects money or entitlement.

| Change | Result |
|---|---|
| Price change | New `Price` row; if it changes what the plan *is* (bundled apps, capacity), a new `Plan` version |
| Bundling an add-on into a tier | New `Plan` version |
| Renaming a plan for marketing | New `Plan` version; existing subscriptions keep the old display name on their invoices |
| Retiring a plan | `state = retired` (the contract's `Plan.state`). Existing subscriptions continue; no new subscription may reference it |
| Fixing a typo in a non-commercial field | Allowed in place, and audited |

Rules:

- A `Subscription` references a `(plan, price)` **and** copies the commercial facts into its own snapshot columns. Re-versioning a plan therefore cannot change what an existing customer pays, what their invoice says, or what capacity they were promised.
- The public catalogue endpoint serves only `state = published` rows. The console never computes a price; it renders `net_unit_amount_minor` from the subscription or the quote.
- A price change is announced with the notice period the terms promise, and the announcement is an `AuditEvent` (`price.published`) with the effective version, so "we told you" is provable.
- Capacity is a plan entitlement (`Plan.capacity_tier`); what is deployed is `Tenant.capacity_tier` ([`MODEL.md`](MODEL.md) §5). An event-day capacity boost changes the tenant, not the plan, and is billed as a one-off `Price(kind = one_off)`.

### 1.1 The offer: one workspace

Kodera is sold as one workspace with every application in it, at a flat price by organisation size (owner decision): the `workspace` pack, `visio` and `messaging` (Espace), is the one pack on sale in `apps/billing/catalogue/offer.toml`, under the four plans and their tiers, and no application is chosen at checkout. Its amounts are placeholders equal to the Visio grid until the real prices, which come as new `Price` rows. The `visio` and `visio-docs` packs are off sale (`available = false`) and their rows stay. A pack's applications never change in place, so Docs joins the workspace as a new pack once it can be deployed. A tenant's applications are its order's pack's, copied at `placeOrder`.

## 2. Price snapshots

Two snapshots, at two moments, for two reasons.

**On `Subscription`, at signature.** `snapshot_plan_code`, `snapshot_plan_version`, `snapshot_capacity_tier`, `snapshot_included_apps`, `snapshot_unit_amount_minor`, `snapshot_currency`, `snapshot_interval`, `discount_bp`, `discount_reasons`, `net_unit_amount_minor`, `vat_regime`. This is what the customer agreed to. It is written once and changed only by a subscription change, which writes a new set and audits the difference.

**On `InvoiceLine`, at issue.** The line copies the subscription's snapshot again, plus `tax_rate_bp` and `tax_amount_minor`. This is what was billed. An invoice is readable and reproducible with no join to `Plan`, `Price` or `Subscription`, which is the property an accountant and a court both need.

Consequences a test proves: deleting every `Plan` and `Price` row leaves every issued invoice fully renderable; changing a `Price` changes no issued invoice and no active subscription.

**Arithmetic.** All in integer minor units, in this order, with half-up rounding at each named step:

```
gross      = snapshot_unit_amount_minor × quantity
discount   = round(gross × discount_bp / 10000)
net        = gross − discount                      → InvoiceLine.net_amount_minor
tax        = round(net × tax_rate_bp / 10000)      → InvoiceLine.tax_amount_minor
```

The invoice totals are the sums of the line values, never a recomputation from the invoice's own subtotal. Rounding happens per line, once.

## 3. VAT

The regime is **determined once, recorded as evidence, and snapshotted**; it is never recomputed at render time. `Subscription.vat_regime` is set at signature, re-evaluated on a subscription change or a customer-detail change, and copied onto every invoice with the exact mention printed.

**VAT is due on payment** (exigibilité sur les encaissements), the rule for services: owner decision, recorded in `apps/billing/vat.py` (`VAT_DUE_ON = "payment"`). Core has not opted to pay VAT on invoicing (« option pour les débits »), so an invoice prints no such mention, and an unpaid invoice credited in full carried no VAT due.

| Regime | Customer | Rate | Mention printed on the invoice | Evidence required |
|---|---|---|---|---|
| `fr_standard` | France, business or public body | 20 % (`vat_rate_bp = 2000`) | — | Country and, for a public body, the Chorus Pro identifiers |
| `eu_reverse_charge` | Another EU member state, business with a VAT number valid in VIES | 0 % | "Autoliquidation — art. 283-2 du CGI / art. 196 directive 2006/112/CE" | A **recorded** VIES response: number, country, consultation reference, timestamp, result |
| `eu_b2c_default` | Another EU member state, no valid VAT number | 20 % | — | The refusal or absence of a number. Electronically supplied services to non-taxable persons are taxable where the customer is, so this regime is a **deliberate fallback we avoid by requiring a VAT number**, not a treatment we scale |
| `outside_scope` | Established outside the EU | 0 % | "TVA non applicable — art. 259-1 du CGI" | Country of establishment, and for a business the local registration reference |
| `io_exempt` | International organisation established in the EU | 0 % | "Exonération — art. 151 directive 2006/112/CE" | The exemption certificate, stored as an evidence reference on the organisation |
| `io_outside_scope` | International organisation outside the EU | 0 % | "TVA non applicable — art. 259-1 du CGI" | Country of establishment |

Rules:

- **VIES is evidence, not a lookup.** The check runs at signature and again before each issue for reverse-charge customers; the response is stored with its consultation reference on the organisation's billing profile (`BillingProfile.vat_number_validated_at`) and in an evidence blob. A check that cannot be completed (service unavailable) does **not** silently fall back to 0 %: the invoice is held and an operator decides.
- A change of regime between periods produces a new subscription snapshot and is audited (`vat.regime_changed`). It never rewrites an issued invoice.
- The `vat_mention` string is snapshotted onto the invoice. Changing the wording later changes no issued document.
- Every regime and mention is confirmed with the accountant before first use; this table is the shape the model must support, not tax advice.

**Discounts are not a VAT regime.** They change `net`, not `tax_rate_bp`.

| Discount | `discount_bp` | Reason code | Rule |
|---|---|---|---|
| Annual commitment | −1 000 (−10 %) | `annual` | Applies when `interval = year`; the headline price shown is the discounted one |
| NGO or education | −1 500 (−15 %) | `ngo` | Requires `ngo_discount_verified_at` and stored proof; re-verified at renewal, revocable |
| Founding customer | negotiated | `founding_customer` | Time-boxed by the order form, never published |
| Negotiated (Enterprise) | negotiated | `negotiated` | Never published |

Stacking: annual and NGO stack multiplicatively, floored at −2 350 bp. Add-ons and the event pack are never discounted; a line carrying `addon_code` with a non-zero `discount_bp` is a validation error.

## 4. Invoice numbering and immutability

- **Series.** `<series>-<YYYY>-<NNNNN>`, the series configured per deployment (`KODERA_INVOICE_SERIES`; credit notes take a series of their own, `AV-<series>-<YYYY>-<NNNNN>`, gapless in the same way), where `YYYY` is the issue date's year in Paris and `NNNNN` a zero-padded sequential counter, **gapless within its series and in the order of the issue dates**. A Postgres sequence is not gapless, so the number comes from a counter row incremented in the issuing transaction: a rolled-back issue gives its number back. The number is allocated last, after every validation, under a lock on the series, and the issue time is read once that lock is held. A reconciliation check asserts the series has no gap.
- **Allocation is one-way.** A number is never reused, never reassigned, never renumbered.
- **Immutability.** `state = draft` is editable and carries no number, `issued_at`, `due_at` or accounting/retention clock. Its lines likewise carry no invoice-number snapshot or accounting/retention clock. Moving to `issued` locks the invoice and every line, allocates the number last, atomically fixes the invoice number, both invoice timestamps, every line's matching number snapshot, the common accounting event, exact financial-year close and both ten-year deadlines non-null, then freezes every field. The database state/check contract rejects a partial draft issuance field, any `issued` invoice or line with one of those values null or unequal, and any later change. A mutation test weakens each nullability/state edge independently. The only permitted subsequent transitions are the state field moving to `paid`, `overdue` or `credited` (by its credit note), performed by a narrow function that touches nothing else.
- **No issued invoice is voided.** An issued invoice is delivered as it is issued, so it leaves `issued` only by payment or by a credit note; no transition reaches `void`, which stays in the state enum and consumes no new number.
- **The customer snapshot** — legal name, address, country, VAT number — is copied onto the invoice at issue. A customer who later changes their legal name does not change their old invoices.
- **The PDF is the artefact, not the source.** `pdf_ref` points at the stored document; the row is the record. If the two disagree, that is an incident, and a checksum check runs nightly.

**Credit note is the only correction path.** Every correction — a pricing error, a goodwill gesture, an availability credit under the service-level schedule, a cancellation, a downgrade — is a `CreditNote` referencing exactly one invoice, with its own number, its own date, and its own VAT treatment copied from the invoice it corrects. Invariants:

1. The sum of credit notes against an invoice never exceeds that invoice's `total_incl_tax_minor`.
2. A credit note is itself immutable once issued.
3. There is no "edit invoice" endpoint, no "regenerate invoice" job, and no re-issue path. A pull request adding one is rejected.

An issued credit note and every one of its lines are append-only throughout retention. They are
never targets of tenant deletion. Each row carries its own detached organisation and authority
snapshots and is hard-purged only when its own `purge_after`, exactly the close of the financial year
containing the credit-note issue event plus ten years, has passed. The same exact
financial-year-close-plus-ten-year rule applies per retained invoice, invoice line and payment row;
an accepted contractual document and its order are hard-purged only at their own exact
`contract_ended_at + 10 years` deadline.

### 4.1 An order not yet paid

An organisation holds **one order in flight** — `placed` or `awaiting_payment` — at a time: `placeOrder` refuses another with `409 order-in-progress`, and a partial unique key on `billing_order` holds the rule against two placements at once. A paid, fulfilled or cancelled order holds nothing, so a second tenant is ordered once the first order is paid.

**An issued invoice is never voided by a cancellation.** It is numbered and has been delivered (`placeOrder`'s answer, the console, the payment provider's checkout), so a credit note corrects it (above). An order in flight is cancelled by its owner (`cancelOrder`), or by the `system` once its invoice is unpaid past its due date (`manage.py cancel_unpaid_orders`, `UNPAID_ORDER_GRACE` after the due date of CGV 8.3, never before it). In one transaction: the order becomes `cancelled`; its pending subscription `cancelled`; an issued or overdue invoice is credited in full by a credit note (its own number, `issued_at`, a reference to the invoice, a copy of every line, the invoice's VAT treatment and both parties' snapshot, audited as `credit_note.issued`) and becomes `credited`; a draft invoice, which has no number and was never sent, is discarded; its active payment links are cancelled and withdrawn at the provider once the transaction commits (a refusal, or no provider configured, is logged and retried by `manage.py withdraw_cancelled_links`). The future corrected lifecycle writer locks the tenant and sets its permanent ordered-cancellation fence first. It applies T21 in that transaction only when no lifetime `ProjectBootstrap` exists: it issues the canonical `never_provisioned` attestation and moves the tenant `ordered → deleted`. With any historical bootstrap boundary, it creates the durable complete-scope cleanup obligation and leaves the tenant `ordered` until independently verified project/key closure lets the unbounded finalizer issue the attestation and enter `deleted`. Bootstrap record/verify and provisioning take the same tenant lock and refuse the fence or cancelled order. The current runtime still performs the old direct status transition without either attestation branch, so lifecycle acceptance remains expected-red. The organisation reads the credit note (`listCreditNotes`, `getCreditNote`; the invoice names it, `credit_note_id`), and the `credit_note_issued` notice sends its number, date, amount and permanent reference to the order's billing contact, or else the signatory (`OUTBOX_MAIL_SENDER.md` §4). A credit note and its lines remain append-only during retention, apart from the note's rendered-document and platform references which are each set once, and the delivery of its notice. A note is held at commit to at least one line and to totals equal to their sums, and an invoice takes one credit note: for now a credit note is a full credit of an unpaid invoice.

An invoice with a payment received, or a debit submitted within the settlement window, cannot be credited in full: the order is refused (`409 invoice-issued`; the command counts it as held). A partial credit with a refund of the paid part through the provider is the operator path still to build. A cancelled order's confirmation (CGV 5.3) is withdrawn if it has not left; if it has, the contract it formed is terminated, with the `order_cancellation` notice.

The credit note's reason says which: `customer_cancellation` or `unpaid_lapse`, or `complimentary` (§4.2).

**Status: no document yet, before the first customer.** Neither an invoice nor a credit note is rendered: no PDF (Factur-X, credit note type 381), no download link, no document attached to its mail. Both are owed before a paying customer can cancel an issued invoice; the series gap check and the nightly document checksum of §4 are not built either, for invoices or credit notes.

**Status: the system's cancellation is off.** `cancel_unpaid_orders` refuses to run unless `KODERA_UNPAID_LAPSE_ENABLED=1`, which stays unset until the legal lane rules on the lapse of an unpaid order (the CGV forms the contract at the confirmation, 5.3, and ends it for non-payment only through 15.2 and Annex 1). The tenant's slug stays taken after a cancellation, which is stricter than ADR-0008 (a slug no external resource used may be released); releasing it is a follow-up.

### 4.2 An order settled as complimentary

A staff operator may settle an order in flight with no charge, for an organisation whose billing is deferred: `manage.py settle_complimentary_order --staff-identity <id> --organisation <slug> --order <id> --reason <text>`, from the operator profile. The owner still places the order (`placeOrder`): the CGV and the DPA are the customer's to accept, and no one accepts them on its behalf. The settlement then, in one transaction and as one actor with a current `staff_operator` grant and a mandatory reason: credits the order's one unpaid issued invoice in full by a credit note of reason `complimentary` (§4), cancels its active payment links, moves the order `placed | awaiting_payment → paid` and its pending subscription `active`, and writes `order.complimentary` (staff, target `order`, with the reason, the invoice and the credit note). An invoice a payment holds is never credited, so that order is refused, as are an order not in flight and one whose invoice is still a draft. A settled order is not in flight, so `cancel_unpaid_orders` never lapses it. A payment that lands after the credit (a debit already on its way, a transfer the customer sends anyway) is not matched to anything and is refunded by hand. The command's first line names what happened to the subscription: `activated`, `missing`, or the state a subscription that was not pending was left in. Nothing moves a `paid` order to `provisioning` yet: the tenant stays `ordered` until provisioning is built. The command prints a second line with the order's tenant — its id, slug, realm and each application's host — for the operator to check against the tenant's Fleet record before provisioning.

## 5. Collection at launch

| Concern | At launch | Later |
|---|---|---|
| Invoice document | Issued by core; `Invoice.external_ref` holds the delivery channel's identifier once one is chosen; the PDF is stored | Delivered through an approved e-invoicing platform |
| Card and one-off transfer | A payment link per invoice at the payment provider (`PaymentLink`, behind the port in `apps/billing/payments`), sent with the invoice | Tokenised recurring payment |
| SEPA direct debit | Through the payment link (Stripe Checkout, `sepa_debit`): a debit submitted is `processing` until it settles or fails, and no second link is offered meanwhile; the provider's customer is kept on the payment | Saved mandates and off-session collection with the subscription engine |
| Bank transfer | Reconciled from Qonto | unchanged |
| Recurring collection | Not automated. Invoices are generated on a schedule and collected by the ladder in §6 | Subscription engine, proration, automated retries |

A deployment may not bill at all (`KODERA_BILLING_ENABLED=false`, [`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §2): then no new order, payment link or complimentary settlement is taken (`409 billing-disabled`). An order placed before the switch keeps its course — its cancellation and credit note, its lapse, the confirmation mail, a payment link still active at the provider — so a deployment turns billing off only once no order is `placed` or `awaiting_payment`.

Core is the system of record for *what is owed*; the provider is the system of record for *what was paid*. Neither is derived from the other without a reconciliation step (§7).

Nothing is debited automatically (CGV 8.2): every invoice carries its payment link (card or SEPA debit at the payment provider) and the transfer details, and the customer pays it. The upper tiers are invoiced annually in advance by preference.

## 6. Dunning

One ladder, the one the terms of sale state (CGV Annex 1), run by a scheduled `system` actor on the subscription. The ladder belongs to the subscription, not to one invoice: its clock is the due date of the oldest invoice still owed and not disputed (an invoice falls due thirty days after its issue, CGV 8.3). This is the specification the scheduler will be built to; no scheduler exists yet.

**What the collection does to it.** Core debits nothing on its own (CGV 8.2): each invoice is paid by the customer, through its payment link (card or SEPA debit at the payment provider, §5) or by transfer, and the provider's events reach the ladder through the reconciliation (§7). The collection never advances the ladder; it can only stop or hold it:

- Paid: once nothing undisputed is past due, the ladder clears. Paying the oldest invoice while another is still past due does not clear or restart it: it continues from the step it reached, now counted from the next oldest invoice's due date, and no step already sent is sent again. A partial payment leaves the invoice owed.
- In flight: a SEPA debit submitted and not yet settled (`processing`, with the Stripe adapter) holds the ladder at its step for the settlement window only (twenty days); past it, the debit no longer holds the invoice.
- Failed or reversed: the invoice is owed again and the ladder continues. A failed card or debit is not a ladder of its own; the payer pays again through the invoice's payment link. A chargeback is a reversal of a payment (§7), not a dispute of the invoice.

**Steps go in order and none is skipped.** Each step fires at its `J+n` or, if later, at its minimum gap after the step before it actually went out, so a hold or a reversal never lands the ladder past a notice the terms require: the suspension follows the suspension notice by seven days at least (CGV 13.1), and the termination follows the receipt of the formal notice by thirty days at least (CGV 15.2).

The termination, closure-access, cutoff, delete and finalizer rows below specify approved future
behavior. The current runtime has none of the closure lane, cutoff writers, evidence finalizer or
scheduler that would execute it; the implementation must satisfy the referenced lifecycle contract
before these rows describe a live service.

| Step | Action | Effect | Event |
|---|---|---|---|
| J+0 | The due date passes with the invoice owed | `Invoice.state = overdue`, `Subscription.state = past_due` | `invoice.overdue` |
| J+7 | Email reminder to the billing contact | none | `dunning.reminder_sent` |
| J+21 | Second email reminder plus a phone call to the billing contact | none | `dunning.reminder_sent` |
| J+35 | Formal notice by registered letter with acknowledgement of receipt, citing CGV 15.2: late-payment interest at three times the legal rate, plus the fixed recovery indemnity per invoice | none | `dunning.formal_notice_sent` |
| J+60 | Suspension notice, seven days | none | `dunning.suspension_notice_sent` |
| J+67 | **Suspension** (CGV 13). Logins disabled, running rooms finish, data kept, backups continue | `suspend` job; `Subscription.state = suspended`, `Tenant.status = suspended` | `dunning.suspended` |
| J+90 | Termination (CGV 15.2). A tenant-scoped recovery period of at most 90 days opens; ordinary tenant access is disabled and designated closure principals receive bounded read-only access to exports, invoices, credit notes, closure status and already-available deletion records | `decommission` job; `Subscription.state = cancelled` | `dunning.terminated` |
| End of the recovery period, or an earlier validated controller deletion instruction | **Deletion, whatever is still owed and whether or not an export was requested** (CGV 16.6) | cutoff obligation + `delete` job + durable finalizer | `tenant.deleted` |

The ladder's step (`notice`, `formal_notice`, `suspension_notice`, `suspended`, `terminated`) is its own record on the subscription, separate from `Subscription.state` (`active`, `past_due`, `suspended`, `cancelled`), which the table sets where it says so. The recovery period normally ends 90 days after `dunning.terminated`. A validated instruction from the controller may end it earlier and triggers irreversible deletion without making export a prerequisite. That expiry or instruction starts the cutoff obligation which the `delete` job's confirmation checks; after destruction, its durable finalizer records `tenant.deleted` once evidence is sealed ([`JOB_CATALOGUE.md`](JOB_CATALOGUE.md)).

### Rules

- **Clearing.** When nothing undisputed is past due, at any step before termination, `dunning.cleared` fires, the subscription returns to `active`, and a suspended tenant is resumed at the latest on the next business day (CGV 13.3). No reactivation fee on a first suspension.
- **Data is never held as leverage.** Suspension deletes nothing. Deletion at the end of the recovery period, or on a validated earlier instruction from the controller, runs whether or not an invoice is still owed and whether or not an export was requested; the debt is pursued, the data is not kept for it. Invoices, invoice lines, credit notes, credit-note lines and payments are accounting records whose per-row `purge_after` is exactly the close of the financial year containing their accounting event plus ten years (Code de commerce, art. L123-22). Accepted contractual documents and orders each have `purge_after = contract_ended_at + 10 years` (CGV 5.4). All are kept apart from tenant data, are never deleted by the tenant `delete` job, and are hard-purged only after their own exact deadline.
- **Every step is a scheduled job with an idempotency key derived from `(subscription, ladder_step, invoice)`,** so re-running the scheduler cannot send a notice twice.
- **Contract close is one atomic authority write.** The future close writer locks the linked `Order`, `Subscription` and `DpaAcceptance` in stable order, requires exact links and organisation scope, writes the same `contract_ended_at` and derived ten-year deadlines on all three, fixes the DPA's immutable `close_reason` and `close_evidence_ref`, and emits `dpa.contract_closed` before commit. The action's actor is exactly `staff`, `tenant` or `system`; its metadata/evidence contract is the closed registry in [`AUDIT_TAXONOMY.md`](AUDIT_TAXONOMY.md), while the DPA row retains the decision proof for its own ten-year lifetime.
- **Nothing in the ladder is automatic past `suspension_notice`** without a `staff_operator` confirmation at launch. The scheduler prepares the job; a person releases it. This becomes automatic only when the notice trail is proven.
- **A dispute holds the ladder for the amount disputed** (CGV 8.7). It is raised in writing within thirty days of the invoice's issue, with its reason. An open `SupportTicketLink` flagged as a billing dispute records the invoice, the amount disputed and `dunning_hold_until`; while it holds, that amount is not owed for the ladder, whose clock moves to the oldest invoice still owed for an undisputed amount, and the scheduler skips the subscription when nothing undisputed is past due. The hold is audited.
- Dunning state is never read off `Tenant.status`, and the scheduler never writes `Tenant.status`
  directly. The transition service owns every status write: it creates and enqueues `suspend` and
  `resume` work under their contracts, while termination atomically creates `TenantExit`, closes
  ordinary access/write admission, enters `decommissioning` and enqueues its preparation job
  ([`TENANT_STATE_MACHINE.md`](TENANT_STATE_MACHINE.md)).
- The future durable finalizer after every tenant `delete`, including the last, records only a `tenant_only` active-store attestation and leaves the organisation's realm active. The separate future final-organisation offboarding path is the sole producer of `final_organisation`: under the organisation lock exclusive, after every tenant is `deleted` with its tenant-only attestation, it moves the organisation to `closing`, fences and drains the realm's identity-backup generation, removes the realm, obtains a fresh authenticated realm-absence read, seals the through-cutoff inventory, and atomically records `tenant.realm_deleted`, the final-organisation attestation and `closed`. That attestation, not a tenant closure, starts the organisation/person purge clock.
- **Owed to the scheduler, where today's reconciliation is simpler:** a reversal moves the subscription to `past_due` at once, before the due date if it comes first, and a success returns it to `active` when its own invoice is paid even if an older one is still past due. The scheduler applies the rules above; the contract's `DunningView` still carries the two ladders and is corrected with the next contract change.

## 7. Reconciliation

A scheduled `reconcile_billing` job compares core against the providers. It is read-only against both and never mutates money; it produces findings.

| Check | Compares | Finding |
|---|---|---|
| Document presence | Every `Invoice` in `issued` or later has an `external_ref` resolvable at the provider | `invoice_missing_at_provider` |
| Document totals | Provider total equals `total_incl_tax_minor` and the currency matches | `invoice_total_mismatch` |
| Payment presence | Every provider payment maps to exactly one `Payment` row | `payment_unmatched` |
| Payment allocation | Every `Payment` with `state = succeeded` has terminal allocation classification `allocated` or `on_account` | `payment_unallocated` |
| Overpayment | Allocated payments plus credit notes do not exceed the invoice | `overpayment` |
| Series integrity | Both number series are gapless and monotonic | `numbering_gap` |
| Ladder consistency | Every subscription's dunning state matches the age of its oldest unpaid invoice | `dunning_drift` |
| Regime evidence | Every reverse-charge invoice has a stored VIES response younger than its issue date | `vies_evidence_missing` |

Findings become `Notification` rows for the finance seat and `payment.reconciliation_mismatch` audit events. For every succeeded Payment still `unmatched`, `payment_unallocated` is reproduced on every reconciliation and remains open until exactly `allocated` or `on_account` commits; provider reconciliation, an unrelated finding closure or a later provider read cannot clear it. A finding is never auto-corrected: correcting money requires an explicit credit note or payment decision. The payment decision may be authenticated staff or a deterministic authenticated system rule, but never the reconciliation finding itself. Its transaction emits exactly `payment.allocated` or `payment.placed_on_account`, with actor and metadata/evidence fixed by [`AUDIT_TAXONOMY.md`](AUDIT_TAXONOMY.md).

## 8. Electronic invoicing readiness

The French reform obliges us to **receive** structured electronic invoices through an approved platform, and later to **issue** them. Core issues the invoice; an approved platform is the delivery channel to be chosen. What the model must carry so that the issuing obligation is a configuration change and not a migration:

- Every field a structured invoice requires exists as a column, not as text inside a PDF: customer legal identifiers, country, VAT number, VAT regime and mention, per-line net, rate and tax amounts, period bounds, payment terms, and the invoice's own number and date.
- The customer snapshot is stored per invoice, so a structured document can be regenerated from the row alone.
- `Invoice.external_ref` and `pdf_ref` are separate: the platform's identifier and our stored artefact are not the same thing, and a future format change replaces the artefact without touching the record.
- Credit notes carry a reference to the corrected invoice, which the structured formats require.
- Public-sector customers are invoiced through the state portal; the model keeps their engagement identifiers on the organisation so the routing is data, not a special case in code.

No mandate identifier, card number, IBAN or provider secret is ever stored in core. The provider reference is stored; the instrument is not.

## 9. What a reviewer checks

- [ ] No float or decimal anywhere in a money path; amounts are integer minor units with a currency.
- [ ] A new commercial term is a new `Plan` version or a new `Price`, never an in-place edit of a published row.
- [ ] `Subscription` and `InvoiceLine` both carry their own snapshots; an invoice renders with the catalogue tables emptied.
- [ ] The VAT regime is stored with its evidence and its printed mention; nothing recomputes it at render time.
- [ ] Issued invoices, their lines, credit notes and their lines are append-only during retention, proven by a trigger and a mutation test; there is no edit or re-issue path, tenant deletion never targets them, and their exact legal purge clocks are enforced per row.
- [ ] Every dunning step is an idempotent scheduled job emitting its registered audit action.
- [ ] Reconciliation findings are surfaced, never auto-corrected.

## Changelog

- First version. Fixes assessment item C5 and risk 10: plan versioning with immutable published versions, price snapshots on both the subscription and the invoice line, the VAT regime matrix with recorded VIES evidence and the discount rules kept separate from it, gapless immutable invoice numbering with the credit note as the only correction path, the two dunning ladders from the legal pack expressed as a state machine, the reconciliation job, and the fields electronic invoicing will need.
- Follows the billing application (`apps/billing`). Core issues the invoice; the number series is `<series>-<YYYY>-<NNNNN>` from a counter row under a series lock, not a Postgres sequence; the payment provider is behind a port and still to be chosen; the VAT evidence sits on the billing profile; a retired plan is `retired`, the contract's name. The VAT regimes the contract carries today are `fr_standard`, `eu_reverse_charge`, `exempt` and `outside_eu`; the others in §3 are the shape to grow into.
- One dunning ladder, the terms of sale's (CGV Annex 1), on the subscription, counted from the oldest invoice still owed and not disputed: the card and direct-debit ladder is gone, since Core debits nothing on its own and a failed collection leaves the invoice on the one ladder. The provider's events stop or hold the ladder, never advance it; steps go in order with their legal gaps; it clears only when nothing undisputed is past due; a dispute holds the disputed amount only. Deletion at the end of the recovery period runs whatever is still owed, and the billing records are kept apart. §5 no longer says the lower tiers are debited on the anniversary.
- §4.1: one order in flight per organisation, and the cancellation of an order not yet paid — by its owner (`cancelOrder`, contract 0.20.0) or by the `system` once its invoice is unpaid past its due date (not scheduled) — only while its invoice is a draft: an issued invoice is never voided, and waits for credit notes.
- §§4, 4.1: credit notes, in the `AV-` series of their own, the only correction of an issued invoice; a cancellation credits an unpaid invoice in full and the invoice becomes `credited`; the customer reads it and receives its notice (contract 0.24.0).
- §4.2: an order in flight settled as complimentary by a staff operator, its invoice credited in full (`complimentary`), the order `paid`, audited `order.complimentary`.
- §1.1: one workspace on sale, the `workspace` pack (`visio` + `messaging`) at placeholder prices equal to the Visio grid; `visio` and `visio-docs` off sale.
- §5: a deployment that does not bill (`KODERA_BILLING_ENABLED=false`) takes no order, payment link or complimentary settlement.

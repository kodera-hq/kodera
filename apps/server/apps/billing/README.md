# Billing documents and recorded VAT evidence

Status: Draft implementation; production document and dunning delivery gates remain open.

Core remains the legal invoice and credit-note authority. Stripe Checkout collects in payment
mode; this change introduces no provider invoice, recurring debit, Tax product or live key.
All amounts below come from integer-minor-unit accounting snapshots.

## Implemented source

- `vies.py` checks the fixed European Commission REST endpoint using the existing pinned public
  transport. It records valid, invalid and unavailable outcomes with consultation references,
  response digests and bounded validity. An unavailable or expired check holds reverse-charge
  issuance; an old profile timestamp alone cannot authorize zero VAT. A PostgreSQL trigger also
  refuses direct reverse-charge issuance without current evidence.
- `documents.py` emits deterministic CII candidates for invoice type `380` and positive credit
  type `381`, referencing the original invoice and its separate `AV-` series. It reads frozen
  parties and line columns only. XML output is **not** labelled a conforming Factur-X document.
- `artifacts.py` requires both a local renderer and an independent conformance validator before
  it can publish one immutable PDF/XML pair. The pair is bound to its snapshot and byte digests;
  publication is idempotent under the accounting row lock. Database guards prohibit evidence
  edits and reject mismatched byte digests.
- `downloads.py` exposes a worker-owned object-store signing port. The API holds no storage
  credential and never proxies document bytes. Missing validated artifacts or a signer produce
  no link. Successful link requests are authenticated, scoped and audited.
- `verify_billing_integrity` verifies both complete series against their counters, Paris issue
  years, monotonic issue dates and existing artifact digests. It never renumbers or repairs.
- `reconcile_billing` emits read-only findings from a bounded sanitized provider observation
  file and the ledger. Missing provider evidence remains an explicit unverified finding.
  Unallocated succeeded payments recur on every run; reconciliation never allocates money.
- `dunning.py` proposes the next ordered step with stable idempotency keys, actual-delivery
  gaps, dispute amounts, bounded processing holds, formal-notice receipt and staff gates.
  Proposals are not deliveries and do not change a tenant or subscription state.

The additive `workspace-v2` pack and plan version 2 include `messaging`, `visio` and `docs`.
Historical `workspace` rows keep their original applications and profile and are taken off sale.
Amounts and capacity values remain synthetic reference catalogue data, not measured public
offers or service guarantees. No historical order, subscription or invoice is rewritten.

## Remaining release acceptance

The default deployment intentionally has no PDF/A-3 renderer, EN16931 XSD/Schematron validator,
artifact object-store publisher or download signer configured. It must not serve a paying
customer on the strength of these source tests. A qualified local backend must demonstrate
PDF/A-3 plus embedded `factur-x.xml`, current profile/schema validation, deterministic output and
actual authenticated delivery before this gate can close. The frozen legacy issuer address
is unstructured; the conformance backend must reject any snapshot missing required legal data.

The dunning planner does not yet own persisted notice/outbox receipts, support-dispute links,
scheduled enqueueing, finance notifications or confirmed tenant transition jobs. Those runtime
integrations remain deferred; no reminder, suspension, termination or financial correction is
performed by the planner. Statutory retention/deletion is a separate lifecycle lane.

## Verification

Run the new unit/refusal files `test_billing_documents.py`, `test_billing_vies.py` and
`test_billing_dunning_plan.py`. `test_billing_evidence_persistence.py` requires an isolated real
PostgreSQL database and verifies the database-level mutation refusals. Synthetic PDF fixtures
exercise storage and digest behavior only and explicitly provide no conformance evidence.

Primary protocol references: [Commission VIES API](https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml)
and [FNFE-MPE Factur-X implementation resources](https://fnfe-mpe.org/factur-x/implementer-factur-x/).

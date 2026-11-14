# Billing documents and collection evidence

Status: Implemented source with qualified local conformance evidence; production delivery gates open.

Core remains the legal invoice and credit-note authority. Stripe Checkout collects in payment
mode. No provider invoice, recurring debit, Tax product, console or live key is introduced.
All document amounts come from integer-minor-unit accounting snapshots.

## Frozen documents

`documents.py` builds canonical CII EN16931 invoice `380` and positive credit-note `381` XML,
with original invoice references and separate `AV-` numbering. Parties, service periods and
amounts come only from immutable ledger columns. The issuer country is explicitly snapshotted
from `KODERA_BILLING_ISSUER_COUNTRY`. Legacy null countries refuse rendering; the migration never
infers or backfills a country from the VAT prefix. An unstructured legacy issuer address is
retained as its original line, without invented city/postcode data.

`rendering.py` is an offline operator backend. ReportLab embeds its bundled Vera font; factur-x
packages the matching XML and XMP; normalization binds all timestamps and PDF identifiers to
the frozen snapshot. The checked-in ICC profile has its own provenance and digest in
[assets/README.md](assets/README.md). Unsupported glyphs refuse rather than silently omitting text.

Install the exact `billing-documents` optional extra from `uv.lock` in an isolated operator
environment. It pins [ReportLab 5.1.0](https://pypi.org/project/reportlab/5.1.0/),
[factur-x 7.9](https://pypi.org/project/factur-x/7.9/) and
[SaxonC-HE 13.1.1](https://pypi.org/project/saxonche/13.1.1/). Their BSD/MPL-2.0 licenses
are compatible with the server's AGPL distribution; preserve their notices and the bundled
font/profile notices when packaging. The API image does not gain renderer or validator execution.

The local validator evaluates the packaged Factur-X 1.09 EN16931 XSD and compiled Schematron
with network protocols disabled. It does not use the library's HTTP Saxon service or consider
library logging a successful validation. The sole allowed warning is `PEPPOL-EN16931-R008` for
the required empty delivery aggregate when no physical delivery applies; every other failed
assertion refuses publication. The independent veraPDF report must certify one PDF/A-3b job,
with no parse, encryption, memory or validator failures. Embedded XML bytes and snapshot binding
must match exactly. XML alone is never labelled a conforming Factur-X artifact.

`render_billing_document --invoice UUID --verapdf /absolute/path/to/verapdf` (or `--credit-note`)
renders, validates and stores one immutable PDF/XML pair under the accounting lock. Replays
verify the existing bytes. Database triggers reject changes and SHA mismatches. The download
API issues short private links through a configured signer after checking current billing
membership; no default signer or object-store publication port is inferred.

## VAT and integrity

`vies.py` contacts only the fixed Commission endpoint through pinned public egress. Valid,
invalid and unavailable outcomes persist with minimal consultation evidence, response digests
and validity. An outage or expired result holds reverse-charge issuance; an old profile timestamp
cannot authorize zero VAT. A database trigger independently checks this fence.

`verify_billing_integrity` checks numbering, Paris accounting year, counters, ordering and gaps;
mutation tests prove refusals. `reconcile_billing` compares local ledger facts with optional
bounded sanitized observations, labels absent provider facts unverified and repeatedly reports
unallocated succeeded payments. It never allocates money or performs a provider operation.

## Supervised collection

`schedule_dunning --subscription UUID` serializes invoices before the subscription/case, marks
J+0 unpaid invoices overdue and persists one idempotent proposal for the next legal milestone.
It never treats preparation as delivery. Confirmations recheck debt, processing/dispute holds,
current staff, actual delivery clocks and the complete ordered trail. Payment cancels pending
proposals and starts a fresh episode. Confirmed evidence is retained and immutable.

`record_billing_dispute --staff-identity UUID --invoice UUID --ticket UUID --amount-minor N
--hold-until ISO` links a positive bounded amount to an existing same-organisation billing
support ticket for at most 90 days. Only the disputed amount is held. Closing the support ticket
or expiration ends the active hold. Replays must preserve the original evidence.

`confirm_dunning_action --staff-identity UUID --action UUID --delivered-at ISO --evidence-ref
urn:kodera:evidence:UUID` records an operator attestation of real delivery. Formal notice also
requires `--receipt-at ISO`. This command does not send mail and does not manufacture receipt
proof. Suspension/termination additionally require `--job UUID`, a matching successful current
episode transition job and the actual tenant status; no tenant transition is written here.
Processing payments hold for 20 days; missing processing timestamps refuse. Suspension requires
7 days after actual suspension notice; termination also requires 30 days after formal receipt.
All proposal, confirmation, hold and clearing changes are audited in their transaction.

The additive `workspace-v2` pack and plan version 2 include `messaging`, `visio` and `docs`.
Historical `workspace` rows preserve their original apps/profile and are taken off sale.
Prices/capacity remain synthetic reference data, not measured public offers or service guarantees.

## Evidence and deployment limits

Local tests used veraPDF 1.30.2 downloaded from its official distribution and verified against
the official signing fingerprint `13DD102B4DD69354D12DE5A83184863278B17FE7`. The backend checks
`cli-1.30.2.jar` SHA-256 `889075253fb9df4db5482efb8f8208fb3b4f2e00f5f7e1b1e31edf6fb4b69bb6`
and executes that JAR directly through Java. The validator and JVM must be provisioned by the
operator; they are not downloaded at runtime. This is executable local conformance evidence,
not an external certification of all invoices or national legal completeness.

`test_billing_rendering.py` proves both document types, independent PDF/A-3b validation,
XSD/Schematron monetary mutations, exact embedded XML, wall-clock/random-ID determinism,
unsupported glyph refusal, service periods and invalid reports. Set `KODERA_TEST_VERAPDF` to
the verified executable to run its real-validator cases; skips do not count as conformance.
`test_billing_evidence_persistence.py` and `test_billing_dunning_scheduler.py` need real PostgreSQL.

Production release remains held until issuer-specific legal fields/mentions are qualified,
artifact delivery storage/signing is configured and verified, and actual notice/outbox receipts,
finance notifications and tenant transition writers are connected. Current manual attestations
are labelled as such. Full GDPR/statutory retention is a separate lifecycle lane. No production
billing, delivery, suspension, termination or financial correction was performed by these tests.

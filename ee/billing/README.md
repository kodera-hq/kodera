# Kodera Commercial Billing (`ee/billing`)

Status: Active.

## What stays open source

The billing engine is part of the open-source control plane and stays there. [`apps/server/apps/billing`](../../apps/server/apps/billing) (`AGPL-3.0-or-later`) holds the generic catalogue loader, orders and subscriptions, the invoice and credit-note ledger with VAT, and the payment engine that creates Stripe Checkout sessions and verifies and reconciles signed Stripe webhook events (`/api/v1/billing/webhooks/stripe`). [`GOVERNANCE.md`](../../GOVERNANCE.md) forbids moving code that already shipped in the open-source tree into `ee/`, so none of it will be.

A self-hosted Community stack never needs it: [`deploy/community`](../../deploy/community/README.md) runs with `KODERA_BILLING_ENABLED=false`, which makes the server refuse orders and payment links and create workspaces unbilled, with zero billing configuration. The catalogue fixtures in `apps/server` carry synthetic reference amounts for tests, not Kodera's prices.

## What belongs here

Governed by [`../LICENSE`](../LICENSE) (`LicenseRef-Kodera-EE`), and loaded only with `KODERA_EDITION=enterprise`:

- **Commercial price schedules ([`pricing.py`](./pricing.py)):** the prices Samouraï Coop actually charges, in exact integer minor units (`EUR` cents) with a `4400 bps` (`44.0%`) minimum gross-margin floor.
- **Managed-hosting automation for many tenants ([`warm_pool.py`](./warm_pool.py)):** deterministic Autopilot warm-pool sizing, capacity watermarks, replenishment planning, unhealthy-slot eviction, and idempotent checkout claim. The open-source tree keeps the allocation record and the claim endpoint; what fills and runs the pool belongs here.
- **Custom enterprise billing ([`purchase_orders.py`](./purchase_orders.py)):** Purchase Order (`PO`) lifecycle (`draft` -> `issued` -> `countersigned` -> `invoiced` -> `paid` / `expired`), contracted seat and storage commitment enforcement, and operator-only invoice and payment settlement verified against persisted Core ledger rows (`billing_invoice`, `billing_payment`).
- **Per-tenant FinOps resource attribution ([`finops.py`](./finops.py)):** exact integer minor-unit (`EUR` cents) proportional floor allocation across compute, S3 storage/egress, TURN/LiveKit relay, and shared-platform pools reconciled against provider invoice totals (`allocated_total_minor + unallocated_remainder_minor == provider_invoice_total_minor`) with per-tenant `4400 bps` gross-margin floor flagging.
- **Edition-gated HTTP runtime ([`api.py`](./api.py), [`urls.py`](./urls.py)):** commercial plan, quote, warm-pool, purchase-order, and FinOps reconciliation routes gated behind `KODERA_EDITION=enterprise` (returning `404` in Community mode).

## List prices

| Edition | Hosting | Price |
| :--- | :--- | :--- |
| Community / Self-Host | Your own infrastructure | 0 € |
| Team / Pro | Shared European cloud, strict per-seat quotas | 0 € up to 5 seats, then 5 € excl. VAT per seat per month, billed annually (6 € billed monthly) |
| Sovereign / Enterprise | Dedicated tenant | From 290 € excl. VAT per month, or custom |

This table and the one in the root [`README.md`](../../README.md) say the same thing; a price change updates both.

## Qonto PA transport

Status: Active

[`qonto_pa.py`](./qonto_pa.py) submits already-issued immutable Factur-X PDFs and requests
an e-invoice transmission. Core remains the invoice, numbering and credit-note authority.
This connector is opt-in and is never imported by the open-source API. Set
`QONTO_EINVOICING_ENABLED=true`, `QONTO_EINVOICING_BASE_URL=https://thirdparty.qonto.com`,
`KODERA_QONTO_PA_TOKEN` through the operator secret store, and optionally
`QONTO_EINVOICING_TIMEOUT_SECONDS` (positive, at most 10 seconds). The token is read directly
from the environment, excluded from representations and errors, and never enters Django settings.
Disabled configuration refuses a stray token. No provider configuration is activated by this module.

The HTTPS transport verifies certificates, requires TLS 1.2 or later, rejects redirects,
reads at most 2 MiB and has no SDK dependency. The sandbox host
`https://thirdparty-sandbox.staging.qonto.co` requires explicit `allow_sandbox=True`;
provider staging authentication and e-invoice availability must be qualified separately.
Settings reads use `GET /v2/einvoicing/settings`; bulk uploads use repeated multipart
`client_invoices` fields (1–5 PDFs, at most 5 MB each and 15 MB per request);
transmission requests use `POST /v2/client_invoices/{id}/send_by_einvoice`.
Every PDF passes the always-on PDF/A-3b structural checks and official packaged EN 16931
XSD/Schematron checks before transmission. Both invoice type 380 (`KOD-...`) and credit-note
type 381 (`KOD-AV-...`) are accepted. An explicit `invoice_prefix` can select another external
series; generic manual numbering prefixes are refused. Existing ledger series are never rewritten.
The default submission path requires a persisted Core billing artifact with the exact PDF digest
and matching frozen snapshot. Unrecorded, tampered or duplicate document numbers are refused
before HTTP. Pure offline tests may explicitly disable the ledger check only under the test series.
All transport entrypoints require the enterprise edition.

All POST requests require `X-Qonto-Idempotency-Key`. There are no automatic retries:
[Qonto's bulk-import contract](https://docs.qonto.com/api-reference/business-api/invoicing/client-invoices/bulk-import-client-invoices)
explicitly does not guarantee idempotent imports. After a lost response, reconcile imported
invoice numbers before retrying, even when the same header was sent. A transmission acceptance
is not proof of delivery; inspect the provider lifecycle separately, following the
[e-invoice contract](https://docs.qonto.com/api-reference/business-api/invoicing/client-invoices/send-a-client-invoice-by-e-invoice).
HTTP 429 and 500/502/503/504 or transport timeouts raise scrubbed transient errors;
429 exposes a bounded `retry_after` in seconds. Other failures, including redirects, raise
scrubbed permanent errors. Response bodies, tokens and customer details never enter exceptions.
Offline tests inject transport responses; no account, invoice or transmission is created.

## Document verification and downloads

The operator installs the `billing-documents` optional dependency set. Each real render runs
`validate_facturx_pdfa3b`, including exact embedded XML equality, attachment/XMP/ICC/font/action
checks and XSD/Schematron validation. These deterministic structural checks run without a JVM;
full ISO PDF/A qualification additionally uses the independently pinned veraPDF distribution.
When `KODERA_BILLING_VERAPDF` is explicitly configured, validation chains into it
and fails closed on an unavailable or untrusted installation. The render command requires
`--verapdf /absolute/path/to/verapdf`. Legal issuer aliases are documented with non-secret
placeholders in `apps/server/.env.example`; partial, blank or disagreeing aliases refuse rendering.

`S3ArtifactDownloadSigner` is a worker-only adapter with explicit credentials and HTTPS location;
it never reads infrastructure environment variables. It reuses the media worker's SigV4
implementation, signs only `organisations/{organisation_id}/billing-artifacts/{artifact_id}.pdf`
or `.xml`, clamps expiry to 60–300 seconds and signs an attachment filename and private/no-store
response policy. Workers must publish the validated bytes under those keys before exposing links.
`GatewayBillingDownloadSigner` delegates over an absolute Unix socket configured through
`KODERA_BILLING_GATEWAY_SOCKET`; the API retains no storage credentials. The private worker must
mount the `billing_download_rpc` dispatch port from `apps.billing.downloads` for the
`billing_download` operation. The existing media attachment RPC does not accept billing keys;
this lane does not change that protocol or deploy a worker. The dispatch rechecks artifact
ownership and immutable document number before signing; responses are bounded and scoped again
by the API-side adapter.

## VIES resilience

`consult_with_proof_cache` returns current unexpired valid proof without provider I/O or a newer
outage row. HTTP runs outside transactions; short profile locks recheck identity and proof before persistence, preserving validation timestamps
and the evidence required by reverse-charge issuance. Low-level `record_consultation` retains explicit append-only status semantics and enforces
strictly increasing consultation timestamps. `retry_due_consultations` and the operator command
`retry_vies_consultations --limit 50` select only the latest due consultation for each current
non-domestic profile and back off outages by 15, 30, 60, 120, then 240 minutes.
The bounded attempt is recorded in `evidence["retry_attempt"]`; success resets retry state.
Domestic French orders remain independent of VIES availability. Exhausted or invalid intra-EU
proof still fails closed; an outage never supplies a new VAT exemption.

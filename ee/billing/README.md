# Kodera Commercial Billing (`ee/billing`)

Status: Active.

## What stays open source

The billing engine is part of the open-source control plane and stays there. [`apps/server/apps/billing`](../../apps/server/apps/billing) (`AGPL-3.0-or-later`) holds the generic catalogue loader, orders and subscriptions, the invoice and credit-note ledger with VAT, and the payment engine that creates Stripe Checkout sessions and verifies and reconciles signed Stripe webhook events (`/api/v1/billing/webhooks/stripe`). [`GOVERNANCE.md`](../../GOVERNANCE.md) forbids moving code that already shipped in the open-source tree into `ee/`, so none of it will be.

A self-hosted Community stack never needs it: [`deploy/community`](../../deploy/community/README.md) runs with `KODERA_BILLING_ENABLED=false`, which makes the server refuse orders and payment links and create workspaces unbilled, with zero billing configuration. The catalogue fixtures in `apps/server` carry synthetic reference amounts for tests, not Kodera's prices.

## What belongs here

Governed by [`../LICENSE`](../LICENSE) (`LicenseRef-Kodera-EE`), and loaded only with `KODERA_EDITION=enterprise`:

- **Commercial price schedules ([`pricing.py`](./pricing.py)):** the prices Samouraï Coop actually charges, in exact integer minor units (`EUR` cents) with a `4400 bps` (`44.0%`) minimum gross-margin floor.
- **Managed-hosting automation for many tenants ([`warm_pool.py`](./warm_pool.py)):** deterministic Autopilot warm-pool sizing, capacity watermarks, replenishment planning, unhealthy-slot eviction, and idempotent checkout claim. The open-source tree keeps the allocation record and the claim endpoint; what fills and runs the pool belongs here.
- **Custom enterprise billing ([`purchase_orders.py`](./purchase_orders.py)):** Purchase Order (`PO`) lifecycle (`draft` -> `issued` -> `countersigned` -> `invoiced` -> `paid` / `expired`), contracted seat and storage commitment enforcement, and canonical invoice reference binding.
- **Edition-gated HTTP runtime ([`api.py`](./api.py)):** commercial plan, quote, warm-pool, and purchase-order routes gated behind `KODERA_EDITION=enterprise` (returning `404` in Community mode).

## List prices

| Edition | Hosting | Price |
| :--- | :--- | :--- |
| Community / Self-Host | Your own infrastructure | 0 € |
| Team / Pro | Shared European cloud, strict per-seat quotas | 5 € excl. VAT per seat per month, billed annually (6 € billed monthly) |
| Sovereign / Enterprise | Dedicated tenant | From 290 € excl. VAT per month, or custom |

This table and the one in the root [`README.md`](../../README.md) say the same thing; a price change updates both.

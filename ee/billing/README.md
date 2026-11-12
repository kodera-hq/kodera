# Kodera Commercial Billing (`ee/billing`)

Status: Planned. This directory holds no code yet.

## What stays open source

The billing engine is part of the open-source control plane and stays there. [`apps/server/apps/billing`](../../apps/server/apps/billing) (`AGPL-3.0-or-later`) holds the generic catalogue loader, orders and subscriptions, the invoice and credit-note ledger with VAT, and the payment engine that creates Stripe Checkout sessions and verifies and reconciles signed Stripe webhook events (no public webhook route is wired yet). [`GOVERNANCE.md`](../../GOVERNANCE.md) forbids moving code that already shipped in the open-source tree into `ee/`, so none of it will be.

A self-hosted Community stack never needs it: [`deploy/community`](../../deploy/community/README.md) runs with `KODERA_BILLING_ENABLED=false`, which makes the server refuse orders and payment links and create workspaces unbilled, with zero billing configuration. The catalogue fixtures in `apps/server` carry synthetic reference amounts for tests, not Kodera's prices.

## What belongs here

Governed by [`../LICENSE`](../LICENSE) (`LicenseRef-Kodera-EE`), and to be loaded only with `KODERA_EDITION=enterprise`:

- **Commercial price schedules:** the prices Samouraï Coop actually charges, as data loaded into the open billing engine.
- **Managed-hosting automation for many tenants:** filling and operating a warm pool of ready tenants and the unattended operation of managed stacks ("Autopilot"). The open-source tree keeps the allocation record and the claim endpoint; what fills and runs the pool belongs here.
- **Custom enterprise billing:** negotiated terms, purchase orders and invoicing outside the standard checkout.

## List prices

| Edition | Hosting | Price |
| :--- | :--- | :--- |
| Community / Self-Host | Your own infrastructure | 0 € |
| Team / Pro | Shared European cloud, strict per-seat quotas | 5 € excl. VAT per seat per month, billed annually (6 € billed monthly) |
| Sovereign / Enterprise | Dedicated tenant | From 290 € excl. VAT per month, or custom |

This table and the one in the root [`README.md`](../../README.md) say the same thing; a price change updates both.

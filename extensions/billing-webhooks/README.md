# `@kodera/ext-billing-webhooks`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling subscription lifecycle, invoice settlement, payment failure escalation, and infrastructure quota threshold webhooks (`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `quota.threshold_reached`) alongside the `/billing-ops` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a billing provider account.

## Security & Privacy Guarantees

- **Strict Allowlist-Only PII Redaction**: Structurally strips and ignores customer billing and shipping addresses, payment card metadata (`number`, `last4`, `cvc`, `exp_month`, `exp_year`, `fingerprint`), IBANs, phone numbers, customer names, and raw email addresses. Only validated `workspaceSlug`, `planTier`, ISO-4217 `currency` + minor-unit amount summary, and `status` / `quotaUsagePercent` are emitted.
- **Authorized Ops Channel Isolation**: Refuses to emit billing or quota webhook cards to any channel outside `authorizedOpsChannels`.
- **Timestamped `t=...,v1=...` HMAC-SHA256 Verification**: Constant-time `timingSafeEqual` comparison across `v1` hex digests over `${timestamp}.${rawBody}` with strict replay skew bounds and duplicate event ID rejection.

## Slash Command (`/billing-ops`)

- `/billing-ops status` — show PII-redaction policy status and authorized ops channel list
- `/billing-ops summary --workspace=studio-alpha` — request redacted plan and invoice summary in an authorized ops channel
- `/billing-ops quotas --workspace=studio-alpha` — inspect infrastructure quota threshold status
- `/billing-ops policy` — display active PII redaction guarantees

## Verification

```bash
npm run test:sdk
```

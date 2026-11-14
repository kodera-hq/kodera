# `@kodera/ext-openproject`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) normalizing OpenProject (`work_package:created`, `work_package:updated`) and Jira (`jira:issue_created`, `jira:issue_updated`, `sprint_started`, `sprint_closed`) webhooks into a unified sovereign work-item timeline card alongside the `/work` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming OpenProject or Jira describes the webhook payload schema rather than an endorsement.

## Security & Normalization Guarantees

- **Unified Sovereign Work-Item Card**: Maps both OpenProject HAL+JSON work packages and Jira issue or sprint events into a single structured card (`statusBadge`, `assignee`, `priority`, `sprintContext`, and validated HTTPS `url`) while threading subsequent updates onto the root item thread.
- **Constant-Time HMAC-SHA256 Verification**: Verifies `X-OpenProject-Signature` and `X-Hub-Signature-256` (`sha256=<hex>`) over exact raw bytes with `timingSafeEqual`, plus canonical Kodera `x-kodera-signature-256` envelopes and bounded replay protection.
- **Anti-SSRF Link Validation & Sanitization**: Validates every outbound tracker link via `validateEndpointUrl` against an explicit HTTPS host allowlist and strips untrusted markup and raw assignee emails in linear time.

## Slash Command (`/work`)

- `/work status` — show work-item timeline bridge status
- `/work inspect --key=OP-1042` — inspect a work package or issue card
- `/work sprint --name="Sprint 14"` — inspect active sprint timeline context
- `/work triage --key=OPS-208 --status="In Progress"` — post a structured triage transition

## Verification

```bash
npm run test:sdk
```

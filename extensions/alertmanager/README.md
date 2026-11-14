# `@kodera/ext-alertmanager`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling Prometheus Alertmanager v4 (`status: firing | resolved`, `commonLabels`, `commonAnnotations`, `alerts[]`, `externalURL`, `runbook_url`) and Grafana Unified Alerting webhook payloads alongside the `/alerts` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming Prometheus or Grafana describes the webhook payload shape rather than an endorsement by either project.

## Security & Reliability Guarantees

- **Constant-Time Signature & Bearer Secret Verification**: Supports canonical Kodera `x-kodera-signature-256` signatures via `createWebhookHandler`, `X-Alertmanager-Signature` (`HMAC-SHA256`) constant-time comparison, and `Authorization: Bearer <secret>` verification over fixed-width `SHA-256` digests so token length never leaks.
- **Structured Incident Cards & Thread Resolution**: Maps Alertmanager and Grafana severities to badges (`critical`, `warning`, `info`) and SDK incident severities (`critical`, `medium`, `info`), opening cards via `postIncidentCard` and threading `resolved` follow-ups onto active group keys.
- **Anti-SSRF `externalURL` & `runbook_url` Validation**: Validates alert generator, dashboard, and runbook links via `validateEndpointUrl`, rejecting plaintext HTTP, embedded credentials, loopback, link-local, and RFC1918 targets.

## Slash Command (`/alerts`)

- `/alerts status` — display active group count and routing summary
- `/alerts firing --severity=critical` — filter firing alerts by severity badge
- `/alerts runbook --alert=HighErrorRate` — preview validated runbook reference

## Verification

```bash
npm run test:sdk
```

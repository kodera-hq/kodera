# `@kodera/ext-uptime-incident-bridge`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) that bridges external monitoring alerts (`incident.opened`, `incident.acknowledged`, `incident.resolved`) into Espace incident cards and threaded status transitions.

## Capabilities

- **Structured Incident Cards & Thread Follow-Ups**: Opens a high-signal incident card via `client.postIncidentCard` on `incident.opened`, records the root thread ID, and posts `incident.acknowledged` and `incident.resolved` transitions as replies via `client.postThreadReply`.
- **Configurable Flapping Alert Deduplication**: Suppresses noisy duplicate or rapidly flapping `incident.opened` alerts for the same `incidentKey` within `dedupWindowSeconds` (`300s` default).
- **SSRF & Severity Enforcement**: Validates external runbook/status URLs via `validateEndpointUrl` (`https:` only, no private/link-local IPs) and enforces canonical severity tiers (`critical`, `high`, `medium`, `low`, `info`).

## Verification

```bash
npm run test:sdk
```

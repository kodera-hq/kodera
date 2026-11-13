# `@kodera/ext-rss-advisories`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling normalized Atom 1.0, RSS 2.0, `GHSA`, `CVE`, and `CERT-FR` security advisory deliveries for upstream dependencies (`Synapse`, `PostgreSQL`, `Keycloak`, `Rust`, `Node.js`) alongside the `/advisories` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to external feeds, and naming upstream projects or advisory sources describes the payload shape rather than an endorsement.

## Security & Reliability Guarantees

- **Constant-Time Webhook Authentication**: Supports canonical Kodera `x-kodera-signature-256` signatures via `createWebhookHandler` and `X-Advisory-Signature-256` (`HMAC-SHA256`) constant-time verification over raw JSON or Atom/RSS XML bytes.
- **XXE / DTD Refusal**: Rejects any XML payload containing `<!DOCTYPE`, `<!ENTITY`, `<!ATTLIST`, or `<!NOTATION` declarations with `XML_ENTITY_FORBIDDEN` before parsing.
- **State-Machine Plain-Text Extraction**: Extracts feed summaries via a single-pass XML entity decoder and character-by-character state machine (with zero HTML-tag regular expressions), suppressing `<script>` and `<style>` blocks and omitting all angle-bracket markup.
- **Bounded GUID & Advisory ID Deduplication**: Deduplicates across feed `GUID` values and canonical `CVE`, `GHSA`, and `CERT-FR` identifiers inside a bounded FIFO set so duplicate cross-feed publications do not flood channels.

## Slash Command (`/advisories`)

- `/advisories status` — display tracked upstream components and CVSS threshold
- `/advisories list --component=postgresql --min-cvss=7.0` — filter advisories by component and CVSS floor
- `/advisories sources --source=cert-fr` — inspect advisory source configuration

## Verification

```bash
npm run test:sdk
```

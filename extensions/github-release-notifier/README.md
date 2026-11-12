# `@kodera/ext-github-release-notifier`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) that transforms `release.published` and `ci.workflow_failed` webhook deliveries into structured Espace channel cards.

## Security & Reliability Guarantees

- **Constant-Time Signature & Replay Verification**: Uses `createWebhookHandler` to enforce `x-kodera-signature-256`, bounded `x-kodera-timestamp` tolerance, and `x-kodera-delivery-id` deduplication.
- **Strict SemVer Tag & Repository Slug Validation**: Rejects malformed repository identifiers or non-SemVer tags before constructing channel messages.
- **Markdown Sanitization & SSRF Link Validation**: Strips raw HTML tags (`<script>`, `<iframe>`), neutralizes `javascript:` / `data:` URIs, truncates oversized changelogs, and validates release/workflow URLs via `validateEndpointUrl`.
- **Deterministic Idempotency Keys**: Emits `release:<repo>:<tag>` and `ci-failure:<repo>:<runId>` idempotency keys via `createExtensionClient`.

## Verification

```bash
npm run test:sdk
```

# Extension SDK & 10 connectors

> Bring signed events into channels, with explicit trust boundaries.

## Sign the exact bytes

The SDK is a zero-dependency ESM/TypeScript package. Its envelope signs timestamp.rawBody using HMAC-SHA256, with a v1= hexadecimal signature. Headers are x-kodera-signature-256 and x-kodera-timestamp.

The timestamp is a canonical non-negative safe integer, within the inclusive 300-second window. The SDK admits at most 1 MiB of raw body; this browser lab deliberately limits examples to 64 KiB.

> The local example secret is public test data. Never paste a production signing secret into this lab.

```typescript
import { signWebhookPayload, verifyWebhookRequest } from "@kodera/extension-sdk";

const rawBody = JSON.stringify({ type: "asset.ready", assetId: "demo-1" });
const timestamp = Math.floor(Date.now() / 1000);
const secret = "local-example-secret-only";
const signature = signWebhookPayload(secret, timestamp, rawBody);
const verified = verifyWebhookRequest({
  secret, rawBody, signatureHeader: signature,
  timestampHeader: String(timestamp), nowUnixSeconds: timestamp,
});
```

## Route events, then admit side effects

createWebhookHandler requires a signed type or event marker; both must agree if present. An optional event header must match the signed marker.

The handler deduplicates authenticated signatures and delivery IDs before side effects. Its bounded in-memory history is not durable across restarts. Use durable idempotency at the side-effect boundary.

Native GitHub uses sha256= over rawBody without the SDK timestamp prefix. The Frame.io adapter uses the Kodera SDK envelope. Native provider signatures need a trusted ingress adapter; they are not interchangeable.

> Signature verification alone is neither tenant authorization nor a persistent replay guarantee.

## Ten reference implementations

The connector list below describes repository implementations, not connected production accounts. Frame.io routes asset.ready to dailies and comment/review events to post-production without fetching assets.

Linear, Stripe and Sentry are possible SDK integrations. This checkout does not contain additional reference connectors for those services.

> HTTPS syntax checks and disabled redirects do not pin DNS. Production egress must also enforce resolved-address and network policy.

## Connectors

- [Hello Webhook](https://github.com/kodera-hq/kodera/blob/main/extensions/hello-webhook/README.md): hello-webhook

- [GitHub Release Notifier](https://github.com/kodera-hq/kodera/blob/main/extensions/github-release-notifier/README.md): github-release-notifier

- [Uptime Incident Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/uptime-incident-bridge/README.md): uptime-incident-bridge

- [Docs Collab Announcer](https://github.com/kodera-hq/kodera/blob/main/extensions/docs-collab-announcer/manifest.json): docs-collab-announcer

- [GitHub Repo Tracker](https://github.com/kodera-hq/kodera/blob/main/extensions/github-repo-tracker/manifest.json): github-repo-tracker

- [Qonto Treasury Feed](https://github.com/kodera-hq/kodera/blob/main/extensions/qonto-treasury-feed/manifest.json): qonto-treasury-feed

- [Notion Workspace Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/notion-workspace-bridge/manifest.json): notion-workspace-bridge

- [GDrive Document Share](https://github.com/kodera-hq/kodera/blob/main/extensions/gdrive-document-share/manifest.json): gdrive-document-share

- [Social Pulse Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/social-pulse-bridge/manifest.json): social-pulse-bridge

- [Frame.io Review Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio-review-bridge/README.md): frameio-review-bridge

## Sources

- [packages/extension-sdk/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/extension-sdk/README.md)

- [extensions/frameio-review-bridge/README.md](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio-review-bridge/README.md)

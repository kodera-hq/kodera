# Extension SDK & 22 connectors

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

## Twenty-two reference implementations

The connector list below describes repository implementations, not connected production accounts. Studio starters route Frame.io timecode/OTIO markers and Flamenco/Deadline render telemetry without fetching private media.

External providers outside these twenty-two starters remain possible custom SDK integrations. This checkout does not contain additional reference connectors beyond the list below.

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

- [Frame.io Timecode & OTIO](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio/README.md): frameio

- [Render-Farm Monitor (Flamenco & Deadline)](https://github.com/kodera-hq/kodera/blob/main/extensions/renderfarm/README.md): renderfarm

- [GitHub Dev & PR Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/github/README.md): github

- [GitLab MR & Pipeline Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/gitlab/README.md): gitlab

- [Linear Issue & Cycle Triage](https://github.com/kodera-hq/kodera/blob/main/extensions/linear/README.md): linear

- [Sentry Issue & Regression Triage](https://github.com/kodera-hq/kodera/blob/main/extensions/sentry/README.md): sentry

- [Alertmanager & Grafana Incident Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/alertmanager/README.md): alertmanager

- [RSS & Security Advisories Digest](https://github.com/kodera-hq/kodera/blob/main/extensions/rss-advisories/README.md): rss-advisories

- [Release Notes & Triage Assistant](https://github.com/kodera-hq/kodera/blob/main/extensions/release-assistant/README.md): release-assistant

- [OpenProject & Jira Work Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/openproject/README.md): openproject

- [Cal.com Scheduling & Voice Bridge](https://github.com/kodera-hq/kodera/blob/main/extensions/calcom/README.md): calcom

- [Billing & Quota Ops Webhooks](https://github.com/kodera-hq/kodera/blob/main/extensions/billing-webhooks/README.md): billing-webhooks

## Sources

- [packages/extension-sdk/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/extension-sdk/README.md)

- [extensions/frameio-review-bridge/README.md](https://github.com/kodera-hq/kodera/blob/main/extensions/frameio-review-bridge/README.md)

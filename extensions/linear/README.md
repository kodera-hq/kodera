# `@kodera/ext-linear`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling Linear `Issue` (`create`, `update`, `remove`), `Comment` (`create` with plain-text quote previews), `Cycle`, and `ProjectUpdate` (`onTrack`, `atRisk`, `offTrack`) webhooks alongside the `/linear` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming Linear describes the webhook payload shape rather than an endorsement by Linear.

## Security & Reliability Guarantees

- **Constant-Time HMAC & Freshness Window**: Supports canonical Kodera `x-kodera-signature-256` signatures via `createWebhookHandler` and native `Linear-Signature` (`HMAC-SHA256`) constant-time verification via `timingSafeEqual`, paired with `webhookTimestamp` skew enforcement and `webhookId` replay rejection.
- **Plain-Text Comment Sanitization**: Extracts bounded plain-text quote previews from comment bodies and project updates with a linear-time character scanner that strips HTML markup and neutralizes unsafe URI schemes.
- **SSRF-Validated Issue & Project URLs**: Validates outbound links through `validateEndpointUrl` and restricts hosts to `linear.app`.

## Slash Command (`/linear`)

- `/linear status` — show configured team defaults
- `/linear issue --id=ENG-142` — inspect an issue card preview
- `/linear cycle --team=ENG` — inspect active cycle summary
- `/linear project --health=atRisk` — filter project health updates

## Verification

```bash
npm run test:sdk
```

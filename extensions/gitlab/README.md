# `@kodera/ext-gitlab`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling GitLab and self-hosted GitLab CE/EE `Merge Request Hook`, `Pipeline Hook`, `Push Hook`, `Tag Push Hook`, `Issue Hook`, `Release Hook`, and the `/gitlab` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming GitLab describes the webhook payload shape rather than an endorsement by GitLab.

## Security & Reliability Guarantees

- **Constant-Time Token & HMAC Verification**: Supports canonical Kodera `x-kodera-signature-256` signatures via `createWebhookHandler` and native `X-Gitlab-Token` verification by comparing fixed-width `SHA-256` digests with `timingSafeEqual` so secret length never leaks through timing.
- **Event & Replay Integrity**: Validates `X-Gitlab-Event` against `object_kind` inside the JSON body and blocks duplicate deliveries across `X-Gitlab-Event-UUID` and payload `SHA-256` digests.
- **Self-Hosted GitLab CE/EE Origin Pinning**: Validates custom GitLab instance origins and project links via `validateEndpointUrl`, rejecting plaintext HTTP, embedded credentials, loopback, link-local, and RFC1918 addresses.
- **Pipeline Stage & Failed-Job Breakdown**: Summarizes stage counts, formatted execution duration, and bounded failed job names without reflecting raw job logs or CI variables.

## Slash Command (`/gitlab`)

- `/gitlab status` — display configured GitLab origin and project defaults
- `/gitlab mr group/project --state=opened` — preview merge request filter
- `/gitlab pipelines group/project --ref=main` — inspect pipeline stage summary
- `/gitlab issues group/project --iid=14` — inspect or reference a project issue

## Verification

```bash
npm run test:sdk
```

# `@kodera/ext-sentry`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling Sentry and open-source GlitchTip `event_alert` and `issue` (`created`, `regressed`, `resolved`, `ignored`) webhooks alongside the `/sentry` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming Sentry or GlitchTip describes the webhook payload shape rather than an endorsement by either project.

## Security & Reliability Guarantees

- **Constant-Time `Sentry-Hook-Signature` & Kodera Signature Verification**: Supports canonical Kodera `x-kodera-signature-256` signatures via `createWebhookHandler` and native `Sentry-Hook-Signature` (`HMAC-SHA256`) constant-time verification via `timingSafeEqual`, paired with bounded replay deduplication.
- **Sanitized Stacktrace Preview**: Extracts a compact culprit frame (`file:line in fn`), environment, release version, and impacted user count while scrubbing home-directory prefixes, query strings and fragments with one bounded filename policy across chosen `filename`/`abs_path` frames and no-frame `culprit`/`metadata.filename` fallbacks, plus markup and control characters.
- **Anti-SSRF Issue URL Validation**: Validates issue links for Sentry and self-hosted GlitchTip origins via `validateEndpointUrl`, rejecting plaintext HTTP, embedded credentials, loopback, link-local, and RFC1918 addresses.

## Slash Command (`/sentry`)

- `/sentry status` — display configured project and origin defaults
- `/sentry issues --project=kodera-web --env=production` — preview filtered issue queue
- `/sentry resolve --issue=KODERA-WEB-4A` — prepare an issue resolution update
- `/sentry ignore --issue=KODERA-WEB-4A` — prepare an issue mute update

## Verification

```bash
npm run test:sdk
```

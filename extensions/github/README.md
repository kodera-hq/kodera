# `@kodera/ext-github`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling GitHub pull request lifecycles, code review verdicts, check suite and workflow run completions, issue triage, release publications, and the `/gh` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming GitHub describes the webhook payload shape rather than an endorsement by GitHub.

## Security & Reliability Guarantees

- **Dual Signature & Replay Verification**: Supports canonical Kodera `x-kodera-signature-256` (`v1=<hex>`) webhook signatures via `createWebhookHandler` and native GitHub `X-Hub-Signature-256` (`sha256=<hex>`) constant-time `HMAC-SHA256` verification via `timingSafeEqual`, paired with bounded `X-GitHub-Delivery` and signature replay protection.
- **Authenticated Event Binding**: Cross-checks `X-GitHub-Event` against the authenticated JSON payload structure so an unsigned event header cannot reroute a signed body.
- **Anti-SSRF URL & Slug Validation**: Enforces strict `owner/repo` slug syntax and validates outbound repository, pull request, workflow run, and release links through `validateEndpointUrl` against an explicit HTTPS host allowlist.
- **Linear-Time Plain-Text Sanitization**: Strips untrusted markup and control characters with a deterministic character scanner without backtracking regular expressions.

## Slash Command (`/gh`)

- `/gh status` — show configured repository defaults and triage summary
- `/gh pr owner/repo --state=open` — preview pull request queue filter
- `/gh checks owner/repo --branch=main` — inspect check suite and workflow run state
- `/gh triage owner/repo --number=42 --label=security` — prepare a structured issue triage action

## Verification

```bash
npm run test:sdk
```

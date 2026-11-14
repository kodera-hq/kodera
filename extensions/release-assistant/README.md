# `@kodera/ext-release-assistant`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling strict per-room opt-in bilingual (`fr`/`en`) changelog and release-notes drafting from conventional commits and merged pull requests, paired with an optional anti-SSRF validated HTTPS request builder for self-hosted chat-completions HTTP endpoints (Ollama / vLLM).

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to an external endpoint.

## Security & Privacy Guarantees

- **Strict Per-Room Opt-In Scope & Zero Telemetry**: Refuses to draft or publish release notes in any channel absent from `optInChannels`, and permanently disables background telemetry (`TELEMETRY_ENABLED = false`).
- **Deterministic Bilingual Formatter (Zero Endpoint Required)**: Categorizes `feat`, `fix`, `perf`, `security`, `docs`, and breaking (`!`) commits plus merged pull requests into clean French and English Markdown sections with no network dependency.
- **Anti-SSRF Self-Hosted HTTPS Endpoint Validation**: When an optional self-hosted Ollama or vLLM endpoint is configured, `buildSelfHostedSummarizerRequest` enforces `validateEndpointUrl(..., { allowLocalhostHttp: false })`, rejecting plaintext HTTP, loopback, cloud metadata (`169.254.169.254`), RFC1918 private subnets, and embedded credentials.
- **Constant-Time HMAC-SHA256 Verification**: Verifies `X-Release-Signature-256` (`sha256=<hex>`) with `timingSafeEqual` and canonical Kodera `x-kodera-signature-256` envelopes.

## Slash Command (`/release-draft`)

- `/release-draft status` — display room opt-in state and deterministic/self-hosted mode
- `/release-draft draft --tag=v1.4.0 --locale=bilingual` — generate bilingual (FR/EN) release notes in an opted-in room (also accepts `/release-notes` as a parser alias)
- `/release-draft opt-in-check` — verify whether the current channel is in `optInChannels`

## Verification

```bash
npm run test:sdk
```

# `@kodera/ext-renderfarm`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling Blender **Flamenco** and Thinkbox **Deadline** render-farm queue webhooks (`job.started`, `job.completed`, `job.failed`, `task.oom_killed`) and the `/render` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a render cluster, and naming Flamenco or Deadline describes the webhook payload shape rather than an endorsement.

## Security & Pipeline Guarantees

- **Flamenco & Deadline Normalization**: Normalizes shot codes (`SEQ010_SH040`), stepped or multi-span frame ranges (`1001-1120`), average frame render durations, and GPU/CPU worker hostnames into structured cards and OOM incident alerts.
- **Worker Hostname & Output URI Validation**: Enforces RFC 1123 worker node hostnames and sanitizes output URIs (`https://`, `s3://`, or `/renders/...` studio mounts) while refusing `..` traversal, embedded credentials, SSRF targets, and local home-directory paths.
- **Constant-Time HMAC-SHA256 & Replay Guard**: Verifies `X-Renderfarm-Timestamp` + `X-Renderfarm-Signature` (`sha256=<hex>`) via `timingSafeEqual` alongside canonical Kodera `x-kodera-signature-256` envelopes.

## Slash Command (`/render`)

- `/render status` — display render queue monitor status
- `/render queue --scheduler=flamenco` — inspect Flamenco or Deadline queue state
- `/render shot SEQ010_SH040 --frames=1001-1120` — inspect frame range and shot progress
- `/render workers --pool=gpu-optix` — inspect render node pool status

## Verification

```bash
npm run test:sdk
```

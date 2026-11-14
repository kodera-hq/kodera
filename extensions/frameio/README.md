# `@kodera/ext-frameio`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling Frame.io post-production dailies webhooks (`comment.created`, `comment.completed`, `asset.ready`, `review_link.created`), SMPTE 12M timecode conversion, OpenTimelineIO (`OTIO`) marker summaries, and the `/dailies` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming Frame.io or OpenTimelineIO describes the payload format rather than an endorsement.

## Security & Studio Capabilities

- **SMPTE 12M Timecode Engine**: Exact non-drop (`HH:MM:SS:FF`) and `29.97` drop-frame (`HH:MM:SS;FF`, 17,982 frames per 10-minute block) formatting across `23.976`, `24`, `25`, `29.97`, `30`, and `60` fps.
- **OpenTimelineIO (`OTIO`) Marker Summaries**: Bounded traversal of `Timeline.1`, `Track.1`, `Clip.1`, and `Marker.2` payloads with rational-time frame conversion.
- **Timestamped HMAC-SHA256 Verification**: Constant-time `timingSafeEqual` verification of `X-Frameio-Request-Timestamp` and `X-Frameio-Signature` (`v0=<hex>` over `v0:${timestamp}:${rawBody}`), plus canonical Kodera `x-kodera-signature-256` envelopes and bounded replay protection.
- **Anti-SSRF Review URLs & Plain-Text Sanitization**: Enforces HTTPS host allowlists via `validateEndpointUrl` and strips untrusted HTML/Markdown markup in linear time.

## Slash Command (`/dailies`)

- `/dailies status` — display dailies review bridge status
- `/dailies timecode --frame=1800 --fps=29.97 --drop-frame=true` — convert a frame count to SMPTE timecode
- `/dailies otio --timeline=Reel_02 --fps=24` — inspect OpenTimelineIO timeline marker settings
- `/dailies reviews --project=Feature_Cut` — inspect active asset review queue

## Verification

```bash
npm run test:sdk
```

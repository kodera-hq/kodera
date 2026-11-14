# `@kodera/ext-calcom`

Status: Reference implementation (`Apache-2.0`)

Reference Kodera extension built on [`@kodera/extension-sdk`](../../packages/extension-sdk) modeling open-source Cal.com scheduling webhooks (`BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `MEETING_STARTED`), UTC/ISO-8601 window validation, Kodera voice room jump actions (`🔊 office-hours`), and the `/schedule` slash command.

Exercised with synthetic fixtures against the SDK in-memory harness only. Nothing in this repository installs, hosts, or connects this package to a provider account, and naming Cal.com describes the webhook payload structure rather than an endorsement.

## Security & Scheduling Guarantees

- **Constant-Time `X-Cal-Signature-256` Verification**: Verifies hex HMAC-SHA256 digests over exact raw bytes with `timingSafeEqual`, paired with `createdAt` skew bounds, canonical Kodera `x-kodera-signature-256` support, and bounded replay protection.
- **Strict UTC/ISO-8601 Window Normalization**: Requires explicit UTC (`Z`) or numeric timezone offsets on `startTime` and `endTime`, rejects inverted or multi-day windows, and normalizes all booking cards to UTC.
- **Participant Privacy & Voice Room Jump Actions**: Emits participant counts without exposing raw attendee email addresses or phone numbers, threads reschedules and cancellations onto the root booking `uid`, and validates Kodera voice room jump URLs via `validateEndpointUrl`.

## Slash Command (`/schedule`)

- `/schedule status` — display scheduling bridge defaults and target Kodera voice room
- `/schedule upcoming --window=today --room=office-hours` — preview upcoming booking routing
- `/schedule room --room=studio-standup` — configure the designated Kodera voice room jump target
- `/schedule booking --uid=bk_ref_001` — inspect a booking correlation reference

## Verification

```bash
npm run test:sdk
```

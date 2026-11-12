# Messaging media, direct conversations and notifications

Status: Implemented for review on Core API 0.43.0; service release remains separate.

## Spec

### Attachments

- **Checks on the device.** A file dropped on the composer, pasted into it or chosen with « Préparer des pièces jointes » is checked before a byte leaves (`messaging/attachments/uploadPreflight.ts`).
  - It is refused when it is empty, larger than the contract's 25 MiB, or a page, script, SVG or program. The type the browser reports does not matter, and every extension in the name counts.
  - A file that claims to be a PNG, JPEG, GIF, WebP or PDF must start like one. Any other file must not start like markup.
  - Its name loses any path and every control or direction-override character.
- **Upload.** A checked file is sent at once (`uploadAttachment.ts`):
  1. Core issues a ticket for its name, type, size and SHA-256.
  2. The bytes go by `PUT` to the ticket's presigned address, with exactly the ticket's headers. The request carries no cookie, no referrer and no Kodera token.
  3. Core completes the upload, and the console checks the digest it returns.
  - A ticket that is not https, carries credentials in its address, asks for another method or names a credential header is refused before a byte leaves.
- **Sending.** The message waits while any file is still sending, or refused and not yet removed. The composer lists each file with its state, and shows at most ten (`attachmentQueue.ts`).
- **Where the bytes may go.** The console's policy allows the upload under the deployment's `--attachment-base` only: an https origin with a path ending in `/` (`server/static.mjs`). A bare origin, a wildcard, or Core's or the identity provider's origin is refused at start. A deployment without the flag offers no upload, since its policy blocks one. `storageTransport.ts` is the one file where ESLint allows `fetch`.
- **In the message.** The Matrix event names each file by Core's id under `io.kodera.attachments`, never by an address. Its `body` falls back to « 📎 name » lines for other clients.
- **Reading a file reference.** A reader keeps only references that look like Core's: a UUID, a known type and a positive size. The name is cleaned. Opening one asks Core for a fresh, short-lived download address, which must be https, and opens it in a new tab with no opener. No image from storage is drawn inside the console.

### Link previews

- Core fetches the page (`unfurlUrl`). The console asks once per address and page life (`unfurl/unfurlCache.ts`), for the first http(s) address outside code.
- The card is refused whole unless all of these hold (`unfurl/safeUnfurl.ts`):
  - the result is for the address in the message;
  - the result's address is http or https, never `javascript:`, `data:`, `vbscript:`, `file:` or `blob:`;
  - no credentials are in the address;
  - no control character is in the address before the browser would strip it;
  - any canonical address is http or https too.
- A canonical address on another site is not followed.
- Text loses control, zero-width and direction-override characters, and is cut on whole characters.
- No image is drawn. `img-src 'self'` stays as it is, and a remote image would tell its host who read the message.

### Direct conversations

- The sidebar's « Messages directs » lists the joined rooms that `m.direct` names, by their people's names (`matrix/directs.ts`, `DirectMessages.tsx`).
- « Nouveau » opens a conversation with one to eight Matrix ids:
  - the joined room already held with exactly those people is reused;
  - otherwise a private, `is_direct` room is created, with those people invited, and listed under each of them in `m.direct`.
- A direct conversation is drawn in the main view as a channel is, with its own timeline and composer. The address stays the channel's. Choosing a channel, or a change of address, leaves the direct conversation.

### Notifications

- A bell beside the organisation lists the member's notifications (`listNotifications`). It shows the unread count and offers « Tout marquer comme lu » (`markNotificationsRead`).
- It reads Core on mount and every minute while the page is shown. Unknown kinds are dropped.
- Marking read shows at once. A refusal shows the items unread again.
- **Web Push carries no payload.**
  - Subscribing is refused unless Core's key says `payloadMode: "empty"`. Core's VAPID key must be an uncompressed P-256 point. The subscription must be https, with keys of the contract's sizes.
  - The worker (`public/push-sw.js`) never reads what a push carries and fetches nothing. It shows the line the page last gave it in the member's language, and opens or focuses the console on a click.
  - The device's id is kept under `kodera.web.push-device`, which the console's sign-out clears.

### Invite links and moderation

- Settings › « Liens d’invitation et modération » is shown to owners and administrators only (`workspace/moderation/`).
- **Invite links.**
  - Create a link valid for 1 to 30 days, with 1 to 10,000 uses, as a member or a moderator.
  - The new link is shown once. Its code rides in the fragment of `/join#code`, which no server receives.
  - Active links are listed, and can be revoked.
- **Reports.**
  - The open reports are listed. Each is resolved or dismissed with a written decision.
  - The contract gives a report no read of its own and its list no tags. The decision is therefore first sent against a version Core cannot hold. On `412`, the report is read again, and the decision is re-sent with Core's current tag only while the report is still open. A decision another moderator made meanwhile is never overwritten.
- **Moderating a member.** Mute, remove, ban or lift a ban, by membership id, with a reason. Mute and ban also take a duration.
- **`/join#code`** (`invitation/JoinScreen.tsx`).
  - The code is read from the fragment and removed from the address and the history entry at once. It is kept in memory only.
  - The screen previews the organisation, role and expiry, and joins only on a click, under one idempotency key per page.
  - A refusal says what to do: sign in, ask for a new link, or try again.

## Acceptance

Run:

```
npx vitest run src/features/messaging src/features/notifications src/features/workspace/moderation src/features/invitation/joinCode.test.ts src/features/espace/matrix tests/unit/serving tests/unit/espace-network-boundary.test.ts
```

The refusal tests are in `uploadPreflight.test.ts`, `uploadAttachment.test.ts`, `attachmentRefs.test.ts`, `safeUnfurl.test.ts`, `push.test.ts`, `notificationFeed.test.ts`, `moderationApi.test.ts`, `joinCode.test.ts`, `directs.test.ts` and `headers.test.ts` (`--attachment-base`).

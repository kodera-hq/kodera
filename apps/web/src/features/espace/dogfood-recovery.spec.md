# Workspace invitation and navigation recovery

Status: Implemented; hosted acceptance pending.

Matrix invitations are explicit user decisions. The sidebar and notification panel show pending
rooms with accept/join and decline/leave actions. A direct invitation carries `is_direct`, or is
an unnamed, unaliased room with exactly the recipient and inviter. Acceptance preserves existing
`m.direct` entries and records the inviter before joining; a failed account-data write leaves the
invitation available for retry. No acceptance path sends content or changes room classification.
Confidential and unclassified rooms retain the existing plaintext quarantine. While joined sync
is pending after acceptance, the previous channel composer is withheld.

Every text-channel, audio-channel and direct-conversation selection requests the chat canvas,
including selection of the already-active channel from Docs or Files. Membership and media
capability checks still decide whether joining or sending is allowed.

The Matrix SSO token exchange keeps credentials in memory under console ADR-0007. Reloads still
require SSO; no access token, refresh token or login token is persisted in browser storage.
A login 429 lazily loads recovery code, honours the longer valid `retry_after_ms` or `Retry-After`
(seconds or HTTP date), and retries at most twice within a total 15-second wait budget. A cooldown
outside that budget or exhausted recovery shows a specific rate-limit notice and console return
link. A session generation change prevents another login retry after sign-out.

Acceptance: `matrix/store.invites.test.tsx`, `matrix/loginRetry.test.ts`, `auth/matrix.test.ts`,
`app/espace-callback-route.test.tsx` and `EspaceLiveView.test.tsx`. Store tests use actual SDK rooms
with synthetic membership/account data; no live service or production credential is required.

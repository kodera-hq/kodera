# Workspace moderation and reusable invitations

Status: Implemented; production service release remains operator-controlled

The contract is Core 0.43.0 and Agent 0.6.0. A moderator is a workspace grant on a
current organisation membership; organisation roles remain unchanged. Owners and
administrators administer invite links. Moderators may kick, ban, unban and mute
ordinary members and resolve reports; protected owner/admin targets are refused.
All moderation actions append audit events in the same database transaction.
Moderation, invitation and report references restrict parent deletion to preserve evidence.

A workspace row serializes membership moderation and grant changes before engine
heads are locked. Bans and kicks remove subjects from the projected audience;
removed-member join blocks and timestamped mutes reach the agent's room policy.
Native public rooms check removal blocks on every join, including a kick until
readmission. Disabled and soft-deleted identity subjects remain in these facts
because an older Matrix session may still exist. Message and media guards check
mute expiry on every event/token, independently of a scheduled expiry job.

Invite codes are random; link rows store only their SHA-256 digests. Creation
responses use the existing authenticated 24-hour replay store, including its response
body retention. A link row is locked
before checking revocation, expiry and usage, creating a membership and incrementing
its counter. Database checks require positive capacity and a counter within bounds.
Each first redemption consumes one use, including an existing organisation member
receiving a channel or moderator scope. Retries by the same member never consume
another use. A kicked member must redeem a new link to rejoin; a previously redeemed
link cannot reverse the kick. A banned member is refused. Codes never enter URLs,
audit metadata, logs or cursors. Redemption requires an enabled persisted identity,
an exact organisation issuer and verified email. It cannot create a first owner. The existing verified-principal mutation bucket
rate-limits previews and redemptions before their handlers execute.

Acceptance tests must prove protected targets refuse without effects, expired mutes
allow publishing, ban/unban propagates to native-join rooms, concurrent redemptions
cannot exceed capacity, revoked/expired links refuse, constraints reject invalid
counters, report queues are scoped and every successful moderation is audited.

Report resolution is a single transition from `open` to `resolved` or `dismissed`.
It accepts the exact report ETag, or RFC 9110 `If-Match: *` for a queue action. A
concurrent second resolution returns conflict and cannot overwrite the first decision.
The creator's POST response supplies the report ETag; the queue permits the wildcard
without disclosing an additional report metadata endpoint.

The agent reconciles its own bans after writing policy and before joining readmitted
members. It preserves independent operator bans, including when a Core ban is
applied and later removed. An unavailable moderation transport stops the pass
after its first failed room. Unchanged incremental room fingerprints avoid another
ban inventory read; a full reconciliation repairs external state drift.

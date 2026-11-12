# `@kodera/api-contract`

Canonical OpenAPI specifications shared across `apps/server`, `apps/web`, `apps/desktop`, `apps/ios`, and `apps/android`.

- `core-api.openapi.yaml`: Kodera Control Plane & Workspace HTTP API.
- `agent-api.openapi.yaml`: Kodera Tenant Agent internal reconciliation contract.

Licensed under `Apache-2.0`.

## Workspace increment 0.43.0

Status: Proposed

The additive Core contract declares moderation and reports, reusable invite links,
checksum-bound attachments, public-target URL previews, a private notification inbox,
empty-body push wakeups, workspace documents and short-lived collaboration tickets.
These declarations do not assert that their HTTP handlers or deployment are available.
There is no chat-to-document promotion operation.

Acceptance requires byte-identical server/web copies, the explicit cursor inventory,
valid response examples, and generated web types pinned to the commit containing this
contract. Preserve that commit with a merge commit when integrating the pin.

Moderation is a workspace grant on a current organisation membership; it does not add
an organisation billing role. Moderators cannot target owners or administrators.
The agent 0.6.0 projection adds optional bans and expiring mutes to the existing
channel-members reconciliation command, preserving older producers.

URL previews reuse the established RFC 9457 `forbidden` type with the closed
`blocked-target` / `private-target` reason vocabulary. The resolver must validate all
answers and pin the connection separately for every redirect. Push subscriptions
must apply that outbound transport policy too. Push wakeups carry an empty body.

A collaboration ticket is valid for at most five minutes, one organisation and one
document. Viewers can receive sync and awareness but cannot submit state updates;
refusal is audited. Templates are `spec`, `adr`, `meeting_notes` and `runbook`.

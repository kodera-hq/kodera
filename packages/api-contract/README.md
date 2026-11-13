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

## Collections, quotas, billing artifacts and privacy increment 0.44.0

Status: Proposed

The additive contract defines typed collection properties and values, saved table,
board and list views, bounded server-validated queries and document-backed rows.
Every collection and row follows current workspace visibility and document editor
permissions. The query body carries filters and sorts; its shared `cursor` and
`limit` query parameters retain the existing signed cursor envelope. A row removal
removes collection membership, while document deletion remains a separate operation.

Workspace quota usage and limits describe seats, reserved and committed media bytes,
and pages. A null configured limit explicitly means unlimited. Writes reserve usage
server-side in the same transaction as their mutation. Capacity refusals distinguish
seat/page subscription exhaustion (402), media bytes (413) and request rate (429).

Invoice downloads preserve their PDF default and accept an optional `format=xml`.
Credit notes gain the same download surface. Artifacts bind immutable Core snapshots:
PDF/A-3 with embedded Factur-X EN 16931 XML, invoice code 380 and credit-note code 381.
Core remains the gap-free numbering and legal invoicing authority; a payment collector
never becomes a second invoice authority. Persisted VIES evidence distinguishes
valid, invalid, unchecked and unavailable outcomes without changing issued snapshots.

Account export/deletion binds the current person; workspace export/deletion requires
its current owner. Distinct lifecycle schemas prevent exporting a workspace through
an account request or reporting an export-ready deletion. Resumable signed export
archives carry checksums and expiry. Deletion revokes active access and retains only
lawfully required accounting snapshots under the ten-year retention clock; legal
holds and pending retention remain explicit states. A last owner transfers ownership
before deleting their account.

These are proposed wire surfaces, not evidence of deployed HTTP handlers, certified
billing documents, a working VIES service or completed data deletion. Server and
client implementation lanes supply their own runtime proofs.

Offline acceptance uses `apps/server/contracts/check_wave_surfaces.py --selftest`,
which also runs the 0.44.0 checks and named refusal mutations. Acceptance additionally
requires contract byte parity, the authorization matrix and cursor inventories,
OpenAPI lint and compatibility classification, regenerated web consumers and the
current contract pin. Preserve the source commit with a merge commit when integrating.

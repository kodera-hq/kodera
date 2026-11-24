# `@kodera/api-contract`

Canonical OpenAPI specifications shared across `apps/server`, `apps/web`, `apps/desktop`, `apps/ios`, and `apps/android`.

Status: Active. `core-api.openapi.yaml` is at `0.61.0` and `agent-api.openapi.yaml` at `0.11.0`.

- `core-api.openapi.yaml`: Kodera Control Plane & Workspace HTTP API.
- `agent-api.openapi.yaml`: Kodera Tenant Agent internal reconciliation contract.

Licensed under `Apache-2.0`.

## Workspace increment 0.43.0

Status: Implemented. `apps/server` routes every operation of this increment — moderation,
invite links, attachments, URL previews, the notification inbox, empty-body push wakeups,
workspace documents and collaboration tickets are the Wave 2B and Wave 3 boundaries
recorded in [`docs/specs/collaboration-status.md`](../../docs/specs/collaboration-status.md).

The additive Core contract declares moderation and reports, reusable invite links,
checksum-bound attachments, public-target URL previews, a private notification inbox,
empty-body push wakeups, workspace documents and short-lived collaboration tickets.
OpenAPI declarations and routed handlers are not evidence of a live deployment; server
and client implementation lanes supply their own runtime proofs.
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

Status: Implemented in source (`apps/server` routes the collection
([`apps/server/apps/docs/api/urls.py`](../../apps/server/apps/docs/api/urls.py)), quota,
credit-note, and GDPR/privacy export and deletion HTTP endpoints in
[`apps/server/apps/orgs/api/privacy.py`](../../apps/server/apps/orgs/api/privacy.py));
statutory retention worker execution and archive storage activation remain operator-gated per
[`PRIVATE_EXPORT_RUNTIME.md`](../../apps/server/apps/orgs/PRIVATE_EXPORT_RUNTIME.md) and
[`docs/specs/collaboration-status.md`](../../docs/specs/collaboration-status.md).

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

OpenAPI declarations and routed handlers are not evidence of a live deployment,
certified billing documents, a reachable VIES service or completed data deletion. Server
and client implementation lanes supply their own runtime proofs.

Offline acceptance uses `apps/server/contracts/check_wave_surfaces.py --selftest`,
which also runs the 0.44.0 checks and named refusal mutations. Acceptance additionally
requires contract byte parity, the authorization matrix and cursor inventories,
OpenAPI lint and compatibility classification, regenerated web consumers and the
current contract pin. Preserve the source commit with a merge commit when integrating.

## Collaboration, Sovereignty, Extensions & Self-Serve increments 0.45.0–0.61.0

Status: Implemented in `apps/server` and `apps/web` (`core-api.openapi.yaml` `0.61.0`); operator feature flags (`KODERA_E2EE_RELAY_ENABLED`, `KODERA_AI_GATEWAY_ENABLED`, `KODERA_CHANNEL_GOVERNANCE_ENABLED`, `KODERA_BILLING_ENABLED`) gate optional subsystems at runtime.

- **`0.45.0–0.51.0` (Waves 6–9):** Outbound extension runtime v2, `Slack`/`Discord`/`Notion` workspace importers, `.well-known` discovery, `Kodera Passport` PKCE cross-workspace magic-link sessions, voluntary `#proximity` epoch-lease check-ins, and `/organisations/{organisation_id}/confidential/*` HPKE KeyPackage & opaque envelope relays.
- **`0.52.0–0.58.0` (Wave 10 & Governance / Sovereignty):** Bilateral `PartnerChannelAgreement` bridges and `single_channel_guest` grants, operator-gated confidential room/session directory, consecutive MLS epoch provisioning and proof-bound cross-signing bundles, workspace identity/mode administration, sovereign `ai_gateway` (written translation and multi-party consent-gated live call captions), Community boosts, VIP passes and DAC7 reporting, CalDAV calendar sync and zero-PII `.ics` booking, and the `0–100` cybersecurity posture advisor.
- **`0.58.1–0.60.0` (Extensions, Experience & Key Backup):** Declarative `kodera.widget.v1` action relay and web extension marketplace, sanitized RIFF/WebP custom emojis, scheduled messages, personal reminders and per-member *Kodera Labs* preferences, and operator-gated server opaque `KVKB1` key-backup publication (`GET`/`PUT`/`DELETE /organisations/{organisation_id}/confidential/key-backup`).
- **`0.61.0` (Self-Serve Onboarding):** Cardless shared-realm SMB workspace creation (`POST /api/v1/workspaces/self-serve`, `Idempotency-Key` required, `<= 5` seats, `< 5 s`) and `shared_realm` / `plan_tier` metadata on `MeMembership` (`GET /api/v1/me`).

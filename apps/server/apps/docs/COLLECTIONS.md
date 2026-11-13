# Collections and resource quotas

Status: Draft — source implementation; deployment qualification remains pending.

Collections attach typed JSONB values to existing native documents. A collection has a creator,
properties and saved table, board and list views. The creator and current workspace administrators
edit its schema. Reading rows additionally requires current document visibility; editing a row
requires both collection and document editing authority. Collection deletion retains its rows and
never deletes the underlying pages.

Property types are text, number, checkbox, date, URL, select, multiple select and workspace person.
Status, priority, tags and assignee fields use these primitives. Unknown fields, duplicate IDs,
invalid options, incompatible filters and invalid view references are refused. A populated schema
cannot be reinterpreted silently. PostgreSQL additionally checks workspace ownership, row bindings,
JSON bounds and value types. Property IDs pass through JSON key expressions, never field traversal
or SQL interpolation. The values index uses JSONB path operations.

Queries combine at most 50 filters and ten scalar sorts. The document ID breaks sort ties. A signed,
expiring cursor binds the collection revision, complete query and current caller. Changing rows or
the query invalidates continuation; current document access is checked again on every page. A row
GET supplies its ETag. An initial PUT requires `If-None-Match: *`; subsequent PUT and DELETE
require the current `If-Match` ETag. Supplying both conditions is refused.

## Explicit quota snapshots

`WorkspaceQuota` is server-owned. The Community migration explicitly records
`community-unlimited-v1` for seats, media and pages, preserving the existing Community policy.
Null in that recorded snapshot deliberately means unlimited. Deleting a policy makes resource
admission unavailable; an absent row never selects an unlimited fallback. Commercial provisioning
must apply its reviewed limits explicitly through the supervised `configure_workspace_quotas`
command. Capacity-tier seat/storage sizing guides are not interpreted as contractual ceilings.

PostgreSQL serializes page admission and upload reservations on the workspace. Media reservations
remain counted after upload-link expiry until actual object cleanup is implemented, preventing
expired reservations from concealing stored bytes. Deferred seat checks count active memberships
and outstanding invitations after an acceptance transaction completes. Snapshot and update-frame
limits also apply to direct native collaboration writes, without granting the collaboration login
access to quota configuration. Application credentials cannot change these snapshots.

Quota responses expose usage, explicit limits and measurement time. Refusals use the existing
problem registry: `402 subscription-required` for seats/pages, `413 payload-too-large` for bytes,
and the existing `429 rate-limited` admission boundary. Metadata names the quota and its limit,
usage, requested allocation and remaining allowance. Runtime timeouts and database credentials
are unchanged.

## Release boundaries

The server lane depends on contract 0.44. PostgreSQL migration, concurrency, restricted-role and
HTTP qualification must pass before review. The temporary test harness can increase only its
own query timeout on a slow workstation; this does not qualify different production settings.
Privacy export and deletion have separate provider-completeness and statutory-retention gates.
An injected archive pipeline is not evidence of a complete live GDPR export or completed erasure.

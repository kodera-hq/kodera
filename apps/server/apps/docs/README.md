# Native workspace documents and realtime collaboration boundary

Status: Implemented; production service release remains operator-controlled

Workspace documents live in PostgreSQL under workspace-serialized write ownership,
parent-tree validation, wikilink resolution, prefix/full-text search, and an
immutable binary update journal backed by compacted snapshots. Every read,
mutation, backlink page, search page, and realtime session grant checks active
organisation membership, workspace moderation state, inherited channel policy,
and per-document grants through `docs_document_role`.

REST document creation and Markdown replacement run through the private HTTP
transform endpoint (`KODERA_COLLAB_ENGINE_URL`, `/internal/transform`) using
requests signed with `KODERA_COLLAB_TICKET_KEY`. Browser clients never reach
the transform endpoint; `createDocumentCollabSession` mints short-lived HMAC
tickets for `KODERA_COLLAB_PUBLIC_URL` (`/documents/collab`), where the
Node.js `yjs_collab` service authenticates the first WebSocket frame, enforces
closed ProseMirror/TipTap schema invariants, bounds presence payloads, appends
and compacts binary Yjs updates in PostgreSQL, and records identifier-only
audit events through the bounded `docs_collab_audit` database port. Its dedicated
database login holds only document table/column grants; authorization and audit
ports fence foreign-table access. Each ticket nonce is committed as redeemed
before its first snapshot is disclosed, so reconnects obtain a fresh ticket.

Read context resolution (including collection queries and quota reads) takes no
workspace row lock. Structural and quota-mutating writes authorize before taking
the workspace lock and recheck authority after acquiring it. Document PATCHes
replace outgoing links in batches only for changed Markdown; creation and renaming
resolve incoming references through the indexed old/new title buckets.


## Subteam document permissions

Status: Implemented in Core API 0.62.0

`DocumentRoleGrant` binds a document to a workspace role whose `kind` is `subteam`.
The database enforces the workspace boundary, prevents a referenced subteam from
changing kind, and cascades grant removal on hard document or role deletion.
Soft-deleted documents retain their grants until erasure. Concurrent kind changes
and grant creation serialize through the role row, including at snapshot isolation.

At each node in the existing document-to-ancestor traversal, explicit member grants
and assigned subteam grants are combined with `editor` winning over `viewer`.
Each ancestor and its channel policy still restrict access. A grant on a child
does not open a restricted ancestor. Confidential channel documents additionally
require active room participation by the exact device in the issuer-signed
`kodera_device_id` UUID claim, bound to the caller's current identity and membership;
non-participants receive the same hidden-resource refusal as other invisible documents.
The issuer must derive the device claim from authenticated device/session state, never
from caller-editable profile attributes.
Missing device claims fail closed for room-bound documents, including for organisation
administrators. Tickets carry that device ID; every socket fence rechecks its participation
and revocation status. Standalone confidential document epoch contracts are unchanged.
Core reads, ORM list expressions, tickets, and the restricted collaboration fence
all use `docs_document_role`; the collaboration login gains no grant-table access.

Editors read direct grants at `GET documents/{document_id}/role-grants` and use
that response's exact ETag for `PUT` or `DELETE` on
`documents/{document_id}/role-grants/{role_id}`, under the organisation workspace
API prefix. Listing reads authority, revision and grants at repeatable-read isolation
without taking the workspace structural write lock. Both mutations lock the document
before grant DML and return the complete direct grant set. Changes increment the
revision, emit a collaboration notification, and record an audit event. Unchanged
PUTs and absent DELETEs preserve the revision, ETag and audit history. Missing tags
return 428; stale or wildcard tags return 412. The 412 responses carry the same
current ETag in the header and problem body. Every response prohibits caching. Available subteams come from `listWorkspaceRoles`,
which active members can already read.

The web client port is `documentRoleGrantsApi.ts`. Its list, put, and revoke
functions return a complete `DocumentRoleGrantsState`; Share dialogs replace their
state with that response and refresh after a precondition failure before the
editor reviews another change. `listDocumentSubteams` exposes only subteams with
`@slug` labels. The module leaves Share-dialog rendering to its caller.

Migration `0013` takes short metadata locks on existing tables when installing the
subteam kind trigger and foreign keys. The migration is atomic, with a five-second
lock timeout and a thirty-second statement timeout. If busy writers prevent lock
acquisition, retry the complete migration during a quieter window. Rollback locks
the grant table exclusively and refuses with SQLSTATE `23514` while any grant
remains: operators must explicitly resolve those grants first to avoid promoting
restricted viewers to workspace editors.

Collection queries recompute stored idempotency replays under current collection
and document authority, so removed subteam access never returns cached rows.

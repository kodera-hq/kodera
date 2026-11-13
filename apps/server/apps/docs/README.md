# Native workspace documents and realtime collaboration boundary

Status: Proposed

Workspace documents live in PostgreSQL under workspace-serialized ownership,
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
audit events through `audit_workspace_resource_event`.

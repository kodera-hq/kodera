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

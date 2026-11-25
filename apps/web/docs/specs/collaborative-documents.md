# Collaborative workspace documents

Status: Implemented web surface for review; document records remain compatible with Core API 0.61.0. Service qualification remains separate.

## Spec

### Unified Drive & Docs

- Studio navigation exposes one **Drive & Docs** destination for both `docs` and legacy `files` canvas commands. Channel and direct-message selection returns to chat. The channel header is hidden on these document surfaces.
- `DocsWorkspacePanel` renders the workspace directly. Standalone `EspaceLiveView` mounts lazily load the same workspace through `EspaceCanvasPanes`, including channel attachments and shared documents.
- The collapsible Drive & Pages tree and explorer share folder navigation. The explorer provides search, grid/list views, name/modification sorting, and six filters: All, Folders, Pages, Databases, Whiteboards, Files.
- Item kinds round-trip through the existing Markdown field: `<!-- kodera:drive-folder -->`, `<!-- kodera:doc-kind:base -->`, and `<!-- kodera:doc-kind:whiteboard -->`. Pages retain their rich editor, Markdown source, outline, backlinks, presence, and Markdown export. Databases open the existing Table/Kanban collection component; validated row metadata is retained in a bounded `kodera:collection-rows:v1` Markdown comment. Whiteboards use the existing Yjs canvas and scoped offline persistence.
- The virtual **Channel attachments** folder aggregates only accessible ordinary/community sources. Protected, unknown, invalid, and explicitly confidential sources are excluded before their timelines are read. File previews retain an explicit **Open conversation** action; shared documents open in the editor.
- Uploads use the existing attachment queue and Core storage transport when a workspace and query provider are available. Other hosts may supply a controlled file callback. Upload destinations and sends recheck room boundaries.
- **Share** reports the current role and folder inheritance, and copies an internal document link without granting access. Confidential rooms disable link copying, creation, uploads, publication, and plaintext body writes. Database metadata and kind writes use existing document preconditions; no backend schema field is added.
- Publishing a workspace page to a channel retains its document ID. Chat cards resolve both channel documents and workspace pages for **Open in Docs**.
- Developer documentation opens the external portal at `https://kodera.io/docs` with opener isolation. Static `/llms.txt` and `/developer-docs/*.md` artifacts remain generated and checked separately.
- `DriveUnified.test.tsx`, `driveKinds.test.ts`, the existing editor/collection/whiteboard suites, and the affected production-browser specs cover these paths. Full cloud matrices remain a separate check.

### Licence boundary (`B1`)

- Every runtime and build dependency of the collaborative block editor carries a permissive licence (`Apache-2.0`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, `ISC`, `CC0-1.0`, `Unlicense`, `BlueOak-1.0.0`, `Python-2.0`).
- Copyleft licences (`GPL`, `AGPL`, `LGPL`, `MPL`, `SSPL`, `EUPL`, `OSL`, `CPAL`, `EPL`, `CDDL`, `UNLICENSED`) and the `@blocknote/*` package scope are refused at preflight by `scripts/ci/check-licenses.py` and `tests/unit/licenses.test.ts`.
- Compound SPDX expressions (`OR`, `AND`, parenthesised groups, `WITH` exceptions) are parsed structurally: `MIT OR GPL-3.0-only` is accepted because `MIT` satisfies the policy, whereas `MIT AND GPL-3.0-only` is refused because both obligations apply.

### Nested workspace page tree

- Workspace documents (`GET /organisations/{organisation_id}/workspace/documents`) form a bounded hierarchy (`pageTree.ts`):
  - Pages can be created at the workspace root (`parentId: null`) or nested as subpages up to `MAX_DOCUMENT_TREE_DEPTH = 16` levels.
  - Reparenting (`PATCH /organisations/{organisation_id}/workspace/documents/{document_id}` with `If-Match`) refuses self-parenting, ancestor-to-descendant cycles, and moves whose subtree would exceed depth `16`.
  - Sibling pages can be reordered deterministically (`up` / `down`).
  - Deleting a page (`DELETE /organisations/{organisation_id}/workspace/documents/{document_id}`) refuses non-empty parent pages (`409` or local `has_children`) and instructs the member to move or delete subpages first.
- Four Core `0.43.0` starter templates are offered alongside a blank page in French and English:
  - `spec` (functional specification),
  - `adr` (architecture decision record),
  - `meeting_notes` (meeting minutes and action items),
  - `runbook` (operational runbook).

### Realtime collaboration, offline buffer and sign-out privacy

- Opening a workspace page requests a short-lived collaboration ticket via `POST /organisations/{organisation_id}/workspace/documents/{document_id}/collab-session` (`collabSession.ts`).
- **WebSocket transport hygiene.**
  - Only `wss:` origins (and loopback `ws:` in local testing) without embedded credentials and without query-string tokens are accepted.
  - The session ticket is sent in the first WebSocket frame (`{"type":"auth","token":"..."}`), never in the URL.
  - Document state and live cursor presence synchronise over `y-protocols/sync` and `y-protocols/awareness` binary frames.
  - Unexpected disconnects retry with bounded exponential backoff (`500 ms` up to `8 000 ms`, capped at `6` attempts). Close code `4401` refreshes the ticket once; `4403` transitions immediately to read-only `forbidden`.
- **Offline buffer and sign-out wipe.**
  - Editor sessions cache `Y.Doc` updates locally in IndexedDB under `kodera-docs-yjs:<scope>:<documentId>` (`y-indexeddb`), bounded to at most `64` databases on the device.
  - `clearLocalSessionStorage()` (`src/auth/localSession.ts`) runs registered teardown hooks and deletes every `kodera-docs-yjs:*` IndexedDB database on sign-out so shared devices retain zero cached document state.
- **Strict `viewer` read-only enforcement.**
  - When `role === 'viewer'` (or `4403`), ProseMirror runs with `editable: false`, displays a read-only notice, hides block-insertion, table-mutation and page-hierarchy controls, skips IndexedDB persistence, and drops every outbound Yjs sync update frame.

### Rich blocks, `/` slash menu and strict CSP (`style-src 'self'; style-src-attr 'none'`)

- The collaborative editor (`CollaborativeBlockEditor.tsx`) and workspace pages view (`WorkspaceCollaborativeDocs.tsx`) load lazily via dynamic `import()` so the application entry bundle remains within budget.
- Typing `/` (or activating the block menu button) opens a keyboard-accessible listbox offering twelve block types (`richBlocksExtensions.ts`):
  - Headings 1–3, Bullet list, Numbered list, checkable Task list, Callout block, Blockquote, Divider, Fenced Code block, semantic Table (with contextual row and column insertion), and a Diagram block (`flowchart` and `sequenceDiagram`).
- **Zero inline styles.**
  - `StarterKit` disables `dropcursor` (`prosemirror-dropcursor` writes `element.style.cssText`), task items use `CspSafeTaskItem` instead of `@tiptap/extension-list`'s inline-styled node view, tables emit semantic `<table>` elements without `style="width:..."`, remote collaborator carets and selections (`collaboratorCursorsExtension.ts`) use only `@kodera/design-tokens` classes (`c-cursor-1..6`, `c-cursor-1-soft..6-soft`), and diagram previews (`DiagramBlock.tsx`) render deterministic SVG presentation attributes and token classes with zero `<style>` tags and zero `style` attributes.

### `[[Wikilinks]]`, backlinks and unified `⌘K` search (`B1`)

- Typing `[[` triggers inline page-title autocomplete (`wikilinks.ts`), inserting a keyboard-accessible `[[Page Title]]` chip that navigates to the referenced document.
- Every page renders a backlinks footer (`BacklinksFooter.tsx`) listing incoming references from `GET /organisations/{organisation_id}/workspace/documents/{document_id}/backlinks` and the local `[[...]]` link graph.
- Unified `⌘K` search (`UniversalSearch.tsx`) filters and navigates across channels, direct conversations, workspace members, and workspace documents.
- Per product scope (`B1`), there is no chat-thread-to-document promotion button or bridge.

### Workspace pages: a refused write and its non-destructive recovery

- A page's title, parent and Markdown are saved with the version of the last read: `PATCH /organisations/{organisation_id}/workspace/documents/{document_id}` with `If-Match` (`WorkspaceCollaborativeDocs.tsx`). Markdown only travels this way when it is the whole document and no collaboration session owns it (`maySeedFromMarkdown`).
- **The draft is never discarded.** A refused write leaves the title and the Markdown in the editor exactly as they were typed: nothing is rolled back, nothing is re-read behind the member's back, nothing is retried. The version this tab held is forgotten, so no later write can pair the draft with a version already known to be stale.
- One banner reports it, with `role="alert"` (`InlineAlert kind="error"`, implicitly `aria-live="assertive"`): a polite announcement can be queued behind a presence update and reach the member after they have typed another paragraph into a draft they believe is saved. Its sentence is one of two governed catalogue sentences in French and English, by precondition:
  - `precondition-failed` (`412` — the version sent was stale, a collaborator or the collaboration server committed first) renders `console.docs.collab.error-version-conflict`;
  - `precondition-required` (`428` — no version was sent, so nothing was compared and nothing was written) renders `console.docs.collab.error-version-required`;
  - a page this tab holds no version for is reported as the same missing-version state and its write is refused before it is sent, rather than going out with no `If-Match` over whatever a collaborator wrote meanwhile. Silence was the previous answer, and it left a draft looking saved when nothing had been written.
- Two recovery actions, both plain keyboard-reachable buttons with the shared focus ring and touch-target minimum:
  - `console.docs.collab.action-reload-latest` re-reads the page and its current version (`GET …/documents/{document_id}`), replaces the editor with the server's version, clears the banner, and leaves the next save carrying the fresh version. A read that brings no version back changes nothing and keeps the banner: a page that still cannot be saved must not cost the member their draft.
  - `console.docs.collab.action-save-draft-as-page` keeps the draft as a page of its own — `POST …/documents` with the draft's title and parent, then the draft's Markdown as a conditional body write with the version the creation handed back, because `WorkspaceDocumentRequest` carries no Markdown. The new page is then selected and `console.docs.collab.notice-draft-saved-as-page` names it in a `role="status"` region mounted before the message arrives. It is offered only on `version-conflict`, only to an editor, and never under a confidential policy, under which the body never travels over `REST` at all.
- Neither sentence names an HTTP status number and neither asks for a retry. `console.docs.collab.error-save` keeps answering for every other failure — offline, a refused field, Core unavailable — and its "réessayez" is right there and wrong for a precondition.
- **A refusal is a state of the page, and only those two actions end it.** It is held per document, with the draft it refused and as that draft is typed on, and what follows from that:
  - Opening another page and coming back restores the draft _and_ the banner. A version read on the way in says nothing about a draft nobody saved, so the page the server would answer with is left for the moment the member asks for it. The drafts kept this way are bounded, and an entry is dropped when either action ends its conflict.
  - While a page is in `version-conflict`, no further write of it is attempted: the version it was refused on is the only one this tab has, so every write would be refused in turn — and each refusal would report the missing version the first one left behind, which is the state with no "keep my draft as a new page" on it. The keystrokes are kept instead, so the draft saved as a page of its own is the one typed last, not the one the refused write carried.
  - The re-read reaches the block editor. `CollaborativeBlockEditor` seeds its `Y.Doc` from Markdown once, so a page re-read behind it would keep the fragment from before: the next keystroke would serialize that body and send it with the version the re-read brought — a collaborator's commit overwritten by the very draft the member asked to replace, with a version the server accepts. The page's reload epoch moves the editor's key and tells it that this mount replaces a body rather than resuming one. Only where no collaboration session owns the body (`maySeedFromMarkdown`); where one does, it holds the authoritative state and this tab does not replace it.
  - A write that left before either action and answers after it is discarded, by a per-document write generation both actions move. Cancelling the debounce timer cannot recall a request already on the wire, and its answer must neither write its `ETag` back over the fresh one nor re-open a banner the member has just closed.
- An `update` the editor reports having changed no part of the document is not a change to the Markdown (`CollaborativeBlockEditor`). `setEditable` emits one, from the effect that aligns the editable flag with the role, and in a freshly built editor that effect runs before the one that seeds the fragment: what it serializes is an empty page. Reported as the body it replaces the page in state with nothing and schedules a write of it — the page erased on the server, 350 ms after the member asked to re-read it.

### Structured collection: a refused write and its version recovery

- Inline edits in the structured collection (`DocsCollectionView.tsx`) are optimistic and carry the row's version: `If-Match` with the `ETag` of the last read on an update, `If-None-Match: *` on a create.
- Core refusing the precondition rolls the optimistic value back, forgets the refused version, and raises one banner with `role="alert"` — a refused write is announced assertively, because a `polite` announcement can be queued behind a sync update and reach the member after they have already retried.
- The banner's sentence is one of two, by precondition, and both are governed catalogue copy in French and English:
  - `precondition-failed` (`412` — the version sent was stale, somebody else wrote first) renders `console.docs.collection.error-version-conflict`;
  - `precondition-required` (`428` — no version was sent, so nothing was compared and nothing was written) renders `console.docs.collection.error-version-required`;
  - a row whose version cannot be read at all is refused here rather than written without a precondition, and reported as the same missing-version state.
- Its action is `console.docs.collection.action-reload`, which re-reads the collection, the row and its current version.
- Neither sentence names an HTTP status number, and neither instructs the member to retry: each names the cause and the re-read. The generic fallback `console.common.error-unexpected` never answers for a refused precondition — its "réessayez" would send the same refused write again.

## Acceptance

Run:

```
python3 scripts/ci/check-licenses.py --selftest
python3 scripts/ci/check-licenses.py
npm --prefix apps/web run test -- tests/unit/licenses.test.ts src/auth/localSession.test.ts src/features/docs src/features/command-palette/UniversalSearch.test.tsx
```

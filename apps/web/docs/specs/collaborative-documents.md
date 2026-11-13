# Collaborative workspace documents

Status: Implemented for review on Core API 0.43.0; service release remains separate.

## Spec

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

## Acceptance

Run:

```
python3 scripts/ci/check-licenses.py --selftest
python3 scripts/ci/check-licenses.py
npm --prefix apps/web run test -- tests/unit/licenses.test.ts src/auth/localSession.test.ts src/features/docs src/features/command-palette/UniversalSearch.test.tsx
```

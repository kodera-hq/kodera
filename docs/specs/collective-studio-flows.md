# Collective Studio interactive flows

Status: Active

The local workspace adapter supplies documents, review comments and structured document
messages. Comments persist with the existing workspace view and retain a quoted selection
when the source changes. Mentions insert a channel member's display name into the draft;
they do not send a notification. Publication retains the document ID in the local timeline.
Existing server authentication and messaging contracts remain unchanged.

Acceptance criteria:
- Add, resolve and reopen a comment; restore it after reloading the local workspace.
- Insert a member mention at the selected source range, with undo and keyboard access.
- Open the exact document from a timeline card or the workspace Files panel.
- List unread channels, mentions and recent loaded activity in Notifications; selecting
  an item opens its channel and closes the panel, including on narrow screens.
- List documents and shared attachment messages from accessible workspace channels only.
- Preview camera state locally with an explicit simulation label and no device request.
- Keep call state across navigation and pass accessibility checks in French light,
  English dark and black themes.

Mock responses extend the local adapter with optional document publication and initial
document capabilities, leaving the live Matrix adapter unchanged. Tests cover legacy
workspace state, comment persistence, selection insertion, document navigation, panel
empty states and the camera preview boundary.

## Verification

- Full web unit suite: 5,258 tests passed across 374 files with two workers and
  local listener access. A subsequent focused run passed 41 tests, including the
  added document/file routing integration test.
- Typecheck passed. Lint passed with the existing `ContactsStep.tsx` incompatible-library
  warning. Formatting and attribution checks passed.
- Studio production-browser flows pass at 1440 and 390 pixels in Light FR and Dark EN:
  comments, quoted selection, resolve/reopen state, mention insertion, publication,
  exact-document navigation, notifications, files, camera simulation and reload persistence.
  Axe reports zero violations, including black-theme comments, panels and the active camera
  strip; its scroll region is labelled and keyboard focusable.
- The protected login, support, workspace and emergency suites were run unchanged alongside
  Studio: 86 of 94 scenarios passed. All eight failing scenarios also fail on the untouched
  Phase 1 baseline `c0023f525843fcb5201a5fdf6c15a67d71126a82`: four MFA warning cases
  (wide/narrow in light/dark) lose the warning after Escape, and four emergency cases report
  unhandled production asset requests in the strict mock worker. No authentication or
  protected acceptance-test files were changed.
- Browser builds used an empty environment directory and local fixture services.

Document comments and publication use the existing local workspace boundary. The notification
panel reflects loaded activity and unread counts; attachment entries open their channel.
Mentions insert text without dispatching notifications. Camera preview is explicitly simulated
and never captures or transmits media.

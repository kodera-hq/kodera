# Desktop shell fidelity

Status: Implementation and the reviewed preview adaptations approved by the owner; protected CI and merge acceptance remain required.

## Scope and source

Align the existing desktop Console frame with the saved complete product reference: token-defined 264 px sunken sidebar, flat current navigation, icon module rail (labels in tooltips since current baseline, [`icon-only-controls.md`](icon-only-controls.md)) and a 56 px content header. Keep the existing role-filtered destinations, truthful organisation switcher, account controls and mobile layout. The immutable reference is indexed by the internal product-reference manifest; its export and runtime helpers do not enter this repository.

## Behaviour

- The sidebar consumes `shell-sidebar-width` and `c-sunken`. Its selected item retains the approved accent-ink edge and loses its decorative shadow. The organisation area is integrated into the sidebar; multi-organisation switching remains the existing real control.
- The desktop module rail names, as tooltips and accessible names, the apps returned by Core, « Messages » for the workspace, and « Réglages » for the console at its foot (not for `org_member`). The current module has a visible non-colour marker as well as `aria-current`. External destinations retain their new-tab announcement and existing URLs.
- A desktop content header identifies the current allowed navigation area or account page. Nested invoice routes retain their Billing context. Unknown or disallowed areas get the neutral Console context; the header never grants access.
- The sidebar toggle is a real button with an expanded state and controlled panel; it hides/shows only the desktop sidebar, without resetting the current page. The existing Aide route supplies the functional help action. No fabricated notifications, people, conversation counters or global search controls are drawn.
- Header text is not a second page heading. The screen retains its heading and skip-link target. Narrow and landscape-phone navigation remains unchanged.

## Approved preview adaptations

Rail items are icons only (superseded: rail labels used the package's 12 px type step). Use existing token typography in the header. Draw only the implemented header actions; the reference's notification/collaboration controls await their own features. Preserve the approved accent edge on the current sidebar item.

## Acceptance before publication

- Unit tests cover allowed route/account/nested contexts, unchanged role filtering, visible module names and the current marker, header semantics and toggle state.
- Browser checks at desktop width prove the sidebar measures its published token, navigation changes the header context, and toggling restores the same page. Existing mobile, keyboard, permissions and organisation-switching tests pass.
- Reproduce the new assertions failing against the old shell, then pass them without changing timeouts/retries.
- Review pinned screenshots in light, dark and black and at narrow widths. Only intentional desktop shell pixels change; preserve the existing mobile baselines. No comparison tolerance changes.
- Static/policy gates, independent adversarial and separate CTO review, current-base protected CI and owner approval of the preview adaptations are required before merge.

Commands: `npx vitest run src/app/Shell.landmarks.test.tsx src/app/Sidebar.colours.test.tsx src/app/ModuleRail.test.tsx src/app/contentTitle.test.ts`; `npx playwright test tests/e2e/shell-fidelity.spec.ts`; `npm run test:visual`.

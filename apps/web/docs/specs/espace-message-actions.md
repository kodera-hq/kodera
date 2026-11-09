# Espace message actions

Status: Implemented for independent review; service release remains separate.

## Spec

Each non-redacted message in an active channel has one action disclosure, named by its author and time. As in Discord, it is shown only while the pointer is on the message, while focus is within it, or while one of its menus is open; at rest it is faded out, but it stays in the tab order and the reading order, so a keyboard or screen-reader user meets it as before. A screen with no hover (a phone or tablet) always shows it, and so do forced colours (Windows high contrast), where a faded control would be the only one hidden. It reserves space beside the body rather than hovering over text, so showing it never moves or covers the text. Long unbroken content wraps inside that column rather than being clipped or covering the disclosure. The existing DropdownMenu provides focus, arrow navigation, selection, dismissal and return to the trigger. The items remain React callbacks owned by EspaceLiveView and bound to the shown Matrix room and event. No new service or API response is introduced; the existing EspaceLiveView test store supplies resolved channel rooms, messages and action spies. Archived channels and deleted messages expose no message actions. Own-message edit/delete restrictions and separate thread actions are unchanged.

New labels live under console.workspace.message in both source message catalogues; runtime catalogues are generated. Non-selected messages use the existing muted hover/focus-within role, retaining a detail cue when light page/sunken are white. Ordinary action and thread-open text uses ink with hover/keyboard underline and the canonical ring. Focused-thread, mention and reaction selection cues, status/danger text, geometry and touch targets retain their existing roles.

## Acceptance

Run `npx vitest run src/features/espace/EspaceLiveView.test.tsx src/features/espace/EspaceLiveView.call.test.tsx src/features/espace/EspaceLiveView.leave.test.tsx src/ui/TimelineMessage/TimelineMessage.test.tsx`.

Opening a menu makes no store mutation. ArrowDown opens and focuses its first item. Escape closes it, restores the trigger and preserves the open thread. Reply/edit/delete/reaction/thread operations still hit the original room/event; audience navigation removes a pending old menu. Existing room-bound draft and call guards remain covered. A narrow browser walkthrough checks wrapping, pointer/touch reachability, keyboard focus and all three themes; these checks do not establish live-service or real-device qualification.

When the disclosure is shown is measured in a real browser over a fake store, with no stack: `npx playwright test -c playwright.espace.config.ts tests/espace/layout/actions.spec.ts`. Faded at rest with its width kept; shown under the pointer for that message only, with the text unmoved; shown with focus on its trigger and while its « ··· » menu or its reaction palette is open (focus is then in that layer); faded again once focus leaves; and always shown where `(hover: none)` matches or colours are forced. Removing any one of its six conditions fails one of these cases.

## Evidence

The new keyboard-menu regression fails against the predecessor because the named trigger is absent. Exact-head checks and independent findings are recorded with the pull request. Merge and release remain with the General Lead.

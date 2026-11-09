# Product unification and workspace polish

Status: Superseded for workspace navigation by `docs/specs/community-workspace-polish.md`

The workspace must use the available canvas height and keep organisation actions in its sidebar. The interactive browser demo must support local conversations and documentation without a homeserver. The routed workspace exposes templates and connectors through its workspace menu.

Design: keep the existing themed surface, sunken background, ink, muted ink and accent tokens and the shared typography. Place compact organisation actions above channel navigation. Align channel members and canvas controls beside the title. Present the user identity and clickable presence on one row, with theme and utility controls on a second row. Preserve readable avatar spacing, keyboard focus and existing accessible names and test identifiers.

Mock contract: keep the existing Core workspace and tenant responses. Register a local store factory only from the mock browser bootstrap for the selected demonstration organisation. Resolve ready channel IDs into in-memory rooms, seed welcome messages, and support sending, replying, editing, deleting and reacting without a network connection. Do not issue Matrix credentials. Ordinary sessions keep their existing connection, failure and reconnection behavior. The explicit browser demo uses one-hour mock tokens and an operational status projection; scenario test fixtures retain their short-lived tokens and incident narrative.

Acceptance:

- Workspace configuration and hosting remain reachable with their existing labels, inside the sidebar for ready and live workspaces; configuration remains reachable before creation.
- The registered demo organisation opens the real workspace view, with local messages, per-channel drafts, Discussion / Docs, developer documentation and community access. No Matrix sign-in is attempted; unrelated organisations and production do not use the local store.
- Demo mock token expiry is 3600 seconds; other mock tokens remain 300 seconds. Access and identity token claims agree with the response.
- The demo rail always exposes the Messages workspace link on Home and People without changing the tenant application fixture contract.
- Members retain their trigger reference, controls, expanded state and label, beside the canvas controls. Header avatars do not overlap.
- With the simulator hidden, templates and connectors each open in one click. The compact user pod retains all existing test IDs and theme, presence and settings behavior.

Validation: full web suite, typecheck, lint, production build, vendor attribution and required clause checks. Add regression coverage for demo isolation, local conversations, sidebar action placement, token duration and workspace quick actions. Browser-check the routed workspace. Commit only on the assigned feature branch; do not push.

Delivery evidence:

- Web suite: 359 files, 5164 tests passed. The avatar layout assertion now requires separate faces instead of the superseded overlap.
- Typecheck, lint and production build passed. Lint retains two existing warnings in ContactsStep and DocumentViewer. The production bundle exclusion check passed.
- Repository policy checks passed using the authoritative `.github/scripts/check-vendor-attribution.py` and `.github/scripts/check-required-clauses.py`; the requested `scripts/ci/` paths do not exist in this checkout.
- Built-browser checks passed for demo sign-in, Home and People rail access, local messaging, Docs draft retention, developer documentation, community access, sidebar actions, templates and Frame.io. No Matrix requests or page errors occurred. The 390 px viewport had no horizontal overflow.
- Demo conversations and drafts remain local to the mounted workspace. No provider or remote Git operation is needed.

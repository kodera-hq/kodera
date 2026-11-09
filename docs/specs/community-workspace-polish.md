# Community workspace integration

Status: Implemented and validated

## Scope

The routed Community workspace is the reference local product experience. Retire the obsolete standalone demonstration and retain reusable appearance and collaborative-note components in their product modules.

## Acceptance criteria

- Demo entry resolves Community by default, skips the intermediate identity-provider page, and renews silently.
- Session warnings appear only during the last 120 seconds; closing or pressing Escape dismisses immediately even if renewal fails.
- Both workspace triggers expose the same accessible menu. The channel sidebar contains its compact header, search, and categories.
- Creating a local workspace registers it for switching; creating a text or voice channel selects it immediately.
- Channel notes support editing, templates and publishing; developer documentation remains reachable.
- Community console responses use a consistent identity, roster, domain and service state.
- Invitations, reactions, threads, members and voice controls are verified in a real browser.
- Type checking, lint, documentation generation, unit tests, production isolation, extension tests, attribution and required clauses pass before the clean-branch Genesis rehearsal.

## API fixture boundary

All local workspaces and conversations are registered from the mock bootstrap. Production imports neutral capabilities only. The mock Core responses preserve organisation and tenant identifiers; local creation never allocates cloud resources. Each community membership count is derived from its roster. Tests must verify both Community and the existing independent demo.

## Verification

Evidence and remaining limitations are recorded in the accompanying integration review after implementation and browser validation.

# Dialog focus recovery

Status: Existing change under integration review; no customer release claim.

Preserve the existing explicit return-focus target in Dialog, Drawer and ConfirmDestructive while incorporating the reviewed route and UI foundation. Programmatically opened dialogs must return focus to the caller-supplied current target on close. Trigger-based behavior remains available when no target is supplied. The reference is read at close time, so a reusable dialog can return to its actual opener.

Acceptance: the recovered route foundation must be an ancestor; original ten changed source and story/test files must preserve both changes where they overlap. Run the three component suites, all unit tests, type checks, lint and production build. Inspect any conflicts before resolving. No API response mock is needed for this isolated focus behavior.

Before integration, the ancestry check is expected to fail. Existing programmatic-focus tests provide behavioral regression coverage. A temporary weakening that ignores the supplied target must fail the intended focus assertion; restore the exact file afterwards.

All ten original focus implementation, story and test files remain byte-for-byte unchanged. The normal merge had no conflicts. All 816 unit tests, type checks, lint and production build pass. Temporarily ignoring the supplied target fails the programmatic Dialog focus assertion; the exact source was then restored. The inherited lint and bundle-size warnings remain.

# Editable order drafts and catalogue summaries

Status: implemented with browser acceptance; integrated browser execution remains required.

This is the bounded continuation of [01-order.md](01-order.md). Purchase submission remains
held. Contacts and agreements display the selected pack and capacity-tier names from the
catalogue, and the exact catalogue amount for the selected monthly or annual billing period.
The existing annual-billing label identifies the annual amount. No tax, discount, total,
annual conversion or fallback price is computed. Unavailable packs, tiers, compatibility
metadata or prices show the existing unavailable message and no amount. The summary remains
visible while legal documents load or fail to load. Its prices describe the editable selection;
they are not a submitted order's frozen price snapshot.

Unreachable-step navigation runs after the wizard commits, preserving the reachable-step
guard. The existing submission-held Banner is the disabled final action's accessible
description. No purchase is enabled and no new customer wording is added.

Contacts edits are saved separately as `contactEdits`, using the existing editable draft's
owner tuple, retention and storage limits. `contacts` is written only after form validation.
Editing a previously validated form clears `contacts`; partial edits therefore do not advance
the draft into agreements. Storage remains best effort, and unavailable storage keeps the
existing storage-unavailable behavior.

The existing before-sign-in callback captures the latest contacts fields into a bounded,
editable-only session-storage envelope. It contains the issuer, subject, immutable organisation
ID and draft ID. A renewed authentication generation for the same owner can resume it. Another
owner or organisation cannot hydrate it, even if a valid envelope was copied into their key.
Malformed, expired, future, oversized or purchase-bearing envelopes are ignored. Reads do not
consume during render; committed recovery clears only the captured snapshot after an owned
editable save succeeds. A newer snapshot is preserved. Explicit logout clears this envelope
through the existing local-session cleanup. The route's fresh Core owner resolution is unchanged
and remains required before the wizard is mounted.

## Runnable acceptance

The lightweight acceptance uses real draft storage, AuthProvider, SessionExpiryProvider and
the memory router, with existing MSW catalogue/legal responses and synthetic auth snapshots:

```sh
node node_modules/vitest/vitest.mjs run src/features/order/OrderWizard.polish.test.tsx src/features/order/contactStash.test.ts src/features/order/ContactsStep.test.tsx src/features/order/AgreementsStep.test.tsx src/features/order/ownership.audit.test.tsx src/features/order/routes.owner.test.tsx src/features/order/draft.test.ts src/features/order/PlanStep.test.tsx
```

The acceptance asserts catalogue-backed summaries on both steps, exact period/pack/tier price
selection, missing or mismatched metadata, no NGO discount arithmetic, legal-load failure,
the disabled-submit description, navigation after commit under StrictMode, partial-edit
reopening, before-sign-in callback capture and a provider-remount recovery, owner separation,
temporary-envelope rejection and explicit-logout cleanup. The fresh-owner route tests remain
part of the run. Mutations must reject removed owner-envelope checks and guessed price selection.

The provider-remount unit test models a redirect and a new authentication generation by mocking
the identity adapter. Browser acceptance in `tests/e2e/01-order.spec.ts` additionally follows the
actual SDK's mock-provider authorize/callback route with unsubmitted, incomplete contacts. Its
expiry uses the observed synthetic token lifetime. At the identity page the browser test asserts
the actual owner/draft-bound stash and removes only the redundant durable contact fields,
retaining the selected plan, so broken stash recovery cannot pass using a local copy. Return must
restore visible fields at the exact original contacts URL, save them durably and consume the
stash. A second journey reopens the order index through a full navigation and silent identity
iframe, proving incomplete edits resume on contacts and cannot reach agreements. A third saves
real partial edits and adds a pending contact-envelope cleanup fixture from that exact owner and
draft, logs out through the account menu, checks both stores and signs back into a fresh plan
with a different draft ID. The pending-envelope fixture is not an additional sign-in journey.

Run those browser acceptances through the existing Playwright configuration on the integrated
exact-lock tree. Browser-test discovery or local unit/type checks do not prove they passed. No
local browser or visual evidence is produced by this implementation. Real identity-provider
deployment, backend authorization and a complete purchase journey remain outside these mocks.

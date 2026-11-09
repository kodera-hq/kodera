# Owned editable order recovery

Status: Implemented; independent review pending

Continue the existing order feature by normal merges with the reviewed common
shell and active identity bridge. Do not recreate the wizard. Initial acceptance
is the five failing ownership probes against the original order source, with its
same-scope preservation control retained as historical evidence.

A new order-specific reader obtains Core /me directly with cancellation, captures
and rechecks the active ready generation and token, and resolves exact identity,
organisation and membership IDs. It never treats the shared cached current-user
helper as current membership proof. Protected order entry waits for this result.

Only explicitly allowlisted editable fields can enter a versioned owner envelope.
Record and latest pointer keys include issuer, subject and immutable organisation
ID. Payload owner, purpose, version, draft ID and timestamps must match. Provisional
editable resume eligibility is 24 hours since a validated edit. Legacy, malformed, future,
expired and mismatched records never hydrate. Other-owner records are not migrated
or deleted. Submitted or possibly submitted metadata is held for reconciliation,
never converted to a new editable purchase intent or assigned a new submit key.

Owner, generation and draft transitions hide old state before rendering. Old
callbacks cannot write. StrictMode initialization has no storage side effects.
Read, parse and quota failures are contained and labelled in catalogue
copy. Storage failure may retain current in-memory editable data but cannot imply
it is saved. No token, profile, OTP or recovery secret is persisted.

Purchase submission remains visibly on hold until the separately reviewed
immutable-intent slice. Preserve document browsing and editable plan/contact work;
do not promise cross-logout recovery. No purchase retry, automatic reconciliation,
server endpoint, generic stash framework, workflow or infrastructure changes.

Acceptance covers fresh /me route entry and membership refusal; exact issuer and
subject isolation; same-owner resume; mounted transitions and stale callbacks;
24-hour resume eligibility, malformed/legacy data, storage denial and StrictMode; hold for
possible submitted outcomes and no order POST or fresh purchase key from that hold.

## Integration decisions

Initial probes reproduced five failures and one same-scope control before source
changes. Normal merges preserve original order 2bd6dfa, common shell 45bfe0a and
identity bridge 45870a2. The only merge conflict was the catalogue row assertion.
The exact existing PR46 implementation at fcaf9de71802a597394616863f07e6e182540fb7
replaces that assertion, preserving source-row and regeneration checks without a
new sibling-specific hardcoded count.

Fresh Core membership must explicitly be org_owner before the editor or its DPA
request mounts. Owning local data is not a create grant. Non-owner memberships
receive catalogue guidance, including direct deep links. Synthetic order /me
fixtures now explicitly match the local provider's issuer/subject; no production
fallback assigns capability from omitted mock claims.

All legacy records are conservatively held: the original implementation could
send an order despite failing to persist its key, so even a record without an
order key cannot prove it was never submitted. No legacy or other-owner record is
deleted or reassigned. New owned editable records use the approved provisional
24-hour resume eligibility; reading does not extend it. Unknown/corrupt owned data is held.

The original final-submit browser assertions are replaced with the explicit hold,
legacy reconciliation and same-owner recovery acceptance above. Confirmation
component tests remain, but an enabled purchase workflow is not claimed.

A failed fresh ownership read offers an explicit router retry. Retry must keep the
editor hidden until a new successful Core result, without reloading the page.

## Validation and limits

The 24-hour window limits restoration, not physical personal-data retention.
Expired same-owner editable bytes remain until an explicit new edit replaces them
or existing signout cleanup removes app storage. No background deletion is
implemented. Each editable save rechecks the current owned and legacy record through
readEditable immediately before writing. A held result prevents both envelope and
latest-pointer writes even if the mounted editor previously hydrated editable data.
Unavailable reads likewise prevent writes and retain only the incoming validated
editable draft in memory, labelled unavailable. Empty, saved and rejected states keep
their existing explicit-edit behavior; retention and rejected-state interpretation
are unchanged. A failed envelope write never advances the pointer; a pointer-write
failure can leave the validated envelope updated while the result stays unavailable.
This observed-state check is not atomic compare-and-swap: another tab may still write
between that check and a write. No cross-tab lock or cross-logout recovery is promised.

The fresh-reader failure recovery uses router invalidation and waits for a new
Core response. Both the real wire role org_member and an unknown role are refused,
as are org_admin and org_billing. DPA generation remains the existing Core request
for a freshly verified org_owner; purchase POST and submit-key allocation stay
unreachable under the explicit submission hold.

Initial behavioral failures reproduced cross-owner recovery, stale mounted state,
unsafe purchase metadata stripping and expired-token writes. The final suite also
proves unreadable and mismatched-owner envelopes cannot be overwritten. A missing
retry action failed an actual-route test before correction. The original non-owner
browser accessibility check caught a missing heading; the corrected route keeps
that full accessibility acceptance.

The application runtime used the existing installed toolchain with a private copy
of the exact pinned design-token commit b7048b5. An older borrowed token runtime
first failed the compiled 5px selection-ring acceptance; the dependency was
corrected without changing package files or weakening the check. No clean lockfile
installation, real provider environment or deployed Core ordering is claimed.

Measured acceptance: 106 unit/component/static files, 1,025 tests passed. All 27
Chromium journeys passed before the final retry/held-envelope refinements; all
nine order journeys were rerun after those refinements and passed. Type checking,
format checking and production-bundle exclusion passed. Lint has zero errors and
two inherited warnings (ContactsStep form watch and DocumentViewer suppression).
No Storybook or clean dependency installation was performed in this slice.

Merge ancestry is preserved in 04b0341 (original order plus common foundation) and
b8a33a2 (that continuation plus reviewed identity bridge). No package, workflow,
API contract, generic session loader or authentication implementation changed.

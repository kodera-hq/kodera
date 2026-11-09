# Recovered screens integration

Status: Locally qualified; independent review and hosted checks pending.

Compose these reviewed feature histories without replacing their ancestry:

- Invoice: `9898ffe4cf8110e5e9ee808b2a6e493af1c2c88f` (starting point).
- Order: `62b1e7d3cdb670775c670392f79590f0532ab09c`.
- Home: `cac9566529dc27cb6a6ddfcd10db4d17d5c560f4`.
- Status: `e169528e70f6ca64cc2600f53a544544c74c62b5`.

The initial acceptance was committed before composition and run against the
Invoice starting point. The Home greeting failed and the existing invoice page
passed. The nested Order expectation also failed, but that initial positive
case lacked matching identity evidence and cannot prove an authorised Order
entry. The final suite keeps that input as an explicit refusal control and
uses the reviewed owner identity fixture for the successful draft journey.
Order, Home and Status were then integrated by normal merges. Preserve fresh order ownership reads on every entry,
immutable organisation/identity/session binding, local editable-draft isolation
and `SUBMISSION_HELD`. No purchase, DPA acceptance or payment success is implied
by an accessible preview route.

Resolve only measured overlap: keep the nested Order route and all three
Invoice routes, union the shared formatting functions and their tests, retain
both Home's sign-in helper and Invoice's path-aware awaited sign-in interface.
Union Markdown message rows and regenerate JSON from them. Status owns the
shared feminine skipped-step label. Preserve derived catalogue row counting;
never restore a literal count. Invoice's actual area tests replace the former
invoice stub assertion; retain all other role and direct-route checks.

Acceptance covers the real combined router and mock identity round trip:
Home → Applications → Invoices navigation; owner-only draft preparation from
Home with submission still disabled; billing visibility without management or
purchase authority; and reload/session refusal behavior from the original
feature suites. Record original and combined Chromium suites, full unit tests,
types, lint, formatting and the production mock-exclusion guard. A passing
static spec catalogue is not execution evidence.

Only synthetic responses and the app-local mock identity provider are used.
The owned preview listens on loopback port 4186. This does not deploy Core,
provision infrastructure, open a customer payment journey, certify full mock
parity or satisfy the complete-suite first-customer release boundary. Dependency,
workflow, auth security and production mock gates remain unchanged.


## Composition and evidence

The Order merge required one route-tree resolution: preserve the nested wizard
and all Invoice children. The Home merge was automatic. The Status merge had
six conflicts: the two Markdown catalogues, their two generated JSON files,
the formatting helper and its tests. Resolution retains both feature sets,
uses the Status feminine skipped-step label, and regenerates 911 message keys
per language. Both formatting test sets remain present.

The cross-screen fixture adds a synthetic billing identity using the existing
owner fixture's immutable identity binding, changing its organisation role.
The older billing fixture lacks that binding and would prove a generic identity
refusal rather than the intended role refusal. The no-tenant Home has its own
empty-state heading; the final tests assert that heading. These were test
assumption corrections, not production defects or changes to the owner guard.

The six combined browser cases exercise Home discovery; missing-identity Order
refusal; the existing Invoice page; actual Home → Status → Invoice detail →
Home navigation; fresh owner entry through draft preparation with submission
held and no order POST; and billing read access with direct Order refusal.
The owner journey observes the fresh Core identity reads after navigation;
this synthetic check does not establish server authorisation or production
identity-provider behavior. The inherited suites retain their original
session, renewal, direct-route and four-role counterexamples.

The dependency lock, auth code, workflows and production mock-exclusion gate
are unchanged from the Invoice starting point. Order's fresh-context loader,
owner resolver, submission hold, editable storage and routes retain exact
reviewed parent bytes. All four source heads remain ancestors of the combined
branch. Independent review and current-head hosted checks remain required
before a merge decision. Publishing this branch does not authorise release.


## Measured local qualification

- All 1,465 unit tests passed across 149 files.
- All 95 Chromium cases passed: 89 inherited cases and six combined journeys.
- Both TypeScript projects passed; lint reported zero errors and two inherited
  warnings; formatting passed.
- The production build and mock-exclusion check passed with the production
  configuration. Synthetic mock behavior remains confined to preview mode.

The initial pre-composition run had one valid missing-Home failure, one
underqualified Order expectation and one Invoice positive control. The first
full combined run passed all 89 inherited cases but exposed three assumptions
in the new acceptance: the incomplete identity and two empty-state headings.
The corrected suite was then rerun in full. No product implementation was
changed to accommodate those assumptions.

These results qualify the integrated synthetic foundation only. They do not
prove live Core operations, payment-provider convergence, complete design
parity, or readiness for the first customer release.

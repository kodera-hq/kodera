# Organisation navigation follows explicit role permissions

Status: Specified before correction

The current sidebar and People/Domain route wrappers treat every role except org_member as administrative. The pinned Core authorisation matrix states otherwise: org_billing is a provisional sideways grant for invoice/payment access and grants no People or Domain management. Its presence in the wire enum does not imply that the role is approved for release.

Use explicit allowed roles for each existing navigation area. Owner and administrator can enter People and Domain; owner, administrator and provisional billing can read Invoices. Existing Home, Applications and Help remain available to the four known organisation roles. Direct route wrappers must agree with navigation. Do not change API permissions, the role enum, organisation identity or the future release role decision.

Acceptance before edits: mounted sidebar tests cover all four wire roles and demonstrate the billing role currently sees prohibited links. Actual People and Domain route component tests must verify their supplied RequireRole lists exclude billing while Invoice retains its read grant. Preserve owner/admin/member positive controls. Run focused and full unit/type/static/build and representative shell role browser checks. No server authority or endpoint implementation is claimed.

Contract basis: kodera-core main 5ee9e2556de76603a326f828efa4daae02a9203a, docs/api/AUTHZ.md sections 4–5 and the pinned OrganisationRole schema description. This corrects presentation admission under the existing contract; it does not ratify provisional roles.


The initial mounted acceptance reproduced five failures with fifteen positive controls: billing saw People/Domain links and entered both wrappers; the unguarded Federation deep link admitted billing and members. Federation belongs to Domain identity management under the same existing Core matrix and receives the same wrapper in this correction. No federation feature or redirect behavior is implemented.

Status: Implemented; independent review pending

The final correction passed 935 unit tests across 93 files, TypeScript, lint, formatting and the production simulation guard. Two Chromium journeys passed: the billing fixture retained invoice access while hiding and refusing administrative routes, and the existing member access journey remained green. These checks exercise client navigation and route admission only; server authorisation remains a separate requirement.

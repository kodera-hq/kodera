# ADR-0010: The v1 tenant and staff role sets are fixed

**Status:** Accepted
**Deciders:** zôÖma, the product owner, who decided that Kodera launches with the four tenant roles, the three staff roles and the grant rules exactly as this record states them.

## Context

The API, domain model and console contract already carry `org_billing` and
`staff_security`, but marked both as provisional before this decision. Removing
either after the first contract release would narrow an enum and permissions
matrix; keeping them without a grant path would create support-only behaviour
and hidden privilege.

The offer needs least-privilege access for customer finance contacts and a
read-only security investigation boundary even when no person currently holds
that staff assignment. Role design describes permissions, not the current crew
roster.

## Decision

The tenant membership role set is closed for v1:

- `org_owner`: all organisation administration, owner transfer, role
  assignment, billing and destructive organisation decisions;
- `org_admin`: people and tenant administration except ownership transfer,
  billing authority and assigning `org_owner` or `org_billing`;
- `org_billing`: reads invoices, orders, subscriptions, dunning and the DPA;
  creates and reads payment links (`createPaymentLink`, `getPaymentLink`); reads
  the organisation, its tenants, their status and availability, and its
  entitlements (`getOrganisation`, `getOrganisationStatusSummary`,
  `listTenants`, `getTenant`, `getTenantStatus`, `listTenantAvailability`,
  `listEntitlements`); works support tickets (`createSupportTicket`,
  `replyToTicket`, `attachToTicket`) and edits its own profile (`patchMe`). It
  holds no write on people, tenant operations, domains or infrastructure;
- `org_member`: ordinary application access; reads the organisation, its
  tenants, their status and availability, its domains, identity-federation
  providers and their tests, its entitlements and the people list
  (`listMemberships`, `getMembership`, `countMemberships`); works support
  tickets (`createSupportTicket`, `replyToTicket`, `attachToTicket`) and edits
  its own profile (`patchMe`).

The staff role set is also closed for v1:

- `staff_operator`: operational mutations across organisations — tenant
  lifecycle jobs, provisioning among them (`triggerTenantJob`), tenant agent
  enrolment tokens, domains, identity-federation providers and their tests,
  the organisation intake (`createOrganisation`) and organisation updates —
  plus the two people-related removals below, cross-organisation reads and
  support-ticket work;
- `staff_support`: read-only on customer data across organisations, except
  support tickets: it creates a ticket (`createSupportTicket`), replies to one
  (`replyToTicket`) and attaches a file to one (`attachToTicket`). Its only
  other write is its own profile (`patchMe`), which every staff and tenant role
  holds;
- `staff_security`: cross-fleet audit, job and security-log investigation,
  read-only and without secret access, except its own profile (`patchMe`).

`anonymous`, `invited` and `bootstrap` are declared principal states, not
stored roles.

Only an `org_owner` changes or removes an `org_owner` or `org_billing`
membership, or moves an active membership to or from those roles; an `org_admin`
changes or removes only `org_admin` and `org_member` memberships, and moves one
only between those two roles (`changeMembershipRole`, `removeMembership`); no
one changes or removes their own membership. Every role change requires the
current ETag (`If-Match`) and writes an audit event.

No staff role invites anyone, prepares an on-site enrolment token or a member
import for a customer organisation, changes a customer's role, or grants itself
a membership. On a customer organisation's memberships, invitations, on-site
enrolment tokens and member imports, staff hold reading and two removals:
`staff_operator` and `staff_support` read memberships (`listMemberships`,
`getMembership`, `countMemberships`), invitations (`listInvitations`) and
on-site enrolment tokens (`listEnrolmentTokens`); `staff_operator` alone also
reads member imports (`listMemberImports`, `getMemberImport`), revokes a pending
invitation (`revokeInvitation`) and discards a member import
(`deleteMemberImport`); `staff_security` holds none of them. Other
`staff_operator` operations reach people without touching those records:
activating a federation provider, whose `redirect` mode sends everyone to it
(`activateFederationProvider`); disabling one, which returns every federated
account to hosted sign-in (`disableFederationProvider`); mailing the domain
instruction sheet or the federation runbook to a named person
(`shareDomainInstructions`, `shareFederationRunbook`); and recording the
intended owner at intake (`intended_owner` on `createOrganisation`).

Staff assistance is the intake protocol, not a grant on ordinary invitations.
A staff operator creates a non-active organisation with no membership for
anyone; the intended verified person establishes first ownership through the
first-owner claim protocol of `internal architecture records`,
`plans/complete-mock/FIRST_SLICE_SPEC.md` §P1, whose operations are new
explicit contracts. The customer's recorded instruction for assisted
onboarding is a field of that intake (`instruction_ref`).
`contracts/core-api.openapi.yaml` grants no staff role `invitation:create`,
`invitation:act`, `enrolment_token:create`, `enrolment_token:delete`,
`member_import:create`, `member_import:update` or `member_import:act`, and
`scripts/ci/check-authz-matrix.py` refuses a contract that grants a role
its matrix cell does not hold.

`org_owner` is never granted by invitation, member import or on-site enrolment;
it is established by the first-owner claim and thereafter requires a guarded
change to an active membership. Invitations and imports
may grant `org_admin`, `org_billing` or `org_member`, subject to the caller's
grant ceiling: only an `org_owner` invites or imports with `org_billing`. A
shared on-site enrolment token grants `org_member` only.

The console People surface MUST expose `org_billing` to an owner with explicit
permission copy. A role may exist with zero assignees; no staffing assumption
is encoded in the schema.

## Options considered

| Option | Decision |
|---|---|
| Three tenant roles, billing folded into member | Rejected. Reading invoices is not ordinary application membership and would either overgrant members or create endpoint-specific exceptions. |
| Keep `org_billing` but make staff assign it | Rejected. It turns a customer permission into an operational ticket and lets staff influence the customer permission graph. |
| Fold `staff_security` into operator | Rejected. Incident investigation should not automatically confer infrastructure mutation rights. |
| Fixed four tenant and three staff roles | Chosen. It preserves least privilege and gives every carried role an explicit purpose and grant path. |

## Consequences

- The People specification and its accessibility scenarios need a billing-role
  choice visible only to owners.
- Authorisation tests need negative cases between billing, member,
  administration and staff security scopes, plus negative owner-grant cases on
  every indirect enrolment path.
- Adding a later role is a contract decision with message-catalogue, matrix and
  migration work; removing one is a breaking change.
- The existence of `staff_security` does not assign that responsibility to an
  unconfirmed crew member.
- Staff-assisted onboarding is the intake and first-owner claim operations of
  `FIRST_SLICE_SPEC.md` §P1, carried by the contract as `createOrganisation`
  (the intake, with its recorded instruction reference), `getOrganisationBootstrap`
  and `consumeOwnerClaim`. `consumeOwnerClaim` is the only operation of the
  contract that creates an organisation's first owner, reachable by the
  `bootstrap` principal of `docs/api/AUTHZ.md` §4 and by nobody else before the
  owner exists. No staff role creates a membership in a customer organisation,
  and `scripts/ci/check-authz-matrix.py` refuses `bootstrap` on any
  operation other than `getOrganisationBootstrap` and `consumeOwnerClaim`.

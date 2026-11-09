# ADR-0011: Member-import staging data has a fixed seven-day ceiling

**Status:** Accepted
**Deciders:** zôÖma, the product owner, who decided that member-import data is handled exactly as this record states it.

## Context

Member import needs server-side parsing to apply the same duplicate, existing
membership, seat and invitation rules as individual invitations. The uploaded
address book contains names and email addresses belonging to people who may not
yet have interacted with Kodera. Retaining the raw upload or successful row
data for ordinary operational convenience would violate data minimisation.

The provisional contract named seven days but did not distinguish raw bytes,
active staging rows, terminal summaries and audit evidence. It also did not
define a production admission gate for the processing purpose.

## Decision

- The server parses an uploaded CSV immediately in an organisation-scoped
  staging boundary. The raw uploaded object is deleted as soon as parsing
  succeeds or fails; it is never retained for later support or replay.
- Parsed staging rows are encrypted at rest and contain only the columns needed
  for validation and invitation. All personal staging data is deleted when the
  import reaches `completed` or `discarded`, or seven days after upload,
  whichever happens first.
- A `partially_failed` or `failed` import remains retryable. Successful,
  duplicate and skipped rows are scrubbed immediately; only rows that can still
  be retried retain their address until retry, discard or expiry.
- Completion keeps only non-personal counts, the initiating identity reference,
  timestamps and audit references. It keeps no row email, name, source cell or
  uploaded filename.
- Logs, errors, metrics and traces contain counts and stable reason codes only.
  They never contain a source row or address.
- A nightly retention job deletes expired staging rows. Its acceptance suite
  includes a mutation that disables the deletion and proves the retention gate
  fails.
- The import feature remains disabled in production until the processing
  purpose, data-subject category, fixed seven-day ceiling and deletion mechanism
  appear consistently in the retention schedule, ROPA and DPA annexes and have
  a named privacy review.

## Options considered

| Option | Decision |
|---|---|
| Parse entirely in the browser | Rejected. Duplicate, seat and existing-member checks still require server processing and would split one validation engine into two. |
| Retain the upload until the import expires | Rejected. Parsed staging data is sufficient and the raw object adds risk without a product need. |
| Retain successful rows for support | Rejected. Audit counts and reason codes are enough; support access is not a lawful reason to keep an address book. |
| Immediate raw deletion plus a seven-day staging ceiling | Chosen. It preserves the server-side validation contract while bounding exposure and removing terminal personal data. |

## Consequences

- Retry after a terminal result creates a new import from a new upload; the old
  address book cannot be recovered.
- Support diagnostics use counts and stable reason codes rather than inspecting
  customer addresses. `staff_support` cannot read `MemberImport`; a later
  support-context projection may expose only that non-personal summary.
- This decision bounds `staff_support` and does not bound `staff_operator`.
  `staff_operator` holds `read, delete all` on `MemberImport` in the §5 matrix of
  `docs/api/AUTHZ.md` and `listMemberImports`, `getMemberImport` and
  `deleteMemberImport` in `contracts/core-api.openapi.yaml`, across every
  organisation and over the same staged names and email addresses; it no longer
  holds the operations that stage, map or send an import (`docs/api/AUTHZ.md`
  §4). The matrix and the contract agree, so this is not drift and this decision
  does not change the grant. Whether that read residual is the intended one was
  left to the owner, who has decided that it is: ADR-0010 fixes the staff grant
  rules, under which `staff_operator` alone among the staff roles reads member
  imports and discards one, as `docs/api/AUTHZ.md` §4 and
  `contracts/CONSOLE_RECONCILIATION.md` §6.5 record. Accepting this record
  remains a decision about `staff_support`, not about staff access to the
  staged address book, which ADR-0010 decides.
- The model needs a split between ephemeral staging rows and the non-personal
  terminal summary rather than one long-lived `rows` JSON value.
- Production enablement is blocked until the internal legal and retention
  records agree with this decision.

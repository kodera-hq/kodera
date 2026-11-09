# Member authority and parent-policy facts in one snapshot

Status: Proposed. Implemented on this branch, with its acceptance installed before the source;
the real-database acceptance runs in CI. No HTTP operation, capability mapping, grant
calculation, projection binding or migration.

## Boundary

`resolve_member_parent_policy(verified=..., channel_id=...)` in
`apps.workspaces.policy_selectors` takes trusted `VerifiedAccessToken` evidence and a channel
ID, never browser-supplied identity, organisation, membership, capability or revision facts.
It returns `MemberParentPolicyFacts`, a frozen, slots, repr-disabled record with exactly two
fields:

| Field | Type | Source |
|---|---|---|
| `authority` | `MemberAuthorityFacts` | `apps.orgs.authority_selectors.read_member_authority_in_snapshot`, unchanged |
| `policy` | `ParentPolicyFacts` | the existing parent-policy materializer, unchanged |

Both records are read in one REPEATABLE READ READ ONLY transaction the composer owns. It
refuses an existing atomic block and a manual autocommit-off transaction with `RuntimeError`.
Input types are checked before any trusted field is read. The member reader runs first and
once, before any workspace table is read; the policy seam runs second and once, on the same
snapshot and backend. No lazy object, query or transaction escapes.

The two records must name the same organisation and membership; a mismatch refuses with
`ParentPolicyNotFoundError`. The current active, accepted, issuer-qualified, same-organisation
actor checks stay inside the existing readers, and both keep the active-organisation limit.

## Refusals

| Cause | Raised |
|---|---|
| `MemberAuthorityNotFoundError` | `ParentPolicyNotFoundError` ("parent policy not found") |
| `MemberAuthorityUnavailableError` | `ParentPolicyUnavailableError` ("parent policy unavailable") |
| Policy not found or unavailable | the parent-policy error itself |
| Ambient or unqualified transaction | `RuntimeError` (programmer error) |

A policy failure returns no partial authority. Arbitrary database errors are not caught.
Messages are constant and carry no contact or resource detail.

## Readers in `policy_selectors`

- `_read_parent_policy_facts`: the one private materializer. Actor predicates, inheritance
  selection, scope checks, rule validation, immutable output and fingerprint are unchanged.
  Only the two wrappers below call it.
- `resolve_parent_policy`: the standalone reader, unchanged in behaviour. It keeps its own
  ambient-transaction refusal, input validation and literal `SET TRANSACTION` statement.
- `read_parent_policy_in_snapshot`: the qualified seam. It requires an ambient atomic block
  whose actual `transaction_isolation` is `repeatable read` and `transaction_read_only` is
  `on`, and refuses otherwise before any workspace query. It neither starts nor ends a
  transaction.

The composer sets its isolation from a fixed constant through psycopg SQL composition, so the
standalone literal still occurs once and its source mutant still targets the standalone
reader. There is no caller-configurable isolation and no bypass flag.

## Revisions and policy identity

`authority.authority_revision` is the stored organisation counter. `policy.policy_revision`
is the stored policy counter. They describe different sources and are never equated, merged
or synthesized.

A policy revision identifies a version of one policy, not the binding. Rebinding a category
or workspace default from one policy to another can leave the revision unchanged when both
policies stand at the same revision. A consumer that checks freshness must compare the bound
policy's identity and revision together, `(policy.policy_id, policy.policy_revision)`, or the
`binding_fingerprint`, which contains both; never the revision alone. The acceptance proves a
same-revision swap changes `policy_id` and the fingerprint.

## Acceptance

`tests/test_workspace_member_parent_policy.py`: 13 test functions, 24 cases, on real
PostgreSQL 16 rows from the parent-policy `world` fixture.

- Each real reader is called once, member first, on one observed read-only repeatable-read
  snapshot and backend; stored IDs and both revisions match the database.
- The result is two fields, nested in the existing immutable types, eager, with no
  allowed, eligibility or projection fields.
- Ambient atomic and manual transactions refuse; the seam refuses outside, READ COMMITTED
  and read-write calls before any workspace query; the seam equals the standalone facts.
- Foreign issuer, removed member, disabled identity and suspended organisation refuse.
  Missing policy and unavailable authority refuse with no partial result. An injected
  organisation or membership mismatch refuses.
- Five real second-connection commits land right after the authority-revision SELECT has
  executed and before it returns: the in-flight result equals the complete old pair, and
  the next call returns the complete new pair or refuses the removed or disabled actor.
- Negative control: the two standalone readers composed in separate transactions fail that
  same oracle under the same writer schedule. The writer commits after the
  authority-revision SELECT and before the split reader's second transaction starts.
- A writer that changes both counters and rolls back leaves the pair unchanged.
- A rebinding to another policy at the same revision is visible through `policy_id` and the
  fingerprint.

## Outside this slice

Stored role is descriptive input. No eligible or delegable capability mapping, role policy,
final allow decision, projection binding or projected revision is added. No HTTP response,
message-parent deletion, attachment readiness, download or last-moment revocation fence.
The facts describe one committed snapshot, not a later emission or a cached permission.

# Persisted parent-policy facts

Status: Proposed. Implemented on this branch, with its acceptance written before the source;
the database and migration acceptance runs in CI on the tree combined with the
membership-authority slice.

## Boundary

The existing workspaces app owns one normalized resource-policy store.
`resolve_parent_policy(verified=..., channel_id=...)` accepts trusted
`VerifiedAccessToken` evidence and returns immutable, eagerly materialized internal
facts. It does not verify a JWT, expose an endpoint or make a final permission decision.

The reader owns a short REPEATABLE READ READ ONLY transaction and rejects ambient
transactions. It resolves the enabled issuer-qualified identity, calls the existing
current organisation-read grant, requires an active organisation, and binds the
membership ID before reading workspace tables. The membership ID lookup and the grant
narrow one shared current-membership predicate (undeleted, active, accepted, known role),
so the lookup refuses a membership that is not current on its own; each is proven alone
by the grant source mutant. Identity services are unchanged.

Select exactly one policy: explicit channel policy, otherwise category default,
otherwise workspace default. Replacement never merges ACLs. Missing policies,
inconsistent bindings and unsupported stored values refuse. Initial channel
lifecycle is provisioning and initial policy visibility is restricted. All five
stored lifecycle values remain facts for the final evaluator, with no transition
writer in this slice. There is no owner/admin bypass.

`ParentPolicyFacts` contains organisation/workspace/channel/member IDs, channel kind
and lifecycle, selected policy ID/revision/source/visibility, sorted distinct member
allow/deny tuples, denied capabilities and an internal binding fingerprint. The
fingerprint contains actual channel bindings, relevant defaults and policy revision;
it is neither an organisation authority revision nor a transferable permit. ACL facts
are private service inputs and must not be returned as unauthorised metadata.

`ParentPolicyNotFoundError` refuses absent, foreign or inactive identity/member scope.
`ParentPolicyUnavailableError` refuses unresolved policy state. Both use constant
messages without resource or contact details. No lazy database object escapes.

## Stored invariants

Migration 0003 adds ResourcePolicy and ResourcePolicyRule, nullable defaults on
Workspace and Category, and Channel's exact inherit/null or explicit/non-null pair
plus the closed lifecycle vocabulary. Text checks and conditional target uniqueness
are named. The 19 denied-capability values match the frozen final kernel vocabulary.
Member rules require membership and no capability; capability-deny rules require a
known capability and no membership. Explicit allow and deny may both be preserved.
No role-grant or eligibility table is added.

Migration 0004 installs six named RESTRICT foreign keys, five invoker-security
trigger functions and seven row triggers. Policy defaults must belong to the same
workspace; rule membership must belong to its organisation. Missing targets reach
the named foreign key, while existing foreign targets raise named scope diagnostics.
Policy ID/workspace and rule ID/policy bindings are immutable. Policy deletion refuses.

Every policy UPDATE ignores caller-assigned revision and advances OLD.revision by
one. An exhausted bigint raises `policy_revision_exhausted`. Successful rule
insert/update/delete locks and updates its policy row in the same transaction;
the policy guard alone computes the increment. Rollback restores both rule and
revision. No-op writes may advance revisions. Explicit positive initial seeds are
allowed; revision is otherwise database-owned.

Both migrations bound lock wait to five seconds and statement execution to thirty
seconds in both directions. Reversal removes only this slice's declared objects;
the existing metadata migrations remain unchanged.

## Acceptance and limits

The executable contract is 26 parent-policy cases, all 15 metadata cases and all
five settings-profile cases. The parent-policy tests require PostgreSQL major 16
and real rows: named raw-write refusals, overflow rollback, two-connection revision
serialization, membership removal and snapshot interleaving, source mutants for the
grant and isolation clauses, exact object definitions, migration round trips and
eager immutable results. Dedicated, normal-test and job-queue profiles register the
app; API profiles remain unchanged. Collection or syntax checks are not database proof.

Under a separately allocated disposable database and retained exact-lock interpreter:

```sh
"${TASK_CORE_PYTHON:?}" -B -m pytest --ds=config.settings.workspace_metadata_test \
  -p no:cacheprovider tests/test_workspace_parent_policy.py \
  tests/test_workspace_metadata_schema.py tests/test_workspace_test_profiles.py -q
```

The existing policy kernel remains the only final evaluator. Composition still
needs real current eligible/delegable capabilities, a monotonic organisation
authority revision and a genuine desired/observed projection binding. Never invent
eligibility or set projected revisions equal to current ones to make this reader
appear ready. The snapshot is current only at resolution: membership removal,
policy replacement or parent changes committed before the next call must be seen,
but later HTTP emission needs its own revocation fence. No read transaction may be
held through slow byte delivery. Message-parent lifecycle, attachment readiness,
binary response contracts, content storage and native bypass closure remain outside
this store/reader.

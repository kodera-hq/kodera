# Workspace policy projection kernel

Status: Proposed. Implemented on this branch as a pure kernel, tested in CI on the combined tree. No HTTP, database, messaging engine or runtime authority is implemented by this slice.

## Scope

`services.workspace_policy.projection.evaluate(snapshot)` returns exactly
`{"allowed": bool, "reason": str}` without mutating its input or performing I/O.
The input is a trusted, coherent internal snapshot assembled by the authority
resolver. The function rejects malformed snapshots but does not authenticate
tokens, prove freshness or look up membership. It never accepts a browser's
claimed capability list as authority.

The resolver owns issuer-qualified identity, current active membership,
organisation/resource binding, role delegation, scoped capability eligibility,
inheritance resolution and the desired/current projection revisions. Existing
membership and staff role enums are unchanged. This module contains no role-rank
mapping or owner/admin/private-content bypass.

## Snapshot

All fields below are required; unknown fields are refused. Values must be plain
JSON-shaped dictionaries, strings, booleans, lists and positive integers; booleans
are not revisions. Strings are nonempty and nonblank. Lists contain distinct
nonblank strings. Transport UUID validation remains at the API boundary.

| Fields | Type and meaning |
|---|---|
| `actor_org`, `resource_org`, `member_id` | Opaque IDs; actor/resource organisations must match |
| `active_member`, `resolved`, `is_dm` | Strict booleans |
| `authority_revision`, `projected_authority_revision`, `policy_revision`, `projected_policy_revision` | Positive integers; both projected values must equal the desired values exactly |
| `projection_state` | `pending`, `ready`, `failed`; only ready can allow |
| `eligible`, `denied` | Lists from the closed capability vocabulary below |
| `action` | One capability from that vocabulary |
| `kind` | `text`, `audio` |
| `lifecycle` | `provisioning`, `active`, `archived`, `deletion_pending`, `deleted` |
| `visibility` | `organisation`, `restricted` |
| `role_ids`, `allow_members`, `allow_roles`, `deny_members`, `deny_roles` | Opaque role/member IDs, not a capability source |
| `dm_members` | Exactly two distinct member IDs for a text DM; empty for a non-DM |

Capabilities are `channel.view`, `channel.history`, `message.post`,
`message.reply`, `message.edit_own`, `message.delete_own`, `message.delete_any`,
`message.react`, `message.pin`, `message.search`, `file.upload`, `file.read`,
`file.delete_own`, `file.delete_any`, `media.connect`, `media.speak`, `media.video`,
`media.share`, `media.moderate`.

Every action requires its own eligibility plus eligible `channel.view`. Denying
any required capability wins. `channel.history`, message search, all existing
message actions (reply, edit, delete, react, pin), file read and file delete also
require eligible/non-denied `channel.history`. A new top-level post and its upload
do not imply history access. A server accepting an upload for an existing thread
must additionally evaluate reply and current parent access. Reaction and pin
eligibility are independent; neither requires post or the other capability.

This evaluator is the final capability intersection over a trusted current
snapshot, not merely independent grant eligibility. `media.speak`, `media.video`
and `media.share` also require eligible and non-denied `media.connect`. A revoked
connection capability therefore refuses each publishing action. Scoped
`media.moderate` does not require joining and remains possible without connect
eligibility or with connect explicitly denied; it still requires view, its own
capability, current resource access and all other gates. This pure decision does
not itself establish an actual media connection or revoke a provider session.

Only audio channels accept media actions. Text/DM accepts message/file actions
and history. View applies to either kind. Archived text permits only view,
history, search and file read; archived audio refuses every kernel action,
including occupancy/view. Structural administration has a separate authority
path and does not grant content or occupancy.

## Evaluation order and reasons

1. Malformed/unknown input or unresolved policy: `unavailable`.
2. Inactive or foreign-organisation actor: `not_found`.
3. Explicit member or any actor-role deny: `not_found`.
4. Nonparticipant DM, or restricted non-DM without a member/role grant: `not_found`.
5. Projection not ready or either revision pair unequal: `projection_unavailable`.
6. A missing or denied prerequisite capability: `forbidden`.
7. Wrong channel kind for the action: `forbidden`.
8. Provisioning/deletion-pending/deleted lifecycle: `unavailable`.
9. Archived mutation or archived audio operation: `archived`.
10. Otherwise: `allow` with `allowed=true`.

All refusals have `allowed=false`. A DM participant supplies its visibility
grant; explicit denies still win. No numeric role hierarchy is consulted.
Internal reasons must be mapped/masked by the actual service boundary where
revealing object existence would be inappropriate. These reasons are not a new
HTTP problem registry.

## Caller obligations and limits

Enforcement still requires current authenticated actor resolution; same-org
policy references; correct role/capability scope; active DM pair policy; matching
message parent and author for own operations; current attachment parent access;
server-side projection reconciliation; operation/revocation fencing; and
cache/stream invalidation. A matching pair of invented or stale snapshot
revisions is not proof of current authority. This pure function cannot establish
the connected-session revocation bound or native endpoint isolation.

No journal, engine, browser boundary, storage schema, lifecycle erasure policy or
service selection is frozen by this module. Those remain separate integration
decisions. The slice only makes the permission intersection testable.

## Acceptance

Before implementation, the self-contained test module must fail importing the
absent evaluator. After implementation, from the repository root with an
installed Python interpreter:

```sh
python3 -S -B -m unittest discover -s tests -p test_workspace_policy_projection.py -v
```

The suite covers named history prerequisites, independent capability
combinations, explicit-deny precedence, organisation/DM privacy, archive reads
versus mutation, strict malformed-input refusal, exact revision equality and
input immutability. Site packages, pytest plugins and a database are unnecessary
for this targeted command. Normal repository lint, typecheck, tests and required
publication checks remain required under their existing prerequisites.

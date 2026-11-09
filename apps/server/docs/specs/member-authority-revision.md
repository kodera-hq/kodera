# Current membership authority facts

Status: Proposed. Implemented on this branch; its real-database acceptance runs in CI on the tree
combined with the workspace slices. No HTTP operation, capability policy, custom-role
administration, projected acknowledgement or final service grant.

## Stored authority

Organisation.authority_revision is a positive bigint with baseline one, independent of
owner_guard_revision and workspace structure. The insert trigger forces one; every Organisation
UPDATE advances from OLD, ignoring caller assignments. Exhaustion refuses with SQLSTATE23514 and
organisation_authority_revision_exhausted. Multiple increments per transaction and conservative
increments for descriptive/no-op writes are permitted. Rollback restores all fields and revisions.

Membership and Identity row changes version their immutable parent User with a real no-op UPDATE
before existing membership owner-guard work. User UPDATE fans out to all organisations referenced
by that user's memberships or identities, including retained/deleted associations, in UUID order.
An association's AFTER trigger additionally touches its own organisation so new links are covered.
Only the organisation trigger assigns OLD+1. User DELETE fan-out is defined; existing RESTRICT
constraints prevent deleting a user with retained associations. Identity deletion remains refused.
All original issuer/subject bindings, stored roles and last-owner/slug protections remain intact.
A staff identity has no organisation (`STAFF_IDENTITY.md` §1). The triggers are unchanged for it:
each organisation they lock or touch is selected by an `organisation_id` that is null, which
selects no row, so a staff identity's writes advance no organisation's revision; its parent User
is still versioned, and fans out to whatever customer associations that person holds.

This actual parent tuple change fences concurrent user disable against association insertion:
READ COMMITTED observes committed fan-out after waiting; REPEATABLE READ/SERIALIZABLE must abort
with40001 if the parent changed since the snapshot. A row lock without tuple versioning is
insufficient. No global mutex or blanket isolation prohibition is introduced. A rolled-back holder
permits a valid waiter; timeouts/deadlocks never qualify as the expected safety proof.

### Lock order

Every authority write takes its row locks in one global order: the parent User first, then
Organisation rows in ascending id, never a lower id after a higher one.

- A Membership or Identity INSERT, UPDATE or DELETE fires `aa_member_authority_user_touch`
  before the owner guard. It locks the parent User, then, in one `ORDER BY id FOR NO KEY UPDATE`
  read, every organisation the write will touch: each one the user's identities and memberships
  reference, retained ones included, and the association's own target organisation. Only then
  does it version the User tuple. The fan-out, the owner guard and the AFTER touch that follow
  update rows this transaction already holds and take no new organisation lock.
- A direct User UPDATE locks the User, then the fan-out (`user_authority_fanout`) updates the
  user's organisations `ORDER BY organisation_id`.
- An Organisation write locks only its own row.

The user lock serialises every association write of one user, so the organisation set read
after it is the set the fan-out updates. Two single-row writers therefore each take a prefix of
one ascending sequence and wait, never cycle. Without the pre-lock the target
was locked after the fan-out: two invitations crossing two users between organisations A and C
could each hold one organisation and wait for the other (40P01). Separate organisations with
different users keep independent progress; same-user organisations share a real invalidation
dependency.

The order holds within one row's write. A statement or transaction that writes several
associations, or an organisation row and then an association, must take its users in ascending id before any organisation lock,
or retry an aborted transaction from fresh authority; arbitrary opposing multi-statement order
is not promised deadlock-free. This source does not amend the bootstrap custodian's
organisation-first transaction, whose new organisation row no other transaction can see, or
introduce a retry service.

## Reader

resolve_member_authority(verified=...) owns a short REPEATABLE READ READ ONLY transaction and
refuses ambient transactions. read_member_authority_in_snapshot is an internal composition seam
that requires that mode on an existing transaction. Both use the actual current_identity and
has_current_read_grant helpers. Membership and revision come from that same snapshot; no caller
actor/member/revision values are trusted. Signed token verification remains the calling boundary.
The first slice supports active organisations; existing general organisation reads still support
suspended organisations. Billing remains a stored role, not a fabricated workspace capability.

MemberAuthorityFacts contains only organisation_id, user_id, identity_id, issuer, subject, realm,
membership_id, stored_role and authority_revision. It is frozen and fully materialized. Ineligible
actors produce MemberAuthorityNotFoundError; unavailable revisions produce
MemberAuthorityUnavailableError. Neither exposes resource/contact details. There is no allowed,
eligible, delegable or projected revision field. Do not log principal facts or cache them as grants.

A later composition service must read these facts and actual parent-policy facts inside one owned
snapshot. Two completed public reader calls do not provide that guarantee. The resource evaluator
still needs an explicitly bound capability table, real projection state and a final operation fence.
File bytes and media admission cannot rely on this earlier snapshot after a slow external action.
Audit/outbox changes for role commands and measured connected-session revocation remain separate.

## Acceptance and recovery boundary

The real-table suites cover stored roles, issuer/subject separation, missing/current membership,
snapshot interleaves, direct counter write domain, rollback/exhaustion, catalog definitions,
the firing order of the BEFORE row triggers read from `pg_trigger`, unstorable subjects refused
before any identity read, refusal of every transaction mode but REPEATABLE READ READ ONLY by the
internal reader, and partial/full migration round trips. The existing customer persistence concurrency suite stays
unchanged: all three owner-write isolation levels, the repeatable-read activation/retirement race
and independent organisation progress remain mandatory.

Twenty-four parent-fan-out races cover both association types, all three isolation levels, both
write orders and holder commit/rollback. Two committed function mutants in an exclusively owned
disposable test database distinguish a missing fence and a lock-only fence; original function
text is restored in finally. A rolled-back trigger mutant and isolated reader source mutants
prove counter and snapshot/current-membership acceptance can fail.

Lock order is probed with real connections: a writer blocked on the k-th of five organisations
must hold exactly the k lower ones, for a direct User UPDATE and for a membership insert whose
target sits in the middle. Committed mutants that reverse the fan-out, reverse the pre-lock or
drop the target from it are each distinguished. Two crossed invitations between two
organisations must both commit, with the higher organisation free while both wait; the
target-dropping mutant is distinguished there too. Two committed concurrent writers of one
organisation, including two that assign the same stale value, must end two revisions higher;
a mutant that keeps the caller's value is distinguished.

Migration0004 backfills one without asserting prior projection convergence;0005 installs six
triggers/four functions. Reversing them removes only those objects/column/constraint and must
preserve prior guards. A restored/rolled-back database history can reuse integers: operators must
invalidate every external grant and projection binding before reuse. Administrative TRUNCATE and
schema/restore operations are outside row-DML invalidation. No cross-restore epoch or durable event
stream is fabricated here. The shared documentation index requires serialized integration.

"""Member authority and parent-policy facts read in one snapshot, against real tables."""

from dataclasses import FrozenInstanceError, fields, is_dataclass, replace
from inspect import signature
from uuid import UUID

import pytest
from django.db import connection, transaction
from test_customer_persistence_concurrency import session
from test_workspace_parent_policy import world as world

from apps.orgs import authority_selectors as member_service
from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)


def resolve(world, **changes):
    values = {"verified": world.actor.verified, "channel_id": world.channel.pk}
    values.update(changes)
    return world.service.resolve_member_parent_policy(**values)


def snapshot():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_setting('transaction_isolation'), "
            "current_setting('transaction_read_only'), pg_current_snapshot()::text, pg_backend_pid()"
        )
        return cursor.fetchone()


def test_composition_uses_both_real_snapshot_readers_once(world, monkeypatch):
    seen = []
    actual_member = world.service.read_member_authority_in_snapshot
    actual_policy = world.service.read_parent_policy_in_snapshot
    assert actual_member is member_service.read_member_authority_in_snapshot

    def member(**kwargs):
        seen.append(("member", snapshot()))
        return actual_member(**kwargs)

    def policy(**kwargs):
        seen.append(("policy", snapshot()))
        return actual_policy(**kwargs)

    monkeypatch.setattr(world.service, "read_member_authority_in_snapshot", member)
    monkeypatch.setattr(world.service, "read_parent_policy_in_snapshot", policy)
    facts = resolve(world)
    assert [kind for kind, _ in seen] == ["member", "policy"]
    assert seen[0][1] == seen[1][1]
    assert seen[0][1][:2] == ("repeatable read", "on")
    assert facts.authority.membership_id == facts.policy.membership_id == world.actor.member.pk
    assert facts.authority.organisation_id == facts.policy.organisation_id == world.first.pk
    assert facts.authority.user_id == world.actor.user.pk
    assert facts.authority.identity_id == world.actor.identity.pk
    world.first.refresh_from_db()
    world.default.refresh_from_db()
    assert facts.authority.authority_revision == world.first.authority_revision > 0
    assert facts.policy.policy_revision == world.default.revision > 0
    assert not connection.in_atomic_block and connection.get_autocommit()


def test_combined_result_is_eager_immutable_and_adds_no_permission_fields(world):
    facts = resolve(world)
    assert {field.name for field in fields(facts)} == {"authority", "policy"}
    assert type(facts.authority) is member_service.MemberAuthorityFacts
    assert type(facts.policy) is world.service.ParentPolicyFacts

    def no_query(*args, **kwargs):
        raise AssertionError("combined facts performed a lazy query")

    def materialized(value):
        if is_dataclass(value):
            return all(materialized(getattr(value, field.name)) for field in fields(value))
        if type(value) is tuple:
            return all(materialized(item) for item in value)
        return type(value) in (UUID, int, str, type(None))

    with connection.execute_wrapper(no_query):
        assert materialized(facts)
        for value in (facts, facts.authority, facts.policy):
            for forbidden in (
                "allowed",
                "eligible",
                "projected_authority_revision",
                "projection_state",
            ):
                assert not hasattr(value, forbidden)
        with pytest.raises(FrozenInstanceError):
            facts.authority = facts.authority
        with pytest.raises(FrozenInstanceError):
            facts.authority.authority_revision = 1
        with pytest.raises(FrozenInstanceError):
            facts.policy.policy_revision = 1
    assert not connection.in_atomic_block and connection.get_autocommit()
    assert set(signature(world.service.resolve_member_parent_policy).parameters) == {
        "verified",
        "channel_id",
    }


@pytest.mark.parametrize("ambient", ["atomic", "manual"])
def test_combined_reader_refuses_ambient_transactions(world, ambient):
    if ambient == "atomic":
        with transaction.atomic(), pytest.raises(RuntimeError):
            resolve(world)
    else:
        connection.set_autocommit(False)
        try:
            with pytest.raises(RuntimeError):
                resolve(world)
        finally:
            connection.rollback()
            connection.set_autocommit(True)


@pytest.mark.parametrize("mode", ["outside", "read-committed", "read-write"])
def test_policy_snapshot_seam_refuses_unqualified_call_before_workspace_read(world, mode):
    reads = []

    def observe(execute, statement, params, many, context):
        if "workspaces_" in str(statement).lower():
            reads.append(str(statement))
        return execute(statement, params, many, context)

    def call():
        return world.service.read_parent_policy_in_snapshot(
            verified=world.actor.verified, channel_id=world.channel.pk
        )

    with connection.execute_wrapper(observe):
        if mode == "outside":
            with pytest.raises(RuntimeError):
                call()
        else:
            with transaction.atomic():
                with connection.cursor() as cursor:
                    if mode == "read-committed":
                        cursor.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY")
                    else:
                        cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE")
                with pytest.raises(RuntimeError):
                    call()
    assert reads == []


def test_qualified_policy_seam_reuses_standalone_materialization(world):
    expected = world.service.resolve_parent_policy(
        verified=world.actor.verified, channel_id=world.channel.pk
    )
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        actual = world.service.read_parent_policy_in_snapshot(
            verified=world.actor.verified, channel_id=world.channel.pk
        )
        assert actual == expected
    assert not connection.in_atomic_block


@pytest.mark.parametrize("case", ["foreign-issuer", "removed", "disabled", "suspended"])
def test_combined_reader_keeps_current_active_same_org_actor(world, case):
    changes = {}
    if case == "foreign-issuer":
        changes["verified"] = world.other.verified
    elif case == "removed":
        world.models.Membership.objects.filter(pk=world.actor.member.pk).update(state="removed")
    elif case == "disabled":
        world.models.Identity.objects.filter(pk=world.actor.identity.pk).update(enabled=False)
    else:
        world.models.Organisation.objects.filter(pk=world.first.pk).update(state="suspended")
    with pytest.raises(world.service.ParentPolicyNotFoundError) as error:
        resolve(world, **changes)
    assert str(error.value) == "parent policy not found"
    assert not connection.in_atomic_block and connection.get_autocommit()


def test_missing_policy_refuses_without_partial_authority_escape(world):
    world.Workspace.objects.filter(pk=world.workspace.pk).update(default_policy=None)
    with pytest.raises(world.service.ParentPolicyUnavailableError) as error:
        resolve(world)
    assert str(error.value) == "parent policy unavailable"
    assert not connection.in_atomic_block and connection.get_autocommit()


def test_unavailable_member_revision_uses_safe_composition_refusal(world, monkeypatch):
    # The 03 suite owns real invalid-revision storage behavior. This injects only
    # its typed service failure to verify the composition boundary's safe mapping.
    def unavailable(**kwargs):
        raise member_service.MemberAuthorityUnavailableError()

    monkeypatch.setattr(world.service, "read_member_authority_in_snapshot", unavailable)
    with pytest.raises(world.service.ParentPolicyUnavailableError) as error:
        resolve(world)
    assert str(error.value) == "parent policy unavailable"
    assert not connection.in_atomic_block


@pytest.mark.parametrize("binding", ["organisation_id", "membership_id"])
def test_composition_refuses_inconsistent_reader_bindings(world, monkeypatch, binding):
    actual = world.service.read_parent_policy_in_snapshot

    def corrupt(**kwargs):
        return replace(actual(**kwargs), **{binding: new_uuid7()})

    monkeypatch.setattr(world.service, "read_parent_policy_in_snapshot", corrupt)
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world)
    assert not connection.in_atomic_block


def interleaved_change(world, resolver, change):
    """Commit once after authority SELECT executes, before returning that query."""
    replacement = world.Policy.objects.create(workspace=world.workspace, visibility="organisation")
    world.Rule.objects.create(policy=replacement, kind="deny_capability", capability="file.read")
    target_group = world.Category.objects.create(
        workspace=world.workspace,
        name="Replacement",
        position=1,
        default_policy=replacement,
    )
    old = resolve(world)
    seen = {"authority_revision_read": False, "committed": False}
    with session() as writer:
        writer.execute("SET statement_timeout='8s'")
        writer.execute("SET lock_timeout='6s'")
        writer_pid = writer.info.backend_pid

        def interleave(execute, statement, params, many, context):
            text = str(statement).lower().lstrip()
            if text.startswith("select") and "workspaces_" in text:
                assert seen["committed"], "policy read preceded the authority-query interleave"
            result = execute(statement, params, many, context)
            authority_query = (
                text.startswith("select")
                and "orgs_organisation" in text
                and "authority_revision" in text
            )
            if authority_query and not seen["authority_revision_read"]:
                # This query has executed in the first reader's old snapshot.
                # Commit before its result returns, while the split reader's
                # independent policy transaction has not started yet.
                seen["authority_revision_read"] = True
                observed = snapshot()
                assert observed[:2] == ("repeatable read", "on")
                assert observed[3] != writer_pid
                with writer.transaction():
                    if change == "remove-replace":
                        writer.execute(
                            "UPDATE orgs_membership SET state='removed' WHERE id=%s",
                            [world.actor.member.pk],
                        )
                    elif change == "disable-replace":
                        writer.execute(
                            "UPDATE identity_identity SET enabled=false WHERE id=%s",
                            [world.actor.identity.pk],
                        )
                    else:
                        writer.execute(
                            "UPDATE orgs_membership SET role='org_admin' WHERE id=%s",
                            [world.actor.member.pk],
                        )
                    if change == "role-rule":
                        writer.execute(
                            "INSERT INTO workspaces_resourcepolicyrule "
                            "(id,created_at,updated_at,policy_id,kind,capability) "
                            "VALUES (%s,now(),now(),%s,'deny_capability','channel.history')",
                            [new_uuid7(), world.default.pk],
                        )
                    elif change == "role-reparent":
                        writer.execute(
                            "UPDATE workspaces_channel SET category_id=%s,lifecycle='active' WHERE id=%s",
                            [target_group.pk, world.channel.pk],
                        )
                    else:
                        writer.execute(
                            "UPDATE workspaces_workspace SET default_policy_id=%s WHERE id=%s",
                            [replacement.pk, world.workspace.pk],
                        )
                seen["committed"] = True
            return result

        with connection.execute_wrapper(interleave):
            first = resolver(verified=world.actor.verified, channel_id=world.channel.pk)
    assert seen["committed"], "real writer did not reach the database interleave"
    assert first == old, "composition mixed database snapshots"
    assert not connection.in_atomic_block and connection.get_autocommit()
    if change in ("remove-replace", "disable-replace"):
        with pytest.raises(world.service.ParentPolicyNotFoundError):
            resolve(world)
    else:
        fresh = resolve(world)
        world.first.refresh_from_db()
        assert fresh.authority.stored_role == "org_admin"
        assert fresh.authority.authority_revision == world.first.authority_revision
        assert fresh.authority.authority_revision > old.authority.authority_revision
        if change == "role-rule":
            assert fresh.policy.policy_id == old.policy.policy_id
            assert fresh.policy.policy_revision == old.policy.policy_revision + 1
            assert fresh.policy.denied == ("channel.history",)
        else:
            assert fresh.policy.policy_id == replacement.pk
            assert fresh.policy.denied == ("file.read",)
            assert fresh.policy.selected_from == (
                "category" if change == "role-reparent" else "workspace"
            )
            if change == "role-reparent":
                assert fresh.policy.lifecycle == "active"
        assert fresh.policy.binding_fingerprint != old.policy.binding_fingerprint


@pytest.mark.parametrize(
    "change",
    [
        "role-replace",
        "remove-replace",
        "disable-replace",
        "role-rule",
        "role-reparent",
    ],
)
def test_one_snapshot_survives_real_interleaved_commit_and_next_call_is_fresh(world, change):
    interleaved_change(world, world.service.resolve_member_parent_policy, change)


def test_independent_transaction_negative_control_fails_same_snapshot_oracle(world):
    # Deliberately compose the actual standalone readers in separate transactions.
    # This uses real rows and the same second-connection writer/oracle as above.
    def split(*, verified, channel_id):
        return world.service.MemberParentPolicyFacts(
            authority=member_service.resolve_member_authority(verified=verified),
            policy=world.service.resolve_parent_policy(verified=verified, channel_id=channel_id),
        )

    with pytest.raises(AssertionError, match="composition mixed database snapshots"):
        interleaved_change(world, split, "role-replace")
    assert resolve(world).authority.stored_role == "org_admin"


def test_failed_writer_rolls_back_both_revisions_and_combined_facts(world):
    before = resolve(world)
    with session() as writer:
        writer.execute("SET statement_timeout='8s'")
        writer.execute("SET lock_timeout='6s'")

        class RollbackProbeError(Exception):
            pass

        with pytest.raises(RollbackProbeError), writer.transaction():
            writer.execute(
                "UPDATE orgs_membership SET role='org_admin' WHERE id=%s",
                [world.actor.member.pk],
            )
            writer.execute(
                "UPDATE workspaces_resourcepolicy SET visibility='organisation' WHERE id=%s",
                [world.default.pk],
            )
            observed = writer.execute(
                "SELECT o.authority_revision,p.revision FROM orgs_organisation o "
                "JOIN workspaces_workspace w ON w.organisation_id=o.id "
                "JOIN workspaces_resourcepolicy p ON p.workspace_id=w.id WHERE p.id=%s",
                [world.default.pk],
            ).fetchone()
            assert observed[0] > before.authority.authority_revision
            assert observed[1] == before.policy.policy_revision + 1
            raise RollbackProbeError()
    assert resolve(world) == before


def test_rebinding_to_another_policy_at_the_same_revision_is_visible_in_the_facts(world):
    # A freshness check that compares only the policy revision reads a swap of the
    # bound policy as current when both policies stand at the same revision. The
    # facts carry the bound policy's identity, so a consumer keyed on (id, revision)
    # sees the swap.
    first = world.Policy.objects.create(workspace=world.workspace)
    second = world.Policy.objects.create(workspace=world.workspace)
    world.Category.objects.filter(pk=world.group.pk).update(default_policy=first)
    before = resolve(world)
    world.Category.objects.filter(pk=world.group.pk).update(default_policy=second)
    after = resolve(world)
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.revision == second.revision, "precondition: both policies at one revision"
    assert before.policy.policy_id == first.pk and after.policy.policy_id == second.pk
    assert before.policy.selected_from == after.policy.selected_from == "category"
    assert after.policy.policy_revision == before.policy.policy_revision
    assert (after.policy.policy_id, after.policy.policy_revision) != (
        before.policy.policy_id,
        before.policy.policy_revision,
    )
    assert after.policy.binding_fingerprint != before.policy.binding_fingerprint
    # Rebinding a default is not a membership write: the authority revision is unchanged.
    assert after.authority == before.authority

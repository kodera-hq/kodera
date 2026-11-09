"""Current real membership facts, not capability or final-service grants."""

import ast
import dataclasses
import sys
import types
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID

import pytest
from django.db import connection, transaction
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import anchor, anchor_models, identity

from apps.orgs import authority_selectors as authority
from services.identity.access_tokens import VerifiedAccessToken


@pytest.fixture(name="world")
def authority_world(transactional_db):
    models = anchor_models()
    org, _, owners = anchor(models)
    member = owners[0]
    principal = identity(models, org, member.user)
    verified = VerifiedAccessToken(
        org.issuer, principal.subject, ("kodera-server",), 1, 9999999999, None, None, None, None
    )
    return types.SimpleNamespace(
        models=models,
        org=org,
        member=member,
        principal=principal,
        user=member.user,
        verified=verified,
    )


def stored_revision(world):
    world.org.refresh_from_db()
    return world.org.authority_revision


@pytest.mark.parametrize("role", ["org_owner", "org_admin", "org_member", "org_billing"])
def test_facts_preserve_existing_roles_and_are_materialized(world, role):
    if role != "org_owner":
        # Keep an independent accepted owner; do not defeat the last-owner guard.
        owner = world.models.User.objects.create(email="retained-owner@customer.test")
        world.models.Membership.objects.create(
            user=owner,
            organisation=world.org,
            role="org_owner",
            state="active",
            accepted_at=world.member.accepted_at,
        )
        world.models.Membership.objects.filter(pk=world.member.pk).update(role=role)
    expected = stored_revision(world)
    facts = authority.resolve_member_authority(verified=world.verified)
    assert facts.organisation_id == world.org.pk
    assert facts.user_id == world.user.pk and facts.identity_id == world.principal.pk
    assert facts.membership_id == world.member.pk and facts.stored_role == role
    assert (facts.issuer, facts.subject, facts.realm) == (
        world.org.issuer,
        world.principal.subject,
        world.org.realm,
    )
    assert facts.authority_revision == expected > 0
    assert not connection.in_atomic_block
    with pytest.raises(dataclasses.FrozenInstanceError):
        facts.stored_role = "org_owner"

    def no_query(*_args):
        raise AssertionError("fact evaluation queried after transaction completion")

    with connection.execute_wrapper(no_query):
        values = dataclasses.asdict(facts)
        assert set(values) == {
            "organisation_id",
            "user_id",
            "identity_id",
            "issuer",
            "subject",
            "realm",
            "membership_id",
            "stored_role",
            "authority_revision",
        }
        assert all(type(v) in (str, int, UUID) for v in values.values())


@pytest.mark.parametrize(
    "case",
    [
        "wrong-issuer",
        "wrong-subject",
        "user-disabled",
        "identity-disabled",
        "identity-deleted",
        "user-deleted",
        "member-removed",
        "member-suspended",
        "member-deleted",
        "member-invited",
        "organisation-suspended",
        "organisation-closed",
    ],
)
def test_ineligible_actor_never_returns_authority(world, case):
    from datetime import timedelta

    from django.utils import timezone

    now = timezone.now()
    verified = world.verified
    if case == "wrong-issuer":
        verified = dataclasses.replace(verified, issuer="https://foreign.test/realms/alpha")
    elif case == "wrong-subject":
        verified = dataclasses.replace(verified, subject="unknown")
    else:
        # A closed organisation permits changing the only owner for refusal fixtures.
        if case.startswith("member-"):
            world.models.Organisation.objects.filter(pk=world.org.pk).update(state="closed")
        if case in {"user-disabled", "identity-disabled"}:
            model, pk = (
                (world.models.User, world.user.pk)
                if case.startswith("user")
                else (world.models.Identity, world.principal.pk)
            )
            model.objects.filter(pk=pk).update(enabled=False)
        elif case in {"identity-deleted", "user-deleted", "member-deleted"}:
            obj = {
                "identity-deleted": world.principal,
                "user-deleted": world.user,
                "member-deleted": world.member,
            }[case]
            type(obj).objects.filter(pk=obj.pk).update(
                deleted_at=now, purge_after=now + timedelta(days=1)
            )
        elif case.startswith("member-"):
            state = case.removeprefix("member-")
            changes = {"state": state}
            if state == "invited":
                changes["accepted_at"] = None
            world.models.Membership.objects.filter(pk=world.member.pk).update(**changes)
        else:
            world.models.Organisation.objects.filter(pk=world.org.pk).update(
                state=case.removeprefix("organisation-")
            )
    with pytest.raises(authority.MemberAuthorityNotFoundError):
        authority.resolve_member_authority(verified=verified)


UNSTORABLE_SUBJECTS = {
    "nul": "provider\x00subject",
    "non-ascii": "provider-subjecté",
    "256-chars": "s" * 256,
    "empty": "",
    "space": "same subject",
    "x20": "\x20",
    "x7f": "\x7f",
}
STORABLE_BOUNDARY_SUBJECTS = {"255-chars": "s" * 255, "x21": "\x21", "x7e": "\x7e"}


def identity_reads(reader, verified, refusal):
    statements = []

    def record(execute, statement, params, many, context):
        statements.append(str(statement))
        return execute(statement, params, many, context)

    with connection.execute_wrapper(record), pytest.raises(refusal):
        reader(verified=verified)
    return [statement for statement in statements if "identity_identity" in statement]


@pytest.mark.parametrize("case", sorted(UNSTORABLE_SUBJECTS))
def test_unstorable_subject_is_not_found_before_any_identity_read(world, case):
    # Without the shared guard a NUL raises a driver DataError, and the other
    # shapes reach the identity table; either fails this assertion.
    verified = dataclasses.replace(world.verified, subject=UNSTORABLE_SUBJECTS[case])
    assert (
        identity_reads(
            authority.resolve_member_authority, verified, authority.MemberAuthorityNotFoundError
        )
        == []
    )


@pytest.mark.parametrize("case", sorted(STORABLE_BOUNDARY_SUBJECTS))
def test_storable_boundary_subject_still_reaches_the_identity_read(world, case):
    verified = dataclasses.replace(world.verified, subject=STORABLE_BOUNDARY_SUBJECTS[case])
    assert identity_reads(
        authority.resolve_member_authority, verified, authority.MemberAuthorityNotFoundError
    ), "an over-strict guard refused a subject the database can store"


def test_same_subject_other_issuer_is_not_the_same_actor(world):
    org, _, owners = anchor(world.models, slug="bravo")
    other = identity(world.models, org, owners[0].user, subject=world.principal.subject)
    token = dataclasses.replace(world.verified, issuer=org.issuer)
    first = authority.resolve_member_authority(verified=world.verified)
    second = authority.resolve_member_authority(verified=token)
    assert (second.identity_id, second.user_id, second.organisation_id) == (
        other.pk,
        owners[0].user_id,
        org.pk,
    )
    assert first.membership_id != second.membership_id


def test_public_reader_refuses_ambient_transaction(world):
    with transaction.atomic(), pytest.raises(RuntimeError, match="own transaction"):
        authority.resolve_member_authority(verified=world.verified)


@pytest.mark.parametrize("transaction_started", [False, True])
def test_public_reader_refuses_manual_transaction_without_touching_it(world, transaction_started):
    assert connection.get_autocommit() and not connection.in_atomic_block
    attempts = []

    def refuse_query(execute, sql, params, many, context):
        attempts.append(sql)
        raise AssertionError("public reader entered the caller transaction")

    connection.set_autocommit(False)
    try:
        if transaction_started:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
        before = (
            connection.connection.info.transaction_status,
            tuple(connection.savepoint_ids),
            connection.needs_rollback,
        )
        with (
            connection.execute_wrapper(refuse_query),
            pytest.raises(RuntimeError, match="own transaction"),
        ):
            authority.resolve_member_authority(verified=world.verified)
        assert attempts == []
        assert not connection.get_autocommit() and not connection.in_atomic_block
        assert (
            connection.connection.info.transaction_status,
            tuple(connection.savepoint_ids),
            connection.needs_rollback,
        ) == before
    finally:
        try:
            connection.rollback()
        finally:
            connection.set_autocommit(True)


def test_internal_reader_requires_qualified_transaction(world):
    with pytest.raises(RuntimeError, match="snapshot"):
        authority.read_member_authority_in_snapshot(verified=world.verified)
    with transaction.atomic(), pytest.raises(RuntimeError, match="snapshot"):
        authority.read_member_authority_in_snapshot(verified=world.verified)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        assert (
            authority.read_member_authority_in_snapshot(verified=world.verified).membership_id
            == world.member.pk
        )


@pytest.mark.parametrize(
    "mode",
    [
        "REPEATABLE READ READ WRITE",
        "SERIALIZABLE READ ONLY",
        "READ COMMITTED READ ONLY",
    ],
)
def test_internal_reader_refuses_every_other_transaction_mode(world, mode):
    # Isolation alone is not the contract: a writable repeatable-read snapshot can
    # take row locks and write, so it is refused like a weaker isolation level.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(f"SET TRANSACTION ISOLATION LEVEL {mode}")
        with pytest.raises(RuntimeError, match="snapshot"):
            authority.read_member_authority_in_snapshot(verified=world.verified)


@contextmanager
def source_mutant(change):
    source = Path(authority.__file__).read_text()
    tree = ast.parse(source)
    changes = 0

    class Mutator(ast.NodeTransformer):
        def visit_Call(self, node):
            nonlocal changes
            node = self.generic_visit(node)
            if (
                change == "grant"
                and isinstance(node.func, ast.Name)
                and node.func.id == "has_current_read_grant"
            ):
                changes += 1
                return ast.copy_location(ast.Constant(True), node)
            return node

        def visit_Constant(self, node):
            nonlocal changes
            if change == "isolation" and node.value == "REPEATABLE READ":
                changes += 1
                return ast.copy_location(ast.Constant("READ COMMITTED"), node)
            return node

    tree = ast.fix_missing_locations(Mutator().visit(tree))
    assert changes == 1, "mutant must change exactly one intended source node"
    name = "apps.orgs._authority_acceptance_mutant"
    module = types.ModuleType(name)
    module.__package__ = "apps.orgs"
    previous = sys.modules.get(name)
    sys.modules[name] = module
    try:
        # The only input is inspected local production source with one counted AST change.
        exec(compile(tree, authority.__file__, "exec"), module.__dict__)  # noqa: S102
        yield module
    finally:
        if previous is None:
            del sys.modules[name]
        else:
            sys.modules[name] = previous


def test_current_membership_check_mutant_is_distinguished(world):
    # Keep the organisation eligible while removing this member.
    owner = world.models.User.objects.create(email="other-owner@customer.test")
    world.models.Membership.objects.create(
        user=owner,
        organisation=world.org,
        role="org_owner",
        state="active",
        accepted_at=world.member.accepted_at,
    )
    world.models.Membership.objects.filter(pk=world.member.pk).update(state="removed")
    with pytest.raises(authority.MemberAuthorityNotFoundError):
        authority.resolve_member_authority(verified=world.verified)
    with source_mutant("grant") as mutant:
        assert (
            mutant.resolve_member_authority(verified=world.verified).membership_id
            == world.member.pk
        )
    with pytest.raises(authority.MemberAuthorityNotFoundError):
        authority.resolve_member_authority(verified=world.verified)


def interleaved_read(world, reader):
    revision = stored_revision(world)
    observed = []
    with session() as writer:

        def interleave(execute, statement, params, many, context):
            result = execute(statement, params, many, context)
            if not observed and 'FROM "identity_identity"' in str(statement):
                observed.append(True)
                writer.execute("BEGIN")
                writer.execute(
                    "UPDATE identity_user SET enabled=false WHERE id=%s", [world.user.pk]
                )
                writer.execute("COMMIT")
            return result

        with connection.execute_wrapper(interleave):
            facts = reader(verified=world.verified)
    assert observed == [True], "actual identity SELECT did not acquire the tested snapshot"
    assert facts.authority_revision == revision, "mixed-authority-snapshot"
    return facts


def test_reader_snapshot_and_next_call_refusal(world):
    assert (
        interleaved_read(world, authority.resolve_member_authority).identity_id
        == world.principal.pk
    )
    assert stored_revision(world) > 0
    with pytest.raises(authority.MemberAuthorityNotFoundError):
        authority.resolve_member_authority(verified=world.verified)


def test_weakened_reader_snapshot_is_distinguished(world):
    with source_mutant("isolation") as mutant:
        with pytest.raises(AssertionError, match="mixed-authority-snapshot"):
            interleaved_read(world, mutant.resolve_member_authority)

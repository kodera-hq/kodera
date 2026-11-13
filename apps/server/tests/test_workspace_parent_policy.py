"""Parent-policy store and reader against the real database, run in the normal suite.

Catalogue and migration round trips, real second-connection snapshot and revision races,
unstorable-subject refusal, and isolated source and trigger mutants that prove each probe fails.
"""

import ast
import hashlib
import importlib
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, fields, replace
from pathlib import Path
from types import ModuleType, SimpleNamespace
from uuid import UUID

import pytest
from django.apps import apps
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from test_customer_persistence_concurrency import session
from test_customer_persistence_models import anchor, anchor_models, identity, named_refusal
from test_workspace_metadata_schema import schema_objects

from core.db.ids import new_uuid7
from services.identity.access_tokens import VerifiedAccessToken

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def world():
    assert connection.vendor == "postgresql" and connection.pg_version // 10000 == 16
    service = importlib.import_module("apps.workspaces.policy_selectors")
    models = anchor_models()
    first, _, _ = anchor(models, slug="alpha")
    second, _, _ = anchor(models, slug="bravo")
    people = []
    for org in (first, second):
        user = models.User.objects.create(email="synthetic@customer.test")
        principal = identity(models, org, user, subject="same-subject")
        member = models.Membership.objects.create(
            user=user,
            organisation=org,
            role="org_member",
            state="active",
            accepted_at=timezone.now(),
        )
        # This internal-service test starts after token verification. It does not
        # claim a new token verifier or any HTTP/signature acceptance result.
        now = int(timezone.now().timestamp())
        verified = VerifiedAccessToken(
            issuer=org.issuer,
            subject=principal.subject,
            audience=("kodera-server",),
            issued_at=now,
            expires_at=now + 300,
            not_before=None,
            amr=None,
            acr=None,
            auth_time=None,
        )
        people.append(
            SimpleNamespace(user=user, identity=principal, member=member, verified=verified)
        )

    def model(name):
        return apps.get_model("workspaces", name)

    # These local aliases are model classes, matching the fixture's public fields.
    Workspace, Category, Channel = (model(name) for name in ("Workspace", "Category", "Channel"))  # noqa: N806
    Policy, Rule = (model(name) for name in ("ResourcePolicy", "ResourcePolicyRule"))  # noqa: N806
    workspace = Workspace.objects.create(organisation=first)
    other_workspace = Workspace.objects.create(organisation=second)
    default = Policy.objects.create(workspace=workspace)
    Workspace.objects.filter(pk=workspace.pk).update(default_policy=default)
    group = Category.objects.create(workspace=workspace, name="General", position=0)
    channel = Channel.objects.create(
        workspace=workspace,
        category=group,
        name="History",
        kind="text",
        position=0,
    )
    return SimpleNamespace(
        service=service,
        models=models,
        Workspace=Workspace,
        Category=Category,
        Channel=Channel,
        Policy=Policy,
        Rule=Rule,
        first=first,
        second=second,
        actor=people[0],
        other=people[1],
        workspace=workspace,
        other_workspace=other_workspace,
        default=default,
        group=group,
        channel=channel,
    )


def resolve(world, **changes):
    values = {"verified": world.actor.verified, "channel_id": world.channel.pk}
    values.update(changes)
    return world.service.resolve_parent_policy(**values)


def test_persisted_default_and_closed_initial_lifecycle(world):
    connection.close()
    facts = resolve(world)
    assert facts.policy_id == world.default.pk and facts.selected_from == "workspace"
    assert facts.lifecycle == "provisioning" and facts.visibility == "restricted"
    assert facts.allow_members == facts.deny_members == facts.denied == ()
    assert facts.membership_id == world.actor.member.pk
    assert {field.name for field in fields(facts)} == {
        "organisation_id",
        "workspace_id",
        "channel_id",
        "membership_id",
        "kind",
        "lifecycle",
        "policy_id",
        "policy_revision",
        "selected_from",
        "visibility",
        "allow_members",
        "deny_members",
        "denied",
        "binding_fingerprint",
    }
    assert not hasattr(facts, "allowed") and not hasattr(facts, "authority_revision")


def test_category_then_channel_replacement_never_merges_defaults(world):
    world.Rule.objects.create(policy=world.default, kind="deny_capability", capability="file.read")
    category_policy = world.Policy.objects.create(workspace=world.workspace)
    world.Category.objects.filter(pk=world.group.pk).update(default_policy=category_policy)
    facts = resolve(world)
    assert facts.policy_id == category_policy.pk and facts.selected_from == "category"
    assert facts.denied == ()
    explicit = world.Policy.objects.create(workspace=world.workspace)
    world.Rule.objects.create(policy=explicit, kind="deny_capability", capability="channel.history")
    world.Channel.objects.filter(pk=world.channel.pk).update(
        policy_mode="explicit",
        explicit_policy=explicit,
    )
    facts = resolve(world)
    assert facts.policy_id == explicit.pk and facts.selected_from == "channel"
    assert facts.denied == ("channel.history",)
    world.Channel.objects.filter(pk=world.channel.pk).update(
        policy_mode="inherit",
        explicit_policy=None,
        category=None,
    )
    fallback = resolve(world)
    assert fallback.policy_id == world.default.pk and fallback.selected_from == "workspace"
    assert fallback.denied == ("file.read",)


def test_same_subject_other_issuer_cannot_resolve_foreign_channel(world):
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world, verified=world.other.verified)


def test_committed_membership_removal_is_observed_on_next_call(world):
    resolve(world)
    world.models.Membership.objects.filter(pk=world.actor.member.pk).update(state="removed")
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world)


def test_disabled_identity_and_suspended_organisation_refuse(world):
    world.models.Identity.objects.filter(pk=world.actor.identity.pk).update(enabled=False)
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world)
    world.models.Identity.objects.filter(pk=world.actor.identity.pk).update(enabled=True)
    world.models.Organisation.objects.filter(pk=world.first.pk).update(state="suspended")
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world)


def test_allow_and_deny_are_preserved_without_owner_bypass(world):
    world.models.Membership.objects.filter(pk=world.actor.member.pk).update(role="org_admin")
    for kind in ("allow_member", "deny_member"):
        world.Rule.objects.create(policy=world.default, kind=kind, membership=world.actor.member)
    facts = resolve(world)
    assert facts.allow_members == facts.deny_members == (world.actor.member.pk,)
    assert not hasattr(facts, "allowed")


def test_foreign_rule_and_foreign_policy_binding_refuse_in_database(world):
    with named_refusal("23514", "policy_rule_scope_valid"):
        world.Rule.objects.create(
            policy=world.default,
            kind="allow_member",
            membership=world.other.member,
        )
    foreign = world.Policy.objects.create(workspace=world.other_workspace)
    for model, row, changes, name in (
        (
            world.Workspace,
            world.workspace,
            {"default_policy": foreign},
            "workspace_default_policy_scope_valid",
        ),
        (
            world.Category,
            world.group,
            {"default_policy": foreign},
            "category_default_policy_scope_valid",
        ),
        (
            world.Channel,
            world.channel,
            {"policy_mode": "explicit", "explicit_policy": foreign},
            "channel_explicit_policy_scope_valid",
        ),
    ):
        with named_refusal("23514", name):
            model.objects.filter(pk=row.pk).update(**changes)


def test_rule_shapes_and_duplicates_cannot_make_partial_grants(world):
    with named_refusal("23514", "policy_rule_shape_valid"):
        world.Rule.objects.create(policy=world.default, kind="allow_member")
    with named_refusal("23514", "policy_rule_shape_valid"):
        world.Rule.objects.create(
            policy=world.default, kind="deny_capability", capability="unknown"
        )
    world.Rule.objects.create(policy=world.default, kind="deny_capability", capability="file.read")
    with named_refusal("23505", "policy_rule_capability_unique"):
        world.Rule.objects.create(
            policy=world.default, kind="deny_capability", capability="file.read"
        )


def test_rules_advance_revision_and_rollback_restores_both(world):
    before = resolve(world)
    rule = world.Rule.objects.create(
        policy=world.default, kind="deny_capability", capability="file.read"
    )
    after = resolve(world)
    assert after.policy_revision > before.policy_revision and after.denied == ("file.read",)

    class RollbackError(Exception):
        pass

    with pytest.raises(RollbackError):
        with transaction.atomic():
            world.Rule.objects.filter(pk=rule.pk).update(capability="channel.history")
            raise RollbackError
    restored = resolve(world)
    assert restored.policy_revision == after.policy_revision and restored.denied == after.denied
    rule.delete()
    removed = resolve(world)
    assert removed.policy_revision > after.policy_revision and removed.denied == ()


def test_current_lifecycle_and_missing_policy_are_not_ready(world):
    for state in ("provisioning", "active", "archived", "deletion_pending", "deleted"):
        world.Channel.objects.filter(pk=world.channel.pk).update(lifecycle=state)
        assert resolve(world).lifecycle == state
    world.Workspace.objects.filter(pk=world.workspace.pk).update(default_policy=None)
    with pytest.raises(world.service.ParentPolicyUnavailableError):
        resolve(world)


UNSTORABLE_SUBJECTS = {
    "nul": "same\x00subject",
    "non-ascii": "same-subjecté",
    "256-chars": "s" * 256,
    "empty": "",
    "space": "same subject",
    "x20": "\x20",
    "x7f": "\x7f",
}
STORABLE_BOUNDARY_SUBJECTS = {"255-chars": "s" * 255, "x21": "\x21", "x7e": "\x7e"}


def identity_reads(world, subject):
    statements = []

    def record(execute, statement, params, many, context):
        statements.append(str(statement))
        return execute(statement, params, many, context)

    verified = replace(world.actor.verified, subject=subject)
    with (
        connection.execute_wrapper(record),
        pytest.raises(world.service.ParentPolicyNotFoundError),
    ):
        resolve(world, verified=verified)
    return [statement for statement in statements if "identity_identity" in statement]


@pytest.mark.parametrize("case", sorted(UNSTORABLE_SUBJECTS))
def test_unstorable_subject_is_not_found_before_any_identity_read(world, case):
    # Without the shared guard a NUL raises a driver DataError, and the other
    # shapes reach the identity table; either fails this assertion.
    assert identity_reads(world, UNSTORABLE_SUBJECTS[case]) == []


@pytest.mark.parametrize("case", sorted(STORABLE_BOUNDARY_SUBJECTS))
def test_storable_boundary_subject_still_reaches_the_identity_read(world, case):
    assert identity_reads(world, STORABLE_BOUNDARY_SUBJECTS[case]), (
        "an over-strict guard refused a subject the database can store"
    )


def test_reader_refuses_an_ambient_transaction(world):
    with transaction.atomic(), pytest.raises(RuntimeError):
        resolve(world)


POLICY_TABLE = "workspaces_resourcepolicy"
RULE_TABLE = "workspaces_resourcepolicyrule"
MAX_REVISION = 9223372036854775807
NEW_CONSTRAINTS = {
    POLICY_TABLE: {
        "workspaces_resourcepolicy_pkey": "p",
        "policy_workspace_fk": "f",
        "policy_revision_valid": "c",
        "policy_visibility_valid": "c",
    },
    RULE_TABLE: {
        "workspaces_resourcepolicyrule_pkey": "p",
        "policy_rule_policy_fk": "f",
        "policy_rule_membership_fk": "f",
        "policy_rule_shape_valid": "c",
    },
}
NEW_FOREIGN_KEYS = {
    (
        POLICY_TABLE,
        "policy_workspace_fk",
    ): "FOREIGN KEY (workspace_id) REFERENCES workspaces_workspace(id) ON DELETE RESTRICT",
    (
        RULE_TABLE,
        "policy_rule_policy_fk",
    ): "FOREIGN KEY (policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT",
    (
        RULE_TABLE,
        "policy_rule_membership_fk",
    ): "FOREIGN KEY (membership_id) REFERENCES orgs_membership(id) ON DELETE RESTRICT",
    (
        "workspaces_workspace",
        "workspace_default_policy_fk",
    ): "FOREIGN KEY (default_policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT",
    (
        "workspaces_category",
        "category_default_policy_fk",
    ): "FOREIGN KEY (default_policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT",
    (
        "workspaces_channel",
        "channel_explicit_policy_fk",
    ): "FOREIGN KEY (explicit_policy_id) REFERENCES workspaces_resourcepolicy(id) ON DELETE RESTRICT",
}
# Exact table, trigger, function and pg_trigger event/timing bits. All row-level,
# enabled, nondeferrable and zero-argument; rules serialize after successful DML.
NEW_TRIGGERS = {
    (POLICY_TABLE, "workspace_policy_guard"): ("workspace_policy_guard", 27),
    (RULE_TABLE, "workspace_policy_rule_binding"): ("workspace_policy_rule_binding", 19),
    (RULE_TABLE, "workspace_policy_rule_scope"): ("workspace_policy_rule_scope", 23),
    (RULE_TABLE, "workspace_policy_rule_revision"): ("workspace_policy_rule_revision", 29),
    ("workspaces_workspace", "workspace_policy_workspace_scope"): (
        "workspace_policy_binding_scope",
        23,
    ),
    ("workspaces_category", "workspace_policy_category_scope"): (
        "workspace_policy_binding_scope",
        23,
    ),
    ("workspaces_channel", "workspace_policy_channel_scope"): (
        "workspace_policy_binding_scope",
        23,
    ),
}
NEW_FUNCTIONS = {value[0] for value in NEW_TRIGGERS.values()}


def catalog_contract():
    objects = schema_objects()
    for table, expected in {
        POLICY_TABLE: {"id", "created_at", "updated_at", "workspace_id", "revision", "visibility"},
        RULE_TABLE: {
            "id",
            "created_at",
            "updated_at",
            "policy_id",
            "kind",
            "membership_id",
            "capability",
        },
    }.items():
        assert {key[2] for key in objects if key[:2] == ("column", table)} == expected
    for table, expected in NEW_CONSTRAINTS.items():
        assert {
            key[2]: value[0] for key, value in objects.items() if key[:2] == ("constraint", table)
        } == expected
    for (table, name), definition in NEW_FOREIGN_KEYS.items():
        value = objects[("constraint", table, name)]
        assert value == ("f", definition, False, False, True)
    unique = {
        key[2]: value[0]
        for key, value in objects.items()
        if key[:2] == ("index", RULE_TABLE) and value[3]
    }
    assert set(unique) == {
        "workspaces_resourcepolicyrule_pkey",
        "policy_rule_member_unique",
        "policy_rule_capability_unique",
    }
    for suffix, column in (("member", "membership_id"), ("capability", "capability")):
        name = f"policy_rule_{suffix}_unique"
        assert unique[name] == (
            f"CREATE UNIQUE INDEX {name} ON public.{RULE_TABLE} USING btree "
            f"(policy_id, kind, {column}) WHERE ({column} IS NOT NULL)"
        )
    with connection.cursor() as cursor:
        cursor.execute("""
            SELECT c.relname,t.tgname,p.proname,t.tgtype,t.tgenabled,t.tgdeferrable,
                   t.tginitdeferred,t.tgnargs,t.tgargs,pg_get_triggerdef(t.oid)
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
            WHERE n.nspname=current_schema() AND NOT t.tgisinternal
              AND t.tgname LIKE 'workspace_policy_%'
        """)
        triggers = cursor.fetchall()
        assert {(row[0], row[1]) for row in triggers} == set(NEW_TRIGGERS)
        for (
            table,
            name,
            function,
            bits,
            enabled,
            deferred,
            initial,
            nargs,
            args,
            definition,
        ) in triggers:
            assert (function, bits) == NEW_TRIGGERS[(table, name)]
            assert (enabled, deferred, initial, nargs, bytes(args)) == ("O", False, False, 0, b"")
            assert f"EXECUTE FUNCTION {function}()" in definition
        cursor.execute("""
            SELECT p.proname,pg_get_function_identity_arguments(p.oid),
                   pg_get_function_result(p.oid),l.lanname,p.provolatile,p.prosecdef,
                   p.proleakproof,p.proparallel,p.prosrc,pg_get_functiondef(p.oid)
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            JOIN pg_language l ON l.oid=p.prolang
            WHERE n.nspname=current_schema() AND p.proname LIKE 'workspace_policy_%'
        """)
        functions = cursor.fetchall()
        assert {row[0] for row in functions} == NEW_FUNCTIONS
        for (
            name,  # noqa: B007 - the complete function-name set is asserted above
            args,
            result,
            language,
            volatility,
            definer,
            leakproof,
            parallel,
            body,
            definition,
        ) in functions:
            assert (args, result, language, volatility, definer, leakproof, parallel) == (
                "",
                "trigger",
                "plpgsql",
                "v",
                False,
                False,
                "u",
            )
            assert body.strip() and body in definition
    return objects


def test_complete_policy_object_inventory_and_model_migration_state(world, record_property):
    from django.core.management import call_command

    call_command("makemigrations", "workspaces", check=True, dry_run=True, verbosity=0)
    objects = catalog_contract()
    # Preserve full definitions for review, not only object names or catalog counts.
    record_property("policy_definitions", repr(sorted(objects.items())))
    for model, names in (
        (world.Policy, ("workspace",)),
        (world.Rule, ("policy", "membership")),
        (world.Workspace, ("default_policy",)),
        (world.Category, ("default_policy",)),
        (world.Channel, ("explicit_policy",)),
    ):
        for name in names:
            field = model._meta.get_field(name)
            assert not field.db_constraint and not field.unique


def test_all_policy_scalar_checks_and_rule_targets(world):
    from services.workspace_policy.projection import _CAPABILITIES

    for capability in sorted(_CAPABILITIES):
        world.Rule.objects.create(
            policy=world.default, kind="deny_capability", capability=capability
        )
    assert resolve(world).denied == tuple(sorted(_CAPABILITIES))
    for changes, name in (
        ({"revision": 0}, "policy_revision_valid"),
        ({"visibility": "private"}, "policy_visibility_valid"),
    ):
        with named_refusal("23514", name):
            world.Policy.objects.create(workspace=world.workspace, **changes)
    for changes in (
        {"kind": "unknown"},
        {"kind": "allow_member"},
        {"kind": "allow_member", "membership": world.actor.member, "capability": "file.read"},
        {"kind": "deny_capability"},
        {"kind": "deny_capability", "capability": "unknown"},
        {"kind": "deny_capability", "capability": "file.read", "membership": world.actor.member},
    ):
        with named_refusal("23514", "policy_rule_shape_valid"):
            world.Rule.objects.create(policy=world.default, **changes)
    world.Rule.objects.create(
        policy=world.default, kind="allow_member", membership=world.actor.member
    )
    with named_refusal("23505", "policy_rule_member_unique"):
        world.Rule.objects.create(
            policy=world.default, kind="allow_member", membership=world.actor.member
        )
    for changes, name in (
        ({"policy_mode": "unknown"}, "channel_policy_mode_valid"),
        ({"policy_mode": "explicit", "explicit_policy": None}, "channel_policy_mode_valid"),
        ({"policy_mode": "inherit", "explicit_policy": world.default}, "channel_policy_mode_valid"),
        ({"lifecycle": "unknown"}, "channel_lifecycle_valid"),
    ):
        with named_refusal("23514", name):
            world.Channel.objects.filter(pk=world.channel.pk).update(**changes)


def test_all_new_foreign_keys_refuse_missing_targets(world):
    cases = [
        (lambda: world.Policy.objects.create(workspace_id=new_uuid7()), "policy_workspace_fk"),
        (
            lambda: world.Rule.objects.create(
                policy_id=new_uuid7(), kind="deny_capability", capability="file.read"
            ),
            "policy_rule_policy_fk",
        ),
        (
            lambda: world.Rule.objects.create(
                policy=world.default, kind="allow_member", membership_id=new_uuid7()
            ),
            "policy_rule_membership_fk",
        ),
        (
            lambda: world.Workspace.objects.filter(pk=world.workspace.pk).update(
                default_policy_id=new_uuid7()
            ),
            "workspace_default_policy_fk",
        ),
        (
            lambda: world.Category.objects.filter(pk=world.group.pk).update(
                default_policy_id=new_uuid7()
            ),
            "category_default_policy_fk",
        ),
        (
            lambda: world.Channel.objects.filter(pk=world.channel.pk).update(
                policy_mode="explicit", explicit_policy_id=new_uuid7()
            ),
            "channel_explicit_policy_fk",
        ),
    ]
    for action, name in cases:
        with named_refusal("23503", name):
            action()


def test_policy_and_rule_binding_immutability_and_policy_delete_refusal(world):
    alternate = world.Policy.objects.create(workspace=world.workspace)
    rule = world.Rule.objects.create(
        policy=world.default, kind="deny_capability", capability="file.read"
    )
    for row, changes, name in (
        (world.default, {"id": new_uuid7()}, "policy_binding_immutable"),
        (world.default, {"workspace": world.other_workspace}, "policy_binding_immutable"),
        (rule, {"id": new_uuid7()}, "policy_rule_binding_immutable"),
        (rule, {"policy": alternate}, "policy_rule_binding_immutable"),
    ):
        with named_refusal("23514", name):
            type(row).objects.filter(pk=row.pk).update(**changes)
    with named_refusal("23514", "policy_delete_refused"):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM workspaces_resourcepolicy WHERE id=%s", [alternate.pk])
    with named_refusal("23503", "policy_workspace_fk"):
        # Remove the original channel/category objects only in the separate workspace.
        world.Policy.objects.create(workspace=world.other_workspace)
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM workspaces_workspace WHERE id=%s", [world.other_workspace.pk]
            )
    member_rule = world.Rule.objects.create(
        policy=world.default, kind="allow_member", membership=world.actor.member
    )
    with named_refusal("23514", "policy_rule_scope_valid"):
        world.Rule.objects.filter(pk=member_rule.pk).update(membership=world.other.member)
    with named_refusal("23503", "policy_rule_membership_fk"):
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM orgs_membership WHERE id=%s", [world.actor.member.pk])


def test_revision_ignores_caller_value_and_overflow_rolls_back_rule(world):
    previous = resolve(world).policy_revision
    world.Policy.objects.filter(pk=world.default.pk).update(revision=0)
    world.default.refresh_from_db()
    assert world.default.revision == previous + 1

    class RestoreError(Exception):
        pass

    with pytest.raises(RestoreError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "ALTER TABLE workspaces_resourcepolicy DISABLE TRIGGER workspace_policy_guard"
                )
                cursor.execute(
                    "UPDATE workspaces_resourcepolicy SET revision=%s WHERE id=%s",
                    [MAX_REVISION, world.default.pk],
                )
                cursor.execute(
                    "ALTER TABLE workspaces_resourcepolicy ENABLE TRIGGER workspace_policy_guard"
                )
            with named_refusal("23514", "policy_revision_exhausted"):
                world.Rule.objects.create(
                    policy=world.default, kind="deny_capability", capability="file.read"
                )
            with named_refusal("23514", "policy_revision_exhausted"):
                world.Policy.objects.filter(pk=world.default.pk).update(visibility="organisation")
            assert not world.Rule.objects.filter(policy=world.default).exists()
            raise RestoreError
    world.default.refresh_from_db()
    assert world.default.revision == previous + 1


def test_scope_trigger_mutant_admits_foreign_row_then_transaction_restores(world):
    before = resolve(world).policy_revision

    class RestoreError(Exception):
        pass

    with pytest.raises(RestoreError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "DROP TRIGGER workspace_policy_rule_scope ON workspaces_resourcepolicyrule"
                )
            wrong = world.Rule.objects.create(
                policy=world.default, kind="allow_member", membership=world.other.member
            )
            assert wrong.membership.organisation_id != wrong.policy.workspace.organisation_id
            raise RestoreError
    with named_refusal("23514", "policy_rule_scope_valid"):
        world.Rule.objects.create(
            policy=world.default, kind="allow_member", membership=world.other.member
        )
    assert resolve(world).policy_revision == before
    assert not world.Rule.objects.filter(policy=world.default).exists()


def insert_rule(client, world, capability):
    return client.execute(
        "INSERT INTO workspaces_resourcepolicyrule "
        "(id,created_at,updated_at,policy_id,kind,membership_id,capability) "
        "VALUES (%s,now(),now(),%s,'deny_capability',NULL,%s) RETURNING id",
        [new_uuid7(), world.default.pk, capability],
    ).fetchone()[0]


@pytest.mark.parametrize("rollback_first", [False, True])
def test_two_connections_serialize_rule_revision_with_real_lock_barrier(world, rollback_first):
    before = resolve(world).policy_revision
    result = {}
    thread = None

    class RollbackError(Exception):
        pass

    with session() as second:
        second.execute("SET statement_timeout='8s'")
        second.execute("SET lock_timeout='6s'")
        try:
            try:
                with transaction.atomic():
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT pg_backend_pid()")
                        first_pid = cursor.fetchone()[0]
                    assert first_pid != second.info.backend_pid
                    world.Rule.objects.create(
                        policy=world.default, kind="deny_capability", capability="file.read"
                    )

                    def contender():
                        try:
                            with second.transaction():
                                result["id"] = insert_rule(second, world, "channel.history")
                            result["outcome"] = "committed"
                        except BaseException as error:
                            result.update(outcome="failed", error=repr(error))

                    thread = threading.Thread(target=contender)
                    thread.start()
                    limit = time.monotonic() + 3
                    blocked = False
                    while time.monotonic() < limit:
                        with connection.cursor() as cursor:
                            cursor.execute("SELECT pg_blocking_pids(%s)", [second.info.backend_pid])
                            blocked = first_pid in cursor.fetchone()[0]
                        if blocked:
                            break
                        assert thread.is_alive(), result
                        time.sleep(0.02)
                    assert blocked, (
                        "second rule write did not reach the actual first-transaction lock"
                    )
                    if rollback_first:
                        raise RollbackError
            except RollbackError:
                assert rollback_first
            thread.join(9)
            assert not thread.is_alive() and result.get("outcome") == "committed", result
        finally:
            # The outer Django transaction has committed/rolled back before join.
            if thread is not None and thread.is_alive():
                second.cancel()
                thread.join(3)
            assert thread is None or not thread.is_alive(), "owned worker survived cancellation"
    facts = resolve(world)
    assert facts.denied == (
        ("channel.history",) if rollback_first else ("channel.history", "file.read")
    )
    assert facts.policy_revision == before + (1 if rollback_first else 2)


def interleaved_snapshot(world, resolver, *, remove_member):
    replacement = world.Policy.objects.create(workspace=world.workspace, visibility="organisation")
    world.Rule.objects.create(policy=replacement, kind="deny_capability", capability="file.read")
    old = resolve(world)
    seen = {}
    with session() as writer:
        writer.execute("SET statement_timeout='8s'")
        writer.execute("SET lock_timeout='6s'")

        def interleave(execute, statement, params, many, context):
            text = str(statement).lower()
            assert not (
                not seen and text.lstrip().startswith("select") and "workspaces_" in text
            ), "policy reads must follow the current membership snapshot"
            result = execute(statement, params, many, context)
            if not seen and text.lstrip().startswith("select") and "orgs_membership" in text:
                seen["membership_select_completed"] = True
                with connection.cursor() as cursor:
                    cursor.execute("SHOW transaction_isolation")
                    seen["isolation"] = cursor.fetchone()[0]
                    cursor.execute("SHOW transaction_read_only")
                    seen["read_only"] = cursor.fetchone()[0]
                    cursor.execute("SELECT pg_backend_pid()")
                    assert cursor.fetchone()[0] != writer.info.backend_pid
                with writer.transaction():
                    writer.execute(
                        "UPDATE workspaces_workspace SET default_policy_id=%s WHERE id=%s",
                        [replacement.pk, world.workspace.pk],
                    )
                    if remove_member:
                        writer.execute(
                            "UPDATE orgs_membership SET state='removed' WHERE id=%s",
                            [world.actor.member.pk],
                        )
                seen["writer_committed"] = True
            return result

        with connection.execute_wrapper(interleave):
            try:
                first = resolver(verified=world.actor.verified, channel_id=world.channel.pk)
            except (
                world.service.ParentPolicyNotFoundError,
                world.service.ParentPolicyUnavailableError,
            ):
                first = None
    assert seen.get("writer_committed"), "interleave hook never reached a real membership read"

    def values(facts):
        return tuple(getattr(facts, field.name) for field in fields(facts))

    assert first is None or values(first) == values(old), (
        "reader mixed pre-commit membership with a new policy cut"
    )
    assert seen["isolation"] == "repeatable read", "snapshot isolation must stay REPEATABLE READ"
    assert seen["read_only"] == "on"
    assert not connection.in_atomic_block and connection.get_autocommit()
    if remove_member:
        with pytest.raises(world.service.ParentPolicyNotFoundError):
            resolver(verified=world.actor.verified, channel_id=world.channel.pk)
    else:
        fresh = resolver(verified=world.actor.verified, channel_id=world.channel.pk)
        assert fresh.policy_id == replacement.pk and fresh.denied == ("file.read",)
        assert fresh.binding_fingerprint != old.binding_fingerprint


@pytest.mark.parametrize("remove_member", [False, True])
def test_real_second_connection_commit_cannot_mix_snapshot_and_next_call_is_fresh(
    world, remove_member
):
    interleaved_snapshot(world, world.service.resolve_parent_policy, remove_member=remove_member)


@contextmanager
def reader_mutant(world, change):
    path = Path(world.service.__file__)
    original = path.read_bytes()
    tree = ast.parse(original)
    hits = []

    class Mutate(ast.NodeTransformer):
        def visit_Call(self, node):
            node = self.generic_visit(node)
            if (
                change == "membership"
                and isinstance(node.func, ast.Name)
                and node.func.id == "has_current_read_grant"
            ):
                hits.append("membership")
                return ast.copy_location(ast.Constant(True), node)
            return node

        def visit_Constant(self, node):
            if (
                change == "isolation"
                and node.value == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
            ):
                hits.append("isolation")
                return ast.copy_location(
                    ast.Constant("SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY"), node
                )
            return node

    tree = ast.fix_missing_locations(Mutate().visit(tree))
    assert hits == [change], "mutant must weaken exactly one designated source clause"
    name = f"apps.workspaces._acceptance_{change}"
    assert name not in sys.modules
    module = ModuleType(name)
    module.__file__ = str(path)
    module.__package__ = "apps.workspaces"
    sys.modules[name] = module
    try:
        exec(compile(tree, str(path), "exec"), module.__dict__)  # noqa: S102 - isolated local-source mutant
        # Share safe error identities so refusal is observed across isolated modules.
        module.ParentPolicyNotFoundError = world.service.ParentPolicyNotFoundError
        module.ParentPolicyUnavailableError = world.service.ParentPolicyUnavailableError
        yield module.resolve_parent_policy
    finally:
        del sys.modules[name]
        assert path.read_bytes() == original


def any_undeleted_membership_id(world):
    """The pre-predicate lookup: any undeleted row, whatever its state."""

    def lookup(*, user_id, organisation_id):
        return (
            world.models.Membership.objects.filter(
                user_id=user_id, organisation_id=organisation_id, deleted_at__isnull=True
            )
            .values_list("id", flat=True)
            .first()
        )

    return lookup


def test_current_membership_clause_mutant_is_distinguished_by_removed_member(world, monkeypatch):
    world.models.Membership.objects.filter(pk=world.actor.member.pk).update(state="removed")
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world)
    # Each guard is proven alone. The grant alone still refuses a removed member.
    with monkeypatch.context() as patch:
        patch.setattr(world.service, "active_membership_id", any_undeleted_membership_id(world))
        with pytest.raises(world.service.ParentPolicyNotFoundError):
            resolve(world)
    with reader_mutant(world, "membership") as weakened:
        # So does the membership lookup alone, with the grant call removed.
        with pytest.raises(world.service.ParentPolicyNotFoundError):
            weakened(verified=world.actor.verified, channel_id=world.channel.pk)
        # Weakening both admits the removed member: the probe is not vacuous.
        weakened.__globals__["active_membership_id"] = any_undeleted_membership_id(world)
        facts = weakened(verified=world.actor.verified, channel_id=world.channel.pk)
        assert facts.membership_id == world.actor.member.pk
    with pytest.raises(world.service.ParentPolicyNotFoundError):
        resolve(world)


def test_read_committed_source_mutant_fails_snapshot_contract(world):
    with reader_mutant(world, "isolation") as weakened:
        with pytest.raises(
            AssertionError,
            match="reader mixed pre-commit membership with a new policy cut|snapshot isolation must stay REPEATABLE READ",
        ):
            interleaved_snapshot(world, weakened, remove_member=False)
    # Actual source still resolves only current committed data, with a fresh cut.
    assert resolve(world).visibility == "organisation"


def test_facts_are_eager_immutable_and_no_transaction_escapes(world):
    facts = resolve(world)
    assert not connection.in_atomic_block and connection.get_autocommit()

    def no_query(*args, **kwargs):
        raise AssertionError("facts escaped with a lazy database read")

    def scalar_or_tuple(value):
        if type(value) is tuple:
            return all(scalar_or_tuple(item) for item in value)
        return type(value) in (str, int, UUID, type(None))

    with connection.execute_wrapper(no_query):
        assert all(scalar_or_tuple(getattr(facts, field.name)) for field in fields(facts))
        repr(facts)
        with pytest.raises(FrozenInstanceError):
            facts.lifecycle = "active"


POLICY_COLUMNS = {
    ("workspaces_workspace", "default_policy_id"),
    ("workspaces_category", "default_policy_id"),
    ("workspaces_channel", "explicit_policy_id"),
    ("workspaces_channel", "policy_mode"),
    ("workspaces_channel", "lifecycle"),
}
POLICY_BINDING_CHECKS = {
    ("workspaces_channel", "channel_policy_mode_valid"),
    ("workspaces_channel", "channel_lifecycle_valid"),
}


# 0005_template_key, the starter template's row key (PILOT_WORKSPACE_ONBOARDING.md §2).
TEMPLATE_KEY_OBJECTS = {
    ("column", "workspaces_category", "template_key"),
    ("column", "workspaces_channel", "template_key"),
    ("constraint", "workspaces_category", "category_template_key_valid"),
    ("constraint", "workspaces_channel", "channel_template_key_valid"),
    ("index", "workspaces_category", "category_template_key_unique"),
    ("index", "workspaces_channel", "channel_template_key_unique"),
}


def without_template_key(objects):
    assert TEMPLATE_KEY_OBJECTS <= objects.keys(), "the template key objects are not all present"
    return {key: value for key, value in objects.items() if key not in TEMPLATE_KEY_OBJECTS}


# 0006_espace_structure, the structure administration (ESPACE_STRUCTURE.md §§4, 5, 9), and
# 0007_room_state_revision, the channel set's result order (§13.3). Reversals below them
# remove these objects and restore the two position constraints to immediate first.
# Every test restores the current leaf, including the later warm-pool allocation table.
LEAF = "0010_moderation_scope_guards"
WARM_POOL_TABLE = "workspaces_warmpoolallocation"
NOTICE_TABLE = "workspaces_channelnotice"
ESPACE_OBJECTS = {
    ("column", "workspaces_channel", "room_state"),
    ("column", "workspaces_channel", "applied_access_etag"),
    ("constraint", "workspaces_channel", "channel_room_state_valid"),
    ("column", "workspaces_channel", "room_state_revision"),
    ("constraint", "workspaces_channel", "channel_room_state_revision_valid"),
    ("relation", NOTICE_TABLE, NOTICE_TABLE),
    ("constraint", NOTICE_TABLE, "channel_notice_channel_fk"),
    ("constraint", NOTICE_TABLE, "channel_notice_membership_fk"),
    ("index", NOTICE_TABLE, "channel_notice_pending_unique"),
}
DEFERRED_POSITIONS = {
    ("constraint", "workspaces_category", "category_position_unique"),
    ("constraint", "workspaces_channel", "channel_position_unique"),
}
DEFERRED = " DEFERRABLE INITIALLY DEFERRED"


def without_warm_pool(objects):
    """0008 owns only the warm-pool table; retain every unrelated schema object."""
    from workspace_documents.schema_inventory import without_documents
    from workspace_quotas.schema_inventory import without_quotas
    from workspace_safety.schema_inventory import without_moderation

    objects = without_moderation(without_documents(without_quotas(objects)))
    assert ("relation", WARM_POOL_TABLE, WARM_POOL_TABLE) in objects
    assert ("constraint", WARM_POOL_TABLE, "warm_pool_offer_valid") in objects
    return {key: value for key, value in objects.items() if key[1] != WARM_POOL_TABLE}


def without_espace_structure(objects):
    """The schema as 0005 left it: no notice table, no room state, immediate position checks."""
    assert ESPACE_OBJECTS | DEFERRED_POSITIONS <= objects.keys(), (
        "0006 and 0007 are not all present"
    )
    result = {}
    for key, value in objects.items():
        if key in ESPACE_OBJECTS or key[1] == NOTICE_TABLE:
            continue
        if key in DEFERRED_POSITIONS:
            kind, definition, deferrable, deferred, validated = value
            assert (deferrable, deferred) == (True, True) and definition.endswith(DEFERRED)
            value = (kind, definition.removesuffix(DEFERRED), False, False, validated)
        result[key] = value
    return result


def without_policy_integrity(objects):
    return {
        key: value
        for key, value in objects.items()
        if not (
            key[0] == "function"
            and key[1] in NEW_FUNCTIONS
            or key[0] == "trigger"
            and key[1:] in NEW_TRIGGERS
            or key[0] == "constraint"
            and key[1:] in NEW_FOREIGN_KEYS
        )
    }


def metadata_baseline_objects(objects):
    """Remove only the declared new objects; unknown shared changes remain visible."""
    result = without_policy_integrity(
        without_template_key(without_espace_structure(without_warm_pool(objects)))
    )
    expected_indexes = {
        "workspaces_workspace": "default_policy_id",
        "workspaces_category": "default_policy_id",
        "workspaces_channel": "explicit_policy_id",
    }
    filtered = {}
    for key, value in result.items():
        kind, owner, name = key
        if owner in {POLICY_TABLE, RULE_TABLE}:
            continue
        if kind == "column" and (owner, name) in POLICY_COLUMNS:
            continue
        if kind == "constraint" and (owner, name) in POLICY_BINDING_CHECKS:
            continue
        if kind == "index" and owner in expected_indexes:
            wanted = (
                f"CREATE INDEX {name} ON public.{owner} USING btree ({expected_indexes[owner]})"
            )
            if value == (wanted, True, True, False):
                continue
        filtered[key] = value
    return filtered


def test_policy_migrations_reverse_reapply_exact_definitions_and_preserve_metadata(
    world, record_property
):
    from django.core.management import call_command

    call_command("flush", interactive=False, verbosity=0)
    assert not world.Workspace.objects.exists()
    complete = catalog_contract()
    baseline = metadata_baseline_objects(complete)
    try:
        MigrationExecutor(connection).migrate([("workspaces", "0003_policy_state")])
        assert schema_objects() == without_policy_integrity(
            without_template_key(without_espace_structure(without_warm_pool(complete)))
        )
        MigrationExecutor(connection).migrate([("workspaces", "0002_integrity")])
        assert schema_objects() == baseline
        # Full original D05-2 schema behavior stays independently testable at this leaf.
        from test_workspace_metadata_schema import BASE_TABLE_CONSTRAINTS

        for table, expected in BASE_TABLE_CONSTRAINTS.items():
            actual = {
                key[2]: value[0]
                for key, value in baseline.items()
                if key[:2] == ("constraint", table)
            }
            assert actual == expected
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
    assert catalog_contract() == complete
    record_property("policy_migration_definitions", repr(sorted(complete.items())))
    # A new real fixture after reapplication also exercises the restored scope guard.
    models = anchor_models()
    first, _, _ = anchor(models, slug="alpha")
    second, _, members = anchor(models, slug="bravo")
    owner = world.Workspace.objects.create(organisation=first)
    policy = world.Policy.objects.create(workspace=owner)
    with named_refusal("23514", "policy_rule_scope_valid"):
        world.Rule.objects.create(policy=policy, kind="allow_member", membership=members[0])


def test_frozen_final_kernel_source_is_reused_without_a_second_evaluator(world):
    from services.workspace_policy import projection

    assert hashlib.sha256(Path(projection.__file__).read_bytes()).hexdigest() == (
        "47b7d8aede9cd1275df10f8ce5fa9534b45374d94ebf967d5fc5188b025d7e47"
    )

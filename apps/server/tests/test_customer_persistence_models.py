"""Customer anchor integrity against real migrations/PostgreSQL, never an auth stub."""

from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.apps import apps
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from psycopg import sql

from core.db.ids import new_uuid7

MODELS = [
    ("identity", "User"),
    ("identity", "Identity"),
    ("orgs", "Organisation"),
    ("orgs", "Membership"),
    ("orgs", "SlugReservation"),
]


def anchor_models():
    missing = []
    found = {}
    for app, name in MODELS:
        try:
            found[name] = apps.get_model(app, name)
        except LookupError:
            missing.append(f"{app}.{name}")
    assert not missing, "customer anchor models are not registered: " + ", ".join(missing)
    return SimpleNamespace(**found)


def test_customer_anchor_models_are_registered():
    assert len(vars(anchor_models())) == 5


@pytest.fixture
def models(transactional_db):
    assert connection.vendor == "postgresql", "customer migration acceptance requires PostgreSQL"
    return anchor_models()


def anchor(
    models,
    *,
    slug="alpha",
    state="active",
    owners=1,
    reservation=True,
    reservation_state="permanent",
):
    with transaction.atomic():
        organisation = models.Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.customer.test/realms/{slug}",
            name="Synthetic organisation",
            state=state,
        )
        held = None
        if reservation:
            held = models.SlugReservation.objects.create(
                namespace="organisation",
                slug=slug,
                organisation=organisation,
                state=reservation_state,
                protected_at=None if reservation_state == "provisional" else timezone.now(),
            )
        memberships = []
        for index in range(owners):
            user = models.User.objects.create(email=f"owner-{index}@customer.test", enabled=True)
            memberships.append(
                models.Membership.objects.create(
                    user=user,
                    organisation=organisation,
                    role="org_owner",
                    state="active",
                    accepted_at=timezone.now(),
                )
            )
    return organisation, held, memberships


def identity(models, organisation, user, *, subject="Provider-Subject"):
    return models.Identity.objects.create(
        user=user,
        organisation=organisation,
        issuer=organisation.issuer,
        realm=organisation.realm,
        subject=subject,
        email="person@customer.test",
        enabled=True,
    )


@contextmanager
def named_refusal(sqlstate, constraint):
    with pytest.raises(IntegrityError) as error:
        with transaction.atomic():
            yield
    cause = error.value.__cause__
    assert cause.sqlstate == sqlstate
    assert cause.diag.constraint_name == constraint


def test_migrations_match_registered_state(models):
    call_command("makemigrations", "identity", "orgs", check=True, dry_run=True, verbosity=0)
    with connection.cursor() as cursor:
        cursor.execute("SELECT app FROM django_migrations WHERE app IN ('identity','orgs')")
        assert {row[0] for row in cursor.fetchall()} == {"identity", "orgs"}


def test_actual_uuid_columns_defaults_and_utc_timestamps(models):
    organisation, reservation, owners = anchor(models)
    principal = identity(models, organisation, owners[0].user)
    for item in (organisation, reservation, owners[0], owners[0].user, principal):
        item.refresh_from_db()
        assert item.pk.version == 7
        assert item._meta.pk.default is new_uuid7
        assert timezone.is_aware(item.created_at) and timezone.is_aware(item.updated_at)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT udt_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = %s "
                "AND column_name = 'id'",
                [item._meta.db_table],
            )
            assert cursor.fetchone() == ("uuid",)
            cursor.execute(
                "SELECT column_name, udt_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = %s "
                "AND column_name IN ('created_at', 'updated_at')",
                [item._meta.db_table],
            )
            assert dict(cursor.fetchall()) == {
                "created_at": "timestamptz",
                "updated_at": "timestamptz",
            }


def test_equal_contacts_never_link_or_refuse_independent_people(models):
    first = models.User.objects.create(email="same@customer.test")
    second = models.User.objects.create(email="same@customer.test")
    assert first.pk != second.pk
    assert models.User.objects.filter(email="same@customer.test").count() == 2


@pytest.mark.parametrize("missing", ["owner", "reservation"])
def test_active_organisation_requires_both_final_partners(models, missing):
    constraint = (
        "organisation_owner_required" if missing == "owner" else "organisation_reservation_required"
    )
    with named_refusal("23514", constraint):
        anchor(models, owners=0 if missing == "owner" else 1, reservation=missing != "reservation")
    assert models.Organisation.objects.count() == 0


@pytest.mark.parametrize("change", ["delete", "removed", "suspended", "demoted", "soft-delete"])
def test_final_owner_cannot_be_removed(models, change):
    organisation, _, memberships = anchor(models)
    owner = memberships[0]
    with named_refusal("23514", "organisation_owner_required"):
        query = models.Membership.objects.filter(pk=owner.pk)
        if change == "delete":
            query.delete()
        elif change == "demoted":
            query.update(role="org_member")
        elif change == "soft-delete":
            now = timezone.now()
            query.update(deleted_at=now, purge_after=now + timedelta(days=1))
        else:
            query.update(state=change)
    owner.refresh_from_db()
    assert owner.role == "org_owner" and owner.state == "active" and owner.deleted_at is None
    assert (
        models.Membership.objects.filter(organisation=organisation, role="org_owner").count() == 1
    )


def test_owner_replacement_and_two_to_one_are_valid(models):
    organisation, _, memberships = anchor(models, owners=2)
    with transaction.atomic():
        models.Organisation.objects.select_for_update().get(pk=organisation.pk)
        memberships[0].delete()
    replacement = models.User.objects.create(email="replacement@customer.test")
    with transaction.atomic():
        models.Organisation.objects.select_for_update().get(pk=organisation.pk)
        models.Membership.objects.create(
            user=replacement,
            organisation=organisation,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
        memberships[1].delete()
    assert models.Membership.objects.filter(organisation=organisation).count() == 1
    assert models.Membership.objects.get(organisation=organisation).user_id == replacement.pk


def test_identity_key_is_retained_after_soft_deletion(models):
    organisation, _, members = anchor(models)
    first = identity(models, organisation, members[0].user)
    now = timezone.now()
    models.Identity.objects.filter(pk=first.pk).update(
        enabled=False, deleted_at=now, purge_after=now + timedelta(days=1)
    )
    other = models.User.objects.create(email="other@customer.test")
    with named_refusal("23505", "identity_issuer_subject_unique"):
        identity(models, organisation, other)
    assert models.Identity._base_manager.get(pk=first.pk).user_id == members[0].user_id


def test_identity_key_cannot_be_deleted_and_reassigned(models):
    organisation, _, owners = anchor(models)
    member = models.User.objects.create(email="member@customer.test")
    principal = identity(models, organisation, member)
    with named_refusal("23514", "identity_delete_refused"):
        models.Identity.objects.filter(pk=principal.pk).delete()
        identity(models, organisation, owners[0].user)  # Must never be reached successfully.
    assert models.Identity.objects.get(pk=principal.pk).user_id == member.pk


def test_one_identity_per_person_and_issuer(models):
    organisation, _, owners = anchor(models)
    identity(models, organisation, owners[0].user)
    with named_refusal("23505", "identity_issuer_user_unique"):
        identity(models, organisation, owners[0].user, subject="Another-Subject")


def test_subject_case_and_issuer_are_distinct(models):
    first, _, owners = anchor(models, slug="alpha")
    second, _, other_owners = anchor(models, slug="bravo")
    upper = identity(models, first, owners[0].user, subject="Subject")
    other = models.User.objects.create(email="person@customer.test")
    lower = identity(models, first, other, subject="subject")
    another_issuer = identity(models, second, other_owners[0].user, subject="Subject")
    assert len({upper.pk, lower.pk, another_issuer.pk}) == 3


def test_identity_requires_actual_composite_organisation_binding(models):
    first, _, owners = anchor(models, slug="alpha")
    second, _, _ = anchor(models, slug="bravo")
    with named_refusal("23503", "identity_organisation_binding_fk"):
        models.Identity.objects.create(
            user=owners[0].user,
            organisation=first,
            issuer=second.issuer,
            realm=second.realm,
            subject="Subject",
            email="person@customer.test",
        )


@pytest.mark.parametrize("field", ["subject", "issuer", "realm", "user_id", "organisation_id"])
def test_identity_binding_is_immutable(models, field):
    organisation, _, owners = anchor(models)
    principal = identity(models, organisation, owners[0].user)
    other_org, _, other_owners = anchor(models, slug="bravo")
    values = {
        "subject": "changed",
        "issuer": other_org.issuer,
        "realm": other_org.realm,
        "user_id": other_owners[0].user_id,
        "organisation_id": other_org.pk,
    }
    with named_refusal("23514", "identity_immutable_binding"):
        models.Identity.objects.filter(pk=principal.pk).update(**{field: values[field]})


# The owner's minimum of five (register SLUG-MIN-ANSWER): four characters is refused, five admitted.
@pytest.mark.parametrize(
    "slug", ["a" * 4, "a" * 21, "Alpha", "-alpha", "alpha-", "álpha", "al_pha"]
)
def test_canonical_organisation_slug_refuses_invalid_storage(models, slug):
    with named_refusal("23514", "organisation_slug_valid"):
        anchor(models, slug=slug)


@pytest.mark.parametrize("slug", ["a" * 5, "a" * 20, "alpha-bravo"])
def test_canonical_organisation_slug_boundaries_are_accepted(models, slug):
    organisation, _, _ = anchor(models, slug=slug)
    assert organisation.slug == slug and organisation.realm == slug


def test_prospect_provisional_reservation_has_real_owner(models):
    organisation, held, _ = anchor(
        models, state="prospect", owners=0, reservation_state="provisional"
    )
    assert held.organisation_id == organisation.pk
    assert held.protected_at is None


def test_reservation_delete_refuses(models):
    _, held, _ = anchor(models)
    with named_refusal("23514", "reservation_delete_refused"):
        held.delete()


@pytest.mark.parametrize("field", ["namespace", "slug", "organisation_id"])
def test_reservation_binding_is_immutable(models, field):
    _, held, _ = anchor(models)
    other, _, _ = anchor(models, slug="bravo")
    values = {"namespace": "tenant", "slug": "changed", "organisation_id": other.pk}
    with named_refusal("23514", "reservation_immutable_binding"):
        models.SlugReservation.objects.filter(pk=held.pk).update(**{field: values[field]})


@pytest.mark.parametrize(
    "initial,target",
    [("permanent", "provisional"), ("retired", "provisional"), ("retired", "permanent")],
)
def test_reservation_protected_state_cannot_downgrade(models, initial, target):
    _, held, _ = anchor(models, state="closed", owners=0, reservation_state=initial)
    with named_refusal("23514", "reservation_transition_valid"):
        models.SlugReservation.objects.filter(pk=held.pk).update(state=target)


@pytest.mark.parametrize("replacement", [None, "changed"])
def test_reservation_protection_cannot_disappear_or_change(models, replacement):
    _, held, _ = anchor(models)
    value = None if replacement is None else held.protected_at + timedelta(seconds=1)
    with named_refusal("23514", "reservation_protection_immutable"):
        models.SlugReservation.objects.filter(pk=held.pk).update(protected_at=value)


@pytest.mark.parametrize("role", ["org_owner", "org_admin", "org_billing", "org_member"])
def test_all_canonical_membership_roles_are_accepted(models, role):
    organisation, _, _ = anchor(models)
    user = models.User.objects.create(email="additional@customer.test")
    membership = models.Membership.objects.create(
        user=user, organisation=organisation, role=role, state="active", accepted_at=timezone.now()
    )
    membership.refresh_from_db()
    assert membership.role == role


@pytest.mark.parametrize("role", ["billing_contact", "member"])
def test_legacy_role_aliases_refuse_named_enum(models, role):
    organisation, _, _ = anchor(models)
    user = models.User.objects.create(email="additional@customer.test")
    with named_refusal("23514", "membership_role_valid"):
        models.Membership.objects.create(
            user=user,
            organisation=organisation,
            role=role,
            state="active",
            accepted_at=timezone.now(),
        )


# Direct SQL deliberately bypasses Django's collector and field validation.
def raw_update(item, **values):
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("UPDATE {} SET {} WHERE id=%s").format(
                sql.Identifier(item._meta.db_table),
                sql.SQL(", ").join(sql.SQL("{}=%s").format(sql.Identifier(key)) for key in values),
            ),
            [*values.values(), item.pk],
        )


def raw_delete(item):
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("DELETE FROM {} WHERE id=%s").format(sql.Identifier(item._meta.db_table)),
            [item.pk],
        )


def anchor_items(models):
    organisation, reservation, owners = anchor(models)
    # Independent person: its own ID guard cannot be confused with incoming FKs.
    user = models.User.objects.create(email="independent@customer.test")
    principal = identity(models, organisation, owners[0].user)
    return {
        "User": user,
        "Identity": principal,
        "Organisation": organisation,
        "Membership": owners[0],
        "SlugReservation": reservation,
    }


@pytest.mark.parametrize("name", [name for _, name in MODELS])
def test_all_primary_ids_refuse_direct_reassignment(models, name):
    item = anchor_items(models)[name]
    original = item.pk
    with named_refusal("23514", f"{item._meta.model_name}_id_immutable"):
        raw_update(item, id=new_uuid7())
    assert type(item)._base_manager.filter(pk=original).exists()
    raw_update(item, id=original)  # A no-op does not invent key reassignment.


@pytest.mark.parametrize("method", ["create", "fresh-save"])
def test_primary_key_collision_does_not_overwrite_original(models, method):
    original = models.User.objects.create(email="original@customer.test")
    with named_refusal("23505", f"{original._meta.db_table}_pkey"):
        if method == "create":
            models.User.objects.create(id=original.pk, email="replacement@customer.test")
        else:
            models.User(id=original.pk, email="replacement@customer.test").save()
    original.refresh_from_db()
    assert original.email == "original@customer.test"


@pytest.mark.parametrize("is_owner", [True, False])
def test_raw_identity_delete_cannot_reassign_principal(models, is_owner):
    org, _, owners = anchor(models)
    original_user = (
        owners[0].user if is_owner else models.User.objects.create(email="nonowner@customer.test")
    )
    original = identity(models, org, original_user)
    replacement = models.User.objects.create(email="replacement@customer.test")
    with named_refusal("23514", "identity_delete_refused"):
        raw_delete(original)
        identity(models, org, replacement)
    original.refresh_from_db()
    assert original.user_id == original_user.pk
    assert (
        models.Identity.objects.filter(issuer=original.issuer, subject=original.subject).count()
        == 1
    )


@pytest.mark.parametrize("state", ["provisional", "permanent", "retired"])
def test_raw_reservation_delete_is_refused_in_every_state(models, state):
    _, held, _ = anchor(models, state="closed", owners=0, reservation_state=state)
    with named_refusal("23514", "reservation_delete_refused"):
        raw_delete(held)
    assert models.SlugReservation.objects.filter(pk=held.pk).exists()


def test_actual_parent_delete_uses_restrict_fk(models):
    org, _, owners = anchor(models)
    with named_refusal("23503", "membership_user_fk"):
        raw_delete(owners[0].user)
    # Reservation is the only referring row, selecting one exact FK refusal.
    empty, _, _ = anchor(models, slug="bravo", state="prospect", owners=0)
    with named_refusal("23503", "reservation_organisation_fk"):
        raw_delete(empty)
    assert models.Organisation.objects.filter(pk=org.pk).exists()


@pytest.mark.parametrize("field", ["user_id", "organisation_id"])
def test_membership_ownership_is_immutable(models, field):
    _, _, owners = anchor(models)
    other, _, others = anchor(models, slug="bravo")
    value = others[0].user_id if field == "user_id" else other.pk
    with named_refusal("23514", "membership_immutable_binding"):
        raw_update(owners[0], **{field: value})


def test_organisation_issuer_is_immutable_without_identity_reference(models):
    org, _, _ = anchor(models, state="prospect", owners=0)
    with named_refusal("23514", "organisation_immutable_binding"):
        raw_update(org, issuer="https://another.customer.test/realms/alpha")
    raw_update(org, issuer=org.issuer)


def test_delete_then_replace_owner_commits_at_final_state(models):
    org, _, owners = anchor(models)
    user = models.User.objects.create(email="replacement@customer.test")
    with transaction.atomic():
        models.Organisation.objects.select_for_update().get(pk=org.pk)
        raw_delete(owners[0])
        models.Membership.objects.create(
            user=user,
            organisation=org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    assert models.Membership.objects.get(organisation=org).user_id == user.pk


def test_owner_to_invited_is_valid_storage_but_refuses_ownerless_commit(models):
    _, _, owners = anchor(models)
    with named_refusal("23514", "organisation_owner_required"):
        raw_update(owners[0], state="invited", accepted_at=None)
    with named_refusal("23514", "membership_acceptance_valid"):
        raw_update(owners[0], accepted_at=None)


def test_prospect_activation_requires_final_owner_and_permanent_reservation(models):
    org, held, _ = anchor(models, state="prospect", owners=0, reservation_state="provisional")
    with named_refusal("23514", "organisation_owner_required"):
        with transaction.atomic():
            raw_update(held, state="permanent", protected_at=timezone.now())
            raw_update(org, state="active")
    user = models.User.objects.create(email="new-owner@customer.test")
    member = models.Membership.objects.create(
        user=user, organisation=org, role="org_owner", state="invited", accepted_at=None
    )
    with transaction.atomic():
        models.Organisation.objects.select_for_update().get(pk=org.pk)
        raw_update(held, state="permanent", protected_at=timezone.now())
        raw_update(member, state="active", accepted_at=timezone.now())
        raw_update(org, state="active")
    org.refresh_from_db()
    assert org.state == "active"


def test_disabled_person_does_not_redefine_membership_count(models):
    org, _, owners = anchor(models)
    principal = identity(models, org, owners[0].user)
    raw_update(owners[0].user, enabled=False)
    raw_update(principal, enabled=False)
    assert (
        models.Membership.objects.filter(organisation=org, role="org_owner", state="active").count()
        == 1
    )


@pytest.mark.parametrize(
    "state,accepted",
    [
        ("invited", False),
        ("active", True),
        ("suspended", True),
        ("removed", False),
        ("removed", True),
    ],
)
def test_membership_storage_state_positive_controls(models, state, accepted):
    org, _, _ = anchor(models)
    user = models.User.objects.create(email="nonowner@customer.test")
    member = models.Membership.objects.create(
        user=user,
        organisation=org,
        role="org_member",
        state=state,
        accepted_at=timezone.now() if accepted else None,
    )
    raw_update(member, role="org_admin")  # Valid non-owner mutation also commits.


@pytest.mark.parametrize(
    "state,accepted,constraint",
    [
        ("unknown", False, "membership_state_valid"),
        ("invited", True, "membership_acceptance_valid"),
        ("active", False, "membership_acceptance_valid"),
        ("suspended", False, "membership_acceptance_valid"),
    ],
)
def test_membership_storage_refuses_invalid_combinations(models, state, accepted, constraint):
    org, _, _ = anchor(models)
    user = models.User.objects.create(email="nonowner@customer.test")
    with named_refusal("23514", constraint):
        models.Membership.objects.create(
            user=user,
            organisation=org,
            role="org_member",
            state=state,
            accepted_at=timezone.now() if accepted else None,
        )


@pytest.mark.parametrize("state", ["active", "removed"])
def test_non_deleted_membership_key_remains_unique(models, state):
    org, _, _ = anchor(models)
    user = models.User.objects.create(email="nonowner@customer.test")
    member = models.Membership.objects.create(
        user=user, organisation=org, role="org_member", state=state, accepted_at=timezone.now()
    )
    with named_refusal("23505", "membership_current_unique"):
        models.Membership.objects.create(
            user=user, organisation=org, role="org_member", state="invited"
        )
    now = timezone.now()
    raw_update(member, deleted_at=now, purge_after=now + timedelta(seconds=1))
    replacement = models.Membership.objects.create(
        user=user, organisation=org, role="org_member", state="invited"
    )
    assert replacement.pk != member.pk


def test_person_issuer_key_is_retained_after_identity_soft_deletion(models):
    org, _, owners = anchor(models)
    principal = identity(models, org, owners[0].user)
    now = timezone.now()
    raw_update(principal, deleted_at=now, purge_after=now + timedelta(seconds=1))
    with named_refusal("23505", "identity_issuer_user_unique"):
        identity(models, org, owners[0].user, subject="different")


@pytest.mark.parametrize(
    "subject", ["", "é", "a" * 256, " ", "\x01", "\x7f", "Case Sensitive\tSubject"]
)
def test_subject_storage_bounds_are_named_refusals(models, subject):
    org, _, owners = anchor(models)
    with named_refusal("23514", "identity_subject_valid"):
        identity(models, org, owners[0].user, subject=subject)


# Printable ASCII exactly, the Agent API contract's subject shape (ADR-0016), and case-sensitive.
@pytest.mark.parametrize("subject", ["A", "a", "a" * 255, "!", "~", "Case-Sensitive|Subject"])
def test_subject_is_exact_printable_ascii(models, subject):
    org, _, owners = anchor(models)
    assert identity(models, org, owners[0].user, subject=subject).subject == subject


@pytest.mark.parametrize("name", ["User", "Identity", "Organisation", "Membership"])
@pytest.mark.parametrize("shape", ["deleted-only", "purge-only", "equal", "reversed"])
def test_deletion_pair_storage_refuses_inconsistent_timestamps(models, name, shape):
    item = anchor_items(models)[name]
    now = timezone.now()
    values = {
        "deleted-only": (now, None),
        "purge-only": (None, now),
        "equal": (now, now),
        "reversed": (now, now - timedelta(seconds=1)),
    }[shape]
    with named_refusal("23514", f"{item._meta.model_name}_deletion_valid"):
        raw_update(item, deleted_at=values[0], purge_after=values[1])


@pytest.mark.parametrize("name", ["User", "Identity", "Organisation", "Membership"])
def test_deletion_pair_accepts_absent_or_later_timestamps(models, name):
    items = anchor_items(models)
    item = items[name]
    if name == "Membership":  # Keep another owner; test storage, not final-owner removal.
        org = items["Organisation"]
        user = models.User.objects.create(email="second-owner@customer.test")
        models.Membership.objects.create(
            user=user,
            organisation=org,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    raw_update(item, deleted_at=None, purge_after=None)
    now = timezone.now()
    raw_update(item, deleted_at=now, purge_after=now + timedelta(seconds=1))
    item.refresh_from_db()
    assert item.purge_after > item.deleted_at


@pytest.mark.parametrize("state", ["provisional", "permanent", "retired"])
def test_duplicate_held_name_refuses_in_each_state(models, state):
    first, _, _ = anchor(models, state="closed", owners=0, reservation_state=state)
    with named_refusal("23505", "reservation_namespace_slug_unique"):
        with transaction.atomic():
            second = models.Organisation.objects.create(
                slug="bravo",
                realm="bravo",
                issuer="https://identity.customer.test/realms/bravo",
                name="Second",
                state="prospect",
            )
            models.SlugReservation.objects.create(
                namespace="organisation",
                slug=first.slug,
                organisation=second,
                state=state,
                protected_at=None if state == "provisional" else timezone.now(),
            )


@pytest.mark.parametrize(
    "namespace,slug,constraint",
    [
        ("tenant", "alpha", "reservation_namespace_valid"),
        ("organisation", "bravo", "organisation_reservation_required"),
    ],
)
def test_reservation_insert_must_match_real_organisation(models, namespace, slug, constraint):
    with named_refusal("23514", constraint):
        with transaction.atomic():
            org = models.Organisation.objects.create(
                slug="alpha",
                realm="alpha",
                issuer="https://identity.customer.test/realms/alpha",
                name="Synthetic",
                state="prospect",
            )
            models.SlugReservation.objects.create(
                namespace=namespace, slug=slug, organisation=org, state="provisional"
            )


def test_reservation_cannot_reference_phantom_owner(models):
    with named_refusal("23503", "reservation_organisation_fk"):
        models.SlugReservation.objects.create(
            namespace="organisation", slug="alpha", organisation_id=new_uuid7(), state="provisional"
        )


@pytest.mark.parametrize("state", ["active", "suspended"])
@pytest.mark.parametrize("reservation_state", ["provisional", "retired"])
def test_live_organisation_refuses_non_permanent_reservation(models, state, reservation_state):
    with named_refusal("23514", "organisation_reservation_required"):
        anchor(models, state=state, reservation_state=reservation_state)


@pytest.mark.parametrize("state", ["prospect", "closed"])
def test_non_live_organisation_still_requires_matching_reservation(models, state):
    with named_refusal("23514", "organisation_reservation_required"):
        anchor(models, state=state, owners=0, reservation=False)
    org, _, _ = anchor(models, state=state, owners=0)
    with named_refusal("23514", "organisation_realm_valid"):
        raw_update(org, slug="bravo")


def test_reservation_side_change_cannot_retire_active_organisation(models):
    _, held, _ = anchor(models)
    with named_refusal("23514", "organisation_reservation_required"):
        raw_update(held, state="retired")


def test_valid_reservation_protection_and_retirement_transitions(models):
    org, held, _ = anchor(models, state="prospect", owners=0, reservation_state="provisional")
    now = timezone.now()
    raw_update(held, state="permanent", protected_at=now)
    with transaction.atomic():
        raw_update(org, state="closed")
        raw_update(held, state="retired")
    held.refresh_from_db()
    assert held.state == "retired" and held.protected_at == now


@pytest.mark.parametrize(
    "state,protected",
    [("provisional", True), ("permanent", False), ("retired", False), ("unknown", False)],
)
def test_reservation_insert_state_and_protection_are_checked(models, state, protected):
    constraint = "reservation_state_valid" if state == "unknown" else "reservation_protection_valid"
    with named_refusal("23514", constraint):
        with transaction.atomic():
            org = models.Organisation.objects.create(
                slug="alpha",
                realm="alpha",
                issuer="https://identity.customer.test/realms/alpha",
                name="Synthetic",
                state="prospect",
            )
            models.SlugReservation.objects.create(
                namespace="organisation",
                slug="alpha",
                organisation=org,
                state=state,
                protected_at=timezone.now() if protected else None,
            )


@pytest.mark.parametrize("issuer", ["", "x" * 2049, "https://identity.customer.test/realms/wrong"])
def test_issuer_insert_bounds_and_realm_suffix_are_checked(models, issuer):
    with named_refusal("23514", "organisation_issuer_valid"):
        with transaction.atomic():
            models.Organisation.objects.create(
                slug="alpha", realm="alpha", issuer=issuer, name="Synthetic", state="prospect"
            )


def test_issuer_is_globally_unique(models):
    first, _, _ = anchor(models, state="prospect", owners=0)
    with named_refusal("23505", "organisation_issuer_unique"):
        with transaction.atomic():
            models.Organisation.objects.create(
                slug=first.slug,
                realm=first.realm,
                issuer=first.issuer,
                name="Synthetic",
                state="prospect",
            )


@pytest.mark.parametrize(
    "name,field,value,constraint",
    [
        ("User", "email", "", "user_email_valid"),
        ("Identity", "email", "", "identity_email_valid"),
        ("User", "display_name", "x" * 201, "user_display_name_valid"),
        ("Organisation", "name", "", "organisation_name_valid"),
        ("Organisation", "name", "x" * 201, "organisation_name_valid"),
        ("Organisation", "state", "closing", "organisation_state_valid"),
    ],
)
def test_explicit_contact_name_and_state_checks(models, name, field, value, constraint):
    item = anchor_items(models)[name]
    with named_refusal("23514", constraint):
        raw_update(item, **{field: value})


@pytest.mark.parametrize(
    "name,field",
    [("User", "email"), ("Identity", "email"), ("Organisation", "name"), ("Membership", "role")],
)
def test_required_fields_are_database_not_null(models, name, field):
    item = anchor_items(models)[name]
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        raw_update(item, **{field: None})
    cause = error.value.__cause__
    assert cause.sqlstate == "23502" and cause.diag.column_name == field


def test_contact_and_name_boundary_positive_controls(models):
    items = anchor_items(models)
    raw_update(items["User"], display_name=None)
    raw_update(items["User"], display_name="x" * 200)
    raw_update(items["Organisation"], name="x" * 200)
    for name in ("User", "Identity"):
        raw_update(items[name], email="same@customer.test")


def test_catalogue_proves_actual_restrict_composite_and_deferred_constraints(
    models, record_property
):
    tables = [model._meta.db_table for model in vars(models).values()]
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_user, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls "
            "FROM pg_roles WHERE rolname=current_user"
        )
        role = cursor.fetchone()
        assert role and isinstance(role[0], str) and all(isinstance(v, bool) for v in role[1:])
        record_property(
            "migration_role",
            dict(
                zip(
                    ("name", "superuser", "create_role", "create_db", "bypass_rls"),
                    role,
                    strict=True,
                )
            ),
        )
        # Role authority is recorded as test metadata, never presented as API least privilege.
        cursor.execute(
            "SELECT conname, contype, confdeltype, convalidated, condeferrable, "
            "condeferred, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = ANY(%s::regclass[])",
            [tables],
        )
        constraints = {row[0]: row[1:] for row in cursor.fetchall()}
        fks = {name: values for name, values in constraints.items() if values[0] == "f"}
        assert fks and all(v[1] == "r" and v[2] for v in fks.values())
        cursor.execute(
            "SELECT source.relname, "
            "ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinal) "
            "JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ordinal), "
            "target.relname, "
            "ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ordinal) "
            "JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ordinal) "
            "FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid "
            "JOIN pg_class target ON target.oid=c.confrelid "
            "WHERE c.contype='f' AND c.conrelid=ANY(%s::regclass[])",
            [tables],
        )
        relationships = {
            (source, tuple(columns), target, tuple(references))
            for source, columns, target, references in cursor.fetchall()
        }
        required = {
            (models.Identity._meta.db_table, ("user_id",), models.User._meta.db_table, ("id",)),
            (
                models.Identity._meta.db_table,
                ("organisation_id", "issuer", "realm"),
                models.Organisation._meta.db_table,
                ("id", "issuer", "realm"),
            ),
            (models.Membership._meta.db_table, ("user_id",), models.User._meta.db_table, ("id",)),
            (
                models.Membership._meta.db_table,
                ("organisation_id",),
                models.Organisation._meta.db_table,
                ("id",),
            ),
            (
                models.SlugReservation._meta.db_table,
                ("organisation_id",),
                models.Organisation._meta.db_table,
                ("id",),
            ),
        }
        assert required <= relationships, "required actual foreign-key relationship is absent"
        assert all(v[2] for v in constraints.values()), "unvalidated actual constraint remains"
        composite = constraints["identity_organisation_binding_fk"][-1]
        assert "FOREIGN KEY (organisation_id, issuer, realm)" in composite
        assert f"REFERENCES {models.Organisation._meta.db_table}(id, issuer, realm)" in composite
        for name in ("organisation_owner_required", "organisation_reservation_required"):
            assert constraints[name][3:5] == (True, True), (
                "final-state guard is not initially deferred"
            )


def test_issuer_maximum_length_and_realm_positive_control(models):
    suffix = "/realms/alpha"
    issuer = "https://" + "a" * (2048 - len("https://") - len(suffix)) + suffix
    with transaction.atomic():
        org = models.Organisation.objects.create(
            slug="alpha", realm="alpha", issuer=issuer, name="Synthetic", state="prospect"
        )
        models.SlugReservation.objects.create(
            namespace="organisation", slug="alpha", organisation=org, state="provisional"
        )
    assert len(org.issuer) == 2048


def test_final_state_constraint_triggers_cover_both_ends(models):
    with connection.cursor() as cursor:
        for guard, expected in (
            (
                "organisation_owner_required",
                {models.Organisation._meta.db_table, models.Membership._meta.db_table},
            ),
            (
                "organisation_reservation_required",
                {models.Organisation._meta.db_table, models.SlugReservation._meta.db_table},
            ),
        ):
            cursor.execute(
                "SELECT r.relname FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid "
                "WHERE c.conname=%s AND c.contype='t' AND c.condeferrable AND c.condeferred",
                [guard],
            )
            assert {row[0] for row in cursor.fetchall()} == expected


def test_identity_refuses_phantom_person_reference(models):
    org, _, _ = anchor(models)
    with named_refusal("23503", "identity_user_fk"):
        models.Identity.objects.create(
            user_id=new_uuid7(),
            organisation=org,
            issuer=org.issuer,
            realm=org.realm,
            subject="Phantom-User",
            email="phantom@customer.test",
        )

"""`active_membership_id` holds on its own, against the real database.

It is called here without `has_current_read_grant`: a membership that is not current
(removed, suspended, invited, deleted, unaccepted or of an unknown role) yields no id,
and the grant agrees on every row because both narrow one shared predicate.
"""

from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.db import connection, transaction
from django.utils import timezone
from test_customer_persistence_models import anchor, anchor_models

from apps.orgs.selectors import active_membership_id, has_current_read_grant

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def org():
    assert connection.vendor == "postgresql"
    models = anchor_models()
    organisation, _, _ = anchor(models, slug="alpha")
    return SimpleNamespace(models=models, organisation=organisation)


def member(org, *, state="active", accepted=True, role="org_member"):
    user = org.models.User.objects.create(email="synthetic@customer.test")
    return org.models.Membership.objects.create(
        user=user,
        organisation=org.organisation,
        role=role,
        state=state,
        accepted_at=timezone.now() if accepted else None,
    )


def lookup(org, row):
    return active_membership_id(user_id=row.user_id, organisation_id=org.organisation.pk)


def grant(org, row):
    return has_current_read_grant(
        user_id=row.user_id,
        organisation_id=org.organisation.pk,
        issuer=org.organisation.issuer,
        realm=org.organisation.realm,
    )


def test_current_member_of_active_organisation_yields_its_id(org):
    row = member(org)
    assert lookup(org, row) == row.pk and grant(org, row)


@pytest.mark.parametrize(
    ("state", "accepted"),
    [("removed", True), ("suspended", True), ("invited", False)],
    ids=["removed", "suspended", "invited"],
)
def test_membership_that_is_not_current_yields_no_id_on_its_own(org, state, accepted):
    row = member(org, state=state, accepted=accepted)
    assert lookup(org, row) is None
    assert not grant(org, row)


def test_deleted_membership_yields_no_id(org):
    row = member(org)
    deleted = timezone.now()
    org.models.Membership.objects.filter(pk=row.pk).update(
        deleted_at=deleted, purge_after=deleted + timedelta(days=30)
    )
    assert lookup(org, row) is None and not grant(org, row)


def test_suspended_organisation_keeps_the_grant_but_yields_no_id(org):
    row = member(org)
    org.models.Organisation.objects.filter(pk=org.organisation.pk).update(state="suspended")
    # The org-read grant supports suspended organisations; the id lookup is active-only.
    assert grant(org, row) and lookup(org, row) is None


class RestoreError(Exception):
    pass


@pytest.mark.parametrize(
    ("constraint", "changes"),
    [
        ("membership_acceptance_valid", {"accepted_at": None}),
        ("membership_role_valid", {"role": "org_unknown"}),
    ],
    ids=["unaccepted-active", "unknown-role"],
)
def test_clauses_the_schema_also_guards_still_refuse_without_it(org, constraint, changes):
    # Each clause is proven alone: drop only the check that would refuse the row,
    # store it inside a transaction that is then rolled back, and read it.
    row = member(org)
    with pytest.raises(RestoreError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(f"ALTER TABLE orgs_membership DROP CONSTRAINT {constraint}")
            org.models.Membership.objects.filter(pk=row.pk).update(**changes)
            assert org.models.Membership.objects.filter(pk=row.pk, **changes).exists()
            assert lookup(org, row) is None
            assert not grant(org, row)
            raise RestoreError
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM pg_constraint WHERE conname=%s AND conrelid='orgs_membership'::regclass",
            [constraint],
        )
        assert cursor.fetchone() == (1,), "schema check was not restored"
    assert lookup(org, row) == row.pk

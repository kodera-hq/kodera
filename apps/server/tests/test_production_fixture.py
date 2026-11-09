"""Actual operator seed against retained PostgreSQL owner/reservation constraints."""

import inspect

import pytest
from django.db import IntegrityError, transaction

from dev.accept_production_http import seed_fixture


@pytest.mark.django_db(transaction=True)
def test_actual_fixture_seed_obeys_retained_owner_and_reservation():
    from apps.identity.models import Identity
    from apps.orgs.models import Membership, Organisation, SlugReservation

    seed_fixture()
    org = Organisation.objects.get(slug="alpha")
    assert org.state == "active"
    reservation = SlugReservation.objects.get(organisation=org)
    assert reservation.slug == org.slug and reservation.state == "permanent"
    assert reservation.protected_at is not None
    owner = Membership.objects.get(organisation=org, role="org_owner", state="active")
    assert owner.accepted_at is not None
    assert Identity.objects.get(user=owner.user).subject == "synthetic-subject"


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "before,after,constraint",
    [
        ('role="org_owner"', 'role="org_member"', "organisation_owner_required"),
        ('state="permanent"', 'state="retired"', "organisation_reservation_required"),
    ],
)
def test_stored_constraints_refuse_actual_seed_mutations(before, after, constraint):
    source = inspect.getsource(seed_fixture)
    assert source.count(before) == 1
    namespace = dict(seed_fixture.__globals__)
    exec(compile(source.replace(before, after), "<actual-fixture-mutant>", "exec"), namespace)  # noqa: S102 - owned seed mutation; disposable test database
    with pytest.raises(IntegrityError) as refused, transaction.atomic():
        namespace["seed_fixture"]()
    assert refused.value.__cause__.sqlstate == "23514"
    assert refused.value.__cause__.diag.constraint_name == constraint
    from apps.orgs.models import Organisation

    assert not Organisation.objects.filter(slug="alpha").exists()

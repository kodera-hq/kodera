"""The platform labels of kodera.io are reserved tenant slugs too (ADR-0023, contract 0.38.0).

A tenant's slug names its Matrix homeserver, `{slug}.{matrix domain}`, so a tenant that took
`staging` would be given the staging Matrix domain itself. ADR-0018 reserved these labels for
organisation slugs only (tests/test_reserved_platform_slugs.py). Here: the list, the database's
refusal, and the migration that stops, naming them, when a tenant already holds one. The refusals
of `placeOrder`, `createTenant` and `checkSlugAvailability` are in their own files, each with
`staging` among its cases.
"""

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from kodera_io_labels import fitting
from test_reserved_platform_slugs import PLATFORM_LABELS

from apps.orgs.models import Organisation, SlugReservation
from apps.tenancy.models import RESERVED_TENANT_SLUGS, SLUG, Tenant, is_reserved_tenant_slug

BEFORE = ("tenancy", "0002_guards")
RESERVING = ("tenancy", "0003_reserved_platform_labels")


# The labels of kodera.io a tenant slug's pattern admits (tests/kodera_io_labels.py, the list the
# organisation test reads too).
TENANT_PLATFORM_LABELS = fitting(SLUG)


def test_every_platform_host_of_kodera_io_is_reserved_for_a_tenant():
    missing = sorted(set(TENANT_PLATFORM_LABELS) - set(RESERVED_TENANT_SLUGS))
    assert not missing, f"platform labels a tenant may still take: {missing}"


def test_every_label_an_organisation_reserves_as_a_platform_label_is_reserved_for_a_tenant():
    missing = sorted(set(PLATFORM_LABELS) - set(RESERVED_TENANT_SLUGS))
    assert not missing, f"platform labels a tenant may still take: {missing}"


@pytest.mark.parametrize("slug", TENANT_PLATFORM_LABELS)
def test_the_rule_the_services_apply_refuses_each_platform_label(slug):
    assert is_reserved_tenant_slug(slug)


def organisation(slug="acme-sa"):
    """An organisation with the held name its deferred guard requires, in one transaction: the
    guard is checked at commit, and these tests run in autocommit (transaction=True)."""
    with transaction.atomic():
        owner = Organisation.objects.create(
            slug=slug, realm=slug, issuer=f"https://identity.customer.test/realms/{slug}", name="X"
        )
        SlugReservation.objects.create(
            namespace="organisation", slug=slug, organisation=owner, state="provisional"
        )
    return owner


def tenant(owner, slug, model=Tenant):
    return model.objects.create(
        organisation_id=owner.id,
        slug=slug,
        name="X",
        status_changed_at=timezone.now(),
        pack_code="workspace",
        capacity_tier_code="S",
        apps=["visio", "messaging"],
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("slug", TENANT_PLATFORM_LABELS)
def test_the_database_refuses_each_platform_label(slug):
    owner = organisation()
    with pytest.raises(IntegrityError) as refusal, transaction.atomic():
        tenant(owner, slug)
    assert refusal.value.__cause__.diag.constraint_name == "tenancy_tenant_slug_not_reserved"


@pytest.mark.django_db(transaction=True)
def test_the_database_still_refuses_the_earlier_names_and_punycode():
    owner = organisation()
    for slug in ("www", "kodera", "xn--80ak6aa92e"):
        with pytest.raises(IntegrityError) as refusal, transaction.atomic():
            tenant(owner, slug)
        assert refusal.value.__cause__.diag.constraint_name == "tenancy_tenant_slug_not_reserved"
    assert tenant(owner, "acme").slug == "acme"


@pytest.mark.django_db(transaction=True)
def test_the_migration_stops_naming_the_held_labels():
    """Everything below runs in one transaction that is rolled back: the reversal, the rows a
    database could hold before this migration, and the refused forward run."""
    try:
        with transaction.atomic():
            executor = MigrationExecutor(connection)
            executor.migrate([BEFORE])
            historical = executor.loader.project_state([BEFORE]).apps.get_model("tenancy", "Tenant")
            owner = organisation()
            tenant(owner, "staging", historical)
            tenant(owner, "matrix", historical)
            tenant(owner, "acme", historical)
            with pytest.raises(RuntimeError) as stopped:
                MigrationExecutor(connection).migrate([RESERVING])
            message = str(stopped.value)
            assert "matrix, staging" in message, f"the held labels are not named: {message}"
            assert "acme" not in message
            transaction.set_rollback(True)
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
    executor = MigrationExecutor(connection)
    assert executor.migration_plan(executor.loader.graph.leaf_nodes()) == [], "schema left behind"
    assert not Tenant.objects.filter(slug__in=TENANT_PLATFORM_LABELS).exists()

"""The platform labels of kodera.io are reserved organisation slugs: ESPACE_STRUCTURE.md §8, ES-10.

The intake's refusal of each label is in tests/test_organisation_intake.py, which reads the same
list, and the contract's closed list in tests/test_espace_structure_contract.py. Here: the list
itself, the database's refusal, and the migration that stops, naming them, when an organisation
already holds one. And since contract 0.39.0, every label of kodera.io the slug pattern admits
(tests/kodera_io_labels.py, the list the tenant test reads too), with migrations 0018 and 0019.
"""

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from kodera_io_labels import fitting

from apps.orgs.intake_services import SLUG
from apps.orgs.models import RESERVED_ORGANISATION_SLUGS, Organisation

PLATFORM_LABELS = (
    "notify",
    "staging",
    "status",
    "support",
    "billing",
    "console",
    "developers",
    "matrix",
    "auth-admin",
    "auth-mail",
)
BEFORE = ("orgs", "0012_validate_notice_contacts")
RESERVING = ("orgs", "0013_reserved_platform_slugs")
ORGANISATION_PLATFORM_LABELS = fitting(SLUG)
BEFORE_HOSTS = ("orgs", "0017_invitations")
RESERVING_HOSTS = ("orgs", "0018_reserved_platform_hosts")


def test_es10_every_platform_label_is_reserved():
    assert set(PLATFORM_LABELS) <= set(RESERVED_ORGANISATION_SLUGS), (
        "ES-10: a label is not reserved"
    )


def test_every_label_of_kodera_io_the_pattern_admits_is_reserved():
    missing = sorted(set(ORGANISATION_PLATFORM_LABELS) - set(RESERVED_ORGANISATION_SLUGS))
    assert not missing, f"labels of kodera.io an organisation may still take: {missing}"
    assert {"errors", "ops-admin"} <= set(ORGANISATION_PLATFORM_LABELS), (
        "the shared list lost a host"
    )


def organisation(slug, model=Organisation):
    return model.objects.create(
        slug=slug, realm=slug, issuer=f"https://identity.customer.test/realms/{slug}", name="X"
    )


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("slug", ORGANISATION_PLATFORM_LABELS)
def test_es10_the_database_refuses_each_platform_label(slug):
    with pytest.raises(IntegrityError) as refusal, transaction.atomic():
        organisation(slug)
    assert refusal.value.__cause__.diag.constraint_name == "organisation_slug_not_reserved"


@pytest.mark.django_db(transaction=True)
def test_es10_the_migration_stops_naming_the_held_labels():
    """Everything below runs in one transaction that is rolled back: the reversal, the two rows a
    database could hold before this migration, and the refused forward run."""
    try:
        with transaction.atomic():
            executor = MigrationExecutor(connection)
            executor.migrate([BEFORE])
            historical = executor.loader.project_state([BEFORE]).apps.get_model(
                "orgs", "Organisation"
            )
            organisation("status", historical)
            organisation("matrix", historical)
            organisation("acme-sa", historical)
            with pytest.raises(RuntimeError) as stopped:
                MigrationExecutor(connection).migrate([RESERVING])
            message = str(stopped.value)
            assert "matrix, status" in message, f"ES-10: the held labels are not named: {message}"
            assert "acme-sa" not in message
            transaction.set_rollback(True)
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
    executor = MigrationExecutor(connection)
    assert executor.migration_plan(executor.loader.graph.leaf_nodes()) == [], "schema left behind"
    assert not Organisation.objects.filter(slug__in=PLATFORM_LABELS).exists()


@pytest.mark.django_db(transaction=True)
def test_the_hosts_migration_stops_naming_the_held_hosts():
    """As above, for 0018: rolled back, then the schema restored to the leaf."""
    try:
        with transaction.atomic():
            executor = MigrationExecutor(connection)
            executor.migrate([BEFORE_HOSTS])
            historical = executor.loader.project_state([BEFORE_HOSTS]).apps.get_model(
                "orgs", "Organisation"
            )
            organisation("ops-admin", historical)
            organisation("errors", historical)
            organisation("acme-sa", historical)
            with pytest.raises(RuntimeError) as stopped:
                MigrationExecutor(connection).migrate([RESERVING_HOSTS])
            message = str(stopped.value)
            assert "errors, ops-admin" in message, f"the held hosts are not named: {message}"
            assert "acme-sa" not in message
            transaction.set_rollback(True)
    finally:
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
    executor = MigrationExecutor(connection)
    assert executor.migration_plan(executor.loader.graph.leaf_nodes()) == [], "schema left behind"
    assert not Organisation.objects.filter(slug__in=("errors", "ops-admin")).exists()


@pytest.mark.django_db(transaction=True)
def test_third_party_organisation_cannot_claim_community():
    with pytest.raises(IntegrityError) as refused, transaction.atomic():
        organisation("community")
    assert refused.value.__cause__.diag.constraint_name == "organisation_slug_not_reserved"

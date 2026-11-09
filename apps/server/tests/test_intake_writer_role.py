"""The API role's intake grants are enough, and no more: docs/specs/ORGANISATION_INTAKE.md §4.

A role holding exactly `dev/api_writer_role.py`'s grants is created in the test database, and the
test connection acts as it (`SET ROLE`) while the real view records an intake, refuses a held slug
and audits a refusal. The same role is then refused, by privilege, every write on the staff grants
— revoking one, deleting or truncating them, granting a role — and every change to the intake,
the audit, or an organisation's state. The one column of `identity_staffrole` it may update is one
the immutability trigger already freezes.
"""

import uuid
from contextlib import contextmanager

import pytest
from django.db import DatabaseError, connection, transaction
from test_organisation_intake import body, signing_key, world  # noqa: F401 - fixtures

from apps.audit.models import AuditEvent
from apps.orgs.models import Organisation, OrganisationIntake
from dev.api_writer_role import grant_statements

INSUFFICIENT_PRIVILEGE = "42501"
CHECK_VIOLATION = "23514"


@pytest.fixture
def writer(world):  # noqa: F811 - the fixture imported above
    role = f"intake_writer_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def current_user():
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user")
        return cursor.fetchone()[0]


@contextmanager
def acting_as(role):
    with connection.cursor() as cursor:
        cursor.execute(f'SET ROLE "{role}"')
    try:
        yield
        assert current_user() == role, "the connection stopped acting as the writer role"
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")


def refused(statement):
    """The SQLSTATE the database refused `statement` with, inside a savepoint."""
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(statement)
    except DatabaseError as error:
        return getattr(error.__cause__, "sqlstate", None)
    return None


def test_the_writer_role_records_refuses_and_audits_an_intake(world, writer):  # noqa: F811
    with acting_as(writer):
        assert current_user() == writer
        recorded = world.post()
        assert recorded.status_code == 201, recorded.content
        replayed = world.post()
        assert replayed.headers.get("Idempotency-Replayed") == "true"
        taken = world.post(body(name="Another"), key="intake-key-0000000002")
        assert taken.status_code == 409 and taken.json()["type"].endswith("/slug-taken")
        denied = world.post(credential=world.token(amr=("pwd",)), key="intake-key-0000000003")
        assert denied.status_code == 403
    assert Organisation.objects.count() == OrganisationIntake.objects.count() == 1
    assert AuditEvent.objects.filter(action="authz.denied").count() == 1


@pytest.mark.parametrize(
    ("statement", "sqlstate"),
    [
        ("UPDATE identity_staffrole SET revoked_at = clock_timestamp()", INSUFFICIENT_PRIVILEGE),
        ("DELETE FROM identity_staffrole", INSUFFICIENT_PRIVILEGE),
        ("TRUNCATE identity_staffrole", INSUFFICIENT_PRIVILEGE),
        (
            "INSERT INTO identity_staffrole (id, identity_id, realm, role, created_at, updated_at) "
            "SELECT gen_random_uuid(), identity_id, realm, role, now(), now() "
            "FROM identity_staffrole",
            INSUFFICIENT_PRIVILEGE,
        ),
        ("UPDATE identity_identity SET enabled = true", INSUFFICIENT_PRIVILEGE),
        ("UPDATE orgs_organisationintake SET instruction_ref = 'SUP-1'", INSUFFICIENT_PRIVILEGE),
        ("DELETE FROM orgs_organisationintake", INSUFFICIENT_PRIVILEGE),
        ("UPDATE audit_auditevent SET action = 'job.failed'", INSUFFICIENT_PRIVILEGE),
        ("DELETE FROM audit_auditevent", INSUFFICIENT_PRIVILEGE),
        ("UPDATE orgs_organisation SET state = 'active'", INSUFFICIENT_PRIVILEGE),
        # The role inserts a membership on acceptance (docs/specs/INVITATIONS.md §7), never deletes one.
        ("DELETE FROM orgs_membership", INSUFFICIENT_PRIVILEGE),
        ("UPDATE jobs_job SET status = 'cancelled'", INSUFFICIENT_PRIVILEGE),
        # The one staff-grant column the role may update: the trigger refuses any change to it.
        ("UPDATE identity_staffrole SET created_at = clock_timestamp()", CHECK_VIOLATION),
    ],
)
def test_the_writer_role_cannot_touch_a_grant_or_rewrite_what_it_wrote(
    world,  # noqa: F811
    writer,
    statement,
    sqlstate,
):
    with acting_as(writer):
        assert world.post().status_code == 201
        assert refused(statement) == sqlstate, statement
    # Control: the schema owner is not refused by privilege, so the refusal above is the role's.
    assert refused(statement) != INSUFFICIENT_PRIVILEGE, statement

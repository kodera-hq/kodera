"""The collaboration login operates documents without reading other application tables."""

from uuid import UUID, uuid4

import pytest
from django.db import connection, transaction
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from workspace_safety.test_moderation import world as world

from apps.docs import services
from apps.docs.models import Document
from workspace_documents.test_services import native_engine as native_engine

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def collab_role():
    from apps.docs.collab_role import grant_statements

    name = "collab_test_" + uuid4().hex[:12]
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
        )
        for statement in grant_statements(name):
            cursor.execute(statement)
    try:
        yield name
    finally:
        with connection.cursor() as cursor:
            cursor.execute(f'DROP OWNED BY "{name}"')
            cursor.execute(f'DROP ROLE "{name}"')


def test_collab_role_fences_current_authority_and_refuses_unrelated_tables(
    world, native_engine, collab_role
):
    org, workspace, members, tokens = world
    created = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Restricted runtime",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    document = UUID(created["id"])
    from apps.identity.models import Identity

    identity = Identity.objects.get(user=members[3].user)
    parameters = [
        document,
        org.id,
        members[3].id,
        identity.id,
        tokens[3].issuer,
        tokens[3].subject,
        "editor",
    ]
    with acting_as(collab_role):
        for table in (
            "orgs_membership",
            "identity_user",
            "identity_identity",
            "workspaces_workspace",
            "audit_auditevent",
            "media_attachment",
        ):
            assert refused(f'SELECT * FROM "{table}"') == INSUFFICIENT_PRIVILEGE  # noqa: S608 - fixed local table names
        assert refused("UPDATE docs_document SET visibility='restricted'") == INSUFFICIENT_PRIVILEGE
        assert refused("DELETE FROM docs_document") == INSUFFICIENT_PRIVILEGE
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)", parameters)
            assert cursor.fetchone() == (workspace.id,)
            cursor.execute(
                "UPDATE docs_document SET markdown='Restricted update',revision=revision+1 WHERE id=%s",
                [document],
            )
            cursor.execute(
                "SELECT docs_collab_audit(%s,%s,%s,%s,%s,%s)",
                [
                    uuid4(),
                    "workspace.document.collab_updated",
                    org.id,
                    document,
                    identity.id,
                    uuid4().hex,
                ],
            )
        changed = list(parameters)
        changed[5] = "wrong-subject"
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT docs_collab_fence(%s,%s,%s,%s,%s,%s,%s)", changed)
            assert cursor.fetchone() == (None,)
    assert Document.objects.get(id=document).markdown == "Restricted update"


def test_scope_guard_refusal_detects_invoker_rights_mutation(world, native_engine, collab_role):
    org, _, _, tokens = world
    created = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Trigger privilege mutation",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    with connection.cursor() as cursor:
        cursor.execute("ALTER FUNCTION docs_scope_guard() SECURITY INVOKER")
    try:
        with acting_as(collab_role):
            assert refused("UPDATE docs_document SET revision=revision+1") == INSUFFICIENT_PRIVILEGE
    finally:
        with connection.cursor() as cursor:
            cursor.execute("ALTER FUNCTION docs_scope_guard() SECURITY DEFINER")
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("UPDATE docs_document SET revision=revision+1 WHERE id=%s", [created["id"]])


def test_temp_relations_cannot_shadow_scope_or_journal_guards(world, native_engine, collab_role):
    org, _, _, tokens = world
    created = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Temporary relation shadow",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    with acting_as(collab_role), transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE docs_document(id uuid,workspace_id uuid) ON COMMIT DROP")
        # A lookalike must neither supply nor suppress the scope guard's facts.
        # This valid link still resolves against the actual document table.
        cursor.execute(
            "UPDATE public.docs_document SET revision=revision+1 WHERE id=%s", [created["id"]]
        )
        cursor.execute(
            "INSERT INTO public.docs_documentlink(id,created_at,updated_at,source_id,target_id,target_title) VALUES(%s,clock_timestamp(),clock_timestamp(),%s,%s,%s)",
            [uuid4(), created["id"], created["id"], "temporary relation shadow"],
        )


@pytest.mark.parametrize(
    "grant",
    [
        "GRANT SELECT (email) ON identity_user",
        "GRANT UPDATE (visibility) ON docs_document",
        "GRANT TRUNCATE ON docs_document",
    ],
)
def test_role_installer_refuses_existing_excess_grants(collab_role, grant):
    from django.core.exceptions import ImproperlyConfigured

    from apps.docs.collab_role import assert_unprivileged

    with connection.cursor() as cursor:
        assert_unprivileged(cursor, collab_role)
        cursor.execute(grant + f' TO "{collab_role}"')
        with pytest.raises(ImproperlyConfigured, match="forbidden table grants"):
            assert_unprivileged(cursor, collab_role)


def test_operator_installs_and_rechecks_the_fixed_independent_login(monkeypatch):
    from io import StringIO
    from urllib.parse import quote

    from django.core.management import call_command
    from django.core.management.base import CommandError

    database = connection.settings_dict
    target = (
        "postgresql://kodera_collab:synthetic-independent-database-password@"
        + database["HOST"]
        + ":"
        + str(database["PORT"])
        + "/"
        + quote(database["NAME"], safe="")
    )
    monkeypatch.setenv("KODERA_COLLAB_DATABASE_URL", target)
    try:
        for _ in range(2):
            output = StringIO()
            call_command("configure_collab_role", stdout=output)
            assert "Dedicated collaboration database role configured" in output.getvalue()
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT rolconnlimit,rolsuper,rolinherit,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='kodera_collab'"
            )
            assert cursor.fetchone() == (5, False, False, False, False)
            cursor.execute("GRANT SELECT(email) ON identity_user TO kodera_collab")
        with pytest.raises(CommandError, match="forbidden table grants"):
            call_command("configure_collab_role", stdout=StringIO())
    finally:
        with connection.cursor() as cursor:
            cursor.execute("DROP OWNED BY kodera_collab")
            cursor.execute("DROP ROLE kodera_collab")


def test_restricted_native_store_persists_and_redeems_one_nonce(
    world, native_engine, collab_role, settings
):
    import base64
    import json
    import os
    import shutil
    import subprocess
    from pathlib import Path
    from urllib.parse import quote

    org, _, _, tokens = world
    created = services.create(
        verified=tokens[3],
        organisation_id=org.id,
        name="Native restricted store",
        parent_id=None,
        template_key=None,
        request_id=str(uuid4()),
    )
    ticket = services.collab_session(
        verified=tokens[3],
        organisation_id=org.id,
        document_id=UUID(created["id"]),
        request_id=str(uuid4()),
    )
    database = connection.settings_dict
    url = (
        "postgresql://"
        + quote(database["USER"], safe="")
        + ":"
        + quote(database["PASSWORD"], safe="")
        + "@"
        + database["HOST"]
        + ":"
        + str(database["PORT"])
        + "/"
        + quote(database["NAME"], safe="")
    )
    root = Path(__file__).resolve().parents[2] / "yjs_collab"
    binary = shutil.which("node")
    if binary is None:
        raise RuntimeError("native role tests require Node.js")
    result = subprocess.run(  # noqa: S603 - fixed owned fixture and disposable database
        [binary, str(root / "test/role-fixture.mjs")],
        cwd=root,
        env={
            "PATH": os.environ["PATH"],
            "KODERA_TEST_DATABASE_URL": url,
            "KODERA_TEST_COLLAB_KEY": base64.urlsafe_b64encode(
                settings.KODERA_COLLAB_TICKET_KEY
            ).decode(),
        },
        input=json.dumps({"role": collab_role, "ticket": ticket["token"]}).encode(),
        capture_output=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads(result.stdout) == {
        "restricted": True,
        "persisted": True,
        "nonceWinners": 1,
        "widenedRefused": True,
    }
    assert "Restricted store update" in Document.objects.get(id=created["id"]).markdown

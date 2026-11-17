"""The API writer role's realm discovery grants are enough, and no more: REALM_DISCOVERY.md,
ORGANISATION_INTAKE.md §4, `core/db/api_writer_role.py`.

Verifies against real PostgreSQL:
1. A loginless role holding `core.db.api_writer_role.grant_statements` passes
   `core.db.api_database_boundary.assert_writer_grants` (zero sequence grants, zero excess grants)
   and serves `POST /api/v1/auth/discover` (`{"slug": "community"}`, customer `{"slug": ...}` via
   `counting_realm_ready`, and `{"email": "person@example.com"}`) with `HTTP 200`, including
   expired quota pruning and `cleanup_expired()`.
2. PostgreSQL refuses gate deletion/insertion/id rewrites, `singleton = false` (`23514`), quota
   event rewrites or truncation, and staff-recorder reads or mutations on `orgs_realmreadiness`.
3. `manage.py configure_api_role` provisions `kodera_api` cleanly and `config.deploy_wsgi` serves
   `POST /api/v1/auth/discover` (`{"slug": "community"}` and `{"email": "person@example.com"}`)
   with `HTTP 200` over an independent `kodera_api` database login.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from datetime import timedelta
from io import StringIO
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, trust_entry
from django.core.management import call_command
from django.db import DatabaseError, connection
from django.test import Client
from django.utils import timezone
from psycopg import sql
from test_discovery_services import (
    DEPLOYED_IDP,
    KEY,
    owner_world as owner_world,
    quota_configuration as quota_configuration,
    ready as ready,
    w as w,
)
from test_intake_writer_role import (
    CHECK_VIOLATION,
    INSUFFICIENT_PRIVILEGE,
    acting_as,
    current_user,
    refused,
)

from apps.identity.discovery_quotas import cleanup_expired
from apps.identity.models import DiscoveryQuotaEvent, DiscoveryQuotaGate, User
from apps.orgs.community import bootstrap_community_workspace
from core.db.api_database_boundary import assert_writer_grants
from core.db.api_writer_role import grant_statements

ROOT = Path(__file__).resolve().parents[1]
URL = "/api/v1/auth/discover"
pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def writer():
    role = f"discovery_writer_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for statement in grant_statements(role):
            cursor.execute(statement)
        assert_writer_grants(cursor, role)
    try:
        yield role
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def _post_discover(client: Client, payload: dict[str, str], key_suffix: str) -> Any:
    return client.generic(
        "POST",
        URL,
        json.dumps(payload).encode("utf-8"),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"discover-writer-{key_suffix}",
    )


def _database_url(user: str, password: str) -> str:
    cfg = connection.settings_dict
    return (
        "postgresql://"
        + quote(user, safe="")
        + ":"
        + quote(password, safe="")
        + "@"
        + str(cfg["HOST"] or "127.0.0.1")
        + ":"
        + str(cfg["PORT"] or 5432)
        + "/"
        + quote(str(cfg["NAME"]), safe="")
    )


def test_discovery_quota_tables_have_zero_sequences_and_pass_assert_writer_grants(
    writer: str,
) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'S'
              AND c.relname LIKE 'identity_discoveryquota%'
            """
        )
        assert cursor.fetchall() == []
        assert_writer_grants(cursor, writer)

        for forbidden_grant in (
            f'GRANT DELETE ON TABLE "identity_discoveryquotagate" TO "{writer}"',
            f'GRANT UPDATE (id) ON TABLE "identity_discoveryquotagate" TO "{writer}"',
            f'GRANT UPDATE (scope) ON TABLE "identity_discoveryquotaevent" TO "{writer}"',
            f'GRANT SELECT (recorded_by_identity_id) ON TABLE "orgs_realmreadiness" TO "{writer}"',
        ):
            cursor.execute(forbidden_grant)
            try:
                with pytest.raises(DatabaseError, match="API database role refused"):
                    assert_writer_grants(cursor, writer)
            finally:
                revoke_stmt = forbidden_grant.replace("GRANT ", "REVOKE ").replace(
                    f' TO "{writer}"', f' FROM "{writer}"'
                )
                cursor.execute(revoke_stmt)
        assert_writer_grants(cursor, writer)


def test_writer_role_serves_community_tenant_and_email_discovery_and_prunes_expired_events(
    writer: str,
    ready,
    settings,
    http_signer,
) -> None:
    community_issuer = DEPLOYED_IDP + "community"
    expiry = int(time.time()) + 3600
    configure(
        settings,
        [
            trust_entry(http_signer, community_issuer, expires_at=expiry),
            trust_entry(http_signer, ready.organisation.issuer, expires_at=expiry),
            trust_entry(
                http_signer, DEPLOYED_IDP + "kodera-staff", lane="staff", expires_at=expiry
            ),
        ],
    )
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"
    settings.KODERA_DEFAULT_COMMUNITY_ISSUER = community_issuer

    owner = User.objects.create(email="community-owner@synthetic.test", display_name="Owner")
    bootstrap_community_workspace(owner_user_id=owner.id)
    DiscoveryQuotaGate.objects.get_or_create(singleton=True)

    expired = DiscoveryQuotaEvent.objects.create(
        scope="entry",
        digest="a" * 64,
        occurred_at=timezone.now() - timedelta(seconds=120),
    )

    client = Client()
    with acting_as(writer):
        assert current_user() == writer

        comm_res = _post_discover(client, {"slug": "community"}, "0001")
        assert comm_res.status_code == 200, comm_res.content
        comm_body = comm_res.json()
        assert comm_body["realm"] == "community"
        assert comm_body["issuer"] == community_issuer
        assert comm_body["openid_configuration_url"] == (
            community_issuer + "/.well-known/openid-configuration"
        )
        assert comm_body["organisation"]["slug"] == "community"
        assert int(comm_res["RateLimit-Remaining"]) >= 0

        tenant_res = _post_discover(client, {"slug": ready.organisation.slug}, "0002")
        assert tenant_res.status_code == 200, tenant_res.content
        tenant_body = tenant_res.json()
        assert tenant_body["realm"] == ready.organisation.slug
        assert tenant_body["issuer"] == ready.organisation.issuer
        assert int(tenant_res["RateLimit-Remaining"]) >= 0

        email_res = _post_discover(client, {"email": "person@example.com"}, "0003")
        assert email_res.status_code == 200, email_res.content
        assert email_res.json() == {
            "realm": None,
            "issuer": None,
            "openid_configuration_url": None,
            "organisation": None,
            "candidates": [],
        }
        assert int(email_res["RateLimit-Remaining"]) >= 0

        assert cleanup_expired() == 0
        assert current_user() == writer

    assert not DiscoveryQuotaEvent.objects.filter(id=expired.id).exists()
    assert sorted(DiscoveryQuotaEvent.objects.values_list("scope", flat=True)) == [
        "domain",
        "entry",
        "entry",
        "entry",
        "slug",
        "slug",
    ]


@pytest.mark.parametrize(
    ("statement", "expected_sqlstate"),
    [
        ("DELETE FROM identity_discoveryquotagate", INSUFFICIENT_PRIVILEGE),
        ("TRUNCATE identity_discoveryquotagate", INSUFFICIENT_PRIVILEGE),
        (
            "INSERT INTO identity_discoveryquotagate (id, singleton) VALUES (gen_random_uuid(), true)",
            INSUFFICIENT_PRIVILEGE,
        ),
        ("UPDATE identity_discoveryquotagate SET id = gen_random_uuid()", INSUFFICIENT_PRIVILEGE),
        ("UPDATE identity_discoveryquotagate SET singleton = false", CHECK_VIOLATION),
        ("UPDATE identity_discoveryquotaevent SET scope = 'slug'", INSUFFICIENT_PRIVILEGE),
        (
            "UPDATE identity_discoveryquotaevent SET digest = repeat('0', 64)",
            INSUFFICIENT_PRIVILEGE,
        ),
        ("TRUNCATE identity_discoveryquotaevent", INSUFFICIENT_PRIVILEGE),
        ("SELECT recorded_by_identity_id FROM orgs_realmreadiness", INSUFFICIENT_PRIVILEGE),
        ("SELECT recorded_by_realm FROM orgs_realmreadiness", INSUFFICIENT_PRIVILEGE),
        ("SELECT recorded_at FROM orgs_realmreadiness", INSUFFICIENT_PRIVILEGE),
        (
            "UPDATE orgs_realmreadiness SET revoked_at = clock_timestamp()",
            INSUFFICIENT_PRIVILEGE,
        ),
        ("DELETE FROM orgs_realmreadiness", INSUFFICIENT_PRIVILEGE),
    ],
)
def test_writer_role_cannot_tamper_with_discovery_gate_events_or_readiness_recorder(
    writer: str,
    ready,
    statement: str,
    expected_sqlstate: str,
) -> None:
    DiscoveryQuotaGate.objects.get_or_create(singleton=True)
    DiscoveryQuotaEvent.objects.create(scope="entry", digest="b" * 64)
    with acting_as(writer):
        assert refused(statement) == expected_sqlstate, statement


def test_configure_api_role_deploy_wsgi_serves_discover_over_kodera_api_login(
    monkeypatch,
    settings,
    http_signer,
) -> None:
    community_issuer = "https://id.synthetic.test/realms/community"
    trust_payload = [trust_entry(http_signer, community_issuer, expires_at=int(time.time()) + 3600)]
    configure(settings, trust_payload)
    settings.KODERA_DEFAULT_COMMUNITY_ORG_SLUG = "community"
    settings.KODERA_DEFAULT_COMMUNITY_ISSUER = community_issuer

    owner = User.objects.create(email="wsgi-owner@synthetic.test", display_name="WSGI Owner")
    bootstrap_community_workspace(owner_user_id=owner.id)
    DiscoveryQuotaGate.objects.get_or_create(singleton=True)

    api_password = secrets.token_urlsafe(32)
    api_url = _database_url("kodera_api", api_password)
    monkeypatch.setenv("KODERA_API_DATABASE_URL", api_url)
    monkeypatch.setenv(
        "KODERA_COLLAB_DATABASE_URL", _database_url("kodera_collab", secrets.token_urlsafe(32))
    )

    program = """
import json
from config.deploy_wsgi import application
from django.test import Client

client = Client()
out = {}
for label, payload, key in (
    ("slug", {"slug": "community"}, "wsgi-discover-0001"),
    ("email", {"email": "person@example.com"}, "wsgi-discover-0002"),
):
    res = client.generic(
        "POST",
        "/api/v1/auth/discover",
        json.dumps(payload).encode("utf-8"),
        content_type="application/json",
        HTTP_HOST="community.synthetic.test",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    out[label] = {"status": res.status_code, "body": res.json()}
print(json.dumps(out))
"""
    try:
        call_command("configure_api_role", stdout=StringIO())
        completed = subprocess.run(  # noqa: S603 - owned WSGI proof against disposable database
            [sys.executable, "-c", program],
            cwd=ROOT,
            env={
                "PATH": os.environ["PATH"],
                "PYTHONDONTWRITEBYTECODE": "1",
                "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                "DJANGO_ALLOWED_HOSTS": "community.synthetic.test,127.0.0.1,server",
                "DATABASE_URL": api_url,
                "KODERA_DISCOVERY_HMAC_KEY": base64.b64encode(KEY).decode("ascii"),
                "KODERA_AUTH_TRUST": json.dumps(trust_payload, separators=(",", ":")),
                "KODERA_DEFAULT_COMMUNITY_ORG_SLUG": "community",
                "KODERA_DEFAULT_COMMUNITY_ISSUER": community_issuer,
                "KODERA_BILLING_ENABLED": "false",
                "KODERA_EDITION": "community",
            },
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert completed.returncode == 0, (
            f"deploy_wsgi subprocess failed ({completed.returncode}):\n"
            f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
        )
        results = json.loads(completed.stdout)
        assert results["slug"]["status"] == 200, results
        assert results["slug"]["body"]["realm"] == "community"
        assert results["slug"]["body"]["issuer"] == community_issuer
        assert results["email"]["status"] == 200, results
        assert results["email"]["body"] == {
            "realm": None,
            "issuer": None,
            "openid_configuration_url": None,
            "organisation": None,
            "candidates": [],
        }
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier("kodera_api")))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier("kodera_api")))

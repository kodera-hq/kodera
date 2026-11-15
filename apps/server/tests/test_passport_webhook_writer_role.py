"""The API writer role's Passport, Stripe webhook, and EE billing table grants are enough and no more.

Verifies against real PostgreSQL (`SET ROLE` + `assert_writer_grants`):
1. A loginless role holding `core.db.api_writer_role.grant_statements` passes
   `core.db.api_database_boundary.assert_writer_grants` (zero `CREATE`, zero sequence privileges,
   zero `DELETE` outside explicit horizon/replay tables, and exact `UPDATE_COLUMNS`).
2. Under `SET ROLE`, Kodera Passport (`request`, `verify`, `workspaces`, `switch-workspace`) and
   signed Stripe webhooks (`checkout.session.completed`, `charge.refunded`, duplicate replay)
   succeed end-to-end.
3. Under `SET ROLE`, runtime DDL (`CREATE TABLE`), audit/webhook/ledger deletions, and immutable
   commercial/invoice column rewrites are refused by PostgreSQL with `42501` (`insufficient_privilege`).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, trust_entry
from django.db import connection
from django.test import Client
from django.utils import timezone
from test_billing_orders import offer, place, world as billing_world
from test_customer_persistence_models import anchor, anchor_models, identity
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused

import apps.billing.payments as payments_package
from apps.billing.models import Invoice, Order, Payment, PaymentLink, Subscription
from apps.billing.payments import services as payments
from apps.billing.payments.stripe import StripeProvider
from apps.workspaces.models import Workspace, WorkspaceQuota
from core.db.api_database_boundary import assert_writer_grants
from core.db.api_writer_role import grant_statements
from core.passport import compute_pkce_s256

pytestmark = pytest.mark.django_db

STRIPE_SECRET = "rk_" + "test_" + "SyntheticWriterRoleKey00"
WEBHOOK_SECRET = "wh" + "sec_" + "writer-role-hmac-01"
PKCE_VERIFIER = "v" * 43
PKCE_CHALLENGE = compute_pkce_s256(PKCE_VERIFIER)


@pytest.fixture
def writer():
    role = f"passport_webhook_writer_{uuid.uuid4().hex[:10]}"
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


def _sign_webhook(raw_body: bytes) -> str:
    ts = int(time.time())
    digest = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        f"{ts}.".encode("ascii") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return f"t={ts},v1={digest}"


def test_writer_role_serves_passport_and_stripe_webhooks_under_least_privilege(
    writer,
    settings,
    monkeypatch,
    http_signer,  # noqa: F811
):
    # 1. Seed two active organisations + memberships + workspaces as schema owner.
    seal_key = bytes(range(32))
    settings.KODERA_PASSPORT_HMAC_KEY = "passport-writer-role-hmac-secret-32b!!"
    settings.KODERA_PASSPORT_DELIVERY_SINK = None
    settings.KODERA_OUTBOX_SEAL_KEY = seal_key
    settings.KODERA_MAIL_LINK_ORIGINS = frozenset({"https://app.localhost"})
    settings.KODERA_PASSPORT_MAGIC_LINK = None
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"

    models = anchor_models()
    org_alpha, _, _ = anchor(models, slug="wr-alpha-" + uuid.uuid4().hex[:6])
    org_bravo, _, _ = anchor(models, slug="wr-bravo-" + uuid.uuid4().hex[:6])
    org_outsider, _, _ = anchor(models, slug="wr-out-" + uuid.uuid4().hex[:6])

    person = models.User.objects.create(
        email="writer.passport@acme.fr",
        display_name="Writer Role User",
    )
    identity(models, org_alpha, person, subject="wr-sub-alpha")
    identity(models, org_bravo, person, subject="wr-sub-bravo")
    now = timezone.now()
    models.Membership.objects.create(
        user=person,
        organisation=org_alpha,
        role="org_owner",
        state="active",
        accepted_at=now,
    )
    models.Membership.objects.create(
        user=person,
        organisation=org_bravo,
        role="org_admin",
        state="active",
        accepted_at=now,
    )
    Workspace.objects.create(organisation=org_alpha)
    Workspace.objects.create(organisation=org_bravo)
    configure(
        settings,
        [
            trust_entry(http_signer, org_alpha.issuer),
            trust_entry(http_signer, org_bravo.issuer),
            trust_entry(http_signer, org_outsider.issuer),
        ],
    )

    # 2. Seed an issued invoice + active Stripe Checkout PaymentLink as schema owner.
    provider = StripeProvider(
        secret_key=STRIPE_SECRET,
        webhook_secret=WEBHOOK_SECRET,
        transport=lambda method, url, headers, body: (
            200,
            json.dumps(
                {
                    "id": "cs_test_writer_role_001",
                    "url": "https://checkout.stripe.invalid/c/wr1",
                    "expires_at": int(time.time()) + 3600,
                }
            ).encode("utf-8"),
        ),
    )
    settings.KODERA_PAYMENT_PROVIDER = "stripe"
    settings.KODERA_STRIPE_SECRET_KEY = STRIPE_SECRET
    settings.KODERA_STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    settings.KODERA_PAYMENT_RETURN_ORIGINS = frozenset({"https://app.localhost"})
    monkeypatch.setattr(payments_package, "_stripe", lambda secret_key, webhook_secret: provider)

    bw = billing_world()
    Workspace.objects.create(organisation=bw.organisation)
    placed = place(bw, offer(), quantity=5)
    link = payments.create_payment_link(
        invoice_id=placed.invoice.id,
        organisation_id=bw.organisation.id,
        return_url="https://app.localhost/billing",
    ).link
    invoice_total = Invoice.objects.get(id=placed.invoice.id).total_incl_vat_minor

    from apps.outbox.mail.seal import unseal

    client = Client()

    # 3. Switch connection to `writer` (`kodera_api` grants only) and exercise production outbox enqueue.
    with acting_as(writer):
        assert current_user() == writer

        req_res = client.post(
            "/api/v1/auth/passport/magic-link/request",
            data=json.dumps(
                {
                    "email": "writer.passport@acme.fr",
                    "code_challenge": PKCE_CHALLENGE,
                    "code_challenge_method": "S256",
                }
            ).encode("utf-8"),
            content_type="application/json",
        )
        assert req_res.status_code == 202

    # Outbox sender (schema/worker role) reads sealed payload from outbox_message
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT delivery_id, sealed FROM outbox_message"
            " WHERE template_id = 'passport_magic_link'"
        )
        row = cursor.fetchone()
    assert row is not None
    delivery_uuid = row[0] if isinstance(row[0], uuid.UUID) else uuid.UUID(str(row[0]))
    opened = unseal(seal_key, delivery_uuid, bytes(row[1]))
    assert opened.recipient == "writer.passport@acme.fr"
    assert opened.secret is not None

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT user_id, organisation_id FROM identity_passportoutboxbinding"
            " WHERE delivery_id = %s",
            [delivery_uuid],
        )
        binding_row = cursor.fetchone()
    assert binding_row == (person.id, org_alpha.id)

    with acting_as(writer):
        assert current_user() == writer

        ver_res = client.post(
            "/api/v1/auth/passport/magic-link/verify",
            data=json.dumps(
                {
                    "token": opened.secret,
                    "code_verifier": PKCE_VERIFIER,
                }
            ).encode("utf-8"),
            content_type="application/json",
        )
        assert ver_res.status_code == 200
        session_token = ver_res.json()["session_token"]

        ws_res = client.get(
            "/api/v1/auth/passport/workspaces",
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        )
        assert ws_res.status_code == 200
        assert len(ws_res.json()["workspaces"]) == 2

        sw_res = client.post(
            "/api/v1/auth/passport/switch-workspace",
            data=json.dumps({"organisation_id": str(org_bravo.id)}).encode("utf-8"),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        )
        assert sw_res.status_code == 200
        assert sw_res.json()["active_organisation_id"] == str(org_bravo.id)

        denied_sw = client.post(
            "/api/v1/auth/passport/switch-workspace",
            data=json.dumps({"organisation_id": str(org_outsider.id)}).encode("utf-8"),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {session_token}",
        )
        assert denied_sw.status_code == 403

        # 3b. Signed Stripe webhook `checkout.session.completed` + non-G4 ignored + duplicate + `charge.refunded`
        cs_raw = json.dumps(
            {
                "id": "evt_wr_cs_completed_01",
                "type": "checkout.session.completed",
                "api_version": "2024-12-18.acacia",
                "created": int(time.time()),
                "data": {
                    "object": {
                        "id": link.provider_ref,
                        "payment_intent": "pi_wr_0001",
                        "payment_status": "paid",
                        "amount_total": invoice_total,
                        "currency": "eur",
                        "metadata": {
                            "organisation_id": str(bw.organisation.id),
                            "subscription_id": str(placed.subscription.id),
                        },
                    }
                },
            },
            separators=(",", ":"),
        ).encode("utf-8")
        wh_res = client.post(
            "/api/v1/webhooks/stripe",
            data=cs_raw,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=_sign_webhook(cs_raw),
        )
        assert wh_res.status_code == 200
        assert wh_res.json()["status"] == "applied"

        non_g4_raw = json.dumps(
            {
                "id": "evt_wr_sub_deleted_ignored_01",
                "type": "customer.subscription.deleted",
                "api_version": "2024-12-18.acacia",
                "created": int(time.time()) + 1,
                "data": {"object": {"id": "sub_wr_0001", "status": "canceled"}},
            },
            separators=(",", ":"),
        ).encode("utf-8")
        ign_res = client.post(
            "/api/v1/webhooks/stripe",
            data=non_g4_raw,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=_sign_webhook(non_g4_raw),
        )
        assert ign_res.status_code == 200
        assert ign_res.json()["status"] == "ignored_event_type"

        dup_res = client.post(
            "/api/v1/billing/webhooks/stripe",
            data=cs_raw,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=_sign_webhook(cs_raw),
        )
        assert dup_res.status_code == 200
        assert dup_res.json()["status"] == "duplicate"

        refund_raw = json.dumps(
            {
                "id": "evt_wr_refund_02",
                "type": "charge.refunded",
                "api_version": "2024-12-18.acacia",
                "created": int(time.time()) + 5,
                "data": {
                    "object": {
                        "id": "ch_wr_0002",
                        "payment_intent": "pi_wr_0001",
                        "amount": invoice_total,
                        "amount_refunded": invoice_total,
                        "currency": "eur",
                        "refunded": True,
                        "metadata": {"core_invoice_id": str(placed.invoice.id)},
                    }
                },
            },
            separators=(",", ":"),
        ).encode("utf-8")
        ref_res = client.post(
            "/api/v1/webhooks/stripe",
            data=refund_raw,
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE=_sign_webhook(refund_raw),
        )
        assert ref_res.status_code == 200
        assert ref_res.json()["status"] == "applied"

    assert Invoice.objects.get(id=placed.invoice.id).state == "paid"
    assert Order.objects.get(id=placed.order.id).state == "paid"
    assert PaymentLink.objects.get(id=link.id).state == "used"
    assert Payment.objects.get(provider="stripe", provider_ref="pi_wr_0001").state == "reversed"
    assert Subscription.objects.get(id=placed.subscription.id).state == "past_due"
    quota_after = WorkspaceQuota.objects.get(workspace__organisation_id=bw.organisation.id)
    assert quota_after.policy_ref.endswith(":past_due")


@pytest.mark.parametrize(
    "statement",
    [
        "CREATE TABLE forbidden_runtime_probe (id text PRIMARY KEY)",
        "DELETE FROM billing_stripewebhookdelivery",
        "TRUNCATE billing_stripewebhookdelivery",
        "DELETE FROM billing_providerevent",
        "UPDATE billing_invoice SET total_incl_vat_minor = 0",
        "UPDATE billing_invoice SET number = 'KODERA-2026-99999'",
        "DELETE FROM billing_payment",
        "DELETE FROM identity_passportoutboxbinding",
        "UPDATE identity_passportoutboxbinding SET user_id = user_id",
        "UPDATE ee_billing_purchase_orders SET subtotal_excl_vat_minor = 0",
        "UPDATE ee_billing_purchase_orders SET committed_seats = 999",
        "UPDATE ee_billing_purchase_orders SET pii_scrubbed_at = clock_timestamp()",
        "DELETE FROM ee_billing_purchase_orders",
        "DELETE FROM ee_billing_warm_pool_slots",
        "DELETE FROM ee_billing_sequences",
        "TRUNCATE ee_billing_purchase_orders",
    ],
)
def test_writer_role_is_refused_ddl_deletes_and_immutable_billing_columns(writer, statement):
    with acting_as(writer):
        assert refused(statement) == INSUFFICIENT_PRIVILEGE


def test_deploy_installed_apps_migration_graph_is_strictly_self_contained():
    """Every migration of every app in `config.settings.deploy.INSTALLED_APPS` must resolve all
    dependencies strictly within `config.settings.deploy.INSTALLED_APPS` (no `outbox` or
    `extensions` edge that would break `migrate --settings config.settings.deploy`)."""
    import ast
    from pathlib import Path

    from django.db.migrations.graph import MigrationGraph
    from django.db.migrations.loader import MigrationLoader

    server_root = Path(__file__).resolve().parents[1]
    deploy_path = server_root / "config" / "settings" / "deploy.py"
    base_path = server_root / "config" / "settings" / "base.py"

    def _extract_installed_apps(src_path: Path) -> list[str]:
        tree = ast.parse(src_path.read_text(encoding="utf-8"))
        out: list[str] = []
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "INSTALLED_APPS":
                        if isinstance(node.value, (ast.List, ast.Tuple)):
                            for elt in node.value.elts:
                                if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                    out.append(elt.value)
        return out

    deploy_entries = _extract_installed_apps(base_path) + _extract_installed_apps(deploy_path)
    deploy_labels = {entry.rsplit(".", 1)[-1] for entry in deploy_entries}
    assert "outbox" not in deploy_labels
    assert "extensions" not in deploy_labels
    assert {"identity", "orgs", "billing"} <= deploy_labels

    loader = MigrationLoader(None, ignore_no_migrations=True)
    loader.load_disk()

    deploy_graph = MigrationGraph()
    deploy_migrations = {
        key: migration
        for key, migration in loader.disk_migrations.items()
        if key[0] in deploy_labels
    }
    assert ("identity", "0007_passport_magic_link") in deploy_migrations
    assert ("billing", "0024_enterprise_billing_tables") in deploy_migrations

    for key, migration in sorted(deploy_migrations.items()):
        deploy_graph.add_node(key, migration)

    for key, migration in sorted(deploy_migrations.items()):
        for dep in migration.dependencies:
            dep_app, dep_name = dep[0], dep[1]
            assert dep_app in deploy_labels, (
                f"deploy migration {key} depends on non-deploy app {dep_app}.{dep_name}"
            )
            deploy_graph.add_dependency(
                f"{key[0]}.{key[1]}", key, (dep_app, dep_name), skip_validation=False
            )

    deploy_graph.validate_consistency()


def test_fresh_database_community_deploy_then_deploy_operator_then_configure_api_role():
    """Reproduce `deploy/community/docker-compose.yml`'s exact 3-step migrator sequence on a
    fresh PostgreSQL database:
      1. `python manage.py migrate --noinput --settings config.settings.deploy`
      2. `python manage.py migrate --noinput --settings config.settings.deploy_operator`
      3. `python manage.py configure_api_role --settings config.settings.deploy`
    """
    import os
    import subprocess
    import sys
    import uuid
    from pathlib import Path
    from urllib.parse import quote

    import psycopg
    from django.db import connection

    server_root = Path(__file__).resolve().parents[1]
    cfg = connection.settings_dict
    host = cfg["HOST"] or "127.0.0.1"
    port = int(cfg["PORT"] or 5432)
    user = str(cfg["USER"])
    password = str(cfg["PASSWORD"] or "")
    admin_db = str(cfg["NAME"])

    suffix = uuid.uuid4().hex[:10]
    fresh_db = f"kodera_fresh_{suffix}"
    fresh_role = "kodera_api"
    role_pass = "a" * 36

    with psycopg.connect(
        host=host,
        port=port,
        dbname=admin_db,
        user=user,
        password=password,
        autocommit=True,
    ) as admin_conn:
        had_role = (
            admin_conn.execute(
                "SELECT 1 FROM pg_roles WHERE rolname = %s",
                [fresh_role],
            ).fetchone()
            is not None
        )
        admin_conn.execute(f'CREATE DATABASE "{fresh_db}"')

    with psycopg.connect(
        host=host,
        port=port,
        dbname=fresh_db,
        user=user,
        password=password,
        autocommit=True,
    ) as fresh_init_conn:
        fresh_init_conn.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")

    try:
        userinfo = (
            f"{quote(user, safe='')}:{quote(password, safe='')}"
            if password
            else quote(user, safe="")
        )
        db_url = f"postgresql://{userinfo}@{host}:{port}/{fresh_db}"
        api_db_url = f"postgresql://{fresh_role}:{role_pass}@{host}:{port}/{fresh_db}"

        env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(server_root),
            "DJANGO_SECRET_KEY": "synthetic-deploy-only-" + "abc0123456789" * 5,
            "DJANGO_ALLOWED_HOSTS": "community.synthetic.test,127.0.0.1",
            "DATABASE_URL": db_url,
            "KODERA_API_DATABASE_URL": api_db_url,
            "KODERA_AUTH_TRUST": "",
            "KODERA_BILLING_ENABLED": "false",
        }

        for cmd in (
            [
                sys.executable,
                "manage.py",
                "migrate",
                "--noinput",
                "--settings",
                "config.settings.deploy",
            ],
            [
                sys.executable,
                "manage.py",
                "migrate",
                "--noinput",
                "--settings",
                "config.settings.deploy_operator",
            ],
            [
                sys.executable,
                "manage.py",
                "configure_api_role",
                "--settings",
                "config.settings.deploy",
            ],
        ):
            completed = subprocess.run(  # noqa: S603
                cmd,
                cwd=str(server_root),
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            assert completed.returncode == 0, (
                f"command {' '.join(cmd[2:])} failed ({completed.returncode}):\n"
                f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
            )

        with psycopg.connect(
            host=host,
            port=port,
            dbname=fresh_db,
            user=fresh_role,
            password=role_pass,
            autocommit=True,
        ) as role_conn:
            row = role_conn.execute(
                "SELECT has_column_privilege(current_user, 'ee_billing_purchase_orders',"
                " 'countersigned_by_user_id', 'UPDATE'),"
                " has_column_privilege(current_user, 'ee_billing_purchase_orders',"
                " 'pii_scrubbed_at', 'UPDATE')"
            ).fetchone()
            assert row == (True, False)
    finally:
        with psycopg.connect(
            host=host,
            port=port,
            dbname=admin_db,
            user=user,
            password=password,
            autocommit=True,
        ) as cleanup_conn:
            cleanup_conn.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
                [fresh_db],
            )
            cleanup_conn.execute(f'DROP DATABASE IF EXISTS "{fresh_db}"')
            if not had_role:
                cleanup_conn.execute(f'DROP ROLE IF EXISTS "{fresh_role}"')

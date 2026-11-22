"""Real gthread requests with persisted authorization and synthetic external transports."""

import http.client
import json
import os
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer, token, trust_entry
from django.db import connection
from psycopg import sql
from workspace_safety.test_moderation import world as world

from apps.workspaces.models import Channel, ResourcePolicy
from core.db.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def api_login():
    role = "concurrency_" + uuid4().hex[:12]
    password = "synthetic-concurrency-password-" + uuid4().hex
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("CREATE ROLE {} LOGIN NOINHERIT PASSWORD {}").format(
                sql.Identifier(role), sql.Literal(password)
            )
        )
        cursor.execute(
            sql.SQL("REVOKE CREATE, TEMP ON DATABASE {} FROM PUBLIC").format(
                sql.Identifier(connection.settings_dict["NAME"])
            )
        )
        for statement in grant_statements(role):
            cursor.execute(statement)
    try:
        yield role, password
    finally:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))


def test_real_gthread_authenticated_endpoints_and_slow_body_isolation(
    world, http_signer, tmp_path, api_login
):
    org, workspace, _, tokens = world
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    channel = Channel.objects.create(
        workspace=workspace,
        name="Uploads",
        kind="text",
        lifecycle="active",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )
    now = int(time.time())
    credential = token(
        http_signer,
        org.issuer,
        subject=tokens[3].subject,
        iat=now,
        exp=now + 600,
        nbf=now - 1,
        email_verified=True,
    )
    # Token verification, authorization, transactions, replay and audit are production code.
    # Only object storage, DNS and preview network transports are synthetic.
    module = """
from config.deploy_wsgi import application
from django.conf import settings
from datetime import timedelta
from django.utils import timezone
from apps.media import services, unfurl, outbound
from cryptography.hazmat.primitives.asymmetric import ec
from apps.notifications import push
class Gateway:
    def call(self, operation, obj):
        return {"url": "https://storage.example.org/" + obj.key,
                "headers": {"Content-Type": obj.content_type},
                "expiresAt": (timezone.now() + timedelta(seconds=250)).isoformat()}
services._gateway = Gateway
outbound.addresses = lambda *args: ["93.184.216.34"]
settings.KODERA_NOTIFICATION_SEAL_KEY = bytes(range(32))
settings.KODERA_PUSH_VAPID_PUBLIC_KEY = push.public_key(ec.generate_private_key(ec.SECP256R1()))
def fetch(url, **kwargs):
    return {"url": url, "canonicalUrl": url, "title": "Synthetic", "description": "", "siteName": ""}
unfurl.unfurl = fetch
"""
    (tmp_path / "concurrent_wsgi.py").write_text(module)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    database = connection.settings_dict
    role, password = api_login
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(tmp_path) + os.pathsep + str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SECRET_KEY": "synthetic-concurrency-" + "ab1234" * 10,
        "DJANGO_ALLOWED_HOSTS": "127.0.0.1",
        "KODERA_CONSOLE_CLIENT_ID": "synthetic-console",
        "KODERA_AUTH_TRUST": json.dumps(
            [trust_entry(http_signer, org.issuer, expires_at=now + 600)]
        ),
        "DATABASE_URL": f"postgresql://{role}:{password}@{database['HOST']}:{database['PORT']}/{database['NAME']}",
    }
    log = tmp_path / "gunicorn.log"

    def request(method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid4()),
            "Authorization": "Bearer " + credential,
        }
        try:
            conn.request(
                method, path, body=None if body is None else json.dumps(body), headers=headers
            )
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    partial = []
    with log.open("w") as output:
        process = subprocess.Popen(  # noqa: S603 - fixed config and owned synthetic module
            [
                sys.executable,
                "-m",
                "gunicorn",
                "-c",
                "config/gunicorn.py",
                "--bind",
                f"127.0.0.1:{port}",
                "--worker-tmp-dir",
                str(tmp_path),
                "concurrent_wsgi:application",
            ],
            cwd=ROOT,
            env=env,
            stdout=output,
            stderr=output,
        )
        try:
            for _ in range(100):
                assert process.poll() is None, log.read_text()
                try:
                    if request("GET", "/health/live")[0] == 200:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.05)
            else:
                pytest.fail("Gunicorn did not start: " + log.read_text())
            base = f"/api/v1/organisations/{org.id}/workspace"
            for _ in range(16):
                sock = socket.create_connection(("127.0.0.1", port), timeout=3)
                sock.sendall(
                    b"POST /api/v1/slow HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    b"Content-Length: 1048575\r\n\r\nx"
                )
                partial.append(sock)
            time.sleep(0.3)
            with ThreadPoolExecutor(8) as pool:
                results = list(
                    pool.map(lambda i: request("GET", base if i % 2 else "/health/live"), range(32))
                )
            assert all(status == 200 for status, _ in results), (results, log.read_text()[-6000:])
            for sock in partial:
                sock.shutdown(socket.SHUT_WR)
                sock.close()
            partial.clear()
            time.sleep(0.3)
            from cryptography.hazmat.primitives.asymmetric import ec

            from apps.notifications import push

            subscription = {
                "endpoint": "https://push.example.org/wake",
                "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
                "auth": push.encode(bytes(16)),
            }
            operations = [
                ("GET", base, None, 200),
                (
                    "POST",
                    base + "/attachments/uploads",
                    {
                        "filename": "test.txt",
                        "contentType": "text/plain",
                        "sizeBytes": 1,
                        "sha256": "a" * 64,
                        "channelId": str(channel.id),
                    },
                    201,
                ),
                ("PUT", "/api/v1/push/subscriptions/" + str(uuid4()), subscription, 204),
                ("POST", base + "/unfurl", {"url": "https://public.example.org/page"}, 200),
            ]
            with ThreadPoolExecutor(4) as pool:
                for _ in range(4):
                    results = list(pool.map(lambda op: request(*op[:3]), operations))
                    assert [status for status, _ in results] == [op[3] for op in operations], (
                        results
                    )
        finally:
            for sock in partial:
                sock.close()
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    assert "Traceback" not in log.read_text(), log.read_text()
    assert "Error handling request" not in log.read_text(), log.read_text()

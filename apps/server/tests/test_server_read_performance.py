"""Issuer routing, status parity, and workspace read/write transaction boundaries."""

import base64
import json
from dataclasses import replace
from types import SimpleNamespace
from uuid import uuid4

import pytest
from django.utils import timezone
from test_access_tokens import (
    claims,
    frozen_clock as frozen_clock,
    sign,
    signer as signer,
    snapshot,
)
from workspace_media.test_media_services import gateway as gateway, upload
from workspace_media.test_notification_services import configured as configured, register
from workspace_safety.test_moderation import world as world

from apps.billing import tenant_reads
from services.identity import trusted_issuers
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import TrustedIssuer


@pytest.mark.parametrize("position", [0, 7])
def test_issuer_routing_verifies_only_the_matching_snapshot(signer, monkeypatch, position):
    admitted = snapshot([signer[2]])
    entries = [
        TrustedIssuer(
            "customer", replace(admitted, issuer=f"https://issuer-{i}.test/"), ("console",)
        )
        for i in range(8)
    ]
    entries[position] = TrustedIssuer("customer", admitted, ("console",))
    calls = []
    real = trusted_issuers.verify_access_token

    def verify(compact, *, admitted):
        calls.append(admitted.issuer)
        return real(compact, admitted=admitted)

    monkeypatch.setattr(trusted_issuers, "verify_access_token", verify)
    verified, lane = trusted_issuers.verify_configured_token(sign(signer), trusted=tuple(entries))
    assert lane == "customer" and verified.issuer == admitted.issuer
    assert calls == [admitted.issuer]


@pytest.mark.parametrize("issuer", ["https://unknown.test/", None, [], {"nested": "issuer"}])
def test_untrusted_or_invalid_issuer_never_reaches_signature_verification(
    signer, monkeypatch, issuer
):
    def unexpected(*args, **kwargs):
        raise AssertionError("an unmatched issuer reached signature verification")

    monkeypatch.setattr(trusted_issuers, "verify_access_token", unexpected)
    parts = sign(signer).split(".")
    parts[1] = (
        base64.urlsafe_b64encode(json.dumps(claims(iss=issuer)).encode()).rstrip(b"=").decode()
    )
    with pytest.raises(TokenVerificationError):
        trusted_issuers.verify_configured_token(
            ".".join(parts),
            trusted=(TrustedIssuer("customer", snapshot([signer[2]]), ("console",)),),
        )


@pytest.mark.parametrize(
    "status,overall",
    [
        ("ordered", "maintenance"),
        ("provisioning", "maintenance"),
        ("ready", "operational"),
        ("active", "operational"),
        ("maintenance", "maintenance"),
        ("failed", "major_outage"),
        ("suspended", "major_outage"),
    ],
)
def test_empty_community_application_list_preserves_pending_and_failure_status(
    monkeypatch, settings, status, overall
):
    row = SimpleNamespace(
        id=uuid4(),
        organisation_id=uuid4(),
        status=status,
        apps=[],
        slug="community",
        is_default_community=True,
        status_changed_at=timezone.now(),
    )
    settings.KODERA_TENANT_APP_URLS = {}
    monkeypatch.setattr(tenant_reads.tenancy, "tenant_of", lambda **kwargs: row)
    monkeypatch.setattr(tenant_reads.tenancy, "newest_tenant_not_deleted", lambda _: row)
    monkeypatch.setattr(tenant_reads, "last_heartbeat", lambda **kwargs: None)
    monkeypatch.setattr(tenant_reads, "dunning", lambda _: ("current", None))
    detail = tenant_reads.tenant_status(row.organisation_id, row.id)
    summary = tenant_reads.status_summary(row.organisation_id)
    assert detail["apps"] == [] and detail["status"] == status
    assert summary["tenant_id"] == detail["tenant_id"] and summary["overall"] == overall


@pytest.mark.parametrize("exists", [True, False])
def test_staff_community_prepares_membership_only_when_the_current_read_misses(monkeypatch, exists):
    from apps.identity import services
    from apps.orgs import community

    principal = SimpleNamespace(
        id=uuid4(),
        user_id=uuid4(),
        user=object(),
        issuer="https://staff.test/",
        realm="community",
        subject="staff",
        email="staff@example.test",
    )
    member = SimpleNamespace(organisation_id=uuid4())
    reads, preparations = [], []

    def current(**kwargs):
        reads.append(1)
        return (principal, member) if exists or len(reads) > 1 else None

    monkeypatch.setattr(community, "configured_slug", lambda: "community")
    monkeypatch.setattr(community, "community_member", current)
    monkeypatch.setattr(
        community, "ensure_community_membership", lambda **kwargs: preparations.append(1)
    )
    monkeypatch.setattr(services, "person_memberships", lambda **kwargs: ())
    result = services.read_staff_community(verified=SimpleNamespace(amr=None))
    assert result.current_identity_id == principal.id
    assert len(reads) == (1 if exists else 2) and len(preparations) == (0 if exists else 1)


@pytest.fixture
def workspace_operations(world, gateway, configured):
    from uuid import UUID

    from apps.media import services as media
    from apps.notifications import services as notifications
    from apps.notifications.models import Notification

    org, _, members, tokens = world
    common = {"verified": tokens[3], "organisation_id": org.id}
    attachment_id = UUID(upload(world, gateway)["attachmentId"])
    subscription = register(world)
    entries = [
        Notification.objects.create(
            organisation=org,
            membership=members[3],
            kind=kind,
            resource_id=members[3].id,
        )
        for kind in ("moderation", "invitation", "mention", "document")
    ]
    return {
        "create_upload": lambda: upload(world, gateway),
        "complete_upload": lambda: media.complete_upload(
            **common, attachment_id=attachment_id, request_id=str(uuid4())
        ),
        "put_subscription": lambda: register(world, endpoint="https://push.example.org/new"),
        "delete_subscription": lambda: notifications.delete_subscription(
            verified=tokens[3], device_id=subscription.device_id, request_id=str(uuid4())
        ),
        "mark_read": lambda: notifications.mark_read(
            verified=tokens[3], ids=[entries[0].id], request_id=str(uuid4())
        ),
        "get_attachment": lambda: media.get_attachment(**common, attachment_id=attachment_id),
        "authorize": lambda: media.authorize(tokens[3], org.id),
        "inbox": lambda: notifications.inbox(verified=tokens[3], cursor=None, limit=10),
    }


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["get_attachment", "authorize", "inbox"])
def test_media_and_inbox_reads_do_no_writes_or_update_locks(world, workspace_operations, operation):
    from django.db import connection, transaction
    from django.test.utils import CaptureQueriesContext

    # Complete the attachment before entering the read-only transaction.
    workspace_operations["complete_upload"]()
    with CaptureQueriesContext(connection) as queries, transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
        workspace_operations[operation]()
    assert not any("FOR UPDATE" in query["sql"].upper() for query in queries)


WRITE_OPERATIONS = [
    "create_upload",
    "complete_upload",
    "put_subscription",
    "delete_subscription",
    "mark_read",
]


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", WRITE_OPERATIONS)
def test_media_and_notification_writes_lock_workspace_before_other_rows(
    workspace_operations, operation
):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as queries:
        workspace_operations[operation]()
    locks = [query["sql"].upper() for query in queries if "FOR UPDATE" in query["sql"].upper()]
    assert locks and "WORKSPACES_WORKSPACE" in locks[0]
    assert "FOR NO KEY UPDATE" not in locks[0]


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", WRITE_OPERATIONS)
def test_revoked_media_and_notification_writers_never_lock_workspace(
    world, workspace_operations, operation
):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    from apps.identity.models import Identity
    from apps.media.context import RefusalError

    _, _, members, _ = world
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    with CaptureQueriesContext(connection) as queries, pytest.raises(RefusalError) as denied:
        workspace_operations[operation]()
    assert denied.value.status == 403
    assert not any("FOR UPDATE" in query["sql"].upper() for query in queries)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", WRITE_OPERATIONS)
@pytest.mark.parametrize("action", ["ban", "kick"])
def test_waiting_media_and_notification_writers_recheck_moderation(
    world, workspace_operations, operation, action
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections, connection, transaction

    from apps.media.context import RefusalError
    from apps.workspaces import moderation

    org, _, members, tokens = world
    locking = Event()

    def observe_lock(execute, sql, params, many, context):
        if "FOR UPDATE" in sql.upper() and "workspaces_workspace" in sql.lower():
            locking.set()
        return execute(sql, params, many, context)

    def write():
        close_old_connections()
        try:
            with connection.execute_wrapper(observe_lock):
                try:
                    workspace_operations[operation]()
                except RefusalError as error:
                    return error.status
                return "accepted"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as workers:
        with transaction.atomic():
            moderation.moderate(
                verified=tokens[2],
                organisation_id=org.id,
                target_id=members[3].id,
                action=action,
                reason="Example",
                expires_at=None,
                request_id=str(uuid4()),
            )
            pending = workers.submit(write)
            assert locking.wait(timeout=5), "writer never acquired the workspace fence"
        assert pending.result(timeout=5) == 403

"""Database and current-member boundaries of object tickets and completion."""

import hashlib
import secrets
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity
from apps.media import services as service
from apps.media.context import RefusalError
from apps.media.models import Attachment
from apps.media.storage import ObjectMismatchError, StorageRefusedError
from apps.orgs.models import Membership, Organisation, SlugReservation

pytestmark = pytest.mark.django_db


class FakeGateway:
    def __init__(self):
        self.calls = []
        self.reject = False

    def call(self, operation, obj):
        self.calls.append((operation, obj))
        if self.reject:
            if operation == "verify":
                raise ObjectMismatchError()
            raise StorageRefusedError()
        if operation == "verify":
            return {"verified": True}
        return {
            "url": "https://storage.example.org/" + obj.key,
            "headers": {"Content-Type": obj.content_type},
            "expiresAt": (timezone.now() + timedelta(seconds=250)).isoformat(),
        }


@pytest.fixture
def gateway(monkeypatch):
    result = FakeGateway()
    monkeypatch.setattr(service, "_gateway", lambda: result)
    return result


def upload(world, gateway):
    org, _, _, tokens = world
    return service.create_upload(
        verified=tokens[3],
        organisation_id=org.id,
        body={
            "filename": "example.txt",
            "contentType": "text/plain",
            "sizeBytes": 42,
            "sha256": hashlib.sha256(secrets.token_bytes(42)).hexdigest(),
        },
        request_id=str(uuid4()),
    )


def test_completion_verifies_actual_object_and_download_rechecks_membership(world, gateway):
    org, _, members, tokens = world
    ticket = upload(world, gateway)
    row = Attachment.objects.get(pk=ticket["attachmentId"])
    assert row.organisation_id == org.id and row.uploader_id == members[3].id
    assert gateway.calls[0][1].key.startswith(f"organisations/{org.id}/attachments/")
    with pytest.raises(RefusalError) as denied:
        service.complete_upload(
            verified=tokens[2],
            organisation_id=org.id,
            attachment_id=row.id,
            request_id=str(uuid4()),
        )
    assert denied.value.status == 403
    assert row.completed_at is None
    completed = service.complete_upload(
        verified=tokens[3], organisation_id=org.id, attachment_id=row.id, request_id=str(uuid4())
    )
    assert completed["disposition"] == "attachment"
    assert [operation for operation, _ in gateway.calls] == ["upload", "verify", "download"]
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    with pytest.raises(RefusalError) as denied:
        service.get_attachment(verified=tokens[3], organisation_id=org.id, attachment_id=row.id)
    assert denied.value.status == 403
    assert len(gateway.calls) == 3


def test_failed_checksum_completion_and_absent_signer_never_publish_metadata(world, gateway):
    org, _, _, tokens = world
    ticket = upload(world, gateway)
    gateway.reject = True
    with pytest.raises(RefusalError) as failed:
        service.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=ticket["attachmentId"],
            request_id=str(uuid4()),
        )
    assert failed.value.status == 409
    assert Attachment.objects.get(pk=ticket["attachmentId"]).completed_at is None
    with pytest.raises(RefusalError) as failed:
        upload(world, gateway)
    assert failed.value.status == 503
    assert Attachment.objects.count() == 1


def test_database_refuses_an_attachment_uploader_from_another_organisation(world):
    org, _, members, _ = world
    with transaction.atomic():
        slug = "media-" + uuid4().hex[:12]
        other = Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.example.org/realms/{slug}",
            name="Example",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=other,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        foreign = Membership.objects.create(
            organisation=other,
            user=members[0].user,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        Attachment.objects.create(
            organisation=org,
            uploader=foreign,
            filename="example.txt",
            content_type="text/plain",
            size_bytes=1,
            sha256=hashlib.sha256(b"example").hexdigest(),
            upload_expires_at=timezone.now() + timedelta(minutes=5),
        )

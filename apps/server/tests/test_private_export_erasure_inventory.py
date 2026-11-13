"""Original private-export deadlines are authoritative erasure input, never a guessed TTL."""

import json
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, connection, transaction
from test_core_erasure import begin
from test_privacy_journal import started
from workspace_safety.test_moderation import world as world

from apps.orgs.erasure_services import database_now
from apps.orgs.privacy_models import PrivacyErasure, PrivacyExport

pytestmark = pytest.mark.django_db(transaction=True)


def test_workspace_inventory_keeps_original_snapshot_expiry_even_when_current_expiry_was_shortened(
    world,
):
    state, export = started(world)
    PrivacyExport.objects.filter(pk=export.id).update(
        expires_at=database_now() + timedelta(seconds=1)
    )
    row = begin(world[0])
    assert row.inventory["private_exports"] == [str(export.id)]
    assert row.inventory["private_export_expiries"] == {str(export.id): state.request.expires_at}
    export.refresh_from_db()
    assert export.status == "expired"
    assert export.request_snapshot["expires_at"] == state.request.expires_at


@pytest.mark.parametrize(
    "mutation", ["missing", "string", "fraction", "namespace", "person", "window", "future_created"]
)
def test_malformed_legacy_export_deadline_or_scope_refuses_admission_without_inference(
    world, mutation
):
    state, export = started(world)
    snapshot = dict(export.request_snapshot)
    if mutation == "missing":
        snapshot.pop("expires_at")
    elif mutation == "string":
        snapshot["expires_at"] = str(state.request.expires_at)
    elif mutation == "fraction":
        snapshot["expires_at"] = 1.25
    elif mutation == "namespace":
        snapshot["id"] = str(uuid4())
    elif mutation == "person":
        snapshot["user_id"] = str(uuid4())
    elif mutation == "future_created":
        snapshot["created_at"] = int(database_now().timestamp()) + 3600
        snapshot["expires_at"] = snapshot["created_at"] + 600
    else:
        snapshot["expires_at"] = snapshot["created_at"] + 86401
    PrivacyExport.objects.filter(pk=export.id).update(request_snapshot=snapshot)
    with pytest.raises(IntegrityError, match="original export expiry"), transaction.atomic():
        begin(world[0])
    assert not PrivacyErasure.objects.exists()
    world[0].refresh_from_db()
    assert world[0].state == "active"


def test_private_expiry_helper_refuses_missing_export_rows_and_keeps_map_exact(world):
    _, export = started(world)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT privacy_export_expiry_inventory(%s::jsonb)", [json.dumps([str(export.id)])]
        )
        assert set(json.loads(cursor.fetchone()[0])) == {str(export.id)}
    with (
        pytest.raises(IntegrityError, match="inventory incomplete"),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(
            "SELECT privacy_export_expiry_inventory(%s::jsonb)", [json.dumps([str(uuid4())])]
        )

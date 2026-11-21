"""Confidential channel designation migration, immutability, and channel-set emission (BUG-0012)."""

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from test_access_tokens import frozen_clock as frozen_clock
from test_customer_persistence_migrations import empty_database
from test_espace_channel_set import latest
from test_espace_structure import (
    CHANNELS,
    create_channel,
    e as e,
    patch_channel,
    send,
)
from test_workspace_metadata_schema import schema_objects
from test_workspace_onboarding import (
    http_signer as http_signer,
    problem,
    w as w,
)
from workspace_quotas.test_retention_migration_timeouts import finite_ddl

from apps.workspaces.models import Channel

pytestmark = pytest.mark.django_db(transaction=True)


def test_confidential_channel_migration_round_trips_with_finite_ddl(django_db_blocker, monkeypatch):
    with django_db_blocker.unblock(), empty_database() as database:
        with finite_ddl(database, monkeypatch, None) as observed:
            MigrationExecutor(database).migrate(
                [("workspaces", "0015_confidential_channel_designation")]
            )
            before = schema_objects(database)
            MigrationExecutor(database).migrate([("workspaces", "0014_iam_scope_guards")])
            MigrationExecutor(database).migrate(
                [("workspaces", "0015_confidential_channel_designation")]
            )
            assert schema_objects(database) == before
        assert {
            ("workspaces", "0015_confidential_channel_designation", "forward"),
            ("workspaces", "0015_confidential_channel_designation", "reverse"),
        } <= observed


def test_confidential_channel_creation_immutability_and_channel_set_emission(e):
    ordinary = create_channel(e, None, "ordinary-notes")
    confidential = create_channel(e, None, "board-confidential", confidential=True)

    assert Channel.objects.get(id=ordinary["id"]).is_confidential is False
    assert Channel.objects.get(id=confidential["id"]).is_confidential is True

    emitted = {item["channel_id"]: item for item in latest(e).channels}
    assert "confidential" not in emitted[ordinary["id"]]
    assert emitted[confidential["id"]]["confidential"] == "io.kodera.mls.v1"

    audio_refused = send(
        e,
        e.owner,
        "post",
        CHANNELS,
        {"category_id": None, "kind": "audio", "name": "secret-voice", "confidential": True},
    )
    doc = problem(audio_refused, 422, "validation-error")
    assert doc["errors"] == [{"pointer": "/confidential", "code": "not_applicable"}]

    patch_refused = patch_channel(e, confidential, {"confidential": False})
    patch_doc = problem(patch_refused, 422, "validation-error")
    assert patch_doc["errors"] == [{"pointer": "/confidential", "code": "unexpected"}]

    with (
        pytest.raises(IntegrityError, match="channel_confidential_immutable"),
        transaction.atomic(),
    ):
        Channel.objects.filter(id=confidential["id"]).update(is_confidential=False)

    with (
        pytest.raises(IntegrityError, match="channel_confidential_immutable"),
        transaction.atomic(),
    ):
        row = Channel.objects.get(id=confidential["id"])
        row.is_confidential = False
        row.save(update_fields=["is_confidential"])

    with (
        pytest.raises(IntegrityError, match="channel_confidential_immutable"),
        transaction.atomic(),
    ):
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE workspaces_channel SET is_confidential = false WHERE id = %s",
                [confidential["id"]],
            )

    with (
        pytest.raises(IntegrityError, match="channel_confidential_text_only"),
        transaction.atomic(),
    ):
        Channel.objects.create(
            workspace_id=Channel.objects.get(id=confidential["id"]).workspace_id,
            category_id=None,
            kind=Channel.Kind.AUDIO,
            name="raw-audio-confidential",
            position=99,
            is_confidential=True,
        )

    from test_espace_structure import ARCHIVE

    archived = send(e, e.owner, "post", ARCHIVE, channel_id=confidential["id"])
    assert archived.status_code == 200, archived.content
    archived_emitted = {item["channel_id"]: item for item in latest(e).channels}
    assert archived_emitted[confidential["id"]]["archived"] is True
    assert archived_emitted[confidential["id"]]["confidential"] == "io.kodera.mls.v1"

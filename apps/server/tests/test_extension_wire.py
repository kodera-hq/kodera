"""Signed body scope and rotation are stable SDK-compatible transcripts."""

import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest

from apps.extensions.wire import ExtensionRefusedError, event_payload, signed_delivery

NOW = datetime(2026, 11, 13, 12, tzinfo=UTC)
SECRET = "synthetic-current-webhook-key-00000000"
OLD = "synthetic-previous-webhook-key-0000000"


def vector(**values):
    return signed_delivery(
        **{
            "organisation_id": UUID(int=1),
            "installation_id": UUID(int=2),
            "delivery_id": UUID(int=3),
            "generation": UUID(int=4),
            "event": event_payload("command.invoked", {"text": "hello"}),
            "secret": SECRET,
            "now": NOW,
            **values,
        }
    )


def test_primary_transcript_preserves_v1_and_signed_body_binds_scope():
    result = vector()
    body = json.loads(result.body)
    assert body["organisation_id"] == str(UUID(int=1))
    assert body["installation_id"] == str(UUID(int=2))
    assert body["delivery_id"] == str(UUID(int=3))
    assert (
        result.headers["X-Kodera-Signature-256"]
        == "v1="
        + hmac.digest(
            SECRET.encode(), str(int(NOW.timestamp())).encode() + b"." + result.body, "sha256"
        ).hex()
    )
    assert (
        body["event_sha256"]
        == hashlib.sha256(event_payload("command.invoked", {"text": "hello"})).hexdigest()
    )


def test_rotation_is_separate_and_ends_at_exact_absolute_boundary():
    grace = NOW + timedelta(hours=1)
    result = vector(previous_generation=UUID(int=5), previous_secret=OLD, grace_expires_at=grace)
    assert result.headers["X-Kodera-Previous-Signature-256"].startswith("v1=")
    assert json.loads(result.body)["previous_key_generation"] == str(UUID(int=5))
    result = vector(
        now=grace, previous_generation=UUID(int=5), previous_secret=OLD, grace_expires_at=grace
    )
    assert "X-Kodera-Previous-Signature-256" not in result.headers
    assert "previous_key_generation" not in json.loads(result.body)


@pytest.mark.parametrize(
    "values",
    [
        {"secret": "short"},
        {"now": NOW.replace(tzinfo=None)},
        {"event": b'{"type":"command.invoked","data":NaN}'},
        {
            "grace_expires_at": NOW + timedelta(days=2),
            "previous_generation": UUID(int=5),
            "previous_secret": OLD,
        },
        {
            "grace_expires_at": NOW + timedelta(hours=1),
            "previous_generation": UUID(int=4),
            "previous_secret": OLD,
        },
    ],
)
def test_malformed_keys_clocks_payloads_and_rotation_refuse(values):
    with pytest.raises(ExtensionRefusedError):
        vector(**values)


def test_rotation_refuses_reused_key_material_even_with_new_generation():
    with pytest.raises(ExtensionRefusedError, match="rotation_key_reused"):
        vector(
            previous_generation=UUID(int=5),
            previous_secret=SECRET,
            grace_expires_at=NOW + timedelta(hours=1),
        )


def test_queue_payload_reserves_space_for_authenticated_scope_envelope():
    from apps.extensions.wire import MAX_BODY

    with pytest.raises(ExtensionRefusedError, match="payload_bound"):
        event_payload("command.invoked", {"text": "x" * (MAX_BODY - 500)})


@pytest.mark.parametrize(
    "action,metadata",
    [
        ("arbitrary.action", {}),
        ("installed", {"generation": "synthetic", "email": "private@example.test"}),
    ],
)
def test_local_audit_writer_refuses_unknown_actions_and_extra_private_fields(action, metadata):
    from apps.extensions.services import audit

    with pytest.raises(ValueError, match="audit action or metadata refused"):
        audit(action, None, UUID(int=1), UUID(int=2), metadata)

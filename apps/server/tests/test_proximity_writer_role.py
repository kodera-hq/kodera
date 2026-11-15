"""The mounted radio HTTP operations use only the admitted API role's grants."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
import time_machine
from django.db import connection
from django.test import Client
from test_intake_writer_role import acting_as, current_user
from test_proximity_broker import (
    ISSUER_A,
    NOW,
    WORKSPACE_A,
    WORKSPACE_B,
    _mint_jwt,
    _post_json,
    broker_env as broker_env,
    es256_signer as es256_signer,
)

from apps.proximity.services import mint_ephemeral_beacon_token_with_epoch_key
from core.db.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def api_role(broker_env):
    # Provision only the canonical policy, using the migration owner before SET ROLE.
    role = f"proximity_http_{uuid4().hex[:12]}"
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


def test_all_mounted_radio_operations_and_tenant_refusal_under_api_role(api_role, es256_signer):
    client = Client()
    bearer = _mint_jwt(es256_signer, "user-bob", issuer=ISSUER_A)
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False), acting_as(api_role):
        assert current_user() == api_role
        lease_response = _post_json(
            client,
            "/api/v1/proximity/bootstrap",
            {"workspace_id": str(WORKSPACE_A)},
            bearer=bearer,
        )
        assert lease_response.status_code == 200, lease_response.content
        lease = lease_response.json()
        token = mint_ephemeral_beacon_token_with_epoch_key(
            epoch_mac_key=bytes.fromhex(lease["epoch_mac_key"]),
            device_ephemeral_seed=b"r" * 32,
            workspace_id=WORKSPACE_A,
            event_scope="default",
            epoch=lease["epoch"],
            epoch_expires_at=lease["epoch_expires_at"],
            now_unix_secs=NOW,
            counter=0,
        )
        checked_in = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {"workspace_id": str(WORKSPACE_A), "beacon_token": token},
            bearer=bearer,
        )
        assert checked_in.status_code == 201, checked_in.content
        nearby = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}",
            headers={"Authorization": f"Bearer {bearer}"},
        )
        assert nearby.status_code == 200, nearby.content
        resolved = _post_json(
            client,
            "/api/v1/proximity/resolve",
            {
                "workspace_id": str(WORKSPACE_A),
                "observed_tokens": [{"beacon_token": token}],
            },
            bearer=bearer,
        )
        assert resolved.status_code == 200, resolved.content
        refused = _post_json(
            client,
            "/api/v1/proximity/bootstrap",
            {"workspace_id": str(WORKSPACE_B)},
            bearer=bearer,
        )
        assert refused.status_code == 404, refused.content
        checked_out = _post_json(
            client,
            "/api/v1/proximity/checkout",
            {"workspace_id": str(WORKSPACE_A)},
            bearer=bearer,
        )
        assert checked_out.status_code == 200, checked_out.content
        assert current_user() == api_role

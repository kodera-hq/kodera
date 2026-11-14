"""End-to-end HTTP & cryptographic tests for the zero-GPS `#proximity` check-in broker."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import jwt
import pytest
import time_machine
from cryptography.hazmat.primitives.asymmetric import ec
from django.test import Client

from apps.proximity.services import (
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
    PROXIMITY_EPOCH_ROTATION_SECS,
    ProximityBroker,
    hkdf_expand_sha256,
    hkdf_extract_sha256,
)
from config.environment import allowed_oidc_client_ids
from services.identity import trusted_issuers

NOW = 2_000_000_100
ISSUER = "https://identity.invalid/realms/kodera-prox-test"
WORKSPACE_A = UUID("01950000-0000-7000-8000-0000000000a1")
WORKSPACE_B = UUID("01950000-0000-7000-8000-0000000000b2")


@pytest.fixture
def es256_signer() -> tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]]:
    key = ec.generate_private_key(ec.SECP256R1())
    public = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    public.update(kid="prox-test-key", alg="ES256", use="sig", key_ops=["verify"])
    return key, "ES256", public


@pytest.fixture
def broker_env(
    settings: object, es256_signer: tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]]
) -> ProximityBroker:
    broker = ProximityBroker(broker_secret=bytes(range(1, 33)))
    entries = [
        {
            "lane": "customer",
            "issuer": ISSUER,
            "generation": "prox-test-gen",
            "expires_at": NOW + 10_800,
            "public_jwks": {"keys": [es256_signer[2]]},
        }
    ]
    allowed = allowed_oidc_client_ids({"KODERA_CONSOLE_CLIENT_ID": "synthetic-console"})
    settings.ROOT_URLCONF = "apps.proximity.urls"  # type: ignore[attr-defined]
    settings.KODERA_PROXIMITY_BROKER = broker  # type: ignore[attr-defined]
    settings.KODERA_AUTH_TRUST = trusted_issuers.load_trust(  # type: ignore[attr-defined]
        json.dumps(entries), allowed_azp=allowed
    )
    return broker


def _mint_jwt(
    signer: tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]],
    subject: str,
    *,
    now_ts: int = NOW,
) -> str:
    key, algorithm, public = signer
    payload = {
        "iss": ISSUER,
        "sub": subject,
        "aud": "kodera-server",
        "iat": now_ts,
        "exp": now_ts + 7_200,
        "typ": "Bearer",
        "azp": "console",
    }
    return jwt.encode(payload, key, algorithm=algorithm, headers={"kid": str(public["kid"])})


def _post_json(
    client: Client, path: str, body: dict[str, object], bearer: str | None = None
) -> Any:
    if bearer is not None:
        return client.post(
            path,
            data=json.dumps(body),
            content_type="application/json",
            headers={"Authorization": f"Bearer {bearer}"},
        )
    return client.post(
        path,
        data=json.dumps(body),
        content_type="application/json",
    )


def test_rfc5869_hkdf_vector_matches_rust_core() -> None:
    ikm = bytes([0x0B]) * 22
    salt = bytes.fromhex("000102030405060708090a0b0c")
    info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
    prk = hkdf_extract_sha256(salt, ikm)
    assert prk.hex() == "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
    okm = hkdf_expand_sha256(prk, info, 42)
    assert (
        okm.hex()
        == "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    )


def test_opt_in_checkin_and_mutual_peer_resolution(
    broker_env: ProximityBroker,
    es256_signer: tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]],
) -> None:
    client = Client()
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False):
        alice_jwt = _mint_jwt(es256_signer, "user-alice")
        bob_jwt = _mint_jwt(es256_signer, "user-bob")

        alice_seed = bytes([0x41]) * 32
        bob_seed = bytes([0x42]) * 32

        alice_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=alice_seed,
            now_unix_secs=NOW,
            counter=0,
        )
        bob_tok_0 = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=bob_seed,
            now_unix_secs=NOW,
            counter=0,
        )
        bob_tok_1 = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=bob_seed,
            now_unix_secs=NOW + 5,
            counter=1,
        )

        # Unauthenticated check-in is refused 401.
        unauth = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {"workspace_id": str(WORKSPACE_A), "beacon_token": alice_tok},
        )
        assert unauth.status_code == 401

        # Before opting in, Alice CANNOT query /nearby or /resolve (mutual opt-in required!).
        pre_nearby = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}",
            HTTP_AUTHORIZATION=f"Bearer {alice_jwt}",
        )
        assert pre_nearby.status_code == 403
        assert pre_nearby.json()["reason"] == "caller_not_checked_in"

        # Alice opts in with default 30m TTL; Bob opts in with custom note and 1h TTL.
        alice_res = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {
                "workspace_id": str(WORKSPACE_A),
                "beacon_token": alice_tok,
                "status_note": "Salle B · café",
                "handle": "alice-prox",
                "transport": "ble",
                "distance_band": "immediate",
            },
            bearer=alice_jwt,
        )
        assert alice_res.status_code == 201
        alice_body = alice_res.json()
        assert alice_body["ttl_seconds"] == DEFAULT_TTL_SECONDS
        assert alice_body["gps_persisted"] is False
        assert alice_body["status_note"] == "Salle B · café"

        bob_res = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {
                "workspace_id": str(WORKSPACE_A),
                "beacon_token": bob_tok_0,
                "ttl_seconds": 3600,
                "status_note": "Open space nord",
                "handle": "bob-lan",
                "transport": "mdns_quic",
                "distance_band": "near",
            },
            bearer=bob_jwt,
        )
        assert bob_res.status_code == 201

        # Mutual resolution: Alice scans Bob's next counter emission `bob_tok_1` over BLE.
        resolve_res = _post_json(
            client,
            "/api/v1/proximity/resolve",
            {
                "workspace_id": str(WORKSPACE_A),
                "observed_tokens": [
                    {
                        "beacon_token": bob_tok_1,
                        "distance_band": "immediate",
                        "transport": "ble",
                    }
                ],
            },
            bearer=alice_jwt,
        )
        assert resolve_res.status_code == 200
        peers = resolve_res.json()["peers"]
        assert len(peers) == 1
        assert peers[0]["handle"] == "bob-lan"
        assert peers[0]["status_note"] == "Open space nord"
        assert peers[0]["distance_band"] == "immediate"
        assert peers[0]["transport"] == "ble"

        # Nearby listing returns Bob to Alice (and never leaks principal subjects or GPS).
        nearby_res = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}",
            HTTP_AUTHORIZATION=f"Bearer {alice_jwt}",
        )
        assert nearby_res.status_code == 200
        nearby_body = nearby_res.json()
        assert nearby_body["self"]["handle"] == "alice-prox"
        assert [p["handle"] for p in nearby_body["peers"]] == ["bob-lan"]


def test_cross_workspace_and_event_scope_isolation(
    broker_env: ProximityBroker,
    es256_signer: tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]],
) -> None:
    client = Client()
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False):
        alice_jwt = _mint_jwt(es256_signer, "user-alice")
        charlie_jwt = _mint_jwt(es256_signer, "user-charlie")
        dana_jwt = _mint_jwt(es256_signer, "user-dana")

        alice_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            event_scope="summit-hall",
            device_seed=bytes([0x11]) * 32,
            now_unix_secs=NOW,
        )
        charlie_ws_b_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_B,
            event_scope="summit-hall",
            device_seed=bytes([0x22]) * 32,
            now_unix_secs=NOW,
        )
        dana_other_scope_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            event_scope="quiet-library",
            device_seed=bytes([0x33]) * 32,
            now_unix_secs=NOW,
        )

        assert (
            _post_json(
                client,
                "/api/v1/proximity/checkin",
                {
                    "workspace_id": str(WORKSPACE_A),
                    "event_scope": "summit-hall",
                    "beacon_token": alice_tok,
                },
                bearer=alice_jwt,
            ).status_code
            == 201
        )
        assert (
            _post_json(
                client,
                "/api/v1/proximity/checkin",
                {
                    "workspace_id": str(WORKSPACE_B),
                    "event_scope": "summit-hall",
                    "beacon_token": charlie_ws_b_tok,
                },
                bearer=charlie_jwt,
            ).status_code
            == 201
        )
        assert (
            _post_json(
                client,
                "/api/v1/proximity/checkin",
                {
                    "workspace_id": str(WORKSPACE_A),
                    "event_scope": "quiet-library",
                    "beacon_token": dana_other_scope_tok,
                },
                bearer=dana_jwt,
            ).status_code
            == 201
        )

        # Alice sees zero peers in WORKSPACE_A / summit-hall.
        nearby = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}&event_scope=summit-hall",
            HTTP_AUTHORIZATION=f"Bearer {alice_jwt}",
        )
        assert nearby.status_code == 200
        assert nearby.json()["peers"] == []

        # Submitting Charlie's WORKSPACE_B token to WORKSPACE_A /resolve fails HKDF MAC check (422).
        cross_resolve = _post_json(
            client,
            "/api/v1/proximity/resolve",
            {
                "workspace_id": str(WORKSPACE_A),
                "event_scope": "summit-hall",
                "observed_tokens": [{"beacon_token": charlie_ws_b_tok}],
            },
            bearer=alice_jwt,
        )
        assert cross_resolve.status_code == 422
        assert cross_resolve.json()["reason"] == "invalid_beacon_proof"


def test_expired_hkdf_token_ttl_bounds_and_instant_checkout_wipe(
    broker_env: ProximityBroker,
    es256_signer: tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]],
) -> None:
    client = Client()
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False):
        alice_jwt = _mint_jwt(es256_signer, "user-alice", now_ts=NOW)
        bob_jwt = _mint_jwt(es256_signer, "user-bob", now_ts=NOW)

        alice_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=bytes([0x51]) * 32,
            now_unix_secs=NOW,
        )
        bob_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=bytes([0x52]) * 32,
            now_unix_secs=NOW,
        )

        # TTL > 2h (7201s) is strictly refused with 422.
        too_long = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {
                "workspace_id": str(WORKSPACE_A),
                "beacon_token": alice_tok,
                "ttl_seconds": MAX_TTL_SECONDS + 1,
            },
            bearer=alice_jwt,
        )
        assert too_long.status_code == 422
        assert too_long.json()["reason"] == "ttl_out_of_bounds"

        # Stale HKDF token minted 30 minutes ago (2 epochs old) is refused with 422.
        stale_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=bytes([0x53]) * 32,
            now_unix_secs=NOW - (2 * PROXIMITY_EPOCH_ROTATION_SECS),
        )
        stale_res = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {"workspace_id": str(WORKSPACE_A), "beacon_token": stale_tok},
            bearer=alice_jwt,
        )
        assert stale_res.status_code == 422
        assert stale_res.json()["reason"] == "token_epoch_expired"

        # Valid 15-minute opt-ins for Alice and Bob.
        assert (
            _post_json(
                client,
                "/api/v1/proximity/checkin",
                {
                    "workspace_id": str(WORKSPACE_A),
                    "beacon_token": alice_tok,
                    "ttl_seconds": 900,
                    "handle": "alice-ephemeral",
                },
                bearer=alice_jwt,
            ).status_code
            == 201
        )
        assert (
            _post_json(
                client,
                "/api/v1/proximity/checkin",
                {
                    "workspace_id": str(WORKSPACE_A),
                    "beacon_token": bob_tok,
                    "ttl_seconds": 3600,
                    "handle": "bob-ephemeral",
                },
                bearer=bob_jwt,
            ).status_code
            == 201
        )

        # Instant checkout wipe for Bob!
        checkout_res = _post_json(
            client,
            "/api/v1/proximity/checkout",
            {"workspace_id": str(WORKSPACE_A)},
            bearer=bob_jwt,
        )
        assert checkout_res.status_code == 200
        assert checkout_res.json() == {
            "workspace_id": str(WORKSPACE_A),
            "checked_out": True,
            "purged_records": 1,
        }

        # Bob disappears immediately from Alice's /nearby and /resolve!
        nearby_after = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}",
            HTTP_AUTHORIZATION=f"Bearer {alice_jwt}",
        )
        assert nearby_after.status_code == 200
        assert nearby_after.json()["peers"] == []

        resolve_after = _post_json(
            client,
            "/api/v1/proximity/resolve",
            {
                "workspace_id": str(WORKSPACE_A),
                "observed_tokens": [{"beacon_token": bob_tok}],
            },
            bearer=alice_jwt,
        )
        assert resolve_after.status_code == 200
        assert resolve_after.json()["peers"] == []

    # Advance clock past Alice's 15-minute (900s) check-in TTL -> auto-purged!
    with time_machine.travel(datetime.fromtimestamp(NOW + 901, UTC), tick=False):
        alice_jwt_later = _mint_jwt(es256_signer, "user-alice", now_ts=NOW + 901)
        expired_nearby = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}",
            HTTP_AUTHORIZATION=f"Bearer {alice_jwt_later}",
        )
        assert expired_nearby.status_code == 403
        assert expired_nearby.json()["reason"] == "caller_not_checked_in"


@pytest.mark.parametrize(
    "forbidden_payload",
    [
        {"latitude": 48.8566, "longitude": 2.3522},
        {"lat": 48.8566, "lng": 2.3522},
        {"gps": "48.8566,2.3522"},
        {"coordinates": [2.3522, 48.8566]},
        {"geolocation": {"accuracy_meters": 5}},
    ],
)
def test_strict_privacy_wall_rejects_any_gps_coordinates_with_422(
    broker_env: ProximityBroker,
    es256_signer: tuple[ec.EllipticCurvePrivateKey, str, dict[str, object]],
    forbidden_payload: dict[str, object],
) -> None:
    client = Client()
    with time_machine.travel(datetime.fromtimestamp(NOW, UTC), tick=False):
        alice_jwt = _mint_jwt(es256_signer, "user-alice")
        alice_tok = broker_env.mint_client_token(
            workspace_id=WORKSPACE_A,
            device_seed=bytes([0x61]) * 32,
            now_unix_secs=NOW,
        )

        # 1. Refused on /checkin
        checkin_gps = _post_json(
            client,
            "/api/v1/proximity/checkin",
            {
                "workspace_id": str(WORKSPACE_A),
                "beacon_token": alice_tok,
                **forbidden_payload,
            },
            bearer=alice_jwt,
        )
        assert checkin_gps.status_code == 422
        assert checkin_gps.json()["type"] == "https://kodera.io/problems/gps-coordinates-forbidden"
        assert checkin_gps.json()["reason"] == "gps_coordinates_forbidden"

        # 2. Refused when nested inside /resolve observed_tokens
        resolve_gps = _post_json(
            client,
            "/api/v1/proximity/resolve",
            {
                "workspace_id": str(WORKSPACE_A),
                "observed_tokens": [{"beacon_token": alice_tok, **forbidden_payload}],
            },
            bearer=alice_jwt,
        )
        assert resolve_gps.status_code == 422
        assert resolve_gps.json()["reason"] == "gps_coordinates_forbidden"

        # 3. Refused on /nearby query parameters
        nearby_gps = client.get(
            f"/api/v1/proximity/nearby?workspace_id={WORKSPACE_A}&latitude=48.8566&longitude=2.3522",
            HTTP_AUTHORIZATION=f"Bearer {alice_jwt}",
        )
        assert nearby_gps.status_code == 422
        assert nearby_gps.json()["reason"] == "gps_coordinates_forbidden"

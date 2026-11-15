"""One-epoch capability issuance and cross-language byte-identity proof."""

import json
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from apps.proximity.services import (
    ProximityBroker,
    ProximityRefusalError,
    _compute_token_mac,
    _derive_epoch_mac_key,
    mint_ephemeral_beacon_token,
    mint_ephemeral_beacon_token_with_epoch_key,
    verify_ephemeral_beacon_token,
)

NOW = 1_800_000_100
WORKSPACE = UUID("01950000-0000-7000-8000-0000000000a1")
FIXTURE = (
    Path(__file__).resolve().parents[3] / "packages/kodera-rs/vectors/proximity-epoch-lease-v1.json"
)


def test_bootstrap_exports_exact_current_epoch_material_and_no_master() -> None:
    broker = ProximityBroker()
    lease = broker.bootstrap(workspace_id=WORKSPACE, now_unix_secs=NOW)
    assert set(lease) == {
        "workspace_id",
        "event_scope",
        "epoch",
        "epoch_mac_key",
        "epoch_expires_at",
        "epoch_rotation_seconds",
    }
    assert lease["epoch"] == NOW // 900
    assert lease["epoch_expires_at"] == (NOW // 900 + 1) * 900
    assert lease["epoch_mac_key"] != broker.workspace_beacon_key(WORKSPACE).hex()
    later = broker.bootstrap(workspace_id=WORKSPACE, now_unix_secs=NOW + 900)
    assert lease["epoch_mac_key"] != later["epoch_mac_key"]


def test_direct_epoch_key_preserves_the_frozen_wire_fixture() -> None:
    fixture = json.loads(FIXTURE.read_text())
    master = bytes.fromhex(fixture["reference_workspace_master_key"])
    lease = fixture["bootstrap"]
    inputs = dict(
        workspace_id=UUID(lease["workspace_id"]),
        event_scope=lease["event_scope"],
        device_ephemeral_seed=bytes.fromhex(fixture["device_seed"]),
        now_unix_secs=fixture["now_unix_seconds"],
        counter=fixture["counter"],
    )
    reference = mint_ephemeral_beacon_token(workspace_master_key=master, **inputs)
    assert (
        _derive_epoch_mac_key(
            master, inputs["workspace_id"], inputs["event_scope"], lease["epoch"]
        ).hex()
        == lease["epoch_mac_key"]
    )
    direct = mint_ephemeral_beacon_token_with_epoch_key(
        epoch_mac_key=bytes.fromhex(lease["epoch_mac_key"]),
        epoch=lease["epoch"],
        epoch_expires_at=lease["epoch_expires_at"],
        **inputs,
    )
    assert direct == reference == fixture["token_hex"]


@pytest.mark.parametrize("offset", [-900, 900, 365 * 24 * 60 * 60])
def test_saved_epoch_key_cannot_authorize_another_wall_clock_epoch(offset: int) -> None:
    broker = ProximityBroker()
    lease = broker.bootstrap(workspace_id=WORKSPACE, now_unix_secs=NOW)
    key = bytes.fromhex(lease["epoch_mac_key"])
    with pytest.raises(ValueError, match="expired or future epoch MAC lease"):
        mint_ephemeral_beacon_token_with_epoch_key(
            epoch_mac_key=key,
            epoch=lease["epoch"],
            epoch_expires_at=lease["epoch_expires_at"],
            device_ephemeral_seed=bytes([7]) * 32,
            workspace_id=WORKSPACE,
            event_scope="default",
            now_unix_secs=NOW + offset,
        )


def test_revoked_member_ignoring_lease_cannot_forge_a_future_epoch_mac() -> None:
    broker = ProximityBroker()
    lease = broker.bootstrap(workspace_id=WORKSPACE, now_unix_secs=NOW)
    future = NOW + 365 * 24 * 60 * 60
    # The attacker can rewrite the clock metadata and frame header, but cannot derive the next key.
    body = b"KT\x01\x00" + (future // 900).to_bytes(4, "big") + bytes(4) + bytes([7]) * 8
    fake = (
        body + _compute_token_mac(bytes.fromhex(lease["epoch_mac_key"]), WORKSPACE, "default", body)
    ).hex()
    with pytest.raises(ProximityRefusalError, match="invalid_beacon_proof"):
        verify_ephemeral_beacon_token(
            fake,
            workspace_master_key=broker.workspace_beacon_key(WORKSPACE),
            workspace_id=WORKSPACE,
            event_scope="default",
            now_unix_secs=future,
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"epoch": True},
        {"epoch": -1},
        {"epoch": 0x100000000},
        {"epoch_expires_at": True},
        {"epoch_expires_at": (NOW // 900 + 1) * 900 + 60},
        {"now_unix_secs": float("nan")},
        {"counter": True},
        {"counter": -1},
        {"counter": 0x100000000},
        {"epoch_mac_key": bytes(32)},
        {"epoch_mac_key": bytes(31)},
        {"device_ephemeral_seed": bytes(32)},
        {"device_ephemeral_seed": bytes([3]) * 32},
    ],
)
def test_malformed_epoch_capabilities_cannot_mint(changes: dict[str, object]) -> None:
    inputs: dict[str, Any] = dict(
        epoch_mac_key=bytes([3]) * 32,
        epoch=NOW // 900,
        epoch_expires_at=(NOW // 900 + 1) * 900,
        now_unix_secs=NOW,
        counter=0,
        device_ephemeral_seed=bytes([7]) * 32,
        workspace_id=WORKSPACE,
        event_scope="default",
    )
    inputs.update(changes)
    with pytest.raises(ValueError):
        mint_ephemeral_beacon_token_with_epoch_key(**inputs)

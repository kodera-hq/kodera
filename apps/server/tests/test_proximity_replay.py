"""Production routing and server-side epoch replay admission regressions."""

from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import pytest
from django.urls import resolve

from apps.proximity import services
from apps.proximity.api import views
from apps.proximity.services import ProximityBroker, ProximityRefusalError

WORKSPACE = UUID("01950000-0000-7000-8000-0000000000a1")
NOW = 1_800_000_100


@pytest.mark.parametrize("endpoint", ["bootstrap", "checkin", "resolve", "nearby", "checkout"])
def test_proximity_routes_are_mounted_in_customer_profile(endpoint: str) -> None:
    match = resolve(f"/api/v1/proximity/{endpoint}", urlconf="config.customer_urls")
    assert match.func is getattr(views, endpoint)


def token(broker: ProximityBroker, counter: int, now: int = NOW, seed: int = 1) -> str:
    return broker.mint_client_token(
        workspace_id=WORKSPACE,
        device_seed=bytes([seed]) * 32,
        counter=counter,
        now_unix_secs=now,
    )


def checkin(
    broker: ProximityBroker, wire: str, principal: str = "alice", now: int = NOW
) -> dict[str, object]:
    return broker.checkin(
        principal_key=principal,
        workspace_id=WORKSPACE,
        beacon_token_hex=wire,
        now_unix_secs=now,
    )


def test_replay_and_lower_counter_refuse_without_replacing_checkin() -> None:
    broker = ProximityBroker()
    first = checkin(broker, token(broker, 10))
    for counter in [10, 9, 0]:
        with pytest.raises(ProximityRefusalError, match="beacon_counter_replayed") as refusal:
            checkin(broker, token(broker, counter), now=NOW + 1)
        assert refusal.value.status == 409
    current = broker.nearby(principal_key="alice", workspace_id=WORKSPACE, now_unix_secs=NOW)
    assert current["self"]["expires_at"] == first["expires_at"]
    assert checkin(broker, token(broker, 11))["epoch"] == first["epoch"]


def test_checkout_retains_replay_binding_until_epoch_expires() -> None:
    broker = ProximityBroker()
    wire = token(broker, 3)
    checkin(broker, wire)
    broker.checkout(principal_key="alice", workspace_id=WORKSPACE, now_unix_secs=NOW)
    with pytest.raises(ProximityRefusalError, match="beacon_counter_replayed"):
        checkin(broker, wire)
    with pytest.raises(ProximityRefusalError, match="beacon_pseudonym_already_claimed"):
        checkin(broker, token(broker, 4), principal="bob")
    checkin(broker, token(broker, 4))


def test_concurrent_duplicate_has_exactly_one_admission() -> None:
    broker = ProximityBroker()
    wire = token(broker, 0)

    def submit(_: int) -> int:
        try:
            checkin(broker, wire)
        except ProximityRefusalError as refusal:
            return refusal.status
        return 201

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(submit, range(16)))
    assert outcomes.count(201) == 1
    assert outcomes.count(409) == 15


def test_replay_capacity_refuses_without_eviction_and_reclaims_expired_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(services, "MAX_REPLAY_BINDINGS", 2)
    broker = ProximityBroker()
    checkin(broker, token(broker, 0, seed=1))
    checkin(broker, token(broker, 0, seed=2))
    with pytest.raises(ProximityRefusalError, match="broker_replay_capacity_reached") as refusal:
        checkin(broker, token(broker, 0, seed=3))
    assert refusal.value.status == 503
    with pytest.raises(ProximityRefusalError, match="beacon_counter_replayed"):
        checkin(broker, token(broker, 0, seed=1))
    later = ((NOW // 900) + 1) * 900 + 60
    assert checkin(broker, token(broker, 0, now=later, seed=3), now=later)["epoch"] == later // 900


def test_new_epoch_resets_counter_and_clear_resets_all_replay_state() -> None:
    broker = ProximityBroker()
    checkin(broker, token(broker, 100))
    later = NOW + 900
    wire = token(broker, 0, now=later)
    checkin(broker, wire, now=later)
    broker.clear()
    checkin(broker, wire, now=later)


def test_previous_epoch_binding_survives_skew_until_exact_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(services, "MAX_REPLAY_BINDINGS", 1)
    broker = ProximityBroker()
    old = token(broker, 2)
    checkin(broker, old)
    boundary = ((NOW // 900) + 1) * 900
    with pytest.raises(ProximityRefusalError, match="beacon_counter_replayed"):
        checkin(broker, old, now=boundary + 59)
    new = token(broker, 0, now=boundary + 59)
    with pytest.raises(ProximityRefusalError, match="broker_replay_capacity_reached"):
        checkin(broker, new, now=boundary + 59)
    checkin(broker, new, now=boundary + 60)
    with pytest.raises(ProximityRefusalError, match="token_epoch_expired"):
        checkin(broker, old, now=boundary + 60)


def test_replay_state_is_isolated_by_workspace_and_event_scope() -> None:
    broker = ProximityBroker()
    other_workspace = UUID("01950000-0000-7000-8000-0000000000b2")
    for workspace, scope in [
        (WORKSPACE, "default"),
        (WORKSPACE, "another-event"),
        (other_workspace, "default"),
    ]:
        wire = broker.mint_client_token(
            workspace_id=workspace,
            event_scope=scope,
            device_seed=bytes([1]) * 32,
            counter=0,
            now_unix_secs=NOW,
        )
        broker.checkin(
            principal_key="alice",
            workspace_id=workspace,
            event_scope=scope,
            beacon_token_hex=wire,
            now_unix_secs=NOW,
        )


def test_failed_presence_capacity_does_not_consume_token_counter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(services, "MAX_ACTIVE_CHECKINS", 1)
    broker = ProximityBroker()
    checkin(broker, token(broker, 0))
    pending = token(broker, 0, seed=2)
    with pytest.raises(ProximityRefusalError, match="broker_capacity_reached"):
        checkin(broker, pending, principal="bob")
    broker.checkout(principal_key="alice", workspace_id=WORKSPACE, now_unix_secs=NOW)
    checkin(broker, pending, principal="bob")

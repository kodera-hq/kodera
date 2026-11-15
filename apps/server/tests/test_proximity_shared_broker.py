"""Independent-process acceptance and bounded protocol refusals for shared ephemeral presence."""

import io
import json
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from apps.proximity import broker_rpc
from apps.proximity.api.views import _active_broker
from apps.proximity.broker_rpc import (
    MAX_REQUEST_BYTES,
    BrokerGateway,
    dispatch,
)
from apps.proximity.services import (
    ProximityBroker,
    ProximityRefusalError,
    mint_ephemeral_beacon_token_with_epoch_key,
)

WORKSPACE = "01950000-0000-7000-8000-0000000000a1"
CLIENT = """
import json, sys
from apps.proximity.broker_rpc import BrokerGateway, ProximityRefusalError
request = json.load(sys.stdin)
try:
    result = BrokerGateway(sys.argv[1]).call(request['operation'], **request['arguments'])
except ProximityRefusalError as error:
    result = {'error': error.status, 'reason': error.reason}
print(json.dumps(result))
"""

FIXED_NOW = 1_800_000_100
SERVER = """
import sys
from apps.proximity import broker_rpc, services
services.time.time = lambda: 1_800_000_100
raise SystemExit(broker_rpc.main())
"""


class RunningBroker:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.process: subprocess.Popen[bytes] | None = None
        self.start()

    def start(self) -> None:
        self.process = subprocess.Popen(  # noqa: S603 - fixed interpreter/module and private synthetic socket
            [sys.executable, "-c", SERVER, str(self.path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        deadline = time.monotonic() + 5
        while not self.path.exists():
            if self.process.poll() is not None:
                assert self.process.stderr is not None
                detail = self.process.stderr.read(4096).decode("utf-8", "replace")
                self.process.stderr.close()
                pytest.fail(f"shared broker exited before binding: {detail}")
            assert time.monotonic() < deadline, "shared broker did not bind"
            time.sleep(0.02)

    def stop(self) -> None:
        assert self.process is not None
        self.process.terminate()
        self.process.wait(timeout=5)
        assert self.process.returncode == 0
        if self.process.stderr is not None:
            self.process.stderr.close()

    def call(self, operation: str, **arguments: object) -> dict[str, Any]:
        # Human-readable fixture names stand for canonical opaque identity IDs on the private wire.
        principal_ids = {
            "alice": "01950000-0000-7000-8000-000000000001",
            "bob": "01950000-0000-7000-8000-000000000002",
        }
        principal = arguments.get("principal_key")
        if isinstance(principal, str) and principal in principal_ids:
            arguments["principal_key"] = principal_ids[principal]
        result = subprocess.run(  # noqa: S603 - fixed interpreter and synthetic fixture input
            [sys.executable, "-c", CLIENT, str(self.path)],
            input=json.dumps({"operation": operation, "arguments": arguments}),
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        return json.loads(result.stdout)


@pytest.fixture
def shared_broker() -> Iterator[RunningBroker]:
    # macOS Unix socket paths are limited; keep ownership-private fixtures short.
    with tempfile.TemporaryDirectory(
        prefix="cx-broker-", dir=Path(Path(tempfile.gettempdir()).anchor, "tmp").resolve()
    ) as directory:
        broker = RunningBroker(Path(directory) / "broker.sock")
        try:
            yield broker
        finally:
            broker.stop()


def wire(master: str, seed: int, counter: int = 0, *, workspace: str = WORKSPACE) -> str:
    return mint_ephemeral_beacon_token_with_epoch_key(
        epoch_mac_key=bytes.fromhex(master),
        epoch=FIXED_NOW // 900,
        epoch_expires_at=(FIXED_NOW // 900 + 1) * 900,
        device_ephemeral_seed=bytes([seed]) * 32,
        workspace_id=UUID(workspace),
        event_scope="default",
        now_unix_secs=FIXED_NOW,
        counter=counter,
    )


def test_independent_workers_share_key_presence_resolution_checkout_and_replay(
    shared_broker: RunningBroker,
) -> None:
    first = shared_broker.call("bootstrap", workspace_id=WORKSPACE)
    second = shared_broker.call("bootstrap", workspace_id=WORKSPACE)
    assert first["epoch_mac_key"] == second["epoch_mac_key"]
    master = str(first["epoch_mac_key"])
    alice, bob = wire(master, 1), wire(master, 2)
    for principal, token in [("alice", alice), ("bob", bob)]:
        assert "error" not in shared_broker.call(
            "checkin",
            principal_key=principal,
            workspace_id=WORKSPACE,
            beacon_token_hex=token,
            handle=f"{principal}-peer",
        )
    resolved = shared_broker.call(
        "resolve",
        principal_key="bob",
        workspace_id=WORKSPACE,
        observed_tokens=[{"beacon_token": alice}],
    )
    assert [peer["handle"] for peer in resolved["peers"]] == ["alice-peer"]
    checkout = shared_broker.call("checkout", principal_key="alice", workspace_id=WORKSPACE)
    assert checkout["purged_records"] == 1
    assert shared_broker.call("nearby", principal_key="bob", workspace_id=WORKSPACE)["peers"] == []
    replay = shared_broker.call(
        "checkin", principal_key="alice", workspace_id=WORKSPACE, beacon_token_hex=alice
    )
    assert replay == {"error": 409, "reason": "beacon_counter_replayed"}


def test_concurrent_processes_admit_exactly_one_duplicate(shared_broker: RunningBroker) -> None:
    master = str(shared_broker.call("bootstrap", workspace_id=WORKSPACE)["epoch_mac_key"])
    token = wire(master, 1)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda _: shared_broker.call(
                    "checkin",
                    principal_key="alice",
                    workspace_id=WORKSPACE,
                    beacon_token_hex=token,
                ),
                range(8),
            )
        )
    assert sum("error" not in result for result in results) == 1
    assert sum(result.get("error") == 409 for result in results) == 7


def test_restart_wipes_key_presence_and_replay_state(shared_broker: RunningBroker) -> None:
    master = str(shared_broker.call("bootstrap", workspace_id=WORKSPACE)["epoch_mac_key"])
    token = wire(master, 1)
    shared_broker.call(
        "checkin", principal_key="alice", workspace_id=WORKSPACE, beacon_token_hex=token
    )
    shared_broker.stop()
    assert not shared_broker.path.exists()
    assert {path.name for path in shared_broker.path.parent.iterdir()} == {"broker.sock.lock"}
    assert shared_broker.path.with_suffix(".sock.lock").read_bytes() == b""
    shared_broker.start()
    fresh = shared_broker.call("bootstrap", workspace_id=WORKSPACE)
    assert fresh["epoch_mac_key"] != master
    assert shared_broker.call("nearby", principal_key="alice", workspace_id=WORKSPACE) == {
        "error": 403,
        "reason": "caller_not_checked_in",
    }
    assert (
        shared_broker.call(
            "checkin", principal_key="alice", workspace_id=WORKSPACE, beacon_token_hex=token
        )["error"]
        == 422
    )


def test_private_purge_spans_account_workspaces_without_erasing_another_person(
    shared_broker: RunningBroker,
) -> None:
    alice = "01950000-0000-7000-8000-000000000001"
    bob = "01950000-0000-7000-8000-000000000002"
    other_workspace = "01950000-0000-7000-8000-0000000000a2"
    for workspace in (WORKSPACE, other_workspace):
        lease = shared_broker.call("bootstrap", workspace_id=workspace)
        for principal, seed in ((alice, 1), (bob, 2)):
            assert "error" not in shared_broker.call(
                "checkin",
                workspace_id=workspace,
                principal_key=principal,
                beacon_token_hex=wire(lease["epoch_mac_key"], seed, workspace=workspace),
            )
    assert shared_broker.call("inventory", workspace_id=WORKSPACE) == {
        "principal_keys": [alice, bob]
    }
    assert shared_broker.call("erase_account", identity_ids=[alice])["removed_records"] == 2
    assert shared_broker.call("inspect_account", identity_ids=[alice]) == {
        "remaining_records": 0,
        "remaining_replay_bindings": 0,
    }
    assert shared_broker.call("inspect_account", identity_ids=[bob])["remaining_records"] == 2
    assert shared_broker.call("erase_workspace", workspace_id=WORKSPACE)["removed_records"] == 1
    assert shared_broker.call("inspect_workspace", workspace_id=WORKSPACE) == {
        "remaining_records": 0,
        "remaining_replay_bindings": 0,
    }
    assert shared_broker.call("inspect_account", identity_ids=[bob])["remaining_records"] == 1
    assert shared_broker.call("erase_account", identity_ids=[alice])["removed_records"] == 0
    assert shared_broker.call("health") == {"ready": True}


def test_normal_departure_removes_presence_but_does_not_release_replay_binding(
    shared_broker: RunningBroker,
) -> None:
    alice = "01950000-0000-7000-8000-000000000001"
    lease = shared_broker.call("bootstrap", workspace_id=WORKSPACE)
    token = wire(lease["epoch_mac_key"], 1)
    assert "error" not in shared_broker.call(
        "checkin", workspace_id=WORKSPACE, principal_key=alice, beacon_token_hex=token
    )
    assert shared_broker.call("forget", workspace_id=WORKSPACE, principal_keys=[alice]) == {
        "removed_records": 1,
        "remaining_records": 0,
        "remaining_replay_bindings": 1,
    }
    assert (
        shared_broker.call(
            "checkin", workspace_id=WORKSPACE, principal_key=alice, beacon_token_hex=token
        )["error"]
        == 409
    )


@pytest.mark.parametrize(
    "identities",
    [[], ["raw-subject"], [str(UUID(int=0))], [str(UUID(int=1))] * 2, [str(UUID(int=1))] * 129],
)
def test_private_erasure_rpc_rejects_unbounded_or_noncanonical_identity_batches(
    identities: list[str],
) -> None:
    payload = (
        json.dumps(
            {"operation": "erase_account", "arguments": {"identity_ids": identities}}
        ).encode()
        + b"\n"
    )
    assert dispatch(ProximityBroker(), payload)["error"]["status"] == 400


def test_second_broker_refuses_same_socket_without_replacing_live_service(
    shared_broker: RunningBroker,
) -> None:
    first = shared_broker.call("bootstrap", workspace_id=WORKSPACE)
    second = subprocess.run(  # noqa: S603 - fixed interpreter and synthetic fixture input
        [sys.executable, "-m", "apps.proximity.broker_rpc", str(shared_broker.path)],
        capture_output=True,
        timeout=5,
        check=False,
    )
    assert second.returncode == 1
    assert shared_broker.call("bootstrap", workspace_id=WORKSPACE) == first


@pytest.mark.parametrize(
    "payload",
    [
        b"{}\n",
        b'{"operation":"bootstrap","arguments":{"workspace_id":NaN}}\n',
        b'{"operation":"bootstrap","arguments":{"workspace_id":Infinity}}\n',
        b'{"operation":"clear","arguments":{}}\n',
        b'{"operation":"workspace_beacon_key","arguments":{}}\n',
        b'{"operation":"bootstrap","operation":"nearby","arguments":{}}\n',
        b'{"operation":"bootstrap","arguments":{"workspace_id":"bad"}}\n',
        json.dumps(
            {"operation": "bootstrap", "arguments": {"workspace_id": WORKSPACE, "now_unix_secs": 0}}
        ).encode()
        + b"\n",
        b"x" * (MAX_REQUEST_BYTES + 1),
        b"{}",
        b"\xff\n",
    ],
)
def test_malformed_protocol_requests_fail_closed(payload: bytes) -> None:
    assert dispatch(ProximityBroker(), payload)["error"]["status"] == 400


def test_unconfigured_backend_never_uses_per_worker_memory(settings: Any) -> None:
    settings.KODERA_PROXIMITY_BROKER = None
    settings.KODERA_PROXIMITY_BROKER_SOCKET = None
    with pytest.raises(ProximityRefusalError, match="proximity_broker_unavailable"):
        _active_broker()


def test_transport_failure_is_unavailable_and_socket_permissions_are_private(
    shared_broker: RunningBroker,
) -> None:
    assert shared_broker.path.stat().st_mode & 0o777 == 0o600
    assert shared_broker.path.parent.stat().st_mode & 0o777 == 0o700
    gateway = BrokerGateway(str(shared_broker.path))
    shared_broker.path.chmod(0o666)
    with pytest.raises(ProximityRefusalError, match="proximity_broker_unavailable"):
        gateway.bootstrap(workspace_id=WORKSPACE)
    shared_broker.path.chmod(0o600)
    absent = BrokerGateway(str(shared_broker.path.parent / "absent.sock"))
    with pytest.raises(ProximityRefusalError, match="proximity_broker_unavailable"):
        absent.bootstrap(workspace_id=WORKSPACE)


def test_oversized_socket_request_does_not_stop_broker(shared_broker: RunningBroker) -> None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(str(shared_broker.path))
        connection.sendall(b"x" * (MAX_REQUEST_BYTES + 1))
        result = json.loads(connection.recv(4096))
        assert result["error"]["status"] == 400
    assert "epoch_mac_key" in shared_broker.call("bootstrap", workspace_id=WORKSPACE)


@pytest.mark.parametrize(
    "raw", [None, "relative.sock", "/broker/../broker.sock", "/broker//broker.sock", "\x00bad.sock"]
)
def test_invalid_socket_paths_fail_closed(raw: str | None) -> None:
    with pytest.raises(ProximityRefusalError, match="proximity_broker_unavailable"):
        BrokerGateway(raw)


@pytest.mark.parametrize(
    "reply",
    [
        b'{"result":{}}',
        b'{"result":{},"result":{}}\n',
        b"[]\n",
        b'{"error":{"status":200,"kind":null,"reason":null}}\n',
        b'{"error":{"status":400.0,"kind":null,"reason":null}}\n',
        b'{"result":{"value":NaN}}\n',
        b'{"result":{"value":Infinity}}\n',
        b'{"result":{"value":-Infinity}}\n',
        b"x" * (broker_rpc.MAX_RESPONSE_BYTES + 1),
    ],
    ids=[
        "unframed",
        "duplicate",
        "array",
        "wrong-status",
        "float-status",
        "nan",
        "infinity",
        "negative-infinity",
        "oversized",
    ],
)
def test_malformed_backend_response_fails_closed(
    shared_broker: RunningBroker,
    monkeypatch: pytest.MonkeyPatch,
    reply: bytes,
) -> None:
    class FakeConnection:
        def __enter__(self) -> "FakeConnection":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def settimeout(self, timeout: float) -> None:
            pass

        def connect(self, path: str) -> None:
            pass

        def sendall(self, raw: bytes) -> None:
            pass

        def makefile(self, mode: str) -> io.BytesIO:
            return io.BytesIO(reply)

    monkeypatch.setattr(socket, "socket", lambda *args: FakeConnection())
    with pytest.raises(ProximityRefusalError, match="proximity_broker_unavailable"):
        BrokerGateway(str(shared_broker.path)).bootstrap(workspace_id=WORKSPACE)

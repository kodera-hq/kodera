"""Pure refusal controls for the narrowly owned PostgreSQL coordinator."""

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "dev"))
    module = importlib.import_module("accept_persistence")
    monkeypatch.setattr(module.shutil, "disk_usage", lambda _: SimpleNamespace(free=10 * 1024**3))
    monkeypatch.setattr(
        module.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0)
    )
    return module


def fake_docker(module, monkeypatch, *, wrong_owner=False, query_failure=False, wrong_memory=False):
    calls = []
    running = False
    owner = None

    def invoke(*args, **_kwargs):
        nonlocal running, owner
        calls.append(args)
        output = ""
        if args[0] == "run":
            running = True
            owner = args[args.index("--name") + 1]
        elif args[0] == "port":
            output = "127.0.0.1:15432"
        elif args[0] == "ps":
            if query_failure:
                raise RuntimeError("synthetic Docker query failure")
            output = "synthetic-id" if running else ""
        elif args[0] == "inspect":
            output = json.dumps(
                [
                    {
                        "Config": {"Labels": {module.LABEL: "different" if wrong_owner else owner}},
                        "Image": "sha256:synthetic",
                        "Mounts": [],
                        "HostConfig": {
                            "Memory": 1 if wrong_memory else 512 * 1024**2,
                            "MemorySwap": 512 * 1024**2,
                            "NanoCpus": 1000000000,
                            "Tmpfs": {"/var/lib/postgresql/data": "rw,noexec,nosuid,size=256m"},
                            "NetworkMode": "bridge",
                        },
                        "NetworkSettings": {
                            "Ports": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "15432"}]}
                        },
                    }
                ]
            )
        elif args[0] == "rm":
            running = False
        return SimpleNamespace(stdout=output, returncode=0)

    monkeypatch.setattr(module, "docker", invoke)
    return calls


def test_harness_requires_reserve_before_start(harness, monkeypatch):
    calls = fake_docker(harness, monkeypatch)
    monkeypatch.setattr(harness.shutil, "disk_usage", lambda _: SimpleNamespace(free=1))
    with pytest.raises(RuntimeError, match="Five GiB local disk reserve"):
        harness.main()
    assert not any(call[0] == "run" for call in calls)


def test_harness_refuses_wrong_label_before_removal(harness, monkeypatch):
    calls = fake_docker(harness, monkeypatch, wrong_owner=True)
    with pytest.raises(RuntimeError, match="Refusing to remove an unowned PostgreSQL resource"):
        harness.main()
    assert not any(call[0] == "rm" for call in calls)


def test_harness_query_error_is_not_absence(harness, monkeypatch):
    fake_docker(harness, monkeypatch, query_failure=True)
    with pytest.raises(RuntimeError, match="synthetic Docker query failure"):
        harness.main()


def test_harness_uses_cached_bounded_resource_and_removes_exact_owner(harness, monkeypatch):
    calls = fake_docker(harness, monkeypatch)
    harness.main()
    run = next(call for call in calls if call[0] == "run")
    assert "--pull=never" in run and run[-1] == harness.POSTGRES
    assert run[run.index("--memory") + 1] == "512m"
    assert run[run.index("--cpus") + 1] == "1"
    assert run[run.index("-p") + 1] == "127.0.0.1::5432"
    assert next(call for call in calls if call[0] == "rm") == (
        "rm",
        "-f",
        run[run.index("--name") + 1],
    )


def test_harness_refuses_actual_unbounded_memory(harness, monkeypatch):
    fake_docker(harness, monkeypatch, wrong_memory=True)
    with pytest.raises(RuntimeError, match="Owned PostgreSQL resource bounds differ"):
        harness.main()

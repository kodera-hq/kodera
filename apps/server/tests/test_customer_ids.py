"""Actual shared UUID acceptance; no dependency install or service startup."""

import importlib
import multiprocessing
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def ids_module():
    assert (ROOT / "core/db/ids.py").is_file(), "shared UUIDv7 callable is not implemented"
    module = importlib.import_module("core.db.ids")
    assert callable(getattr(module, "new_uuid7", None)), "shared UUIDv7 callable is absent"
    return module


def test_shared_callable_exists():
    ids_module()


def test_actual_version_variant_serialization_and_uniqueness():
    factory = ids_module().new_uuid7
    values = [factory() for _ in range(256)]
    assert all(isinstance(value, uuid.UUID) for value in values)
    assert all(value.version == 7 and value.variant == uuid.RFC_4122 for value in values)
    assert all(
        str(value) == str(value).lower() and uuid.UUID(str(value)) == value for value in values
    )
    assert len(set(values)) == len(values)


def _child_generate(sender, count, controlled_clock=False, ready=None, start=None):
    """Child only: fresh generator state and no shared test database."""
    try:
        module = ids_module()
        if controlled_clock:
            dependency = importlib.import_module("uuid6")
            times = iter(
                [1_700_000_000_000_000_000, 1_700_000_000_000_000_000, 1_699_999_999_000_000_000]
            )
            dependency.time.time_ns = lambda: next(times)
        if ready is not None:
            ready.set()
            assert start.wait(5), "child UUID start barrier was not released"
        sender.send([str(module.new_uuid7()) for _ in range(count)])
    finally:
        sender.close()


def child_values(context, count, *, controlled_clock=False, held_lock=None):
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_child_generate, args=(sender, count, controlled_clock))
    try:
        if held_lock is not None:
            held_lock.acquire()
        process.start()
        sender.close()
        assert receiver.poll(5), "child UUID generation did not make bounded progress"
        values = receiver.recv()
        process.join(5)
        assert process.exitcode == 0, "child UUID generation failed"
        return values
    finally:
        if held_lock is not None:
            held_lock.release()
        if process.pid is not None and process.is_alive():
            process.terminate()
            process.join(5)
            if process.is_alive():
                process.kill()
                process.join(5)
            assert not process.is_alive(), "owned UUID child was not cleaned up"
        receiver.close()
        sender.close()


def test_equal_and_backward_clock_in_fresh_process():
    ids_module()
    values = child_values(multiprocessing.get_context("spawn"), 3, controlled_clock=True)
    identifiers = [uuid.UUID(value) for value in values]
    assert all(value.version == 7 for value in identifiers)
    # Protocol-format observation only; never used as a business timestamp.
    assert [value.int >> 80 for value in identifiers] == [
        1_700_000_000_000,
        1_700_000_000_001,
        1_700_000_000_002,
    ]
    assert len(set(values)) == 3


def test_real_thread_calls_are_unique():
    factory = ids_module().new_uuid7
    with ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(lambda _: factory(), range(512)))
    assert len(set(values)) == 512
    assert all(value.version == 7 for value in values)


def test_full_dependency_call_is_serialized(monkeypatch):
    module = ids_module()
    dependency = importlib.import_module("uuid6")
    original = dependency.uuid7
    first_inside = threading.Event()
    second_attempted = threading.Event()
    second_inside = threading.Event()
    release_first = threading.Event()
    counter_lock = threading.Lock()
    calls = 0
    active = 0
    peak = 0

    def measured_call():
        nonlocal calls, active, peak
        with counter_lock:
            calls += 1
            ordinal = calls
            active += 1
            peak = max(peak, active)
        try:
            if ordinal == 1:
                first_inside.set()
                assert release_first.wait(5), "first instrumented call was not released"
            else:
                second_inside.set()
            return original()
        finally:
            with counter_lock:
                active -= 1

    def second_call():
        second_attempted.set()
        return module.new_uuid7()

    monkeypatch.setattr(dependency, "uuid7", measured_call)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(module.new_uuid7)
        try:
            assert first_inside.wait(5), "dependency was not instrumented"
            second = pool.submit(second_call)
            assert second_attempted.wait(5)
            overlapped = second_inside.wait(0.25)
        finally:
            release_first.set()
        values = [first.result(5), second.result(5)]
    assert calls == 2
    assert not overlapped and peak == 1, "shared UUID dependency calls overlapped"
    assert values[0] != values[1]


def test_separate_processes_generate_unique_values():
    ids_module()
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    children = []
    try:
        for _ in range(2):
            receiver, sender = context.Pipe(duplex=False)
            ready = context.Event()
            process = context.Process(
                target=_child_generate, args=(sender, 128, False, ready, start)
            )
            children.append((process, receiver, sender, ready))
            process.start()
            sender.close()
        assert all(child[3].wait(5) for child in children), (
            "both UUID children did not reach barrier"
        )
        assert all(child[0].is_alive() for child in children), "both UUID children must be live"
        start.set()
        values = []
        for process, receiver, _, _ in children:
            assert receiver.poll(5), "concurrent UUID child made no bounded progress"
            values.extend(receiver.recv())
            process.join(5)
            assert process.exitcode == 0, "concurrent UUID child failed"
        assert len(set(values)) == 256
        assert all(uuid.UUID(value).version == 7 for value in values)
    finally:
        start.set()
        survivors = []
        for process, receiver, sender, _ in children:
            if process.pid is not None:
                process.join(1)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
                if process.is_alive():
                    process.kill()
                    process.join(5)
                if process.is_alive():
                    survivors.append(process.pid)
            receiver.close()
            sender.close()
        assert not survivors, "owned concurrent UUID children were not cleaned up"


def test_child_replaces_inherited_held_lock():
    module = ids_module()
    assert "fork" in multiprocessing.get_all_start_methods(), "fork acceptance requires POSIX"
    values = child_values(multiprocessing.get_context("fork"), 1, held_lock=module._generation_lock)
    assert len(values) == 1 and uuid.UUID(values[0]).version == 7

"""Actual descriptor lifetime across child preparation, without a child process or provider."""

import errno
import importlib.util
import os
import sys
from collections.abc import Mapping
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from worker import child

PHASES = ("lease", "environment", "mapping", "pipe")
LEAK = "step.err descriptor stayed open after preparation failure"


class PreparationInterrupted(BaseException):
    pass


def closed(descriptor):
    try:
        os.fstat(descriptor)
    except OSError as error:
        assert error.errno == errno.EBADF
        return True
    return False


@contextmanager
def preparation(tmp_path, module=child):
    directory = tmp_path / "job"
    directory.mkdir()
    real_close, real_pipe = os.close, os.pipe
    real_errors, real_directory = module._open_errors, module._open_directory
    borrowed = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    unrelated = os.open(tmp_path / "unrelated", os.O_CREAT | os.O_RDWR, 0o600)
    state = SimpleNamespace(
        directory=directory,
        borrowed=borrowed,
        unrelated=unrelated,
        errors=[],
        pipes=[],
        owned=[],
        closes=[],
        lost=Mock(return_value=False),
        send=Mock(return_value=True),
        popen=Mock(),
        abandon=Mock(),
        request={"synthetic": "preparation-only"},
    )

    def close(descriptor):
        state.closes.append(descriptor)
        real_close(descriptor)

    def errors(*args):
        descriptor = real_errors(*args)
        state.errors.append(descriptor)
        return descriptor

    def folder(*args):
        descriptor = real_directory(*args)
        state.owned.append(descriptor)
        return descriptor

    def pipe():
        descriptors = real_pipe()
        state.pipes.extend(descriptors)
        return descriptors

    def spawn(*args, **options):
        assert not closed(options["stderr"]), "step.err closed before spawn preparation"
        os.write(options["stdout"], b'{"answer":{"prepared":true}}\n')
        return SimpleNamespace(pid=2_000_000_000, returncode=0, stdin=Mock())

    def hand_off(write):
        assert all(closed(fd) for fd in state.errors), "step.err stayed open into handoff"
        return write()

    def wait(process, output, *args):
        output.read()
        return None

    state.popen.side_effect = spawn
    state.hand_off = Mock(side_effect=hand_off)
    try:
        with ExitStack() as stack:
            for owner, name, replacement in (
                (module.os, "close", close),
                (module.os, "pipe", pipe),
                (module, "_open_errors", errors),
                (module, "_open_directory", folder),
                (module.subprocess, "Popen", state.popen),
                (module, "_send", state.send),
                (module, "_abandon", state.abandon),
                (module, "_wait", wait),
            ):
                stack.enter_context(patch.object(owner, name, replacement))
            yield state
    finally:
        # Observe the verdict before cleanup. The predecessor and removal comparison really
        # leak descriptors; this finally must not convert that observation into a pass.
        for descriptor in {*state.errors, *state.pipes, *state.owned, borrowed, unrelated}:
            if not closed(descriptor):
                real_close(descriptor)


def run(module, state, *, owned=False):
    return module.run_child(
        state.request,
        directory=state.directory,
        directory_fd=None if owned else state.borrowed,
        secret="synthetic-preparation-credential",
        lost=state.lost,
        timeout_s=1,
        hand_off=state.hand_off,
    )


def assert_lifetimes(state):
    assert len(state.errors) == 1
    assert closed(state.errors[0]), LEAK
    assert state.closes.count(state.errors[0]) == 1, "step.err was not closed exactly once"
    assert not closed(state.borrowed), "borrowed directory descriptor was closed"
    assert not closed(state.unrelated), "unrelated descriptor was closed"
    assert not (state.directory / child.CREDENTIAL_FILE).exists(), "owned credential survived"
    for descriptor in state.pipes:
        assert closed(descriptor), "preparation pipe descriptor survived"
        assert state.closes.count(descriptor) == 1, "preparation pipe closed more than once"
    for descriptor in state.owned:
        assert closed(descriptor), "owned directory descriptor survived"
        assert state.closes.count(descriptor) == 1


def failure_case(tmp_path, module, phase, error, *, owned=False):
    with preparation(tmp_path, module) as state, ExitStack() as stack:
        if phase == "lease":
            state.lost.side_effect = [False, error]
        elif phase == "environment":
            stack.enter_context(patch.object(module, "child_environment", side_effect=error))
        elif phase == "mapping":

            class BrokenMapping(Mapping):
                def __iter__(self):
                    raise error

                def __len__(self):
                    return 1

                def __getitem__(self, key):
                    raise error

            state.request = BrokenMapping()
        elif phase == "pipe":
            stack.enter_context(patch.object(module.os, "pipe", side_effect=error))
        with pytest.raises(type(error)) as raised:
            run(module, state, owned=owned)
        assert raised.value is error, "preparation exception identity changed"
        assert_lifetimes(state)
        state.popen.assert_not_called()
        state.send.assert_not_called()
        state.hand_off.assert_not_called()


@pytest.mark.parametrize("phase", PHASES)
@pytest.mark.parametrize("owned", [False, True], ids=["borrowed-directory", "owned-directory"])
@pytest.mark.parametrize(
    "exception", [RuntimeError, PreparationInterrupted], ids=["Exception", "BaseException"]
)
def test_preparation_exception_closes_errors_before_propagating(tmp_path, phase, exception, owned):
    failure_case(tmp_path, child, phase, exception("synthetic preparation failure"), owned=owned)


def control_case(tmp_path, module, scenario):
    with preparation(tmp_path, module) as state:
        if scenario == "pre-open":
            with patch.object(
                module, "_open_errors", side_effect=OSError("synthetic open refusal")
            ):
                assert run(module, state).killed == child.NOT_STARTED
            assert not state.errors and not state.pipes
        elif scenario == "pre-existing-credential":
            credential = state.directory / child.CREDENTIAL_FILE
            credential.write_text("pre-existing synthetic credential")
            assert run(module, state).killed == child.NOT_STARTED
            assert credential.read_text() == "pre-existing synthetic credential"
            assert not state.errors and not state.pipes
        elif scenario == "lease-refused":
            state.lost.side_effect = [False, True]
            assert run(module, state).killed == child.LEASE_LOST
            assert_lifetimes(state)
        elif scenario in ("spawn-Exception", "spawn-BaseException"):
            error = (
                RuntimeError("synthetic spawn failure")
                if scenario == "spawn-Exception"
                else PreparationInterrupted("synthetic spawn interruption")
            )
            state.popen.side_effect = error
            if isinstance(error, Exception):
                assert run(module, state).killed == child.NOT_STARTED
            else:
                with pytest.raises(type(error)) as raised:
                    run(module, state)
                assert raised.value is error
            assert_lifetimes(state)
        else:
            result = run(module, state, owned=scenario == "owned-success")
            assert result.killed is None and result.answer == {"answer": {"prepared": True}}
            assert_lifetimes(state)
            state.send.assert_called_once()
            state.hand_off.assert_called_once()
            return
        state.send.assert_not_called()
        state.hand_off.assert_not_called()
        if not scenario.startswith("spawn-"):
            state.popen.assert_not_called()
        assert not closed(state.borrowed) and not closed(state.unrelated)
        if scenario != "pre-existing-credential":
            assert not (state.directory / child.CREDENTIAL_FILE).exists()


CONTROLS = (
    "pre-open",
    "pre-existing-credential",
    "lease-refused",
    "spawn-Exception",
    "spawn-BaseException",
    "success",
    "owned-success",
)


@pytest.mark.parametrize("scenario", CONTROLS)
def test_preparation_controls_preserve_results_and_descriptor_ownership(tmp_path, scenario):
    control_case(tmp_path, child, scenario)


def test_narrowed_cleanup_fails_closure_owners_with_controls_and_restored_source(tmp_path):
    source_path = Path(child.__file__)
    original = source_path.read_bytes()
    source = original.decode()
    prefix = (
        "        # Own step.err through every preparation exit, before handoff.\n        try:\n"
    )
    suffix = "        finally:\n            os.close(errors)\n"
    assert source.count(prefix) == 1
    start = source.index(prefix)
    end = source.index("\n        def write()", start)
    guarded = source[start:end]
    assert guarded.endswith(suffix)
    body = guarded[len(prefix) : -len(suffix)]
    body = "".join(
        line[4:] if line.startswith("    ") else line for line in body.splitlines(keepends=True)
    )
    lease = "        if _lease_lost(lost):\n            return"
    spawn = "        finally:\n            os.close(write_end)\n"
    assert body.count(lease) == body.count(spawn) == 1
    # Recreate the predecessor's narrowed ownership: normal lease/spawn paths still close,
    # but preparation exceptions before Popen escape the new cleanup. No production flag.
    body = body.replace(
        lease, "        if _lease_lost(lost):\n            os.close(errors)\n            return"
    )
    body = body.replace(spawn, spawn + "            os.close(errors)\n")
    mutant_path = tmp_path / "narrowed_child.py"
    mutant_path.write_text(source[:start] + body + source[end:])
    name = "worker._preparation_cleanup_comparison"
    spec = importlib.util.spec_from_file_location(name, mutant_path)
    assert spec is not None and spec.loader is not None
    mutant = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {name: mutant}):
        spec.loader.exec_module(mutant)
        for phase in PHASES:
            for exception in (RuntimeError, PreparationInterrupted):
                directory = tmp_path / f"mutant-{phase}-{exception.__name__}"
                directory.mkdir()
                with pytest.raises(AssertionError) as refused:
                    failure_case(directory, mutant, phase, exception("synthetic comparison"))
                assert str(refused.value).splitlines()[0] == LEAK
        for scenario in CONTROLS:
            directory = tmp_path / f"mutant-control-{scenario}"
            directory.mkdir()
            control_case(directory, mutant, scenario)
    assert source_path.read_bytes() == original, "comparison changed the repaired source"
    for phase in PHASES:
        for exception in (RuntimeError, PreparationInterrupted):
            directory = tmp_path / f"restored-{phase}-{exception.__name__}"
            directory.mkdir()
            failure_case(directory, child, phase, exception("synthetic restored control"))
    for scenario in CONTROLS:
        directory = tmp_path / f"restored-control-{scenario}"
        directory.mkdir()
        control_case(directory, child, scenario)
    assert source_path.read_bytes() == original

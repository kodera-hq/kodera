#!/usr/bin/env python3
"""Hosted Linux optimized backport regression and deliberate wrong-value oracle."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True
WORKSPACE = Path(__file__).resolve().parents[2]
CANDIDATE = WORKSPACE / 'security/backports/glib-0.18.5'
TEST_NAME = 'variant_str_iter_out_pointer_optimized_regression'
ORACLE_VALUE = 'intentional-glib-oracle-mismatch'
BUILD_SECONDS = 240
COMPILE_SECONDS = 60
TEST_SECONDS = 15
# These reserves apply only after the hosted-Linux admission below. Local jobs
# retain the workstation's separate 20 GiB minimum and heavy-slot guards.
ADMISSION_BYTES = 4 * 1024**3
STOP_BYTES = 2 * 1024**3


def backport_verifier():
    spec = importlib.util.spec_from_file_location('glib_backport_verifier', CANDIDATE / 'verify.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def oracle_source(source: str) -> str:
    declaration = 'let expected: Vec<&str> = values.iter().map(String::as_str).collect();'
    anchor = 'let view = black_box(&variant);'
    if source.count(declaration) != 1 or source.count(anchor) != 1:
        raise ValueError('regression oracle anchor changed')
    return source.replace(declaration, declaration.replace('let expected:', 'let mut expected:')).replace(
        anchor, f'if !expected.is_empty() {{ expected[0] = "{ORACLE_VALUE}"; }}\n            ' + anchor
    )


def positive_result(stdout: str, returncode: int) -> None:
    if returncode != 0 or not re.search(r'test result: ok\. 1 passed; 0 failed; 0 ignored;', stdout):
        raise ValueError('optimized regression did not execute exactly one passing test')


def oracle_result(stdout: str, stderr: str, returncode: int) -> None:
    if returncode != 101 or ORACLE_VALUE not in stdout + stderr or not re.search(
        r'test result: FAILED\. 0 passed; 1 failed; 0 ignored;', stdout
    ):
        raise ValueError('deliberate wrong-value oracle did not fail as an executed assertion')


def existing_ancestor(path: Path) -> Path:
    while not path.exists():
        path = path.parent
    return path


def dependency_search_directories(messages: Path, target: Path) -> list[Path]:
    """Use Cargo's actual artifacts, whose intermediate layout is not stable."""
    directories = set()
    for line in messages.read_text().splitlines():
        if not line.strip():
            continue
        message = json.loads(line)
        if message.get('reason') != 'compiler-artifact':
            continue
        for filename in message.get('filenames', []):
            path = Path(filename)
            if path.suffix not in {'.rlib', '.so', '.dylib'}:
                continue
            resolved = path.resolve()
            if not path.is_absolute() or not resolved.is_relative_to(target.resolve()):
                raise ValueError('Cargo dependency artifact is outside the selected target')
            if not resolved.is_file() or resolved.stat().st_size == 0:
                raise ValueError('Cargo dependency artifact is missing or empty')
            directories.add(resolved.parent)
            if len(directories) > 1024:
                raise ValueError('Cargo dependency search exceeds its bound')
    if not directories:
        raise ValueError('Cargo reported no library dependency search directories')
    return sorted(directories)


def selftest() -> None:
    positive_result('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured;', 0)
    oracle_result('test result: FAILED. 0 passed; 1 failed; 0 ignored;', ORACLE_VALUE, 101)
    cases = [
        lambda: positive_result('test result: ok. 0 passed; 0 failed; 0 ignored;', 0),
        lambda: positive_result('test result: ok. 0 passed; 0 failed; 1 ignored;', 0),
        lambda: positive_result('test result: ok. 1 passed; 0 failed; 0 ignored;', 1),
        lambda: oracle_result('test result: ok. 1 passed; 0 failed; 0 ignored;', ORACLE_VALUE, 0),
        lambda: oracle_result('test result: FAILED. 0 passed; 1 failed; 0 ignored;', 'other failure', 101),
        lambda: oracle_result('segmentation fault', ORACLE_VALUE, -11),
        lambda: oracle_source('test source without the expected value anchor'),
    ]
    for case in cases:
        try:
            case()
        except ValueError:
            pass
        else:
            raise AssertionError('negative qualification fixture admitted')
    source = (CANDIDATE / 'tests/variant_str_iter_out_pointer.rs').read_text()
    assert ORACLE_VALUE in oracle_source(source)
    with tempfile.TemporaryDirectory(prefix='glib-search-fixture-') as directory:
        root = Path(directory).resolve()
        target = root / 'target'
        legacy = target / 'release/deps/libdependency.rlib'
        per_unit = target / 'units/macro/libfixture.so'
        for path in [legacy, per_unit]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'path-selection fixture, not a compiled library')
        messages = root / 'messages.json'
        def emit(paths):
            messages.write_text(json.dumps({'reason': 'compiler-artifact', 'filenames': [str(p) for p in paths]}) + '\n')
        emit([legacy, per_unit, legacy])
        assert dependency_search_directories(messages, target) == sorted([legacy.parent, per_unit.parent])
        alias = target / 'alias.rlib'
        alias.symlink_to(legacy)
        emit([alias])
        assert dependency_search_directories(messages, target) == [legacy.parent]
        outside = root / 'outside.rlib'
        outside.write_bytes(b'outside fixture')
        empty = target / 'empty.rlib'
        empty.touch()
        link = target / 'link.rlib'
        link.symlink_to(outside)
        for paths in [[], [outside], [target / 'missing.rlib'], [empty], [link]]:
            emit(paths)
            try:
                dependency_search_directories(messages, target)
            except ValueError:
                pass
            else:
                raise AssertionError('invalid Cargo search path admitted')
    print('Qualification parser/oracle source checks passed; no compiler or native process ran.')


def qualify(revision: str, evidence_path: Path) -> None:
    if sys.platform != 'linux' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('execution requires the explicitly authorized hosted Linux job')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=WORKSPACE, text=True).strip()
    if head != revision:
        raise ValueError('qualification revision differs from the checked-out source')
    verifier = backport_verifier()
    provenance = json.loads((CANDIDATE / 'provenance.json').read_text())
    verifier.verify_source(provenance)
    target = Path(os.environ.get('CARGO_TARGET_DIR') or str(WORKSPACE / 'target'))
    if not target.is_absolute():
        target = WORKSPACE / target
    target = target.resolve()
    runner_temp = Path(os.environ['RUNNER_TEMP']).resolve()
    paths = [WORKSPACE, target, runner_temp]
    free = lambda: min(shutil.disk_usage(existing_ancestor(path)).free for path in paths)
    if free() < ADMISSION_BYTES:
        raise ValueError('optimized hosted qualification requires 4 GiB available before allocation')
    evidence = {'revision': revision, 'source_manifest_sha256': provenance['integrated_source_manifest_sha256'],
                'status': 'running', 'vulnerable_runtime_controls': 'not executed; no kill or unreachability claim',
                'minimum_free_bytes': free(), 'commands': [],
                'cargo_lock_sha256': hashlib.sha256((WORKSPACE / 'Cargo.lock').read_bytes()).hexdigest()}
    target.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    stage = 'initialize'
    with tempfile.TemporaryDirectory(prefix='glib-iterator-qualification-', dir=runner_temp) as temporary:
        scratch = Path(temporary)

        def run(label: str, arguments: list[str], timeout: int):
            nonlocal stage
            stage = label
            stdout_path, stderr_path = scratch / (label + '.stdout'), scratch / (label + '.stderr')
            command_start = time.monotonic()
            with stdout_path.open('wb') as stdout, stderr_path.open('wb') as stderr:
                process = subprocess.Popen(arguments, cwd=WORKSPACE, stdout=stdout, stderr=stderr, start_new_session=True)
                try:
                    while process.poll() is None:
                        available = free()
                        evidence['minimum_free_bytes'] = min(evidence['minimum_free_bytes'], available)
                        if available < STOP_BYTES:
                            raise RuntimeError('disk early-stop guard')
                        if time.monotonic() - command_start > timeout:
                            raise RuntimeError('command timeout; not a qualified negative result')
                        if stdout_path.stat().st_size + stderr_path.stat().st_size > 16 * 1024**2:
                            raise RuntimeError('command output limit')
                        time.sleep(0.25)
                except BaseException:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    raise
            evidence['minimum_free_bytes'] = min(evidence['minimum_free_bytes'], free())
            if free() < STOP_BYTES or stdout_path.stat().st_size + stderr_path.stat().st_size > 16 * 1024**2:
                raise RuntimeError('post-command resource guard')
            result = {'stage': label, 'arguments': arguments, 'returncode': process.returncode,
                      'elapsed_seconds': round(time.monotonic() - command_start, 3)}
            evidence['commands'].append(result)
            return process.returncode, stdout_path.read_text(errors='replace'), stderr_path.read_text(errors='replace'), stdout_path

        try:
            for name in ['cargo', 'rustc']:
                code, stdout, stderr, _ = run(name + '-version', [name, '--version', '--verbose'], 5)
                if code != 0:
                    raise ValueError(name + ' version query failed')
                evidence[name + '_version'] = stdout.strip()
            # Pin intermediate output as well as final output. --target-dir alone
            # does not override an independently configured build.build-dir.
            command = ['cargo', 'build', '--locked', '--offline', '--release', '-p', 'glib', '--lib',
                       '--target-dir', str(target), '--config', 'build.build-dir=' + json.dumps(str(target)),
                       '--message-format=json']
            code, stdout, stderr, messages = run('optimized-library', command, BUILD_SECONDS)
            if code != 0:
                print(stderr[-24000:], file=sys.stderr)
                for line in stdout.splitlines():
                    try:
                        message = json.loads(line)
                        if message.get('reason') == 'compiler-message':
                            print((message.get('message', {}).get('rendered') or '')[-24000:], file=sys.stderr)
                    except ValueError:
                        pass
                raise ValueError('locked optimized GLib library build failed')
            artifact = verifier.optimized_artifact(messages, target)
            evidence['glib_rlib'] = str(artifact)
            evidence['glib_rlib_sha256'] = verifier.sha(artifact.read_bytes())
            # Cargo versions can use flat or per-unit intermediate directories.
            # Reported artifacts bind the search to this actual build's outputs.
            dependency_directories = dependency_search_directories(messages, target)
            evidence['rust_dependency_directories'] = [str(path) for path in dependency_directories]
            native_search_paths = sorted({path for line in stdout.splitlines()
                for item in [json.loads(line)] if item.get('reason') == 'build-script-executed'
                for path in item.get('linked_paths', []) if path.startswith('native=')})
            evidence['native_search_paths'] = native_search_paths
            source = CANDIDATE / 'tests/variant_str_iter_out_pointer.rs'
            oracle = scratch / 'wrong_expected_value.rs'
            oracle.write_text(oracle_source(source.read_text()))
            for label, path, expected in [('positive', source, positive_result), ('wrong-value-oracle', oracle, oracle_result)]:
                binary = scratch / label
                args = ['rustc', '--edition=2021', '--test', str(path), '-C', 'opt-level=3',
                        '--extern', 'glib=' + str(artifact), '-o', str(binary)]
                for directory in dependency_directories:
                    args.extend(['-L', 'dependency=' + str(directory)])
                for search_path in native_search_paths:
                    args.extend(['-L', search_path])
                code, stdout, stderr, _ = run(label + '-compile', args, COMPILE_SECONDS)
                if code != 0:
                    print(stderr[-24000:], file=sys.stderr)
                    raise ValueError(label + ' compiler failure is not a runtime qualification')
                code, stdout, stderr, _ = run(label + '-run', [str(binary), '--exact', TEST_NAME, '--nocapture'], TEST_SECONDS)
                print(stdout[-24000:])
                if label == 'positive':
                    expected(stdout, code)
                else:
                    expected(stdout, stderr, code)
                    print(stderr[-24000:], file=sys.stderr)
            verifier.verify_source(provenance)
            if hashlib.sha256((WORKSPACE / 'Cargo.lock').read_bytes()).hexdigest() != evidence['cargo_lock_sha256']:
                raise ValueError('qualification changed the root lockfile')
            evidence.update(status='passed', positive_tests_passed=1, wrong_expected_value_assertions_failed=1,
                            elapsed_seconds=round(time.monotonic() - started, 3))
        except BaseException as error:
            evidence.update(status='failed', failed_stage=stage, error=str(error), elapsed_seconds=round(time.monotonic() - started, 3))
            raise
        finally:
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(json.dumps(evidence, sort_keys=True, indent=2) + '\n')
            print(json.dumps(evidence, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--selftest', action='store_true')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--revision')
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    if args.selftest:
        selftest()
    if args.execute:
        if not args.revision or not args.evidence:
            parser.error('--execute requires --revision and --evidence')
        qualify(args.revision, args.evidence)
    elif not args.selftest:
        parser.error('choose source-only --selftest or explicitly authorized hosted --execute')


if __name__ == '__main__':
    main()

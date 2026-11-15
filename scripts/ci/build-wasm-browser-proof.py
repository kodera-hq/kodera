#!/usr/bin/env python3
"""Own one same-checkout generated WASM/browser proof; no production caller."""
from __future__ import annotations

import argparse
import ctypes
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

MIB = 1024 ** 2
GIB = 1024 ** 3
ADMIT, STOP, TOTAL = 28 * GIB, 20.5 * GIB, int(7.5 * GIB)
TOOL_URL = 'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.130/wasm-bindgen-0.2.130-x86_64-unknown-linux-musl.tar.gz'
TOOL_SHA = '9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f'
TOOL_SIZE = 11860397
TOOL_PREFIX = 'wasm-bindgen-0.2.130-x86_64-unknown-linux-musl/'
TOOL_MEMBERS = {'README.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'wasm-bindgen', 'wasm-bindgen-test-runner', 'wasm2es6js'}
GENERATED_REQUIRED = {'kodera_rs.js', 'kodera_rs_bg.wasm', 'kodera_rs.d.ts', 'kodera_rs_bg.wasm.d.ts'}
CASE_BUDGET = 240
MAX_CARGO_ROW = 4 * MIB


class Refused(RuntimeError):
    pass


def need(value, reason):
    if not value:
        raise Refused(reason)


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def bounded_log_digest(path, cap, expected):
    deadline = time.monotonic() + 2
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and
             signature(before) == signature(expected) and before.st_size <= cap, 'Stopped log identity/cap')
        hasher, count = hashlib.sha256(), 0
        while True:
            need(time.monotonic() <= deadline, 'Stopped log hash deadline')
            body = os.read(descriptor, min(65536, cap + 1 - count))
            count += len(body)
            need(count <= cap, 'Stopped log grew past cap')
            if not body:
                break
            hasher.update(body)
        need(signature(os.fstat(descriptor)) == signature(before) and count == before.st_size and
             time.monotonic() <= deadline, 'Stopped log changed/deadline')
        return hasher.hexdigest()
    finally:
        os.close(descriptor)


def stopped_log_evidence(stdout, stderr, cap):
    paths = {'stdout': stdout, 'stderr': stderr}
    stats = {name: path.lstat() for name, path in paths.items()}
    # Check BOTH final sizes before consuming either stopped stream.
    over_cap = any(value.st_size > cap for value in stats.values())
    failed, entries = over_cap, {}
    for name, value in stats.items():
        entry = {'bytes': value.st_size, 'sha256': None, 'over_cap': value.st_size > cap,
                 'identity': [value.st_dev, value.st_ino, value.st_mtime_ns]}
        if over_cap:
            entry['digest_omitted_reason'] = 'Stopped output set exceeds per-stream cap'
        else:
            try:
                entry['sha256'] = bounded_log_digest(paths[name], cap, value)
            except (Refused, OSError) as error:
                failed = True
                entry['digest_omitted_reason'] = 'Bounded stopped log read refused: ' + type(error).__name__
        entries[name] = entry
    return entries, failed


def reserve(size):
    return ((size + 4095) // 4096 + 1) * 4096


def write_new(path, payload):
    need(shutil.disk_usage(path.parent).free >= STOP + reserve(len(payload)) + 2 * MIB,
         'Evidence floor')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    need(path.read_bytes() == payload, 'Evidence readback')


def json_new(path, value):
    body = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    need(len(body) <= MIB, 'Receipt cap')
    write_new(path, body)


def identity(path):
    value = path.lstat()
    need(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid() and not path.is_symlink(),
         'Owned directory identity')
    return value.st_dev, value.st_ino


def physical(path, *, allow_tmp_sockets=False):
    """Bounded sampled scan; not a quota or an open-unlinked-FD guarantee."""
    if not path.exists():
        return 0
    expected = identity(path)
    socket_root = path / 'tmp' if allow_tmp_sockets else None
    socket_identity = identity(socket_root) if socket_root is not None else None
    need(socket_identity is None or socket_identity[0] == expected[0], 'Foreign allocation tmp')
    peak = 0
    deadline = time.monotonic() + 2
    for _ in range(3):
        total = path.lstat().st_blocks * 512
        count = 0
        try:
            def error(value):
                raise value
            for current, dirs, files in os.walk(path, followlinks=False, onerror=error):
                need(time.monotonic() <= deadline, 'Allocation sample deadline')
                need(len(Path(current).relative_to(path).parts) <= 64, 'Allocation depth')
                for name in dirs + files:
                    item = Path(current) / name
                    count += 1
                    need(count <= 250000, 'Allocation entries')
                    value = item.lstat()
                    need(value.st_dev == expected[0] and value.st_uid == os.getuid(), 'Foreign allocation')
                    ordinary = stat.S_ISREG(value.st_mode) or stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode)
                    if not ordinary:
                        relative = item.relative_to(path)
                        kind = ('socket' if stat.S_ISSOCK(value.st_mode) else
                                'fifo' if stat.S_ISFIFO(value.st_mode) else
                                'character-device' if stat.S_ISCHR(value.st_mode) else
                                'block-device' if stat.S_ISBLK(value.st_mode) else
                                'mode-' + format(stat.S_IFMT(value.st_mode), 'o'))
                        detail = ' kind=' + kind + ' path=' + json.dumps(relative.as_posix()[:512], ensure_ascii=True)
                        allowed = (socket_root is not None and stat.S_ISSOCK(value.st_mode) and
                                   len(relative.parts) > 1 and relative.parts[0] == 'tmp')
                        need(allowed, 'Special allocation' + detail)
                        need(identity(socket_root) == socket_identity, 'Allocation tmp changed' + detail)
                        # Never follow a directory alias to classify a socket as private tmp IPC.
                        ancestor = item.parent
                        while ancestor != path:
                            need(time.monotonic() <= deadline, 'Allocation sample deadline')
                            parent_value = ancestor.lstat()
                            need(stat.S_ISDIR(parent_value.st_mode) and parent_value.st_uid == os.getuid() and
                                 parent_value.st_dev == expected[0], 'Socket allocation ancestor' + detail)
                            ancestor = ancestor.parent
                    total += value.st_blocks * 512
                    peak = max(peak, total)
            need(socket_root is None or identity(socket_root) == socket_identity, 'Allocation tmp changed')
            need(identity(path) == expected and time.monotonic() <= deadline, 'Allocation changed or deadline')
            return max(peak, total)
        except FileNotFoundError as exc:
            need(exc.errno == 2 and exc.filename and Path(exc.filename) != path and
                 Path(exc.filename).is_relative_to(path), 'Allocation root/error')
            peak = max(peak, total)
    raise Refused('Allocation churn')


class Children:
    """Owner-local Linux subreaper; detached browser groups stay descendants."""
    def __init__(self):
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        self.libc.prctl.restype = ctypes.c_int
        need(self.libc.prctl(36, 1, 0, 0, 0) == 0, 'Owner subreaper unavailable')
        need(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'PID identity signals unavailable')
        self.handles = {}
        self.last_stopped = []

    @staticmethod
    def children(pid):
        location = Path('/proc') / str(pid) / 'task' / str(pid) / 'children'
        try:
            with location.open('rb') as source:
                body = source.read(65537)
        except FileNotFoundError:
            return []
        need(len(body) <= 65536 and all(part.isdigit() for part in body.split()), 'Owned descendant inventory')
        return [int(part) for part in body.split()]

    @staticmethod
    def process(pid):
        try:
            with (Path('/proc') / str(pid) / 'stat').open('rb') as source:
                body = source.read(8193)
        except FileNotFoundError:
            return None
        need(len(body) <= 8192 and b') ' in body, 'Process identity record')
        rest = body.rsplit(b') ', 1)[1].split()
        need(len(rest) >= 20 and rest[1].isdigit() and rest[19].isdigit(), 'Process identity fields')
        return int(rest[1]), int(rest[19])

    def observe(self):
        owner = os.getpid()
        queue, seen = [(pid, owner) for pid in self.children(owner)], set()
        while queue:
            pid, parent = queue.pop()
            if pid in seen:
                continue
            seen.add(pid)
            need(pid != owner and len(seen) <= 512, 'Owned descendant count')
            before = self.process(pid)
            if before is None:
                continue
            need(before[0] in (parent, owner), 'Descendant parent changed; do not signal')
            if pid not in self.handles:
                try:
                    descriptor = os.pidfd_open(pid, 0)
                except ProcessLookupError:
                    continue
                after = self.process(pid)
                if after is None:
                    os.close(descriptor)
                    continue
                if after != before:
                    os.close(descriptor)
                    raise Refused('Process identity changed; do not signal')
                if len(self.handles) >= 512:
                    os.close(descriptor)
                    raise Refused('Owned identity history cap; retain recovery state')
                self.handles[pid] = (descriptor, before[1])
            need(self.handles[pid][1] == before[1], 'PID reused; do not signal replacement')
            descendants = self.children(pid)
            after = self.process(pid)
            if after is not None:
                need(after == before, 'Process changed during descendant enumeration')
                queue.extend((child, pid) for child in descendants)
        return seen

    def stop(self, direct):
        # Previously opened PIDfds remain safe even when a later inventory fails.
        # Always stop the known direct child; inventory refusal must not bypass it.
        deadline = time.monotonic() + 8
        try:
            self.observe()
        except (Refused, OSError):
            pass
        for descriptor, start in self.handles.values():
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGTERM, None, 0)
            except OSError:
                pass
        if direct.poll() is None:
            direct.terminate()
        try:
            direct.wait(timeout=3)
        except subprocess.TimeoutExpired:
            direct.kill()
            direct.wait(timeout=5)
        while True:
            try:
                self.observe()
            except (Refused, OSError):
                pass
            for descriptor, start in self.handles.values():
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL, None, 0)
                except OSError:
                    pass
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    break
            if not self.children(os.getpid()):
                self.last_stopped = [[pid, value[1]] for pid, value in sorted(self.handles.items())]
                for descriptor, start in self.handles.values():
                    os.close(descriptor)
                self.handles.clear()
                return
            need(time.monotonic() <= deadline, 'Owned descendants uncertain; retain root')
            time.sleep(.05)


class Guard:
    def __init__(self, root, repo):
        self.root, self.repo = root, repo
        self.ident = identity(root)
        self.started = time.monotonic()
        self.minimum_free = shutil.disk_usage(root).free
        self.peaks = {}
        self.last_sample = float("-inf")
        self.groups = set()
        self.commands = []
        self.children = Children()
        npm_lock = json.loads((repo / 'package-lock.json').read_text())
        self.npm_roots = [repo / 'node_modules']
        for name in npm_lock['packages']:
            if name and 'node_modules' not in name.split('/'):
                need(not name.startswith('/') and all(part not in ('', '.', '..') for part in name.split('/')),
                     'Workspace lock path')
                self.npm_roots.append(repo / name / 'node_modules')
        self.env = {key: os.environ[key] for key in ('PATH', 'RUSTUP_HOME', 'CARGO_HOME', 'CARGO_TARGET_DIR')
                    if key in os.environ}
        self.env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'),
                        CARGO_BUILD_JOBS='2', RUSTUP_AUTO_INSTALL='0', CI='true',
                        npm_config_cache=str(root / 'npm-cache'), npm_config_ignore_scripts='true',
                        PLAYWRIGHT_BROWSERS_PATH=str(root / 'browsers'),
                        WASM_PROOF_ROOT=str(root))
        for name in ('home', 'tmp', 'logs', 'tools', 'generated', 'npm-cache', 'browsers'):
            (root / name).mkdir(mode=0o700)
        temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        for key in ('RUSTUP_HOME', 'CARGO_HOME', 'CARGO_TARGET_DIR'):
            value = Path(self.env[key])
            need(value.is_absolute() and value.resolve(strict=True).is_relative_to(temp) and not value.is_symlink(),
                 'Private Rust directory required')

    def tick(self):
        need(identity(self.root) == self.ident, 'Root changed')
        need(time.monotonic() - self.started <= 780, 'Owner time budget')
        free = shutil.disk_usage(self.root).free
        self.minimum_free = min(self.minimum_free, free)
        need(free >= STOP, 'Continuous disk stop')
        if time.monotonic() - self.last_sample < .2:
            return
        rows = {'target': (Path(self.env['CARGO_TARGET_DIR']), 3 * GIB),
                'rustup': (Path(self.env['RUSTUP_HOME']), 2 * GIB),
                'cargo': (Path(self.env['CARGO_HOME']), 2 * GIB),
                'private': (self.root, int(1.25 * GIB))}
        measured = {}
        for key, (path, cap) in rows.items():
            size = physical(path, allow_tmp_sockets=key == 'private')
            self.peaks[key] = max(self.peaks.get(key, 0), size)
            measured[key] = self.peaks[key] if key == 'target' else size
            need(measured[key] + (64 * MIB if key == 'target' else 0) <= cap, 'Partition ' + key)
        measured['npm'] = sum(physical(path) for path in self.npm_roots)
        self.peaks['npm'] = max(self.peaks.get('npm', 0), measured['npm'])
        need(measured['rustup'] + measured['cargo'] <= 2 * GIB, 'Toolchain/source combined partition')
        need(measured['npm'] <= int(1.25 * GIB), 'All workspace Node modules partition')
        need(sum(measured.values()) + 80 * MIB <= TOTAL, 'Combined owned allocation')
        self.last_sample = time.monotonic()

    def stop(self, child):
        self.children.stop(child)
        self.groups.discard(child.pid)

    def command(self, argv, label, seconds, cap=8 * MIB):
        self.tick()
        stdout, stderr = (self.root / 'logs' / (label + suffix) for suffix in ('.stdout', '.stderr'))
        start = time.monotonic()
        child = None
        with stdout.open('xb') as out, stderr.open('xb') as err:
            try:
                # Defer Python cancellation without changing the inherited OS
                # signal mask. Exec resets caught handlers; blocked masks persist.
                pending_signal = [False]
                launch_handlers = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}
                def deferred(signum, frame):
                    pending_signal[0] = True
                for signum in launch_handlers:
                    signal.signal(signum, deferred)
                try:
                    child = subprocess.Popen(argv, cwd=self.repo, env=self.env, stdin=subprocess.DEVNULL,
                                             stdout=out, stderr=err, start_new_session=True, close_fds=True)
                    self.groups.add(child.pid)
                finally:
                    for signum, handler in launch_handlers.items():
                        signal.signal(signum, handler)
                if pending_signal[0]:
                    raise KeyboardInterrupt
                while child.poll() is None:
                    self.children.observe()
                    self.tick()
                    need(time.monotonic() - start <= seconds, 'Command timeout: ' + label)
                    need(stdout.stat().st_size <= cap and stderr.stat().st_size <= cap, 'Command log cap')
                    time.sleep(.2)
            finally:
                if child is not None:
                    self.stop(child)
                log_entries, log_failure = stopped_log_evidence(stdout, stderr, cap)
                self.commands.append({'label': label, 'argv': argv, 'direct_pid': child.pid if child else None, 'exit': child.returncode if child else None,
                    'stdout': log_entries['stdout'], 'stderr': log_entries['stderr'], 'log_cap': cap,
                    'owned_descendants_absent': not self.groups,
                    'stopped_family_identity_count': len(self.children.last_stopped),
                    'stopped_family_identity_sha256': hashlib.sha256(json.dumps(self.children.last_stopped).encode()).hexdigest()})
                need(not log_failure, 'Stopped log cap/authentication refused')
        need(stdout.stat().st_size <= cap and stderr.stat().st_size <= cap, 'Final command log cap')
        need(child.returncode == 0, 'Command failed: ' + label)
        return stdout


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        super().__init__()
        self.count = 0

    def redirect_request(self, request, fp, code, message, headers, url):
        self.count += 1
        parsed = urllib.parse.urlsplit(url)
        need(self.count <= 3 and parsed.scheme == 'https' and parsed.hostname in
             ('github.com', 'release-assets.githubusercontent.com') and parsed.port in (None, 443)
             and not parsed.username and not parsed.password and not parsed.fragment, 'Public tool redirect')
        return super().redirect_request(request, fp, code, message, headers, url)


def acquire_tool(guard):
    archive = guard.root / 'tools' / 'publisher.tar.gz'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PublicRedirect())
    hasher = hashlib.sha256()
    size = 0
    started = time.monotonic()
    with opener.open(TOOL_URL, timeout=10) as response, archive.open('xb') as target:
        need(response.status == 200, 'Publisher tool response')
        while chunk := response.read(65536):
            guard.tick()
            need(time.monotonic() - started <= 120, 'Tool download deadline')
            size += len(chunk)
            need(size <= TOOL_SIZE, 'Tool compressed cap')
            hasher.update(chunk)
            need(shutil.disk_usage(guard.root).free >= STOP + reserve(len(chunk)) + 2 * MIB, 'Download floor reserve')
            target.write(chunk)
    need(size == TOOL_SIZE and hasher.hexdigest() == TOOL_SHA, 'Publisher tool bytes')
    records = extract_tool(archive, guard.root / 'tools', guard.tick)
    binary = guard.root / 'tools' / 'wasm-bindgen'
    output = guard.command([str(binary), '--version'], 'bindgen-version', 10, 4096)
    need(output.read_bytes().strip() == b'wasm-bindgen 0.2.130', 'CLI version')
    return binary, records


class CompressedInput:
    def __init__(self, source):
        self.source, self.count, self.hasher = source, 0, hashlib.sha256()

    def read(self, size=-1):
        need(type(size) is int and size >= 0, 'Bounded compressed read')
        value = self.source.read(min(size, 65536))
        self.count += len(value)
        need(self.count <= TOOL_SIZE, 'Compressed read cap')
        self.hasher.update(value)
        return value


def extract_tool(archive, output, tick):
    """Read bounded raw headers; authenticate actual compressed decoder input."""
    need(archive.stat().st_size == TOOL_SIZE and digest(archive) == TOOL_SHA, 'Tool archive pin')
    seen, records, decoded = set(), [], 0
    with archive.open('rb') as raw:
        before = os.fstat(raw.fileno())
        compressed = CompressedInput(raw)
        with gzip.GzipFile(fileobj=compressed, mode='rb') as stream:
            def read_exact(size):
                nonlocal decoded
                need(0 <= size <= 65536, 'Bounded decoded read')
                body = stream.read(size)
                decoded += len(body)
                need(decoded <= 192 * MIB and len(body) == size, 'Tool truncated/decoded cap')
                return body
            while True:
                tick()
                header = read_exact(512)
                if header == bytes(512):
                    need(read_exact(512) == bytes(512), 'Tool end marker')
                    padding = 0
                    while extra := stream.read(65536):
                        decoded += len(extra)
                        padding += len(extra)
                        need(decoded <= 192 * MIB and padding <= MIB and not any(extra), 'Tool trailing decoded data')
                    break
                def octal(value):
                    value = value.rstrip(b'\0 ').lstrip(b' ')
                    need(value and all(48 <= byte <= 55 for byte in value), 'Tool octal header')
                    return int(value, 8)
                need(octal(header[148:156]) == sum(header[:148]) + 8 * 32 + sum(header[156:]), 'Tool header checksum')
                need(header[257:263] in (b'ustar\0', b'ustar '), 'Tool header format')
                need(not header[345:500].strip(b'\0'), 'Tool prefix forbidden')
                name = header[:100].split(b'\0', 1)[0].decode('ascii')
                kind, size, mode = header[156:157], octal(header[124:136]), octal(header[100:108])
                need(kind in (b'0', b'\0', b'5') and not header[157:257].strip(b'\0'), 'Tool links/extensions forbidden')
                directory = kind == b'5'
                if directory:
                    need(name.rstrip('/') == TOOL_PREFIX.rstrip('/') and size == 0, 'Tool root directory')
                    relative = ''
                else:
                    need(name.startswith(TOOL_PREFIX), 'Tool member root')
                    relative = name[len(TOOL_PREFIX):]
                    need(relative in TOOL_MEMBERS, 'Tool closed member')
                need(relative not in seen and len(seen) < 7, 'Tool duplicate/member count')
                seen.add(relative)
                need(mode & ~0o170777 == 0 and mode & 0o170000 in (0, 0o040000 if directory else 0o100000),
                     'Tool member kind/mode')
                need(size <= 128 * MIB, 'Tool member size')
                selected = relative in {'wasm-bindgen', 'README.md', 'LICENSE-MIT', 'LICENSE-APACHE'}
                target = (output / relative).open('xb') if selected else None
                hasher, remaining = hashlib.sha256(), size
                try:
                    while remaining:
                        tick()
                        body = read_exact(min(65536, remaining))
                        hasher.update(body)
                        if target is not None:
                            need(shutil.disk_usage(output).free >= STOP + reserve(len(body)) + 2 * MIB, 'Extraction floor reserve')
                            target.write(body)
                        remaining -= len(body)
                finally:
                    if target is not None:
                        target.close()
                pad = (-size) % 512
                need(not any(read_exact(pad)), 'Tool member padding')
                if selected:
                    (output / relative).chmod(0o700 if relative == 'wasm-bindgen' else 0o600)
                records.append({'path': name, 'bytes': size, 'mode': mode, 'sha256': hasher.hexdigest()})
        need(compressed.read(1) == b'', 'Unconsumed compressed bytes')
        after = os.fstat(raw.fileno())
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'Tool archive changed')
        need(compressed.count == TOOL_SIZE and compressed.hasher.hexdigest() == TOOL_SHA and
             seen - {''} == TOOL_MEMBERS, 'Tool consumed bytes/inventory differ')
    return records


def cargo_artifact(log, repo, target):
    matches = []
    with log.open('rb') as stream:
        while True:
            line = stream.readline(MAX_CARGO_ROW + 1)
            if not line:
                break
            need(len(line) <= MAX_CARGO_ROW, 'Cargo JSON row cap')
            value = json.loads(line)
            if value.get('reason') != 'compiler-artifact':
                continue
            t = value.get('target', {})
            if (value.get('manifest_path') == str(repo / 'packages/kodera-rs/Cargo.toml') and t.get('name') == 'kodera_rs' and
                set(t.get('crate_types', [])) == {'rlib', 'staticlib', 'cdylib'} and
                1 <= len(t.get('kind', [])) <= 3 and set(t['kind']) <= {'lib', 'rlib', 'staticlib', 'cdylib'}):
                for name in value.get('filenames', []):
                    if name.endswith('.wasm'):
                        candidate = Path(name)
                        need(not candidate.is_symlink() and candidate.resolve(strict=True).is_relative_to(target.resolve(strict=True)),
                             'WASM artifact outside target')
                        need(candidate.is_file() and 0 < candidate.stat().st_size <= 32 * MIB, 'WASM artifact shape')
                        with candidate.open('rb') as raw:
                            need(raw.read(8) == b'\0asm\1\0\0\0', 'WASM module header')
                        matches.append(candidate)
    need(len(matches) == 1, 'Exact compiler-artifact selection')
    return matches[0]


def generated_inventory(root):
    rows, total, snippets = [], 0, 0
    def inventory_error(error):
        raise error
    for current, dirs, files in os.walk(root, followlinks=False, onerror=inventory_error):
        need(len(Path(current).relative_to(root).parts) <= 8, 'Generated depth')
        for name in dirs:
            need(not (Path(current) / name).is_symlink(), 'Generated directory link')
        for name in files:
            item = Path(current) / name
            relative = item.relative_to(root).as_posix()
            need(not item.is_symlink() and item.is_file(), 'Generated file kind')
            size = item.stat().st_size
            is_snippet = relative.startswith('snippets/')
            need(relative in GENERATED_REQUIRED or is_snippet and item.suffix == '.js', 'Generated closed output')
            need(size <= (32 * MIB if relative == 'kodera_rs_bg.wasm' else 2 * MIB), 'Generated file cap')
            total += size
            snippets += size if is_snippet else 0
            rows.append({'path': relative, 'bytes': size, 'sha256': digest(item)})
            need(len(rows) <= 128 and snippets <= 4 * MIB and total <= 39 * MIB, 'Generated aggregate cap')
    need(GENERATED_REQUIRED <= {row['path'] for row in rows}, 'Generated required files absent')
    return sorted(rows, key=lambda row: row['path'])


def browser_report(log, names, executed):
    report = json.loads(log.read_bytes())
    specs = []
    def visit(suites):
        need(type(suites) is list and len(suites) <= 64, 'Browser suite cap')
        for suite in suites:
            specs.extend(suite.get('specs', []))
            visit(suite.get('suites', []))
    visit(report['suites'])
    need(not report.get('errors') and len(specs) == len(names) and
         sorted(spec['title'] for spec in specs) == sorted('device: ' + name for name in names), 'Browser discovery differs')
    for spec in specs:
        need(len(spec['tests']) == 1, 'Single managed project required')
        test = spec['tests'][0]
        need(test['expectedStatus'] == 'passed', 'Browser skip/failure annotation')
        if executed:
            need(len(test['results']) == 1 and test['results'][0]['status'] == 'passed' and
                 test['results'][0].get('retry', 0) == 0, 'Every browser case must actually pass once')


def finish(guard, proof):
    """Public first proof precedes any deletion; uncertainty retains all state."""
    proof.update(minimum_free=guard.minimum_free, sampled_partition_peaks=guard.peaks,
                 cleanup_pending=True, root=str(guard.root))
    if guard.groups or guard.children.handles:
        proof['unreaped_identities'] = [[pid, value[1]] for pid, value in sorted(guard.children.handles.items())]
        json_new(guard.root / 'recovery.json', proof)
        raise Refused('Children uncertain; retain root and recovery receipt')
    json_new(guard.root / 'precleanup.json', proof)
    evidence = guard.root.with_name(guard.root.name + '-public-evidence')
    need(not os.path.lexists(evidence) and shutil.disk_usage(guard.root).free >= STOP + 16 * MIB,
         'Evidence-copy reservation')
    evidence.mkdir(mode=0o700)
    rows = []
    for name in ('artifact-manifest.json', 'semantic-abi.json', 'browser-provenance.json', 'lifecycle-qualification.json'):
        source = guard.root / name
        if source.exists():
            need(source.is_file() and not source.is_symlink() and source.stat().st_size <= MIB, 'Public receipt shape')
            body = source.read_bytes()
            json.loads(body)
            write_new(evidence / name, body)
            rows.append({'name': name, 'bytes': len(body), 'sha256': digest(evidence / name)})
    if proof['status'] != 'COMPONENT_BROWSER_PROOF_COMPLETE' and guard.commands:
        last = guard.commands[-1]
        need(re.fullmatch('[a-z-]+', last['label']), 'Closed diagnostic label')
        for stream in ('stdout', 'stderr'):
            source = guard.root / 'logs' / (last['label'] + '.' + stream)
            descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as file:
                current = os.fstat(file.fileno())
                need(stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid(), 'Diagnostic file kind/owner')
                value = file.read(256 * 1024)
                if current.st_size > len(value):
                    file.seek(max(len(value), current.st_size - 256 * 1024))
                    value += b'\n[bounded public diagnostic tail]\n' + file.read(256 * 1024)
                current = os.fstat(file.fileno())
            destination = evidence / (last['label'] + '.' + stream)
            write_new(destination, value)
            recorded = last[stream]
            unchanged = recorded.get('identity') == [current.st_dev, current.st_ino, current.st_mtime_ns] and recorded['bytes'] == current.st_size
            original_digest = recorded.get('sha256') if unchanged and current.st_size <= last['log_cap'] else None
            row = {'name': destination.name, 'bytes': len(value), 'sha256': digest(destination),
                   'original_bytes': current.st_size, 'original_sha256': original_digest}
            if original_digest is None:
                row['original_digest_omitted_reason'] = recorded.get('digest_omitted_reason', 'Stopped log metadata changed')
            else:
                row['original_digest_origin'] = 'Previously bounded stopped-log evidence; no full reread'
            rows.append(row)
    for label in ('browser-discovery', 'browser-proof'):
        source = guard.root / 'logs' / (label + '.stdout')
        if source.exists() and source.stat().st_size <= MIB:
            body = source.read_bytes()
            try:
                json.loads(body)
            except (ValueError, UnicodeError):
                continue
            destination = evidence / (label + '.json')
            write_new(destination, body)
            rows.append({'name': destination.name, 'bytes': len(body), 'sha256': digest(destination)})
    proof['retained_public_diagnostics'] = rows
    json_new(evidence / 'precleanup.json', proof)
    need(identity(guard.root) == guard.ident and shutil.rmtree.avoids_symlink_attacks,
         'Verified root/safe cleanup required')
    shutil.rmtree(guard.root)
    need(not os.path.lexists(guard.root), 'Private prefix remains')
    proof.update(cleanup_pending=False, owned_private_root_removed=True)
    json_new(evidence / 'result.json', proof)
    print(json.dumps({'status': proof['status'], 'public_evidence': str(evidence),
                      'result_sha256': digest(evidence / 'result.json')}, sort_keys=True))


def qualify_descendant_cleanup(guard):
    # Fixed public fixture: an acknowledged double-forked daemon uses a new
    # session/group, then its leader exits. No caller-provided program executes.
    marker = guard.root / 'lifecycle-child.json'
    program = r"""
import json, os, signal, sys, time
blocked = signal.pthread_sigmask(signal.SIG_BLOCK, [])
if signal.SIGINT in blocked or signal.SIGTERM in blocked:
    os._exit(2)
received = []
signal.signal(signal.SIGTERM, lambda signum, frame: received.append(signum))
os.kill(os.getpid(), signal.SIGTERM)
if received != [signal.SIGTERM]:
    os._exit(3)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
read_fd, write_fd = os.pipe()
if os.fork() == 0:
    os.close(read_fd)
    os.setsid()
    if os.fork() == 0:
        with open(sys.argv[1], 'x') as target:
            json.dump({'pid': os.getpid(), 'pgid': os.getpgrp(), 'sigterm_delivered': True, 'termination_mask_unblocked': True}, target)
            target.flush()
        os.write(write_fd, b'1')
        os.close(write_fd)
        time.sleep(60)
        os._exit(0)
    os.close(write_fd)
    os._exit(0)
os.close(write_fd)
if os.read(read_fd, 1) != b'1':
    os._exit(1)
os.close(read_fd)
os._exit(0)
"""
    guard.command([sys.executable, '-I', '-S', '-B', '-c', program, str(marker)], 'owned-lifecycle', 8, 4096)
    need(marker.is_file() and marker.stat().st_size <= 128, 'Lifecycle acknowledgement absent')
    value = json.loads(marker.read_bytes())
    need(type(value) is dict and set(value) == {'pid', 'pgid', 'sigterm_delivered', 'termination_mask_unblocked'} and
         all(type(value[key]) is int and value[key] > 1 for key in ('pid', 'pgid')) and
         value['sigterm_delivered'] is True and value['termination_mask_unblocked'] is True, 'Lifecycle marker schema')
    record = guard.commands[-1]
    need(value['pid'] in {pid for pid, start in guard.children.last_stopped} and
         value['pgid'] != record['direct_pid'] and not guard.children.children(os.getpid()),
         'Detached orphan identity/absence proof')
    json_new(guard.root / 'lifecycle-qualification.json', {'schema': 'owned-linux-lifecycle-v1',
        'detached_orphan_reaped': True, 'child_sigterm_delivered': True, 'child_termination_mask_unblocked': True, 'public_fixture_pid': value['pid'],
        'public_fixture_pgid': value['pgid'], 'stopped_family_identity_sha256': record['stopped_family_identity_sha256']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    need(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'Hosted Linux x86_64 required')
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
         'Managed hosted runner required')
    repo = Path(__file__).resolve().parents[2]
    root = Path(args.root)
    temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    need(root.is_absolute() and root.resolve(strict=True) == root and root.parent == temp and
         root.name.startswith('kodera-wasm-proof-') and not root.is_symlink() and not any(root.iterdir()) and
         stat.S_IMODE(root.stat().st_mode) == 0o700, 'Fresh private proof root')
    need(shutil.disk_usage(root).free >= ADMIT, 'Fresh hosted 28GiB admission')
    guard = Guard(root, repo)
    old = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    for s in old:
        signal.signal(s, interrupted)
    proof = {'status': 'STARTED', 'scope': 'Generated component proof only', 'commands': guard.commands}
    try:
        qualify_descendant_cleanup(guard)
        proof['source_head'] = guard.command(['git', 'rev-parse', 'HEAD'], 'source-head', 10, 4096).read_text().strip()
        proof['lock_sha256'] = digest(repo / 'Cargo.lock')
        proof['npm_lock_sha256'] = digest(repo / 'package-lock.json')
        for command, label in ((['rustc', '+1.100.0', '--version', '--verbose'], 'rust-version'),
                               (['node', '--version'], 'node-version'), (['npm', '--version'], 'npm-version')):
            proof[label] = guard.command(command, label, 10, 4096).read_text().strip()
        need(proof['rust-version'].startswith('rustc 1.100.0 (') and proof['node-version'].startswith('v22.'), 'Pinned Rust and Node major')
        guard.command(['npm', 'ci', '--ignore-scripts'], 'npm-ci', 120)
        cli = repo / 'apps/web/node_modules/playwright/cli.js'
        need(cli.is_file() and not cli.is_symlink(), 'Exact workspace browser CLI absent')
        guard.command(['node', str(cli), 'install', 'chromium'], 'browser-install', 90)
        binary, proof['publisher_members'] = acquire_tool(guard)
        log = guard.command(['cargo', '+1.100.0', 'build', '--locked', '-p', 'kodera-rs', '--lib',
            '--no-default-features', '--features', 'browser-bindings', '--target', 'wasm32-unknown-unknown',
            '--profile', 'dev', '--config', 'profile.dev.debug=0', '--message-format=json', '--jobs', '2'],
            'cargo-build', 300, 32 * MIB)
        artifact = cargo_artifact(log, repo, Path(guard.env['CARGO_TARGET_DIR']))
        proof['raw_wasm_sha256'] = digest(artifact)
        guard.command([str(binary), str(artifact), '--target', 'web', '--out-name', 'kodera_rs',
                       '--out-dir', str(root / 'generated')], 'codegen', 90)
        rows = generated_inventory(root / 'generated')
        proof['generated'] = rows
        proof['bindgen_binary_sha256'] = digest(binary)
        json_new(root / 'artifact-manifest.json', {'schema': 'wasm-device-proof-v1',
            'source_head': proof['source_head'], 'lock_sha256': proof['lock_sha256'], 'files': rows})
        proof['manifest_sha256'] = digest(root / 'artifact-manifest.json')
        guard.command(['node', 'apps/web/tests/wasm/prepare-fixtures.mjs'], 'semantic-abi', 30, MIB)
        command = ['node', str(cli), 'test', '--config', 'apps/web/tests/wasm/playwright.config.mjs', '--reporter=json']
        names = json.loads((repo / 'apps/web/tests/wasm/cases.json').read_text())
        need(type(names) is list and len(names) == 50 and len(set(names)) == 50 and
             all(type(name) is str and re.fullmatch('[a-z-]+', name) for name in names), 'Closed browser inventory')
        listing = guard.command(command + ['--list'], 'browser-discovery', 20, MIB)
        browser_report(listing, names, False)
        actual = guard.command(command, 'browser-proof', CASE_BUDGET, MIB)
        browser_report(actual, names, True)
        proof['status'] = 'COMPONENT_BROWSER_PROOF_COMPLETE'
    except BaseException as exc:
        proof['status'] = 'REFUSED'
        proof['failure'] = type(exc).__name__ + (': ' + str(exc) if isinstance(exc, Refused) else '')
        raise
    finally:
        try:
            # Stop/reap already occurs in each command's finally. Ignore further
            # cancellation only while preserving first proof and owned cleanup.
            for signum in old:
                signal.signal(signum, signal.SIG_IGN)
            finish(guard, proof)
        finally:
            for signum, handler in old.items():
                signal.signal(signum, handler)


if __name__ == '__main__':
    main()

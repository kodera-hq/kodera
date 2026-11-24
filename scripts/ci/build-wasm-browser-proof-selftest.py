#!/usr/bin/env python3
"""Tiny public fixtures only; no network, compiler, child, browser or private keys."""
import gzip
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('build-wasm-browser-proof.py')
spec = importlib.util.spec_from_file_location('browser_proof_owner', SOURCE)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


def tar_entry(name, body=b'', kind=b'0', mode=0o644):
    header = bytearray(512)
    header[:len(name)] = name.encode('ascii')
    for start, length, value in ((100, 8, mode), (108, 8, 0), (116, 8, 0), (124, 12, len(body)), (136, 12, 0)):
        header[start:start+length] = (format(value, 'o').zfill(length-1) + '\0').encode()
    header[148:156] = b'        '; header[156:157] = kind
    header[257:263] = b'ustar\0'; header[263:265] = b'00'
    header[148:156] = (format(sum(header), 'o').zfill(6) + '\0 ').encode()
    return bytes(header) + body + bytes((-len(body)) % 512)


def public_archive(changed=None):
    body = tar_entry(M.TOOL_PREFIX.rstrip('/'), kind=b'5', mode=0o755)
    for name in sorted(M.TOOL_MEMBERS):
        payload = b'INVALID public fixture; never execute\n'
        if changed and name == 'README.md':
            payload = b'CHANGED public fixture; never execute\n'
        body += tar_entry(M.TOOL_PREFIX + name, payload, mode=0o755 if name.startswith('wasm') else 0o644)
    return gzip.compress(body + bytes(1024), compresslevel=0, mtime=0)


class CompressedReadControls(unittest.TestCase):
    def test_large_decoder_requests_return_authenticated_bounded_short_reads(self):
        class Source(io.BytesIO):
            def __init__(self, body):
                super().__init__(body)
                self.requests = []
            def read(self, size):
                self.requests.append(size)
                return super().read(size)

        data = b'public-compressed-reader-fixture' * 2300
        source = Source(data)
        reader = M.CompressedInput(source)
        consumed = bytearray()
        with patch.object(M, 'TOOL_SIZE', len(data)):
            for request in (0, 1, 65536, 65537, 2**63):
                value = reader.read(request)
                self.assertLessEqual(len(value), min(request, 65536))
                consumed.extend(value)
                self.assertEqual(reader.count, len(consumed))
                self.assertEqual(reader.hasher.hexdigest(), hashlib.sha256(consumed).hexdigest())
            self.assertEqual(bytes(consumed), data)
            self.assertEqual(source.requests, [0, 1, 65536, 65536, 65536])
            self.assertEqual(reader.read(2**63), b'')
            for request in (-1, None, 1.5, True):
                before = len(source.requests)
                with self.assertRaisesRegex(M.Refused, 'Bounded compressed read'):
                    reader.read(request)
                self.assertEqual(len(source.requests), before)
        # The independent stream cap remains enforced even when decoder requests are large.
        with patch.object(M, 'TOOL_SIZE', 1):
            with self.assertRaisesRegex(M.Refused, 'Compressed read cap'):
                M.CompressedInput(io.BytesIO(b'public')).read(2**63)


class AllocationSocketControls(unittest.TestCase):
    @contextlib.contextmanager
    def owned_socket(self, root, relative):
        import socket
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            channel.bind(str(path))
            yield path
        finally:
            channel.close()
            path.unlink(missing_ok=True)

    def test_real_owned_tmp_socket_is_counted_only_with_private_root_opt_in(self):
        with tempfile.TemporaryDirectory(prefix='wasm-ipc-', dir='/tmp') as name:
            root = Path(name).resolve()
            with self.owned_socket(root, 'tmp/browser/ipc') as channel:
                (root / 'public').write_bytes(b'public allocation fixture')
                self.assertTrue(M.stat.S_ISSOCK(channel.lstat().st_mode))
                expected = root.lstat().st_blocks * 512 + sum(
                    item.lstat().st_blocks * 512 for item in root.rglob('*'))
                self.assertGreaterEqual(M.physical(root, allow_tmp_sockets=True), expected)
                with self.assertRaisesRegex(M.Refused, 'Special allocation kind=socket path="tmp/browser/ipc"'):
                    M.physical(root)

    def test_real_socket_outside_private_tmp_and_fifo_inside_tmp_are_refused_with_path_kind(self):
        with tempfile.TemporaryDirectory(prefix='wasm-ipc-', dir='/tmp') as name:
            root = Path(name).resolve()
            (root / 'tmp').mkdir()
            with self.owned_socket(root, 'logs/not-tmp'):
                with self.assertRaisesRegex(M.Refused, 'Special allocation kind=socket path="logs/not-tmp"'):
                    M.physical(root, allow_tmp_sockets=True)
            fifo = root / 'tmp/pipe'
            os.mkfifo(fifo, 0o600)
            try:
                with self.assertRaisesRegex(M.Refused, 'Special allocation kind=fifo path="tmp/pipe"'):
                    M.physical(root, allow_tmp_sockets=True)
            finally:
                fifo.unlink()

    def test_real_socket_with_foreign_uid_metadata_is_refused_before_accounting(self):
        with tempfile.TemporaryDirectory(prefix='wasm-ipc-', dir='/tmp') as name:
            root = Path(name).resolve()
            with self.owned_socket(root, 'tmp/ipc') as channel:
                original = Path.lstat
                def foreign(path, *args, **kwargs):
                    value = original(path, *args, **kwargs)
                    if path == channel:
                        return types.SimpleNamespace(st_uid=os.getuid() + 1, st_dev=value.st_dev,
                                                     st_mode=value.st_mode, st_blocks=value.st_blocks)
                    return value
                with patch.object(Path, 'lstat', foreign):
                    with self.assertRaisesRegex(M.Refused, 'Foreign allocation'):
                        M.physical(root, allow_tmp_sockets=True)

    def test_tmp_directory_alias_is_refused_before_socket_walk(self):
        with tempfile.TemporaryDirectory(prefix='wasm-ipc-', dir='/tmp') as name:
            root = Path(name).resolve()
            (root / 'elsewhere').mkdir()
            (root / 'tmp').symlink_to(root / 'elsewhere', target_is_directory=True)
            with self.assertRaisesRegex(M.Refused, 'Owned directory identity'):
                M.physical(root, allow_tmp_sockets=True)

    def test_guard_enables_socket_accounting_only_for_its_private_root_partition(self):
        with tempfile.TemporaryDirectory(prefix='wasm-ipc-', dir='/tmp') as name:
            root = Path(name).resolve()
            guard = M.Guard.__new__(M.Guard)
            guard.root = root
            guard.ident = M.identity(root)
            guard.started = 0
            guard.minimum_free = M.STOP + 1
            guard.last_sample = float('-inf')
            guard.peaks = {}
            guard.env = {key: str(root / key) for key in ('CARGO_TARGET_DIR', 'RUSTUP_HOME', 'CARGO_HOME')}
            guard.npm_roots = [root / 'node_modules']
            observed = []
            def measure(path, *, allow_tmp_sockets=False):
                observed.append((path, allow_tmp_sockets))
                return 0
            with patch.object(M.time, 'monotonic', return_value=1), \
                 patch.object(M.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=M.STOP + 1)), \
                 patch.object(M, 'physical', side_effect=measure):
                guard.tick()
            self.assertEqual(observed, [(Path(guard.env['CARGO_TARGET_DIR']), False),
                (Path(guard.env['RUSTUP_HOME']), False), (Path(guard.env['CARGO_HOME']), False),
                (root, True), (root / 'node_modules', False)])


class ArtifactControls(unittest.TestCase):
    def setUp(self):
        patcher=patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+32*M.MIB))
        patcher.start(); self.addCleanup(patcher.stop)

    def test_public_tool_baseline_and_unknown_path_refusal(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'public.gz'; out = root / 'out'; out.mkdir()
            data = public_archive(); archive.write_bytes(data)
            with patch.object(M, 'TOOL_SIZE', len(data)), patch.object(M, 'TOOL_SHA', hashlib.sha256(data).hexdigest()):
                rows = M.extract_tool(archive, out, lambda: None)
            self.assertEqual(len(rows), 7)
            self.assertEqual({item.name for item in out.iterdir()}, {'wasm-bindgen', 'README.md', 'LICENSE-MIT', 'LICENSE-APACHE'})
        bad = gzip.compress(tar_entry(M.TOOL_PREFIX + '../escape', b'public') + bytes(1024), mtime=0)
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'public.gz'; archive.write_bytes(bad)
            with patch.object(M, 'TOOL_SIZE', len(bad)), patch.object(M, 'TOOL_SHA', hashlib.sha256(bad).hexdigest()):
                with self.assertRaisesRegex(M.Refused, 'closed member'):
                    M.extract_tool(archive, root, lambda: None)
            self.assertFalse((root.parent / 'escape').exists())

    def test_actual_compressed_read_view_refuses_and_bad_guard_is_caught(self):
        a, b = public_archive(), public_archive(True)
        self.assertEqual(len(a), len(b))
        real_need = M.need
        def attempt():
            with tempfile.TemporaryDirectory() as name:
                root = Path(name); archive = root / 'public.gz'; archive.write_bytes(a)
                original = Path.open
                def alternate(path, *args, **kwargs):
                    if path == archive and args == ('rb',):
                        raw = original(path, *args, **kwargs)
                        # Pinning pass reads A; decoder pass alone sees B with stable fstat(A).
                        if not getattr(alternate, 'pinned', False):
                            alternate.pinned = True
                            return raw
                        view = io.BytesIO(b)
                        class Reader:
                            def __enter__(self): return self
                            def __exit__(self, *exc): raw.close()
                            def read(self, size): return view.read(size)
                            def fileno(self): return raw.fileno()
                        return Reader()
                    return original(path, *args, **kwargs)
                with patch.object(M, 'TOOL_SIZE', len(a)), patch.object(M, 'TOOL_SHA', hashlib.sha256(a).hexdigest()), patch.object(Path, 'open', alternate):
                    with self.assertRaisesRegex(M.Refused, 'consumed bytes'):
                        M.extract_tool(archive, root, lambda: None)
        attempt()
        def bypass(value, reason):
            if reason != 'Tool consumed bytes/inventory differ': real_need(value, reason)
        with patch.object(M, 'need', bypass), self.assertRaises(AssertionError):
            attempt()

    def test_real_manifest_selector_refuses_wrong_root_and_multiple_records(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); target = root / 'target'; target.mkdir(); wasm = target / 'public.wasm'; wasm.write_bytes(b'\0asm\1\0\0\0')
            row = {'reason': 'compiler-artifact', 'manifest_path': str(root/'packages/kodera-rs/Cargo.toml'),
                   'target': {'name': 'kodera_rs', 'kind': ['lib'], 'crate_types': ['rlib','staticlib','cdylib']}, 'filenames': [str(wasm)]}
            log = root/'public.jsonl'; log.write_text(json.dumps(row)+'\n')
            self.assertEqual(M.cargo_artifact(log, root, target), wasm)
            log.write_text((json.dumps(row)+'\n')*2)
            with self.assertRaisesRegex(M.Refused, 'Exact compiler-artifact'): M.cargo_artifact(log, root, target)
            outside = root/'outside.wasm'; outside.write_bytes(b'\0asm\1\0\0\0'); row['filenames']=[str(outside)]
            log.write_text(json.dumps(row)+'\n')
            with self.assertRaisesRegex(M.Refused, 'outside target'): M.cargo_artifact(log, root, target)

    def test_generated_real_files_required_and_link_refused(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for filename in M.GENERATED_REQUIRED: (root/filename).write_bytes(b'public')
            self.assertEqual(len(M.generated_inventory(root)), 4)
            (root/'kodera_rs.js').unlink(); (root/'kodera_rs.js').symlink_to(root/'kodera_rs.d.ts')
            with self.assertRaisesRegex(M.Refused, 'file kind'): M.generated_inventory(root)

    def test_discovery_and_actual_skip_retry_missing_mutants(self):
        with tempfile.TemporaryDirectory() as name:
            log = Path(name)/'public.json'
            test = {'expectedStatus':'passed','results':[{'status':'passed','retry':0}]}
            report = {'suites':[{'specs':[{'title':'device: create','tests':[test]}]}]}
            log.write_text(json.dumps(report)); M.browser_report(log,['create'],True)
            for mutation in ('skip','retry','missing'):
                changed=json.loads(json.dumps(report))
                value=changed['suites'][0]['specs'][0]['tests'][0]
                if mutation=='skip': value['results'][0]['status']='skipped'
                if mutation=='retry': value['results'][0]['retry']=1
                if mutation=='missing': changed['suites'][0]['specs']=[]
                log.write_text(json.dumps(changed))
                with self.assertRaises(M.Refused): M.browser_report(log,['create'],True)


class SupplementalReportControls(unittest.TestCase):
    """Synthetic report parsing only, never a browser/native acceptance receipt."""
    @staticmethod
    def report(legacy, supplemental):
        titles = ['device: ' + name for name in legacy] + ['device HTTP: ' + name for name in supplemental]
        return {'suites': [{'specs': [{'title': title, 'tests': [
            {'expectedStatus': 'passed', 'results': [{'status': 'passed', 'retry': 0}]}]} for title in titles]}]}

    def test_real_closed_legacy50_and_supplemental35_parser_inputs(self):
        fixtures = SOURCE.parents[2] / 'apps/web/tests/wasm'
        legacy = json.loads((fixtures / 'cases.json').read_text())
        supplemental = M.http_inventory(fixtures / 'http-cases.json')
        self.assertEqual(len(legacy), 50)
        self.assertEqual(len(supplemental), 35)
        with tempfile.TemporaryDirectory() as name:
            log = Path(name) / 'public.json'
            log.write_text(json.dumps(self.report(legacy, [])))
            self.assertEqual(M.browser_report(log, legacy, True),
                             {'legacy_device_cases': 50, 'http_host_oracle_cases': 0})
            log.write_text(json.dumps(self.report(legacy, supplemental)))
            self.assertEqual(M.browser_report(log, legacy, True, supplemental),
                             {'legacy_device_cases': 50, 'http_host_oracle_cases': 35})
            M.browser_report(log, legacy, False, supplemental)

    def test_supplemental_missing_duplicate_skip_retry_scope_title_and_project_refuse(self):
        with tempfile.TemporaryDirectory() as name:
            log = Path(name) / 'public.json'
            for mutation in ('missing', 'duplicate', 'skip', 'retry', 'scope', 'title', 'project'):
                with self.subTest(mutation=mutation):
                    report = self.report(['create'], ['http-flow'])
                    specs = report['suites'][0]['specs']
                    if mutation == 'missing': specs.pop()
                    if mutation == 'duplicate': specs.append(json.loads(json.dumps(specs[-1])))
                    if mutation == 'skip': specs[-1]['tests'][0]['results'][0]['status'] = 'skipped'
                    if mutation == 'retry': specs[-1]['tests'][0]['results'][0]['retry'] = 1
                    if mutation == 'scope': specs[-1]['title'] = 'device: http-flow'
                    if mutation == 'title': specs[-1]['title'] = 'device HTTP: http-unlisted'
                    if mutation == 'project': specs[-1]['tests'].append(json.loads(json.dumps(specs[-1]['tests'][0])))
                    log.write_text(json.dumps(report))
                    with self.assertRaises(M.Refused): M.browser_report(log, ['create'], True, ['http-flow'])

    def test_http_inventory_requires_closed_host_oracle_scope(self):
        fixtures = SOURCE.parents[2] / 'apps/web/tests/wasm'
        original = json.loads((fixtures / 'http-cases.json').read_text())
        with tempfile.TemporaryDirectory() as name:
            source = Path(name) / 'public.json'
            for mutation in ('scope', 'unknown', 'duplicate', 'prefix', 'missing', 'duplicate-key'):
                with self.subTest(mutation=mutation):
                    value = json.loads(json.dumps(original))
                    if mutation == 'scope': value['hostOracleOnly'] = False
                    if mutation == 'unknown': value['realCore'] = True
                    if mutation == 'duplicate': value['cases'][-1] = value['cases'][0]
                    if mutation == 'prefix': value['cases'][0] = 'create'
                    if mutation == 'missing': value['cases'].pop()
                    text = json.dumps(value)
                    if mutation == 'duplicate-key': text = '{"hostOracleOnly":true,' + text[1:]
                    source.write_text(text)
                    with self.assertRaises(M.Refused): M.http_inventory(source)


class GeneratedExportControls(unittest.TestCase):
    """Actual tiny file I/O with invalid public code; never compile or execute it."""
    @contextlib.contextmanager
    def roots(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); source = root/'source'; target = root/'target'
            source.mkdir(); target.mkdir()
            a = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            b = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
            try: yield root, source, target, a, b
            finally: os.close(a); os.close(b)

    @staticmethod
    def row(path, body):
        return {'path': path, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}

    def test_bounded_regular_copy_and_exact_digest_readback(self):
        with self.roots() as (_, source, target, a, b):
            (source/'snippets/public').mkdir(parents=True)
            payload = b'INVALID public generated-code fixture\n' * 4096
            (source/'snippets/public/inline0.js').write_bytes(payload)
            checks = []
            M.copy_generated_file(a, b, self.row('snippets/public/inline0.js', payload), lambda: checks.append(True))
            self.assertEqual((target/'snippets/public/inline0.js').read_bytes(), payload)
            self.assertGreater(len(checks), 2)

    def test_both_source_and_destination_ancestor_aliases_refuse_before_foreign_creation(self):
        for side in ('source', 'target'):
            with self.subTest(side=side), self.roots() as (root, source, target, a, b):
                foreign = root/'foreign'; foreign.mkdir()
                (foreign/'sentinel').write_bytes(b'public foreign sentinel')
                (source/'snippets').mkdir(); (target/'snippets').mkdir()
                if side == 'source':
                    (foreign/'inline0.js').write_bytes(b'public')
                    (source/'snippets/public').symlink_to(foreign, target_is_directory=True)
                else:
                    (source/'snippets/public').mkdir(); (source/'snippets/public/inline0.js').write_bytes(b'public')
                    (target/'snippets/public').symlink_to(foreign, target_is_directory=True)
                with self.assertRaises((M.Refused, OSError)):
                    M.copy_generated_file(a, b, self.row('snippets/public/inline0.js', b'public'), lambda: None)
                self.assertEqual((foreign/'sentinel').read_bytes(), b'public foreign sentinel')
                self.assertEqual(sorted(p.name for p in foreign.iterdir()), ['inline0.js', 'sentinel'] if side == 'source' else ['sentinel'])
                if side == 'source': self.assertFalse((target/'snippets/public/inline0.js').exists())

    def test_fifo_foreign_owner_and_closed_path_cap_refuse(self):
        with self.roots() as (_, source, target, a, b):
            os.mkfifo(source/'kodera_rs.js')
            with self.assertRaises(M.Refused): M.copy_generated_file(a, b, self.row('kodera_rs.js', b'x'), lambda: None)
            self.assertFalse((target/'kodera_rs.js').exists())
            (source/'kodera_rs.js').unlink(); (source/'kodera_rs.js').write_bytes(b'x')
            original = M.os.fstat
            def foreign(fd):
                value = original(fd)
                if M.stat.S_ISREG(value.st_mode):
                    return types.SimpleNamespace(**{key: getattr(value, key) for key in
                        ('st_mode','st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_nlink')}, st_uid=os.getuid()+1)
                return value
            with patch.object(M.os, 'fstat', side_effect=foreign):
                with self.assertRaises(M.Refused): M.copy_generated_file(a, b, self.row('kodera_rs.js', b'x'), lambda: None)
            self.assertFalse((target/'kodera_rs.js').exists())
            os.link(source/'kodera_rs.js', source/'second-link')
            with self.assertRaises(M.Refused): M.copy_generated_file(a, b, self.row('kodera_rs.js', b'x'), lambda: None)
            (source/'second-link').unlink()
            for row in [self.row('../outside.js', b'x'), self.row('snippets/.env/private.js', b'x'),
                        {'path':'kodera_rs_bg.wasm','bytes':32*M.MIB+1,'sha256':'0'*64}]:
                with self.assertRaises(M.Refused): M.copy_generated_file(a, b, row, lambda: None)

    def test_wrong_hash_and_changed_source_never_create_complete_export(self):
        with self.roots() as (_, source, target, a, b):
            (source/'kodera_rs.js').write_bytes(b'public')
            row = self.row('kodera_rs.js', b'public'); row['sha256'] = '0'*64
            with self.assertRaises(M.Refused): M.copy_generated_file(a, b, row, lambda: None)
            self.assertFalse((target/'generated-export.json').exists())
        with self.roots() as (_, source, target, a, b):
            file = source/'kodera_rs.js'; file.write_bytes(b'public')
            original = M.os.read; changed = [False]
            def growing(fd, size):
                data = original(fd, size)
                if data and not changed[0]:
                    changed[0] = True; file.write_bytes(b'public plus unexpected tail')
                return data
            with patch.object(M.os, 'read', side_effect=growing):
                with self.assertRaises(M.Refused): M.copy_generated_file(a, b, self.row('kodera_rs.js', b'public'), lambda: None)

    def test_native_tree_rejects_link_submodule_secret_path_and_duplicate(self):
        line = b'100644 blob ' + b'a'*40 + b' 6\tCargo.toml\0'
        self.assertEqual(M.parse_native_tree(line)[0]['path'], 'Cargo.toml')
        for body in [line.replace(b'100644', b'120000'), line.replace(b'blob', b'commit'),
                     line.replace(b'Cargo.toml', b'packages/kodera-rs/.env'), line+line]:
            with self.assertRaises(M.Refused): M.parse_native_tree(body)

    def test_native_snapshot_closes_complete_namespace_modes_and_actual_git_blobs(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            values = {'Cargo.toml': ('[workspace]\nmembers=["packages/kodera-rs","apps/desktop/src-tauri"]\n'
                '[patch.crates-io]\n' + ''.join(key+'={path="'+path+'"}\n' for key,path in M.NATIVE_PATCHES.items())).encode(),
                'Cargo.lock': b'version = 3\n', 'apps/desktop/src-tauri/Cargo.toml': b'[package]\nname="public"\n',
                'packages/kodera-rs/Cargo.toml': b'[package]\nname="kodera-rs"\n', 'packages/kodera-rs/src/lib.rs': b'// public\n'}
            for path in M.NATIVE_PATCHES.values(): values[path+'/Cargo.toml'] = b'[package]\nname="public"\n'
            rows = []
            for path, body in values.items():
                target = root/path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(body); target.chmod(0o644)
                rows.append({'path':path,'mode':'100644','bytes':len(body),
                    'git_blob':hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest()})
            result = M.native_snapshot(root, rows, [], lambda: None)
            self.assertEqual(len(result), len(rows))
            (root/'packages/kodera-rs/src/untracked.rs').write_text('// unbound compiler input')
            with self.assertRaises(M.Refused): M.native_snapshot(root, rows, [], lambda: None)
            (root/'packages/kodera-rs/src/untracked.rs').unlink()
            (root/'packages/kodera-rs/src/lib.rs').chmod(0o755)
            with self.assertRaises(M.Refused): M.native_snapshot(root, rows, [], lambda: None)
            (root/'packages/kodera-rs/src/lib.rs').chmod(0o644)
            config = root/'config.toml'; config.write_text('# public unexpected config')
            with self.assertRaises(M.Refused): M.native_snapshot(root, rows, [config], lambda: None)
            config.unlink()
            body = b'[package]\nname="kodera-rs"\n[dependencies]\nforeign={path="../outside"}\n'
            (root/'packages/kodera-rs/Cargo.toml').write_bytes(body)
            row = next(row for row in rows if row['path'] == 'packages/kodera-rs/Cargo.toml')
            row.update(bytes=len(body), git_blob=hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest())
            with self.assertRaisesRegex(M.Refused, 'Unbound path'): M.native_snapshot(root, rows, [], lambda: None)

    def test_export_refusal_retains_private_prefix_and_partial_evidence(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)/'owned'; root.mkdir(mode=0o700)
            guard = types.SimpleNamespace(root=root,ident=M.identity(root),minimum_free=1,peaks={},commands=[],groups=set(),
                children=types.SimpleNamespace(handles={}))
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+512*M.MIB)), \
                 patch.object(M,'export_generated',side_effect=M.Refused('public export uncertainty')), \
                 patch.object(M.shutil,'rmtree') as remove:
                with self.assertRaises(M.Refused): M.finish(guard,{'status':'COMPONENT_BROWSER_PROOF_COMPLETE'})
            remove.assert_not_called(); self.assertTrue(root.is_dir())
            evidence = root.with_name('owned-public-evidence')
            self.assertFalse((evidence/'result.json').exists())
            self.assertTrue((root/'export-recovery.json').is_file())

    def test_complete_structural_export_still_requires_final_cleanup_result(self):
        with self.roots() as (root, private, evidence, _, __):
            (private/'generated').mkdir(); (private/'tmp').mkdir(); (root/'repo').mkdir()
            for filename in M.GENERATED_REQUIRED:
                (private/'generated'/filename).write_bytes(b'INVALID public generated code, never execute')
            for directory in ('rustup', 'cargo'): (root/directory).mkdir()
            native = {'source_head':'a'*40,'files':[{'path':'Cargo.lock','sha256':'b'*64}]}
            body = (json.dumps(native)+'\n').encode()
            for parent in (private, evidence):
                path = parent/'native-input-manifest.json'; path.write_bytes(body); path.chmod(0o600)
            semantic = {'schema':'wasm-device-abi-v1','declarationRemovalMutantRefused':True,'httpDeclarationRemovalMutantRefused':True}
            semantic_body = json.dumps(semantic).encode()
            path = evidence/'semantic-abi.json'; path.write_bytes(semantic_body); path.chmod(0o600)
            generated = M.generated_inventory(private/'generated')
            artifact = {'source_head':'a'*40,'lock_sha256':'b'*64,'files':generated}
            artifact_body = json.dumps(artifact).encode()
            path = evidence/'artifact-manifest.json'; path.write_bytes(artifact_body); path.chmod(0o600)
            commands = [{'label':label,'argv':['PUBLIC_NEVER_EXECUTED'],'exit':0,'owned_descendants_absent':True,
                'stdout':{'sha256':'1'*64},'stderr':{'sha256':'2'*64}} for label in ('cargo-build','codegen','semantic-abi','browser-proof')]
            guard = types.SimpleNamespace(root=private,ident=M.identity(private),started=M.time.monotonic(),minimum_free=M.STOP+512*M.MIB,
                groups=set(),children=types.SimpleNamespace(handles={}),peaks={'target':0},npm_roots=[],commands=commands,repo=root/'repo',
                env={'RUSTUP_HOME':str(root/'rustup'),'CARGO_HOME':str(root/'cargo')},tick=lambda:None)
            proof = {'status':'COMPONENT_BROWSER_PROOF_COMPLETE','browser_executed':{'legacy_device_cases':50,'http_host_oracle_cases':35},
                'native_inputs_final_verified':True,'native_inputs_sha256':hashlib.sha256(body).hexdigest(),'source_head':'a'*40,
                'lock_sha256':'b'*64,'npm_lock_sha256':'c'*64,'rust-version':'SYNTHETIC public tool fixture',
                'bindgen_binary_sha256':'d'*64,'raw_wasm_sha256':'e'*64,'manifest_sha256':hashlib.sha256(artifact_body).hexdigest(),'component_source_sha256':{},
                'retained_public_diagnostics':[{'name':'semantic-abi.json','sha256':hashlib.sha256(semantic_body).hexdigest()}],
                'generated':generated}
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+512*M.MIB)), \
                 patch.object(M,'cargo_configs',return_value=[]),patch.object(M,'native_snapshot',return_value=native['files']):
                with patch.object(M,'TOTAL',80*M.MIB+M.EXPORT_RESERVE-1):
                    with self.assertRaisesRegex(M.Refused,'combined reservation'): M.export_generated(guard, proof, evidence)
                self.assertFalse((evidence/'generated').exists())
                result = M.export_generated(guard, proof, evidence)
            self.assertTrue(result['complete']); self.assertEqual(result['files'],4)
            manifest = json.loads((evidence/'generated-export.json').read_bytes())
            self.assertTrue(manifest['requires_successful_cleanup_result'])
            self.assertFalse((evidence/'result.json').exists())
            self.assertEqual(M.generated_inventory(evidence/'generated'),proof['generated'])
            self.assertEqual((private/'generated/kodera_rs.js').read_bytes(),b'INVALID public generated code, never execute')
            (evidence/'generated/unlisted.bin').write_bytes(b'public unknown member')
            fd = M.directory_fd(evidence/'generated')
            try:
                with self.assertRaises(M.Refused): M.verify_export_tree(fd,proof['generated'],lambda:None)
            finally: os.close(fd)

    def test_additional_export_reservation_and_live_children_refuse(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); guard=types.SimpleNamespace(root=root,ident=M.identity(root),started=M.time.monotonic(),
                groups=set(),children=types.SimpleNamespace(handles={}),minimum_free=M.STOP+512*M.MIB)
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+79*M.MIB)):
                with self.assertRaisesRegex(M.Refused,'Additional generated export floor'): M.export_check(guard)
            guard.groups.add(123)
            with self.assertRaisesRegex(M.Refused,'quiescent'): M.export_check(guard)

    def test_failed_component_does_not_attempt_generated_export(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)/'owned'; root.mkdir(mode=0o700)
            guard = types.SimpleNamespace(root=root,ident=M.identity(root),minimum_free=1,peaks={},commands=[],groups=set(),
                children=types.SimpleNamespace(handles={}))
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+512*M.MIB)), \
                 patch.object(M,'export_generated') as export:
                M.finish(guard,{'status':'REFUSED'})
            export.assert_not_called()
            self.assertFalse((root.with_name('owned-public-evidence')/'generated-export.json').exists())


class RevisedArtifactControls(unittest.TestCase):
    def test_generated_walk_eacces_refuses_with_all_required_files_present(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);(root/'snippets').mkdir()
            for filename in M.GENERATED_REQUIRED:(root/filename).write_bytes(b'public')
            self.assertEqual(len(M.generated_inventory(root)),4)
            def denied(path,followlinks=False,onerror=None):
                yield str(root),['snippets'],sorted(M.GENERATED_REQUIRED)
                if onerror is not None: onerror(PermissionError(13,'public denied subtree',str(root/'snippets')))
            with patch.object(M.os,'walk',denied):
                with self.assertRaises(PermissionError)as caught:M.generated_inventory(root)
            self.assertEqual(caught.exception.errno,13)

    def test_cargo_row_cap_precedes_json_allocation_decode(self):
        with tempfile.TemporaryDirectory()as name:
            root=Path(name);log=root/'public.jsonl';log.write_bytes(b'{"public":"long-but-valid-json"}\n')
            with patch.object(M,'MAX_CARGO_ROW',8),patch.object(M.json,'loads')as decoding:
                with self.assertRaisesRegex(M.Refused,'Cargo JSON row cap'):M.cargo_artifact(log,root,root)
                decoding.assert_not_called()


class CommandBoundaryControls(unittest.TestCase):
    @contextlib.contextmanager
    def owner(self,grow=False,interrupt=False):
        with tempfile.TemporaryDirectory()as name:
            root=Path(name);(root/'logs').mkdir()
            value=M.Guard.__new__(M.Guard);value.root=root;value.repo=root;value.env={};value.groups=set();value.commands=[]
            value.children=types.SimpleNamespace(last_stopped=[]);value.tick=lambda:None
            events=[];prior={M.signal.SIGINT:object(),M.signal.SIGTERM:object()};handlers=prior.copy()
            def setting(signum,handler):
                old=handlers[signum];handlers[signum]=handler;return old
            def launched(*args,**kwargs):
                self.assertTrue(kwargs['start_new_session']);self.assertTrue(kwargs['close_fds'])
                if interrupt:handlers[M.signal.SIGTERM](M.signal.SIGTERM,None)
                return types.SimpleNamespace(pid=101,returncode=0,poll=lambda:0)
            def stopped(child):
                events.append('stopped');value.groups.discard(child.pid)
                if grow:(root/'logs/public.stdout').write_bytes(b'123456')
            value.stop=stopped
            with patch.object(M.signal,'getsignal',side_effect=lambda signum:handlers[signum]), \
                 patch.object(M.signal,'signal',side_effect=setting), \
                 patch.object(M.signal,'pthread_sigmask',side_effect=AssertionError('child mask must not change'))as masking, \
                 patch.object(M.subprocess,'Popen',side_effect=launched):
                yield value,events,prior,handlers,masking

    def test_stopped_child_growth_refuses_before_either_digest_with_metadata(self):
        original=M.bounded_log_digest
        for grow in(False,True):
            with self.subTest(grow=grow),self.owner(grow=grow)as(owner,events,prior,handlers,masking), \
                 patch.object(M,'bounded_log_digest',wraps=original)as hashing:
                if grow:
                    with self.assertRaisesRegex(M.Refused,'Stopped log cap'):owner.command(['PUBLIC_NEVER_EXECUTED'],'public',1,5)
                    hashing.assert_not_called()
                    self.assertEqual(owner.commands[0]['stdout']['bytes'],6)
                    self.assertTrue(owner.commands[0]['stdout']['over_cap'])
                    self.assertIsNone(owner.commands[0]['stdout']['sha256'])
                    self.assertIn('cap',owner.commands[0]['stdout']['digest_omitted_reason'])
                else:
                    owner.command(['PUBLIC_NEVER_EXECUTED'],'public',1,5)
                    self.assertEqual(hashing.call_count,2)
                self.assertEqual(events,['stopped']);self.assertFalse(owner.groups)
                self.assertEqual(handlers,prior);masking.assert_not_called()

    def test_launch_signal_defers_until_registered_then_stops_without_mask_change(self):
        with self.owner(interrupt=True)as(owner,events,prior,handlers,masking):
            with self.assertRaises(KeyboardInterrupt):owner.command(['PUBLIC_NEVER_EXECUTED'],'public',1,5)
            self.assertEqual(events,['stopped']);self.assertFalse(owner.groups)
            self.assertEqual(handlers,prior);masking.assert_not_called()
            self.assertTrue(owner.commands[0]['owned_descendants_absent'])


class RevisedFinalizationControls(unittest.TestCase):
    def test_oversized_retained_tail_never_whole_hashes_original(self):
        with tempfile.TemporaryDirectory()as name:
            root=Path(name)/'owned';root.mkdir(mode=0o700);(root/'logs').mkdir()
            stdout=root/'logs/public.stdout';stderr=root/'logs/public.stderr'
            stdout.write_bytes(b'123456');stderr.write_bytes(b'')
            entries,failed=M.stopped_log_evidence(stdout,stderr,5);self.assertTrue(failed)
            guard=types.SimpleNamespace(root=root,ident=M.identity(root),minimum_free=1,peaks={},groups=set(),
                commands=[{'label':'public','log_cap':5,**entries}],children=types.SimpleNamespace(handles={}))
            original=M.digest
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+32*M.MIB)), \
                 patch.object(M,'digest',wraps=original)as hashing:
                M.finish(guard,{'status':'REFUSED'})
                self.assertFalse(any(call.args[0]in(stdout,stderr)for call in hashing.call_args_list))
            retained=root.with_name('owned-public-evidence')
            result=json.loads((retained/'result.json').read_text())
            row=next(item for item in result['retained_public_diagnostics']if item['name']=='public.stdout')
            self.assertEqual(row['original_bytes'],6);self.assertIsNone(row['original_sha256'])
            self.assertIn('cap',row['original_digest_omitted_reason'])
            self.assertEqual((retained/'public.stdout').read_bytes(),b'123456')


class FinalizationControls(unittest.TestCase):
    def test_controlled_write_checks_full_floor_reservation_before_open(self):
        with tempfile.TemporaryDirectory()as name:
            path=Path(name)/'public.txt';body=b'public'
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+M.reserve(len(body))+2*M.MIB-1)), \
                 patch.object(M.os,'open')as opening:
                with self.assertRaisesRegex(M.Refused,'Evidence floor'): M.write_new(path,body)
                opening.assert_not_called()
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+M.reserve(len(body))+2*M.MIB)):
                M.write_new(path,body)
            self.assertEqual(path.read_bytes(),body)

    def test_cleanup_fault_keeps_first_public_proof_and_exact_root(self):
        with tempfile.TemporaryDirectory()as name:
            root=Path(name)/'owned';root.mkdir(mode=0o700)
            guard=types.SimpleNamespace(root=root,ident=M.identity(root),minimum_free=1,peaks={},commands=[],groups=set(),
                children=types.SimpleNamespace(handles={}))
            with patch.object(M.shutil,'disk_usage',return_value=types.SimpleNamespace(free=M.STOP+32*M.MIB)), \
                 patch.object(M.shutil,'rmtree',side_effect=PermissionError(13,'public cleanup fault')):
                with self.assertRaises(PermissionError): M.finish(guard,{'status':'REFUSED'})
            self.assertTrue(root.is_dir())
            retained=root.with_name('owned-public-evidence')
            self.assertTrue((retained/'precleanup.json').is_file())
            self.assertTrue(json.loads((retained/'precleanup.json').read_text())['cleanup_pending'])
            self.assertFalse((retained/'result.json').exists())


class DescendantControls(unittest.TestCase):
    def owner(self):
        value = M.Children.__new__(M.Children); value.handles = {}; return value

    def test_detached_group_and_orphan_are_owned_by_parent_chain_not_pgid(self):
        value=self.owner(); owner=os.getpid(); graph={owner:[101],101:[102],102:[]}; identities={101:(owner,11),102:(101,12)}
        with patch.object(value,'children',side_effect=lambda pid:graph.get(pid,[])), \
             patch.object(value,'process',side_effect=lambda pid:identities.get(pid)), \
             patch.object(M.os,'pidfd_open',side_effect=lambda pid,flags:pid+1000,create=True):
            self.assertEqual(value.observe(),{101,102})
            # The daemon changed its session/group and became an adopted child.
            graph={owner:[102],102:[]};identities={102:(owner,12)}
            self.assertEqual(value.observe(),{102})
            self.assertEqual(value.handles[102],(1102,12))

    def test_foreign_parent_and_pid_start_reuse_refuse_before_signal(self):
        value=self.owner(); owner=os.getpid()
        with patch.object(value,'children',return_value=[101]),patch.object(value,'process',return_value=(999999,11)), \
             patch.object(M.os,'pidfd_open',create=True)as opening:
            with self.assertRaisesRegex(M.Refused,'parent changed'): value.observe()
            opening.assert_not_called()
        value.handles[101]=(1101,11)
        with patch.object(value,'children',side_effect=lambda pid:[101]if pid==owner else[]), \
             patch.object(value,'process',return_value=(owner,12)):
            with self.assertRaisesRegex(M.Refused,'PID reused'): value.observe()

    def test_descendant_cap_and_deadline_refuse_without_unowned_signal(self):
        value=self.owner(); owner=os.getpid()
        with patch.object(value,'children',side_effect=lambda pid:list(range(1000,1513))if pid==owner else[]), \
             patch.object(value,'process',return_value=(owner,11)),patch.object(M.os,'pidfd_open',return_value=10,create=True):
            with self.assertRaisesRegex(M.Refused,'count'): value.observe()
        value=self.owner(); direct=types.SimpleNamespace(wait=lambda timeout:0,poll=lambda:0)
        with patch.object(value,'observe',return_value=set()),patch.object(value,'children',return_value=[101]), \
             patch.object(M.time,'monotonic',side_effect=[0,9]),patch.object(M.time,'sleep'), \
             patch.object(M.os,'waitpid',side_effect=ChildProcessError):
            with self.assertRaisesRegex(M.Refused,'uncertain'): value.stop(direct)

    def test_termination_failure_keeps_identity_handles_for_recovery(self):
        value=self.owner();value.handles[101]=(1101,11)
        direct=types.SimpleNamespace(wait=lambda timeout:0,poll=lambda:0)
        with patch.object(value,'observe',side_effect=M.Refused('public inventory fault')), \
             patch.object(value,'children',return_value=[101]), \
             patch.object(M.signal,'pidfd_send_signal',side_effect=PermissionError(1,'public fault'),create=True), \
             patch.object(M.time,'monotonic',side_effect=[0,9]),patch.object(M.os,'waitpid',side_effect=ChildProcessError):
            with self.assertRaisesRegex(M.Refused,'uncertain'): value.stop(direct)
        self.assertEqual(value.handles,{101:(1101,11)})

    def test_inventory_fault_does_not_skip_known_direct_child_stop(self):
        value=self.owner();events=[]
        direct=types.SimpleNamespace(poll=lambda:None,terminate=lambda:events.append('term'),wait=lambda timeout:0)
        with patch.object(value,'observe',side_effect=M.Refused('public inventory fault')), \
             patch.object(value,'children',return_value=[]),patch.object(M.os,'waitpid',side_effect=ChildProcessError):
            value.stop(direct)
        self.assertEqual(events,['term'])

    def test_uncertain_cleanup_persists_recovery_and_never_deletes(self):
        with tempfile.TemporaryDirectory()as name:
            root=Path(name)
            guard=types.SimpleNamespace(root=root,minimum_free=1,peaks={},groups={101},
                children=types.SimpleNamespace(handles={101:(1101,11)}))
            written=[]
            with patch.object(M,'json_new',side_effect=lambda path,body:written.append((path,body.copy()))), \
                 patch.object(M.shutil,'rmtree')as removal:
                with self.assertRaisesRegex(M.Refused,'uncertain'): M.finish(guard,{'status':'REFUSED'})
            removal.assert_not_called()
            self.assertEqual(written[0][0],root/'recovery.json')
            self.assertEqual(written[0][1]['unreaped_identities'],[[101,11]])


class WorkspaceBrowserCliControls(unittest.TestCase):
    def test_workspace_browser_cli_accepts_workspace_or_hoisted_and_refuses_missing_or_symlink(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve()
            with self.assertRaisesRegex(M.Refused, 'Exact workspace browser CLI absent'):
                M.workspace_browser_cli(root)
            hoisted = root / 'node_modules/playwright/cli.js'
            hoisted.parent.mkdir(parents=True)
            hoisted.write_text('// cli\n')
            self.assertEqual(M.workspace_browser_cli(root), hoisted)
            nested = root / 'apps/web/node_modules/playwright/cli.js'
            nested.parent.mkdir(parents=True)
            nested.symlink_to(hoisted)
            with self.assertRaisesRegex(M.Refused, 'Exact workspace browser CLI absent'):
                M.workspace_browser_cli(root)
            nested.unlink()
            nested.write_text('// nested cli\n')
            self.assertEqual(M.workspace_browser_cli(root), nested)
            nested.unlink()
            hoisted.unlink()
            target = root / 'real-cli.js'
            target.write_text('// real\n')
            hoisted.symlink_to(target)
            with self.assertRaisesRegex(M.Refused, 'Exact workspace browser CLI absent'):
                M.workspace_browser_cli(root)


if __name__ == '__main__':
    unittest.main()

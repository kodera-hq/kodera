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



if __name__ == '__main__':
    unittest.main()

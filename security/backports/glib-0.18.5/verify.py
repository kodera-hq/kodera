"""Dependency-free integrity check for the same-version GLib iterator backport."""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import tarfile
import tomllib
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[2]
RELATIVE = 'security/backports/glib-0.18.5'
OVERLAY = {'BACKPORT.md', 'provenance.json', 'upstream.patch', 'verify.py'}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest_sha(files: dict[str, str]) -> str:
    return sha(json.dumps(files, sort_keys=True, separators=(',', ':')).encode())


def check_variant(data: bytes, provenance: dict) -> bytes:
    if sha(data) != provenance['patched_variant_iter_sha256']:
        raise ValueError('patched iterator source digest mismatch')
    binding = b'let mut p: *mut libc::c_char = std::ptr::null_mut();'
    argument = b'                &mut p,'
    if data.count(binding) != 1 or data.count(argument) != 1:
        raise ValueError('mutable out-pointer correction missing')
    original = data.replace(binding, b'let p: *mut libc::c_char = std::ptr::null_mut();').replace(argument, b'                &p,')
    if sha(original) != provenance['original_package_files']['src/variant_iter.rs']:
        raise ValueError('iterator differs beyond the exact upstream correction')
    return original


def verify_source(provenance: dict) -> None:
    original_files = provenance['original_package_files']
    if len(original_files) != 121 or manifest_sha(original_files) != provenance['original_file_manifest_sha256']:
        raise ValueError('original package inventory mismatch')
    patched_originals = {**original_files, 'src/variant_iter.rs': provenance['patched_variant_iter_sha256']}
    if manifest_sha(patched_originals) != provenance['patched_file_manifest_sha256']:
        raise ValueError('patched original-file manifest mismatch')
    files = {**patched_originals, **provenance['added_package_files']}
    if manifest_sha(files) != provenance['integrated_source_manifest_sha256']:
        raise ValueError('integrated source manifest mismatch')
    actual = set()
    for path in ROOT.rglob('*'):
        if path.is_symlink():
            raise ValueError('symlink in backported package')
        if path.is_file():
            name = path.relative_to(ROOT).as_posix()
            actual.add(name)
            if name in files and sha(path.read_bytes()) != files[name]:
                raise ValueError('backported package file differs: ' + name)
    if actual != set(files) | OVERLAY:
        raise ValueError('missing or unexpected backport files')
    patched = (ROOT / 'src/variant_iter.rs').read_bytes()
    original = check_variant(patched, provenance)
    patch = ''.join(difflib.unified_diff(original.decode().splitlines(keepends=True), patched.decode().splitlines(keepends=True), fromfile='a/src/variant_iter.rs', tofile='b/src/variant_iter.rs')).encode()
    if patch != (ROOT / 'upstream.patch').read_bytes() or sha(patch) != provenance['patch_sha256']:
        raise ValueError('upstream patch artifact differs')
    manifest = tomllib.loads((ROOT / 'Cargo.toml').read_text())
    if manifest['package']['name'] != 'glib' or manifest['package']['version'] != '0.18.5':
        raise ValueError('upstream package identity changed')
    workspace = tomllib.loads((WORKSPACE / 'Cargo.toml').read_text())
    if RELATIVE not in workspace['workspace'].get('exclude', []) or workspace['patch']['crates-io']['glib'] != {'path': RELATIVE}:
        raise ValueError('source override or workspace exclusion differs')
    locked = [package for package in tomllib.loads((WORKSPACE / 'Cargo.lock').read_text())['package'] if package['name'] == 'glib']
    if len(locked) != 1 or locked[0]['version'] != '0.18.5' or 'source' in locked[0] or 'checksum' in locked[0] or locked[0]['dependencies'] != provenance['original_locked_dependencies']:
        raise ValueError('locked local source identity or dependency graph differs')
    for mutant in [original, patched.replace(b'&mut p,', b'&p,')]:
        try:
            check_variant(mutant, provenance)
        except ValueError:
            pass
        else:
            raise AssertionError('negative source mutation admitted')


def verify_archive(path: Path, cached_source: Path | None, provenance: dict) -> None:
    if sha(path.read_bytes()) != provenance['registry_archive_sha256']:
        raise ValueError('original registry archive digest mismatch')
    files = {}
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive.getmembers():
            if not member.isfile():
                raise ValueError('non-regular original archive entry')
            relative = Path(member.name).relative_to('glib-0.18.5')
            if '..' in relative.parts:
                raise ValueError('uncontained original archive entry')
            data = archive.extractfile(member).read()
            files[relative.as_posix()] = sha(data)
            if cached_source is not None and sha((cached_source / relative).read_bytes()) != sha(data):
                raise ValueError('cached original differs: ' + str(relative))
    if files != provenance['original_package_files']:
        raise ValueError('original registry file inventory differs')


def optimized_artifact(messages: Path, target_dir: Path) -> Path:
    artifacts = []
    target_root = target_dir.resolve()
    for line in messages.read_text().splitlines():
        if not line.strip():
            continue
        message = json.loads(line)
        if message.get('reason') != 'compiler-artifact' or message.get('target', {}).get('name') != 'glib':
            continue
        if Path(message.get('manifest_path', '')).resolve() != ROOT / 'Cargo.toml' or Path(message['target']['src_path']).resolve() != ROOT / 'src/lib.rs':
            raise ValueError('GLib artifact comes from an unapproved source')
        if message.get('profile', {}).get('opt_level') != '3' or message['profile'].get('test'):
            raise ValueError('GLib artifact was not an optimized release library')
        for name in message.get('filenames', []):
            if not name.endswith('.rlib'):
                continue
            path = Path(name).resolve()
            if not path.is_relative_to(target_root) or not path.is_file() or path.stat().st_size == 0:
                raise ValueError('GLib artifact missing or outside the selected target')
            artifacts.append(path)
    if len(artifacts) != 1:
        raise ValueError('expected exactly one optimized backported GLib library')
    return artifacts[0]



def selector_selftest() -> None:
    # These tiny synthetic files qualify selection/refusal logic, never native compilation.
    with tempfile.TemporaryDirectory(prefix='glib-artifact-selector-') as directory:
        root = Path(directory)
        target = root / 'target'
        target.mkdir()
        artifact = target / 'libglib-fixture.rlib'
        artifact.write_bytes(b'not-a-native-library; selector fixture only')
        record = {
            'reason': 'compiler-artifact', 'manifest_path': str(ROOT / 'Cargo.toml'),
            'target': {'name': 'glib', 'src_path': str(ROOT / 'src/lib.rs')},
            'profile': {'opt_level': '3', 'test': False}, 'filenames': [str(artifact)],
        }
        messages = root / 'messages.json'
        messages.write_text(json.dumps(record) + '\n')
        assert optimized_artifact(messages, target) == artifact.resolve()
        mutations = [
            [], [record, record],
            [{**record, 'profile': {'opt_level': '0', 'test': False}}],
            [{**record, 'profile': {'opt_level': '3', 'test': True}}],
            [{**record, 'manifest_path': str(root / 'registry/Cargo.toml')}],
            [{**record, 'filenames': [str(root / 'outside.rlib')]}],
            [{**record, 'filenames': [str(target / 'missing.rlib')]}],
        ]
        for mutation in mutations:
            messages.write_text(''.join(json.dumps(item) + '\n' for item in mutation))
            try:
                optimized_artifact(messages, target)
            except ValueError:
                pass
            else:
                raise AssertionError('negative artifact selector mutation admitted')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--cached-source', type=Path)
    parser.add_argument('--cargo-messages', type=Path)
    parser.add_argument('--target-dir', type=Path)
    parser.add_argument('--print-rlib', action='store_true')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.cached_source and not args.archive:
        parser.error('--cached-source requires --archive')
    if bool(args.cargo_messages) != bool(args.target_dir) or args.print_rlib and not args.cargo_messages:
        parser.error('artifact selection requires --cargo-messages and --target-dir')
    provenance = json.loads((ROOT / 'provenance.json').read_text())
    verify_source(provenance)
    if args.selftest:
        selector_selftest()
    if args.archive:
        verify_archive(args.archive, args.cached_source, provenance)
    if args.cargo_messages:
        artifact = optimized_artifact(args.cargo_messages, args.target_dir)
        if args.print_rlib:
            print(artifact)
            return
        print(json.dumps({'source_verified': True, 'optimized_glib_rlib': str(artifact), 'rlib_sha256': sha(artifact.read_bytes())}))
    else:
        print('Verified 121 upstream files, exact two-line correction, regression, notices, local source lock and two negative source mutations; no compilation performed.')


if __name__ == '__main__':
    main()

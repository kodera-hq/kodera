#!/usr/bin/env python3
"""Select the official HTTPS Ubuntu archive on an explicit CI runner."""
import argparse
import os
from pathlib import Path
import platform
import re
import stat
import tempfile

ARCHIVE = 'https://archive.ubuntu.com/ubuntu/'
REPLACEMENTS = {
    'mirror+file:/etc/apt/apt-mirrors.txt': ARCHIVE,
    'http://azure.archive.ubuntu.com/ubuntu/': ARCHIVE,
    'http://azure.archive.ubuntu.com/ubuntu': ARCHIVE,
}
OFFICIAL = {ARCHIVE, ARCHIVE.rstrip('/')}


def transform(text, deb822):
    """Only URI tokens change; signing, suites and every other byte survive."""
    recognized = False
    def uri(match):
        nonlocal recognized
        value = match.group(0)
        recognized |= value in REPLACEMENTS or value in OFFICIAL
        return REPLACEMENTS.get(value, value)

    if deb822:
        # A URI field may continue onto whitespace-prefixed lines.
        pattern = r'(?m)^(URIs:[ \t]*)([^\n]*(?:\n[ \t]+[^\n]*)*)'
        def field(match):
            return match.group(1) + re.sub(r'\S+', uri, match.group(2))
        updated = re.sub(pattern, field, text)
    else:
        pattern = r'(?m)^([ \t]*deb(?:-src)?[ \t]+(?:\[[^\]\n]*\][ \t]+)?)(\S+)'
        def line(match):
            return match.group(1) + re.sub(r'\S+', uri, match.group(2))
        updated = re.sub(pattern, line, text)
    return updated, recognized


def prepare(apt_root, dry_run=False):
    """Plan every candidate first; write only recognized source-file changes."""
    plans = []
    recognized = False
    for relative, deb822 in [('sources.list.d/ubuntu.sources', True), ('sources.list', False)]:
        path = apt_root / relative
        if path.is_symlink():
            raise ValueError('Refusing a symlinked APT source file')
        if not path.exists():
            continue
        if not path.is_file() or path.stat().st_size > 65536:
            raise ValueError('Unexpected APT source file type or size')
        original = path.read_bytes().decode('utf-8')
        updated, found = transform(original, deb822)
        recognized |= found
        if updated != original:
            plans.append((path, updated))
    if not recognized:
        raise ValueError('No recognized Ubuntu archive source; inspect runner configuration')
    if not dry_run:
        for path, updated in plans:
            metadata = path.stat()
            pending = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
                    pending = Path(stream.name)
                    stream.write(updated)
                    stream.flush()
                    os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
                    os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
                pending.replace(path)
            finally:
                if pending is not None:
                    pending.unlink(missing_ok=True)
    return len(plans)


def require_ci(environ, system, machine, uid, os_release):
    if environ.get('GITHUB_ACTIONS') != 'true' or environ.get('RUNNER_OS') != 'Linux':
        raise ValueError('Explicit Linux GitHub Actions context is required')
    if system != 'Linux' or machine not in {'x86_64', 'amd64'} or uid != 0:
        raise ValueError('A root process on the x86-64 Linux runner is required')
    if not re.search(r'(?m)^ID=(?:ubuntu|"ubuntu")$', os_release):
        raise ValueError('An Ubuntu runner is required')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='validate and report changes without writing')
    args = parser.parse_args()
    system = platform.system()
    release = Path('/etc/os-release').read_text() if system == 'Linux' else ''
    require_ci(os.environ, system, platform.machine(), os.geteuid(), release)
    changed = prepare(Path('/etc/apt'), args.dry_run)
    print(f'Ubuntu archive source files {"planned" if args.dry_run else "changed"}: {changed}; authentication settings preserved')


if __name__ == '__main__':
    main()

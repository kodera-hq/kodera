#!/usr/bin/env python3
"""Exercise source transforms and refusal paths using temporary fixtures only."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_ubuntu_apt', Path(__file__).with_name('prepare-ubuntu-apt.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

SOURCE = '''Types: deb deb-src
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

# mirror+file:/etc/apt/apt-mirrors.txt is not an active source here
Types: deb
URIs: https://packages.example.invalid/repository
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/vendor.gpg
'''


class Tests(unittest.TestCase):
    def test_deb822_preserves_every_other_byte(self):
        expected = SOURCE.replace('URIs: mirror+file:/etc/apt/apt-mirrors.txt', 'URIs: '+helper.ARCHIVE)
        self.assertEqual(helper.transform(SOURCE, True), (expected, True))
        self.assertEqual(helper.transform(expected, True), (expected, True))

    def test_legacy_preserves_options_comments_and_unrelated_repositories(self):
        text = ('deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] '
                'http://azure.archive.ubuntu.com/ubuntu/ noble main universe\n'
                '# deb http://azure.archive.ubuntu.com/ubuntu/ noble main\n'
                'deb https://vendor.invalid/ubuntu stable main\n')
        expected = text.replace('http://azure.archive.ubuntu.com/ubuntu/', helper.ARCHIVE, 1)
        self.assertEqual(helper.transform(text, False), (expected, True))

    def test_continuation_and_exact_token_matching(self):
        text = 'URIs: https://vendor.invalid/ubuntu\n mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n'
        self.assertEqual(helper.transform(text, True), (text.replace('mirror+file:/etc/apt/apt-mirrors.txt', helper.ARCHIVE), True))
        for uri in ['mirror+file:/etc/apt/other.txt', 'http://azure.archive.ubuntu.com/ubuntu/other', 'https://azure.archive.ubuntu.com/ubuntu/']:
            text = 'URIs: '+uri+'\n'
            self.assertEqual(helper.transform(text, True), (text, False))

    def test_fixture_dry_run_write_idempotence_and_vendor_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'sources.list.d/ubuntu.sources'
            source.parent.mkdir()
            source.write_text(SOURCE)
            source.chmod(0o640)
            vendor = source.with_name('vendor.sources')
            vendor.write_text('URIs: http://azure.archive.ubuntu.com/ubuntu/\n')
            self.assertEqual(helper.prepare(root, dry_run=True), 1)
            self.assertEqual(source.read_text(), SOURCE)
            self.assertEqual(helper.prepare(root), 1)
            self.assertEqual(source.stat().st_mode & 0o777, 0o640)
            self.assertEqual(helper.prepare(root), 0)
            self.assertEqual(vendor.read_text(), 'URIs: http://azure.archive.ubuntu.com/ubuntu/\n')

    def test_unknown_and_symlinked_sources_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'sources.list'
            source.write_text('deb https://vendor.invalid/repo stable main\n')
            with self.assertRaisesRegex(ValueError, 'No recognized'):
                helper.prepare(root)
            source.unlink()
            source.symlink_to(root/'absent')
            with self.assertRaisesRegex(ValueError, 'symlinked'):
                helper.prepare(root)

    def test_explicit_context_and_privilege_required(self):
        valid = [dict(GITHUB_ACTIONS='true', RUNNER_OS='Linux'), 'Linux', 'x86_64', 0, 'ID=ubuntu\n']
        helper.require_ci(*valid)
        for index, bad in [(0, {}), (0, dict(GITHUB_ACTIONS='false', RUNNER_OS='Linux')), (1, 'Darwin'), (2, 'aarch64'), (3, 1001), (4, 'ID=debian\n')]:
            changed = list(valid)
            changed[index] = bad
            with self.assertRaises(ValueError):
                helper.require_ci(*changed)


if __name__ == '__main__':
    unittest.main()

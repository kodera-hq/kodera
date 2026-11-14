#!/usr/bin/env node
/**
 * Deterministic multi-OS release binary and installer bundler for `@kodera/desktop`.
 *
 * Usage:
 *   node scripts/ci/package-desktop-release.mjs --target <macos|linux|windows> --out-dir <dir>
 *   node scripts/ci/package-desktop-release.mjs --selftest
 *
 * Produces normalized release assets in `--out-dir`:
 *   - macos:
 *       kodera-desktop-macos-universal.dmg
 *       kodera-desktop-macos-universal.app.tar.gz
 *   - linux:
 *       kodera-desktop-linux-x86_64.AppImage
 *       kodera-desktop-linux-amd64.deb
 *   - windows:
 *       kodera-desktop-windows-x64.msi
 *       kodera-desktop-windows-x64-setup.exe
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const tauriDir = join(desktopDir, 'src-tauri');
const webDistDir = join(repoRoot, 'apps', 'web', 'dist');

export const EXPECTED_RELEASE_ASSETS = Object.freeze({
  macos: Object.freeze([
    'kodera-desktop-macos-universal.dmg',
    'kodera-desktop-macos-universal.app.tar.gz',
  ]),
  linux: Object.freeze([
    'kodera-desktop-linux-x86_64.AppImage',
    'kodera-desktop-linux-amd64.deb',
  ]),
  windows: Object.freeze([
    'kodera-desktop-windows-x64.msi',
    'kodera-desktop-windows-x64-setup.exe',
  ]),
});

const SAFE_PATH_RE = /^[A-Za-z0-9._:/\\-]+$/u;

export function parseReleaseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--selftest') {
    return { selftest: true, target: null, outDir: null };
  }
  let target = null;
  let outDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      target = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--out-dir') {
      outDir = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  if (target !== 'macos' && target !== 'linux' && target !== 'windows') {
    throw new Error(`invalid_target:${String(target)}`);
  }
  if (typeof outDir !== 'string' || outDir.trim().length === 0 || outDir.includes('..') || !SAFE_PATH_RE.test(outDir)) {
    throw new Error(`invalid_out_dir:${String(outDir)}`);
  }
  return { selftest: false, target, outDir };
}

function runChecked(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`command_failed:${cmd} ${args.join(' ')} (exit ${String(res.status)})`);
  }
  return res;
}

function resolveCargoTargetDir() {
  if (process.env.CARGO_TARGET_DIR && process.env.CARGO_TARGET_DIR.trim().length > 0) {
    return resolve(repoRoot, process.env.CARGO_TARGET_DIR);
  }
  return join(repoRoot, 'target');
}

function resolveTauriCli() {
  if (process.env.KODERA_DESKTOP_FORCE_HOST_PACKAGER === '1') {
    return null;
  }
  const binName = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
  const candidates = [
    join(desktopDir, 'node_modules', '.bin', binName),
    join(repoRoot, 'node_modules', '.bin', binName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findMatchingFile(dir, suffix) {
  if (!existsSync(dir)) {
    return null;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return full;
      }
    }
  }
  return null;
}

export function renderMacosInfoPlist(conf) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${conf.productName}</string>
  <key>CFBundleExecutable</key>
  <string>kodera-desktop</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${conf.identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${conf.productName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${conf.version}</string>
  <key>CFBundleVersion</key>
  <string>${conf.version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

export function renderDebianControl(conf) {
  return [
    'Package: kodera-desktop',
    `Version: ${conf.version}`,
    'Section: net',
    'Priority: optional',
    'Architecture: amd64',
    'Depends: libwebkit2gtk-4.1-0, libayatana-appindicator3-1, librsvg2-2',
    'Maintainer: Kodera Maintainers <security@kodera.io>',
    `Description: ${conf.productName} Desktop Companion Shell`,
    ' Native Tauri v2 desktop companion shell for Kodera workspaces.',
    '',
  ].join('\n');
}

export function buildSelfExtractingAppImage(appDirTarGzBytes) {
  const header = Buffer.from(
    [
      '#!/bin/sh',
      '# Kodera Desktop Linux x86_64 AppImage launcher bundle',
      'set -eu',
      'TMP_APPDIR="$(mktemp -d "${TMPDIR:-/tmp}/kodera-appimage.XXXXXX")"',
      'cleanup() { rm -rf "$TMP_APPDIR"; }',
      'trap cleanup EXIT INT TERM',
      'ARCHIVE_LINE="$(awk \'/^__KODERA_APPDIR_ARCHIVE__$/ { print NR + 1; exit 0; }\' "$0")"',
      'tail -n +"$ARCHIVE_LINE" "$0" | tar -xzf - -C "$TMP_APPDIR"',
      'exec "$TMP_APPDIR/usr/bin/kodera-desktop" "$@"',
      '__KODERA_APPDIR_ARCHIVE__',
      '',
    ].join('\n'),
    'utf8',
  );
  return Buffer.concat([header, appDirTarGzBytes]);
}

function packageMacosHost(conf, outDir) {
  const targetDir = resolveCargoTargetDir();
  runChecked('rustup', ['target', 'add', 'aarch64-apple-darwin', 'x86_64-apple-darwin']);
  for (const rustTarget of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    runChecked('cargo', [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      join(tauriDir, 'Cargo.toml'),
      '--features',
      'desktop-app',
      '--bin',
      'kodera-desktop',
      '--target',
      rustTarget,
    ]);
  }

  const hostArchTarget = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  runChecked(join(targetDir, hostArchTarget, 'release', 'kodera-desktop'), ['--self-check']);

  const scratch = mkdtempSync(join(tmpdir(), 'kodera-macos-pkg-'));
  try {
    const appDir = join(scratch, 'Kodera.app');
    const macosBinDir = join(appDir, 'Contents', 'MacOS');
    const resourcesDir = join(appDir, 'Contents', 'Resources');
    mkdirSync(macosBinDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });

    const universalBin = join(macosBinDir, 'kodera-desktop');
    runChecked('lipo', [
      '-create',
      '-output',
      universalBin,
      join(targetDir, 'aarch64-apple-darwin', 'release', 'kodera-desktop'),
      join(targetDir, 'x86_64-apple-darwin', 'release', 'kodera-desktop'),
    ]);
    chmodSync(universalBin, 0o755);

    writeFileSync(join(appDir, 'Contents', 'Info.plist'), renderMacosInfoPlist(conf), 'utf8');
    copyFileSync(join(tauriDir, 'icons', 'icon.icns'), join(resourcesDir, 'icon.icns'));
    if (existsSync(webDistDir)) {
      cpSync(webDistDir, join(resourcesDir, 'web'), { recursive: true });
    }

    const appTarGz = join(outDir, 'kodera-desktop-macos-universal.app.tar.gz');
    runChecked('tar', ['-czf', appTarGz, '-C', scratch, 'Kodera.app']);

    const dmgStage = join(scratch, 'dmg-root');
    mkdirSync(dmgStage, { recursive: true });
    cpSync(appDir, join(dmgStage, 'Kodera.app'), { recursive: true });
    const dmgOut = join(outDir, 'kodera-desktop-macos-universal.dmg');
    runChecked('hdiutil', [
      'create',
      '-volname',
      conf.productName,
      '-srcfolder',
      dmgStage,
      '-ov',
      '-format',
      'UDZO',
      dmgOut,
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function packageLinuxHost(conf, outDir) {
  const targetDir = resolveCargoTargetDir();
  runChecked('cargo', [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    join(tauriDir, 'Cargo.toml'),
    '--features',
    'desktop-app',
    '--bin',
    'kodera-desktop',
  ]);
  const builtBin = join(targetDir, 'release', 'kodera-desktop');
  runChecked(builtBin, ['--self-check']);

  const scratch = mkdtempSync(join(tmpdir(), 'kodera-linux-pkg-'));
  try {
    const desktopEntry = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${conf.productName}`,
      'Exec=kodera-desktop %u',
      'Icon=kodera-desktop',
      'Terminal=false',
      'Categories=Network;InstantMessaging;Chat;',
      'MimeType=x-scheme-handler/kodera;x-scheme-handler/matrix;',
      '',
    ].join('\n');

    // 1. Debian package (.deb)
    const debRoot = join(scratch, 'deb-root');
    mkdirSync(join(debRoot, 'DEBIAN'), { recursive: true });
    mkdirSync(join(debRoot, 'usr', 'bin'), { recursive: true });
    mkdirSync(join(debRoot, 'usr', 'share', 'applications'), { recursive: true });
    mkdirSync(join(debRoot, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps'), { recursive: true });
    mkdirSync(join(debRoot, 'usr', 'share', 'kodera-desktop'), { recursive: true });

    writeFileSync(join(debRoot, 'DEBIAN', 'control'), renderDebianControl(conf), 'utf8');
    copyFileSync(builtBin, join(debRoot, 'usr', 'bin', 'kodera-desktop'));
    chmodSync(join(debRoot, 'usr', 'bin', 'kodera-desktop'), 0o755);
    writeFileSync(
      join(debRoot, 'usr', 'share', 'applications', 'kodera-desktop.desktop'),
      desktopEntry,
      'utf8',
    );
    copyFileSync(
      join(tauriDir, 'icons', '128x128.png'),
      join(debRoot, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps', 'kodera-desktop.png'),
    );
    if (existsSync(webDistDir)) {
      cpSync(webDistDir, join(debRoot, 'usr', 'share', 'kodera-desktop', 'web'), { recursive: true });
    }

    const debOut = join(outDir, 'kodera-desktop-linux-amd64.deb');
    runChecked('dpkg-deb', ['--root-owner-group', '--build', debRoot, debOut]);

    // 2. AppImage bundle (.AppImage)
    const appDir = join(scratch, 'Kodera.AppDir');
    mkdirSync(join(appDir, 'usr', 'bin'), { recursive: true });
    mkdirSync(join(appDir, 'usr', 'share', 'kodera-desktop'), { recursive: true });
    copyFileSync(builtBin, join(appDir, 'usr', 'bin', 'kodera-desktop'));
    chmodSync(join(appDir, 'usr', 'bin', 'kodera-desktop'), 0o755);
    writeFileSync(
      join(appDir, 'AppRun'),
      '#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/kodera-desktop" "$@"\n',
      'utf8',
    );
    chmodSync(join(appDir, 'AppRun'), 0o755);
    writeFileSync(join(appDir, 'kodera-desktop.desktop'), desktopEntry, 'utf8');
    copyFileSync(join(tauriDir, 'icons', '128x128.png'), join(appDir, 'kodera-desktop.png'));
    if (existsSync(webDistDir)) {
      cpSync(webDistDir, join(appDir, 'usr', 'share', 'kodera-desktop', 'web'), { recursive: true });
    }

    const appDirArchive = join(scratch, 'appdir.tar.gz');
    runChecked('tar', ['-czf', appDirArchive, '-C', appDir, '.']);
    const appImageOut = join(outDir, 'kodera-desktop-linux-x86_64.AppImage');
    writeFileSync(appImageOut, buildSelfExtractingAppImage(readFileSync(appDirArchive)));
    chmodSync(appImageOut, 0o755);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function resolveWindowsTool(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    const probe = spawnSync('where', [candidate], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim().length > 0) {
      return probe.stdout.trim().split(/\r?\n/u)[0];
    }
  }
  return null;
}

function packageWindowsHost(conf, outDir) {
  const targetDir = resolveCargoTargetDir();
  runChecked('cargo', [
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    join(tauriDir, 'Cargo.toml'),
    '--features',
    'desktop-app',
    '--bin',
    'kodera-desktop',
  ]);
  const builtExe = join(targetDir, 'release', 'kodera-desktop.exe');
  runChecked(builtExe, ['--self-check']);

  const scratch = mkdtempSync(join(tmpdir(), 'kodera-win-pkg-'));
  try {
    const stageDir = join(scratch, 'stage');
    mkdirSync(stageDir, { recursive: true });
    const stagedExe = join(stageDir, 'kodera-desktop.exe');
    const stagedIco = join(stageDir, 'icon.ico');
    copyFileSync(builtExe, stagedExe);
    copyFileSync(join(tauriDir, 'icons', 'icon.ico'), stagedIco);

    // 1. MSI installer via WiX Toolset (candle + light, or wix v4+)
    const msiOut = join(outDir, 'kodera-desktop-windows-x64.msi');
    const candleBin = resolveWindowsTool([
      'candle.exe',
      'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin\\candle.exe',
      'C:\\Program Files (x86)\\WiX Toolset v3.11\\bin\\candle.exe',
    ]);
    const lightBin = resolveWindowsTool([
      'light.exe',
      'C:\\Program Files (x86)\\WiX Toolset v3.14\\bin\\light.exe',
      'C:\\Program Files (x86)\\WiX Toolset v3.11\\bin\\light.exe',
    ]);
    if (candleBin && lightBin) {
      const wxsPath = join(scratch, 'kodera.wxs');
      const wixobjPath = join(scratch, 'kodera.wixobj');
      const wxsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${conf.productName}" Language="1033" Version="${conf.version}.0" Manufacturer="Kodera" UpgradeCode="6c81d4c4-7301-4a76-9f64-281629977f01">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="x64" />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="Kodera">
          <Component Id="MainExecutable" Guid="9b56e651-8f57-46c0-87e1-87c24e6e4a12" Win64="yes">
            <File Id="KoderaDesktopExe" Source="${stagedExe}" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="DefaultFeature" Level="1">
      <ComponentRef Id="MainExecutable" />
    </Feature>
  </Product>
</Wix>
`;
      writeFileSync(wxsPath, wxsXml, 'utf8');
      runChecked(candleBin, ['-nologo', '-arch', 'x64', '-out', wixobjPath, wxsPath]);
      runChecked(lightBin, ['-nologo', '-sval', '-out', msiOut, wixobjPath]);
    } else {
      const wix4Bin = resolveWindowsTool(['wix.exe', 'wix']);
      if (!wix4Bin) {
        throw new Error('wix_toolset_missing_on_windows_runner');
      }
      const wxs4Path = join(scratch, 'kodera-v4.wxs');
      const wxs4Xml = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="${conf.productName}" Manufacturer="Kodera" Version="${conf.version}.0" UpgradeCode="6c81d4c4-7301-4a76-9f64-281629977f01" Compressed="yes" Scope="perMachine">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Kodera">
        <Component Id="MainExecutable" Guid="9b56e651-8f57-46c0-87e1-87c24e6e4a12">
          <File Source="${stagedExe}" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
  </Package>
</Wix>
`;
      writeFileSync(wxs4Path, wxs4Xml, 'utf8');
      runChecked(wix4Bin, ['build', '-arch', 'x64', '-o', msiOut, wxs4Path]);
    }

    // 2. NSIS setup executable (-setup.exe)
    const setupOut = join(outDir, 'kodera-desktop-windows-x64-setup.exe');
    const makensisBin = resolveWindowsTool([
      'makensis.exe',
      'C:\\Program Files (x86)\\NSIS\\makensis.exe',
      'C:\\Program Files\\NSIS\\makensis.exe',
    ]);
    if (!makensisBin) {
      throw new Error('nsis_makensis_missing_on_windows_runner');
    }
    const nsiPath = join(scratch, 'installer.nsi');
    const nsiScript = [
      `Name "${conf.productName}"`,
      `OutFile "${setupOut}"`,
      'InstallDir "$PROGRAMFILES64\\Kodera"',
      'RequestExecutionLevel admin',
      'SilentInstall normal',
      'Section "Install"',
      '  SetOutPath "$INSTDIR"',
      `  File "${stagedExe}"`,
      `  File "${stagedIco}"`,
      '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
      'SectionEnd',
      'Section "Uninstall"',
      '  Delete "$INSTDIR\\kodera-desktop.exe"',
      '  Delete "$INSTDIR\\icon.ico"',
      '  Delete "$INSTDIR\\Uninstall.exe"',
      '  RMDir "$INSTDIR"',
      'SectionEnd',
      '',
    ].join('\r\n');
    writeFileSync(nsiPath, nsiScript, 'utf8');
    runChecked(makensisBin, ['/V2', nsiPath]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function collectTauriBundleOutputs(tauriBin, target, outDir) {
  const bundleDir = join(resolveCargoTargetDir(), 'release', 'bundle');
  if (target === 'macos') {
    runChecked(tauriBin, ['build', '--target', 'universal-apple-darwin', '--bundles', 'dmg,app'], {
      cwd: desktopDir,
    });
    const univBundleDir = join(resolveCargoTargetDir(), 'universal-apple-darwin', 'release', 'bundle');
    const dmg = findMatchingFile(univBundleDir, '.dmg') ?? findMatchingFile(bundleDir, '.dmg');
    const appTar = findMatchingFile(univBundleDir, '.app.tar.gz') ?? findMatchingFile(bundleDir, '.app.tar.gz');
    if (!dmg) {
      throw new Error('tauri_bundle_missing_dmg');
    }
    copyFileSync(dmg, join(outDir, 'kodera-desktop-macos-universal.dmg'));
    if (appTar) {
      copyFileSync(appTar, join(outDir, 'kodera-desktop-macos-universal.app.tar.gz'));
    } else {
      const appFolder = join(univBundleDir, 'macos', 'Kodera.app');
      runChecked('tar', [
        '-czf',
        join(outDir, 'kodera-desktop-macos-universal.app.tar.gz'),
        '-C',
        dirname(appFolder),
        'Kodera.app',
      ]);
    }
    return;
  }
  if (target === 'linux') {
    runChecked(tauriBin, ['build', '--bundles', 'appimage,deb'], { cwd: desktopDir });
    const appImage = findMatchingFile(bundleDir, '.AppImage');
    const deb = findMatchingFile(bundleDir, '.deb');
    if (!appImage || !deb) {
      throw new Error('tauri_bundle_missing_linux_installers');
    }
    copyFileSync(appImage, join(outDir, 'kodera-desktop-linux-x86_64.AppImage'));
    chmodSync(join(outDir, 'kodera-desktop-linux-x86_64.AppImage'), 0o755);
    copyFileSync(deb, join(outDir, 'kodera-desktop-linux-amd64.deb'));
    return;
  }
  runChecked(tauriBin, ['build', '--bundles', 'msi,nsis'], { cwd: desktopDir });
  const msi = findMatchingFile(bundleDir, '.msi');
  const setupExe = findMatchingFile(bundleDir, '-setup.exe');
  if (!msi || !setupExe) {
    throw new Error('tauri_bundle_missing_windows_installers');
  }
  copyFileSync(msi, join(outDir, 'kodera-desktop-windows-x64.msi'));
  copyFileSync(setupExe, join(outDir, 'kodera-desktop-windows-x64-setup.exe'));
}

export function verifyStagedAssets(target, outDir) {
  const expected = EXPECTED_RELEASE_ASSETS[target];
  assert.ok(Array.isArray(expected) && expected.length === 2, `unknown target ${target}`);
  for (const name of expected) {
    const full = join(outDir, name);
    assert.ok(existsSync(full), `missing staged desktop release asset: ${name}`);
    const info = statSync(full);
    assert.ok(info.isFile() && info.size > 0, `empty staged desktop release asset: ${name}`);
  }
}

function runSelftest() {
  const parsed = parseReleaseArgs(['--target', 'linux', '--out-dir', 'dist-release']);
  assert.equal(parsed.target, 'linux');
  assert.equal(parsed.outDir, 'dist-release');

  assert.throws(() => parseReleaseArgs(['--target', 'freebsd', '--out-dir', 'dist']), /invalid_target/u);
  assert.throws(() => parseReleaseArgs(['--target', 'linux', '--out-dir', '../escape']), /invalid_out_dir/u);
  assert.throws(() => parseReleaseArgs(['--target', 'linux', '--out-dir', 'bad;rm']), /invalid_out_dir/u);
  assert.throws(() => parseReleaseArgs(['--unknown']), /unknown_argument/u);

  const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const plist = renderMacosInfoPlist(conf);
  assert.match(plist, /<string>kodera-desktop<\/string>/u);
  assert.match(plist, new RegExp(`<string>${conf.identifier}</string>`, 'u'));

  const control = renderDebianControl(conf);
  assert.match(control, /Depends: libwebkit2gtk-4\.1-0, libayatana-appindicator3-1, librsvg2-2/u);

  const appImageBytes = buildSelfExtractingAppImage(Buffer.from('payload'));
  assert.ok(appImageBytes.subarray(0, 10).toString('utf8').startsWith('#!/bin/sh\n'));

  const scratch = mkdtempSync(join(tmpdir(), 'kodera-pkg-selftest-'));
  try {
    assert.throws(() => verifyStagedAssets('macos', scratch), /missing staged desktop release asset/u);
    for (const file of EXPECTED_RELEASE_ASSETS.macos) {
      writeFileSync(join(scratch, file), 'non-empty');
    }
    verifyStagedAssets('macos', scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log('OK: package-desktop-release.mjs selftest passed.');
}

function main() {
  const args = parseReleaseArgs(process.argv.slice(2));
  if (args.selftest) {
    runSelftest();
    return;
  }

  runChecked(process.execPath, [join(desktopDir, 'scripts', 'generate-icons.mjs'), '--check'], {
    cwd: desktopDir,
  });
  runChecked(process.execPath, [join(desktopDir, 'scripts', 'verify-config.mjs')], {
    cwd: desktopDir,
  });

  if (!existsSync(join(webDistDir, 'index.html'))) {
    runChecked('npm', ['--workspace', '@kodera/web', 'run', 'build']);
  }

  const outAbs = resolve(repoRoot, args.outDir);
  mkdirSync(outAbs, { recursive: true });
  const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const tauriBin = resolveTauriCli();

  if (tauriBin) {
    collectTauriBundleOutputs(tauriBin, args.target, outAbs);
  } else if (args.target === 'macos') {
    packageMacosHost(conf, outAbs);
  } else if (args.target === 'linux') {
    packageLinuxHost(conf, outAbs);
  } else {
    packageWindowsHost(conf, outAbs);
  }

  verifyStagedAssets(args.target, outAbs);
  console.log(
    JSON.stringify({
      target: args.target,
      outDir: outAbs,
      assets: EXPECTED_RELEASE_ASSETS[args.target],
    }),
  );
}

function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  return pathToFileURL(realpathSync(resolve(argv1))).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  main();
}

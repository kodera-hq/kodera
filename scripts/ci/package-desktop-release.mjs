#!/usr/bin/env node
/**
 * Deterministic multi-OS release binary and installer bundler for `@kodera/desktop`.
 *
 * Usage:
 *   node scripts/ci/package-desktop-release.mjs --target <macos|linux|windows> --out-dir <dir>
 *   node scripts/ci/package-desktop-release.mjs --verify-appimage <path>
 *   node scripts/ci/package-desktop-release.mjs --selftest
 *
 * Produces normalized release assets in `--out-dir`:
 *   - macos:
 *       kodera-desktop-macos-universal.dmg
 *       kodera-desktop-macos-universal.app.tar.gz
 *   - linux:
 *       kodera-desktop-linux-x86_64.AppImage  (genuine ELF64 Type-2 `AI\x02` + SquashFS image)
 *       kodera-desktop-linux-amd64.deb
 *   - windows:
 *       kodera-desktop-windows-x64.msi
 *       kodera-desktop-windows-x64-setup.exe
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
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
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyFrontendAssets } from '../../apps/desktop/scripts/verify-frontend-assets.mjs';

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

export const WEB_RESOURCE_STAGE_PATHS = Object.freeze({
  macos: Object.freeze({
    bundleRoot: 'Kodera.app',
    executableRelPath: 'Contents/MacOS/kodera-desktop',
    webResourceRelPath: 'Contents/Resources/web',
    guiLookupFromExeDir: '../Resources/web',
  }),
  linux: Object.freeze({
    bundleRoot: 'linux-root',
    executableRelPath: 'usr/bin/kodera-desktop',
    webResourceRelPath: 'usr/lib/Kodera/web',
    guiLookupFromExeDir: '../lib/Kodera/web',
  }),
  windows: Object.freeze({
    bundleRoot: 'Kodera',
    executableRelPath: 'kodera-desktop.exe',
    webResourceRelPath: 'web',
    guiLookupFromExeDir: 'web',
  }),
});

const APPIMAGE_ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
const APPIMAGE_TYPE2_MAGIC = Buffer.from([0x41, 0x49, 0x02]); // AI\x02 at bytes 8..11
const SQUASHFS_LE_MAGIC = Buffer.from([0x68, 0x73, 0x71, 0x73]); // 'hsqs' (SquashFS 4.0 LE)
const SQUASHFS_SUPERBLOCK_MIN_BYTES = 96;
const SAFE_PATH_RE = /^[A-Za-z0-9._:/\\-]+$/u;

function bundlerUnavailableError(detail) {
  const err = new Error(`appimage_packager_unavailable:${detail}`);
  err.exitCode = 69;
  return err;
}

export function stagePackagedWebAssets(targetOs, bundleRootDir, sourceDistDir = webDistDir) {
  const spec = WEB_RESOURCE_STAGE_PATHS[targetOs];
  if (!spec) {
    throw new Error(`unsupported_target:${String(targetOs)}`);
  }
  verifyFrontendAssets(sourceDistDir);
  const destWebDir = join(bundleRootDir, spec.webResourceRelPath);
  rmSync(destWebDir, { recursive: true, force: true });
  mkdirSync(dirname(destWebDir), { recursive: true });
  cpSync(sourceDistDir, destWebDir, { recursive: true });
  verifyFrontendAssets(destWebDir);
  return {
    stagedWebDir: destWebDir,
    executablePath: join(bundleRootDir, spec.executableRelPath),
    guiLookupFromExeDir: spec.guiLookupFromExeDir,
  };
}

export function computeElf64EndOffset(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('appimage_buffer_expected');
  }
  if (buf.length >= 2 && buf[0] === 0x23 && buf[1] === 0x21) {
    throw new Error('appimage_shell_script_refused');
  }
  if (buf.length < 64 || !buf.subarray(0, 4).equals(APPIMAGE_ELF_MAGIC)) {
    throw new Error('appimage_missing_elf_magic');
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new Error('appimage_invalid_elf64_header');
  }
  if (!buf.subarray(8, 11).equals(APPIMAGE_TYPE2_MAGIC)) {
    throw new Error('appimage_missing_type2_magic');
  }
  const phOff = Number(buf.readBigUInt64LE(0x20));
  const shOff = Number(buf.readBigUInt64LE(0x28));
  const phEntSize = buf.readUInt16LE(0x36);
  const phNum = buf.readUInt16LE(0x38);
  const shEntSize = buf.readUInt16LE(0x3a);
  const shNum = buf.readUInt16LE(0x3c);
  const phEnd = phNum > 0 ? phOff + phEntSize * phNum : 0;
  const shEnd = shNum > 0 ? shOff + shEntSize * shNum : 0;
  const elfEnd = Math.max(64, phEnd, shEnd);
  if (!Number.isSafeInteger(elfEnd) || elfEnd > buf.length) {
    throw new Error('appimage_invalid_elf64_bounds');
  }
  return elfEnd;
}

export function verifyAppImageType2Runtime(runtimeBytes) {
  const elfEnd = computeElf64EndOffset(runtimeBytes);
  if (elfEnd !== runtimeBytes.length) {
    throw new Error(`appimage_runtime_size_mismatch:expected_${elfEnd}_got_${runtimeBytes.length}`);
  }
  return elfEnd;
}

export function verifySquashfsPayload(squashfsBytes) {
  if (!Buffer.isBuffer(squashfsBytes) || squashfsBytes.length < SQUASHFS_SUPERBLOCK_MIN_BYTES) {
    throw new Error('appimage_missing_squashfs_payload');
  }
  if (!squashfsBytes.subarray(0, 4).equals(SQUASHFS_LE_MAGIC)) {
    throw new Error('appimage_missing_squashfs_payload');
  }
}

export function verifyAppImageType2Bytes(appImageBytes) {
  const elfEnd = computeElf64EndOffset(appImageBytes);
  if (appImageBytes.length < elfEnd + SQUASHFS_SUPERBLOCK_MIN_BYTES) {
    throw new Error('appimage_missing_squashfs_payload');
  }
  const payloadHeader = appImageBytes.subarray(elfEnd, elfEnd + 4);
  if (!payloadHeader.equals(SQUASHFS_LE_MAGIC)) {
    throw new Error('appimage_missing_squashfs_payload');
  }
  return { elfEnd, squashfsBytes: appImageBytes.length - elfEnd };
}

export function verifyAppImageType2File(filePath) {
  const st = lstatSync(filePath);
  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) {
    throw new Error(`appimage_invalid_file:${filePath}`);
  }
  const raw = readFileSync(filePath);
  return verifyAppImageType2Bytes(raw);
}

export function assembleAppImageType2(runtimeBytes, squashfsBytes) {
  verifyAppImageType2Runtime(runtimeBytes);
  verifySquashfsPayload(squashfsBytes);
  const image = Buffer.concat([runtimeBytes, squashfsBytes]);
  verifyAppImageType2Bytes(image);
  return image;
}

function resolvePosixExecutable(binName, env = process.env) {
  const pathRaw = env.PATH ?? '';
  for (const dir of pathRaw.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, binName);
    if (existsSync(candidate)) {
      const info = statSync(candidate);
      if (info.isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

export function resolveLinuxAppImageTools(env = process.env) {
  const runtimePathRaw = env.KODERA_APPIMAGE_RUNTIME_PATH ?? '';
  if (typeof runtimePathRaw !== 'string' || runtimePathRaw.trim().length === 0) {
    throw bundlerUnavailableError(
      'KODERA_APPIMAGE_RUNTIME_PATH is unset and Tauri bundler is unavailable',
    );
  }
  const runtimePath = resolve(runtimePathRaw.trim());
  if (!existsSync(runtimePath)) {
    throw bundlerUnavailableError(`runtime file does not exist: ${runtimePath}`);
  }
  const st = lstatSync(runtimePath);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw bundlerUnavailableError(`runtime path must be a regular file: ${runtimePath}`);
  }
  const runtimeBytes = readFileSync(runtimePath);
  verifyAppImageType2Runtime(runtimeBytes);

  const mksquashfsBin = resolvePosixExecutable('mksquashfs', env);
  if (!mksquashfsBin) {
    throw bundlerUnavailableError('mksquashfs (squashfs-tools) is not installed on PATH');
  }
  return { runtimePath, runtimeBytes, mksquashfsBin };
}

export function parseReleaseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--selftest') {
    return { selftest: true, verifyAppImage: null, target: null, outDir: null };
  }
  if (argv.length === 2 && argv[0] === '--verify-appimage') {
    const appImagePath = argv[1] ?? '';
    if (
      typeof appImagePath !== 'string'
      || appImagePath.trim().length === 0
      || appImagePath.includes('..')
      || !SAFE_PATH_RE.test(appImagePath)
    ) {
      throw new Error(`invalid_appimage_path:${String(appImagePath)}`);
    }
    return { selftest: false, verifyAppImage: appImagePath, target: null, outDir: null };
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
  if (
    typeof outDir !== 'string'
    || outDir.trim().length === 0
    || outDir.includes('..')
    || !SAFE_PATH_RE.test(outDir)
  ) {
    throw new Error(`invalid_out_dir:${String(outDir)}`);
  }
  return { selftest: false, verifyAppImage: null, target, outDir };
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

function escapeXml(raw) {
  return String(raw)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function deterministicGuid(seed) {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex');
  const p1 = hex.slice(0, 8);
  const p2 = hex.slice(8, 12);
  const p3 = `4${hex.slice(13, 16)}`;
  const variantNibble = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const p4 = `${variantNibble}${hex.slice(17, 20)}`;
  const p5 = hex.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

function shortHashId(prefix, relPosix) {
  const digest = createHash('sha256').update(relPosix, 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function collectWebDirectoryTree(absDir, relPosixPrefix = 'web') {
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const files = [];
  const subdirs = [];
  const componentIds = [];

  for (const entry of entries) {
    const childAbs = join(absDir, entry.name);
    const childRelPosix = `${relPosixPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const sub = collectWebDirectoryTree(childAbs, childRelPosix);
      subdirs.push(sub);
      componentIds.push(...sub.componentIds);
    } else if (entry.isFile()) {
      const compId = shortHashId('CmpWeb', childRelPosix);
      const fileId = shortHashId('FilWeb', childRelPosix);
      const guid = deterministicGuid(`kodera-wix-web:${childRelPosix}`);
      files.push({
        compId,
        fileId,
        guid,
        sourcePath: childAbs,
        relPosix: childRelPosix,
      });
      componentIds.push(compId);
    }
  }

  const dirName = relPosixPrefix.includes('/')
    ? relPosixPrefix.slice(relPosixPrefix.lastIndexOf('/') + 1)
    : relPosixPrefix;
  const dirId = relPosixPrefix === 'web' ? 'DirWeb' : shortHashId('DirWeb', relPosixPrefix);

  return {
    dirId,
    dirName,
    files,
    subdirs,
    componentIds,
  };
}

function renderWixDirectoryNode(node, indent, isV3) {
  const pad = ' '.repeat(indent);
  const childPad = ' '.repeat(indent + 2);
  const filePad = ' '.repeat(indent + 4);
  const lines = [
    `${pad}<Directory Id="${escapeXml(node.dirId)}" Name="${escapeXml(node.dirName)}">`,
  ];
  for (const file of node.files) {
    const win64Attr = isV3 ? ' Win64="yes"' : '';
    lines.push(
      `${childPad}<Component Id="${escapeXml(file.compId)}" Guid="${escapeXml(file.guid)}"${win64Attr}>`,
    );
    lines.push(
      `${filePad}<File Id="${escapeXml(file.fileId)}" Source="${escapeXml(file.sourcePath)}" KeyPath="yes" />`,
    );
    lines.push(`${childPad}</Component>`);
  }
  for (const sub of node.subdirs) {
    lines.push(renderWixDirectoryNode(sub, indent + 2, isV3));
  }
  lines.push(`${pad}</Directory>`);
  return lines.join('\n');
}

export function renderWixV3Xml({ conf, stagedExe, stagedIco, stagedWebDir }) {
  const webTree = collectWebDirectoryTree(stagedWebDir, 'web');
  const webXml = renderWixDirectoryNode(webTree, 10, true);
  const webRefs = webTree.componentIds
    .map((id) => `      <ComponentRef Id="${escapeXml(id)}" />`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">',
    `  <Product Id="*" Name="${escapeXml(conf.productName)}" Language="1033" Version="${escapeXml(conf.version)}.0" Manufacturer="Kodera" UpgradeCode="6c81d4c4-7301-4a76-9f64-281629977f01">`,
    '    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="x64" />',
    '    <MediaTemplate EmbedCab="yes" />',
    '    <Directory Id="TARGETDIR" Name="SourceDir">',
    '      <Directory Id="ProgramFiles64Folder">',
    '        <Directory Id="INSTALLFOLDER" Name="Kodera">',
    '          <Component Id="MainExecutable" Guid="9b56e651-8f57-46c0-87e1-87c24e6e4a12" Win64="yes">',
    `            <File Id="KoderaDesktopExe" Source="${escapeXml(stagedExe)}" KeyPath="yes" />`,
    '          </Component>',
    '          <Component Id="MainIcon" Guid="4f09d5e2-3192-48eb-9a14-2fb5bc524d09" Win64="yes">',
    `            <File Id="KoderaDesktopIcon" Source="${escapeXml(stagedIco)}" KeyPath="yes" />`,
    '          </Component>',
    webXml,
    '        </Directory>',
    '      </Directory>',
    '    </Directory>',
    '    <Feature Id="DefaultFeature" Level="1">',
    '      <ComponentRef Id="MainExecutable" />',
    '      <ComponentRef Id="MainIcon" />',
    ...(webRefs ? [webRefs] : []),
    '    </Feature>',
    '  </Product>',
    '</Wix>',
    '',
  ].join('\n');
}

export function renderWixV4Xml({ conf, stagedExe, stagedIco, stagedWebDir }) {
  const webTree = collectWebDirectoryTree(stagedWebDir, 'web');
  const webXml = renderWixDirectoryNode(webTree, 8, false);
  const webRefs = webTree.componentIds
    .map((id) => `      <ComponentRef Id="${escapeXml(id)}" />`)
    .join('\n');
  return [
    '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">',
    `  <Package Name="${escapeXml(conf.productName)}" Manufacturer="Kodera" Version="${escapeXml(conf.version)}.0" UpgradeCode="6c81d4c4-7301-4a76-9f64-281629977f01" Compressed="yes" Scope="perMachine">`,
    '    <MediaTemplate EmbedCab="yes" />',
    '    <StandardDirectory Id="ProgramFiles64Folder">',
    '      <Directory Id="INSTALLFOLDER" Name="Kodera">',
    '        <Component Id="MainExecutable" Guid="9b56e651-8f57-46c0-87e1-87c24e6e4a12">',
    `          <File Id="KoderaDesktopExe" Source="${escapeXml(stagedExe)}" KeyPath="yes" />`,
    '        </Component>',
    '        <Component Id="MainIcon" Guid="4f09d5e2-3192-48eb-9a14-2fb5bc524d09">',
    `          <File Id="KoderaDesktopIcon" Source="${escapeXml(stagedIco)}" KeyPath="yes" />`,
    '        </Component>',
    webXml,
    '      </Directory>',
    '    </StandardDirectory>',
    '    <Feature Id="DefaultFeature">',
    '      <ComponentRef Id="MainExecutable" />',
    '      <ComponentRef Id="MainIcon" />',
    ...(webRefs ? [webRefs] : []),
    '    </Feature>',
    '  </Package>',
    '</Wix>',
    '',
  ].join('\n');
}

export function renderNsisScript({ conf, setupOut, stagedExe, stagedIco, stagedWebDir }) {
  return [
    `Name "${conf.productName}"`,
    `OutFile "${setupOut}"`,
    'InstallDir "$PROGRAMFILES64\\Kodera"',
    'RequestExecutionLevel admin',
    'SilentInstall normal',
    'Section "Install"',
    '  SetOutPath "$INSTDIR"',
    `  File "${stagedExe}"`,
    `  File "${stagedIco}"`,
    '  SetOutPath "$INSTDIR\\web"',
    `  File /r "${stagedWebDir}\\*.*"`,
    '  SetOutPath "$INSTDIR"',
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    'SectionEnd',
    'Section "Uninstall"',
    '  Delete "$INSTDIR\\kodera-desktop.exe"',
    '  Delete "$INSTDIR\\icon.ico"',
    '  RMDir /r "$INSTDIR\\web"',
    '  Delete "$INSTDIR\\Uninstall.exe"',
    '  RMDir "$INSTDIR"',
    'SectionEnd',
    '',
  ].join('\r\n');
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
    stagePackagedWebAssets('macos', appDir, webDistDir);

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

function stageLinuxAppDir(appDir, conf, builtBin, sourceWebDir) {
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

  mkdirSync(join(appDir, 'usr', 'bin'), { recursive: true });
  mkdirSync(join(appDir, 'usr', 'share', 'applications'), { recursive: true });
  mkdirSync(join(appDir, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps'), {
    recursive: true,
  });

  copyFileSync(builtBin, join(appDir, 'usr', 'bin', 'kodera-desktop'));
  chmodSync(join(appDir, 'usr', 'bin', 'kodera-desktop'), 0o755);

  writeFileSync(
    join(appDir, 'AppRun'),
    [
      '#!/bin/sh',
      'set -eu',
      'HERE="$(dirname "$(readlink -f "$0")")"',
      'export APPDIR="$HERE"',
      'exec "$HERE/usr/bin/kodera-desktop" "$@"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(join(appDir, 'AppRun'), 0o755);

  writeFileSync(join(appDir, 'kodera-desktop.desktop'), desktopEntry, 'utf8');
  writeFileSync(
    join(appDir, 'usr', 'share', 'applications', 'kodera-desktop.desktop'),
    desktopEntry,
    'utf8',
  );

  const iconSrc = join(tauriDir, 'icons', '128x128.png');
  copyFileSync(iconSrc, join(appDir, 'kodera-desktop.png'));
  copyFileSync(iconSrc, join(appDir, '.DirIcon'));
  copyFileSync(
    iconSrc,
    join(appDir, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps', 'kodera-desktop.png'),
  );
  stagePackagedWebAssets('linux', appDir, sourceWebDir);
}

function packageLinuxHost(conf, outDir) {
  // Fail closed with exit 69 before building if a verified Type-2 ELF runtime or mksquashfs is missing.
  const { runtimeBytes, mksquashfsBin } = resolveLinuxAppImageTools();

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
    mkdirSync(join(debRoot, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps'), {
      recursive: true,
    });

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
    stagePackagedWebAssets('linux', debRoot, webDistDir);

    const debOut = join(outDir, 'kodera-desktop-linux-amd64.deb');
    runChecked('dpkg-deb', ['--root-owner-group', '--build', debRoot, debOut]);

    // 2. Genuine ELF Type-2 AppImage (`\x7fELF` + `AI\x02` runtime + SquashFS 4.0 AppDir payload)
    const appDir = join(scratch, 'Kodera.AppDir');
    stageLinuxAppDir(appDir, conf, builtBin, webDistDir);

    const squashfsPath = join(scratch, 'kodera-appdir.squashfs');
    runChecked(mksquashfsBin, [appDir, squashfsPath, '-root-owned', '-noappend']);

    const appImageOut = join(outDir, 'kodera-desktop-linux-x86_64.AppImage');
    const appImageBytes = assembleAppImageType2(runtimeBytes, readFileSync(squashfsPath));
    writeFileSync(appImageOut, appImageBytes);
    chmodSync(appImageOut, 0o755);
    verifyAppImageType2File(appImageOut);
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
    const stageDir = join(scratch, 'Kodera');
    mkdirSync(stageDir, { recursive: true });
    const stagedExe = join(stageDir, 'kodera-desktop.exe');
    const stagedIco = join(stageDir, 'icon.ico');
    copyFileSync(builtExe, stagedExe);
    copyFileSync(join(tauriDir, 'icons', 'icon.ico'), stagedIco);
    const { stagedWebDir } = stagePackagedWebAssets('windows', stageDir, webDistDir);

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
      const wxsXml = renderWixV3Xml({ conf, stagedExe, stagedIco, stagedWebDir });
      writeFileSync(wxsPath, wxsXml, 'utf8');
      runChecked(candleBin, ['-nologo', '-arch', 'x64', '-out', wixobjPath, wxsPath]);
      runChecked(lightBin, ['-nologo', '-sval', '-out', msiOut, wixobjPath]);
    } else {
      const wix4Bin = resolveWindowsTool(['wix.exe', 'wix']);
      if (!wix4Bin) {
        throw new Error('wix_toolset_missing_on_windows_runner');
      }
      const wxs4Path = join(scratch, 'kodera-v4.wxs');
      const wxs4Xml = renderWixV4Xml({ conf, stagedExe, stagedIco, stagedWebDir });
      writeFileSync(wxs4Path, wxs4Xml, 'utf8');
      runChecked(wix4Bin, ['build', '-arch', 'x64', '-o', msiOut, wxs4Path]);
    }

    // 2. NSIS setup executable (-setup.exe)
    const setupOut = join(outDir, 'kodera-desktop-windows-x64-setup.exe');
    const makensisBin = resolveWindowsTool([
      ...(process.env.KODERA_NSIS_MAKENSIS_PATH
        ? [process.env.KODERA_NSIS_MAKENSIS_PATH]
        : []),
      'makensis.exe',
      'C:\\Program Files (x86)\\NSIS\\makensis.exe',
      'C:\\Program Files\\NSIS\\makensis.exe',
    ]);
    if (!makensisBin) {
      throw new Error('nsis_makensis_missing_on_windows_runner');
    }
    const nsiPath = join(scratch, 'installer.nsi');
    const nsiScript = renderNsisScript({ conf, setupOut, stagedExe, stagedIco, stagedWebDir });
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
    const univBundleDir = join(
      resolveCargoTargetDir(),
      'universal-apple-darwin',
      'release',
      'bundle',
    );
    const dmg = findMatchingFile(univBundleDir, '.dmg') ?? findMatchingFile(bundleDir, '.dmg');
    const appTar =
      findMatchingFile(univBundleDir, '.app.tar.gz') ?? findMatchingFile(bundleDir, '.app.tar.gz');
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
    const appImageOut = join(outDir, 'kodera-desktop-linux-x86_64.AppImage');
    copyFileSync(appImage, appImageOut);
    chmodSync(appImageOut, 0o755);
    verifyAppImageType2File(appImageOut);
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
  if (target === 'linux') {
    verifyAppImageType2File(join(outDir, 'kodera-desktop-linux-x86_64.AppImage'));
  }
}

function buildSyntheticType2ElfRuntime({ includeAi2Magic = true, trailingExtraBytes = 0 } = {}) {
  const codeSection = Buffer.alloc(64, 0x90);
  const shEntSize = 64;
  const shNum = 2;
  const shOff = 64 + codeSection.length; // 128
  const totalElfBytes = shOff + shEntSize * shNum; // 256
  const buf = Buffer.alloc(totalElfBytes + trailingExtraBytes, 0);

  APPIMAGE_ELF_MAGIC.copy(buf, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  if (includeAi2Magic) {
    APPIMAGE_TYPE2_MAGIC.copy(buf, 8);
  }
  buf.writeUInt16LE(2, 0x10); // ET_EXEC
  buf.writeUInt16LE(0x3e, 0x12); // EM_X86_64
  buf.writeUInt32LE(1, 0x14); // EV_CURRENT
  buf.writeBigUInt64LE(0n, 0x20); // e_phoff
  buf.writeBigUInt64LE(BigInt(shOff), 0x28); // e_shoff
  buf.writeUInt16LE(64, 0x34); // e_ehsize
  buf.writeUInt16LE(0, 0x36); // e_phentsize
  buf.writeUInt16LE(0, 0x38); // e_phnum
  buf.writeUInt16LE(shEntSize, 0x3a); // e_shentsize
  buf.writeUInt16LE(shNum, 0x3c); // e_shnum
  codeSection.copy(buf, 64);
  return buf;
}

function buildSyntheticSquashfsSuperblock(extraPayloadBytes = 64) {
  const sb = Buffer.alloc(SQUASHFS_SUPERBLOCK_MIN_BYTES + extraPayloadBytes, 0);
  SQUASHFS_LE_MAGIC.copy(sb, 0);
  sb.writeUInt32LE(4, 4); // inode_count
  sb.writeUInt16LE(4, 28); // s_major = 4
  sb.writeUInt16LE(0, 30); // s_minor = 0
  return sb;
}

function runSelftest() {
  const parsed = parseReleaseArgs(['--target', 'linux', '--out-dir', 'dist-release']);
  assert.equal(parsed.target, 'linux');
  assert.equal(parsed.outDir, 'dist-release');

  assert.throws(
    () => parseReleaseArgs(['--target', 'freebsd', '--out-dir', 'dist']),
    /invalid_target/u,
  );
  assert.throws(
    () => parseReleaseArgs(['--target', 'linux', '--out-dir', '../escape']),
    /invalid_out_dir/u,
  );
  assert.throws(
    () => parseReleaseArgs(['--target', 'linux', '--out-dir', 'bad;rm']),
    /invalid_out_dir/u,
  );
  assert.throws(() => parseReleaseArgs(['--unknown']), /unknown_argument/u);

  const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const plist = renderMacosInfoPlist(conf);
  assert.match(plist, /<string>kodera-desktop<\/string>/u);
  assert.match(plist, new RegExp(`<string>${conf.identifier}</string>`, 'u'));

  const control = renderDebianControl(conf);
  assert.match(
    control,
    /Depends: libwebkit2gtk-4\.1-0, libayatana-appindicator3-1, librsvg2-2/u,
  );

  const scratch = mkdtempSync(join(tmpdir(), 'kodera-pkg-selftest-'));
  try {
    // 1. Verify frontend asset staging & relative lookup across macOS, Linux, and Windows layouts.
    const spaSource = join(scratch, 'spa-dist-fixture');
    mkdirSync(join(spaSource, 'assets'), { recursive: true });
    const fixtureHtml =
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-C4p1L8nR.css"><script type="module" src="/assets/index-B7x9K2mQ.js"></script></head><body><div id="root"></div></body></html>';
    const fixtureJs = 'export const KODERA_SPA_BUNDLE = "hashed-release-module-ok";\n';
    const fixtureCss = ':root { color: var(--text-primary); }\n';
    writeFileSync(join(spaSource, 'index.html'), fixtureHtml, 'utf8');
    writeFileSync(join(spaSource, 'assets', 'index-B7x9K2mQ.js'), fixtureJs, 'utf8');
    writeFileSync(join(spaSource, 'assets', 'index-C4p1L8nR.css'), fixtureCss, 'utf8');

    const guiRelCandidates = [
      '../Resources/web',
      '../lib/Kodera/web',
      '../Resources/dist',
      '../share/kodera-desktop/web',
      '../share/kodera-desktop/dist',
      'web',
      'dist',
    ];
    for (const target of /** @type {const} */ (['macos', 'linux', 'windows'])) {
      const bundleStage = join(scratch, `bundle-${target}`, WEB_RESOURCE_STAGE_PATHS[target].bundleRoot);
      const staged = stagePackagedWebAssets(target, bundleStage, spaSource);
      mkdirSync(dirname(staged.executablePath), { recursive: true });
      writeFileSync(staged.executablePath, 'binary-stub', 'utf8');

      const exeDir = dirname(staged.executablePath);
      const discovered = guiRelCandidates
        .map((rel) => resolve(exeDir, rel))
        .find((candidate) => existsSync(join(candidate, 'index.html')));
      assert.ok(discovered, `gui.rs relative lookup failed to discover staged web dir for ${target}`);
      assert.equal(realpathSync(discovered), realpathSync(staged.stagedWebDir));
      assert.equal(readFileSync(join(discovered, 'index.html'), 'utf8'), fixtureHtml);
      assert.equal(
        readFileSync(join(discovered, 'assets', 'index-B7x9K2mQ.js'), 'utf8'),
        fixtureJs,
      );
    }

    // 2. Positive & negative AppImage Type-2 (`\x7fELF` + `AI\x02` + `hsqs` SquashFS) verification.
    const validRuntime = buildSyntheticType2ElfRuntime();
    const validSquashfs = buildSyntheticSquashfsSuperblock();
    const validAppImage = assembleAppImageType2(validRuntime, validSquashfs);
    assert.deepEqual([...validAppImage.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
    assert.deepEqual([...validAppImage.subarray(8, 11)], [0x41, 0x49, 0x02]);

    const linuxStageOk = join(scratch, 'linux-out-ok');
    mkdirSync(linuxStageOk, { recursive: true });
    writeFileSync(join(linuxStageOk, 'kodera-desktop-linux-x86_64.AppImage'), validAppImage);
    writeFileSync(join(linuxStageOk, 'kodera-desktop-linux-amd64.deb'), '!<arch>\ndebian-binary');
    verifyStagedAssets('linux', linuxStageOk);

    // Negative refusal: shell+tar masquerading (`#!/bin/sh`) MUST be rejected everywhere.
    const fakeShellTar = Buffer.from(
      `#!/bin/sh\ntail -n +3 "$0" | tar -xzf -\n${'P'.repeat(256)}`,
      'utf8',
    );
    assert.throws(() => verifyAppImageType2Runtime(fakeShellTar), /appimage_shell_script_refused/u);
    assert.throws(() => verifyAppImageType2Bytes(fakeShellTar), /appimage_shell_script_refused/u);
    const linuxStageShell = join(scratch, 'linux-out-shell');
    mkdirSync(linuxStageShell, { recursive: true });
    writeFileSync(join(linuxStageShell, 'kodera-desktop-linux-x86_64.AppImage'), fakeShellTar);
    writeFileSync(join(linuxStageShell, 'kodera-desktop-linux-amd64.deb'), '!<arch>\ndebian-binary');
    assert.throws(
      () => verifyStagedAssets('linux', linuxStageShell),
      /appimage_shell_script_refused/u,
    );
    assert.deepEqual(parseReleaseArgs(['--verify-appimage', 'release-bundle/kodera-desktop-linux-x86_64.AppImage']), {
      selftest: false,
      verifyAppImage: 'release-bundle/kodera-desktop-linux-x86_64.AppImage',
      target: null,
      outDir: null,
    });

    // Negative refusal: plain ELF64 binary missing `AI\x02` at bytes 8..11.
    const plainElf = buildSyntheticType2ElfRuntime({ includeAi2Magic: false });
    assert.throws(
      () => assembleAppImageType2(plainElf, validSquashfs),
      /appimage_missing_type2_magic/u,
    );

    // Negative refusal: Type-2 runtime with trailing garbage or missing SquashFS superblock.
    const trailingRuntime = buildSyntheticType2ElfRuntime({ trailingExtraBytes: 16 });
    assert.throws(
      () => verifyAppImageType2Runtime(trailingRuntime),
      /appimage_runtime_size_mismatch/u,
    );
    assert.throws(
      () => verifyAppImageType2Bytes(validRuntime),
      /appimage_missing_squashfs_payload/u,
    );
    assert.throws(
      () => assembleAppImageType2(validRuntime, Buffer.from('not-squashfs-magic-at-all')),
      /appimage_missing_squashfs_payload/u,
    );

    // Negative refusal: missing KODERA_APPIMAGE_RUNTIME_PATH fails closed with exit code 69.
    assert.throws(
      () => resolveLinuxAppImageTools({ PATH: process.env.PATH ?? '' }),
      (err) => err instanceof Error
        && err.message.startsWith('appimage_packager_unavailable:')
        && err.exitCode === 69,
    );

    // When `mksquashfs` is installed on the host/runner, pack a real AppDir and verify SquashFS superblock.
    const hostMksquashfs = resolvePosixExecutable('mksquashfs');
    if (hostMksquashfs) {
      const realAppDir = join(scratch, 'Real.AppDir');
      const stubBin = join(scratch, 'kodera-desktop-stub');
      writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(stubBin, 0o755);
      stageLinuxAppDir(realAppDir, conf, stubBin, spaSource);
      const realSquashfs = join(scratch, 'real.squashfs');
      runChecked(hostMksquashfs, [realAppDir, realSquashfs, '-root-owned', '-noappend'], {
        stdio: 'pipe',
      });
      const realAppImagePath = join(scratch, 'real-packed.AppImage');
      writeFileSync(realAppImagePath, assembleAppImageType2(validRuntime, readFileSync(realSquashfs)));
      const verified = verifyAppImageType2File(realAppImagePath);
      assert.equal(verified.elfEnd, validRuntime.length);
      assert.ok(verified.squashfsBytes >= SQUASHFS_SUPERBLOCK_MIN_BYTES);
    }

    // 3. Verify Windows WiX v3, WiX v4, and NSIS generators stage nested `web/assets/*.js` cleanly.
    const winStage = join(scratch, 'win-stage');
    const stagedExe = join(winStage, 'kodera-desktop.exe');
    const stagedIco = join(winStage, 'icon.ico');
    const stagedWebDir = join(winStage, 'web');
    mkdirSync(join(stagedWebDir, 'assets', 'chunks'), { recursive: true });
    writeFileSync(stagedExe, 'MZ-stub', 'utf8');
    writeFileSync(stagedIco, 'ICO-stub', 'utf8');
    writeFileSync(join(stagedWebDir, 'index.html'), '<!doctype html>', 'utf8');
    writeFileSync(join(stagedWebDir, 'assets', 'index-main.js'), 'console.log(1);', 'utf8');
    writeFileSync(join(stagedWebDir, 'assets', 'chunks', 'vendor.js'), 'export {};', 'utf8');

    const wxs3 = renderWixV3Xml({ conf, stagedExe, stagedIco, stagedWebDir });
    assert.match(wxs3, /<Directory Id="DirWeb" Name="web">/u);
    assert.match(wxs3, /<Directory Id="DirWeb_[0-9a-f]{16}" Name="assets">/u);
    assert.match(wxs3, /<Directory Id="DirWeb_[0-9a-f]{16}" Name="chunks">/u);
    assert.match(wxs3, /index\.html" KeyPath="yes" \/>/u);
    assert.match(wxs3, /index-main\.js" KeyPath="yes" \/>/u);
    assert.match(wxs3, /vendor\.js" KeyPath="yes" \/>/u);
    const wxs3CompRefs = [...wxs3.matchAll(/<ComponentRef Id="([^"]+)" \/>/gu)].map((m) => m[1]);
    assert.equal(wxs3CompRefs.length, 5, 'expected MainExecutable + MainIcon + 3 web ComponentRefs');
    assert.equal(new Set(wxs3CompRefs).size, 5);

    const wxs4 = renderWixV4Xml({ conf, stagedExe, stagedIco, stagedWebDir });
    assert.match(wxs4, /<Wix xmlns="http:\/\/wixtoolset\.org\/schemas\/v4\/wxs">/u);
    assert.match(wxs4, /<Directory Id="DirWeb" Name="web">/u);
    assert.match(wxs4, /index-main\.js" KeyPath="yes" \/>/u);
    assert.ok(!wxs4.includes('Win64='), 'WiX v4 Component elements must not emit v3 Win64 attribute');
    const wxs4CompRefs = [...wxs4.matchAll(/<ComponentRef Id="([^"]+)" \/>/gu)].map((m) => m[1]);
    assert.deepEqual(wxs4CompRefs, wxs3CompRefs);

    const nsi = renderNsisScript({
      conf,
      setupOut: join(scratch, 'kodera-setup.exe'),
      stagedExe,
      stagedIco,
      stagedWebDir,
    });
    assert.ok(nsi.includes('SetOutPath "$INSTDIR\\web"'));
    assert.ok(nsi.includes(`File /r "${stagedWebDir}\\*.*"`));
    assert.ok(nsi.includes('RMDir /r "$INSTDIR\\web"'));

    // 4. Verify asset staging check for macOS.
    assert.throws(
      () => verifyStagedAssets('macos', scratch),
      /missing staged desktop release asset/u,
    );
    for (const file of EXPECTED_RELEASE_ASSETS.macos) {
      writeFileSync(join(scratch, file), 'non-empty');
    }
    verifyStagedAssets('macos', scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    'OK: package-desktop-release.mjs selftest passed (ELF Type-2 AI\\x02 + SquashFS AppImage, shell-tar refusal, WiX v3/v4 & NSIS web staging).',
  );
}

function main() {
  const args = parseReleaseArgs(process.argv.slice(2));
  if (args.selftest) {
    runSelftest();
    return;
  }
  if (args.verifyAppImage) {
    const appImageAbs = resolve(repoRoot, args.verifyAppImage);
    const verified = verifyAppImageType2File(appImageAbs);
    console.log(
      JSON.stringify({
        ok: true,
        path: appImageAbs,
        elfEnd: verified.elfEnd,
        squashfsBytes: verified.squashfsBytes,
      }),
    );
    return;
  }

  runChecked(process.execPath, [join(desktopDir, 'scripts', 'generate-bootstrap-css.mjs')], {
    cwd: desktopDir,
  });
  runChecked(process.execPath, [join(desktopDir, 'scripts', 'generate-icons.mjs'), '--check'], {
    cwd: desktopDir,
  });
  runChecked(process.execPath, [join(desktopDir, 'scripts', 'verify-config.mjs')], {
    cwd: desktopDir,
  });

  if (!existsSync(join(webDistDir, 'index.html'))) {
    runChecked('npm', ['--workspace', '@kodera/web', 'run', 'build']);
  }
  verifyFrontendAssets(webDistDir);

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
  try {
    main();
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.exitCode === 'number' ? err.exitCode : 1;
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(code);
  }
}

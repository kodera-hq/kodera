#!/usr/bin/env node
/**
 * Reproducible multi-OS build and installer packaging driver for `@kodera/desktop`.
 *
 * Usage:
 *   node scripts/desktop-cli.mjs dev [--dry-run]
 *   node scripts/desktop-cli.mjs build [--dry-run]
 *   node scripts/desktop-cli.mjs package --target <macos|linux|windows> [--dry-run]
 *
 * Security invariants:
 * - Validates `tauri.conf.json`, `capabilities/default.json`, and deterministic `.png`/`.icns`/`.ico`
 *   bundle assets before running any build or packaging step.
 * - Inspects code-signing and notarization environment variable presence as booleans only; secret
 *   values (`APPLE_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY`, certificates) are never logged or
 *   included in returned manifests.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');
const tauriDir = join(desktopDir, 'src-tauri');
const repoRoot = resolve(desktopDir, '..', '..');

const OS_TARGETS = Object.freeze({
  macos: {
    targetOs: 'macos',
    rustTargets: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
    bundles: ['app', 'dmg'],
    expectedArtifacts: [
      'bundle/macos/Kodera.app',
      'bundle/dmg/Kodera_0.1.0_aarch64.dmg',
      'bundle/dmg/Kodera_0.1.0_x64.dmg',
    ],
    signingEnvKeys: [
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'TAURI_SIGNING_PRIVATE_KEY',
    ],
  },
  linux: {
    targetOs: 'linux',
    rustTargets: ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'],
    bundles: ['appimage', 'deb'],
    expectedArtifacts: [
      'bundle/appimage/Kodera_0.1.0_amd64.AppImage',
      'bundle/deb/Kodera_0.1.0_amd64.deb',
    ],
    signingEnvKeys: ['TAURI_SIGNING_PRIVATE_KEY'],
  },
  windows: {
    targetOs: 'windows',
    rustTargets: ['x86_64-pc-windows-msvc'],
    bundles: ['msi', 'nsis'],
    expectedArtifacts: [
      'bundle/msi/Kodera_0.1.0_x64_en-US.msi',
      'bundle/nsis/Kodera_0.1.0_x64-setup.exe',
    ],
    signingEnvKeys: [
      'WINDOWS_CERTIFICATE_THUMBPRINT',
      'WINDOWS_TIMESTAMP_URL',
      'TAURI_SIGNING_PRIVATE_KEY',
    ],
  },
});

/**
 * Builds a deterministic, secret-free multi-OS installer packaging plan.
 *
 * @param {'macos' | 'linux' | 'windows'} target
 * @param {Record<string, string | undefined>} [env]
 */
export function buildPackagingPlan(target, env = process.env) {
  if (!Object.hasOwn(OS_TARGETS, target)) {
    throw new RangeError(`unsupported_package_target:${target}`);
  }
  const spec = OS_TARGETS[target];
  const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const presentKeys = spec.signingEnvKeys.filter(
    (key) => typeof env[key] === 'string' && env[key].trim().length > 0,
  );
  const missingKeys = spec.signingEnvKeys.filter((key) => !presentKeys.includes(key));

  return {
    identifier: conf.identifier,
    productName: conf.productName,
    version: conf.version,
    targetOs: spec.targetOs,
    rustTargets: [...spec.rustTargets],
    bundles: [...spec.bundles],
    expectedArtifacts: spec.expectedArtifacts.map((item) =>
      item.replaceAll('0.1.0', String(conf.version)),
    ),
    signing: {
      fullyConfigured: missingKeys.length === 0,
      presentEnvKeys: presentKeys,
      missingEnvKeys: missingKeys,
    },
    commands: {
      hostCargoBuild: [
        'cargo',
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--features',
        'desktop-app',
        '--bin',
        'kodera-desktop',
      ],
      tauriBundle: ['tauri', 'build', '--bundles', spec.bundles.join(',')],
    },
  };
}

function resolveTauriBinary() {
  const localCandidates = [
    join(desktopDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri'),
    join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri'),
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(whichCmd, ['tauri'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim().length > 0) {
    return probe.stdout.trim().split(/\r?\n/u)[0];
  }
  return null;
}

function runSecurityPreflight() {
  const cssCheck = spawnSync(process.execPath, [join(__dirname, 'generate-bootstrap-css.mjs')], { stdio: 'inherit' });
  if (cssCheck.status !== 0) throw new Error('fallback_token_validation_failed');
  const iconCheck = spawnSync(process.execPath, [join(__dirname, 'generate-icons.mjs'), '--check'], {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  if (iconCheck.status !== 0) {
    process.exit(iconCheck.status ?? 1);
  }
  const confCheck = spawnSync(process.execPath, [join(__dirname, 'verify-config.mjs')], {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  if (confCheck.status !== 0) {
    process.exit(confCheck.status ?? 1);
  }
}

function runCargoCommand(cargoArgs) {
  const res = spawnSync('cargo', cargoArgs, {
    cwd: desktopDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const [subcommand, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');

  if (subcommand === 'dev') {
    runSecurityPreflight();
    const cargoArgs = [
      'run',
      '--locked',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--features',
      'desktop-app',
      '--bin',
      'kodera-desktop',
    ];
    if (dryRun) {
      console.log(JSON.stringify({ mode: 'dev', command: ['cargo', ...cargoArgs] }));
      return 0;
    }
    const tauriBin = resolveTauriBinary();
    if (tauriBin && process.env.KODERA_DESKTOP_HOST_ONLY !== '1') {
      const res = spawnSync(tauriBin, ['dev'], { cwd: desktopDir, stdio: 'inherit', env: process.env });
      return res.status ?? 1;
    }
    runCargoCommand(cargoArgs);
    return 0;
  }

  if (subcommand === 'build') {
    runSecurityPreflight();
    const cargoArgs = [
      'build',
      '--locked',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--features',
      'desktop-app',
      '--bin',
      'kodera-desktop',
    ];
    if (dryRun) {
      console.log(JSON.stringify({ mode: 'build', command: ['cargo', ...cargoArgs] }));
      return 0;
    }
    runCargoCommand(cargoArgs);
    return 0;
  }

  if (subcommand === 'package') {
    const targetIdx = rest.indexOf('--target');
    const rawTarget = targetIdx >= 0 ? rest[targetIdx + 1] : '';
    if (rawTarget !== 'macos' && rawTarget !== 'linux' && rawTarget !== 'windows') {
      console.error('Usage: desktop-cli.mjs package --target <macos|linux|windows> [--dry-run]');
      return 64;
    }
    runSecurityPreflight();
    const plan = buildPackagingPlan(rawTarget, process.env);
    if (dryRun) {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    const tauriBin = resolveTauriBinary();
    if (tauriBin) {
      const res = spawnSync(tauriBin, ['build', '--bundles', plan.bundles.join(',')], {
        cwd: desktopDir,
        stdio: 'inherit',
        env: process.env,
      });
      return res.status ?? 1;
    }
    console.error('Desktop installer bundler unavailable; inspect --dry-run or build the host separately.');
    return 69;
  }

  console.error('Usage: desktop-cli.mjs <dev|build|package> [--target <macos|linux|windows>] [--dry-run]');
  return 64;
}

function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  return pathToFileURL(realpathSync(resolve(argv1))).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  process.exit(runCli());
}

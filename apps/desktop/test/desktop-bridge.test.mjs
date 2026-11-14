import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_CAPABILITY_PERMISSIONS,
  APPROVED_CONNECT_SOURCES,
  DESKTOP_APP_IDENTIFIER,
  REDACTED_NOTIFICATION_PREVIEW,
  TRAY_MENU_ITEM_IDS,
  createDesktopClient,
  formatUnreadBadgeLabel,
  isTauriDesktopRuntime,
  resolveTauriInternals,
  validateClientDeepLinkUri,
  validateTauriSecurityInvariants,
} from '../src/index.mjs';
import { buildPackagingPlan, runCli as runDesktopCli } from '../scripts/desktop-cli.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');
const tauriDir = join(desktopDir, 'src-tauri');

const ORG_ID = '019a5e62-6ca0-7303-8303-030303030303';
const SAMPLE_SECRET = 'syt_sample_opaque_fixture_0123456789';

test('runtime detection distinguishes browser globals from Tauri v2 WebView internals', () => {
  assert.equal(isTauriDesktopRuntime(undefined), false);
  assert.equal(isTauriDesktopRuntime(null), false);
  assert.equal(isTauriDesktopRuntime({}), false);
  assert.equal(isTauriDesktopRuntime({ __TAURI_INTERNALS__: {} }), false);
  assert.equal(resolveTauriInternals({ __TAURI_INTERNALS__: { invoke: 'not-a-fn' } }), null);

  const mockGlobal = {
    __TAURI_INTERNALS__: {
      invoke: async () => ({}),
    },
  };
  assert.equal(isTauriDesktopRuntime(mockGlobal), true);
  assert.notEqual(resolveTauriInternals(mockGlobal), null);
});

test('browser fallback executes safe no-ops without touching Web Storage and still enforces security validation', async () => {
  let storageTouched = false;
  const browserGlobal = {
    localStorage: new Proxy(
      {},
      {
        get() {
          storageTouched = true;
          throw new Error('localStorage must never be accessed by secure storage fallback');
        },
      },
    ),
  };

  const client = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: browserGlobal,
  });
  assert.equal(client.isNativeDesktop(), false);

  const meta = await client.getAppMetadata();
  assert.equal(meta.identifier, DESKTOP_APP_IDENTIFIER);
  assert.equal(meta.isNativeDesktop, false);
  assert.equal(meta.updateChannel, 'web');

  const updates = await client.checkForAppUpdates();
  assert.equal(updates.supported, false);
  assert.equal(updates.updateAvailable, false);

  const routed = await client.routeDeepLink('kodera://workspace/acme-ops/general');
  assert.equal(routed.admitted, true);
  assert.equal(routed.nativeHandled, false);
  assert.equal(routed.canonicalUri, 'kodera://workspace/acme-ops/general');

  // Dangerous schemes and open redirects are still rejected outside Tauri!
  await assert.rejects(
    () => client.routeDeepLink('javascript:alert(1)'),
    /deep_link_rejected:unsupported_scheme/u,
  );
  await assert.rejects(
    () => client.routeDeepLink('data:text/html,<script>alert(1)</script>'),
    /deep_link_rejected:unsupported_scheme/u,
  );
  await assert.rejects(
    () => client.routeDeepLink('file:///etc/passwd'),
    /deep_link_rejected:unsupported_scheme/u,
  );
  await assert.rejects(
    () => client.routeDeepLink('kodera://auth/callback?code=abcdefgh1234&state=state_0123456789abcd&redirect_uri=https://evil.test'),
    /deep_link_rejected:open_redirect_detected/u,
  );

  const unlistenDeep = await client.listenDeepLinks(() => {});
  await unlistenDeep();
  const unlistenTray = await client.listenTrayActions(() => {});
  await unlistenTray();

  const badge = await client.setUnreadCount(142);
  assert.equal(badge.applied, false);
  assert.equal(badge.badgeLabel, '99+');
  assert.equal(badge.visible, true);
  assert.equal(formatUnreadBadgeLabel(0), null);

  const note = await client.sendNotification({
    title: 'Confidential',
    body: 'Private room message',
    routeUri: 'kodera://workspace/acme-ops/general',
    redactPreview: true,
  });
  assert.equal(note.delivered, false);
  assert.equal(note.body, REDACTED_NOTIFICATION_PREVIEW);
  assert.equal(note.redacted, true);

  // Bidi spoofing in notifications is rejected even in browser fallback.
  await assert.rejects(
    () => client.sendNotification({ title: 'Spoof\u202Eexe', body: 'Hello' }),
    /forbidden_notification_characters/u,
  );

  const stored = await client.storeSecureCredential({
    secretKind: 'matrix-session',
    matrixUserId: '@alice:kodera.io',
    deviceId: 'BROWSER_TAB',
    issuedAtUnixSecs: 1_762_520_000,
    rawSecret: SAMPLE_SECRET,
  });
  assert.equal(stored.stored, false);
  assert.equal(stored.nativeKeychain, false);
  assert.equal(storageTouched, false);

  const loaded = await client.loadSecureCredentialStatus('matrix-session', '@alice:kodera.io');
  assert.equal(loaded.present, false);

  const oidcStart = await client.beginOidcPkceLoopback({
    issuerOrigin: 'https://auth.kodera.io',
    clientId: 'kodera-desktop',
    codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
    state: 'pkce_state_fixture_0001',
    loopbackPort: 51_920,
  });
  assert.equal(oidcStart.supported, false);

  const bounds = await client.restoreWindowBounds();
  assert.equal(bounds.applied, false);
  assert.equal(bounds.width, 1280);
  assert.equal(bounds.height, 820);
});

test('Tauri IPC bridge invokes native commands, filters incoming events, and enforces org fencing', async () => {
  /** @type {Array<{ cmd: string, args: Record<string, unknown> | undefined }>} */
  const calls = [];
  /** @type {Map<number, (payload: unknown) => void>} */
  const callbacks = new Map();
  let cbSeq = 10;

  const mockTauriGlobal = {
    __TAURI_INTERNALS__: {
      transformCallback(fn) {
        const id = cbSeq++;
        callbacks.set(id, fn);
        return id;
      },
      async invoke(cmd, args) {
        calls.push({ cmd, args });
        switch (cmd) {
          case 'get_app_metadata':
            return {
              identifier: 'io.kodera.desktop',
              productName: 'Kodera',
              version: '0.1.0',
              updateChannel: 'stable',
              updateAvailable: true,
            };
          case 'check_app_updates':
            return {
              updateAvailable: true,
              currentVersion: '0.1.0',
              latestVersion: '0.1.1',
              channel: 'stable',
            };
          case 'plugin:event|listen':
            return 77;
          case 'plugin:event|unlisten':
            return null;
          case 'route_deep_link':
            return { canonical_uri: args?.raw_uri };
          case 'trigger_tray_menu_action':
            return { muted: true };
          case 'load_keychain_credential':
            return { present: true, service_name: 'io.kodera.desktop.matrix-session' };
          case 'delete_keychain_credential':
            return { present: true, service_name: 'io.kodera.desktop.matrix-session' };
          case 'begin_oidc_pkce_loopback':
            return {
              redirect_uri: `http://127.0.0.1:${args?.loopback_port}/auth/callback`,
              code_challenge: 'challenge_s256_fixture',
            };
          case 'restore_window_bounds':
            return { x: 120, y: 80, width: 1280, height: 820, clamped: true };
          default:
            return { ok: true };
        }
      },
    },
  };

  const client = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: mockTauriGlobal,
  });
  assert.equal(client.isNativeDesktop(), true);

  const meta = await client.getAppMetadata();
  assert.equal(meta.isNativeDesktop, true);
  assert.equal(meta.updateAvailable, true);

  const updateInfo = await client.checkForAppUpdates();
  assert.equal(updateInfo.supported, true);
  assert.equal(updateInfo.latestVersion, '0.1.1');

  // Deep link event listener drops malicious javascript: payloads and forwards valid kodera:// URIs.
  /** @type {string[]} */
  const receivedLinks = [];
  const stopListening = await client.listenDeepLinks((ev) => {
    receivedLinks.push(ev.canonicalUri);
  });
  const registeredHandler = [...callbacks.values()][0];
  registeredHandler({ payload: 'javascript:alert(1)' });
  registeredHandler({ payload: 'matrix:r/ops:untrusted.example.org?action=join' });
  registeredHandler({ payload: 'kodera://workspace/kodera/ops' });
  assert.deepEqual(receivedLinks, ['kodera://workspace/kodera/ops']);
  await stopListening();
  await stopListening(); // idempotent second call

  // Tray actions cover all 4 menu items.
  assert.deepEqual([...TRAY_MENU_ITEM_IDS], [
    'open_kodera',
    'toggle_mute',
    'unread_indicator',
    'quit',
  ]);
  const toggled = await client.triggerTrayAction('toggle_mute');
  assert.equal(toggled.applied, true);
  assert.equal(toggled.muted, true);

  await client.setUnreadCount(9);
  await client.updateTrayState({ unreadCount: 9, callState: 'voice', muted: true });
  await client.sendNotification({
    title: 'Ops',
    body: 'Ready',
    routeUri: 'matrix:r/ops:community.kodera.io?action=join',
    redactPreview: false,
  });

  // Keychain rejects metadata secret leaks before invoking native IPC.
  await assert.rejects(
    () =>
      client.storeSecureCredential({
        secretKind: 'matrix-session',
        matrixUserId: '@alice:kodera.io',
        deviceId: SAMPLE_SECRET.toUpperCase(),
        issuedAtUnixSecs: 1_762_520_000,
        rawSecret: SAMPLE_SECRET,
      }),
    /secret_leaked_in_metadata/u,
  );

  const stored = await client.storeSecureCredential({
    secretKind: 'matrix-session',
    matrixUserId: '@alice:kodera.io',
    deviceId: 'MAC_01',
    issuedAtUnixSecs: 1_762_520_000,
    expiresAtUnixSecs: 1_762_523_600,
    rawSecret: SAMPLE_SECRET,
  });
  assert.equal(stored.stored, true);
  assert.equal(stored.nativeKeychain, true);

  const loaded = await client.loadSecureCredentialStatus('matrix-session', '@alice:kodera.io');
  assert.equal(loaded.present, true);

  const deleted = await client.deleteSecureCredential('matrix-session', '@alice:kodera.io');
  assert.equal(deleted.present, true);

  /** @type {string[]} */
  const trayEvents = [];
  const stopTrayListening = await client.listenTrayActions((act) => {
    trayEvents.push(act);
  });
  const trayHandler = [...callbacks.values()][1];
  trayHandler({ payload: 'invalid_action_ignored' });
  trayHandler({ payload: 'toggle_mute' });
  assert.deepEqual(trayEvents, ['toggle_mute']);
  await stopTrayListening();

  const oidcReady = await client.beginOidcPkceLoopback({
    issuerOrigin: 'https://auth.kodera.io',
    clientId: 'kodera-desktop',
    codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
    state: 'pkce_state_fixture_0001',
    loopbackPort: 51_920,
  });
  assert.equal(oidcReady.redirectUri, 'http://127.0.0.1:51920/auth/callback');
  assert.equal(oidcReady.codeChallenge, 'challenge_s256_fixture');

  const oidcDone = await client.completeOidcPkceCallback(
    'http://127.0.0.1:51920/auth/callback?code=code_fixture_0001&state=pkce_state_fixture_0001',
  );
  assert.equal(oidcDone.verified, true);

  const placement = await client.restoreWindowBounds(
    '{"x":-2000,"y":50,"width":1280,"height":820,"maximized":false,"fullscreen":false,"visible":true}',
  );
  assert.equal(placement.applied, true);
  assert.equal(placement.clamped, true);

  // Clearing organisation ID fences all org-scoped IPC commands.
  client.setOrganisationId(null);
  await assert.rejects(() => client.setUnreadCount(1), /invalid_organisation/u);
  assert.ok(calls.length >= 10);
});

test('tauri.conf.json and capabilities/default.json satisfy security invariants and reject permissive mutations', () => {
  const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const cap = JSON.parse(readFileSync(join(tauriDir, 'capabilities/default.json'), 'utf8'));

  // Positive check against real configuration on disk.
  validateTauriSecurityInvariants(conf, cap);
  assert.ok(APPROVED_CONNECT_SOURCES.includes("'self'"));
  assert.ok(APPROVED_CAPABILITY_PERMISSIONS.includes('core:default'));

  // Negative self-test 1: unsafe-eval in CSP is rejected.
  const evalConf = structuredClone(conf);
  evalConf.app.security.csp += "; script-src 'self' 'unsafe-eval'";
  assert.throws(
    () => validateTauriSecurityInvariants(evalConf, cap),
    /CSP must forbid 'unsafe-eval'/u,
  );

  // Negative self-test 2: overly permissive shell:allow-execute capability is rejected.
  const shellCap = structuredClone(cap);
  shellCap.permissions.push('shell:allow-execute');
  assert.throws(
    () => validateTauriSecurityInvariants(conf, shellCap),
    /capability must remain least privilege/u,
  );

  // Negative self-test 3: remote origin capability grant is rejected.
  const remoteCap = structuredClone(cap);
  remoteCap.remote = { urls: ['https://*.kodera.io'] };
  assert.throws(
    () => validateTauriSecurityInvariants(conf, remoteCap),
    /capability must not grant remote origins/u,
  );

  // Negative self-test 4: bare wildcard connect-src without path scope is rejected.
  const wildcardConnectConf = structuredClone(conf);
  wildcardConnectConf.app.security.csp = wildcardConnectConf.app.security.csp.replace(
    'https://*.kodera.io/_matrix/',
    'https://*.kodera.io',
  );
  assert.throws(
    () => validateTauriSecurityInvariants(wildcardConnectConf, cap),
    /connect-src must use only approved sources/u,
  );

  // Client deep-link validator rejects traversal and credentials.
  assert.equal(validateClientDeepLinkUri('kodera://workspace/../etc').ok, false);
  assert.equal(validateClientDeepLinkUri('kodera://user@workspace/acme').ok, false);
});

test('multi-OS packaging planner covers macOS, Linux, and Windows without leaking signing secrets', () => {
  const fakeSigningSecret = 'SIGNING_PRIVATE_SECRET_NEVER_PRINT';
  const env = {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example',
    APPLE_ID: 'release@kodera.io',
    APPLE_PASSWORD: fakeSigningSecret,
    APPLE_TEAM_ID: 'TEAMID1234',
    TAURI_SIGNING_PRIVATE_KEY: fakeSigningSecret,
  };

  const macPlan = buildPackagingPlan('macos', env);
  assert.deepEqual(macPlan.bundles, ['app', 'dmg']);
  assert.equal(macPlan.signing.fullyConfigured, true);
  assert.ok(!JSON.stringify(macPlan).includes(fakeSigningSecret));

  const linuxPlan = buildPackagingPlan('linux', {});
  assert.deepEqual(linuxPlan.bundles, ['appimage', 'deb']);
  assert.equal(linuxPlan.signing.fullyConfigured, false);

  const winPlan = buildPackagingPlan('windows', {});
  assert.deepEqual(winPlan.bundles, ['msi', 'nsis']);
  assert.ok(winPlan.expectedArtifacts.some((p) => p.endsWith('.msi')));
  assert.ok(winPlan.expectedArtifacts.some((p) => p.endsWith('-setup.exe')));

  assert.equal(runDesktopCli(['package', '--target', 'macos', '--dry-run']), 0);
});

test('compiled kodera-desktop binary passes --self-check and --ipc-stdio round-trip when present', (t) => {
  const targetDir =
    process.env.CARGO_TARGET_DIR
    ?? resolve(desktopDir, '..', '..', '..', '.cargo-target');
  const binName = process.platform === 'win32' ? 'kodera-desktop.exe' : 'kodera-desktop';
  const candidates = [
    join(targetDir, 'debug', binName),
    join(desktopDir, '..', '..', 'target', 'debug', binName),
  ];
  const binPath = candidates.find((candidate) => existsSync(candidate));
  if (!binPath) {
    t.skip('kodera-desktop debug binary not built in current environment');
    return;
  }

  const selfCheck = spawnSync(binPath, ['--self-check'], { encoding: 'utf8' });
  assert.equal(selfCheck.status, 0);
  const report = JSON.parse(selfCheck.stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.csp_verified, true);
  assert.equal(report.tray_menu_count, 4);

  const healthCheck = spawnSync(binPath, ['--health'], { encoding: 'utf8' });
  assert.equal(healthCheck.status, 0);
  assert.equal(JSON.parse(healthCheck.stdout.trim()).ok, true);

  const openUrlCheck = spawnSync(
    binPath,
    ['--open-url', 'kodera://workspace/acme-ops/general'],
    { encoding: 'utf8' },
  );
  assert.equal(openUrlCheck.status, 0);
  assert.equal(
    JSON.parse(openUrlCheck.stdout.trim()).canonical_uri,
    'kodera://workspace/acme-ops/general',
  );

  const stdioInput = [
    JSON.stringify({ host_op: 'init_session', organisation_id: ORG_ID }),
    JSON.stringify({ command: 'set_unread_badge', organisation_id: ORG_ID, unread_count: 15 }),
    JSON.stringify({ host_op: 'quit' }),
  ].join('\n') + '\n';

  const stdioRun = spawnSync(binPath, ['--ipc-stdio'], {
    input: stdioInput,
    encoding: 'utf8',
  });
  assert.equal(stdioRun.status, 0);
  const replies = stdioRun.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[1].badge_label, '15');
  assert.equal(replies[2].quit, true);
});

test('.env.example documents code-signing variables with blank/safe values and CLI dry-runs succeed', () => {
  const envExamplePath = join(desktopDir, '.env.example');
  assert.equal(existsSync(envExamplePath), true);
  const envText = readFileSync(envExamplePath, 'utf8');
  for (const requiredKey of [
    'APPLE_SIGNING_IDENTITY=',
    'APPLE_TEAM_ID=',
    'APPLE_ID=',
    'APPLE_PASSWORD=',
    'WINDOWS_CERTIFICATE_THUMBPRINT=',
    'WINDOWS_TIMESTAMP_URL=',
    'TAURI_SIGNING_PRIVATE_KEY=',
  ]) {
    assert.ok(envText.includes(requiredKey), `.env.example must document ${requiredKey}`);
  }
  // Secret keys in .env.example must remain empty.
  for (const secretKey of [
    'APPLE_PASSWORD',
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  ]) {
    const match = new RegExp(`^${secretKey}=(.*)$`, 'mu').exec(envText);
    assert.notEqual(match, null, `${secretKey} must be present in .env.example`);
    assert.equal(match?.[1]?.trim(), '', `${secretKey} must be blank in .env.example`);
  }

  assert.equal(runDesktopCli(['dev', '--dry-run']), 0);
  assert.equal(runDesktopCli(['build', '--dry-run']), 0);

  // Real child-process CLI execution: direct path + symlinked path containing spaces.
  const cliScript = join(desktopDir, 'scripts', 'desktop-cli.mjs');
  const directRun = spawnSync(
    process.execPath,
    [cliScript, 'package', '--target', 'windows', '--dry-run'],
    { cwd: desktopDir, encoding: 'utf8' },
  );
  assert.equal(directRun.status, 0, directRun.stderr);
  const directLines = directRun.stdout.trim().split('\n');
  const jsonStartIdx = directLines.findIndex((line) => line.startsWith('{'));
  assert.ok(jsonStartIdx >= 0, 'desktop-cli.mjs must emit packaging plan JSON');
  const parsedPlan = JSON.parse(directLines.slice(jsonStartIdx).join('\n'));
  assert.equal(parsedPlan.targetOs, 'windows');
  assert.deepEqual(parsedPlan.bundles, ['msi', 'nsis']);

  if (process.platform !== 'win32') {
    const scratch = mkdtempSync(join(tmpdir(), 'kodera desktop cli-'));
    try {
      const spacedDir = join(scratch, 'nested dir with spaces');
      mkdirSync(spacedDir, { recursive: true });
      const linkedCli = join(spacedDir, 'desktop-cli-link.mjs');
      symlinkSync(cliScript, linkedCli);
      const symlinkRun = spawnSync(
        process.execPath,
        [linkedCli, 'package', '--target', 'windows', '--dry-run'],
        { cwd: desktopDir, encoding: 'utf8' },
      );
      assert.equal(symlinkRun.status, 0, symlinkRun.stderr);
      assert.ok(symlinkRun.stdout.includes('"targetOs": "windows"'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

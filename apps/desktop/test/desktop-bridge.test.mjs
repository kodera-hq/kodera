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
  COMMUNITY_TLS_MODES,
  DESKTOP_APP_IDENTIFIER,
  MAX_MEDIA_DEVICE_ID_BYTES,
  REDACTED_NOTIFICATION_PREVIEW,
  SCREEN_SHARE_SURFACES,
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
  await assert.rejects(
    () => client.routeDeepLink('kodera://auth/callback?redirect'),
    /deep_link_rejected:open_redirect_detected/u,
  );
  await assert.rejects(
    () => client.routeDeepLink('kodera://auth/callback?REDIRECT_URI=https://evil.test'),
    /deep_link_rejected:open_redirect_detected/u,
  );
  await assert.rejects(
    () => client.routeDeepLink('kodera://auth/callback?%72edirect=https://evil.test'),
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
  assert.equal(stored.ephemeralProcessVault, false);
  assert.equal(storageTouched, false);

  const loaded = await client.loadSecureCredentialStatus('matrix-session', '@alice:kodera.io');
  assert.equal(loaded.present, false);
  assert.equal(loaded.nativeKeychain, false);
  assert.equal(loaded.ephemeralProcessVault, false);

  await assert.rejects(
    () =>
      client.beginOidcPkceLoopback({
        issuerOrigin: 'https://auth.kodera.io',
        clientId: 'kodera-desktop',
        codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
        state: 'pkce_state_fixture_0001',
        loopbackPort: 51_920,
      }),
    /invalid_issuer_origin/u,
  );

  const oidcStart = await client.beginOidcPkceLoopback({
    issuerOrigin: 'https://auth.kodera.io/realms/kodera',
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
    location: {
      protocol: 'kodera-asset:',
      hostname: 'localhost',
      port: '',
    },
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
              supported: true,
              verified: true,
              updateReady: true,
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
  assert.equal(updateInfo.updateReady, true);
  assert.equal(updateInfo.verified, true);

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
  assert.equal(stored.nativeKeychain, false);
  assert.equal(stored.ephemeralProcessVault, true);

  const loaded = await client.loadSecureCredentialStatus('matrix-session', '@alice:kodera.io');
  assert.equal(loaded.present, true);
  assert.equal(loaded.nativeKeychain, false);
  assert.equal(loaded.ephemeralProcessVault, true);

  const deleted = await client.deleteSecureCredential('matrix-session', '@alice:kodera.io');
  assert.equal(deleted.present, true);
  assert.equal(deleted.nativeKeychain, false);
  assert.equal(deleted.ephemeralProcessVault, true);

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
    issuerOrigin: 'https://auth.kodera.io/realms/kodera',
    clientId: 'kodera-desktop',
    codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
    state: 'pkce_state_fixture_0001',
    loopbackPort: 51_920,
  });
  assert.equal(oidcReady.redirectUri, 'http://127.0.0.1:51920/auth/callback');
  assert.equal(oidcReady.codeChallenge, 'challenge_s256_fixture');

  const oidcDone = await client.completeOidcPkceCallback(
    'http://127.0.0.1:51920/auth/callback?code=code_fixture_0001&state=pkce_state_fixture_0001&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fkodera',
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

  // Missing `location` without explicit test-harness flag fails closed (zero native IPC invocations).
  /** @type {string[]} */
  const missingLocCalls = [];
  const missingLocClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {
      __TAURI_INTERNALS__: {
        async invoke(cmd) {
          missingLocCalls.push(cmd);
          return {};
        },
      },
    },
  });
  assert.equal(missingLocClient.isNativeDesktop(), false);
  const noOpOidc = await missingLocClient.beginOidcPkceLoopback({
    issuerOrigin: 'https://auth.kodera.io/realms/kodera',
    clientId: 'kodera-desktop',
    codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
    state: 'pkce_state_fixture_0001',
    loopbackPort: 51_920,
  });
  assert.equal(noOpOidc.supported, false);
  assert.equal(missingLocCalls.length, 0);

  // `http://localhost:5173` fails closed in release mode, and forged window globals cannot re-enable dev or test mode.
  /** @type {string[]} */
  const devCalls = [];
  const release5173Client = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {
      __KODERA_DESKTOP_TEST_ENV__: true,
      __KODERA_DESKTOP_DEV_ORIGIN__: true,
      location: { protocol: 'http:', hostname: 'localhost', port: '5173' },
      __TAURI_INTERNALS__: {
        async invoke(cmd) {
          devCalls.push(cmd);
          return {};
        },
      },
    },
  });
  assert.equal(release5173Client.isNativeDesktop(), false);
  assert.equal(
    (
      await release5173Client.beginOidcPkceLoopback({
        issuerOrigin: 'https://auth.kodera.io/realms/kodera',
        clientId: 'kodera-desktop',
        codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
        state: 'pkce_state_fixture_0001',
        loopbackPort: 51_920,
      })
    ).supported,
    false,
  );
  assert.equal(devCalls.length, 0);

  // Node.js process.env test-harness gate (`KODERA_DESKTOP_BRIDGE_NODE_TEST === '1'`) enables headless
  // missing-`location` tests only via Node's `process.env` (never via forgeable window properties).
  const forgedWindowMissingLoc = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {
      __KODERA_DESKTOP_TEST_ENV__: true,
      __TAURI_INTERNALS__: {
        async invoke(cmd) {
          devCalls.push(cmd);
          return {};
        },
      },
    },
  });
  assert.equal(forgedWindowMissingLoc.isNativeDesktop(), false);
  assert.equal(devCalls.length, 0);

  const prevNodeTestFlag = process.env.KODERA_DESKTOP_BRIDGE_NODE_TEST;
  process.env.KODERA_DESKTOP_BRIDGE_NODE_TEST = '1';
  try {
    assert.equal(forgedWindowMissingLoc.isNativeDesktop(), true);
  } finally {
    if (prevNodeTestFlag === undefined) {
      delete process.env.KODERA_DESKTOP_BRIDGE_NODE_TEST;
    } else {
      process.env.KODERA_DESKTOP_BRIDGE_NODE_TEST = prevNodeTestFlag;
    }
  }
  assert.equal(forgedWindowMissingLoc.isNativeDesktop(), false);
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
    JSON.stringify({
      command: 'self_host_preflight_community',
      organisation_id: ORG_ID,
      stack_dir: 'relative/path',
      domain: 'chat.example.org',
      acme_email: 'ops@example.org',
      tls_mode: 'acme',
      http_port: 80,
      https_port: 443,
    }),
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
  assert.equal(replies.length, 4);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[1].badge_label, '15');
  assert.equal(replies[2].ok, false);
  assert.equal(replies[2].error, 'community_deploy:invalid_stack_dir');
  assert.equal(replies[3].quit, true);

  // Cross-process persistent keychain restart + PTT/media serialization verification:
  // Process 1 stores credential (`native_keychain: true`), exercises PTT & media capture, and quits (`clear_session`).
  // Process 2 starts fresh, reloads credential (`present: true, native_keychain: true`), deletes it, and verifies `present: false`.
  const vaultScratch = mkdtempSync(join(tmpdir(), 'kodera-keychain-restart-'));
  try {
    const vaultPath = join(vaultScratch, 'debug-keychain-vault.json');
    const nowUnix = Math.floor(Date.now() / 1000);
    const proc1Input = [
      JSON.stringify({ host_op: 'init_session', organisation_id: ORG_ID }),
      JSON.stringify({
        command: 'store_keychain_credential',
        organisation_id: ORG_ID,
        secret_kind: 'matrix-session',
        matrix_user_id: '@alice:kodera.io',
        device_id: 'MACBOOK_RESTART_01',
        issued_at_unix_secs: nowUnix,
        expires_at_unix_secs: nowUnix + 3600,
        raw_secret: SAMPLE_SECRET,
      }),
      JSON.stringify({
        command: 'configure_ptt',
        organisation_id: ORG_ID,
        opt_in: true,
        chord: 'Ctrl+Shift+Space',
      }),
      JSON.stringify({
        command: 'set_ptt_pressed',
        organisation_id: ORG_ID,
        pressed: true,
        now_ms: 9100,
      }),
      JSON.stringify({
        command: 'configure_media_capture',
        organisation_id: ORG_ID,
        preferred_surface: 'window',
        system_audio_loopback: true,
        noise_suppression: true,
        preferred_audio_input_id: 'usb-mic-01',
      }),
      JSON.stringify({ host_op: 'quit' }),
    ].join('\n') + '\n';

    const proc1 = spawnSync(binPath, ['--ipc-stdio'], {
      input: proc1Input,
      encoding: 'utf8',
      env: { ...process.env, KODERA_DESKTOP_DEBUG_KEYCHAIN_VAULT: vaultPath },
    });
    assert.equal(proc1.status, 0, proc1.stderr);
    assert.ok(!proc1.stdout.includes(SAMPLE_SECRET), 'stdout must never echo raw keychain secret');
    const p1Replies = proc1.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(p1Replies.length, 6);
    assert.equal(p1Replies[1].ok, true);
    assert.equal(p1Replies[1].type, 'keychain_metadata');
    assert.equal(p1Replies[1].native_keychain, true);
    assert.equal(p1Replies[2].type, 'ptt_state');
    assert.equal(p1Replies[2].binding, 'Ctrl+Shift+Space');
    assert.equal(p1Replies[3].type, 'ptt_state');
    assert.equal(p1Replies[3].transmitting, true);
    assert.equal(p1Replies[3].transmitting_since_ms, 9100);
    assert.equal(p1Replies[4].type, 'media_capture_state');
    assert.equal(p1Replies[4].preferred_surface, 'window');
    assert.equal(p1Replies[4].system_audio_loopback, true);
    assert.equal(p1Replies[5].quit, true);

    const proc2Input = [
      JSON.stringify({ host_op: 'init_session', organisation_id: ORG_ID }),
      JSON.stringify({
        command: 'load_keychain_credential',
        organisation_id: ORG_ID,
        secret_kind: 'matrix-session',
        matrix_user_id: '@alice:kodera.io',
      }),
      JSON.stringify({
        command: 'delete_keychain_credential',
        organisation_id: ORG_ID,
        secret_kind: 'matrix-session',
        matrix_user_id: '@alice:kodera.io',
      }),
      JSON.stringify({
        command: 'load_keychain_credential',
        organisation_id: ORG_ID,
        secret_kind: 'matrix-session',
        matrix_user_id: '@alice:kodera.io',
      }),
      JSON.stringify({ host_op: 'quit' }),
    ].join('\n') + '\n';

    const proc2 = spawnSync(binPath, ['--ipc-stdio'], {
      input: proc2Input,
      encoding: 'utf8',
      env: { ...process.env, KODERA_DESKTOP_DEBUG_KEYCHAIN_VAULT: vaultPath },
    });
    assert.equal(proc2.status, 0, proc2.stderr);
    assert.ok(!proc2.stdout.includes(SAMPLE_SECRET));
    const p2Replies = proc2.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(p2Replies.length, 5);
    assert.equal(p2Replies[1].ok, true);
    assert.equal(p2Replies[1].type, 'keychain_status');
    assert.equal(p2Replies[1].present, true);
    assert.equal(p2Replies[1].native_keychain, true);
    assert.equal(p2Replies[2].ok, true);
    assert.equal(p2Replies[2].present, true);
    assert.equal(p2Replies[2].native_keychain, true);
    assert.equal(p2Replies[3].ok, true);
    assert.equal(p2Replies[3].present, false);
    assert.equal(p2Replies[3].native_keychain, false);
    assert.equal(p2Replies[4].quit, true);
  } finally {
    rmSync(vaultScratch, { recursive: true, force: true });
  }
});

test('Push-to-Talk, media capture, and native keychain status bridge enforce validation, fallback, and live events', async () => {
  assert.deepEqual([...SCREEN_SHARE_SURFACES], ['monitor', 'window', 'browser_tab']);
  assert.equal(MAX_MEDIA_DEVICE_ID_BYTES, 128);

  const webClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {},
  });

  const webPttCfg = await webClient.configurePushToTalk({
    optIn: true,
    chord: 'option+shift+space',
  });
  assert.equal(webPttCfg.supported, false);
  assert.equal(webPttCfg.optInEnabled, true);
  assert.equal(webPttCfg.binding, 'Alt+Shift+Space');
  assert.equal((await webClient.setPushToTalkPressed(true, 1200)).supported, false);
  assert.equal((await webClient.getPushToTalkState()).supported, false);
  const stopWebPtt = await webClient.listenPushToTalk(() => {});
  await stopWebPtt();

  const webMedia = await webClient.configureMediaCapture({
    preferredSurface: 'browser_tab',
    systemAudioLoopback: true,
    noiseSuppression: false,
    preferredAudioInputId: 'mic-usb-01',
  });
  assert.equal(webMedia.supported, false);
  assert.equal(webMedia.preferredSurface, 'browser_tab');
  assert.equal(webMedia.systemAudioLoopback, true);
  assert.equal(webMedia.noiseSuppression, false);
  assert.equal((await webClient.getMediaCaptureState()).supported, false);

  // Typing-hijack and reserved system chords fail closed before any native IPC call.
  for (const unsafeChord of ['Space', 'A', 'Shift+A', 'F5']) {
    await assert.rejects(
      () => webClient.configurePushToTalk({ optIn: true, chord: unsafeChord }),
      /unsafe_typing_key_without_modifier/u,
    );
  }
  for (const reservedChord of ['Alt+F4', 'Ctrl+Q', 'Super+Q', 'Super+L', 'Ctrl+W', 'Ctrl+Enter', 'Ctrl+Escape']) {
    await assert.rejects(
      () => webClient.configurePushToTalk({ optIn: true, chord: reservedChord }),
      /reserved_system_chord/u,
    );
  }
  await assert.rejects(
    () => webClient.configurePushToTalk({ optIn: false, chord: 'Ctrl+Space' }),
    /ptt_not_opted_in/u,
  );
  await assert.rejects(
    // @ts-expect-error negative test for invalid surface
    () => webClient.configureMediaCapture({ preferredSurface: 'entire_gpu' }),
    /invalid_screen_share_surface/u,
  );
  await assert.rejects(
    () => webClient.configureMediaCapture({ preferredAudioInputId: 'x'.repeat(129) }),
    /invalid_audio_input_device_id/u,
  );
  await assert.rejects(
    () => webClient.configureMediaCapture({ preferredAudioOutputId: ' bad-padding ' }),
    /invalid_audio_output_device_id/u,
  );

  /** @type {Map<number, (payload: unknown) => void>} */
  const callbacks = new Map();
  let nextCb = 1;
  const nativeClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {
      location: { protocol: 'kodera-asset:', hostname: 'localhost', port: '' },
      __TAURI_INTERNALS__: {
        transformCallback(fn) {
          const id = nextCb++;
          callbacks.set(id, fn);
          return id;
        },
        async invoke(cmd, args) {
          switch (cmd) {
            case 'plugin:event|listen':
              return 88;
            case 'plugin:event|unlisten':
              return null;
            case 'store_keychain_credential':
              return {
                ok: true,
                type: 'keychain_metadata',
                service_name: `io.kodera.desktop.${args?.secret_kind}`,
                native_keychain: true,
              };
            case 'load_keychain_credential':
              return {
                ok: true,
                type: 'keychain_status',
                service_name: `io.kodera.desktop.${args?.secret_kind}`,
                present: true,
                native_keychain: true,
              };
            case 'configure_ptt':
              return {
                ok: true,
                type: 'ptt_state',
                opt_in_enabled: args?.opt_in,
                binding: args?.chord ?? null,
                transmitting: false,
                transmitting_since_ms: null,
              };
            case 'set_ptt_pressed':
              return {
                ok: true,
                type: 'ptt_state',
                opt_in_enabled: true,
                binding: 'Ctrl+Shift+Space',
                transmitting: args?.pressed,
                transmitting_since_ms: args?.pressed ? args?.now_ms : null,
              };
            case 'get_ptt_state':
              return {
                ok: true,
                type: 'ptt_state',
                opt_in_enabled: true,
                binding: 'Ctrl+Shift+Space',
                transmitting: false,
                transmitting_since_ms: null,
              };
            case 'configure_media_capture':
              return {
                ok: true,
                type: 'media_capture_state',
                preferred_surface: args?.preferred_surface,
                system_audio_loopback: args?.system_audio_loopback,
                noise_suppression: args?.noise_suppression,
                preferred_audio_input_id: args?.preferred_audio_input_id ?? null,
                preferred_audio_output_id: args?.preferred_audio_output_id ?? null,
              };
            case 'get_media_capture_state':
              return {
                ok: true,
                type: 'media_capture_state',
                preferred_surface: 'window',
                system_audio_loopback: true,
                noise_suppression: true,
                preferred_audio_input_id: 'usb-mic-01',
                preferred_audio_output_id: null,
              };
            default:
              return { ok: true };
          }
        },
      },
    },
  });

  const nativeStored = await nativeClient.storeSecureCredential({
    secretKind: 'matrix-session',
    matrixUserId: '@alice:kodera.io',
    deviceId: 'MAC_NATIVE_01',
    issuedAtUnixSecs: 1_762_520_000,
    rawSecret: SAMPLE_SECRET,
  });
  assert.equal(nativeStored.stored, true);
  assert.equal(nativeStored.nativeKeychain, true);
  assert.equal(nativeStored.ephemeralProcessVault, false);

  const nativeLoaded = await nativeClient.loadSecureCredentialStatus(
    'matrix-session',
    '@alice:kodera.io',
  );
  assert.equal(nativeLoaded.present, true);
  assert.equal(nativeLoaded.nativeKeychain, true);
  assert.equal(nativeLoaded.ephemeralProcessVault, false);

  const pttCfg = await nativeClient.configurePushToTalk({
    optIn: true,
    chord: 'ctrl+shift+space',
  });
  assert.equal(pttCfg.supported, true);
  assert.equal(pttCfg.binding, 'Ctrl+Shift+Space');

  const pttDown = await nativeClient.setPushToTalkPressed(true, 4500);
  assert.equal(pttDown.transmitting, true);
  assert.equal(pttDown.transmittingSinceMs, 4500);

  const pttCur = await nativeClient.getPushToTalkState();
  assert.equal(pttCur.optInEnabled, true);
  assert.equal(pttCur.transmitting, false);

  /** @type {Array<{ transmitting: boolean, transmittingSinceMs: number | null }>} */
  const pttEvents = [];
  const unlistenPtt = await nativeClient.listenPushToTalk((ev) => {
    pttEvents.push({
      transmitting: ev.transmitting,
      transmittingSinceMs: ev.transmittingSinceMs,
    });
  });
  const pttHandler = [...callbacks.values()][0];
  pttHandler({ payload: 'not-valid-json' });
  pttHandler({
    payload: JSON.stringify({
      ok: true,
      type: 'ptt_state',
      opt_in_enabled: true,
      binding: 'Ctrl+Shift+Space',
      transmitting: true,
      transmitting_since_ms: 7700,
    }),
  });
  pttHandler({
    payload: JSON.stringify({
      ok: true,
      type: 'ptt_state',
      opt_in_enabled: true,
      binding: 'Ctrl+Shift+Space',
      transmitting: false,
      transmitting_since_ms: null,
    }),
  });
  assert.deepEqual(pttEvents, [
    { transmitting: true, transmittingSinceMs: 7700 },
    { transmitting: false, transmittingSinceMs: null },
  ]);
  await unlistenPtt();

  const mediaCfg = await nativeClient.configureMediaCapture({
    preferredSurface: 'window',
    systemAudioLoopback: true,
    noiseSuppression: true,
    preferredAudioInputId: 'usb-mic-01',
  });
  assert.equal(mediaCfg.supported, true);
  assert.equal(mediaCfg.preferredSurface, 'window');
  assert.equal(mediaCfg.preferredAudioInputId, 'usb-mic-01');

  const mediaGet = await nativeClient.getMediaCaptureState();
  assert.equal(mediaGet.supported, true);
  assert.equal(mediaGet.preferredSurface, 'window');
  assert.equal(mediaGet.systemAudioLoopback, true);
});

test('WebView keyboard responder drives PTT chords, filters editable targets, and releases unconditionally on keyup, blur, and visibilitychange', async () => {
  /** @type {Map<string, Set<(ev: any) => void>>} */
  const winListeners = new Map();
  /** @type {Map<string, Set<(ev: any) => void>>} */
  const docListeners = new Map();
  /** @type {Array<{ cmd: string, args: Record<string, unknown> | undefined }>} */
  const calls = [];

  const mockDocument = {
    visibilityState: 'visible',
    hidden: false,
    focused: true,
    hasFocus() {
      return this.focused;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)?.add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
  };

  const mockWindow = {
    location: { protocol: 'kodera-asset:', hostname: 'localhost', port: '' },
    document: mockDocument,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)?.add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    __TAURI_INTERNALS__: {
      transformCallback() {
        return 42;
      },
      async invoke(cmd, args) {
        calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') return 99;
        if (cmd === 'plugin:event|unlisten') return null;
        if (cmd === 'load_keychain_credential' || cmd === 'delete_keychain_credential') {
          return { ok: true, present: false, native_keychain: false, service_name: 'io.kodera.desktop.matrix-session' };
        }
        if (cmd === 'configure_ptt') {
          return {
            ok: true,
            type: 'ptt_state',
            opt_in_enabled: args?.opt_in,
            binding: args?.chord ?? null,
            transmitting: false,
            transmitting_since_ms: null,
          };
        }
        if (cmd === 'set_ptt_pressed') {
          return {
            ok: true,
            type: 'ptt_state',
            opt_in_enabled: true,
            binding: 'Ctrl+Shift+Space',
            transmitting: Boolean(args?.pressed),
            transmitting_since_ms: args?.pressed ? args?.now_ms : null,
          };
        }
        return { ok: true };
      },
    },
  };

  /**
   * @param {Map<string, Set<(ev: any) => void>>} table
   * @param {string} type
   * @param {Record<string, unknown>} [ev]
   */
  const emit = (table, type, ev = {}) => {
    for (const fn of table.get(type) ?? []) {
      fn(ev);
    }
  };

  const client = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: mockWindow,
  });

  // Absent keychain slot reports `present: false, nativeKeychain: false, ephemeralProcessVault: false`.
  const absentLoad = await client.loadSecureCredentialStatus('matrix-session', '@alice:kodera.io');
  assert.equal(absentLoad.present, false);
  assert.equal(absentLoad.nativeKeychain, false);
  assert.equal(absentLoad.ephemeralProcessVault, false);
  const absentDel = await client.deleteSecureCredential('matrix-session', '@alice:kodera.io');
  assert.equal(absentDel.present, false);
  assert.equal(absentDel.nativeKeychain, false);
  assert.equal(absentDel.ephemeralProcessVault, false);

  const unlisten = await client.listenPushToTalk(() => {});
  await client.configurePushToTalk({ optIn: true, chord: 'F13' });

  const pttCalls = () => calls.filter((c) => c.cmd === 'set_ptt_pressed').map((c) => Boolean(c.args?.pressed));

  // Non-modifier chord (`F13`) is ignored inside `<input>`, `<textarea>`, and `[contenteditable]`.
  emit(winListeners, 'keydown', { code: 'F13', target: { tagName: 'INPUT' } });
  emit(winListeners, 'keydown', { code: 'F13', target: { tagName: 'TEXTAREA' } });
  emit(winListeners, 'keydown', { code: 'F13', target: { tagName: 'DIV', isContentEditable: true } });
  assert.deepEqual(pttCalls(), []);

  // Non-editable target triggers `F13` press, and `keyup` releases even if focus moved to `<input>`.
  emit(winListeners, 'keydown', { code: 'F13', target: { tagName: 'DIV' } });
  await new Promise((r) => setTimeout(r, 0));
  emit(winListeners, 'keyup', { code: 'F13', target: { tagName: 'INPUT' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(pttCalls(), [true, false]);

  // Command-modifier chord (`Ctrl+Shift+Space`) works even on `<input>`, prevents default, ignores repeat,
  // and releases unconditionally on modifier lift, window blur, and document visibilitychange!
  await client.configurePushToTalk({ optIn: true, chord: 'Ctrl+Shift+Space' });
  calls.length = 0;

  let prevented = 0;
  emit(winListeners, 'keydown', {
    code: 'Space',
    ctrlKey: true,
    shiftKey: true,
    target: { tagName: 'INPUT' },
    preventDefault() {
      prevented += 1;
    },
  });
  emit(winListeners, 'keydown', {
    code: 'Space',
    ctrlKey: true,
    shiftKey: true,
    repeat: true,
    target: { tagName: 'INPUT' },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(prevented, 1);
  assert.deepEqual(pttCalls(), [true]);

  // Lifting `ShiftLeft` mid-hold releases PTT immediately.
  emit(winListeners, 'keyup', { code: 'ShiftLeft', ctrlKey: true, shiftKey: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(pttCalls(), [true, false]);

  // Window `blur` releases PTT unconditionally.
  emit(winListeners, 'keydown', { code: 'Space', ctrlKey: true, shiftKey: true });
  await new Promise((r) => setTimeout(r, 0));
  emit(winListeners, 'blur', {});
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(pttCalls(), [true, false, true, false]);

  // Document `visibilitychange` (`hidden`) releases PTT unconditionally and blocks new presses while hidden.
  emit(winListeners, 'keydown', { code: 'Space', ctrlKey: true, shiftKey: true });
  await new Promise((r) => setTimeout(r, 0));
  mockDocument.visibilityState = 'hidden';
  mockDocument.hidden = true;
  emit(docListeners, 'visibilitychange', {});
  await new Promise((r) => setTimeout(r, 0));
  emit(winListeners, 'keydown', { code: 'Space', ctrlKey: true, shiftKey: true });
  assert.deepEqual(pttCalls(), [true, false, true, false, true, false]);

  await client.configurePushToTalk({ optIn: false });

  // Regression: pressing `F13` then calling `setOrganisationId(null)` MUST send `set_ptt_pressed(false)`
  // for the previous organisation BEFORE clearing `activeOrganisationId`, and ignore stale replies!
  mockDocument.visibilityState = 'visible';
  mockDocument.hidden = false;
  await client.configurePushToTalk({ optIn: true, chord: 'F13' });
  calls.length = 0;
  emit(winListeners, 'keydown', { code: 'F13', target: { tagName: 'DIV' } });
  client.setOrganisationId(null);
  await new Promise((r) => setTimeout(r, 0));
  const orgSwitchPttCalls = calls
    .filter((c) => c.cmd === 'set_ptt_pressed')
    .map((c) => ({ org: c.args?.organisation_id, pressed: Boolean(c.args?.pressed) }));
  assert.deepEqual(orgSwitchPttCalls, [
    { org: ORG_ID, pressed: true },
    { org: ORG_ID, pressed: false },
    { org: ORG_ID, pressed: false },
  ]);

  // Regression: starting public `setPushToTalkPressed(true)` with a delayed native reply and calling
  // `setOrganisationId(null)` BEFORE the reply resolves MUST release `prevOrgId` both on teardown
  // and upon delayed resolution!
  /** @type {((val: unknown) => void) | null} */
  let resolveDelayedPress = null;
  /** @type {Array<{ org: unknown, pressed: boolean }>} */
  const delayedCalls = [];
  const delayedClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {
      location: { protocol: 'kodera-asset:', hostname: 'localhost', port: '' },
      __TAURI_INTERNALS__: {
        async invoke(cmd, args) {
          if (cmd === 'set_ptt_pressed') {
            delayedCalls.push({ org: args?.organisation_id, pressed: Boolean(args?.pressed) });
            if (args?.pressed === true) {
              return new Promise((resolve) => {
                resolveDelayedPress = resolve;
              });
            }
          }
          return { ok: true, opt_in_enabled: true, binding: 'F13', transmitting: false };
        },
      },
    },
  });
  const pendingPress = delayedClient.setPushToTalkPressed(true, 9000);
  delayedClient.setOrganisationId(null);
  assert.ok(
    delayedCalls.some((c) => c.org === ORG_ID && c.pressed === false),
    'setOrganisationId(null) must release in-flight PTT press for prevOrgId immediately',
  );
  resolveDelayedPress?.({
    ok: true,
    opt_in_enabled: true,
    binding: 'F13',
    transmitting: true,
    transmitting_since_ms: 9000,
  });
  await pendingPress;
  assert.equal(delayedCalls[delayedCalls.length - 1]?.org, ORG_ID);
  assert.equal(delayedCalls[delayedCalls.length - 1]?.pressed, false);

  // Regression: pending press in Org A -> switch to Org B -> configure Org B `Ctrl+Space` ->
  // resolve Org A's delayed press reply MUST NOT clobber Org B's active `Ctrl+Space` binding!
  const otherOrg = '019a5e62-6ca0-7303-8303-030303030399';
  /** @type {((val: unknown) => void) | null} */
  let resolveOrgADelayed = null;
  let activeHostOrg = ORG_ID;
  /** @type {string | null} */
  let activeHostBinding = 'F13';
  const crossSwitchClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {
      location: { protocol: 'kodera-asset:', hostname: 'localhost', port: '' },
      __TAURI_INTERNALS__: {
        async invoke(cmd, args) {
          const reqOrg = typeof args?.organisation_id === 'string' ? args.organisation_id : null;
          if (cmd === 'set_ptt_pressed') {
            if (args?.pressed === true && reqOrg === ORG_ID) {
              return new Promise((resolve) => {
                resolveOrgADelayed = resolve;
              });
            }
            if (args?.pressed === false && reqOrg !== activeHostOrg) {
              return { ok: true, opt_in_enabled: false, binding: null, transmitting: false };
            }
            return { ok: true, opt_in_enabled: true, binding: activeHostBinding, transmitting: false };
          }
          if (cmd === 'configure_ptt') {
            activeHostOrg = reqOrg ?? activeHostOrg;
            activeHostBinding = typeof args?.chord === 'string' ? args.chord : null;
            return { ok: true, opt_in_enabled: Boolean(args?.opt_in), binding: activeHostBinding, transmitting: false };
          }
          if (cmd === 'get_ptt_state') {
            return {
              ok: true,
              opt_in_enabled: activeHostOrg === reqOrg && activeHostBinding !== null,
              binding: activeHostOrg === reqOrg ? activeHostBinding : null,
              transmitting: false,
            };
          }
          return { ok: true };
        },
      },
    },
  });
  const pendingOrgAPress = crossSwitchClient.setPushToTalkPressed(true, 9500);
  crossSwitchClient.setOrganisationId(otherOrg);
  await crossSwitchClient.configurePushToTalk({ optIn: true, chord: 'Ctrl+Space' });
  resolveOrgADelayed?.({
    ok: true,
    opt_in_enabled: true,
    binding: 'F13',
    transmitting: true,
    transmitting_since_ms: 9500,
  });
  await pendingOrgAPress;
  const orgBState = await crossSwitchClient.getPushToTalkState();
  assert.equal(orgBState.binding, 'Ctrl+Space');

  await unlisten();
  assert.equal(winListeners.get('keydown')?.size ?? 0, 0);
  assert.equal(winListeners.get('keyup')?.size ?? 0, 0);
  assert.equal(winListeners.get('blur')?.size ?? 0, 0);
  assert.equal(docListeners.get('visibilitychange')?.size ?? 0, 0);
});

test('Self-Host Wizard deploy/community bridge enforces injection defenses, browser fallback, and Tauri IPC handoff', async () => {
  assert.deepEqual([...COMMUNITY_TLS_MODES], ['acme', 'internal', 'off']);

  // 1. Browser fallback outside Tauri normalizes inputs and rejects every injection vector.
  const webClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {},
  });

  const webPicked = await webClient.selectCommunityStackDir();
  assert.equal(webPicked.supported, false);
  assert.equal(webPicked.selected, false);
  assert.equal(webPicked.stackDir, null);

  const webPreflight = await webClient.preflightCommunityDeploy({
    stackDir: '/srv/kodera/community',
    domain: 'Chat.Example.org',
    acmeEmail: 'ops@Example.org',
    tlsMode: 'acme',
    httpPort: 80,
    httpsPort: 443,
  });
  assert.equal(webPreflight.supported, false);
  assert.equal(webPreflight.normalizedDomain, 'chat.example.org');
  assert.equal(webPreflight.matrixBaseDomain, 'example.org');

  const webPrepare = await webClient.prepareCommunityDeploy({
    stackDir: '/srv/kodera/community',
    domain: 'Chat.Example.org',
    acmeEmail: 'ops@Example.org',
    oidcProviderOrigin: 'https://id.Example.org:443',
  });
  assert.equal(webPrepare.supported, false);
  assert.equal(webPrepare.envFileWritten, false);
  assert.equal(webPrepare.oidcIssuer, 'https://id.example.org/realms/community');

  const webDeploy = await webClient.deployCommunityStack({
    stackDir: '/srv/kodera/community',
    timeoutMs: 60_000,
  });
  assert.equal(webDeploy.supported, false);
  assert.equal(webDeploy.stackHealthy, false);

  // 2. Negative security tests: newline/CRLF env injection, traversal, shell metacharacters, ports, OIDC.
  /** @type {Array<{ cmd: string, args: unknown }>} */
  const recordedCalls = [];
  const mockTauri = {
    location: {
      protocol: 'kodera-asset:',
      hostname: 'localhost',
      port: '',
    },
    __TAURI_INTERNALS__: {
      async invoke(cmd, args) {
        recordedCalls.push({ cmd, args });
        switch (cmd) {
          case 'select_community_stack_dir':
            return {
              ok: true,
              selected: true,
              stack_dir: '/srv/kodera/community',
            };
          case 'self_host_preflight_community':
            return {
              docker_version: 'Docker version 28.1.0',
              compose_version: 'Docker Compose version v2.36.0',
              compose_file_present: true,
              stack_dir_writable: true,
              normalized_domain: 'chat.example.org',
              matrix_base_domain: 'example.org',
            };
          case 'self_host_prepare_community':
            return {
              env_file_written: true,
              unix_file_mode: 0o600,
              compose_config_valid: true,
              generated_secret_keys: [
                'POSTGRES_PASSWORD',
                'KODERA_API_DATABASE_PASSWORD',
                'KODERA_COLLAB_DATABASE_PASSWORD',
                'SYNAPSE_POSTGRES_PASSWORD',
                'DJANGO_SECRET_KEY',
                'KODERA_CONTACT_SEAL_KEY',
                'KODERA_OUTBOX_SEAL_KEY',
                'KODERA_MEMBERSHIP_CURSOR_KEY',
                'KODERA_DISCOVERY_HMAC_KEY',
                'KODERA_COLLAB_TICKET_KEY',
                'ROOM_ACCESS_MATRIX_TOKEN',
                'LIVEKIT_API_KEY',
                'LIVEKIT_API_SECRET',
                'KODERA_SYNAPSE_OIDC_CLIENT_SECRET',
                'KEYCLOAK_ADMIN_PASSWORD',
                'KEYCLOAK_DB_PASSWORD',
              ],
              normalized_domain: 'chat.example.org',
              matrix_base_domain: 'example.org',
              oidc_issuer: 'https://id.example.org/realms/community',
            };
          case 'self_host_deploy_community':
            return {
              stack_healthy: true,
              poll_attempts: 2,
              state: 'healthy',
              observed_memory_mib: 1280,
              core_services: [
                { service: 'keycloak', readiness: 'ready', external_oidc: false },
                { service: 'server', readiness: 'ready', external_oidc: false },
                { service: 'web', readiness: 'ready', external_oidc: false },
                { service: 'livekit', readiness: 'ready', external_oidc: false },
              ],
            };
          default:
            return {};
        }
      },
    },
  };

  const nativeClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: mockTauri,
  });

  for (const badDir of [
    'deploy/community',
    '/srv/kodera/../escape',
    '/srv/kodera\nEVIL=1',
    '/srv/kodera;id',
    '/srv/kodera$(whoami)',
    '/srv/kodera|cat',
    '/tmp/kodera-stack',
    '/private/tmp/kodera-stack',
    '/var/tmp/kodera-stack',
    '/var/folders/ab/cd/T/kodera-stack',
    '/private/var/folders/ab/cd/T/kodera-stack',
    '/dev/shm/kodera-stack',
    '/private/etc/kodera',
    '/Users/alice',
    '/home/alice',
    '//server/share/kodera',
    '\\\\server\\share\\kodera',
    '/srv/kodera/.ssh/stack',
  ]) {
    await assert.rejects(
      () =>
        nativeClient.preflightCommunityDeploy({
          stackDir: badDir,
          domain: 'chat.example.org',
          acmeEmail: 'ops@example.org',
        }),
      /invalid_stack_dir/u,
    );
  }

  for (const badDomain of [
    'chat.example.org\nEVIL=1',
    'chat.example.org\r\nEVIL=1',
    'localhost',
    '127.0.0.1',
    'chat..example.org',
    'chat;id.example.org',
  ]) {
    await assert.rejects(
      () =>
        nativeClient.preflightCommunityDeploy({
          stackDir: '/srv/kodera/community',
          domain: badDomain,
          acmeEmail: 'ops@example.org',
        }),
      /invalid_domain/u,
    );
  }

  for (const badEmail of [
    'ops@example.org\nEVIL=1',
    'ops@@example.org',
    'ops@localhost',
    'ops;id@example.org',
  ]) {
    await assert.rejects(
      () =>
        nativeClient.preflightCommunityDeploy({
          stackDir: '/srv/kodera/community',
          domain: 'chat.example.org',
          acmeEmail: badEmail,
        }),
      /invalid_acme_email/u,
    );
  }

  await assert.rejects(
    () =>
      nativeClient.preflightCommunityDeploy({
        stackDir: '/srv/kodera/community',
        domain: 'chat.example.org',
        acmeEmail: 'ops@example.org',
        // @ts-expect-error negative security test for invalid TLS mode
        tlsMode: 'self-signed',
      }),
    /invalid_tls_mode/u,
  );

  await assert.rejects(
    () =>
      nativeClient.preflightCommunityDeploy({
        stackDir: '/srv/kodera/community',
        domain: 'chat.example.org',
        acmeEmail: 'ops@example.org',
        httpPort: 443,
        httpsPort: 443,
      }),
    /invalid_port/u,
  );

  for (const badOidc of [
    'http://id.example.org',
    'https://id.example.org/realms/community',
    'https://user@id.example.org',
    'https://id.example.org\nEVIL=1',
  ]) {
    await assert.rejects(
      () =>
        nativeClient.prepareCommunityDeploy({
          stackDir: '/srv/kodera/community',
          domain: 'chat.example.org',
          acmeEmail: 'ops@example.org',
          oidcProviderOrigin: badOidc,
        }),
      /invalid_oidc_origin/u,
    );
  }

  await assert.rejects(
    () =>
      nativeClient.deployCommunityStack({
        stackDir: '/srv/kodera/community',
        timeoutMs: 500,
      }),
    /invalid_timeout_ms/u,
  );

  // Zero native IPC calls were emitted during all negative input rejections!
  assert.equal(recordedCalls.length, 0);

  // 3. Valid end-to-end selectStackDir -> preflight -> prepare (0600 mode, 16 CSPRNG keys) -> deploy + health handoff.
  const selectedFolder = await nativeClient.selectCommunityStackDir();
  assert.equal(selectedFolder.supported, true);
  assert.equal(selectedFolder.selected, true);
  assert.equal(selectedFolder.stackDir, '/srv/kodera/community');

  const preflight = await nativeClient.preflightCommunityDeploy({
    stackDir: '/srv/kodera/community',
    domain: 'Chat.Example.org',
    acmeEmail: 'ops@Example.org',
    tlsMode: 'acme',
    httpPort: 80,
    httpsPort: 443,
  });
  assert.equal(preflight.supported, true);
  assert.equal(preflight.composeFilePresent, true);
  assert.equal(preflight.stackDirWritable, true);
  assert.equal(preflight.dockerVersion, 'Docker version 28.1.0');

  const prepared = await nativeClient.prepareCommunityDeploy({
    stackDir: '/srv/kodera/community',
    domain: 'Chat.Example.org',
    acmeEmail: 'ops@Example.org',
    oidcProviderOrigin: 'https://id.Example.org:443',
    tlsMode: 'acme',
    httpPort: 80,
    httpsPort: 443,
  });
  assert.equal(prepared.supported, true);
  assert.equal(prepared.envFileWritten, true);
  assert.equal(prepared.unixFileMode, 0o600);
  assert.equal(prepared.composeConfigValid, true);
  assert.equal(prepared.generatedSecretKeys.length, 16);

  const deployed = await nativeClient.deployCommunityStack({
    stackDir: '/srv/kodera/community',
    timeoutMs: 60_000,
  });
  assert.equal(deployed.supported, true);
  assert.equal(deployed.stackHealthy, true);
  assert.equal(deployed.pollAttempts, 2);
  assert.equal(deployed.coreServices.length, 4);
  assert.ok(deployed.coreServices.every((svc) => svc.readiness === 'ready'));

  assert.equal(recordedCalls.length, 4);
  assert.equal(recordedCalls[0].cmd, 'select_community_stack_dir');
  assert.equal(recordedCalls[1].cmd, 'self_host_preflight_community');
  assert.equal(recordedCalls[2].cmd, 'self_host_prepare_community');
  assert.equal(recordedCalls[3].cmd, 'self_host_deploy_community');

  // Clearing organisation ID blocks community deploy commands.
  nativeClient.setOrganisationId(null);
  await assert.rejects(
    () => nativeClient.deployCommunityStack({ stackDir: '/srv/kodera/community' }),
    /invalid_organisation/u,
  );
});

test('.env.example documents code-signing variables with blank/safe values and CLI dry-runs succeed', () => {
  const envExamplePath = join(desktopDir, '.env.example');
  assert.equal(existsSync(envExamplePath), true);
  const envText = readFileSync(envExamplePath, 'utf8');
  for (const requiredKey of [
    'APPLE_SIGNING_IDENTITY=',
    'APPLE_KEYCHAIN_PROFILE=',
    'APPLE_KEYCHAIN_PATH=',
    'APPLE_API_KEY_PATH=',
    'APPLE_API_KEY_ID=',
    'APPLE_API_ISSUER=',
    'APPLE_TEAM_ID=',
    'APPLE_ID=',
    'APPLE_PASSWORD=',
    'WINDOWS_CERTIFICATE_THUMBPRINT=',
    'WINDOWS_TIMESTAMP_URL=https://timestamp.digicert.com',
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  APPROVED_CAPABILITY_PERMISSIONS,
  APPROVED_CONNECT_SOURCES,
  COMMUNITY_TLS_MODES,
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
import {
  buildPackagingPlan,
  runCli as runDesktopCli,
  stagePackagedWebAssets,
} from '../scripts/desktop-cli.mjs';

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

  let updaterSupported = false;

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
            return updaterSupported
              ? {
                  supported: true,
                  updateAvailable: true,
                  currentVersion: '0.1.0',
                  latestVersion: '0.1.1',
                  channel: 'stable',
                }
              : {
                  supported: false,
                  updateAvailable: false,
                  currentVersion: '0.1.0',
                  latestVersion: null,
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

  const unsupportedUpdateInfo = await client.checkForAppUpdates();
  assert.equal(unsupportedUpdateInfo.supported, false);
  assert.equal(unsupportedUpdateInfo.updateAvailable, false);
  assert.equal(unsupportedUpdateInfo.latestVersion, null);

  updaterSupported = true;
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
});

test('Self-Host Wizard deploy/community bridge enforces injection defenses, browser fallback, and Tauri IPC handoff', async () => {
  assert.deepEqual([...COMMUNITY_TLS_MODES], ['acme', 'internal', 'off']);

  // 1. Browser fallback outside Tauri normalizes inputs and rejects every injection vector.
  const webClient = createDesktopClient({
    organisationId: ORG_ID,
    globalObject: {},
  });

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
    __TAURI_INTERNALS__: {
      async invoke(cmd, args) {
        recordedCalls.push({ cmd, args });
        switch (cmd) {
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

  // 3. Valid end-to-end preflight -> prepare (0600 mode, 16 CSPRNG keys) -> deploy + health handoff.
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

  assert.equal(recordedCalls.length, 3);
  assert.equal(recordedCalls[0].cmd, 'self_host_preflight_community');
  assert.equal(recordedCalls[1].cmd, 'self_host_prepare_community');
  assert.equal(recordedCalls[2].cmd, 'self_host_deploy_community');

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

test('IPC_INIT_SCRIPT skips OIDC /realms/ origins, cancels pending invokes on pagehide, and desktop-cli stages web assets', async () => {
  const guiRust = readFileSync(join(tauriDir, 'src', 'gui.rs'), 'utf8');
  const scriptMatch = /const\s+IPC_INIT_SCRIPT\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#;/u.exec(guiRust);
  assert.notEqual(scriptMatch, null, 'gui.rs must define IPC_INIT_SCRIPT');
  const initScript = scriptMatch?.[1] ?? '';

  function createVmWindow(urlString) {
    const parsed = new URL(urlString);
    /** @type {Map<string, Array<() => void>>} */
    const listeners = new Map();
    /** @type {string[]} */
    const posted = [];
    const win = {
      location: {
        protocol: parsed.protocol,
        host: parsed.host,
        pathname: parsed.pathname,
      },
      ipc: {
        postMessage(msg) {
          posted.push(String(msg));
        },
      },
      addEventListener(type, handler) {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
      },
    };
    const context = vm.createContext({
      window: win,
      Object,
      Map,
      Promise,
      Error,
      TypeError,
      Number,
      String,
      Boolean,
      JSON,
    });
    vm.runInContext(initScript, context);
    return {
      win: /** @type {Record<string, any>} */ (win),
      posted,
      dispatchPageHide() {
        for (const fn of listeners.get('pagehide') ?? []) {
          fn();
        }
      },
    };
  }

  // 1. Identity-provider `/realms/` documents NEVER receive `window.__TAURI_INTERNALS__` or `window.koderaDesktop`.
  for (const untrustedOrRealmUrl of [
    'https://auth.kodera.io/realms/kodera-staff/protocol/openid-connect/auth',
    'https://staging-auth.kodera.io/realms/kodera-staff/protocol/openid-connect/auth',
    'https://community.kodera.io/realms/acme/protocol/openid-connect/auth',
    'https://evil.example/app',
  ]) {
    const { win } = createVmWindow(untrustedOrRealmUrl);
    assert.equal(
      win.__TAURI_INTERNALS__,
      undefined,
      `${untrustedOrRealmUrl} must not install __TAURI_INTERNALS__`,
    );
    assert.equal(
      win.koderaDesktop,
      undefined,
      `${untrustedOrRealmUrl} must not install koderaDesktop`,
    );
  }

  // 2. Admitted app origin installs the bridge and cancels pending invokes + clears callbacks on `pagehide`.
  const appDoc = createVmWindow('https://app.kodera.io/channels/general');
  assert.equal(typeof appDoc.win.__TAURI_INTERNALS__?.invoke, 'function');
  assert.equal(typeof appDoc.win.koderaDesktop?.onEvent, 'function');

  /** @type {string[]} */
  const deliveredEvents = [];
  appDoc.win.koderaDesktop.onEvent('kodera://deep-link', (ev) => {
    deliveredEvents.push(String(ev.payload));
  });
  const pendingInvoke = appDoc.win.koderaDesktop.invoke('get_app_metadata', {});
  assert.equal(appDoc.posted.length, 2);

  appDoc.dispatchPageHide();
  await assert.rejects(() => pendingInvoke, /navigation_cancelled/u);

  // Late native event dispatch after `pagehide` is inert because callbacks were cleared.
  appDoc.win.__KODERA_IPC_DISPATCH_EVENT__(1, 'kodera://workspace/acme/stale');
  assert.deepEqual(deliveredEvents, []);

  // 3. `stagePackagedWebAssets` stages built web bundle into exact `gui.rs` OS paths.
  const scratch = mkdtempSync(join(tmpdir(), 'kodera-cli-web-stage-'));
  try {
    const fakeDist = join(scratch, 'dist');
    mkdirSync(join(fakeDist, 'assets'), { recursive: true });
    writeFileSync(join(fakeDist, 'index.html'), '<!doctype html><title>Kodera</title>', 'utf8');
    writeFileSync(join(fakeDist, 'assets', 'index-hash.js'), 'export default 1;', 'utf8');

    for (const [target, expectedSuffix] of /** @type {const} */ ([
      ['macos', 'Contents/Resources/web'],
      ['linux', 'usr/share/kodera-desktop/web'],
      ['windows', 'web'],
    ])) {
      const plan = buildPackagingPlan(target, {});
      assert.equal(plan.webResourceStage.webResourceRelPath, expectedSuffix);
      assert.deepEqual(plan.webResourceStage.tauriBundleResources, { '../../web/dist/': 'web/' });

      const outRoot = join(scratch, `stage-${target}`);
      const staged = stagePackagedWebAssets(target, outRoot, fakeDist);
      assert.ok(staged.stagedWebDir.endsWith(expectedSuffix));
      assert.equal(existsSync(join(staged.stagedWebDir, 'index.html')), true);
      assert.equal(existsSync(join(staged.stagedWebDir, 'assets', 'index-hash.js')), true);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

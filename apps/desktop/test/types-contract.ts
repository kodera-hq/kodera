import {
  type CommunityDeployResult,
  type CommunityPreflightResult,
  type CommunityPrepareResult,
  type CommunityStackDirSelectionResult,
  type CommunityTlsModeSlug,
  type DesktopAppMetadata,
  type DesktopDeepLinkEvent,
  type DesktopUpdateStatus,
  type KoderaDesktopClient,
  type MediaCaptureStateResult,
  type PushToTalkStateEvent,
  type PushToTalkStateResult,
  type ScreenShareSurfaceSlug,
  type TrayMenuActionId,
  COMMUNITY_TLS_MODES,
  DESKTOP_APP_IDENTIFIER,
  MAX_MEDIA_DEVICE_ID_BYTES,
  SCREEN_SHARE_SURFACES,
  TRAY_MENU_ITEM_IDS,
  createDesktopClient,
  formatUnreadBadgeLabel,
  isTauriDesktopRuntime,
  validateClientDeepLinkUri,
} from '@kodera/desktop';

export async function verifyDesktopTypeContract(): Promise<void> {
  const id: 'io.kodera.desktop' = DESKTOP_APP_IDENTIFIER;
  const menuItems: readonly TrayMenuActionId[] = TRAY_MENU_ITEM_IDS;
  void id;
  void menuItems;

  const isNative: boolean = isTauriDesktopRuntime({});
  void isNative;

  const label: string | null = formatUnreadBadgeLabel(120);
  void label;

  const check = validateClientDeepLinkUri('kodera://workspace/kodera/general');
  if (check.ok) {
    const uri: string = check.canonicalUri;
    void uri;
  }

  const client: KoderaDesktopClient = createDesktopClient({
    organisationId: '019a5e62-6ca0-7303-8303-030303030303',
    globalObject: {},
  });

  const meta: DesktopAppMetadata = await client.getAppMetadata();
  const update: DesktopUpdateStatus = await client.checkForAppUpdates();
  void meta;
  void update;

  const stopDeepLink = await client.listenDeepLinks((ev: DesktopDeepLinkEvent) => {
    void ev.canonicalUri;
  });
  await stopDeepLink();

  await client.setUnreadCount(3);
  await client.updateTrayState({ unreadCount: 3, callState: 'voice', muted: false });
  await client.triggerTrayAction('toggle_mute');

  const surfaces: readonly ScreenShareSurfaceSlug[] = SCREEN_SHARE_SURFACES;
  const maxDeviceBytes: 128 = MAX_MEDIA_DEVICE_ID_BYTES;
  void surfaces;
  void maxDeviceBytes;

  const pttConfigured: PushToTalkStateResult = await client.configurePushToTalk({
    optIn: true,
    chord: 'Ctrl+Shift+Space',
  });
  const pttPressed: PushToTalkStateResult = await client.setPushToTalkPressed(true, 1000);
  const pttState: PushToTalkStateResult = await client.getPushToTalkState();
  const stopPttListen = await client.listenPushToTalk((ev: PushToTalkStateEvent) => {
    void ev.transmitting;
  });
  await stopPttListen();
  void pttConfigured;
  void pttPressed;
  void pttState;

  const mediaConfigured: MediaCaptureStateResult = await client.configureMediaCapture({
    preferredSurface: 'window',
    systemAudioLoopback: true,
    noiseSuppression: true,
    preferredAudioInputId: 'usb-mic-01',
    preferredAudioOutputId: 'headphones-01',
  });
  const mediaState: MediaCaptureStateResult = await client.getMediaCaptureState();
  void mediaConfigured;
  void mediaState;
  await client.sendNotification({
    title: 'Channel alert',
    body: 'New activity',
    routeUri: 'kodera://workspace/kodera/general',
    redactPreview: true,
  });
  await client.storeSecureCredential({
    secretKind: 'matrix-session',
    matrixUserId: '@alice:kodera.io',
    deviceId: 'MAC_01',
    issuedAtUnixSecs: 1_762_520_000,
    rawSecret: 'fixture_opaque_token_0123456789',
  });
  await client.loadSecureCredentialStatus('matrix-session', '@alice:kodera.io');
  await client.deleteSecureCredential('matrix-session', '@alice:kodera.io');
  await client.beginOidcPkceLoopback({
    issuerOrigin: 'https://auth.kodera.io/realms/kodera',
    clientId: 'kodera-desktop',
    codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
    state: 'pkce_state_fixture_0001',
    loopbackPort: 51_920,
  });
  await client.completeOidcPkceCallback(
    'http://127.0.0.1:51920/auth/callback?code=code_fixture_0001&state=pkce_state_fixture_0001&iss=https%3A%2F%2Fauth.kodera.io%2Frealms%2Fkodera',
  );
  await client.restoreWindowBounds();

  const tlsModes: readonly CommunityTlsModeSlug[] = COMMUNITY_TLS_MODES;
  void tlsModes;
  const selectedDir: CommunityStackDirSelectionResult = await client.selectCommunityStackDir();
  void selectedDir;
  const preflight: CommunityPreflightResult = await client.preflightCommunityDeploy({
    stackDir: '/srv/kodera/community',
    domain: 'chat.example.org',
    acmeEmail: 'ops@example.org',
    tlsMode: 'acme',
    httpPort: 80,
    httpsPort: 443,
  });
  const prepare: CommunityPrepareResult = await client.prepareCommunityDeploy({
    stackDir: '/srv/kodera/community',
    domain: 'chat.example.org',
    acmeEmail: 'ops@example.org',
    oidcProviderOrigin: 'https://id.example.org',
    tlsMode: 'acme',
    httpPort: 80,
    httpsPort: 443,
  });
  const deploy: CommunityDeployResult = await client.deployCommunityStack({
    stackDir: '/srv/kodera/community',
    timeoutMs: 60_000,
  });
  void preflight;
  void prepare;
  void deploy;
}

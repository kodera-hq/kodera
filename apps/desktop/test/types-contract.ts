import {
  type DesktopAppMetadata,
  type DesktopDeepLinkEvent,
  type DesktopUpdateStatus,
  type KoderaDesktopClient,
  type TrayMenuActionId,
  DESKTOP_APP_IDENTIFIER,
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
    issuerOrigin: 'https://auth.kodera.io',
    clientId: 'kodera-desktop',
    codeVerifier: 'pkce_verifier_fixture_alpha_bravo_charlie_delta_01',
    state: 'pkce_state_fixture_0001',
    loopbackPort: 51_920,
  });
  await client.completeOidcPkceCallback(
    'http://127.0.0.1:51920/auth/callback?code=code_fixture_0001&state=pkce_state_fixture_0001',
  );
  await client.restoreWindowBounds();
}

import type {
  DeepLinkScheme,
  KeychainSecretKindSlug,
  TrayMenuActionId,
} from './security-policy.mjs';

export declare const MAX_UNREAD_BADGE_COUNT: 99999;
export declare const MAX_DIRECT_BADGE_COUNT: 99;
export declare const REDACTED_NOTIFICATION_PREVIEW: 'New message in Kodera';
export declare const COMMUNITY_TLS_MODES: readonly ['acme', 'internal', 'off'];

export type CommunityTlsModeSlug = (typeof COMMUNITY_TLS_MODES)[number];

export declare function formatUnreadBadgeLabel(unreadCount: number): string | null;

export interface DesktopClientOptions {
  organisationId?: string | null;
  admittedDomains?: readonly string[];
  globalObject?: unknown;
}

export interface DesktopAppMetadata {
  identifier: string;
  productName: string;
  version: string;
  updateChannel: string;
  updateAvailable: boolean;
  isNativeDesktop: boolean;
  schemes: ['kodera', 'matrix'];
}

export interface DesktopUpdateStatus {
  supported: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: string;
}

export interface DesktopDeepLinkResult {
  admitted: boolean;
  nativeHandled: boolean;
  scheme: DeepLinkScheme;
  canonicalUri: string;
}

export interface DesktopDeepLinkEvent {
  scheme: DeepLinkScheme;
  canonicalUri: string;
}

export interface DesktopUnreadBadgeResult {
  applied: boolean;
  unreadCount: number;
  badgeLabel: string | null;
  visible: boolean;
}

export interface DesktopTrayUpdateInput {
  unreadCount?: number;
  callState?: 'none' | 'voice' | 'video';
  muted?: boolean;
  selfHostDegraded?: boolean;
}

export interface DesktopTrayStateResult {
  applied: boolean;
  unreadCount: number;
  unreadBadge: string | null;
  callState: 'none' | 'voice' | 'video';
  muted: boolean;
  selfHostDegraded: boolean;
}

export interface DesktopTrayActionResult {
  applied: boolean;
  action: TrayMenuActionId;
  muted?: boolean;
}

export interface DesktopNotificationInput {
  title: string;
  body: string;
  routeUri?: string | null;
  redactPreview?: boolean;
}

export interface DesktopNotificationResult {
  delivered: boolean;
  title: string;
  body: string;
  canonicalRouteUri: string | null;
  redacted: boolean;
}

export interface SecureCredentialStoreInput {
  secretKind: KeychainSecretKindSlug;
  matrixUserId: string;
  deviceId: string;
  issuedAtUnixSecs: number;
  expiresAtUnixSecs?: number | null;
  rawSecret: string;
}

export interface SecureCredentialMetadataResult {
  stored: boolean;
  nativeKeychain: boolean;
  serviceName: string;
}

export interface SecureCredentialStatusResult {
  present: boolean;
  nativeKeychain: boolean;
  serviceName: string;
}

export interface OidcPkceStartInput {
  issuerOrigin: string;
  clientId: string;
  codeVerifier: string;
  state: string;
  loopbackPort: number;
}

export interface OidcLoopbackStartResult {
  supported: boolean;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: 'S256';
}

export interface OidcPkceCompleteResult {
  supported: boolean;
  verified: boolean;
}

export interface WindowPlacementResult {
  applied: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  clamped: boolean;
}

export interface CommunityPreflightInput {
  stackDir: string;
  domain: string;
  acmeEmail: string;
  tlsMode?: CommunityTlsModeSlug;
  httpPort?: number;
  httpsPort?: number;
}

export interface CommunityPreflightResult {
  supported: boolean;
  dockerVersion: string | null;
  composeVersion: string | null;
  composeFilePresent: boolean;
  stackDirWritable: boolean;
  normalizedDomain: string;
  matrixBaseDomain: string;
  tlsMode: CommunityTlsModeSlug;
  httpPort: number;
  httpsPort: number;
}

export interface CommunityPrepareInput {
  stackDir: string;
  domain: string;
  acmeEmail: string;
  oidcProviderOrigin: string;
  tlsMode?: CommunityTlsModeSlug;
  httpPort?: number;
  httpsPort?: number;
}

export interface CommunityPrepareResult {
  supported: boolean;
  envFileWritten: boolean;
  unixFileMode: number;
  composeConfigValid: boolean;
  generatedSecretKeys: string[];
  normalizedDomain: string;
  matrixBaseDomain: string;
  oidcIssuer: string;
  tlsMode: CommunityTlsModeSlug;
  httpPort: number;
  httpsPort: number;
}

export interface CommunityDeployInput {
  stackDir: string;
  timeoutMs?: number;
}

export interface CommunityCoreServiceStatus {
  service: string;
  readiness: string;
  externalOidc: boolean;
}

export interface CommunityDeployResult {
  supported: boolean;
  stackHealthy: boolean;
  pollAttempts: number;
  state: string;
  observedMemoryMib: number;
  coreServices: CommunityCoreServiceStatus[];
}

export interface KoderaDesktopClient {
  isNativeDesktop(): boolean;
  getOrganisationId(): string | null;
  setOrganisationId(organisationId: string | null): void;
  getAppMetadata(): Promise<DesktopAppMetadata>;
  checkForAppUpdates(): Promise<DesktopUpdateStatus>;
  routeDeepLink(rawUri: string): Promise<DesktopDeepLinkResult>;
  listenDeepLinks(listener: (event: DesktopDeepLinkEvent) => void): Promise<() => Promise<void>>;
  setUnreadCount(unreadCount: number): Promise<DesktopUnreadBadgeResult>;
  updateTrayState(state: DesktopTrayUpdateInput): Promise<DesktopTrayStateResult>;
  triggerTrayAction(action: TrayMenuActionId): Promise<DesktopTrayActionResult>;
  listenTrayActions(listener: (action: TrayMenuActionId) => void): Promise<() => Promise<void>>;
  sendNotification(request: DesktopNotificationInput): Promise<DesktopNotificationResult>;
  storeSecureCredential(input: SecureCredentialStoreInput): Promise<SecureCredentialMetadataResult>;
  loadSecureCredentialStatus(
    secretKind: KeychainSecretKindSlug,
    matrixUserId: string,
  ): Promise<SecureCredentialStatusResult>;
  deleteSecureCredential(
    secretKind: KeychainSecretKindSlug,
    matrixUserId: string,
  ): Promise<SecureCredentialStatusResult>;
  beginOidcPkceLoopback(input: OidcPkceStartInput): Promise<OidcLoopbackStartResult>;
  completeOidcPkceCallback(callbackUri: string): Promise<OidcPkceCompleteResult>;
  restoreWindowBounds(savedStateJson?: string): Promise<WindowPlacementResult>;
  preflightCommunityDeploy(input: CommunityPreflightInput): Promise<CommunityPreflightResult>;
  prepareCommunityDeploy(input: CommunityPrepareInput): Promise<CommunityPrepareResult>;
  deployCommunityStack(input: CommunityDeployInput): Promise<CommunityDeployResult>;
}

export declare function createDesktopClient(options?: DesktopClientOptions): KoderaDesktopClient;

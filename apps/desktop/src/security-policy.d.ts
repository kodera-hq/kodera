export type DeepLinkScheme = 'kodera' | 'matrix';
export type TrayMenuActionId = 'open_kodera' | 'toggle_mute' | 'unread_indicator' | 'quit';
export type KeychainSecretKindSlug = 'matrix-session' | 'oidc-refresh' | 'mls-store-key';

export declare const DESKTOP_APP_IDENTIFIER: 'io.kodera.desktop';
export declare const DESKTOP_PRODUCT_NAME: 'Kodera';
export declare const DESKTOP_APP_VERSION: string;
export declare const APPROVED_DEEP_LINK_SCHEMES: readonly ['kodera', 'matrix'];
export declare const TRAY_MENU_ITEM_IDS: readonly [
  'open_kodera',
  'toggle_mute',
  'unread_indicator',
  'quit',
];
export declare const APPROVED_CAPABILITY_PERMISSIONS: readonly string[];
export declare const APPROVED_CONNECT_SOURCES: readonly string[];
export declare const REQUIRED_BUNDLE_ICONS: readonly string[];

export type ClientDeepLinkValidationResult =
  | { ok: true; scheme: DeepLinkScheme; canonicalUri: string }
  | { ok: false; error: string };

export declare function validateClientDeepLinkUri(
  rawUri: string,
  admittedDomains?: readonly string[],
): ClientDeepLinkValidationResult;

export declare function validateTauriSecurityInvariants(
  config: Record<string, unknown>,
  defaultCapability: Record<string, unknown> | null | undefined,
): void;

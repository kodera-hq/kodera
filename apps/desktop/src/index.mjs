export {
  isTauriDesktopRuntime,
  resolveTauriInternals,
} from './runtime.mjs';

export {
  APPROVED_CAPABILITY_PERMISSIONS,
  APPROVED_CONNECT_SOURCES,
  APPROVED_DEEP_LINK_SCHEMES,
  DESKTOP_APP_IDENTIFIER,
  DESKTOP_APP_VERSION,
  DESKTOP_PRODUCT_NAME,
  REQUIRED_BUNDLE_ICONS,
  TRAY_MENU_ITEM_IDS,
  validateClientDeepLinkUri,
  validateTauriSecurityInvariants,
} from './security-policy.mjs';

export {
  COMMUNITY_TLS_MODES,
  MAX_DIRECT_BADGE_COUNT,
  MAX_UNREAD_BADGE_COUNT,
  REDACTED_NOTIFICATION_PREVIEW,
  createDesktopClient,
  formatUnreadBadgeLabel,
} from './bridge.mjs';

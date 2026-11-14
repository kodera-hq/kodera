/**
 * Security invariants, CSP source allowlists, capability permissions, and client-side URI
 * preflight checks shared by `@kodera/desktop` and `scripts/verify-config.mjs`.
 */

export const DESKTOP_APP_IDENTIFIER = 'io.kodera.desktop';
export const DESKTOP_PRODUCT_NAME = 'Kodera';
export const DESKTOP_APP_VERSION = '0.1.0';

export const APPROVED_DEEP_LINK_SCHEMES = Object.freeze(['kodera', 'matrix']);

export const TRAY_MENU_ITEM_IDS = Object.freeze([
  'open_kodera',
  'toggle_mute',
  'unread_indicator',
  'quit',
]);

export const APPROVED_CAPABILITY_PERMISSIONS = Object.freeze([
  'core:default',
  'core:window:allow-show',
  'core:window:allow-hide',
  'core:window:allow-set-focus',
  'core:window:allow-unminimize',
  'deep-link:default',
]);

export const APPROVED_CONNECT_SOURCES = Object.freeze([
  "'self'",
  'https://api.kodera.io/api/v1/',
  'https://auth.kodera.io/realms/',
  'https://*.kodera.io/.well-known/matrix/client',
  'https://*.kodera.io/_matrix/',
  'https://*.kodera.io/_kodera/rooms/token',
  'wss://*.kodera.io/rtc',
  'wss://*.kodera.io/rtc/v1',
  'wss://*.kodera.io/rtc/validate',
  'wss://*.kodera.io/rtc/v1/validate',
  'wss://*.kodera.io/ws/collab/',
]);

export const REQUIRED_BUNDLE_ICONS = Object.freeze([
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.icns',
  'icons/icon.ico',
  'icons/icon.png',
]);

const OPEN_REDIRECT_KEYS = new Set([
  'redirect',
  'redirect_uri',
  'redirect_url',
  'next',
  'return_to',
  'returnto',
  'continue',
  'url',
  'target',
  'dest',
]);

const FORBIDDEN_SCHEMES = new Set([
  'javascript',
  'data',
  'file',
  'vbscript',
  'blob',
  'http',
  'https',
  'ws',
  'wss',
  'mailto',
  'tel',
]);

/**
 * Validates an incoming `kodera://` or `matrix:` deep link on the client side before forwarding
 * to the native host or browser router. Never echoes untrusted input in thrown/returned errors.
 *
 * @param {string} rawUri
 * @param {readonly string[]} [admittedDomains]
 * @returns {{ ok: true, scheme: 'kodera' | 'matrix', canonicalUri: string } | { ok: false, error: string }}
 */
export function validateClientDeepLinkUri(
  rawUri,
  admittedDomains = ['kodera.io', 'community.kodera.io', 'auth.kodera.io'],
) {
  if (typeof rawUri !== 'string' || rawUri.length === 0) {
    return { ok: false, error: 'empty_uri' };
  }
  if (rawUri.length > 512) {
    return { ok: false, error: 'payload_too_large' };
  }
  for (let i = 0; i < rawUri.length; i += 1) {
    const code = rawUri.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) {
      return { ok: false, error: 'control_character' };
    }
  }
  if (/%0[0-9a-f]|%1[0-9a-f]|%7f|%2f|%5c/iu.test(rawUri)) {
    return { ok: false, error: 'control_character' };
  }
  if (rawUri.includes('\\') || rawUri.includes('#')) {
    return { ok: false, error: 'malformed_uri' };
  }
  if (rawUri.includes('..')) {
    return { ok: false, error: 'path_traversal' };
  }
  const colonIdx = rawUri.indexOf(':');
  if (colonIdx <= 0) {
    return { ok: false, error: 'malformed_uri' };
  }
  const schemeRaw = rawUri.slice(0, colonIdx);
  const schemeLower = schemeRaw.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(schemeLower)) {
    return { ok: false, error: 'unsupported_scheme' };
  }
  if (schemeRaw !== 'kodera' && schemeRaw !== 'matrix') {
    return { ok: false, error: 'unsupported_scheme' };
  }
  if (rawUri.includes('@')) {
    return { ok: false, error: 'embedded_credentials' };
  }

  const domainSet = new Set(admittedDomains);
  const [withoutQuery, query = ''] = rawUri.split('?');
  if (rawUri.split('?').length > 2 || (rawUri.includes('?') && query.length === 0)) {
    return { ok: false, error: 'invalid_query' };
  }

  if (query.length > 0) {
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq === pair.length - 1) {
        return { ok: false, error: 'invalid_query' };
      }
      const key = pair.slice(0, eq);
      const val = pair.slice(eq + 1);
      if (OPEN_REDIRECT_KEYS.has(key.toLowerCase())) {
        return { ok: false, error: 'open_redirect_detected' };
      }
      if ((key === 'origin' || key === 'via') && !domainSet.has(val)) {
        return { ok: false, error: 'untrusted_origin' };
      }
    }
  }

  if (schemeRaw === 'kodera') {
    if (!withoutQuery.startsWith('kodera://')) {
      return { ok: false, error: 'malformed_uri' };
    }
    const rest = withoutQuery.slice('kodera://'.length);
    const segments = rest.split('/');
    if (segments.some((seg) => seg.length === 0)) {
      return { ok: false, error: 'malformed_uri' };
    }
    const route = segments[0];
    if (!['workspace', 'invite', 'call', 'auth'].includes(route) || segments.length < 2) {
      return { ok: false, error: 'untrusted_origin' };
    }
    return { ok: true, scheme: 'kodera', canonicalUri: rawUri };
  }

  if (withoutQuery.startsWith('matrix://')) {
    return { ok: false, error: 'malformed_uri' };
  }
  const opaque = withoutQuery.slice('matrix:'.length);
  const slashIdx = opaque.indexOf('/');
  const domainSep = opaque.lastIndexOf(':');
  if (slashIdx <= 0 || domainSep <= slashIdx + 1) {
    return { ok: false, error: 'malformed_uri' };
  }
  const kind = opaque.slice(0, slashIdx);
  if (!['r', 'roomid', 'u'].includes(kind)) {
    return { ok: false, error: 'malformed_uri' };
  }
  const domain = opaque.slice(domainSep + 1);
  if (!domainSet.has(domain)) {
    return { ok: false, error: 'untrusted_origin' };
  }
  return { ok: true, scheme: 'matrix', canonicalUri: rawUri };
}

/**
 * Validates Tauri v2 `tauri.conf.json` and `capabilities/default.json` security invariants.
 * Throws a descriptive `Error` when any least-privilege or CSP invariant is violated.
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any> | null | undefined} defaultCapability
 */
export function validateTauriSecurityInvariants(config, defaultCapability) {
  if (config?.identifier !== DESKTOP_APP_IDENTIFIER) {
    throw new Error('identifier must match the desktop app');
  }
  if (config?.productName !== DESKTOP_PRODUCT_NAME) {
    throw new Error('productName must be Kodera');
  }
  if (config?.build?.frontendDist !== '../../web/dist') {
    throw new Error('frontendDist must use the web bundle');
  }
  const tray = config?.app?.trayIcon;
  if (!tray || typeof tray !== 'object' || tray.id !== 'kodera-tray' || tray.iconPath !== 'icons/32x32.png') {
    throw new Error('trayIcon must configure kodera-tray with icons/32x32.png');
  }

  const csp = config?.app?.security?.csp;
  if (typeof csp !== 'string' || csp.trim().length === 0) {
    throw new Error('CSP must be present');
  }
  if (/unsafe-eval/iu.test(csp)) {
    throw new Error("CSP must forbid 'unsafe-eval'");
  }
  const directives = csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/u));

  const expectedSources = new Map([
    ['default-src', ["'self'"]],
    ['connect-src', [...APPROVED_CONNECT_SOURCES]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['media-src', ["'self'", 'blob:']],
    ['worker-src', ["'self'", 'blob:']],
    ['style-src', ["'self'"]],
    ['style-src-attr', ["'unsafe-inline'"]],
    ['font-src', ["'self'", 'data:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]);

  for (const [name, sources] of expectedSources) {
    const matches = directives.filter(([directive]) => directive === name);
    if (matches.length !== 1) {
      throw new Error(`${name} must be present exactly once`);
    }
    const actualSorted = matches[0].slice(1).sort();
    const expectedSorted = [...sources].sort();
    if (
      actualSorted.length !== expectedSorted.length
      || actualSorted.some((val, idx) => val !== expectedSorted[idx])
    ) {
      throw new Error(`${name} must use only approved sources`);
    }
  }
  if (directives.length !== expectedSources.size) {
    throw new Error('CSP must contain only approved directives');
  }

  if (
    config?.app?.security?.dangerousDisableAssetCspModification !== undefined
    && config.app.security.dangerousDisableAssetCspModification !== false
  ) {
    throw new Error('CSP asset modification must not be disabled');
  }
  const selectedCaps = config?.app?.security?.capabilities;
  if (!Array.isArray(selectedCaps) || selectedCaps.length !== 1 || selectedCaps[0] !== 'default') {
    throw new Error('default capability must be selected');
  }

  const plugins = config?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    throw new Error('plugins configuration must be present');
  }
  if (Object.keys(plugins).length !== 1 || !Object.hasOwn(plugins, 'deep-link')) {
    throw new Error('plugins must contain only the approved deep-link handler');
  }
  const deepLink = plugins['deep-link'];
  if (!deepLink || typeof deepLink !== 'object' || Array.isArray(deepLink)) {
    throw new Error('deep-link plugin configuration must be an object');
  }
  if (Object.keys(deepLink).length !== 1 || !Object.hasOwn(deepLink, 'desktop')) {
    throw new Error('deep-link configuration must scope to desktop only');
  }
  const desktopDeepLink = deepLink.desktop;
  if (!desktopDeepLink || typeof desktopDeepLink !== 'object' || Array.isArray(desktopDeepLink)) {
    throw new Error('deep-link desktop configuration must be an object');
  }
  if (Object.keys(desktopDeepLink).length !== 1 || !Object.hasOwn(desktopDeepLink, 'schemes')) {
    throw new Error('deep-link desktop configuration must contain only schemes');
  }
  const schemes = desktopDeepLink.schemes;
  if (!Array.isArray(schemes)) {
    throw new Error('deep-link schemes must be an array');
  }
  if (!schemes.every((scheme) => typeof scheme === 'string' && /^[a-z][a-z0-9+.-]*$/u.test(scheme))) {
    throw new Error('deep-link schemes must be canonical lowercase RFC 3986 scheme names');
  }
  if (new Set(schemes).size !== schemes.length) {
    throw new Error('deep-link schemes must not contain duplicates');
  }
  const sortedSchemes = [...schemes].sort();
  if (sortedSchemes.length !== 2 || sortedSchemes[0] !== 'kodera' || sortedSchemes[1] !== 'matrix') {
    throw new Error('deep-link schemes must register exactly kodera and matrix');
  }

  const icons = config?.bundle?.icon;
  if (
    !Array.isArray(icons)
    || icons.length !== REQUIRED_BUNDLE_ICONS.length
    || icons.some((icon, idx) => icon !== REQUIRED_BUNDLE_ICONS[idx])
  ) {
    throw new Error('all bundled icons must be selected');
  }

  if (!defaultCapability || typeof defaultCapability !== 'object') {
    throw new Error('default capability definition must be present');
  }
  if (defaultCapability.identifier !== 'default') {
    throw new Error('capability identifier must be default');
  }
  if (
    !Array.isArray(defaultCapability.windows)
    || defaultCapability.windows.length !== 1
    || defaultCapability.windows[0] !== 'main'
  ) {
    throw new Error('capability must bind only the main window');
  }
  if (!Array.isArray(defaultCapability.permissions)) {
    throw new Error('capability must remain least privilege');
  }
  const permsSorted = [...defaultCapability.permissions].sort();
  const approvedPermsSorted = [...APPROVED_CAPABILITY_PERMISSIONS].sort();
  if (
    new Set(defaultCapability.permissions).size !== defaultCapability.permissions.length
    || permsSorted.length !== approvedPermsSorted.length
    || permsSorted.some((perm, idx) => perm !== approvedPermsSorted[idx])
  ) {
    throw new Error('capability must remain least privilege');
  }
  if (defaultCapability.remote !== undefined) {
    throw new Error('capability must not grant remote origins');
  }
  if (defaultCapability.local !== undefined && defaultCapability.local !== true) {
    throw new Error('capability must remain local');
  }
  const capabilityKeys = new Set([
    '$schema',
    'identifier',
    'description',
    'windows',
    'permissions',
    'local',
  ]);
  if (Object.keys(defaultCapability).some((key) => !capabilityKeys.has(key))) {
    throw new Error('capability must contain only approved keys');
  }
}

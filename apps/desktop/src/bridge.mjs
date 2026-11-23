/**
 * Typed `@kodera/desktop` IPC client consumed by the Kodera web shell.
 *
 * When running inside the Tauri v2 WebView (`window.__TAURI_INTERNALS__`), commands dispatch over
 * native IPC bound to the active `organisationId`. Outside Tauri (ordinary browsers, SSR, tests),
 * every method validates inputs locally and executes a deterministic, side-effect-free no-op
 * fallback (never persisting secrets to Web Storage).
 */

import { resolveTauriInternals } from './runtime.mjs';
import {
  DESKTOP_APP_IDENTIFIER,
  DESKTOP_APP_VERSION,
  DESKTOP_PRODUCT_NAME,
  TRAY_MENU_ITEM_IDS,
  validateClientDeepLinkUri,
} from './security-policy.mjs';

export const MAX_UNREAD_BADGE_COUNT = 99_999;
export const MAX_DIRECT_BADGE_COUNT = 99;
export const REDACTED_NOTIFICATION_PREVIEW = 'New message in Kodera';
export const COMMUNITY_TLS_MODES = /** @type {const} */ (['acme', 'internal', 'off']);
export const SCREEN_SHARE_SURFACES = /** @type {const} */ (['monitor', 'window', 'browser_tab']);
export const MAX_MEDIA_DEVICE_ID_BYTES = 128;

const VALID_SECRET_KINDS = new Set(['matrix-session', 'oidc-refresh', 'mls-store-key']);
const VALID_CALL_STATES = new Set(['none', 'voice', 'video']);
const VALID_TRAY_ACTIONS = new Set(TRAY_MENU_ITEM_IDS);
const VALID_TLS_MODES = new Set(COMMUNITY_TLS_MODES);
const VALID_SCREEN_SHARE_SURFACES = new Set(SCREEN_SHARE_SURFACES);
const CANONICAL_MODIFIER_ORDER = /** @type {const} */ (['Ctrl', 'Alt', 'Shift', 'Super']);
const PRINTABLE_ASCII_DEVICE_ID_RE = /^[\u0020-\u007e]{1,128}$/u;
const ASCII_NON_SPACE_CHORD_RE = /^[\u0021-\u007e]{1,64}$/u;

const BIDI_OR_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNSAFE_INPUT_RE = /[\u0000-\u0020\u007f-\u009f;|&$`><*?()[\]{}!'"\\#~]/u;
const UNSAFE_STACK_DIR_RE = /[\u0000-\u001f\u007f-\u009f;|&$`><*?'"\r\n]/u;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/u;
const PARENT_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const SENSITIVE_STACK_ROOT_RE = /^(?:\/+$|[A-Za-z]:[\\/]+$|\/(?:tmp|var\/tmp|var\/folders|dev\/shm|private\/tmp|private\/var\/tmp|private\/var\/folders|private\/etc|private\/var\/root|private\/var\/run|private\/var\/db|var\/root|var\/run|var\/db|etc|usr|bin|sbin|lib|lib64|boot|proc|sys|dev|root|System|Library|Applications)(?:\/|$)|\/(?:Users|home)(?:\/[^/]+\/?|\/)?$|[A-Za-z]:[\\/]+(?:Windows|Temp|Program Files|Program Files \(x86\)|ProgramData)(?:[\\/]|$)|[A-Za-z]:[\\/]+Users(?:[\\/]+[^\\/]+[\\/]?|[\\/])?$)/iu;
const SENSITIVE_CREDENTIAL_SEG_RE = /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|Keychains)(?:[\\/]|$)/iu;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EMAIL_LOCAL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$/u;

/**
 * Formats an unread count into the Dock/Taskbar/Tray badge string (`null` for `0`, `"99+"` above `99`).
 *
 * @param {number} unreadCount
 * @returns {string | null}
 */
export function formatUnreadBadgeLabel(unreadCount) {
  if (!Number.isInteger(unreadCount) || unreadCount < 0 || unreadCount > MAX_UNREAD_BADGE_COUNT) {
    throw new RangeError('unread_count_out_of_range');
  }
  if (unreadCount === 0) {
    return null;
  }
  return unreadCount > MAX_DIRECT_BADGE_COUNT ? '99+' : String(unreadCount);
}

/**
 * Validates a canonical lowercase non-nil UUID organisation identifier.
 *
 * @param {string | null | undefined} organisationId
 * @returns {string}
 */
function requireOrganisationId(organisationId) {
  if (
    typeof organisationId !== 'string'
    || !UUID_RE.test(organisationId)
    || organisationId === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new TypeError('invalid_organisation');
  }
  return organisationId;
}

/**
 * @param {unknown} rawDir
 * @returns {string}
 */
function validateCommunityStackDir(rawDir) {
  if (
    typeof rawDir !== 'string'
    || rawDir.length === 0
    || rawDir.length > 512
    || rawDir.startsWith('//')
    || rawDir.startsWith('\\\\')
    || UNSAFE_STACK_DIR_RE.test(rawDir)
    || !ABSOLUTE_PATH_RE.test(rawDir)
    || PARENT_SEGMENT_RE.test(rawDir)
    || SENSITIVE_STACK_ROOT_RE.test(rawDir)
    || SENSITIVE_CREDENTIAL_SEG_RE.test(rawDir)
  ) {
    throw new RangeError('invalid_stack_dir');
  }
  return rawDir;
}

/**
 * @param {unknown} rawDomain
 * @returns {string}
 */
function validateCommunityDomain(rawDomain) {
  if (
    typeof rawDomain !== 'string'
    || rawDomain.length === 0
    || rawDomain.length > 253
    || UNSAFE_INPUT_RE.test(rawDomain)
    || rawDomain.includes('..')
  ) {
    throw new RangeError('invalid_domain');
  }
  const normalized = rawDomain.toLowerCase();
  if (normalized.startsWith('.') || normalized.endsWith('.')) {
    throw new RangeError('invalid_domain');
  }
  const labels = normalized.split('.');
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL_RE.test(label))) {
    throw new RangeError('invalid_domain');
  }
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || !/^[a-z]+$/u.test(tld)) {
    throw new RangeError('invalid_domain');
  }
  return normalized;
}

/**
 * @param {string} normalizedDomain
 * @returns {string}
 */
function deriveMatrixBaseDomain(normalizedDomain) {
  const labels = normalizedDomain.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : normalizedDomain;
}

/**
 * @param {unknown} rawEmail
 * @returns {string}
 */
function validateCommunityEmail(rawEmail) {
  if (
    typeof rawEmail !== 'string'
    || rawEmail.length === 0
    || rawEmail.length > 254
    || UNSAFE_INPUT_RE.test(rawEmail)
    || rawEmail.includes('..')
  ) {
    throw new RangeError('invalid_acme_email');
  }
  const parts = rawEmail.split('@');
  if (parts.length !== 2) {
    throw new RangeError('invalid_acme_email');
  }
  const [local, domain] = parts;
  if (!EMAIL_LOCAL_RE.test(local)) {
    throw new RangeError('invalid_acme_email');
  }
  let normalizedDomain;
  try {
    normalizedDomain = validateCommunityDomain(domain);
  } catch {
    throw new RangeError('invalid_acme_email');
  }
  return `${local}@${normalizedDomain}`;
}

/**
 * @param {unknown} rawOrigin
 * @returns {string}
 */
function validateCommunityOidcOrigin(rawOrigin) {
  if (
    typeof rawOrigin !== 'string'
    || rawOrigin.length === 0
    || rawOrigin.length > 256
    || UNSAFE_INPUT_RE.test(rawOrigin)
    || rawOrigin.includes('..')
    || !rawOrigin.startsWith('https://')
  ) {
    throw new RangeError('invalid_oidc_origin');
  }
  const rest = rawOrigin.slice('https://'.length);
  if (
    rest.length === 0
    || rest.includes('/')
    || rest.includes('?')
    || rest.includes('#')
    || rest.includes('@')
  ) {
    throw new RangeError('invalid_oidc_origin');
  }
  const colonIdx = rest.indexOf(':');
  let hostPart = rest;
  let portSuffix = '';
  if (colonIdx !== -1) {
    hostPart = rest.slice(0, colonIdx);
    const portStr = rest.slice(colonIdx + 1);
    if (!/^[0-9]{1,5}$/u.test(portStr)) {
      throw new RangeError('invalid_oidc_origin');
    }
    const portNum = Number(portStr);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new RangeError('invalid_oidc_origin');
    }
    if (portNum !== 443) {
      portSuffix = `:${portNum}`;
    }
  }
  let normalizedHost;
  try {
    normalizedHost = validateCommunityDomain(hostPart);
  } catch {
    throw new RangeError('invalid_oidc_origin');
  }
  return `https://${normalizedHost}${portSuffix}`;
}

/**
 * @param {unknown} httpPort
 * @param {unknown} httpsPort
 * @returns {{ httpPort: number, httpsPort: number }}
 */
function validateCommunityPorts(httpPort, httpsPort) {
  const http = httpPort ?? 80;
  const https = httpsPort ?? 443;
  if (
    typeof http !== 'number'
    || typeof https !== 'number'
    || !Number.isInteger(http)
    || !Number.isInteger(https)
    || http < 1
    || http > 65535
    || https < 1
    || https > 65535
    || http === https
  ) {
    throw new RangeError('invalid_port');
  }
  return { httpPort: http, httpsPort: https };
}

/**
 * @param {unknown} rawMode
 * @returns {'acme' | 'internal' | 'off'}
 */
function validateCommunityTlsMode(rawMode) {
  const mode = rawMode ?? 'acme';
  if (typeof mode !== 'string' || !VALID_TLS_MODES.has(/** @type {'acme' | 'internal' | 'off'} */ (mode))) {
    throw new RangeError('invalid_tls_mode');
  }
  return /** @type {'acme' | 'internal' | 'off'} */ (mode);
}

/**
 * @param {string} rawChord
 * @returns {{
 *   canonical: string,
 *   modifiers: Set<'Ctrl' | 'Alt' | 'Shift' | 'Super'>,
 *   triggerLabel: string,
 *   hasCommandModifier: boolean,
 * }}
 */
function parsePttChordSpec(rawChord) {
  if (typeof rawChord !== 'string' || !ASCII_NON_SPACE_CHORD_RE.test(rawChord)) {
    throw new RangeError('invalid_key_chord');
  }
  /** @type {Set<'Ctrl' | 'Alt' | 'Shift' | 'Super'>} */
  const modifiers = new Set();
  /** @type {{ label: string, requiresCommandMod: boolean } | null} */
  let trigger = null;

  for (const part of rawChord.split('+')) {
    if (part.length === 0) {
      throw new RangeError('invalid_key_chord');
    }
    const lower = part.toLowerCase();
    /** @type {'Ctrl' | 'Alt' | 'Shift' | 'Super' | null} */
    let mod = null;
    if (part === 'CommandOrControl' || lower === 'ctrl' || lower === 'control') {
      mod = 'Ctrl';
    } else if (lower === 'alt' || lower === 'option') {
      mod = 'Alt';
    } else if (lower === 'shift') {
      mod = 'Shift';
    } else if (lower === 'super' || lower === 'meta' || lower === 'cmd' || lower === 'command') {
      mod = 'Super';
    }
    if (mod !== null) {
      if (modifiers.has(mod)) {
        throw new RangeError('duplicate_modifier');
      }
      modifiers.add(mod);
      continue;
    }

    if (
      lower === 'enter'
      || lower === 'return'
      || lower === 'tab'
      || lower === 'backspace'
      || lower === 'delete'
      || lower === 'del'
      || lower === 'escape'
      || lower === 'esc'
    ) {
      throw new RangeError('reserved_system_chord');
    }

    /** @type {{ label: string, requiresCommandMod: boolean } | null} */
    let parsedTrigger = null;
    if (part.length === 1) {
      if (/^[A-Za-z]$/u.test(part)) {
        parsedTrigger = { label: part.toUpperCase(), requiresCommandMod: true };
      } else if (/^[0-9]$/u.test(part)) {
        parsedTrigger = { label: part, requiresCommandMod: true };
      } else {
        const punctMap = /** @type {Record<string, string>} */ ({
          '`': 'Backquote',
          '-': 'Minus',
          '=': 'Equal',
          '[': 'BracketLeft',
          ']': 'BracketRight',
          '\\': 'Backslash',
          ';': 'Semicolon',
          "'": 'Quote',
          ',': 'Comma',
          '.': 'Period',
          '/': 'Slash',
        });
        if (Object.hasOwn(punctMap, part)) {
          parsedTrigger = { label: punctMap[part], requiresCommandMod: true };
        }
      }
    } else if (/^[Ff][1-9][0-9]?$/u.test(part)) {
      const fnNum = Number(part.slice(1));
      if (fnNum >= 1 && fnNum <= 24) {
        parsedTrigger = { label: `F${fnNum}`, requiresCommandMod: fnNum < 13 };
      }
    } else {
      const namedMap = /** @type {Record<string, { label: string, requiresCommandMod: boolean }>} */ ({
        space: { label: 'Space', requiresCommandMod: true },
        backquote: { label: 'Backquote', requiresCommandMod: true },
        minus: { label: 'Minus', requiresCommandMod: true },
        equal: { label: 'Equal', requiresCommandMod: true },
        bracketleft: { label: 'BracketLeft', requiresCommandMod: true },
        bracketright: { label: 'BracketRight', requiresCommandMod: true },
        backslash: { label: 'Backslash', requiresCommandMod: true },
        semicolon: { label: 'Semicolon', requiresCommandMod: true },
        quote: { label: 'Quote', requiresCommandMod: true },
        comma: { label: 'Comma', requiresCommandMod: true },
        period: { label: 'Period', requiresCommandMod: true },
        slash: { label: 'Slash', requiresCommandMod: true },
        capslock: { label: 'CapsLock', requiresCommandMod: true },
        scrolllock: { label: 'ScrollLock', requiresCommandMod: false },
        pause: { label: 'Pause', requiresCommandMod: false },
        insert: { label: 'Insert', requiresCommandMod: true },
      });
      if (Object.hasOwn(namedMap, lower)) {
        parsedTrigger = namedMap[lower];
      }
    }

    if (parsedTrigger === null) {
      throw new RangeError('invalid_key_chord');
    }
    if (trigger !== null) {
      throw new RangeError('multiple_trigger_keys');
    }
    trigger = parsedTrigger;
  }

  if (trigger === null) {
    throw new RangeError('missing_trigger_key');
  }

  const hasCommandModifier = modifiers.has('Ctrl') || modifiers.has('Alt') || modifiers.has('Super');
  if (trigger.requiresCommandMod && !hasCommandModifier) {
    throw new RangeError('unsafe_typing_key_without_modifier');
  }

  const onlyMod = (/** @type {'Ctrl' | 'Alt' | 'Shift' | 'Super'} */ expected) =>
    modifiers.size === 1 && modifiers.has(expected);
  if (
    (trigger.label === 'F4' && onlyMod('Alt'))
    || (trigger.label === 'Q' && (onlyMod('Ctrl') || onlyMod('Super')))
    || (trigger.label === 'L' && onlyMod('Super'))
    || (trigger.label === 'W' && (onlyMod('Ctrl') || onlyMod('Super')))
  ) {
    throw new RangeError('reserved_system_chord');
  }

  const ordered = CANONICAL_MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return {
    canonical: [...ordered, trigger.label].join('+'),
    modifiers,
    triggerLabel: trigger.label,
    hasCommandModifier,
  };
}

/**
 * @param {string} rawChord
 * @returns {string}
 */
function validateAndCanonicalizePttChord(rawChord) {
  return parsePttChordSpec(rawChord).canonical;
}

/**
 * @param {string | null | undefined} rawChord
 */
function tryParsePttChordSpec(rawChord) {
  if (typeof rawChord !== 'string' || rawChord.length === 0) {
    return null;
  }
  try {
    return parsePttChordSpec(rawChord);
  } catch {
    return null;
  }
}

const DIRECT_PTT_EVENT_CODES = new Set([
  'Space',
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'CapsLock',
  'ScrollLock',
  'Pause',
  'Insert',
]);

/**
 * Maps a W3C DOM `KeyboardEvent` (`code` primary, `key` fallback) to a canonical PTT trigger label.
 *
 * @param {Record<string, unknown> | null | undefined} event
 * @returns {string | null}
 */
function resolveTriggerLabelFromKeyboardEvent(event) {
  const code = typeof event?.code === 'string' ? event.code : '';
  if (code.length > 0) {
    if (/^Key[A-Z]$/u.test(code)) {
      return code.slice(3);
    }
    if (/^Digit[0-9]$/u.test(code)) {
      return code.slice(5);
    }
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(code)) {
      return code;
    }
    if (DIRECT_PTT_EVENT_CODES.has(code)) {
      return code;
    }
    return null;
  }
  const key = typeof event?.key === 'string' ? event.key : '';
  if (key === ' ') {
    return 'Space';
  }
  if (key.length === 1 && /^[A-Za-z]$/u.test(key)) {
    return key.toUpperCase();
  }
  if (key.length === 1 && /^[0-9]$/u.test(key)) {
    return key;
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/iu.test(key)) {
    return key.toUpperCase();
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} event
 * @returns {'Ctrl' | 'Alt' | 'Shift' | 'Super' | null}
 */
function resolveModifierFromKeyboardEvent(event) {
  const code = typeof event?.code === 'string' ? event.code : '';
  const key = typeof event?.key === 'string' ? event.key : '';
  if (code === 'ControlLeft' || code === 'ControlRight' || key === 'Control') {
    return 'Ctrl';
  }
  if (code === 'AltLeft' || code === 'AltRight' || key === 'Alt') {
    return 'Alt';
  }
  if (code === 'ShiftLeft' || code === 'ShiftRight' || key === 'Shift') {
    return 'Shift';
  }
  if (
    code === 'MetaLeft'
    || code === 'MetaRight'
    || code === 'OSLeft'
    || code === 'OSRight'
    || key === 'Meta'
    || key === 'Super'
  ) {
    return 'Super';
  }
  return null;
}

/**
 * Returns `true` when `target` is an editable form control or `contenteditable` region.
 *
 * @param {unknown} target
 * @returns {boolean}
 */
function isEditableEventTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const elem = /** @type {Record<string, unknown>} */ (target);
  if (elem.isContentEditable === true) {
    return true;
  }
  if (typeof elem.contentEditable === 'string') {
    const mode = elem.contentEditable.toLowerCase();
    if (mode === 'true' || mode === '' || mode === 'plaintext-only') {
      return true;
    }
  }
  if (typeof elem.tagName === 'string') {
    const tag = elem.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }
  }
  if (typeof elem.closest === 'function') {
    try {
      const match = elem.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      );
      if (match) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} response
 * @param {boolean} supported
 */
function normalizePttStateResponse(response, supported) {
  const optInEnabled = response?.opt_in_enabled === true || response?.optInEnabled === true;
  const binding = typeof response?.binding === 'string' ? response.binding : null;
  const transmitting = response?.transmitting === true;
  const rawSince = response?.transmitting_since_ms ?? response?.transmittingSinceMs;
  const transmittingSinceMs =
    transmitting && typeof rawSince === 'number' && Number.isFinite(rawSince) ? rawSince : null;
  return {
    supported,
    optInEnabled,
    binding,
    transmitting,
    transmittingSinceMs,
  };
}

/**
 * @param {unknown} rawDeviceId
 * @param {string} errorCode
 * @returns {string | null}
 */
function validateOptionalMediaDeviceId(rawDeviceId, errorCode) {
  if (rawDeviceId === undefined || rawDeviceId === null) {
    return null;
  }
  if (
    typeof rawDeviceId !== 'string'
    || rawDeviceId.trim() !== rawDeviceId
    || !PRINTABLE_ASCII_DEVICE_ID_RE.test(rawDeviceId)
  ) {
    throw new RangeError(errorCode);
  }
  return rawDeviceId;
}

/**
 * Creates a typed Kodera Desktop IPC client with automatic Tauri v2 detection and safe browser
 * no-op fallback.
 *
 * @param {{
 *   organisationId?: string | null,
 *   admittedDomains?: readonly string[],
 *   globalObject?: unknown,
 * }} [options]
 */
export function createDesktopClient(options = {}) {
  let activeOrganisationId = options.organisationId ?? null;
  const admittedDomains = options.admittedDomains ?? [
    'kodera.io',
    'community.kodera.io',
    'auth.kodera.io',
  ];
  const globalObject = options.globalObject ?? globalThis;
  let nextCallbackId = 1;
  /** @type {ReturnType<typeof parsePttChordSpec> | null} */
  let activePttSpec = null;
  let activePttListenerCount = 0;
  let webviewPttPressed = false;
  let inFlightPttPressCount = 0;
  let pttSessionGeneration = 0;
  /** @type {(() => void) | null} */
  let detachWebviewPttResponders = null;

  function isTrustedNativeFrame(requireInternalAsset = false) {
    if (typeof globalObject !== 'object' || globalObject === null) {
      return false;
    }
    const globalRec = /** @type {Record<string, unknown>} */ (globalObject);
    const loc = globalRec.location;
    if (typeof loc !== 'object' || loc === null) {
      return (
        typeof process === 'object'
        && process !== null
        && Boolean(process.versions?.node)
        && process.env?.KODERA_DESKTOP_BRIDGE_NODE_TEST === '1'
      );
    }
    const protocol = /** @type {Record<string, unknown>} */ (loc).protocol;
    const hostname = /** @type {Record<string, unknown>} */ (loc).hostname;
    const port = /** @type {Record<string, unknown>} */ (loc).port;
    if (typeof protocol !== 'string' || typeof hostname !== 'string') {
      return false;
    }
    if (
      (protocol === 'kodera-asset:' && hostname === 'localhost')
      || (protocol === 'https:' && hostname === 'kodera-asset.localhost')
    ) {
      return true;
    }
    const devOriginEnabled = Boolean(/** @type {any} */ (import.meta)?.env?.DEV);
    if (
      devOriginEnabled
      && !requireInternalAsset
      && protocol === 'http:'
      && (hostname === 'localhost' || hostname === '127.0.0.1')
      && port === '5173'
    ) {
      return true;
    }
    return false;
  }

  function getInternals(requireInternalAsset = false) {
    if (!isTrustedNativeFrame(requireInternalAsset)) {
      return null;
    }
    return resolveTauriInternals(globalObject);
  }

  /**
   * Registers a Tauri v2 event listener when running inside the native WebView, or returns a
   * safe no-op cleanup function in web browsers.
   *
   * @param {string} eventName
   * @param {(payload: unknown) => void} handler
   * @returns {Promise<() => Promise<void>>}
   */
  async function listenNativeEvent(eventName, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('invalid_event_listener');
    }
    const internals = getInternals();
    if (!internals) {
      return async () => {};
    }
    const handlerId = typeof internals.transformCallback === 'function'
      ? internals.transformCallback(handler, false)
      : nextCallbackId++;
    const eventId = await internals.invoke('plugin:event|listen', {
      event: eventName,
      target: { kind: 'Any' },
      handler: handlerId,
    });
    let active = true;
    return async () => {
      if (!active) {
        return;
      }
      active = false;
      await internals.invoke('plugin:event|unlisten', {
        event: eventName,
        eventId,
      });
    };
  }

  /**
   * @param {string | null} orgId
   */
  function sendBestEffortPttReleaseForOrg(orgId) {
    if (!orgId) {
      return;
    }
    const internals = getInternals();
    if (!internals) {
      return;
    }
    try {
      Promise.resolve(
        internals.invoke('set_ptt_pressed', {
          organisation_id: orgId,
          pressed: false,
          now_ms: Date.now(),
        }),
      ).catch(() => {});
    } catch {
      // Best-effort release of previous or stale organisation PTT gate.
    }
  }

  /**
   * @param {boolean} pressed
   * @param {string | null} [targetOrgId]
   * @param {number} [expectedGeneration]
   */
  async function invokeWebviewResponderPttPressed(
    pressed,
    targetOrgId = activeOrganisationId,
    expectedGeneration = pttSessionGeneration,
  ) {
    const internals = getInternals();
    if (!internals || !targetOrgId) {
      if (expectedGeneration === pttSessionGeneration) {
        webviewPttPressed = false;
      }
      return;
    }
    let organisationId = null;
    try {
      organisationId = requireOrganisationId(targetOrgId);
    } catch {
      if (expectedGeneration === pttSessionGeneration) {
        webviewPttPressed = false;
      }
      return;
    }
    if (pressed && expectedGeneration === pttSessionGeneration) {
      inFlightPttPressCount += 1;
    }
    try {
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('set_ptt_pressed', {
          organisation_id: organisationId,
          pressed,
          now_ms: Date.now(),
        })
      );
      if (expectedGeneration !== pttSessionGeneration) {
        if (
          pressed
          && response?.ok !== false
          && (activeOrganisationId === null || activeOrganisationId === organisationId)
        ) {
          sendBestEffortPttReleaseForOrg(organisationId);
        }
        return;
      }
      if (response?.ok === false) {
        if (pressed) {
          webviewPttPressed = false;
        }
      } else if (typeof response?.transmitting === 'boolean') {
        webviewPttPressed = response.transmitting;
      }
    } catch {
      if (expectedGeneration === pttSessionGeneration && pressed) {
        webviewPttPressed = false;
      }
    } finally {
      if (pressed && expectedGeneration === pttSessionGeneration && inFlightPttPressCount > 0) {
        inFlightPttPressCount -= 1;
      }
    }
  }

  function releaseWebviewResponderPttUnconditionally() {
    if (!webviewPttPressed) {
      return;
    }
    webviewPttPressed = false;
    void invokeWebviewResponderPttPressed(false);
  }

  function syncWebviewPttResponders() {
    const shouldAttach =
      (activePttListenerCount > 0 || activePttSpec !== null)
      && activeOrganisationId !== null
      && getInternals() !== null
      && typeof globalObject === 'object'
      && globalObject !== null
      && typeof /** @type {Record<string, unknown>} */ (globalObject).addEventListener === 'function'
      && typeof /** @type {Record<string, unknown>} */ (globalObject).removeEventListener === 'function';

    if (!shouldAttach) {
      if (detachWebviewPttResponders) {
        const detach = detachWebviewPttResponders;
        detachWebviewPttResponders = null;
        detach();
      }
      return;
    }
    if (detachWebviewPttResponders) {
      return;
    }

    const winTarget = /** @type {{
      addEventListener: (type: string, fn: (ev: any) => void) => void,
      removeEventListener: (type: string, fn: (ev: any) => void) => void,
      document?: {
        visibilityState?: string,
        hidden?: boolean,
        hasFocus?: () => boolean,
        addEventListener?: (type: string, fn: (ev: any) => void) => void,
        removeEventListener?: (type: string, fn: (ev: any) => void) => void,
      } | null,
    }} */ (globalObject);
    const docTarget = winTarget.document && typeof winTarget.document === 'object'
      ? winTarget.document
      : null;

    /** @param {Record<string, unknown> | null | undefined} ev */
    const onKeyDown = (ev) => {
      if (!activePttSpec || !activeOrganisationId || ev?.repeat === true) {
        return;
      }
      if (docTarget?.visibilityState === 'hidden' || docTarget?.hidden === true) {
        return;
      }
      if (typeof docTarget?.hasFocus === 'function' && docTarget.hasFocus() === false) {
        return;
      }
      const triggerLabel = resolveTriggerLabelFromKeyboardEvent(ev);
      if (triggerLabel !== activePttSpec.triggerLabel) {
        return;
      }
      const exactModifiersMatch =
        Boolean(ev?.ctrlKey) === activePttSpec.modifiers.has('Ctrl')
        && Boolean(ev?.altKey) === activePttSpec.modifiers.has('Alt')
        && Boolean(ev?.shiftKey) === activePttSpec.modifiers.has('Shift')
        && Boolean(ev?.metaKey) === activePttSpec.modifiers.has('Super');
      if (!exactModifiersMatch) {
        return;
      }
      // Ignore editable targets unless an explicit command-modifier chord (`Ctrl`/`Alt`/`Super`) matched.
      if (isEditableEventTarget(ev?.target) && !activePttSpec.hasCommandModifier) {
        return;
      }
      if (typeof ev?.preventDefault === 'function') {
        ev.preventDefault();
      }
      if (!webviewPttPressed) {
        webviewPttPressed = true;
        void invokeWebviewResponderPttPressed(true);
      }
    };

    /** @param {Record<string, unknown> | null | undefined} ev */
    const onKeyUp = (ev) => {
      if (!webviewPttPressed) {
        return;
      }
      if (!activePttSpec) {
        releaseWebviewResponderPttUnconditionally();
        return;
      }
      const triggerLabel = resolveTriggerLabelFromKeyboardEvent(ev);
      const liftedMod = resolveModifierFromKeyboardEvent(ev);
      const requiredModifiersHeld =
        (!activePttSpec.modifiers.has('Ctrl') || (Boolean(ev?.ctrlKey) && liftedMod !== 'Ctrl'))
        && (!activePttSpec.modifiers.has('Alt') || (Boolean(ev?.altKey) && liftedMod !== 'Alt'))
        && (!activePttSpec.modifiers.has('Shift') || (Boolean(ev?.shiftKey) && liftedMod !== 'Shift'))
        && (!activePttSpec.modifiers.has('Super') || (Boolean(ev?.metaKey) && liftedMod !== 'Super'));
      if (triggerLabel === activePttSpec.triggerLabel || !requiredModifiersHeld) {
        releaseWebviewResponderPttUnconditionally();
      }
    };

    const onBlur = () => {
      releaseWebviewResponderPttUnconditionally();
    };

    const onVisibilityChange = () => {
      if (!docTarget || docTarget.visibilityState === 'hidden' || docTarget.hidden === true) {
        releaseWebviewResponderPttUnconditionally();
      }
    };

    winTarget.addEventListener('keydown', onKeyDown);
    winTarget.addEventListener('keyup', onKeyUp);
    winTarget.addEventListener('blur', onBlur);
    if (typeof docTarget?.addEventListener === 'function') {
      docTarget.addEventListener('visibilitychange', onVisibilityChange);
    } else {
      winTarget.addEventListener('visibilitychange', onVisibilityChange);
    }

    detachWebviewPttResponders = () => {
      winTarget.removeEventListener('keydown', onKeyDown);
      winTarget.removeEventListener('keyup', onKeyUp);
      winTarget.removeEventListener('blur', onBlur);
      if (typeof docTarget?.removeEventListener === 'function') {
        docTarget.removeEventListener('visibilitychange', onVisibilityChange);
      } else {
        winTarget.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }

  /**
   * @param {{ optInEnabled: boolean, binding: string | null, transmitting: boolean }} normalized
   */
  function applyNormalizedPttState(normalized) {
    activePttSpec = normalized.optInEnabled ? tryParsePttChordSpec(normalized.binding) : null;
    webviewPttPressed = normalized.transmitting;
    syncWebviewPttResponders();
  }

  return {
    isNativeDesktop() {
      return getInternals() !== null;
    },

    getOrganisationId() {
      return activeOrganisationId;
    },

    /**
     * @param {string | null} organisationId
     */
    setOrganisationId(organisationId) {
      const nextOrg = organisationId === null ? null : requireOrganisationId(organisationId);
      if (nextOrg === activeOrganisationId) {
        syncWebviewPttResponders();
        return;
      }
      const prevOrgId = activeOrganisationId;
      const shouldReleasePrevOrg = webviewPttPressed || inFlightPttPressCount > 0;
      pttSessionGeneration += 1;
      inFlightPttPressCount = 0;
      activePttSpec = null;
      webviewPttPressed = false;
      activeOrganisationId = nextOrg;
      syncWebviewPttResponders();
      if (shouldReleasePrevOrg && prevOrgId !== null) {
        sendBestEffortPttReleaseForOrg(prevOrgId);
      }
    },

    async getAppMetadata() {
      const internals = getInternals();
      if (!internals) {
        return {
          identifier: DESKTOP_APP_IDENTIFIER,
          productName: DESKTOP_PRODUCT_NAME,
          version: DESKTOP_APP_VERSION,
          updateChannel: 'web',
          updateAvailable: false,
          isNativeDesktop: false,
          schemes: /** @type {['kodera', 'matrix']} */ (['kodera', 'matrix']),
        };
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('get_app_metadata', {})
      );
      return {
        identifier: typeof response?.identifier === 'string' ? response.identifier : DESKTOP_APP_IDENTIFIER,
        productName: typeof response?.productName === 'string' ? response.productName : DESKTOP_PRODUCT_NAME,
        version: typeof response?.version === 'string' ? response.version : DESKTOP_APP_VERSION,
        updateChannel: typeof response?.updateChannel === 'string' ? response.updateChannel : 'stable',
        updateAvailable: Boolean(response?.updateAvailable),
        isNativeDesktop: true,
        schemes: /** @type {['kodera', 'matrix']} */ (['kodera', 'matrix']),
      };
    },

    async checkForAppUpdates() {
      const internals = getInternals();
      if (!internals) {
        return {
          supported: false,
          updateAvailable: false,
          updateReady: false,
          verified: false,
          currentVersion: DESKTOP_APP_VERSION,
          latestVersion: null,
          channel: 'web',
        };
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('check_app_updates', {})
      );
      return {
        supported: response?.supported === true,
        updateAvailable: response?.supported === true && response?.updateAvailable === true,
        updateReady: response?.supported === true && response?.verified === true && response?.updateReady === true,
        verified: response?.verified === true,
        currentVersion: typeof response?.currentVersion === 'string' ? response.currentVersion : DESKTOP_APP_VERSION,
        latestVersion: typeof response?.latestVersion === 'string' ? response.latestVersion : null,
        channel: typeof response?.channel === 'string' ? response.channel : 'stable',
      };
    },

    async restartToUpdate() {
      const internals = getInternals(true);
      if (!internals) throw new Error('update_not_ready');
      const response = /** @type {Record<string, unknown> | null} */ (await internals.invoke('restart_to_update', {}));
      if (response?.restarting !== true) throw new Error('update_not_ready');
      return { restarting: true };
    },

    /**
     * @param {string} rawUri
     */
    async routeDeepLink(rawUri) {
      const checked = validateClientDeepLinkUri(rawUri, admittedDomains);
      if (!checked.ok) {
        throw new Error(`deep_link_rejected:${checked.error}`);
      }
      const internals = getInternals();
      if (!internals) {
        return {
          admitted: true,
          nativeHandled: false,
          scheme: checked.scheme,
          canonicalUri: checked.canonicalUri,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('route_deep_link', {
          organisation_id: organisationId,
          raw_uri: rawUri,
        })
      );
      return {
        admitted: true,
        nativeHandled: true,
        scheme: checked.scheme,
        canonicalUri:
          typeof response?.canonical_uri === 'string' ? response.canonical_uri : checked.canonicalUri,
      };
    },

    /**
     * @param {(event: { scheme: 'kodera' | 'matrix', canonicalUri: string }) => void} listener
     */
    async listenDeepLinks(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('invalid_deep_link_listener');
      }
      return listenNativeEvent('kodera://deep-link', (eventPayload) => {
        const rawUri = typeof eventPayload === 'string'
          ? eventPayload
          : /** @type {Record<string, unknown> | null} */ (eventPayload)?.payload;
        if (typeof rawUri !== 'string') {
          return;
        }
        const checked = validateClientDeepLinkUri(rawUri, admittedDomains);
        if (checked.ok) {
          listener({
            scheme: checked.scheme,
            canonicalUri: checked.canonicalUri,
          });
        }
      });
    },

    /**
     * @param {number} unreadCount
     */
    async setUnreadCount(unreadCount) {
      const badgeLabel = formatUnreadBadgeLabel(unreadCount);
      const internals = getInternals();
      if (!internals) {
        return {
          applied: false,
          unreadCount,
          badgeLabel,
          visible: badgeLabel !== null,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      await internals.invoke('set_unread_badge', {
        organisation_id: organisationId,
        unread_count: unreadCount,
      });
      return {
        applied: true,
        unreadCount,
        badgeLabel,
        visible: badgeLabel !== null,
      };
    },

    /**
     * @param {{
     *   unreadCount?: number,
     *   callState?: 'none' | 'voice' | 'video',
     *   muted?: boolean,
     *   selfHostDegraded?: boolean,
     * }} state
     */
    async updateTrayState(state) {
      const unreadCount = state?.unreadCount ?? 0;
      const badgeLabel = formatUnreadBadgeLabel(unreadCount);
      /** @type {'none' | 'voice' | 'video'} */
      const callState = state?.callState ?? 'none';
      if (!VALID_CALL_STATES.has(callState)) {
        throw new RangeError('invalid_call_state');
      }
      const muted = Boolean(state?.muted);
      const selfHostDegraded = Boolean(state?.selfHostDegraded);
      const internals = getInternals();
      if (!internals) {
        return {
          applied: false,
          unreadCount,
          unreadBadge: badgeLabel,
          callState,
          muted,
          selfHostDegraded,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      await internals.invoke('update_tray_state', {
        organisation_id: organisationId,
        unread_count: unreadCount,
        call_state: callState,
        muted,
        self_host_degraded: selfHostDegraded,
      });
      return {
        applied: true,
        unreadCount,
        unreadBadge: badgeLabel,
        callState,
        muted,
        selfHostDegraded,
      };
    },

    /**
     * @param {'open_kodera' | 'toggle_mute' | 'unread_indicator' | 'quit'} action
     */
    async triggerTrayAction(action) {
      if (!VALID_TRAY_ACTIONS.has(action)) {
        throw new RangeError('invalid_tray_action');
      }
      const internals = getInternals();
      if (!internals) {
        return {
          applied: false,
          action,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('trigger_tray_menu_action', {
          organisation_id: organisationId,
          action,
        })
      );
      return {
        applied: true,
        action,
        muted: typeof response?.muted === 'boolean' ? response.muted : undefined,
      };
    },

    /**
     * @param {(action: 'open_kodera' | 'toggle_mute' | 'unread_indicator' | 'quit') => void} listener
     */
    async listenTrayActions(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('invalid_tray_listener');
      }
      return listenNativeEvent('kodera://tray-action', (eventPayload) => {
        const action = typeof eventPayload === 'string'
          ? eventPayload
          : /** @type {Record<string, unknown> | null} */ (eventPayload)?.payload;
        if (
          action === 'open_kodera'
          || action === 'toggle_mute'
          || action === 'unread_indicator'
          || action === 'quit'
        ) {
          listener(action);
        }
      });
    },

    /**
     * @param {{
     *   optIn: boolean,
     *   chord?: string | null,
     * }} input
     */
    async configurePushToTalk(input) {
      if (!input || typeof input !== 'object' || typeof input.optIn !== 'boolean') {
        throw new TypeError('invalid_ptt_input');
      }
      const hasChord = input.chord !== undefined && input.chord !== null;
      if (!input.optIn && hasChord) {
        throw new RangeError('ptt_not_opted_in');
      }
      const canonicalChord = hasChord
        ? validateAndCanonicalizePttChord(/** @type {string} */ (input.chord))
        : null;
      const internals = getInternals();
      if (!internals) {
        return {
          supported: false,
          optInEnabled: input.optIn,
          binding: canonicalChord,
          transmitting: false,
          transmittingSinceMs: null,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      /** @type {Record<string, unknown>} */
      const args = {
        organisation_id: organisationId,
        opt_in: input.optIn,
      };
      if (canonicalChord !== null) {
        args.chord = canonicalChord;
      }
      const callGen = pttSessionGeneration;
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('configure_ptt', args)
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'ptt_command_failed');
      }
      const normalized = typeof response?.opt_in_enabled === 'boolean'
        ? normalizePttStateResponse(response, true)
        : {
          supported: true,
          optInEnabled: input.optIn,
          binding: canonicalChord,
          transmitting: false,
          transmittingSinceMs: null,
        };
      if (callGen === pttSessionGeneration) {
        applyNormalizedPttState(normalized);
      }
      return normalized;
    },

    /**
     * @param {boolean} pressed
     * @param {number} [nowMs]
     */
    async setPushToTalkPressed(pressed, nowMs = Date.now()) {
      if (typeof pressed !== 'boolean') {
        throw new TypeError('invalid_ptt_pressed');
      }
      if (!Number.isInteger(nowMs) || nowMs < 0) {
        throw new RangeError('invalid_ptt_timestamp');
      }
      const internals = getInternals();
      if (!internals) {
        return {
          supported: false,
          optInEnabled: false,
          binding: null,
          transmitting: false,
          transmittingSinceMs: null,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const callGen = pttSessionGeneration;
      if (pressed) {
        inFlightPttPressCount += 1;
      }
      /** @type {Record<string, unknown> | null} */
      let response = null;
      try {
        response = /** @type {Record<string, unknown> | null} */ (
          await internals.invoke('set_ptt_pressed', {
            organisation_id: organisationId,
            pressed,
            now_ms: nowMs,
          })
        );
      } finally {
        if (pressed && callGen === pttSessionGeneration && inFlightPttPressCount > 0) {
          inFlightPttPressCount -= 1;
        }
      }
      if (callGen !== pttSessionGeneration) {
        if (
          pressed
          && response?.ok !== false
          && (activeOrganisationId === null || activeOrganisationId === organisationId)
        ) {
          sendBestEffortPttReleaseForOrg(organisationId);
        }
      }
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'ptt_command_failed');
      }
      const normalized = typeof response?.opt_in_enabled === 'boolean'
        ? normalizePttStateResponse(response, true)
        : {
          supported: true,
          optInEnabled: true,
          binding: activePttSpec?.canonical ?? null,
          transmitting: pressed,
          transmittingSinceMs: pressed ? nowMs : null,
        };
      if (callGen === pttSessionGeneration) {
        applyNormalizedPttState(normalized);
      }
      return normalized;
    },

    async getPushToTalkState() {
      const internals = getInternals();
      if (!internals) {
        return {
          supported: false,
          optInEnabled: false,
          binding: null,
          transmitting: false,
          transmittingSinceMs: null,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const callGen = pttSessionGeneration;
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('get_ptt_state', {
          organisation_id: organisationId,
        })
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'ptt_command_failed');
      }
      const normalized = normalizePttStateResponse(response, true);
      if (callGen === pttSessionGeneration) {
        applyNormalizedPttState(normalized);
      }
      return normalized;
    },

    /**
     * @param {(event: {
     *   optInEnabled: boolean,
     *   binding: string | null,
     *   transmitting: boolean,
     *   transmittingSinceMs: number | null,
     * }) => void} listener
     */
    async listenPushToTalk(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('invalid_ptt_listener');
      }
      const unlistenNative = await listenNativeEvent('kodera://ptt-state', (eventPayload) => {
        const inner =
          eventPayload && typeof eventPayload === 'object' && 'payload' in eventPayload
            ? /** @type {Record<string, unknown>} */ (eventPayload).payload
            : eventPayload;
        /** @type {Record<string, unknown> | null} */
        let parsed = null;
        if (typeof inner === 'string') {
          try {
            const candidate = JSON.parse(inner);
            if (candidate && typeof candidate === 'object') {
              parsed = /** @type {Record<string, unknown>} */ (candidate);
            }
          } catch {
            return;
          }
        } else if (inner && typeof inner === 'object') {
          parsed = /** @type {Record<string, unknown>} */ (inner);
        }
        if (!parsed) {
          return;
        }
        const normalized = normalizePttStateResponse(parsed, true);
        if (activeOrganisationId !== null) {
          applyNormalizedPttState(normalized);
        }
        listener({
          optInEnabled: normalized.optInEnabled,
          binding: normalized.binding,
          transmitting: normalized.transmitting,
          transmittingSinceMs: normalized.transmittingSinceMs,
        });
      });
      activePttListenerCount += 1;
      syncWebviewPttResponders();
      let listening = true;
      return async () => {
        if (!listening) {
          return;
        }
        listening = false;
        activePttListenerCount = Math.max(0, activePttListenerCount - 1);
        if (activePttListenerCount === 0) {
          releaseWebviewResponderPttUnconditionally();
        }
        syncWebviewPttResponders();
        await unlistenNative();
      };
    },

    /**
     * @param {{
     *   preferredSurface?: 'monitor' | 'window' | 'browser_tab',
     *   systemAudioLoopback?: boolean,
     *   noiseSuppression?: boolean,
     *   preferredAudioInputId?: string | null,
     *   preferredAudioOutputId?: string | null,
     * }} input
     */
    async configureMediaCapture(input) {
      if (!input || typeof input !== 'object') {
        throw new TypeError('invalid_media_capture_input');
      }
      const rawSurface = input.preferredSurface ?? 'monitor';
      if (
        typeof rawSurface !== 'string'
        || !VALID_SCREEN_SHARE_SURFACES.has(
          /** @type {'monitor' | 'window' | 'browser_tab'} */ (rawSurface),
        )
      ) {
        throw new RangeError('invalid_screen_share_surface');
      }
      const preferredSurface = /** @type {'monitor' | 'window' | 'browser_tab'} */ (rawSurface);
      const systemAudioLoopback = input.systemAudioLoopback ?? false;
      if (typeof systemAudioLoopback !== 'boolean') {
        throw new TypeError('invalid_system_audio_loopback');
      }
      const noiseSuppression = input.noiseSuppression ?? true;
      if (typeof noiseSuppression !== 'boolean') {
        throw new TypeError('invalid_noise_suppression');
      }
      const preferredAudioInputId = validateOptionalMediaDeviceId(
        input.preferredAudioInputId,
        'invalid_audio_input_device_id',
      );
      const preferredAudioOutputId = validateOptionalMediaDeviceId(
        input.preferredAudioOutputId,
        'invalid_audio_output_device_id',
      );

      const internals = getInternals();
      if (!internals) {
        return {
          supported: false,
          preferredSurface,
          systemAudioLoopback,
          noiseSuppression,
          preferredAudioInputId,
          preferredAudioOutputId,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      /** @type {Record<string, unknown>} */
      const args = {
        organisation_id: organisationId,
        preferred_surface: preferredSurface,
        system_audio_loopback: systemAudioLoopback,
        noise_suppression: noiseSuppression,
      };
      if (preferredAudioInputId !== null) {
        args.preferred_audio_input_id = preferredAudioInputId;
      }
      if (preferredAudioOutputId !== null) {
        args.preferred_audio_output_id = preferredAudioOutputId;
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('configure_media_capture', args)
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'media_capture_failed');
      }
      const respSurface = response?.preferred_surface;
      const effectiveSurface =
        typeof respSurface === 'string'
        && VALID_SCREEN_SHARE_SURFACES.has(
          /** @type {'monitor' | 'window' | 'browser_tab'} */ (respSurface),
        )
          ? /** @type {'monitor' | 'window' | 'browser_tab'} */ (respSurface)
          : preferredSurface;
      return {
        supported: true,
        preferredSurface: effectiveSurface,
        systemAudioLoopback:
          typeof response?.system_audio_loopback === 'boolean'
            ? response.system_audio_loopback
            : systemAudioLoopback,
        noiseSuppression:
          typeof response?.noise_suppression === 'boolean'
            ? response.noise_suppression
            : noiseSuppression,
        preferredAudioInputId:
          typeof response?.preferred_audio_input_id === 'string'
            ? response.preferred_audio_input_id
            : preferredAudioInputId,
        preferredAudioOutputId:
          typeof response?.preferred_audio_output_id === 'string'
            ? response.preferred_audio_output_id
            : preferredAudioOutputId,
      };
    },

    async getMediaCaptureState() {
      const internals = getInternals();
      if (!internals) {
        return {
          supported: false,
          preferredSurface: /** @type {'monitor' | 'window' | 'browser_tab'} */ ('monitor'),
          systemAudioLoopback: false,
          noiseSuppression: true,
          preferredAudioInputId: null,
          preferredAudioOutputId: null,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('get_media_capture_state', {
          organisation_id: organisationId,
        })
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'media_capture_failed');
      }
      const respSurface = response?.preferred_surface;
      const preferredSurface =
        typeof respSurface === 'string'
        && VALID_SCREEN_SHARE_SURFACES.has(
          /** @type {'monitor' | 'window' | 'browser_tab'} */ (respSurface),
        )
          ? /** @type {'monitor' | 'window' | 'browser_tab'} */ (respSurface)
          : /** @type {'monitor' | 'window' | 'browser_tab'} */ ('monitor');
      return {
        supported: true,
        preferredSurface,
        systemAudioLoopback: Boolean(response?.system_audio_loopback),
        noiseSuppression:
          typeof response?.noise_suppression === 'boolean' ? response.noise_suppression : true,
        preferredAudioInputId:
          typeof response?.preferred_audio_input_id === 'string'
            ? response.preferred_audio_input_id
            : null,
        preferredAudioOutputId:
          typeof response?.preferred_audio_output_id === 'string'
            ? response.preferred_audio_output_id
            : null,
      };
    },

    /**
     * @param {{
     *   title: string,
     *   body: string,
     *   routeUri?: string | null,
     *   redactPreview?: boolean,
     * }} request
     */
    async sendNotification(request) {
      const titleRaw = request?.title;
      const bodyRaw = request?.body;
      if (typeof titleRaw !== 'string' || typeof bodyRaw !== 'string') {
        throw new TypeError('invalid_notification_payload');
      }
      if (BIDI_OR_CONTROL_RE.test(titleRaw) || BIDI_OR_CONTROL_RE.test(bodyRaw)) {
        throw new RangeError('forbidden_notification_characters');
      }
      const title = titleRaw.trim();
      const body = bodyRaw.trim();
      if (title.length === 0 || title.length > 120 || body.length === 0 || body.length > 512) {
        throw new RangeError('notification_bounds_exceeded');
      }
      let canonicalRouteUri = null;
      if (request?.routeUri !== undefined && request.routeUri !== null) {
        const checked = validateClientDeepLinkUri(request.routeUri, admittedDomains);
        if (!checked.ok) {
          throw new Error(`invalid_notification_route:${checked.error}`);
        }
        canonicalRouteUri = checked.canonicalUri;
      }
      const redactPreview = Boolean(request?.redactPreview);
      const effectiveBody = redactPreview ? REDACTED_NOTIFICATION_PREVIEW : body;
      const internals = getInternals();
      if (!internals) {
        return {
          delivered: false,
          title,
          body: effectiveBody,
          canonicalRouteUri,
          redacted: redactPreview,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      /** @type {Record<string, unknown>} */
      const payload = {
        organisation_id: organisationId,
        title,
        body,
        redact_preview: redactPreview,
      };
      if (canonicalRouteUri !== null) {
        payload.route_uri = canonicalRouteUri;
      }
      await internals.invoke('dispatch_notification', payload);
      return {
        delivered: true,
        title,
        body: effectiveBody,
        canonicalRouteUri,
        redacted: redactPreview,
      };
    },

    /**
     * @param {{
     *   secretKind: 'matrix-session' | 'oidc-refresh' | 'mls-store-key',
     *   matrixUserId: string,
     *   deviceId: string,
     *   issuedAtUnixSecs: number,
     *   expiresAtUnixSecs?: number | null,
     *   rawSecret: string,
     * }} input
     */
    async storeSecureCredential(input) {
      if (!input || typeof input !== 'object') {
        throw new TypeError('invalid_credential_input');
      }
      if (!VALID_SECRET_KINDS.has(input.secretKind)) {
        throw new RangeError('invalid_secret_kind');
      }
      if (typeof input.rawSecret !== 'string' || input.rawSecret.trim().length < 16) {
        throw new RangeError('secret_too_short');
      }
      if (
        typeof input.matrixUserId !== 'string'
        || !input.matrixUserId.startsWith('@')
        || !input.matrixUserId.includes(':')
      ) {
        throw new RangeError('invalid_matrix_user_id');
      }
      if (typeof input.deviceId !== 'string' || input.deviceId.length === 0) {
        throw new RangeError('invalid_device_id');
      }
      if (input.deviceId.toLowerCase().includes(input.rawSecret.trim().toLowerCase())) {
        throw new RangeError('secret_leaked_in_metadata');
      }
      const internals = getInternals(true);
      if (!internals) {
        // Security invariant: never fall back to localStorage/sessionStorage for keychain secrets.
        return {
          stored: false,
          nativeKeychain: false,
          ephemeralProcessVault: false,
          serviceName: `io.kodera.desktop.${input.secretKind}`,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      /** @type {Record<string, unknown>} */
      const args = {
        organisation_id: organisationId,
        secret_kind: input.secretKind,
        matrix_user_id: input.matrixUserId,
        device_id: input.deviceId,
        issued_at_unix_secs: input.issuedAtUnixSecs,
        raw_secret: input.rawSecret,
      };
      if (input.expiresAtUnixSecs !== undefined && input.expiresAtUnixSecs !== null) {
        args.expires_at_unix_secs = input.expiresAtUnixSecs;
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('store_keychain_credential', args)
      );
      const persistedToOsKeychain = response?.native_keychain === true;
      return {
        stored: true,
        nativeKeychain: persistedToOsKeychain,
        ephemeralProcessVault: !persistedToOsKeychain,
        serviceName:
          typeof response?.service_name === 'string'
            ? response.service_name
            : `io.kodera.desktop.${input.secretKind}`,
      };
    },

    /**
     * @param {'matrix-session' | 'oidc-refresh' | 'mls-store-key'} secretKind
     * @param {string} matrixUserId
     */
    async loadSecureCredentialStatus(secretKind, matrixUserId) {
      if (!VALID_SECRET_KINDS.has(secretKind)) {
        throw new RangeError('invalid_secret_kind');
      }
      const internals = getInternals(true);
      if (!internals) {
        return {
          present: false,
          nativeKeychain: false,
          ephemeralProcessVault: false,
          serviceName: `io.kodera.desktop.${secretKind}`,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('load_keychain_credential', {
          organisation_id: organisationId,
          secret_kind: secretKind,
          matrix_user_id: matrixUserId,
        })
      );
      const present = Boolean(response?.present);
      const persistedToOsKeychain = present && response?.native_keychain === true;
      return {
        present,
        nativeKeychain: persistedToOsKeychain,
        ephemeralProcessVault: present && !persistedToOsKeychain,
        serviceName:
          typeof response?.service_name === 'string'
            ? response.service_name
            : `io.kodera.desktop.${secretKind}`,
      };
    },

    /**
     * @param {'matrix-session' | 'oidc-refresh' | 'mls-store-key'} secretKind
     * @param {string} matrixUserId
     */
    async deleteSecureCredential(secretKind, matrixUserId) {
      if (!VALID_SECRET_KINDS.has(secretKind)) {
        throw new RangeError('invalid_secret_kind');
      }
      const internals = getInternals(true);
      if (!internals) {
        return {
          present: false,
          nativeKeychain: false,
          ephemeralProcessVault: false,
          serviceName: `io.kodera.desktop.${secretKind}`,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('delete_keychain_credential', {
          organisation_id: organisationId,
          secret_kind: secretKind,
          matrix_user_id: matrixUserId,
        })
      );
      const present = Boolean(response?.present);
      const persistedToOsKeychain = present && response?.native_keychain === true;
      return {
        present,
        nativeKeychain: persistedToOsKeychain,
        ephemeralProcessVault: present && !persistedToOsKeychain,
        serviceName:
          typeof response?.service_name === 'string'
            ? response.service_name
            : `io.kodera.desktop.${secretKind}`,
      };
    },

    /**
     * @param {{
     *   issuerOrigin: string,
     *   clientId: string,
     *   codeVerifier: string,
     *   state: string,
     *   loopbackPort: number,
     * }} input
     */
    async beginOidcPkceLoopback(input) {
      if (
        !input
        || typeof input.issuerOrigin !== 'string'
        || !/^https:\/\/[^/?#@\s:]+\/realms\/[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/u.test(input.issuerOrigin)
      ) {
        throw new RangeError('invalid_issuer_origin');
      }
      if (typeof input.codeVerifier !== 'string' || input.codeVerifier.length < 43 || input.codeVerifier.length > 128) {
        throw new RangeError('invalid_code_verifier');
      }
      if (typeof input.state !== 'string' || input.state.length < 16 || input.state.length > 128) {
        throw new RangeError('invalid_state');
      }
      if (!Number.isInteger(input.loopbackPort) || input.loopbackPort < 1024 || input.loopbackPort > 65535) {
        throw new RangeError('invalid_loopback_port');
      }
      const internals = getInternals(true);
      if (!internals) {
        return {
          supported: false,
          redirectUri: null,
          codeChallenge: null,
          codeChallengeMethod: /** @type {'S256'} */ ('S256'),
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('begin_oidc_pkce_loopback', {
          organisation_id: organisationId,
          issuer_origin: input.issuerOrigin,
          client_id: input.clientId,
          code_verifier: input.codeVerifier,
          state: input.state,
          loopback_port: input.loopbackPort,
        })
      );
      return {
        supported: true,
        redirectUri:
          typeof response?.redirect_uri === 'string'
            ? response.redirect_uri
            : `http://127.0.0.1:${input.loopbackPort}/auth/callback`,
        codeChallenge: typeof response?.code_challenge === 'string' ? response.code_challenge : null,
        codeChallengeMethod: /** @type {'S256'} */ ('S256'),
      };
    },

    /**
     * @param {string} callbackUri
     */
    async completeOidcPkceCallback(callbackUri) {
      if (typeof callbackUri !== 'string' || callbackUri.length === 0) {
        throw new RangeError('callback_malformed');
      }
      if (/^(?:javascript|data|file|vbscript):/iu.test(callbackUri)) {
        throw new RangeError('unsupported_scheme');
      }
      if (!callbackUri.startsWith('http://127.0.0.1:') && !callbackUri.startsWith('kodera://auth/callback?')) {
        throw new RangeError('untrusted_callback_uri');
      }
      const internals = getInternals(true);
      if (!internals) {
        return {
          supported: false,
          verified: false,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      await internals.invoke('complete_oidc_pkce_callback', {
        organisation_id: organisationId,
        callback_uri: callbackUri,
      });
      return {
        supported: true,
        verified: true,
      };
    },

    /**
     * @param {string} [savedStateJson]
     */
    async restoreWindowBounds(savedStateJson) {
      const internals = getInternals();
      if (!internals) {
        return {
          applied: false,
          x: 0,
          y: 0,
          width: 1280,
          height: 820,
          clamped: false,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      /** @type {Record<string, unknown>} */
      const args = { organisation_id: organisationId };
      if (typeof savedStateJson === 'string') {
        args.saved_state_json = savedStateJson;
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('restore_window_bounds', args)
      );
      return {
        applied: true,
        x: typeof response?.x === 'number' ? response.x : 0,
        y: typeof response?.y === 'number' ? response.y : 0,
        width: typeof response?.width === 'number' ? response.width : 1280,
        height: typeof response?.height === 'number' ? response.height : 820,
        clamped: Boolean(response?.clamped),
      };
    },

    async selectCommunityStackDir() {
      const internals = getInternals(true);
      if (!internals) {
        return {
          supported: false,
          selected: false,
          stackDir: null,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('select_community_stack_dir', {
          organisation_id: organisationId,
        })
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'community_deploy_failed');
      }
      const selected = Boolean(response?.selected);
      const stackDir = selected && typeof response?.stack_dir === 'string' ? response.stack_dir : null;
      return {
        supported: true,
        selected: stackDir !== null,
        stackDir,
      };
    },

    /**
     * @param {{
     *   stackDir: string,
     *   domain: string,
     *   acmeEmail: string,
     *   tlsMode?: 'acme' | 'internal' | 'off',
     *   httpPort?: number,
     *   httpsPort?: number,
     * }} input
     */
    async preflightCommunityDeploy(input) {
      if (!input || typeof input !== 'object') {
        throw new TypeError('invalid_preflight_input');
      }
      const stackDir = validateCommunityStackDir(input.stackDir);
      const normalizedDomain = validateCommunityDomain(input.domain);
      const acmeEmail = validateCommunityEmail(input.acmeEmail);
      const tlsMode = validateCommunityTlsMode(input.tlsMode);
      const { httpPort, httpsPort } = validateCommunityPorts(input.httpPort, input.httpsPort);
      const matrixBaseDomain = deriveMatrixBaseDomain(normalizedDomain);

      const internals = getInternals(true);
      if (!internals) {
        return {
          supported: false,
          dockerVersion: null,
          composeVersion: null,
          composeFilePresent: false,
          stackDirWritable: false,
          normalizedDomain,
          matrixBaseDomain,
          tlsMode,
          httpPort,
          httpsPort,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('self_host_preflight_community', {
          organisation_id: organisationId,
          stack_dir: stackDir,
          domain: normalizedDomain,
          acme_email: acmeEmail,
          tls_mode: tlsMode,
          http_port: httpPort,
          https_port: httpsPort,
        })
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'community_deploy_failed');
      }
      return {
        supported: true,
        dockerVersion: typeof response?.docker_version === 'string' ? response.docker_version : null,
        composeVersion: typeof response?.compose_version === 'string' ? response.compose_version : null,
        composeFilePresent: Boolean(response?.compose_file_present),
        stackDirWritable: Boolean(response?.stack_dir_writable),
        normalizedDomain:
          typeof response?.normalized_domain === 'string'
            ? response.normalized_domain
            : normalizedDomain,
        matrixBaseDomain:
          typeof response?.matrix_base_domain === 'string'
            ? response.matrix_base_domain
            : matrixBaseDomain,
        tlsMode,
        httpPort,
        httpsPort,
      };
    },

    /**
     * @param {{
     *   stackDir: string,
     *   domain: string,
     *   acmeEmail: string,
     *   oidcProviderOrigin: string,
     *   tlsMode?: 'acme' | 'internal' | 'off',
     *   httpPort?: number,
     *   httpsPort?: number,
     * }} input
     */
    async prepareCommunityDeploy(input) {
      if (!input || typeof input !== 'object') {
        throw new TypeError('invalid_prepare_input');
      }
      const stackDir = validateCommunityStackDir(input.stackDir);
      const normalizedDomain = validateCommunityDomain(input.domain);
      const acmeEmail = validateCommunityEmail(input.acmeEmail);
      const oidcOrigin = validateCommunityOidcOrigin(input.oidcProviderOrigin);
      const tlsMode = validateCommunityTlsMode(input.tlsMode);
      const { httpPort, httpsPort } = validateCommunityPorts(input.httpPort, input.httpsPort);
      const matrixBaseDomain = deriveMatrixBaseDomain(normalizedDomain);
      const defaultOidcIssuer = `${oidcOrigin}/realms/community`;

      const internals = getInternals(true);
      if (!internals) {
        return {
          supported: false,
          envFileWritten: false,
          unixFileMode: 0,
          composeConfigValid: false,
          generatedSecretKeys: /** @type {string[]} */ ([]),
          normalizedDomain,
          matrixBaseDomain,
          oidcIssuer: defaultOidcIssuer,
          tlsMode,
          httpPort,
          httpsPort,
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('self_host_prepare_community', {
          organisation_id: organisationId,
          stack_dir: stackDir,
          domain: normalizedDomain,
          acme_email: acmeEmail,
          oidc_provider_origin: oidcOrigin,
          tls_mode: tlsMode,
          http_port: httpPort,
          https_port: httpsPort,
        })
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'community_deploy_failed');
      }
      const rawKeys = response?.generated_secret_keys;
      const secretKeys = Array.isArray(rawKeys)
        ? rawKeys.filter((item) => typeof item === 'string')
        : [];
      return {
        supported: true,
        envFileWritten: Boolean(response?.env_file_written),
        unixFileMode: typeof response?.unix_file_mode === 'number' ? response.unix_file_mode : 0,
        composeConfigValid: Boolean(response?.compose_config_valid),
        generatedSecretKeys: secretKeys,
        normalizedDomain:
          typeof response?.normalized_domain === 'string'
            ? response.normalized_domain
            : normalizedDomain,
        matrixBaseDomain:
          typeof response?.matrix_base_domain === 'string'
            ? response.matrix_base_domain
            : matrixBaseDomain,
        oidcIssuer:
          typeof response?.oidc_issuer === 'string' ? response.oidc_issuer : defaultOidcIssuer,
        tlsMode,
        httpPort,
        httpsPort,
      };
    },

    /**
     * @param {{
     *   stackDir: string,
     *   timeoutMs?: number,
     * }} input
     */
    async deployCommunityStack(input) {
      if (!input || typeof input !== 'object') {
        throw new TypeError('invalid_deploy_input');
      }
      const stackDir = validateCommunityStackDir(input.stackDir);
      if (input.timeoutMs !== undefined) {
        if (
          !Number.isInteger(input.timeoutMs)
          || input.timeoutMs < 1_000
          || input.timeoutMs > 300_000
        ) {
          throw new RangeError('invalid_timeout_ms');
        }
      }

      const internals = getInternals(true);
      if (!internals) {
        return {
          supported: false,
          stackHealthy: false,
          pollAttempts: 0,
          state: 'unavailable',
          observedMemoryMib: 0,
          coreServices: /** @type {Array<{ service: string, readiness: string, externalOidc: boolean }>} */ ([]),
        };
      }
      const organisationId = requireOrganisationId(activeOrganisationId);
      /** @type {Record<string, unknown>} */
      const args = {
        organisation_id: organisationId,
        stack_dir: stackDir,
      };
      if (input.timeoutMs !== undefined) {
        args.timeout_ms = input.timeoutMs;
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('self_host_deploy_community', args)
      );
      if (response?.ok === false) {
        throw new Error(typeof response.error === 'string' ? response.error : 'community_deploy_failed');
      }
      const maybeServices = response?.core_services;
      const rawServices = Array.isArray(maybeServices) ? maybeServices : [];
      const coreServices = rawServices
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const rec = /** @type {Record<string, unknown>} */ (item);
          return {
            service: typeof rec.service === 'string' ? rec.service : 'unknown',
            readiness: typeof rec.readiness === 'string' ? rec.readiness : 'unknown',
            externalOidc: Boolean(rec.external_oidc),
          };
        });
      return {
        supported: true,
        stackHealthy: Boolean(response?.stack_healthy),
        pollAttempts: typeof response?.poll_attempts === 'number' ? response.poll_attempts : 0,
        state: typeof response?.state === 'string' ? response.state : 'unknown',
        observedMemoryMib:
          typeof response?.observed_memory_mib === 'number' ? response.observed_memory_mib : 0,
        coreServices,
      };
    },
  };
}

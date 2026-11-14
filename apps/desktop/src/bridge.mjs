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

const VALID_SECRET_KINDS = new Set(['matrix-session', 'oidc-refresh', 'mls-store-key']);
const VALID_CALL_STATES = new Set(['none', 'voice', 'video']);
const VALID_TRAY_ACTIONS = new Set(TRAY_MENU_ITEM_IDS);
const VALID_TLS_MODES = new Set(COMMUNITY_TLS_MODES);

const BIDI_OR_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNSAFE_INPUT_RE = /[\u0000-\u0020\u007f-\u009f;|&$`><*?()[\]{}!'"\\#~]/u;
const UNSAFE_STACK_DIR_RE = /[\u0000-\u001f\u007f-\u009f;|&$`><*?'"\r\n]/u;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/u;
const PARENT_SEGMENT_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
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
    || UNSAFE_STACK_DIR_RE.test(rawDir)
    || !ABSOLUTE_PATH_RE.test(rawDir)
    || PARENT_SEGMENT_RE.test(rawDir)
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

  function getInternals() {
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
      if (organisationId === null) {
        activeOrganisationId = null;
        return;
      }
      activeOrganisationId = requireOrganisationId(organisationId);
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
          currentVersion: DESKTOP_APP_VERSION,
          latestVersion: null,
          channel: 'web',
        };
      }
      const response = /** @type {Record<string, unknown> | null} */ (
        await internals.invoke('check_app_updates', {})
      );
      return {
        supported: true,
        updateAvailable: Boolean(response?.updateAvailable),
        currentVersion: typeof response?.currentVersion === 'string' ? response.currentVersion : DESKTOP_APP_VERSION,
        latestVersion: typeof response?.latestVersion === 'string' ? response.latestVersion : null,
        channel: typeof response?.channel === 'string' ? response.channel : 'stable',
      };
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
      const internals = getInternals();
      if (!internals) {
        // Security invariant: never fall back to localStorage/sessionStorage for keychain secrets.
        return {
          stored: false,
          nativeKeychain: false,
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
      return {
        stored: true,
        nativeKeychain: true,
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
      const internals = getInternals();
      if (!internals) {
        return {
          present: false,
          nativeKeychain: false,
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
      return {
        present: Boolean(response?.present),
        nativeKeychain: true,
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
      const internals = getInternals();
      if (!internals) {
        return {
          present: false,
          nativeKeychain: false,
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
      return {
        present: Boolean(response?.present),
        nativeKeychain: true,
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
      if (!input || typeof input.issuerOrigin !== 'string' || !input.issuerOrigin.startsWith('https://')) {
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
      const internals = getInternals();
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
      const internals = getInternals();
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

      const internals = getInternals();
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

      const internals = getInternals();
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

      const internals = getInternals();
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

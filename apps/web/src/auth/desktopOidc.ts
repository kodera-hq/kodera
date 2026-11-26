import { retireSessionGeneration } from './sessionGeneration'

// Privileged native Desktop WebView OIDC PKCE loopback + OS Keychain + Matrix SSO bridge.
// Active exclusively when running inside the bundled Kodera Desktop WebView
// (`kodera-asset://localhost` on macOS/Linux or `https://kodera-asset.localhost` on Windows)
// where `window.koderaDesktop.invoke` is injected by the verified Rust host.
//
// Security invariants:
// - Token exchange (`authorization_code` + PKCE `code_verifier`) and `refresh_token` rotation
//   run inside native Rust over TLS (`https://`), avoiding WebKit `Origin: null` CORS failures
//   and keeping `refresh_token` bytes inside the OS Keychain (`io.kodera.desktop.oidc-refresh`),
//   never in JavaScript or Web Storage.
// - WebView JavaScript receives only the short-lived `access_token`, `expires_in`, and verified
//   identity claims (`issuer`, `subject`, `amr`).

export { isDesktopBundledOrigin } from '../config'

export interface DesktopNativeBridge {
  readonly identifier: string
  readonly invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

interface WindowWithDesktopBridge {
  readonly koderaDesktop?: DesktopNativeBridge | undefined
}

export interface DesktopOidcSessionPayload {
  readonly ok: true
  readonly access_token: string
  readonly expires_in: number
  readonly realm: string
  readonly issuer: string
  readonly subject: string
  readonly amr?: readonly string[] | undefined
}

interface DesktopMatrixLoopbackPayload {
  readonly ok: true
  readonly callback_uri: string
}

function getDesktopBridge(): DesktopNativeBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as unknown as WindowWithDesktopBridge).koderaDesktop
  if (bridge && typeof bridge.invoke === 'function') return bridge
  return undefined
}

export function isDesktopOidcRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('oidc_refused:')
}

function validateSessionPayload(raw: unknown): DesktopOidcSessionPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid desktop OIDC session payload.')
  }
  const obj = raw as Record<string, unknown>
  if (
    obj['ok'] !== true ||
    typeof obj['access_token'] !== 'string' ||
    obj['access_token'].length === 0 ||
    typeof obj['expires_in'] !== 'number' ||
    !Number.isFinite(obj['expires_in']) ||
    obj['expires_in'] <= 0 ||
    typeof obj['realm'] !== 'string' ||
    typeof obj['issuer'] !== 'string' ||
    typeof obj['subject'] !== 'string' ||
    obj['subject'].length === 0
  ) {
    throw new Error('Invalid desktop OIDC session payload.')
  }
  const rawAmr = obj['amr']
  const amr =
    Array.isArray(rawAmr) &&
    rawAmr.every((item): item is string => typeof item === 'string' && item.length > 0)
      ? Object.freeze([...rawAmr])
      : undefined
  return {
    ok: true,
    access_token: obj['access_token'],
    expires_in: obj['expires_in'],
    realm: obj['realm'],
    issuer: obj['issuer'],
    subject: obj['subject'],
    ...(amr === undefined ? {} : { amr }),
  }
}

export async function desktopOidcExchangeLoopback(params: {
  issuerOrigin: string
  realm: string
  clientId: string
  registration: boolean
  uiLocales: 'en' | 'fr'
  prompt?: 'login' | undefined
  kcAction?: 'CONFIGURE_TOTP' | undefined
}): Promise<DesktopOidcSessionPayload> {
  const bridge = getDesktopBridge()
  if (bridge === undefined) throw new Error('Desktop IPC bridge unavailable.')
  const raw = await bridge.invoke('desktop_oidc_exchange_loopback', {
    issuer_origin: params.issuerOrigin,
    realm: params.realm,
    client_id: params.clientId,
    registration: params.registration,
    ui_locales: params.uiLocales,
    ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
    ...(params.kcAction === undefined ? {} : { kc_action: params.kcAction }),
  })
  return validateSessionPayload(raw)
}

export async function desktopOidcRefreshSession(params: {
  issuerOrigin: string
  realm: string
  clientId: string
}): Promise<DesktopOidcSessionPayload> {
  const bridge = getDesktopBridge()
  if (bridge === undefined) throw new Error('Desktop IPC bridge unavailable.')
  const raw = await bridge.invoke('desktop_oidc_refresh_session', {
    issuer_origin: params.issuerOrigin,
    realm: params.realm,
    client_id: params.clientId,
  })
  return validateSessionPayload(raw)
}

export async function desktopOidcClearSession(params: { realm: string }): Promise<void> {
  retireSessionGeneration()
  const bridge = getDesktopBridge()
  if (bridge === undefined) return
  await bridge.invoke('desktop_oidc_clear_session', {
    realm: params.realm,
  })
}

export async function desktopMatrixSsoLoopback(params: {
  homeserverOrigin: string
  state: string
}): Promise<string> {
  const bridge = getDesktopBridge()
  if (bridge === undefined) throw new Error('Desktop IPC bridge unavailable.')
  const raw = (await bridge.invoke('desktop_matrix_sso_loopback', {
    homeserver_origin: params.homeserverOrigin,
    state: params.state,
  })) as Partial<DesktopMatrixLoopbackPayload> | null
  if (
    typeof raw !== 'object' ||
    raw === null ||
    raw.ok !== true ||
    typeof raw.callback_uri !== 'string'
  ) {
    throw new Error('Invalid desktop Matrix SSO callback.')
  }
  let parsed: URL
  try {
    parsed = new URL(raw.callback_uri)
  } catch {
    throw new Error('Invalid desktop Matrix SSO callback.')
  }
  const port = Number(parsed.port)
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    parsed.pathname !== '/espace/callback' ||
    parsed.hash !== ''
  ) {
    throw new Error('Invalid desktop Matrix SSO callback.')
  }
  return raw.callback_uri
}

import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'

export type PassportMagicLinkAccepted = components['schemas']['PassportMagicLinkAccepted']
export type PassportPerson = components['schemas']['PassportPerson']
export type PassportWorkspaceEntry = components['schemas']['PassportWorkspaceEntry']
export type PassportWorkspaceDirectory = components['schemas']['PassportWorkspaceDirectory']
export type PassportVerifiedSession = components['schemas']['PassportVerifiedSession']
export type PassportSwitchedWorkspace = components['schemas']['PassportSwitchedWorkspace']

export interface PassportPkcePair {
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly codeChallengeMethod: 'S256'
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/**
 * Generates an RFC 7636 S256 PKCE verifier/challenge pair using WebCrypto CSPRNG
 * (32 random bytes -> 43-character base64url verifier and SHA-256 challenge).
 */
export async function generatePassportPkcePair(): Promise<PassportPkcePair> {
  const randomBytes = new Uint8Array(32)
  crypto.getRandomValues(randomBytes)
  const codeVerifier = toBase64Url(randomBytes)
  const encoded = new TextEncoder().encode(codeVerifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const codeChallenge = toBase64Url(new Uint8Array(digest))
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  }
}

/**
 * Normalizes an email input (`local@domain`) by trimming outer whitespace and
 * lowercasing both local and domain parts; returns `null` when invalid.
 */
export function normalizePassportEmailInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length < 3 || trimmed.length > 254 || /\s/.test(trimmed)) {
    return null
  }
  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@')) {
    return null
  }
  const local = trimmed.slice(0, atIndex).toLowerCase()
  const domain = trimmed.slice(atIndex + 1).toLowerCase()
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return null
  }
  return `${local}@${domain}`
}

function authHeader(sessionToken: string | undefined): Record<string, string> | undefined {
  if (!sessionToken) return undefined
  return { Authorization: `Bearer ${sessionToken}` }
}

export async function requestPassportMagicLink(params: {
  email: string
  codeChallenge: string
  deviceChallenge?: string | null
}): Promise<PassportMagicLinkAccepted> {
  const { data } = await coreApi().POST('/auth/passport/magic-link/request', {
    body: {
      email: params.email,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      device_challenge: params.deviceChallenge ?? null,
    },
  })
  if (!data) {
    throw new Error('Empty response from requestPassportMagicLink')
  }
  return data
}

export async function verifyPassportMagicLink(params: {
  token: string
  codeVerifier: string
  deviceVerifier?: string | null
}): Promise<PassportVerifiedSession> {
  const { data } = await coreApi().POST('/auth/passport/magic-link/verify', {
    body: {
      token: params.token,
      code_verifier: params.codeVerifier,
      device_verifier: params.deviceVerifier ?? null,
    },
  })
  if (!data) {
    throw new Error('Empty response from verifyPassportMagicLink')
  }
  return data
}

export async function listPassportWorkspaces(options?: {
  sessionToken?: string
}): Promise<PassportWorkspaceDirectory> {
  const headers = authHeader(options?.sessionToken)
  const { data } = await coreApi().GET(
    '/auth/passport/workspaces',
    headers ? { headers } : undefined
  )
  if (!data) {
    throw new Error('Empty response from listPassportWorkspaces')
  }
  return data
}

export async function switchPassportWorkspace(params: {
  organisationId: string
  sessionToken?: string
}): Promise<PassportSwitchedWorkspace> {
  const headers = authHeader(params.sessionToken)
  const { data } = await coreApi().POST('/auth/passport/switch-workspace', {
    body: { organisation_id: params.organisationId },
    ...(headers ? { headers } : {}),
  })
  if (!data) {
    throw new Error('Empty response from switchPassportWorkspace')
  }
  return data
}

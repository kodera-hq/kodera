import { ApiProblem, coreApi } from '../../api/client'
import type { Middleware } from 'openapi-fetch'

export const KVKB1_MIN_CAPSULE_BYTES = 42
export const KVKB1_MAX_CAPSULE_BYTES = 262_144

export interface ConfidentialKeyBackupPublishBody {
  readonly deviceId: string
  readonly backupEpoch: number
  readonly capsule: string
  readonly signature: string
}

export interface ConfidentialKeyBackupPublished {
  readonly backupEpoch: number
  readonly kdfKind: 'recovery-key' | 'passphrase'
  readonly iterations: number
  readonly capsuleSha256: string
  readonly sourceDeviceId: string
  readonly publishedAt: string
}

export interface ConfidentialKeyBackupRemote extends ConfidentialKeyBackupPublished {
  readonly capsule: string
  readonly capsuleBytes: Uint8Array<ArrayBuffer>
}

export type ConfidentialKeyBackupLookupResult =
  | { readonly status: 'active'; readonly backup: ConfidentialKeyBackupRemote }
  | { readonly status: 'absent'; readonly nextBackupEpoch: number }

export class ConfidentialKeyBackupConflictError extends ApiProblem {
  readonly nextBackupEpoch: number | null

  constructor(problem: ApiProblem, nextBackupEpoch: number | null) {
    super({
      type: problem.type,
      status: problem.status,
      title: problem.title,
      detail: problem.detail,
      requestId: problem.requestId,
      errors: problem.errors,
      allowedStates: problem.allowedStates,
      retryAfterS: problem.retryAfterS,
      currentEtag: problem.currentEtag,
      suggestions: problem.suggestions,
    })
    this.name = 'ConfidentialKeyBackupConflictError'
    this.nextBackupEpoch = nextBackupEpoch
  }
}

const kvkb1TextDecoder = new TextDecoder('utf-8', { fatal: true })

export function tryParseKvkb1ArchiveEpoch(bytes: Uint8Array): number | null {
  if (bytes.byteLength < KVKB1_MIN_CAPSULE_BYTES || bytes.byteLength > KVKB1_MAX_CAPSULE_BYTES) {
    return null
  }
  if (
    bytes[0] !== 0x4b ||
    bytes[1] !== 0x56 ||
    bytes[2] !== 0x4b ||
    bytes[3] !== 0x42 ||
    bytes[4] !== 0x31
  ) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLen = view.getUint32(5)
  if (headerLen < 1 || headerLen > 2048 || bytes.byteLength < 9 + headerLen + 17) {
    return null
  }
  try {
    const rawText = kvkb1TextDecoder.decode(bytes.subarray(9, 9 + headerLen))
    const parsed: unknown = JSON.parse(rawText)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 9 ||
      JSON.stringify(parsed) !== rawText ||
      parsed[0] !== 'kodera-zk-key-backup' ||
      parsed[1] !== 1
    ) {
      return null
    }
    const epoch: unknown = parsed[4]
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
      return null
    }
    return epoch
  } catch {
    return null
  }
}

export function encodeCapsuleBase64(bytes: Uint8Array): string {
  if (bytes.byteLength < KVKB1_MIN_CAPSULE_BYTES || bytes.byteLength > KVKB1_MAX_CAPSULE_BYTES) {
    throw new Error('KVKB1 capsule byte length is out of bounds.')
  }
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

export function decodeCapsuleBase64(value: string): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Malformed base64 KVKB1 capsule.')
  }
  const binary = atob(value)
  if (binary.length < KVKB1_MIN_CAPSULE_BYTES || binary.length > KVKB1_MAX_CAPSULE_BYTES) {
    throw new Error('Decoded KVKB1 capsule length is out of bounds.')
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  if (
    out[0] !== 0x4b ||
    out[1] !== 0x56 ||
    out[2] !== 0x4b ||
    out[3] !== 0x42 ||
    out[4] !== 0x31
  ) {
    throw new Error('Decoded capsule does not carry the KVKB1 magic header.')
  }
  return out
}

function parseNextEpochHeader(raw: string | null): number | null {
  if (!raw || !/^[1-9][0-9]{0,15}$/.test(raw)) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

export async function getConfidentialKeyBackup(
  organisationId: string,
  signal?: AbortSignal
): Promise<ConfidentialKeyBackupLookupResult> {
  let hintedNextEpoch: number | null = null
  const headerCapture: Middleware = {
    onResponse({ response }) {
      hintedNextEpoch = parseNextEpochHeader(response.headers.get('X-Kodera-Next-Backup-Epoch'))
      return undefined
    },
  }
  try {
    const { data, response } = await coreApi().GET(
      '/organisations/{organisation_id}/confidential/key-backup',
      {
        params: { path: { organisation_id: organisationId } },
        middleware: [headerCapture],
        ...(signal ? { signal } : {}),
      }
    )
    if (!data || typeof data !== 'object') {
      throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
    }
    const wire = data as Omit<ConfidentialKeyBackupRemote, 'capsuleBytes'>
    const capsuleBytes = decodeCapsuleBase64(wire.capsule)
    return {
      status: 'active',
      backup: {
        ...wire,
        capsuleBytes,
      },
    }
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 404) {
      return {
        status: 'absent',
        nextBackupEpoch: hintedNextEpoch ?? 1,
      }
    }
    throw error
  }
}

export async function publishConfidentialKeyBackup(
  organisationId: string,
  body: ConfidentialKeyBackupPublishBody,
  idempotencyKey: string = crypto.randomUUID()
): Promise<ConfidentialKeyBackupPublished> {
  let hintedNextEpoch: number | null = null
  const headerCapture: Middleware = {
    onResponse({ response }) {
      hintedNextEpoch = parseNextEpochHeader(response.headers.get('X-Kodera-Next-Backup-Epoch'))
      return undefined
    },
  }
  try {
    const { data, response } = await coreApi().POST(
      '/organisations/{organisation_id}/confidential/key-backup',
      {
        params: {
          path: { organisation_id: organisationId },
          header: { 'Idempotency-Key': idempotencyKey },
        },
        body,
        middleware: [headerCapture],
      }
    )
    if (!data || typeof data !== 'object') {
      throw new ApiProblem({ type: null, status: response.status, title: response.statusText })
    }
    return data as ConfidentialKeyBackupPublished
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 409) {
      throw new ConfidentialKeyBackupConflictError(error, hintedNextEpoch)
    }
    throw error
  }
}

export async function discardConfidentialKeyBackup(
  organisationId: string
): Promise<{ readonly nextBackupEpoch: number | null }> {
  const { response } = await coreApi().DELETE(
    '/organisations/{organisation_id}/confidential/key-backup',
    {
      params: { path: { organisation_id: organisationId } },
    }
  )
  return {
    nextBackupEpoch: parseNextEpochHeader(response.headers.get('X-Kodera-Next-Backup-Epoch')),
  }
}

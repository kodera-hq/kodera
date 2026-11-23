import { coreApi } from '@/api/client'
import { mutate } from '@/api/mutations'
import type { components } from '@/api/schema'
import { validateExtensionWebhookUrl, type ExtensionWebhookErrorCode } from './catalog'

export type WorkspaceImportSource = components['schemas']['WorkspaceImportSource']
export type WorkspaceImportWarningCode = components['schemas']['WorkspaceImportWarningCode']
export type WorkspaceImportDryRunCounts = components['schemas']['WorkspaceImportDryRunCounts']
export type WorkspaceImportMemberMapping = components['schemas']['WorkspaceImportMemberMapping']
export type WorkspaceImportDryRunReport = components['schemas']['WorkspaceImportDryRunReport']
export type WorkspaceImportResponse = components['schemas']['WorkspaceImportResponse']
export type CoexistenceBridgeSource = components['schemas']['CoexistenceBridgeSource']
export type CoexistenceBridgeRecord = components['schemas']['CoexistenceBridge']
export type CoexistenceBridgeCreateInput = components['schemas']['CoexistenceBridgeCreateRequest']

export const MAX_INLINE_ARCHIVE_BYTES = 512 * 1024
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024

export type ArchiveValidationErrorCode =
  | 'ARCHIVE_EMPTY'
  | 'ARCHIVE_NOT_ZIP'
  | 'ARCHIVE_INLINE_TOO_LARGE'
  | 'ARCHIVE_TOO_LARGE'

export type BridgeFormErrorCode =
  | ExtensionWebhookErrorCode
  | 'CHANNEL_REQUIRED'
  | 'CHANNEL_CONFIDENTIAL_FORBIDDEN'
  | 'EXTERNAL_IDS_INVALID'
  | 'SECRET_TOO_SHORT'

const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  )
}

export function hasDiscordJsonPrefix(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2) return false
  let idx = 0
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    idx = 3
  }
  while (
    idx < bytes.byteLength &&
    (bytes[idx] === 0x20 || bytes[idx] === 0x09 || bytes[idx] === 0x0a || bytes[idx] === 0x0d)
  ) {
    idx += 1
  }
  if (idx >= bytes.byteLength || (bytes[idx] !== 0x7b && bytes[idx] !== 0x5b)) {
    return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

export function encodeInlineArchiveBase64(
  bytes: Uint8Array,
  source: WorkspaceImportSource = 'notion'
): { readonly ok: true; readonly base64: string } | { readonly ok: false; readonly code: ArchiveValidationErrorCode } {
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'ARCHIVE_EMPTY' }
  }
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    return { ok: false, code: 'ARCHIVE_TOO_LARGE' }
  }
  if (bytes.byteLength >= MAX_INLINE_ARCHIVE_BYTES) {
    return { ok: false, code: 'ARCHIVE_INLINE_TOO_LARGE' }
  }
  const validFormat =
    hasZipMagic(bytes) || (source === 'discord' && hasDiscordJsonPrefix(bytes))
  if (!validFormat) {
    return { ok: false, code: 'ARCHIVE_NOT_ZIP' }
  }
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    binary += String.fromCharCode(...slice)
  }
  return { ok: true, base64: btoa(binary) }
}

export function validateCoexistenceBridgeDraft(input: {
  readonly channelId: string
  readonly isConfidentialChannel: boolean
  readonly externalWorkspaceId: string
  readonly externalChannelId: string
  readonly outboundEndpoint: string
  readonly signingSecret: string
}):
  | { readonly ok: true; readonly normalizedEndpoint: string }
  | { readonly ok: false; readonly code: BridgeFormErrorCode } {
  if (!input.channelId) {
    return { ok: false, code: 'CHANNEL_REQUIRED' }
  }
  if (input.isConfidentialChannel) {
    return { ok: false, code: 'CHANNEL_CONFIDENTIAL_FORBIDDEN' }
  }
  if (
    !EXTERNAL_ID_PATTERN.test(input.externalWorkspaceId.trim()) ||
    !EXTERNAL_ID_PATTERN.test(input.externalChannelId.trim())
  ) {
    return { ok: false, code: 'EXTERNAL_IDS_INVALID' }
  }
  const urlCheck = validateExtensionWebhookUrl(input.outboundEndpoint)
  if (!urlCheck.ok) {
    return { ok: false, code: urlCheck.code }
  }
  const trimmedSecret = input.signingSecret.trim()
  if (trimmedSecret.length < 16 || trimmedSecret.length > 256) {
    return { ok: false, code: 'SECRET_TOO_SHORT' }
  }
  return { ok: true, normalizedEndpoint: urlCheck.normalizedUrl }
}

export interface WorkspaceMigratorTransport {
  previewImport(
    organisationId: string,
    body: components['schemas']['WorkspaceImportPreviewRequest']
  ): Promise<WorkspaceImportDryRunReport>
  executeImport(
    organisationId: string,
    body: components['schemas']['WorkspaceImportExecuteRequest']
  ): Promise<WorkspaceImportResponse>
  listBridges(organisationId: string): Promise<readonly CoexistenceBridgeRecord[]>
  createBridge(
    organisationId: string,
    body: CoexistenceBridgeCreateInput
  ): Promise<CoexistenceBridgeRecord>
  revokeBridge(organisationId: string, bridgeId: string): Promise<void>
}

export const defaultWorkspaceMigratorTransport: WorkspaceMigratorTransport = {
  async previewImport(organisationId, body) {
    const result = await mutate(
      {
        method: 'post',
        path: '/organisations/{organisation_id}/workspace/imports/preview',
      },
      {
        params: { path: { organisation_id: organisationId } },
        body,
      }
    )
    return result
  },
  async executeImport(organisationId, body) {
    const result = await mutate(
      {
        method: 'post',
        path: '/organisations/{organisation_id}/workspace/imports/execute',
      },
      {
        params: { path: { organisation_id: organisationId } },
        body,
      }
    )
    return result
  },
  async listBridges(organisationId) {
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/coexistence/bridges',
      {
        params: { path: { organisation_id: organisationId } },
      }
    )
    return data?.bridges ?? []
  },
  async createBridge(organisationId, body) {
    const result = await mutate(
      {
        method: 'post',
        path: '/organisations/{organisation_id}/workspace/coexistence/bridges',
      },
      {
        params: { path: { organisation_id: organisationId } },
        body,
      }
    )
    return result
  },
  async revokeBridge(organisationId, bridgeId) {
    await mutate(
      {
        method: 'delete',
        path: '/organisations/{organisation_id}/workspace/coexistence/bridges/{bridge_id}',
      },
      {
        params: { path: { organisation_id: organisationId, bridge_id: bridgeId } },
      }
    )
  },
}

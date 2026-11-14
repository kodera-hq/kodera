// GDPR data portability (Art. 20) and erasure (Art. 17) API client (Core API 0.44.0).
// Covers both workspace scope (`/organisations/{id}/workspace/privacy/...`, owner only)
// and personal account scope (`/me/privacy/...`, authenticated member).
// Validates lifecycles and pre-signed download links; never masks 503 proof holds.

import { coreApi } from '../../api/client'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'
import { isSafePresignedDownloadUrl } from '../billing/checkoutUrl'

export type PrivacyWorkspaceExport = components['schemas']['PrivacyWorkspaceExport']
export type PrivacyWorkspaceDeletion = components['schemas']['PrivacyWorkspaceDeletion']
export type PrivacyAccountExport = components['schemas']['PrivacyAccountExport']
export type PrivacyAccountDeletion = components['schemas']['PrivacyAccountDeletion']
export type DownloadLink = components['schemas']['DownloadLink']

export type AnyPrivacyExport = PrivacyWorkspaceExport | PrivacyAccountExport
export type AnyPrivacyDeletion = PrivacyWorkspaceDeletion | PrivacyAccountDeletion
export type PrivacyExportStatus = AnyPrivacyExport['status']
export type PrivacyDeletionStatus = AnyPrivacyDeletion['status']
export type PrivacyFailureCode = NonNullable<AnyPrivacyExport['failureCode']>

const EXPORT_STATUSES: ReadonlySet<unknown> = new Set([
  'queued',
  'running',
  'ready',
  'failed',
  'expired',
  'cancelled',
])

const DELETION_STATUSES: ReadonlySet<unknown> = new Set([
  'queued',
  'running',
  'retention_pending',
  'completed',
  'failed',
  'cancelled',
])

const FAILURE_CODES: ReadonlySet<unknown> = new Set([
  null,
  'build_failed',
  'storage_unavailable',
  'identity_conflict',
  'legal_hold',
])

function isIsoOrNull(value: unknown): boolean {
  if (value === null || value === undefined) return true
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validateLifecycleCommon(
  value: unknown,
  expectedScope: 'workspace' | 'account',
  expectedKind: 'export' | 'deletion',
  allowedStatuses: ReadonlySet<unknown>
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Privacy lifecycle response is unavailable.')
  }
  const rec = value as Record<string, unknown>
  if (
    typeof rec.id !== 'string' ||
    rec.id.trim().length === 0 ||
    rec.scope !== expectedScope ||
    rec.kind !== expectedKind ||
    !allowedStatuses.has(rec.status) ||
    typeof rec.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(rec.requestedAt)) ||
    typeof rec.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(rec.updatedAt)) ||
    !isIsoOrNull(rec.expiresAt) ||
    !isIsoOrNull(rec.purgeAfter) ||
    !FAILURE_CODES.has(rec.failureCode ?? null)
  ) {
    throw new Error('Privacy lifecycle response is unavailable.')
  }
}

function validatePrivacyDownloadLink(value: unknown): asserts value is DownloadLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Privacy export download link is unavailable.')
  }
  const rec = value as Record<string, unknown>
  if (!isSafePresignedDownloadUrl(rec.url, rec.expires_at)) {
    throw new Error('Privacy export download link is unavailable or expired.')
  }
}

export async function requestWorkspaceExport(
  organisationId: string,
  options: { includeMedia: boolean },
  idempotencyKey = crypto.randomUUID()
): Promise<PrivacyWorkspaceExport> {
  const data = await mutate(
    { method: 'post', path: '/organisations/{organisation_id}/workspace/privacy/exports' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body: { format: 'zip', includeMedia: options.includeMedia },
    }
  )
  validateLifecycleCommon(data, 'workspace', 'export', EXPORT_STATUSES)
  return data
}

export async function getWorkspaceExport(
  organisationId: string,
  requestId: string
): Promise<PrivacyWorkspaceExport> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/privacy/exports/{request_id}',
    {
      params: { path: { organisation_id: organisationId, request_id: requestId } },
    }
  )
  validateLifecycleCommon(data, 'workspace', 'export', EXPORT_STATUSES)
  return data as PrivacyWorkspaceExport
}

export async function getWorkspaceExportDownloadLink(
  organisationId: string,
  requestId: string
): Promise<DownloadLink> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/privacy/exports/{request_id}/download',
    {
      params: { path: { organisation_id: organisationId, request_id: requestId } },
    }
  )
  validatePrivacyDownloadLink(data)
  return data
}

export async function requestAccountExport(
  options: { includeMedia: boolean },
  idempotencyKey = crypto.randomUUID()
): Promise<PrivacyAccountExport> {
  const data = await mutate(
    { method: 'post', path: '/me/privacy/exports' },
    {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: { format: 'zip', includeMedia: options.includeMedia },
    }
  )
  validateLifecycleCommon(data, 'account', 'export', EXPORT_STATUSES)
  return data
}

export async function getAccountExport(requestId: string): Promise<PrivacyAccountExport> {
  const { data } = await coreApi().GET('/me/privacy/exports/{request_id}', {
    params: { path: { request_id: requestId } },
  })
  validateLifecycleCommon(data, 'account', 'export', EXPORT_STATUSES)
  return data as PrivacyAccountExport
}

export async function getAccountExportDownloadLink(requestId: string): Promise<DownloadLink> {
  const { data } = await coreApi().GET('/me/privacy/exports/{request_id}/download', {
    params: { path: { request_id: requestId } },
  })
  validatePrivacyDownloadLink(data)
  return data
}

export async function requestWorkspaceDeletion(
  organisationId: string,
  options: { reason?: string },
  idempotencyKey = crypto.randomUUID()
): Promise<PrivacyWorkspaceDeletion> {
  const trimmedReason = options.reason?.trim()
  const data = await mutate(
    { method: 'post', path: '/organisations/{organisation_id}/workspace/privacy/deletions' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body: {
        confirmation: 'delete',
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      },
    }
  )
  validateLifecycleCommon(data, 'workspace', 'deletion', DELETION_STATUSES)
  return data
}

export async function getWorkspaceDeletion(
  organisationId: string,
  requestId: string
): Promise<PrivacyWorkspaceDeletion> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/privacy/deletions/{request_id}',
    {
      params: { path: { organisation_id: organisationId, request_id: requestId } },
    }
  )
  validateLifecycleCommon(data, 'workspace', 'deletion', DELETION_STATUSES)
  return data as PrivacyWorkspaceDeletion
}

export async function requestAccountDeletion(
  options: { reason?: string },
  idempotencyKey = crypto.randomUUID()
): Promise<PrivacyAccountDeletion> {
  const trimmedReason = options.reason?.trim()
  const data = await mutate(
    { method: 'post', path: '/me/privacy/deletions' },
    {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: {
        confirmation: 'delete',
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      },
    }
  )
  validateLifecycleCommon(data, 'account', 'deletion', DELETION_STATUSES)
  return data
}

export async function getAccountDeletion(requestId: string): Promise<PrivacyAccountDeletion> {
  const { data } = await coreApi().GET('/me/privacy/deletions/{request_id}', {
    params: { path: { request_id: requestId } },
  })
  validateLifecycleCommon(data, 'account', 'deletion', DELETION_STATUSES)
  return data as PrivacyAccountDeletion
}

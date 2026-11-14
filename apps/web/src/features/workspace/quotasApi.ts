// Workspace resource quota observation API (Core API 0.44.0).
// Observation only: Core enforces authoritative reservations under lock and
// refuses exhausted writes with 402 (seats/pages), 413 (media bytes), or 503
// when enforcement is unavailable.

import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'

export type WorkspaceQuotaUsage = components['schemas']['WorkspaceQuotaUsage']
export type WorkspaceQuotaCounters = components['schemas']['WorkspaceQuotaCounters']
export type WorkspaceQuotaLimits = components['schemas']['WorkspaceQuotaLimits']

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isLimitField(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
}

export function requireWorkspaceQuotaUsage(value: unknown): asserts value is WorkspaceQuotaUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Workspace quota usage response is unavailable.')
  }
  const record = value as Record<string, unknown>
  const usage = record.usage as Record<string, unknown> | undefined
  const limits = record.limits as Record<string, unknown> | undefined
  if (
    typeof usage !== 'object' ||
    usage === null ||
    !isNonNegativeInt(usage.seats) ||
    !isNonNegativeInt(usage.mediaBytes) ||
    !isNonNegativeInt(usage.pages) ||
    typeof limits !== 'object' ||
    limits === null ||
    !isLimitField(limits.seats) ||
    !isLimitField(limits.mediaBytes) ||
    !isLimitField(limits.pages) ||
    typeof record.measuredAt !== 'string' ||
    !Number.isFinite(Date.parse(record.measuredAt))
  ) {
    throw new Error('Workspace quota usage response is unavailable.')
  }
}

export async function fetchWorkspaceQuotaUsage(
  organisationId: string
): Promise<WorkspaceQuotaUsage> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/quotas/usage', {
    params: { path: { organisation_id: organisationId } },
  })
  if (data === undefined) {
    throw new Error('GET /organisations/{id}/workspace/quotas/usage resolved with no body.')
  }
  requireWorkspaceQuotaUsage(data)
  return data
}

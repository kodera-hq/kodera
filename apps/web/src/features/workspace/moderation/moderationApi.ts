// Invite links, abuse reports and member moderation (Core API 0.43.0), for the workspace's
// administrators. Core decides who may call them; the settings show these screens to owners and
// administrators only, so a member never sees a control that Core would refuse.

import { ApiProblem, coreApi } from '../../../api/client'
import { mutate } from '../../../api/mutations'
import type { components } from '../../../api/schema'

export type InviteLink = components['schemas']['WorkspaceInviteLink']
export type AbuseReport = components['schemas']['AbuseReport']
export type ModerationAction = components['schemas']['WorkspaceModerationRequest']['action']

/** Where a member opens an invite: the code rides in the fragment, which no server ever receives. */
export function inviteUrl(code: string, origin = window.location.origin): string {
  return `${origin}${import.meta.env.BASE_URL}join#${encodeURIComponent(code)}`
}

/** An expiry the contract accepts: whole days from now, between one and thirty. */
export function expiryIn(days: number, now = new Date()): string {
  const bounded = Math.min(30, Math.max(1, Math.round(days)))
  return new Date(now.getTime() + bounded * 86_400_000).toISOString()
}

export async function listInviteLinks(organisationId: string): Promise<InviteLink[]> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/invite-links', {
    params: { path: { organisation_id: organisationId }, query: { status: 'active', limit: 50 } },
  })
  if (data === undefined) throw new Error('invite-links-unavailable')
  return data.data as InviteLink[]
}

export async function createInviteLink(
  organisationId: string,
  request: { days: number; maxUses: number; role: 'org_member' | 'moderator' }
): Promise<{ link: InviteLink; code: string }> {
  return mutate(
    { method: 'post', path: '/organisations/{organisation_id}/workspace/invite-links' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: {
        expiresAt: expiryIn(request.days),
        maxUses: Math.min(10_000, Math.max(1, Math.round(request.maxUses))),
        role: request.role,
      },
    }
  )
}

export async function revokeInviteLink(organisationId: string, linkId: string): Promise<void> {
  await mutate(
    {
      method: 'delete',
      path: '/organisations/{organisation_id}/workspace/invite-links/{invite_link_id}',
    },
    {
      params: { path: { organisation_id: organisationId, invite_link_id: linkId } },
    }
  )
}

export async function listReports(organisationId: string): Promise<AbuseReport[]> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace/reports', {
    params: { path: { organisation_id: organisationId }, query: { limit: 50 } },
  })
  if (data === undefined) throw new Error('reports-unavailable')
  return data.data as AbuseReport[]
}

/**
 * Resolves or dismisses a report. The contract gives a report no read of its own and its list no
 * tags (CONVENTIONS §10), so the change is first sent against no version Core could hold: Core
 * answers `412` with the report's current tag. The report is then read again from the list, and the
 * decision is sent with that tag only while the report is still open, so a decision another
 * moderator made meanwhile is never overwritten.
 */
export async function resolveReport(
  organisationId: string,
  reportId: string,
  status: 'resolved' | 'dismissed',
  resolution: string,
  io: { patch?: typeof patchReport; list?: typeof listReports } = {}
): Promise<AbuseReport> {
  const patch = io.patch ?? patchReport
  const list = io.list ?? listReports
  try {
    return await patch(organisationId, reportId, { status, resolution }, '"unknown"')
  } catch (error) {
    if (!(error instanceof ApiProblem) || error.status !== 412 || !error.currentEtag) throw error
    const current = (await list(organisationId)).find((report) => report.id === reportId)
    if (current === undefined || current.status !== 'open') throw new ReportAlreadyDecided()
    return patch(organisationId, reportId, { status, resolution }, error.currentEtag)
  }
}

export class ReportAlreadyDecided extends Error {
  constructor() {
    super('report already decided')
    this.name = 'ReportAlreadyDecided'
  }
}

function patchReport(
  organisationId: string,
  reportId: string,
  body: { status: 'resolved' | 'dismissed'; resolution: string },
  etag: string
): Promise<AbuseReport> {
  return mutate(
    { method: 'patch', path: '/organisations/{organisation_id}/workspace/reports/{report_id}' },
    {
      params: {
        path: { organisation_id: organisationId, report_id: reportId },
        header: { 'If-Match': etag },
      },
      body,
      concurrency: etag,
    }
  )
}

type ModerationRequest = { membershipId: string; action: ModerationAction; reason: string; days?: number }

/** The wire body. Only a mute lasts: Core refuses `expiresAt` on kick, ban and unban with 422. */
export function moderationBody(request: ModerationRequest, now = new Date()) {
  return {
    membershipId: request.membershipId,
    action: request.action,
    reason: request.reason,
    ...(request.action === 'mute' && request.days !== undefined
      ? { expiresAt: expiryIn(request.days, now) }
      : {}),
  }
}

export async function moderateMember(organisationId: string, request: ModerationRequest): Promise<void> {
  await mutate(
    { method: 'post', path: '/organisations/{organisation_id}/workspace/moderation' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: moderationBody(request),
    }
  )
}

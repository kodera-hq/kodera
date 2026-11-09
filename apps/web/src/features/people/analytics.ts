// The events of `docs/specs/03-people.md` §11. No personal data: never an
// address, a name or a domain — counts, buckets and closed codes only.

import { track } from '@/analytics/track'
import type { InvitationRole, OrganisationRole } from './roles'

export type PeopleTabName = 'members' | 'invitations' | 'on-site'
export type InviteSource = 'button' | 'empty-state' | 'status'

export function memberCountBucket(count: number): string {
  if (count <= 1) return '1'
  if (count <= 10) return '2-10'
  if (count <= 50) return '11-50'
  if (count <= 200) return '51-200'
  return '>200'
}

export function trackPeopleViewed(tab: PeopleTabName, memberCount: number): void {
  track('people_viewed', { tab, member_count_bucket: memberCountBucket(memberCount) })
}

export function trackInviteOpened(source: InviteSource): void {
  track('people_invite_opened', { source })
}

export function trackInviteSubmitted(
  count: number,
  role: InvitationRole,
  pasteUsed: boolean
): void {
  track('people_invite_submitted', { count, role, paste_used: pasteUsed })
}

/** `reasons` are outcome codes, deduplicated and sorted, never addresses. */
export function trackInviteResult(sent: number, rejected: number, reasons: string[]): void {
  track('people_invite_result', { sent, rejected, reasons: [...new Set(reasons)].sort().join(',') })
}

export function trackImportStarted(source: string): void {
  track('people_import_started', { source })
}

export function trackImportParsed(summary: {
  rows: number
  ready: number
  already_member: number
  duplicate: number
  invalid: number
}): void {
  track('people_import_parsed', summary)
}

export function trackImportExecuted(sent: number, failed: number): void {
  track('people_import_executed', { sent, failed })
}

export function trackImportRetry(retried: number): void {
  track('people_import_retry', { retried })
}

export function trackRoleChanged(from: OrganisationRole, to: OrganisationRole): void {
  track('people_role_changed', { from, to })
}

export function trackMemberRemoved(): void {
  track('people_member_removed', {})
}

export function trackEnrolmentCreated(count: number): void {
  track('people_enrolment_created', { count })
}

export function trackEnrolmentPrinted(): void {
  track('people_enrolment_printed', {})
}

export function trackEnrolmentClaimedView(used: number, count: number): void {
  track('people_enrolment_claimed_view', { used, count })
}

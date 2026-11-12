// The shape of a membership as it arrives, checked before a screen draws it or acts on it.
//
// Core withholds a person's private facts from a caller who is neither that person nor someone
// who manages people (contract 0.42.0, « Directory privacy »): `email`, `identity_id` and
// `last_seen_at` are then omitted or `null`, and a client treats the two alike. A check that took
// only the omitted form would turn every colleague's record into « unavailable » for a member.

import type { Membership } from './queries'

const ROLES = ['org_owner', 'org_admin', 'org_billing', 'org_member'] as const
const STATES = ['invited', 'active', 'suspended', 'removed'] as const

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

/** Check the required wire facts and every optional fact this drawer renders. */
export function boundMember(
  value: unknown,
  organisationId: string,
  memberId: string
): value is Membership {
  return (
    record(value) &&
    value['id'] === memberId &&
    value['organisation_id'] === organisationId &&
    ROLES.some((role) => role === value['role']) &&
    STATES.some((state) => state === value['state']) &&
    timestamp(value['created_at']) &&
    (value['updated_at'] === undefined || timestamp(value['updated_at'])) &&
    // A withheld address is omitted or `null` (contract 0.42.0): both are a membership to show.
    (value['email'] == null || typeof value['email'] === 'string') &&
    (value['display_name'] == null || typeof value['display_name'] === 'string') &&
    (value['last_seen_at'] == null || timestamp(value['last_seen_at']))
  )
}

// Typed Core API client and zero-trust wire parser for the Workspace Cybersecurity Posture Advisor.

import { ApiProblem, coreApi } from '../../../api/client'
import { IamUnsupported } from '../iamApi'
import type { PostureCheckId, PostureGrade } from './securityPostureMessages'

export const POSTURE_CHECK_IDS = [
  'invite_hygiene',
  'sovereign_ai_boundary',
  'security_alert_routing',
  'extension_secret_rotation',
  'least_privilege_roles',
  'confidential_room_readiness',
] as const satisfies readonly PostureCheckId[]

export const REMEDIATION_ACTIONS = [
  'cap_unbounded_invites',
  'enforce_eu_sovereign_ai',
  'provision_security_alerts_channel',
  'rotate_stale_extension_keys',
  'strip_excess_role_permissions',
  'provision_confidential_channel',
] as const

export type SingleRemediationAction = (typeof REMEDIATION_ACTIONS)[number]
export type PostureRemediationAction = SingleRemediationAction | 'fix_all_safe'

const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const satisfies readonly PostureGrade[]

export interface SecurityPostureCheck {
  id: PostureCheckId
  status: 'pass' | 'warn'
  earned_points: number
  max_points: number
  remediation_action: SingleRemediationAction
  fix_available: boolean
  affected_count: number
}

export interface WorkspaceSecurityPosture {
  organisation_id: string
  workspace_id: string
  score: number
  max_score: number
  grade: PostureGrade
  passing_checks: number
  total_checks: number
  fixable_checks: number
  checks: SecurityPostureCheck[]
}

export interface RemediateSecurityPostureResult {
  requested_action: PostureRemediationAction
  applied_actions: SingleRemediationAction[]
  score_before: number
  posture: WorkspaceSecurityPosture
}

export const postureQueryKey = (organisationId: string) =>
  ['workspace-iam', organisationId, 'security-posture'] as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function parseCheck(raw: unknown): SecurityPostureCheck {
  if (!isObject(raw)) throw new Error('Malformed security posture check.')
  const id = raw['id']
  const action = raw['remediation_action']
  if (
    typeof id !== 'string' ||
    !(POSTURE_CHECK_IDS as readonly string[]).includes(id) ||
    typeof action !== 'string' ||
    !(REMEDIATION_ACTIONS as readonly string[]).includes(action)
  ) {
    throw new Error('Unexpected security posture check identifier.')
  }
  const maxPoints = clampInt(raw['max_points'], 1, 100, 15)
  return {
    id: id as PostureCheckId,
    status: raw['status'] === 'pass' ? 'pass' : 'warn',
    earned_points: clampInt(raw['earned_points'], 0, maxPoints, 0),
    max_points: maxPoints,
    remediation_action: action as SingleRemediationAction,
    fix_available: raw['fix_available'] === true,
    affected_count: clampInt(raw['affected_count'], 0, 100_000, 0),
  }
}

export function parseSecurityPosture(raw: unknown): WorkspaceSecurityPosture {
  if (!isObject(raw) || !Array.isArray(raw['checks'])) {
    throw new Error('Workspace security posture answered with an unexpected shape.')
  }
  const grade =
    typeof raw['grade'] === 'string' && (GRADES as readonly string[]).includes(raw['grade'])
      ? (raw['grade'] as PostureGrade)
      : 'F'
  const checks = raw['checks'].map(parseCheck)
  return {
    organisation_id: typeof raw['organisation_id'] === 'string' ? raw['organisation_id'] : '',
    workspace_id: typeof raw['workspace_id'] === 'string' ? raw['workspace_id'] : '',
    score: clampInt(raw['score'], 0, 100, 0),
    max_score: clampInt(raw['max_score'], 1, 100, 100),
    grade,
    passing_checks: clampInt(raw['passing_checks'], 0, checks.length, 0),
    total_checks: clampInt(raw['total_checks'], 0, 32, checks.length),
    fixable_checks: clampInt(raw['fixable_checks'], 0, checks.length, 0),
    checks,
  }
}

async function unwrapUnsupported<T>(promise: Promise<{ data?: T }>): Promise<unknown> {
  try {
    const { data } = await promise
    return data
  } catch (error) {
    if (
      error instanceof ApiProblem &&
      (error.status === 405 ||
        error.status === 501 ||
        (error.status === 404 && error.type === null))
    ) {
      throw new IamUnsupported()
    }
    throw error
  }
}

export async function getWorkspaceSecurityPosture(
  organisationId: string
): Promise<WorkspaceSecurityPosture> {
  const data = await unwrapUnsupported(
    coreApi().GET('/organisations/{organisation_id}/workspace/security-posture', {
      params: { path: { organisation_id: organisationId } },
    })
  )
  return parseSecurityPosture(data)
}

export async function remediateWorkspaceSecurityPosture(
  organisationId: string,
  action: PostureRemediationAction
): Promise<RemediateSecurityPostureResult> {
  const data = await unwrapUnsupported(
    coreApi().POST(
      '/organisations/{organisation_id}/workspace/security-posture/actions/remediate',
      {
        params: {
          path: { organisation_id: organisationId },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body: { action },
      }
    )
  )
  if (!isObject(data)) {
    throw new Error('Security posture remediation answered with an unexpected shape.')
  }
  const applied = Array.isArray(data['applied_actions'])
    ? data['applied_actions'].filter(
        (item): item is SingleRemediationAction =>
          typeof item === 'string' && (REMEDIATION_ACTIONS as readonly string[]).includes(item)
      )
    : []
  return {
    requested_action: action,
    applied_actions: applied,
    score_before: clampInt(data['score_before'], 0, 100, 0),
    posture: parseSecurityPosture(data['posture']),
  }
}

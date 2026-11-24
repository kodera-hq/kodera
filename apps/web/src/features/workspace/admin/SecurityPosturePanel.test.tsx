import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProblem } from '../../../api/client'
import '../../../i18n'
import { IamUnsupported } from '../iamApi'
import { auditCategory } from './AuditLogPanel'
import { ADMIN_GROUPS, isAdminSection } from './sections'
import { SecurityPosturePanel } from './SecurityPosturePanel'
import type * as PostureApiModule from './securityPostureApi'
import type { WorkspaceSecurityPosture } from './securityPostureApi'
import { ORG, renderPanel } from './test-support'

const postureApi = vi.hoisted(() => ({
  getWorkspaceSecurityPosture: vi.fn(),
  remediateWorkspaceSecurityPosture: vi.fn(),
}))

vi.mock('./securityPostureApi', async (actual) => ({
  ...(await actual<typeof PostureApiModule>()),
  ...postureApi,
}))

function buildPosture(overrides: Partial<WorkspaceSecurityPosture> = {}): WorkspaceSecurityPosture {
  return {
    organisation_id: ORG,
    workspace_id: '0192f3a4-5b6c-7d8e-9f01-23456789ab02',
    score: 45,
    max_score: 100,
    grade: 'E',
    passing_checks: 3,
    total_checks: 6,
    fixable_checks: 3,
    checks: [
      {
        id: 'invite_hygiene',
        status: 'warn',
        earned_points: 0,
        max_points: 20,
        remediation_action: 'cap_unbounded_invites',
        fix_available: true,
        affected_count: 2,
      },
      {
        id: 'sovereign_ai_boundary',
        status: 'warn',
        earned_points: 0,
        max_points: 20,
        remediation_action: 'enforce_eu_sovereign_ai',
        fix_available: true,
        affected_count: 1,
      },
      {
        id: 'security_alert_routing',
        status: 'pass',
        earned_points: 15,
        max_points: 15,
        remediation_action: 'provision_security_alerts_channel',
        fix_available: false,
        affected_count: 0,
      },
      {
        id: 'extension_secret_rotation',
        status: 'warn',
        earned_points: 0,
        max_points: 15,
        remediation_action: 'rotate_stale_extension_keys',
        fix_available: true,
        affected_count: 1,
      },
      {
        id: 'least_privilege_roles',
        status: 'pass',
        earned_points: 15,
        max_points: 15,
        remediation_action: 'strip_excess_role_permissions',
        fix_available: false,
        affected_count: 0,
      },
      {
        id: 'confidential_room_readiness',
        status: 'pass',
        earned_points: 15,
        max_points: 15,
        remediation_action: 'provision_confidential_channel',
        fix_available: false,
        affected_count: 0,
      },
    ],
    ...overrides,
  }
}

describe('SecurityPosturePanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18next.changeLanguage('fr')
    postureApi.getWorkspaceSecurityPosture.mockResolvedValue(buildPosture())
  })

  afterEach(async () => {
    await i18next.changeLanguage('fr')
  })

  it('wires posture into the safety admin section group and security audit category', () => {
    expect(isAdminSection('posture')).toBe(true)
    const safetyGroup = ADMIN_GROUPS.find((group) => group.key === 'safety')
    expect(safetyGroup?.items).toContain('posture')
    expect(auditCategory('workspace.security_posture.configured')).toBe('security')
  })

  it('renders the 0–100 gauge, grade badge, and all 6 explainable check cards', async () => {
    renderPanel(<SecurityPosturePanel organisationId={ORG} />)

    const scoreEl = await screen.findByTestId('posture-score-value')
    expect(scoreEl).toHaveTextContent('45')

    const gradeBadge = screen.getByTestId('posture-grade-badge')
    expect(gradeBadge).toHaveAttribute('data-grade', 'E')
    expect(gradeBadge).toHaveTextContent('E')

    const meter = screen.getByRole('meter', { name: 'Score de posture' })
    expect(meter).toHaveAttribute('aria-valuenow', '45')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
    expect(screen.getByTestId('posture-gauge-fill').style.getPropertyValue('width')).toBe('45%')

    const expectedCheckIds = [
      'invite_hygiene',
      'sovereign_ai_boundary',
      'security_alert_routing',
      'extension_secret_rotation',
      'least_privilege_roles',
      'confidential_room_readiness',
    ] as const
    for (const id of expectedCheckIds) {
      expect(screen.getByTestId(`posture-check-${id}`)).toBeInTheDocument()
    }

    const inviteCard = screen.getByTestId('posture-check-invite_hygiene')
    expect(within(inviteCard).getByText('0 / 20 pts')).toBeInTheDocument()
    expect(within(inviteCard).getByText('À renforcer')).toBeInTheDocument()
    expect(
      within(inviteCard).getByRole('button', { name: 'Corriger en 1 clic' })
    ).toBeInTheDocument()

    const routingCard = screen.getByTestId('posture-check-security_alert_routing')
    expect(within(routingCard).getByText('15 / 15 pts')).toBeInTheDocument()
    expect(within(routingCard).getByText('Conforme')).toBeInTheDocument()
    expect(within(routingCard).queryByRole('button', { name: 'Corriger en 1 clic' })).toBeNull()
  })

  it('applies a single 1-click check remediation and refreshes score immediately', async () => {
    const user = userEvent.setup()
    const afterSingleFix = buildPosture({
      score: 65,
      grade: 'C',
      passing_checks: 4,
      fixable_checks: 2,
      checks: buildPosture().checks.map((c) =>
        c.id === 'invite_hygiene'
          ? { ...c, status: 'pass', earned_points: 20, fix_available: false, affected_count: 0 }
          : c
      ),
    })
    postureApi.remediateWorkspaceSecurityPosture.mockResolvedValueOnce({
      requested_action: 'cap_unbounded_invites',
      applied_actions: ['cap_unbounded_invites'],
      score_before: 45,
      posture: afterSingleFix,
    })

    renderPanel(<SecurityPosturePanel organisationId={ORG} />)

    const inviteCard = await screen.findByTestId('posture-check-invite_hygiene')
    await user.click(within(inviteCard).getByRole('button', { name: 'Corriger en 1 clic' }))

    expect(postureApi.remediateWorkspaceSecurityPosture).toHaveBeenCalledWith(
      ORG,
      'cap_unbounded_invites'
    )
    await waitFor(() => {
      expect(screen.getByTestId('posture-score-value')).toHaveTextContent('65')
    })
    expect(screen.getByTestId('posture-grade-badge')).toHaveAttribute('data-grade', 'C')
    expect(within(inviteCard).getByText('20 / 20 pts')).toBeInTheDocument()
    expect(within(inviteCard).queryByRole('button', { name: 'Corriger en 1 clic' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Posture mise à jour de 45 à 65 / 100')
  })

  it('applies fix_all_safe in 1 click and lifts posture to 100 / Grade A', async () => {
    const user = userEvent.setup()
    const perfectPosture = buildPosture({
      score: 100,
      grade: 'A',
      passing_checks: 6,
      fixable_checks: 0,
      checks: buildPosture().checks.map((c) => ({
        ...c,
        status: 'pass',
        earned_points: c.max_points,
        fix_available: false,
        affected_count: 0,
      })),
    })
    postureApi.remediateWorkspaceSecurityPosture.mockResolvedValueOnce({
      requested_action: 'fix_all_safe',
      applied_actions: [
        'cap_unbounded_invites',
        'enforce_eu_sovereign_ai',
        'rotate_stale_extension_keys',
      ],
      score_before: 45,
      posture: perfectPosture,
    })

    renderPanel(<SecurityPosturePanel organisationId={ORG} />)

    const fixAllButton = await screen.findByRole('button', {
      name: 'Appliquer toutes les remédiations sûres',
    })
    await user.click(fixAllButton)

    expect(postureApi.remediateWorkspaceSecurityPosture).toHaveBeenCalledWith(ORG, 'fix_all_safe')
    await waitFor(() => {
      expect(screen.getByTestId('posture-score-value')).toHaveTextContent('100')
    })
    expect(screen.getByTestId('posture-grade-badge')).toHaveAttribute('data-grade', 'A')
    expect(screen.getByTestId('posture-gauge-fill').style.getPropertyValue('width')).toBe('100%')
    expect(
      screen.queryByRole('button', { name: 'Appliquer toutes les remédiations sûres' })
    ).toBeNull()
    expect(screen.queryAllByRole('button', { name: 'Corriger en 1 clic' })).toHaveLength(0)
  })

  it('supports English copy and surfaces unsupported or refused server states cleanly', async () => {
    await i18next.changeLanguage('en')
    postureApi.getWorkspaceSecurityPosture.mockResolvedValueOnce(
      buildPosture({ score: 85, grade: 'B', passing_checks: 5, fixable_checks: 1 })
    )
    const { unmount } = renderPanel(<SecurityPosturePanel organisationId={ORG} />)

    expect(
      await screen.findByRole('button', { name: 'Apply all safe remediations' })
    ).toBeInTheDocument()
    expect(screen.getByText(/Grade B — Strong posture/)).toBeInTheDocument()
    unmount()

    postureApi.getWorkspaceSecurityPosture.mockRejectedValueOnce(new IamUnsupported())
    const { unmount: unmountUnsupported } = renderPanel(
      <SecurityPosturePanel organisationId={ORG} />
    )
    expect(
      await screen.findByText(/arrive with the next server update for your workspace/i)
    ).toBeInTheDocument()
    unmountUnsupported()

    postureApi.getWorkspaceSecurityPosture.mockRejectedValueOnce(
      new ApiProblem({
        status: 403,
        type: 'https://kodera.io/problems/forbidden',
        title: 'Forbidden',
        requestId: 'req-403',
      })
    )
    renderPanel(<SecurityPosturePanel organisationId={ORG} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Only workspace owners and administrators/i
    )
  })

  it('shows manual MLS device-commit guidance without a 1-click button when confidential rooms require rekey', async () => {
    await i18next.changeLanguage('en')
    postureApi.getWorkspaceSecurityPosture.mockResolvedValueOnce(
      buildPosture({
        score: 85,
        grade: 'B',
        passing_checks: 5,
        fixable_checks: 0,
        checks: buildPosture().checks.map((c) =>
          c.id === 'confidential_room_readiness'
            ? { ...c, status: 'warn', earned_points: 0, fix_available: false, affected_count: 1 }
            : { ...c, status: 'pass', earned_points: c.max_points, fix_available: false, affected_count: 0 }
        ),
      })
    )
    renderPanel(<SecurityPosturePanel organisationId={ORG} />)
    const confCard = await screen.findByTestId('posture-check-confidential_room_readiness')
    expect(
      within(confCard).getByText(/require a client-signed MLS commit from a member device/i)
    ).toBeInTheDocument()
    expect(within(confCard).queryByRole('button', { name: 'Fix in 1 click' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply all safe remediations' })).toBeNull()
  })
})

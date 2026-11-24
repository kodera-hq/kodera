import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../../api/client'
import { Badge } from '../../../ui/Badge/Badge'
import { Button } from '../../../ui/Button/Button'
import { cssProperty } from '../../../ui/cssom'
import { cx } from '../../../ui/cx'
import { StatusPill, type StatusPillState } from '../../../ui/StatusPill/StatusPill'
import { isForbidden, isIamUnsupported } from '../iamApi'
import { iamKeys, retryUnlessUnsupported } from './useIam'
import {
  getWorkspaceSecurityPosture,
  postureQueryKey,
  remediateWorkspaceSecurityPosture,
  type PostureRemediationAction,
  type SecurityPostureCheck,
} from './securityPostureApi'
import { securityPostureCopy, type PostureGrade } from './securityPostureMessages'

function gradeTone(grade: PostureGrade): {
  pillState: StatusPillState
  badgeClass: string
  barClass: string
} {
  if (grade === 'A' || grade === 'B') {
    return {
      pillState: 'success',
      badgeClass: 'bg-c-ok-soft text-c-ok-ink border-c-ok-ink',
      barClass: 'bg-c-ok',
    }
  }
  if (grade === 'C' || grade === 'D') {
    return {
      pillState: 'warning',
      badgeClass: 'bg-c-warn-soft text-c-warn-ink border-c-warn-ink',
      barClass: 'bg-c-warn',
    }
  }
  return {
    pillState: 'danger',
    badgeClass: 'bg-c-bad-soft text-c-bad-ink border-c-bad-ink',
    barClass: 'bg-c-bad',
  }
}

export function SecurityPosturePanel({ organisationId }: { organisationId: string }) {
  const { i18n } = useTranslation()
  const copy = securityPostureCopy(i18n.language)
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const postureQuery = useQuery({
    queryKey: postureQueryKey(organisationId),
    queryFn: () => getWorkspaceSecurityPosture(organisationId),
    retry: (count, error) => retryUnlessUnsupported(count, error) && !isForbidden(error),
  })

  const remediate = useMutation({
    mutationFn: (action: PostureRemediationAction) =>
      remediateWorkspaceSecurityPosture(organisationId, action),
    onMutate: () => {
      setActionError(null)
    },
    onSuccess: (result) => {
      queryClient.setQueryData(postureQueryKey(organisationId), result.posture)
      setNotice(
        copy.remediatedNotice(
          result.score_before,
          result.posture.score,
          result.applied_actions.length
        )
      )
      void queryClient.invalidateQueries({ queryKey: iamKeys.roles(organisationId) })
      void queryClient.invalidateQueries({ queryKey: iamKeys.profile(organisationId) })
      void queryClient.invalidateQueries({ queryKey: iamKeys.invites(organisationId) })
      void queryClient.invalidateQueries({ queryKey: ['workspace-iam', organisationId, 'audit'] })
      void queryClient.invalidateQueries({ queryKey: ['workspace', organisationId] })
    },
    onError: (error: unknown) => {
      if (isForbidden(error)) {
        setActionError(copy.actionForbidden)
      } else if (error instanceof ApiProblem && error.status === 409) {
        setActionError(copy.actionConflict)
        void postureQuery.refetch()
      } else {
        setActionError(copy.actionFailed)
      }
    },
  })

  if (postureQuery.isPending) {
    return <p className="text-sm text-c-ink-3">{copy.loading}</p>
  }

  if (postureQuery.isError) {
    if (isIamUnsupported(postureQuery.error)) {
      return (
        <div className="rounded-lg border border-c-border-soft bg-c-sunken p-4 text-sm text-c-ink-2">
          {copy.unsupported}
        </div>
      )
    }
    return (
      <div
        role="alert"
        className="rounded-lg border border-c-bad-ink bg-c-bad-soft p-4 text-sm text-c-bad-ink"
      >
        {isForbidden(postureQuery.error) ? copy.actionForbidden : copy.loadError}
      </div>
    )
  }

  const posture = postureQuery.data
  const tone = gradeTone(posture.grade)
  const pendingAction = remediate.isPending ? remediate.variables : undefined

  return (
    <div className="flex flex-col gap-6" data-testid="security-posture-panel">
      <p className="text-sm text-c-ink-2">{copy.subtitle}</p>

      {/* Linear Dark Precision Posture Gauge Card */}
      <section
        aria-label={copy.scoreLabel}
        className="flex flex-col gap-5 rounded-lg border border-c-border bg-c-surface p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              data-testid="posture-grade-badge"
              data-grade={posture.grade}
              className={cx(
                'flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border font-mono text-xl font-bold',
                tone.badgeClass
              )}
            >
              {posture.grade}
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span
                  data-testid="posture-score-value"
                  className="font-mono text-3xl font-semibold tracking-tight text-c-ink tabular-nums"
                >
                  {posture.score}
                </span>
                <span className="font-mono text-sm text-c-ink-3 tabular-nums">
                  {copy.outOf(posture.max_score)}
                </span>
                <StatusPill state={tone.pillState} className="ml-2">
                  {copy.gradePrefix(posture.grade)} — {copy.gradeSummary[posture.grade]}
                </StatusPill>
              </div>
              <p className="text-sm text-c-ink-2">
                {copy.passingSummary(posture.passing_checks, posture.total_checks)} ·{' '}
                {copy.fixableSummary(posture.fixable_checks)}
              </p>
            </div>
          </div>

          {posture.fixable_checks > 0 ? (
            <Button
              variant="primary"
              size="md"
              loading={pendingAction === 'fix_all_safe'}
              disabled={remediate.isPending && pendingAction !== 'fix_all_safe'}
              onClick={() => remediate.mutate('fix_all_safe')}
            >
              {copy.fixAllSafe}
            </Button>
          ) : null}
        </div>

        <div
          role="meter"
          aria-label={copy.scoreLabel}
          aria-valuemin={0}
          aria-valuemax={posture.max_score}
          aria-valuenow={posture.score}
          className="h-2 w-full overflow-hidden rounded-full bg-c-sunken"
        >
          <div
            ref={cssProperty('width', `${posture.score}%`)}
            data-testid="posture-gauge-fill"
            className={cx(
              'h-full rounded-full transition-all duration-normal ease-out',
              tone.barClass
            )}
          />
        </div>
      </section>

      {notice !== null ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-c-border-soft bg-c-ok-soft px-4 py-3 text-sm font-medium text-c-ok-ink"
        >
          {notice}
        </div>
      ) : null}

      {actionError !== null ? (
        <div
          role="alert"
          className="rounded-md border border-c-bad-ink bg-c-bad-soft px-4 py-3 text-sm text-c-bad-ink"
        >
          {actionError}
        </div>
      ) : null}

      {/* 6 Explainable Check Cards */}
      <div className="grid grid-cols-1 gap-4">
        {posture.checks.map((check: SecurityPostureCheck) => {
          const itemCopy = copy.checks[check.id]
          const isPass = check.status === 'pass'
          const isFixingThis = pendingAction === check.remediation_action
          return (
            <article
              key={check.id}
              data-testid={`posture-check-${check.id}`}
              data-check-status={check.status}
              className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-c-ink">{itemCopy.title}</h3>
                    <StatusPill state={isPass ? 'success' : 'warning'}>
                      {isPass ? copy.statusPass : copy.statusWarn}
                    </StatusPill>
                  </div>
                  <p className="text-sm text-c-ink-2">{itemCopy.why}</p>
                </div>
                <Badge
                  variant={isPass ? 'neutral' : 'accent'}
                  className="shrink-0 font-mono tabular-nums"
                >
                  {copy.pointsBadge(check.earned_points, check.max_points)}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-c-border-soft pt-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={cx('text-sm', isPass ? 'text-c-ok-ink' : 'text-c-warn-ink')}>
                    {isPass ? itemCopy.passDetail : itemCopy.warnDetail(check.affected_count)}
                  </p>
                  {!isPass && check.fix_available ? (
                    <p className="text-xs text-c-ink-3">{itemCopy.remediationLabel}</p>
                  ) : null}
                  {!isPass && !check.fix_available ? (
                    <p className="text-xs text-c-ink-3">
                      {check.id === 'extension_secret_rotation'
                        ? copy.manualBridgeRotationNote
                        : check.id === 'least_privilege_roles'
                          ? copy.manualRoleCeilingNote
                          : copy.manualDeviceRekeyNote}
                    </p>
                  ) : null}
                </div>

                {!isPass && check.fix_available ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={isFixingThis}
                    disabled={remediate.isPending && !isFixingThis}
                    onClick={() => remediate.mutate(check.remediation_action)}
                  >
                    {copy.fixOneClick}
                  </Button>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { onboardingCopy } from './onboardingMessages'
import {
  ACTIVATION_TASK_IDS,
  completeActivationTask,
  dismissActivationChecklist,
  readActivationChecklist,
  type ActivationChecklistState,
  type ActivationTaskId,
} from './onboardingState'

export interface OnboardingActivationChecklistProps {
  readonly org: string
  readonly syncToken?: number | undefined
  readonly defaultCompleted?: readonly ActivationTaskId[] | undefined
  readonly onInviteMember?: (() => boolean | Promise<boolean>) | undefined
  readonly onFirstMessageOrCall?: (() => boolean | Promise<boolean>) | undefined
}

const DEFAULT_POST_CLAIM_COMPLETED: readonly ActivationTaskId[] = [
  'identity_template',
  'theme_sonic',
]

export function OnboardingActivationChecklist({
  org,
  syncToken = 0,
  defaultCompleted = DEFAULT_POST_CLAIM_COMPLETED,
  onInviteMember,
  onFirstMessageOrCall,
}: OnboardingActivationChecklistProps) {
  const { i18n } = useTranslation()
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const [tracked, setTracked] = useState({ org, syncToken })
  const [state, setState] = useState<ActivationChecklistState>(() =>
    readActivationChecklist(org, defaultCompleted)
  )
  const [pendingTaskId, setPendingTaskId] = useState<ActivationTaskId | null>(null)

  if (tracked.org !== org || tracked.syncToken !== syncToken) {
    setTracked({ org, syncToken })
    setState(readActivationChecklist(org, defaultCompleted))
  }

  if (!org.trim() || state.dismissed) return null

  const completedSet = new Set(state.completed)
  const total = ACTIVATION_TASK_IDS.length
  const completedCount = state.completed.length

  const markTask = (taskId: ActivationTaskId) => {
    for (const seed of state.completed) {
      completeActivationTask(org, seed)
    }
    const next = completeActivationTask(org, taskId)
    setState(next)
  }

  const handleDismiss = () => {
    for (const seed of state.completed) {
      completeActivationTask(org, seed)
    }
    setState(dismissActivationChecklist(org))
  }

  const runActionableTask = async (
    taskId: ActivationTaskId,
    requiresHandler: boolean,
    handler: (() => boolean | Promise<boolean>) | undefined
  ) => {
    if (pendingTaskId !== null) return
    if (requiresHandler && handler === undefined) return
    if (handler === undefined) {
      markTask(taskId)
      return
    }
    setPendingTaskId(taskId)
    try {
      const succeeded = await handler()
      if (succeeded) {
        markTask(taskId)
      }
    } catch {
      // Failed actions (e.g. clipboard denied) never mark the step completed.
    } finally {
      setPendingTaskId(null)
    }
  }

  const taskDefinitions: readonly {
    readonly id: ActivationTaskId
    readonly label: string
    readonly actionLabel: string
    readonly requiresHandler: boolean
    readonly onTrigger?: (() => boolean | Promise<boolean>) | undefined
  }[] = [
    {
      id: 'identity_template',
      label: copy.taskIdentityTemplate,
      actionLabel: copy.actionCompleteStep,
      requiresHandler: false,
    },
    {
      id: 'theme_sonic',
      label: copy.taskThemeSonic,
      actionLabel: copy.actionCompleteStep,
      requiresHandler: false,
    },
    {
      id: 'invite_member',
      label: copy.taskInviteMember,
      actionLabel: copy.actionInviteMember,
      requiresHandler: true,
      onTrigger: onInviteMember,
    },
    {
      id: 'first_message_or_call',
      label: copy.taskFirstMessageOrCall,
      actionLabel: copy.actionFirstMessageOrCall,
      requiresHandler: true,
      onTrigger: onFirstMessageOrCall,
    },
  ]

  return (
    <section
      aria-label={copy.checklistTitle}
      data-testid="onboarding-activation-checklist"
      className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-sunken p-3 motion-reduce:transition-none"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-c-ink">{copy.checklistTitle}</h3>
          <span
            role="status"
            data-testid="onboarding-activation-progress"
            className="rounded-full bg-c-surface px-2 py-1 font-mono text-xs font-semibold text-c-accent-ink tabular-nums"
          >
            {completedCount} / {total}
          </span>
        </div>
        <Button
          variant="tertiary"
          size="sm"
          aria-label={copy.checklistDismiss}
          onClick={handleDismiss}
        >
          {copy.checklistDismiss}
        </Button>
      </div>
      <div role="group" aria-label={copy.checklistTitle} className="flex flex-col gap-2">
        {taskDefinitions.map((task) => {
          const done = completedSet.has(task.id)
          const unavailable = task.requiresHandler && task.onTrigger === undefined
          return (
            <div
              key={task.id}
              data-activation-step={task.id}
              data-completed={done ? 'true' : 'false'}
              className={cx(
                'flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs motion-reduce:transition-none',
                done
                  ? 'border-c-border-soft bg-c-surface text-c-ink-3'
                  : 'border-c-border bg-c-surface text-c-ink'
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <span
                  aria-hidden="true"
                  className={cx(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    done ? 'bg-c-action text-c-on-inverse' : 'border border-c-border text-c-ink-3'
                  )}
                >
                  {done ? '✓' : '·'}
                </span>
                <span>{task.label}</span>
              </span>
              {done ? (
                <span className="px-2 py-1 text-xs font-semibold text-c-ink-3">
                  {copy.taskDone}
                </span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={unavailable || pendingTaskId === task.id}
                  onClick={() => {
                    void runActionableTask(task.id, task.requiresHandler, task.onTrigger)
                  }}
                >
                  {task.actionLabel}
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

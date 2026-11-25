import { useId } from 'react'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { cssProperty } from '@/ui/cssom'
import {
  validateWidgetCard,
  type WidgetBlock,
  type WidgetProgressTone,
  type WidgetTextTone,
} from './widgetSchema'

export interface SandboxedWidgetActionInvocation {
  readonly widgetId: string
  readonly actionId: string
  readonly value?: string | undefined
}

export interface SandboxedWidgetCardProps {
  readonly card: unknown
  readonly pendingActionId?: string | null | undefined
  readonly disabled?: boolean | undefined
  readonly invalidFallbackLabel?: string | undefined
  readonly onAction?: ((invocation: SandboxedWidgetActionInvocation) => void) | undefined
}

const TEXT_TONE_CLASS: Record<WidgetTextTone, string> = {
  default: 'text-sm font-regular text-c-ink',
  muted: 'text-sm font-regular text-c-ink-2',
  mono: 'font-mono text-xs text-c-ink-2',
}

const PROGRESS_BAR_FILL: Record<WidgetProgressTone, string> = {
  default: 'bg-c-action',
  success: 'bg-c-ok',
  warning: 'bg-c-warn',
  danger: 'bg-c-bad',
}

interface WidgetBlockViewProps {
  readonly block: WidgetBlock
  readonly widgetId: string
  readonly pendingActionId: string | null
  readonly disabled: boolean
  readonly onAction: ((invocation: SandboxedWidgetActionInvocation) => void) | undefined
}

function WidgetBlockView({
  block,
  widgetId,
  pendingActionId,
  disabled,
  onAction,
}: WidgetBlockViewProps) {
  const progressLabelId = useId()

  // Closed declarative switch: never raw HTML, never iframe, never inline style attributes.
  switch (block.type) {
    case 'header':
      return (
        <div className="flex flex-col gap-1">
          <h4 className="text-md font-semibold text-c-ink">{block.title}</h4>
          {block.subtitle !== undefined ? (
            <p className="text-xs font-regular text-c-ink-2">{block.subtitle}</p>
          ) : null}
        </div>
      )

    case 'text': {
      const tone = block.tone ?? 'default'
      return <p className={TEXT_TONE_CLASS[tone]}>{block.body}</p>
    }

    case 'kv_list':
      return (
        <dl className="grid grid-cols-1 gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3 sm:grid-cols-2">
          {block.items.map((item, idx) => (
            <div key={`${item.label}-${idx}`} className="flex flex-col gap-1">
              <dt className="text-xs font-medium text-c-ink-3">{item.label}</dt>
              <dd
                className={
                  item.mono
                    ? 'font-mono text-xs font-semibold text-c-ink'
                    : 'text-sm font-medium text-c-ink'
                }
              >
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      )

    case 'status_pill':
      return (
        <div>
          <StatusPill state={block.state}>{block.label}</StatusPill>
        </div>
      )

    case 'progress_bar': {
      const clamped = Math.min(100, Math.max(0, block.value))
      const tone = block.tone ?? 'default'
      const shownValue = block.valueText ?? `${Math.round(clamped)}%`
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span id={progressLabelId} className="text-xs font-medium text-c-ink-2">
              {block.label}
            </span>
            <span className="font-mono text-xs font-semibold text-c-ink">{shownValue}</span>
          </div>
          <div
            role="progressbar"
            aria-labelledby={progressLabelId}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clamped)}
            aria-valuetext={shownValue}
            className="h-2 w-full overflow-hidden rounded-full bg-c-muted"
          >
            <div
              data-testid={`widget-progress-fill-${widgetId}`}
              ref={cssProperty('width', `${clamped}%`)}
              className={`h-2 rounded-full transition-all duration-fast ${PROGRESS_BAR_FILL[tone]}`}
            />
          </div>
        </div>
      )
    }

    case 'button_row':
      return (
        <div className="flex flex-wrap items-center gap-2">
          {block.actions.map((action) => {
            const isLoading = pendingActionId === action.actionId
            return (
              <Button
                key={action.actionId}
                size="sm"
                variant={action.variant ?? 'secondary'}
                loading={isLoading}
                disabled={disabled || (pendingActionId !== null && !isLoading)}
                data-testid={`widget-action-${widgetId}-${action.actionId}`}
                onClick={() =>
                  onAction?.({
                    widgetId,
                    actionId: action.actionId,
                    value: action.value,
                  })
                }
              >
                {action.label}
              </Button>
            )
          })}
        </div>
      )

    case 'link_button':
      return (
        <div>
          <LinkButton
            href={block.href}
            size="sm"
            variant={block.variant ?? 'secondary'}
            target="_blank"
            rel="noopener noreferrer"
            disabled={disabled}
            data-testid={`widget-link-${widgetId}`}
          >
            {block.label}
          </LinkButton>
        </div>
      )
  }
}

export function SandboxedWidgetCard({
  card,
  pendingActionId = null,
  disabled = false,
  invalidFallbackLabel = 'Invalid widget card refused by sandbox',
  onAction,
}: SandboxedWidgetCardProps) {
  const titleId = useId()
  const validated = validateWidgetCard(card)

  if (!validated.ok) {
    return (
      <div
        role="alert"
        data-testid="sandboxed-widget-refused"
        data-error-code={validated.code}
        className="rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
      >
        {invalidFallbackLabel} ({validated.code})
      </div>
    )
  }

  const safeCard = validated.card
  return (
    <Card
      role="region"
      aria-labelledby={safeCard.title !== undefined ? titleId : undefined}
      aria-label={safeCard.title === undefined ? safeCard.widgetId : undefined}
      data-testid={`sandboxed-widget-${safeCard.widgetId}`}
    >
      <CardBody className="flex flex-col gap-3 p-4">
        {safeCard.title !== undefined ? (
          <div className="flex items-center justify-between gap-2 border-b border-c-border-soft pb-2">
            <h3 id={titleId} className="text-sm font-semibold text-c-ink">
              {safeCard.title}
            </h3>
            <span className="font-mono text-xs text-c-ink-3">{safeCard.schemaVersion}</span>
          </div>
        ) : null}
        {safeCard.blocks.map((block, index) => (
          <WidgetBlockView
            key={`${safeCard.widgetId}-${block.type}-${index}`}
            block={block}
            widgetId={safeCard.widgetId}
            pendingActionId={pendingActionId}
            disabled={disabled}
            onAction={onAction}
          />
        ))}
      </CardBody>
    </Card>
  )
}

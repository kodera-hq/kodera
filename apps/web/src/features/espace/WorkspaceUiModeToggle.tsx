import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { useTranslation } from 'react-i18next'
import { cx } from '../../ui/cx'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import { uiModeCopy, type WorkspaceUiMode } from './uiModePreference'

export function WorkspaceUiModeToggle({
  mode,
  onSelect,
}: {
  readonly mode: WorkspaceUiMode
  readonly onSelect: (next: WorkspaceUiMode) => void
}) {
  const { i18n } = useTranslation()
  const copy = uiModeCopy(i18n.resolvedLanguage)
  return (
    <div
      role="group"
      aria-label={copy.modeToggleGroup}
      data-testid="workspace-ui-mode-toggle"
      className="inline-flex gap-1 self-end"
    >
      {(['pro', 'messages'] as const).map((option) => {
        const active = mode === option
        return (
          <Tooltip
            key={option}
            names
            content={`${option === 'pro' ? copy.modePro : copy.modeSimple} (⌘⇧M)`}
          >
            <button
              type="button"
              data-testid={`workspace-ui-mode-${option}`}
              aria-label={option === 'pro' ? copy.modePro : copy.modeSimple}
              aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
              aria-pressed={active}
              onClick={() => {
                if (!active) onSelect(option)
              }}
              className={cx(
                'inline-flex h-8 w-8 items-center justify-center rounded-md text-xs font-semibold transition-colors duration-fast motion-reduce:transition-none',
                TOUCH_TARGET,
                'focus-visible:ring focus-visible:outline-hidden',
                active
                  ? 'bg-c-accent-soft text-c-accent-ink ring-1 ring-c-accent-ink ring-inset'
                  : 'text-c-ink-3 hover:bg-c-muted hover:text-c-ink-2'
              )}
            >
              <KoderaIcon name={option === 'pro' ? 'grid' : 'messages'} />
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

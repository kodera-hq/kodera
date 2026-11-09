import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { developerDocsCopy } from './developerDocsMessages'
export function DocumentationCopyButton({
  value,
  label,
  compact = false,
}: {
  value: string
  label: string
  compact?: boolean
}) {
  const { i18n } = useTranslation()
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  const [outcome, setOutcome] = useState<{ value: string; success: boolean } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        className={compact ? undefined : 'h-auto min-h-10 py-2'}
        size="sm"
        variant="secondary"
        aria-label={label}
        onClick={() => {
          if (!navigator.clipboard) {
            setOutcome({ value, success: false })
            return
          }
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              if (alive.current) setOutcome({ value, success: true })
            })
            .catch(() => {
              if (alive.current) setOutcome({ value, success: false })
            })
        }}
      >
        <span className="text-left whitespace-normal">{compact ? copy.copy : label}</span>
      </Button>
      {outcome?.value === value ? (
        <span role="status" className="text-xs text-c-ink-2">
          {outcome.success ? copy.copied : copy.copyError}
        </span>
      ) : null}
    </div>
  )
}

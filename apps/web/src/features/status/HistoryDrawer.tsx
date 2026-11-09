// "Historique" (docs/specs/02-status.md §4.5): a compact table, one row per
// day, three cells — web, calls, console, the same three names the header
// pill uses (§9) — each with a `StatusPill` and
// the minutes of degradation. No graphs at launch (§13).

import { useTranslation } from 'react-i18next'
import { formatDate } from '@/i18n/format'
import { Button } from '@/ui/Button/Button'
import type { FocusTarget } from '@/ui/returnFocus'
import { Drawer } from '@/ui/Drawer/Drawer'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { Skeleton } from '@/ui/Skeleton/Skeleton'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from '@/ui/Table/Table'
import { componentNameKey, componentPillState, componentStateLabelKey } from './components'
import type { ComponentState, StatusComponent } from './components'

export interface HistoryDayComponent {
  key: StatusComponent['key']
  state: ComponentState | 'no_data'
  degradedMinutes: number
  downMinutes: number
}

export interface HistoryDay {
  date: string
  components: readonly HistoryDayComponent[]
}

export interface HistoryDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  days: readonly HistoryDay[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  returnFocusTo?: FocusTarget
}

const COLUMN_KEYS: readonly StatusComponent['key'][] = ['web', 'calls', 'console']

function HistoryCell({ component }: { component: HistoryDayComponent | undefined }) {
  const { t } = useTranslation()
  if (component === undefined || component.state === 'no_data') {
    return <TableCell className="text-c-ink-3">{t('console.status.history.empty-day')}</TableCell>
  }
  const minutes = component.degradedMinutes + component.downMinutes
  return (
    <TableCell>
      <div className="flex flex-col gap-1">
        <StatusPill state={componentPillState(component.state)}>
          {t(componentStateLabelKey(component.state))}
        </StatusPill>
        {minutes > 0 ? (
          <span className="text-xs text-c-ink-3">
            {t('console.status.history.label-degraded-minutes', { minutes })}
          </span>
        ) : null}
      </div>
    </TableCell>
  )
}

export function HistoryDrawer({
  open,
  onOpenChange,
  days,
  isLoading,
  isError,
  onRetry,
  returnFocusTo,
}: HistoryDrawerProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={t('console.status.history.title')}
      closeLabel={t('console.common.action-close')}
      size="lg"
      {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
    >
      {isLoading ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : isError ? (
        <div className="flex flex-col gap-3">
          <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
          <div>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('console.common.action-retry')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Table caption={t('console.status.history.title')}>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('console.status.history.title')}</TableHeaderCell>
                {COLUMN_KEYS.map((key) => (
                  <TableHeaderCell key={key} status>
                    {t(componentNameKey(key))}
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.date}>
                  <TableCell>{formatDate(day.date, locale)}</TableCell>
                  {COLUMN_KEYS.map((key) => (
                    <HistoryCell
                      key={key}
                      component={day.components.find((entry) => entry.key === key)}
                    />
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-c-ink-3">{t('console.status.history.hint-schedule')}</p>
        </div>
      )}
    </Drawer>
  )
}

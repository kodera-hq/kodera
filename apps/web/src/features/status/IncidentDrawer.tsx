// The incident detail (docs/specs/02-status.md §4.4). `title_key`,
// `impact_key` and `body_key` are message-catalogue keys the Core API
// chooses from a closed set (§6) — this console's own catalogue does not
// yet carry entries under those exact names (a gap reported alongside this
// unit's work, not invented here), so each one is looked up through
// `i18n.exists` and falls back to a generic, catalogued sentence rather
// than ever rendering an unregistered key's text raw or leaving a blank.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '@/i18n'
import { formatTime } from '@/i18n/format'
import { Button } from '@/ui/Button/Button'
import { DefinitionList } from '@/ui/DefinitionList/DefinitionList'
import { Drawer } from '@/ui/Drawer/Drawer'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'

export interface IncidentUpdate {
  at: string
  bodyKey: string
}

export interface IncidentDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger?: ReactNode
  componentLabel: string
  since: string | undefined
  nextUpdateAt: string | undefined
  impactKey: string | undefined
  updates: readonly IncidentUpdate[]
  isError: boolean
  onOpenTicket: () => void
}

/**
 * `key` is a runtime string — `title_key`/`impact_key`/`body_key` off the
 * wire, not one of this catalogue's own keys — so `i18n.exists` is the
 * check, and the cast on the line it guards is what that check earns: only
 * ever reached once the key is confirmed to be a registered one.
 */
function useKnownOrFallback() {
  const { t, i18n } = useTranslation()
  return (key: string | undefined, fallback: MessageKey): string => {
    if (key !== undefined && i18n.exists(key)) return t(key as MessageKey)
    return t(fallback)
  }
}

export function IncidentDrawer({
  open,
  onOpenChange,
  trigger,
  componentLabel,
  since,
  nextUpdateAt,
  impactKey,
  updates,
  isError,
  onOpenTicket,
}: IncidentDrawerProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'fr'
  const knownOrFallback = useKnownOrFallback()

  const description = [
    since === undefined
      ? undefined
      : t('console.status.incident.label-since', { time: formatTime(since, locale) }),
    nextUpdateAt === undefined
      ? undefined
      : t('console.status.incident.label-next-update', { time: formatTime(nextUpdateAt, locale) }),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ')

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      {...(trigger === undefined ? {} : { trigger })}
      title={t('console.status.incident.title', { component: componentLabel })}
      {...(description === '' ? {} : { description })}
      closeLabel={t('console.common.action-close')}
      footer={
        <>
          <Button variant="secondary" onClick={onOpenTicket}>
            {t('console.status.incident.action-open-ticket')}
          </Button>
        </>
      }
    >
      {isError ? (
        <div className="flex flex-col gap-3">
          <InlineAlert kind="error">{t('console.status.incident.error-unavailable')}</InlineAlert>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="text-sm font-semibold text-c-ink">
              {t('console.status.incident.title-impact')}
            </h3>
            <p className="mt-1 text-sm text-c-ink-3">
              {knownOrFallback(impactKey, 'console.status.incident.body-impact-generic')}
            </p>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-c-ink">
              {t('console.status.incident.title-actions')}
            </h3>
            {updates.length === 0 ? (
              <p className="mt-1 text-sm text-c-ink-3">
                {t('console.status.incident.empty-updates')}
              </p>
            ) : (
              <DefinitionList
                className="mt-2"
                items={updates.map((update) => ({
                  term: formatTime(update.at, locale),
                  description: knownOrFallback(
                    update.bodyKey,
                    'console.status.incident.body-update-generic'
                  ),
                }))}
              />
            )}
          </section>
        </div>
      )}
    </Drawer>
  )
}

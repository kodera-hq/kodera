import { useTranslation } from 'react-i18next'
import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import type { DocumentBacklinkItem } from './wikilinks'

export function BacklinksFooter({
  backlinks,
  onSelectDocument,
}: {
  readonly backlinks: readonly DocumentBacklinkItem[]
  readonly onSelectDocument: (documentId: string) => void
}) {
  const { t } = useTranslation()

  return (
    <footer
      aria-label={t('console.docs.collab.backlinks-title')}
      data-testid="docs-backlinks-footer"
      className="flex flex-col gap-2 border-t border-c-border-soft bg-c-sunken p-3"
    >
      <span className="text-xs font-semibold text-c-ink-2">
        {t('console.docs.collab.backlinks-title')} ({backlinks.length})
      </span>
      {backlinks.length === 0 ? (
        <p className="text-xs text-c-ink-3">{t('console.docs.collab.backlinks-empty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {backlinks.map((item) => (
            <li key={item.documentId}>
              <button
                type="button"
                onClick={() => onSelectDocument(item.documentId)}
                aria-label={t('console.docs.collab.wikilink-open', { title: item.title })}
                className={cx(
                  'inline-flex min-h-8 items-center gap-1 rounded-md border border-c-border bg-c-surface px-3 py-1 text-xs font-medium text-c-accent-ink hover:bg-c-accent-soft focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET
                )}
              >
                <span aria-hidden="true" className="font-mono text-c-ink-3">
                  [[
                </span>
                <span>{item.title}</span>
                <span aria-hidden="true" className="font-mono text-c-ink-3">
                  ]]
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </footer>
  )
}

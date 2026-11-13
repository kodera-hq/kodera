// A link's preview under its message: text only, checked (`safeUnfurl.ts`), and a plain link that
// opens in a new tab without telling the site where it came from.

import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useMessagingOrganisation } from '../organisationContext'
import { firstLink, unfurlCache, type UnfurlCache } from './unfurlCache'

export function UnfurlCard({ body, cache = unfurlCache }: { body: string; cache?: UnfurlCache }) {
  const { t } = useTranslation()
  const organisationId = useMessagingOrganisation()
  const url = firstLink(body)
  useEffect(() => {
    if (organisationId !== null && url !== null) cache.request(organisationId, url)
  }, [cache, organisationId, url])
  const card = useSyncExternalStore(cache.subscribe, () =>
    organisationId === null || url === null ? null : cache.card(organisationId, url)
  )
  if (card === null || card === undefined) return null
  return (
    <a
      href={card.href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      aria-label={t('console.workspace.unfurl.label-link', { title: card.title || card.host })}
      className="mt-2 flex max-w-[480px] flex-col gap-1 rounded-md border border-l-4 border-c-border border-l-c-accent-ink bg-c-sunken px-3 py-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
    >
      <span className="text-xs text-c-ink-3">{card.siteName || card.host}</span>
      {card.title ? <span className="text-sm font-semibold text-c-ink">{card.title}</span> : null}
      {card.description ? (
        <span className="line-clamp-3 text-sm text-c-ink-2">{card.description}</span>
      ) : null}
      <span className="text-xs text-c-ink-3">{card.host}</span>
    </a>
  )
}

import { useNarrowViewport } from '@/app/useNarrowViewport'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { developerDocsCopy } from './developerDocsMessages'
import {
  buildLlmsText,
  documentationPages,
  exportDocumentationPage,
  sourceUrl,
  developerDocsContent,
  type CommunityChannelId,
} from './documentationExport'
import { DocumentationCopyButton } from './DocumentationCopyButton'
import { WebhookSignatureLab } from './WebhookSignatureLab'
import { CommunityPreviewDialog, useCommunityPreview } from './communityPreview'
export function DeveloperDocsHub({
  onOpenSupportChannel,
}: {
  onOpenSupportChannel?: ((id: CommunityChannelId) => void) | undefined
}) {
  const { i18n } = useTranslation()
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  const pages = documentationPages(i18n.resolvedLanguage)
  const [activeId, setActiveId] = useState('quickstart')
  const [query, setQuery] = useState('')
  const narrow = useNarrowViewport()
  const id = useId()
  const community = useCommunityPreview()
  const active = pages.find((page) => page.id === activeId) ?? pages[0]!
  const normalized = query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .trim()
  const filtered = pages.filter((page) =>
    JSON.stringify(page)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .includes(normalized)
  )
  const markdown = exportDocumentationPage(active)
  const llms = useMemo(() => buildLlmsText(), [])
  return (
    <div className="@container min-w-0" data-testid="developer-docs-hub">
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 @4xl:grid-cols-12">
        <aside className="min-w-0 @4xl:sticky @4xl:top-0 @4xl:col-span-3 @4xl:border-r @4xl:border-c-border-soft @4xl:pr-4">
          <p className="mb-4 text-sm font-semibold text-c-ink">{copy.title}</p>
          <label className="flex flex-col gap-2 text-xs text-c-ink-2">
            {copy.search}
            <input
              type="search"
              value={query}
              maxLength={128}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded-md border border-c-border-input bg-c-surface p-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </label>
          <nav aria-label={copy.navigation} className="mt-4 flex flex-col gap-2">
            {narrow && !query.trim() ? (
              <label className="flex flex-col gap-2 text-xs text-c-ink-2">
                {copy.choosePage}
                <select
                  value={activeId}
                  onChange={(event) => setActiveId(event.target.value)}
                  className="w-full rounded-md border border-c-border-input bg-c-surface p-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
                >
                  {pages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              filtered.map((page) => (
                <Button
                  className="h-auto min-h-10 py-2"
                  key={page.id}
                  variant={activeId === page.id ? 'primary' : 'tertiary'}
                  aria-current={activeId === page.id ? 'page' : undefined}
                  onClick={() => setActiveId(page.id)}
                >
                  <span className="w-full text-left text-sm whitespace-normal">{page.title}</span>
                </Button>
              ))
            )}
          </nav>
          {filtered.length === 0 ? (
            <p role="status" className="mt-3 text-sm text-c-ink-2">
              {copy.empty}
            </p>
          ) : null}
          <p className="mt-6 border-t border-c-border-soft pt-4 font-mono text-xs text-c-ink-2">
            Core {developerDocsContent.versions.core}
            <br />
            SDK {developerDocsContent.versions.sdk}
          </p>
        </aside>
        <article aria-labelledby={`${id}-title`} className="min-w-0 @4xl:col-span-6">
          <header className="mb-6 border-b border-c-border-soft pb-6">
            <p className="mb-3 text-xs font-medium text-c-ink-2">{copy.local}</p>
            <h2 id={`${id}-title`} className="text-2xl font-semibold text-c-ink">
              {active.title}
            </h2>
            <p className="mt-3 text-md text-c-ink-2">{active.summary}</p>
          </header>
          {active.sections.map((section) => (
            <section key={`${active.id}-${section.id}`} className="mb-8">
              <h3
                id={`${id}-${active.id}-${section.id}`}
                tabIndex={-1}
                className="mb-3 scroll-mt-4 text-lg font-semibold text-c-ink focus-visible:ring focus-visible:outline-hidden"
              >
                {section.title}
              </h3>
              {section.paragraphs.map((paragraph) => (
                <p
                  key={paragraph}
                  className="mb-3 text-sm leading-relaxed break-words text-c-ink-2"
                >
                  {paragraph}
                </p>
              ))}
              {section.callout ? (
                <aside className="my-4 border-l-2 border-c-accent-ink bg-c-accent-soft p-4 text-sm leading-relaxed text-c-ink">
                  {section.callout}
                </aside>
              ) : null}
              {section.code ? (
                <div className="min-w-0 overflow-hidden rounded-md border border-c-border bg-c-sunken">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-c-border-soft p-3">
                    <span className="font-mono text-xs text-c-ink-2">{section.language}</span>
                    <DocumentationCopyButton
                      key={section.code}
                      value={section.code}
                      label={`${copy.copy} · ${section.title}`}
                      compact
                    />
                  </div>
                  <pre
                    role="region"
                    aria-label={`${section.language} · ${section.title}`}
                    tabIndex={0}
                    className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-c-ink focus-visible:ring focus-visible:outline-hidden"
                  >
                    <code>{section.code}</code>
                  </pre>
                </div>
              ) : null}
            </section>
          ))}
          {active.id === 'extensions' ? (
            <section aria-label={copy.catalogue} className="mb-6 border-t border-c-border pt-4">
              <h3 className="mb-3 text-lg font-semibold">{copy.catalogue}</h3>
              <ul className="flex flex-col gap-3">
                {developerDocsContent.connectors.map((connector) => (
                  <li key={connector.slug} className="min-w-0">
                    <LinkButton inline target="_blank" href={sourceUrl(connector.path)}>
                      {connector.name}
                    </LinkButton>
                    <p className="font-mono text-xs break-words text-c-ink-2">{connector.slug}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {active.id === 'extensions' || active.id === 'api' ? (
            <WebhookSignatureLab key={active.id} />
          ) : null}
        </article>
        <aside className="flex min-w-0 flex-col gap-6 border-t border-c-border-soft pt-4 @4xl:sticky @4xl:top-0 @4xl:col-span-3 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-4">
          <nav aria-label={copy.outline}>
            <h3 className="mb-3 text-sm font-semibold">{copy.outline}</h3>
            <ul className="flex flex-col gap-3">
              {active.sections.map((section) => (
                <li key={section.id}>
                  <LinkButton
                    inline
                    className="text-sm"
                    href={`#${id}-${active.id}-${section.id}`}
                    onClick={(event) => {
                      event.preventDefault()
                      const target = document.getElementById(`${id}-${active.id}-${section.id}`)
                      target?.scrollIntoView?.({
                        block: 'start',
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                          ? 'auto'
                          : 'smooth',
                      })
                      target?.focus({ preventScroll: true })
                    }}
                  >
                    {section.title}
                  </LinkButton>
                </li>
              ))}
            </ul>
          </nav>
          <section aria-label={copy.actions} className="flex min-w-0 flex-col gap-4">
            <DocumentationCopyButton key={markdown} value={markdown} label={copy.markdown} />
            <h3 className="text-sm font-semibold">{copy.source}</h3>
            <p className="text-xs text-c-ink-2">{copy.sourceNote}</p>
            {active.sources.map((path) => (
              <LinkButton
                key={path}
                inline
                href={sourceUrl(path)}
                target="_blank"
                className="font-mono text-xs break-words"
              >
                {path}
              </LinkButton>
            ))}
            <Button
              onClick={() =>
                (onOpenSupportChannel ?? community.open)(
                  active.supportChannel as CommunityChannelId
                )
              }
            >
              <span className="text-left text-sm whitespace-normal">{copy.help}</span>
            </Button>
          </section>
          <details className="min-w-0 border-t border-c-border-soft pt-4">
            <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:ring focus-visible:outline-hidden">
              {copy.llms}
            </summary>
            <div className="mt-3 flex min-w-0 flex-col gap-3">
              <DocumentationCopyButton value={llms} label={copy.copyLlms} />
              <LinkButton inline href="/llms.txt" target="_blank">
                {copy.openLlms}
              </LinkButton>
              <pre
                data-testid="llms-preview"
                role="region"
                aria-label={copy.llms}
                tabIndex={0}
                className="max-h-[calc(100vh/3)] overflow-auto rounded-md border border-c-border bg-c-sunken p-3 font-mono text-xs break-words whitespace-pre-wrap focus-visible:ring focus-visible:outline-hidden"
              >
                {llms}
              </pre>
            </div>
          </details>
        </aside>
      </div>
      <CommunityPreviewDialog controller={community} onOpenDocs={community.close} />
    </div>
  )
}

import { MarkdownDraftEditor } from './MarkdownDraftEditor'
import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react'
import { DeveloperDocsHub } from './DeveloperDocsHub'
import { developerDocsCopy } from './developerDocsMessages'
import type { CommunityChannelId } from './documentationExport'

const LazyWhiteboardCanvas = lazy(() =>
  import('@/features/whiteboard/WhiteboardCanvas').then((m) => ({ default: m.WhiteboardCanvas }))
)

import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
import type { ChannelDocsPadDescriptor } from './types'
import {
  buildChannelDocsPadUrl,
  buildTenantDocsOrigin,
  slugifyDocsSegment,
  validateExternalDocsUrl,
} from './url'

export type DocsWorkspaceView = 'team' | 'pages' | 'whiteboard' | 'developer'

export interface DocsWorkspacePanelProps {
  readonly view?: DocsWorkspaceView | undefined
  readonly onViewChange?: ((view: DocsWorkspaceView) => void) | undefined
  readonly teamPadsSlot?: ReactNode
  readonly workspacePagesSlot?: ReactNode
  readonly whiteboardSlot?: ReactNode
  readonly onOpenSupportChannel?: ((id: CommunityChannelId) => void) | undefined
  readonly draftContent?: string | undefined
  readonly onDraftContentChange?: ((content: string) => void) | undefined
  readonly tenantSlug: string
  readonly channelId: string
  readonly channelName: string
  readonly baseDomain?: string | undefined
  readonly pads?: readonly ChannelDocsPadDescriptor[] | undefined
  readonly activePadId?: string | undefined
  readonly onSelectPad?: ((padId: string) => void) | undefined
  readonly onCreatePad?: ((pad: ChannelDocsPadDescriptor) => void) | undefined
  readonly onCopyPadLink?: ((url: string) => void | Promise<void>) | undefined
}

export function DocsWorkspacePanel({
  view,
  onViewChange,
  teamPadsSlot,
  workspacePagesSlot,
  whiteboardSlot,
  onOpenSupportChannel,
  draftContent,
  onDraftContentChange,
  tenantSlug,
  channelId,
  channelName,
  baseDomain,
  pads = [],
  activePadId,
  onSelectPad,
  onCreatePad,
  onCopyPadLink,
}: DocsWorkspacePanelProps) {
  const { t, i18n } = useTranslation()
  const copy = developerDocsCopy(i18n.resolvedLanguage)
  const whiteboardTabLabel = i18n.resolvedLanguage === 'en' ? 'Whiteboard' : 'Tableau blanc'
  // Same rule as the screen's: without channel pads to draw, the panel opens on the Pages it can
  // actually show rather than on the placeholder card.
  const [internalView, setInternalView] = useState<DocsWorkspaceView>(
    teamPadsSlot === undefined && workspacePagesSlot !== undefined ? 'pages' : 'team'
  )
  const selectedView = view ?? internalView
  const headingId = useId()
  const newPadInputId = useId()

  // Both of these refuse a slug or a domain they cannot make an address from, by throwing
  // (`url.ts`). They run while the panel is drawn and the only error boundary above is the
  // organisation route's, so an unexpected tenant slug replaced the whole shell with the error
  // page — for a member who may never have opened « Docs ». A refusal is a pad that does not
  // exist, not a broken console.
  const docsOrigin = useMemo(() => {
    try {
      return buildTenantDocsOrigin(tenantSlug, baseDomain)
    } catch {
      return null
    }
  }, [tenantSlug, baseDomain])

  const defaultPad = useMemo<ChannelDocsPadDescriptor | null>(() => {
    try {
      const url = buildChannelDocsPadUrl({ tenantSlug, channelId, channelName, baseDomain })
      return {
        id: `default-${slugifyDocsSegment(channelId)}`,
        title: t('console.docs.panel.default-pad-title', { channel: channelName }),
        channelId,
        channelName,
        padSlug: slugifyDocsSegment(channelName),
        url,
      }
    } catch {
      return null
    }
  }, [tenantSlug, channelId, channelName, baseDomain, t])

  const allPads = useMemo<readonly ChannelDocsPadDescriptor[]>(() => {
    if (pads.length > 0) return pads
    // No pad was supplied: the deployment serves none for this channel, and a synthesised
    // `docs.<host>` address would be a link to nothing. The draft below is drawn on its own.
    return []
  }, [pads])

  const [selectedPadId, setSelectedPadId] = useState<string | undefined>(activePadId)
  const [draftTitle, setDraftTitle] = useState('')
  const [copiedPadId, setCopiedPadId] = useState<string | null>(null)
  // Live co-editing is in development: this is a draft held in this component only, and every
  // label says so — nothing here claims a synchronised or shared document.
  const [localInlineContent, setLocalInlineContent] = useState<string>(
    () =>
      `## ${t('console.docs.panel.draft-heading', { channel: channelName })}\n- [ ] ${t('console.docs.panel.draft-first-item')}`
  )
  const inlineContent = draftContent ?? localInlineContent
  const setInlineContent = (value: string | ((previous: string) => string)) => {
    const content = typeof value === 'function' ? value(inlineContent) : value
    if (new TextEncoder().encode(content).length > 65_536) return
    setLocalInlineContent(content)
    onDraftContentChange?.(content)
  }
  const [inlineSavedLabel, setInlineSavedLabel] = useState<string>(() =>
    t('console.docs.panel.draft-initial')
  )

  const currentPad = useMemo<ChannelDocsPadDescriptor | undefined>(() => {
    const targetId = activePadId ?? selectedPadId
    if (targetId !== undefined) {
      const found = allPads.find((pad) => pad.id === targetId)
      if (found !== undefined) return found
    }
    return allPads[0]
  }, [allPads, activePadId, selectedPadId])

  /** The pad's address, once checked against this tenant's own origin; `null` for anything else. */
  const validatedCurrentUrl = useMemo(() => {
    if (currentPad === undefined || docsOrigin === null) return null
    const check = validateExternalDocsUrl(currentPad.url, docsOrigin)
    return check.ok ? check.normalizedUrl : (defaultPad?.url ?? null)
  }, [currentPad, docsOrigin, defaultPad])

  const handleSelectPad = (padId: string) => {
    setSelectedPadId(padId)
    setCopiedPadId(null)
    onSelectPad?.(padId)
  }

  const handleCopy = async () => {
    if (currentPad === undefined || validatedCurrentUrl === null) return
    try {
      if (onCopyPadLink !== undefined) {
        await onCopyPadLink(validatedCurrentUrl)
      } else if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(validatedCurrentUrl)
      } else {
        setCopiedPadId(null)
        return
      }
      setCopiedPadId(currentPad.id)
    } catch {
      setCopiedPadId(null)
    }
  }

  const handleCreatePad = () => {
    const trimmed = draftTitle.trim()
    if (trimmed.length === 0) return
    const docSlug = slugifyDocsSegment(trimmed)
    const docId = `${channelId}-${docSlug}`
    const url = buildChannelDocsPadUrl({
      tenantSlug,
      channelId,
      channelName: trimmed,
      docId,
      baseDomain,
    })
    const created: ChannelDocsPadDescriptor = {
      id: docId,
      title: trimmed,
      channelId,
      channelName,
      padSlug: docSlug,
      url,
    }
    setDraftTitle('')
    setSelectedPadId(created.id)
    onCreatePad?.(created)
  }

  return (
    <section
      aria-label={copy.workspace}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
    >
      <div
        role="group"
        aria-label={copy.views}
        className="flex flex-wrap gap-2 border-b border-c-border-soft pb-2"
      >
        {/* « Pages » is drawn only where its slot is supplied. « Espace Docs » always is: without
            channel pads it is a draft held in this browser, which is a thing the member can use —
            what is not drawn there any more is the address of a pad the deployment does not
            serve. */}
        {(workspacePagesSlot !== undefined
          ? (['team', 'pages', 'whiteboard', 'developer'] as const)
          : (['team', 'whiteboard', 'developer'] as const)
        ).map((next) => (
          <button
            key={next}
            type="button"
            className={cx(
              'inline-flex min-h-10 max-w-full items-center justify-center rounded-md border px-3 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET,
              selectedView === next
                ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
            )}
            aria-pressed={selectedView === next}
            onClick={() => {
              setInternalView(next)
              onViewChange?.(next)
            }}
          >
            <span className="text-left text-sm whitespace-normal">
              {next === 'team'
                ? copy.team
                : next === 'pages'
                  ? t('console.docs.collab.tree-title')
                  : next === 'whiteboard'
                    ? whiteboardTabLabel
                    : copy.developer}
            </span>
          </button>
        ))}
      </div>
      {selectedView === 'developer' ? (
        <DeveloperDocsHub onOpenSupportChannel={onOpenSupportChannel} />
      ) : selectedView === 'whiteboard' ? (
        (whiteboardSlot ?? (
          <Suspense
            fallback={
              <p role="status" className="py-4 text-xs text-c-ink-3">
                {whiteboardTabLabel}
              </p>
            }
          >
            <LazyWhiteboardCanvas participantName={channelName} />
          </Suspense>
        ))
      ) : selectedView === 'pages' && workspacePagesSlot !== undefined ? (
        workspacePagesSlot
      ) : (
        (teamPadsSlot ?? (
          <Card>
            <CardBody className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-c-ink">
                    <ModuleGlyph name="docs" />
                  </span>
                  <div className="flex flex-col gap-1">
                    <h2 id={headingId} className="text-lg font-semibold text-c-ink">
                      {t('console.docs.panel.title')}
                    </h2>
                    <p className="text-sm font-regular text-c-ink-2">
                      {t('console.docs.panel.label-active-channel')}{' '}
                      <span className="font-medium text-c-ink">{channelName}</span>
                    </p>
                  </div>
                </div>
              </div>

              <div
                role="region"
                aria-label={t('console.docs.panel.region-label')}
                className="flex flex-col gap-3 rounded-md border border-c-border bg-c-sunken p-4"
              >
                {/* The pad's own address, and only where there is one. A deployment that serves
                    no pad for this channel gets the draft below on its own, rather than a link
                    to an address nothing answers on. */}
                {currentPad === undefined || validatedCurrentUrl === null ? null : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="text-md font-semibold text-c-ink">{currentPad.title}</span>
                      <span className="font-mono text-xs text-c-ink-3">{validatedCurrentUrl}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void handleCopy()
                        }}
                        aria-label={t('console.docs.panel.action-copy-link-named', {
                          title: currentPad.title,
                        })}
                      >
                        {copiedPadId === currentPad.id
                          ? t('console.docs.panel.label-link-copied')
                          : t('console.docs.panel.action-copy-link')}
                      </Button>
                      <LinkButton
                        size="sm"
                        variant="primary"
                        href={validatedCurrentUrl}
                        target="_blank"
                        aria-label={t('console.docs.panel.action-open-named', {
                          title: currentPad.title,
                        })}
                      >
                        {t('console.docs.panel.action-open')}
                      </LinkButton>
                    </div>
                  </div>
                )}

                <div
                  data-testid="docs-inline-collaborative-editor"
                  className="flex flex-col gap-3 rounded-md border border-c-border-soft bg-c-surface p-3"
                >
                  {/* Single concise local-draft banner instead of 5 redundant disclaimers */}
                  <div
                    data-testid="docs-inline-notice"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-sunken px-3 py-2 text-xs text-c-ink-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill state="info">
                        {t('console.docs.panel.status-in-development')}
                      </StatusPill>
                      <span>{t('console.docs.panel.editor-notice')}</span>
                    </div>
                    <span
                      data-testid="docs-inline-save-badge"
                      className="font-mono text-xs text-c-ink-3"
                    >
                      {inlineSavedLabel}
                    </span>
                  </div>

                  <MarkdownDraftEditor
                    title={
                      currentPad?.title ??
                      t('console.docs.panel.default-pad-title', { channel: channelName })
                    }
                    channelName={channelName}
                    content={inlineContent}
                    onChange={(content) => {
                      setInlineContent(content)
                      setInlineSavedLabel(t('console.docs.panel.draft-edited'))
                    }}
                    sourceLabel={t('console.docs.panel.editor-label')}
                    sourceTestId="docs-inline-textarea"
                    viewToggle
                    hideLocalDisclaimers
                  />
                </div>
              </div>

              {allPads.length > 1 ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-c-ink-2">
                    {t('console.docs.panel.pads-count', { count: allPads.length })}
                  </span>
                  <ul
                    aria-label={t('console.docs.panel.pads-label')}
                    className="flex flex-col gap-2"
                  >
                    {allPads.map((pad) => {
                      const isCurrent = pad.id === currentPad?.id
                      return (
                        <li key={pad.id}>
                          <button
                            type="button"
                            aria-current={isCurrent ? 'true' : undefined}
                            onClick={() => handleSelectPad(pad.id)}
                            className={
                              isCurrent
                                ? 'flex w-full items-center justify-between gap-3 rounded-md border border-c-accent-ink bg-c-accent-soft px-3 py-2 text-left text-sm font-semibold text-c-accent-ink'
                                : 'flex w-full items-center justify-between gap-3 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-left text-sm font-medium text-c-ink hover:bg-c-muted'
                            }
                          >
                            <span>{pad.title}</span>
                            {pad.updatedAtLabel !== undefined ? (
                              <span className="font-mono text-xs text-c-ink-3">
                                {pad.updatedAtLabel}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}

              {onCreatePad !== undefined ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-c-border-soft pt-3">
                  <div className="flex flex-1 flex-col gap-1">
                    <label htmlFor={newPadInputId} className="text-xs font-medium text-c-ink-2">
                      {t('console.docs.panel.label-new-pad')}
                    </label>
                    <input
                      id={newPadInputId}
                      type="text"
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder={t('console.docs.panel.placeholder-new-pad')}
                      className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={draftTitle.trim().length === 0}
                    onClick={handleCreatePad}
                  >
                    {t('console.docs.panel.action-create-pad')}
                  </Button>
                </div>
              ) : null}
            </CardBody>
          </Card>
        ))
      )}
    </section>
  )
}

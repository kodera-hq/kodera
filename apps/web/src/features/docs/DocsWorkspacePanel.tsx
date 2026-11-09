import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { DeveloperDocsHub } from './DeveloperDocsHub'
import { developerDocsCopy } from './developerDocsMessages'
import type { CommunityChannelId } from './documentationExport'

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

export type DocsWorkspaceView = 'team' | 'developer'

export interface DocsWorkspacePanelProps {
  readonly view?: DocsWorkspaceView | undefined
  readonly onViewChange?: ((view: DocsWorkspaceView) => void) | undefined
  readonly teamPadsSlot?: ReactNode
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
  const [internalView, setInternalView] = useState<DocsWorkspaceView>('team')
  const selectedView = view ?? internalView
  const headingId = useId()
  const newPadInputId = useId()

  const docsOrigin = useMemo(
    () => buildTenantDocsOrigin(tenantSlug, baseDomain),
    [tenantSlug, baseDomain]
  )

  const defaultPad = useMemo<ChannelDocsPadDescriptor>(() => {
    const url = buildChannelDocsPadUrl({
      tenantSlug,
      channelId,
      channelName,
      baseDomain,
    })
    return {
      id: `default-${slugifyDocsSegment(channelId)}`,
      title: t('console.docs.panel.default-pad-title', { channel: channelName }),
      channelId,
      channelName,
      padSlug: slugifyDocsSegment(channelName),
      url,
    }
  }, [tenantSlug, channelId, channelName, baseDomain, t])

  const allPads = useMemo<readonly ChannelDocsPadDescriptor[]>(() => {
    if (pads.length === 0) return [defaultPad]
    return pads
  }, [pads, defaultPad])

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

  const currentPad = useMemo<ChannelDocsPadDescriptor>(() => {
    const targetId = activePadId ?? selectedPadId
    if (targetId !== undefined) {
      const found = allPads.find((pad) => pad.id === targetId)
      if (found !== undefined) return found
    }
    return allPads[0] ?? defaultPad
  }, [allPads, activePadId, selectedPadId, defaultPad])

  const validatedCurrentUrl = useMemo(() => {
    const check = validateExternalDocsUrl(currentPad.url, docsOrigin)
    return check.ok ? check.normalizedUrl : defaultPad.url
  }, [currentPad.url, docsOrigin, defaultPad.url])

  const handleSelectPad = (padId: string) => {
    setSelectedPadId(padId)
    setCopiedPadId(null)
    onSelectPad?.(padId)
  }

  const handleCopy = async () => {
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
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
    >
      <div
        role="group"
        aria-label={copy.views}
        className="flex flex-wrap gap-2 border-b border-c-border-soft pb-4"
      >
        {(['team', 'developer'] as const).map((next) => (
          <button
            key={next}
            type="button"
            className={cx(
              'inline-flex min-h-10 max-w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-semibold focus-visible:ring focus-visible:outline-hidden',
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
              {next === 'team' ? copy.team : copy.developer}
            </span>
          </button>
        ))}
      </div>
      {selectedView === 'developer' ? (
        <DeveloperDocsHub onOpenSupportChannel={onOpenSupportChannel} />
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
                <StatusPill state="info">
                  {t('console.docs.panel.status-in-development')}
                </StatusPill>
              </div>

              <div
                role="region"
                aria-label={t('console.docs.panel.region-label')}
                className="flex flex-col gap-3 rounded-md border border-c-border bg-c-sunken p-4"
              >
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

                <div
                  data-testid="docs-inline-collaborative-editor"
                  className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-surface p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-c-ink">
                      {t('console.docs.panel.editor-title')}
                    </span>
                    <span
                      data-testid="docs-inline-save-badge"
                      className="font-mono text-xs text-c-ink-3"
                    >
                      {inlineSavedLabel}
                    </span>
                  </div>
                  <p data-testid="docs-inline-notice" className="text-xs text-c-ink-2">
                    {t('console.docs.panel.editor-notice')}
                  </p>

                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setInlineContent(
                          (prev) => `${prev}\n## ${t('console.docs.panel.snippet-heading')}`
                        )
                        setInlineSavedLabel(t('console.docs.panel.draft-edited'))
                      }}
                    >
                      {t('console.docs.panel.action-insert-heading')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setInlineContent(
                          (prev) => `${prev}\n- [ ] ${t('console.docs.panel.snippet-action')}`
                        )
                        setInlineSavedLabel(t('console.docs.panel.draft-edited'))
                      }}
                    >
                      {t('console.docs.panel.action-insert-action')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setInlineContent(
                          (prev) => `${prev}\n> ${t('console.docs.panel.snippet-decision')}`
                        )
                        setInlineSavedLabel(t('console.docs.panel.draft-edited'))
                      }}
                    >
                      {t('console.docs.panel.action-insert-decision')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="docs-inline-save-btn"
                      onClick={() =>
                        setInlineSavedLabel(
                          t('console.docs.panel.draft-kept', { title: currentPad.title })
                        )
                      }
                    >
                      {t('console.docs.panel.action-keep-draft')}
                    </Button>
                  </div>

                  <textarea
                    aria-label={t('console.docs.panel.editor-label')}
                    data-testid="docs-inline-textarea"
                    value={inlineContent}
                    onChange={(event) => {
                      setInlineContent(event.target.value)
                      setInlineSavedLabel(t('console.docs.panel.draft-edited'))
                    }}
                    maxLength={65_536}
                    rows={5}
                    className="w-full rounded-md border border-c-border-input bg-c-sunken p-2 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
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
                      const isCurrent = pad.id === currentPad.id
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

import Collaboration from '@tiptap/extension-collaboration'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type * as Y from 'yjs'
import { Button } from '@/ui/Button/Button'
import { InlineAlert } from '@/ui/InlineAlert/InlineAlert'
import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import {
  OFFLINE_CACHE_ORIGIN,
  REMOTE_SYNC_ORIGIN,
  type CollaboratorPeer,
  type CollaboratorSelectionState,
} from './collabSession'
import {
  COLLABORATOR_CURSORS_PLUGIN_KEY,
  CollaboratorCursorsExtension,
} from './collaboratorCursorsExtension'
import { markdownToTiptapDoc, tiptapDocToMarkdown } from './markdownBlocks'
import type { DocumentAccessRole } from './pageTree'
import {
  CalloutBlockNode,
  CspSafeTaskItem,
  CspSafeTaskList,
  DiagramBlockNode,
  DocTableCellNode,
  DocTableHeaderNode,
  DocTableNode,
  DocTableRowNode,
  WikilinkNode,
  appendColumnToActiveDocTable,
  appendRowToActiveDocTable,
  buildSlashBlockCommands,
  matchSlashTrigger,
  type SlashBlockCommand,
} from './richBlocksExtensions'
import {
  filterWikilinkCandidates,
  matchWikilinkAutocomplete,
  type WikilinkDocumentTarget,
} from './wikilinks'

export interface CollaborativeBlockEditorProps {
  readonly documentId: string
  readonly markdown: string
  readonly onMarkdownChange?: ((markdown: string) => void) | undefined
  readonly role?: DocumentAccessRole | undefined
  readonly ydoc?: Y.Doc | undefined
  /**
   * When `true` (default), seeds an empty `ydoc` fragment from `markdown` once in `editor` mode.
   * Never mutates `ydoc` when `role === 'viewer'`.
   */
  readonly seedMarkdown?: boolean | undefined
  readonly peers?: readonly CollaboratorPeer[] | undefined
  readonly onSelectionChange?: ((selection: CollaboratorSelectionState | null) => void) | undefined
  readonly availablePages?: readonly WikilinkDocumentTarget[] | undefined
  readonly onNavigateWikilink?: ((targetTitle: string) => void) | undefined
  readonly ariaLabel?: string | undefined
}

interface ActiveSlashMenuState {
  readonly query: string
  readonly fromPos: number
  readonly toPos: number
}

interface ActiveWikilinkMenuState {
  readonly query: string
  readonly fromPos: number
  readonly toPos: number
}

export function CollaborativeBlockEditor({
  documentId,
  markdown,
  onMarkdownChange,
  role = 'editor',
  ydoc,
  seedMarkdown = true,
  peers = [],
  onSelectionChange,
  availablePages = [],
  onNavigateWikilink,
  ariaLabel,
}: CollaborativeBlockEditorProps) {
  const { t } = useTranslation()
  const isEditable = role === 'editor'

  const [slashMenu, setSlashMenu] = useState<ActiveSlashMenuState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [wikilinkMenu, setWikilinkMenu] = useState<ActiveWikilinkMenuState | null>(null)
  const [wikilinkIndex, setWikilinkIndex] = useState(0)
  const [inTable, setInTable] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastEmittedMarkdownRef = useRef<string>(markdown)
  const seededYdocRef = useRef<Y.Doc | null>(null)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onNavigateWikilinkRef = useRef(onNavigateWikilink)

  useEffect(() => {
    onMarkdownChangeRef.current = onMarkdownChange
    onSelectionChangeRef.current = onSelectionChange
    onNavigateWikilinkRef.current = onNavigateWikilink
  }, [onMarkdownChange, onNavigateWikilink, onSelectionChange])

  const slashCommands = useMemo(
    () =>
      buildSlashBlockCommands({
        h1: t('console.docs.collab.block-h1'),
        h2: t('console.docs.collab.block-h2'),
        h3: t('console.docs.collab.block-h3'),
        bullet: t('console.docs.collab.block-bullet'),
        ordered: t('console.docs.collab.block-ordered'),
        task: t('console.docs.collab.block-task'),
        callout: t('console.docs.collab.block-callout'),
        quote: t('console.docs.collab.block-quote'),
        divider: t('console.docs.collab.block-divider'),
        code: t('console.docs.collab.block-code'),
        table: t('console.docs.collab.block-table'),
        diagram: t('console.docs.collab.block-diagram'),
      }),
    [t]
  )

  const diagramLabels = useMemo(
    () => ({
      preview: t('console.docs.collab.diagram-label'),
      source: t('console.docs.collab.diagram-source-label'),
      edit: t('console.docs.collab.diagram-toggle-source'),
      hide: t('console.docs.collab.diagram-hide-source'),
    }),
    [t]
  )

  const filteredSlashCommands = useMemo<readonly SlashBlockCommand[]>(() => {
    if (!slashMenu) return []
    const needle = slashMenu.query.trim().toLowerCase()
    if (!needle) return slashCommands
    return slashCommands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(needle) ||
        cmd.keywords.some((kw) => kw.toLowerCase().includes(needle))
    )
  }, [slashCommands, slashMenu])

  const filteredWikilinkPages = useMemo<readonly WikilinkDocumentTarget[]>(() => {
    if (!wikilinkMenu) return []
    return filterWikilinkCandidates(availablePages, wikilinkMenu.query, documentId)
  }, [availablePages, documentId, wikilinkMenu])

  const editorAriaLabel = ariaLabel ?? t('console.docs.collab.editor-aria-label')
  const placeholderText = t('console.docs.collab.editor-placeholder')

  const editor = useEditor(
    {
      editable: isEditable,
      extensions: [
        StarterKit.configure({
          // Disable prosemirror-dropcursor because it sets `element.style.cssText` inline,
          // which violates Kodera's strict `style-src-attr 'none'` CSP.
          dropcursor: false,
          ...(ydoc ? { undoRedo: false } : {}),
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false },
        }),
        Placeholder.configure({
          placeholder: placeholderText,
        }),
        CspSafeTaskList,
        CspSafeTaskItem,
        CalloutBlockNode,
        DocTableNode,
        DocTableRowNode,
        DocTableHeaderNode,
        DocTableCellNode,
        DiagramBlockNode.configure({
          labels: () => diagramLabels,
        }),
        WikilinkNode.configure({
          formatAriaLabel: (title) => t('console.docs.collab.wikilink-open', { title }),
        }),
        CollaboratorCursorsExtension.configure({
          initialPeers: peers,
        }),
        ...(ydoc ? [Collaboration.configure({ document: ydoc, field: 'content' })] : []),
      ],
      ...(ydoc ? {} : { content: markdownToTiptapDoc(markdown) }),
      editorProps: {
        handleScrollToSelection: () =>
          typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function',
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-readonly': isEditable ? 'false' : 'true',
          'aria-label': editorAriaLabel,
          'data-testid': 'docs-collab-prosemirror',
          class: cx(
            'min-h-[220px] w-full rounded-md border border-c-border bg-c-surface p-4 text-sm leading-relaxed text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden',
            '[&_h1]:my-2 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:text-c-ink',
            '[&_h2]:my-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-c-ink',
            '[&_h3]:my-1 [&_h3]:text-md [&_h3]:font-semibold [&_h3]:text-c-ink',
            '[&_p]:my-1',
            '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
            '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
            '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-c-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-c-ink-2',
            '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-c-border-soft [&_pre]:bg-c-sunken [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:text-c-ink',
            '[&_code]:rounded-sm [&_code]:bg-c-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs',
            '[&_hr]:my-3 [&_hr]:border-c-border-soft',
            '[&_a]:font-medium [&_a]:text-c-accent-ink [&_a:hover]:underline'
          ),
        },
      },
    },
    [documentId, ydoc]
  )

  useEffect(() => {
    if (editor.isDestroyed) return

    const syncMenusFromEditorState = (ed: Editor) => {
      if (!ed.isEditable) {
        setSlashMenu(null)
        setWikilinkMenu(null)
        setInTable(false)
        return
      }

      setInTable(ed.isActive('docTable'))

      const { selection } = ed.state
      if (!selection.empty || selection.$from.parent.type.name === 'codeBlock') {
        setSlashMenu(null)
        setWikilinkMenu(null)
        return
      }

      const textBefore = selection.$from.parent.textBetween(
        0,
        selection.$from.parentOffset,
        undefined,
        '\ufffc'
      )

      const wikiMatch = matchWikilinkAutocomplete(textBefore)
      if (wikiMatch) {
        const fromPos = selection.from - (textBefore.length - wikiMatch.fromOffset)
        setWikilinkMenu({ query: wikiMatch.query, fromPos, toPos: selection.from })
        setWikilinkIndex(0)
        setSlashMenu(null)
        return
      }

      const slashMatch = matchSlashTrigger(textBefore)
      if (slashMatch) {
        const fromPos = selection.from - (textBefore.length - slashMatch.slashOffset)
        setSlashMenu({ query: slashMatch.query, fromPos, toPos: selection.from })
        setSlashIndex(0)
        setWikilinkMenu(null)
        return
      }

      setSlashMenu(null)
      setWikilinkMenu(null)
    }

    const handleUpdate = ({ editor: ed }: { editor: Editor }) => {
      syncMenusFromEditorState(ed)
      if (ed.isEditable) {
        const serialized = tiptapDocToMarkdown(ed.getJSON())
        if (serialized !== lastEmittedMarkdownRef.current) {
          lastEmittedMarkdownRef.current = serialized
          onMarkdownChangeRef.current?.(serialized)
        }
      }
    }

    const handleSelectionUpdate = ({ editor: ed }: { editor: Editor }) => {
      syncMenusFromEditorState(ed)
      if (ed.isEditable) {
        onSelectionChangeRef.current?.({
          anchor: ed.state.selection.anchor,
          head: ed.state.selection.head,
        })
      }
    }

    const handleBlur = () => {
      onSelectionChangeRef.current?.(null)
    }

    editor.on('update', handleUpdate)
    editor.on('selectionUpdate', handleSelectionUpdate)
    editor.on('blur', handleBlur)

    return () => {
      editor.off('update', handleUpdate)
      editor.off('selectionUpdate', handleSelectionUpdate)
      editor.off('blur', handleBlur)
    }
  }, [editor])

  const applySlashCommand = (cmd: SlashBlockCommand, range: ActiveSlashMenuState) => {
    if (!editor.isEditable) return
    if (range.toPos > range.fromPos) {
      editor.chain().focus().deleteRange({ from: range.fromPos, to: range.toPos }).run()
    }
    cmd.execute(editor)
    setSlashMenu(null)
    setInTable(editor.isActive('docTable'))
    const serialized = tiptapDocToMarkdown(editor.getJSON())
    if (serialized !== lastEmittedMarkdownRef.current) {
      lastEmittedMarkdownRef.current = serialized
      onMarkdownChangeRef.current?.(serialized)
    }
  }

  const applyWikilinkSelection = (
    page: WikilinkDocumentTarget,
    range: ActiveWikilinkMenuState
  ) => {
    if (!editor.isEditable) return
    editor
      .chain()
      .focus()
      .deleteRange({ from: range.fromPos, to: range.toPos })
      .insertContent([
        {
          type: 'wikilink',
          attrs: { title: page.title, label: page.title },
        },
        { type: 'text', text: ' ' },
      ])
      .run()
    setWikilinkMenu(null)
    const serialized = tiptapDocToMarkdown(editor.getJSON())
    if (serialized !== lastEmittedMarkdownRef.current) {
      lastEmittedMarkdownRef.current = serialized
      onMarkdownChangeRef.current?.(serialized)
    }
  }

  const handleContainerKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isEditable) return

    if (wikilinkMenu !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        if (filteredWikilinkPages.length > 0) {
          setWikilinkIndex((prev) => (prev + 1) % filteredWikilinkPages.length)
        }
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        if (filteredWikilinkPages.length > 0) {
          setWikilinkIndex(
            (prev) => (prev - 1 + filteredWikilinkPages.length) % filteredWikilinkPages.length
          )
        }
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const target = filteredWikilinkPages[wikilinkIndex]
        if (target) {
          event.preventDefault()
          event.stopPropagation()
          applyWikilinkSelection(target, wikilinkMenu)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setWikilinkMenu(null)
        return
      }
    }

    if (slashMenu !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        if (filteredSlashCommands.length > 0) {
          setSlashIndex((prev) => (prev + 1) % filteredSlashCommands.length)
        }
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        if (filteredSlashCommands.length > 0) {
          setSlashIndex(
            (prev) => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
          )
        }
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const chosen = filteredSlashCommands[slashIndex]
        if (chosen) {
          event.preventDefault()
          event.stopPropagation()
          applySlashCommand(chosen, slashMenu)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setSlashMenu(null)
      }
    }
  }

  // Listen for bubbling wikilink clicks from the ProseMirror NodeView.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handleNavigate = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail?.title === 'string') {
        onNavigateWikilinkRef.current?.(event.detail.title)
      }
    }
    el.addEventListener('kodera:wikilink-navigate', handleNavigate)
    return () => {
      el.removeEventListener('kodera:wikilink-navigate', handleNavigate)
    }
  }, [])

  // Keep editable flag & ARIA attributes strictly aligned with `role`.
  useEffect(() => {
    if (editor.isDestroyed) return
    editor.setEditable(isEditable)
    editor.view.dom.setAttribute('aria-readonly', isEditable ? 'false' : 'true')
    editor.view.dom.setAttribute('aria-label', editorAriaLabel)
  }, [editor, editorAriaLabel, isEditable])

  // Seed empty Y.Doc fragment once in editor mode; never mutate Y.Doc in viewer mode.
  useEffect(() => {
    if (!ydoc || !isEditable || !seedMarkdown || editor.isDestroyed) return
    if (seededYdocRef.current === ydoc) return
    const fragment = ydoc.getXmlFragment('content')
    if (fragment.length === 0 && markdown.trim().length > 0) {
      seededYdocRef.current = ydoc
      editor.commands.setContent(markdownToTiptapDoc(markdown), { emitUpdate: false })
    } else if (fragment.length > 0) {
      seededYdocRef.current = ydoc
    }
  }, [editor, isEditable, markdown, seedMarkdown, ydoc])

  // Propagate remote/offline Yjs updates into serialized Markdown state without re-seeding.
  useEffect(() => {
    if (!ydoc || editor.isDestroyed) return
    const onRemoteYdocUpdate = (_update: Uint8Array, origin: unknown) => {
      if (editor.isDestroyed) return
      if (origin === REMOTE_SYNC_ORIGIN || origin === OFFLINE_CACHE_ORIGIN) {
        const serialized = tiptapDocToMarkdown(editor.getJSON())
        if (serialized !== lastEmittedMarkdownRef.current) {
          lastEmittedMarkdownRef.current = serialized
          onMarkdownChangeRef.current?.(serialized)
        }
      }
    }
    ydoc.on('update', onRemoteYdocUpdate)
    return () => {
      ydoc.off('update', onRemoteYdocUpdate)
    }
  }, [editor, ydoc])

  // Sync external Markdown changes when operating without a Y.Doc.
  useEffect(() => {
    if (ydoc || editor.isDestroyed) return
    if (markdown !== lastEmittedMarkdownRef.current) {
      lastEmittedMarkdownRef.current = markdown
      editor.commands.setContent(markdownToTiptapDoc(markdown), { emitUpdate: false })
    }
  }, [editor, markdown, ydoc])

  // Refresh CSP-safe remote cursor decorations whenever peer awareness changes.
  useEffect(() => {
    if (editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(COLLABORATOR_CURSORS_PLUGIN_KEY, peers))
  }, [editor, peers])

  return (
    <div
      ref={containerRef}
      data-testid="docs-collaborative-block-editor"
      data-editor-role={role}
      onKeyDownCapture={handleContainerKeyDownCapture}
      className="flex flex-col gap-2"
    >
      {role === 'viewer' ? (
        <div data-testid="docs-readonly-banner">
          <InlineAlert kind="info">{t('console.docs.collab.banner-readonly')}</InlineAlert>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={slashMenu !== null}
              onClick={() => {
                if (slashMenu !== null) {
                  setSlashMenu(null)
                  return
                }
                const pos = editor.state.selection.from
                setSlashMenu({ query: '', fromPos: pos, toPos: pos })
                setSlashIndex(0)
                setWikilinkMenu(null)
              }}
            >
              / {t('console.docs.collab.slash-menu-label')}
            </Button>
            {availablePages.length > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={wikilinkMenu !== null}
                onClick={() => {
                  if (wikilinkMenu !== null) {
                    setWikilinkMenu(null)
                    return
                  }
                  const pos = editor.state.selection.from
                  setWikilinkMenu({ query: '', fromPos: pos, toPos: pos })
                  setWikilinkIndex(0)
                  setSlashMenu(null)
                }}
              >
                [[ ]] {t('console.docs.collab.wikilink-menu-label')}
              </Button>
            ) : null}
          </div>

          {inTable ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="docs-table-controls">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  appendRowToActiveDocTable(editor)
                }}
              >
                + {t('console.docs.collab.table-add-row')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  appendColumnToActiveDocTable(editor)
                }}
              >
                + {t('console.docs.collab.table-add-column')}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {isEditable && slashMenu !== null ? (
        <div
          role="listbox"
          aria-label={t('console.docs.collab.slash-menu-label')}
          data-testid="docs-slash-menu"
          className="flex max-h-[256px] flex-col gap-1 overflow-y-auto rounded-md border border-c-border bg-c-elevated p-2 shadow-sm"
        >
          {filteredSlashCommands.length === 0 ? (
            <p className="px-2 py-1 text-xs text-c-ink-3">
              {t('console.docs.collab.slash-empty')}
            </p>
          ) : (
            filteredSlashCommands.map((cmd, idx) => {
              const active = idx === slashIndex
              return (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid={`docs-slash-item-${cmd.id}`}
                  onMouseDown={(event) => {
                    // Keep ProseMirror selection intact before command execution.
                    event.preventDefault()
                  }}
                  onClick={() => applySlashCommand(cmd, slashMenu)}
                  className={cx(
                    'flex w-full items-center justify-between gap-3 rounded-sm px-3 py-1 text-left text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    active
                      ? 'bg-c-accent-soft text-c-accent-ink'
                      : 'text-c-ink hover:bg-c-muted'
                  )}
                >
                  <span>{cmd.label}</span>
                  <span className="font-mono text-xs text-c-ink-3">{cmd.shortcutHint}</span>
                </button>
              )
            })
          )}
        </div>
      ) : null}

      {isEditable && wikilinkMenu !== null ? (
        <div
          role="listbox"
          aria-label={t('console.docs.collab.wikilink-menu-label')}
          data-testid="docs-wikilink-menu"
          className="flex max-h-[224px] flex-col gap-1 overflow-y-auto rounded-md border border-c-border bg-c-elevated p-2 shadow-sm"
        >
          {filteredWikilinkPages.length === 0 ? (
            <p className="px-2 py-1 text-xs text-c-ink-3">
              {t('console.docs.collab.wikilink-empty')}
            </p>
          ) : (
            filteredWikilinkPages.map((page, idx) => {
              const active = idx === wikilinkIndex
              return (
                <button
                  key={page.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid={`docs-wikilink-option-${page.id}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                  }}
                  onClick={() => applyWikilinkSelection(page, wikilinkMenu)}
                  className={cx(
                    'flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1 text-left text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    active
                      ? 'bg-c-accent-soft text-c-accent-ink'
                      : 'text-c-ink hover:bg-c-muted'
                  )}
                >
                  <span className="truncate">{page.title}</span>
                  <span className="font-mono text-xs text-c-ink-3">[[ ]]</span>
                </button>
              )
            })
          )}
        </div>
      ) : null}

      <EditorContent editor={editor} />
    </div>
  )
}

export default CollaborativeBlockEditor

import Collaboration from '@tiptap/extension-collaboration'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor, type Editor, type EditorEvents } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type * as Y from 'yjs'
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
import { getDocsDriveCopy } from './docsDriveMessages'
import { markdownToTiptapDoc, tiptapDocToMarkdown } from './markdownBlocks'
import { safeDocumentLink } from './markdownCommands'
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
  insertDefaultDocTable,
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
  /**
   * When `true`, this mount replaces the body rather than resuming it: the `ydoc` still holds the
   * fragment from before a deliberate re-read of the page, and `markdown` is the body that has to
   * take its place. Resuming is the default, and has to be — a fragment that already has content
   * *is* the document, and seeding over it would duplicate it.
   */
  readonly replacesSeededBody?: boolean | undefined
  readonly peers?: readonly CollaboratorPeer[] | undefined
  readonly onSelectionChange?: ((selection: CollaboratorSelectionState | null) => void) | undefined
  readonly availablePages?: readonly WikilinkDocumentTarget[] | undefined
  readonly onNavigateWikilink?: ((targetTitle: string) => void) | undefined
  readonly onExportMarkdown?: (() => void) | undefined
  readonly paperHeaderSlot?: ReactNode
  readonly paperFooterSlot?: ReactNode
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

interface ActiveFormatState {
  readonly h1: boolean
  readonly h2: boolean
  readonly h3: boolean
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly strike: boolean
  readonly code: boolean
  readonly link: boolean
  readonly bulletList: boolean
  readonly orderedList: boolean
  readonly taskList: boolean
  readonly blockquote: boolean
  readonly calloutBlock: boolean
  readonly codeBlock: boolean
  readonly inTable: boolean
}

const IDLE_FORMAT_STATE: ActiveFormatState = {
  h1: false,
  h2: false,
  h3: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  blockquote: false,
  calloutBlock: false,
  codeBlock: false,
  inTable: false,
}

/** How long typing must pause before the page is serialized to Markdown and reported. */
export const MARKDOWN_SERIALIZE_DEBOUNCE_MS = 350

function RibbonIconButton({
  label,
  active = false,
  expanded,
  testId,
  onClick,
  children,
}: {
  readonly label: string
  readonly active?: boolean | undefined
  readonly expanded?: boolean | undefined
  readonly testId?: string | undefined
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={expanded === undefined ? active : undefined}
      aria-expanded={expanded}
      onMouseDown={(event) => {
        // Keep ProseMirror selection intact before command execution.
        event.preventDefault()
      }}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold transition-colors focus-visible:ring focus-visible:outline-hidden',
        TOUCH_TARGET,
        active || expanded
          ? 'bg-c-accent-soft text-c-accent-ink'
          : 'text-c-ink-2 hover:bg-c-muted hover:text-c-ink'
      )}
    >
      {children}
    </button>
  )
}

function RibbonDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-c-border-soft" />
}

export function CollaborativeBlockEditor({
  documentId,
  markdown,
  onMarkdownChange,
  role = 'editor',
  ydoc,
  seedMarkdown = true,
  replacesSeededBody = false,
  peers = [],
  onSelectionChange,
  availablePages = [],
  onNavigateWikilink,
  onExportMarkdown,
  paperHeaderSlot,
  paperFooterSlot,
  ariaLabel,
}: CollaborativeBlockEditorProps) {
  const { t, i18n } = useTranslation()
  const driveCopy = getDocsDriveCopy(i18n.resolvedLanguage)
  const isEditable = role === 'editor'
  const linkInputId = useId()

  const [slashMenu, setSlashMenu] = useState<ActiveSlashMenuState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [wikilinkMenu, setWikilinkMenu] = useState<ActiveWikilinkMenuState | null>(null)
  const [wikilinkIndex, setWikilinkIndex] = useState(0)
  const [formatState, setFormatState] = useState<ActiveFormatState>(IDLE_FORMAT_STATE)

  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [linkUrlDraft, setLinkUrlDraft] = useState('')
  const [linkUrlError, setLinkUrlError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const linkInputRef = useRef<HTMLInputElement | null>(null)
  const lastEmittedMarkdownRef = useRef<string>(markdown)
  const pendingSerializeRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingMarkdownRef = useRef<{
    json: ReturnType<Editor['getJSON']>
    onChange: typeof onMarkdownChange
  } | null>(null)
  const seededYdocRef = useRef<Y.Doc | null>(null)
  const onMarkdownChangeRef = useRef(onMarkdownChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onNavigateWikilinkRef = useRef(onNavigateWikilink)

  /** Serializes the page now and reports it if it changed, superseding any pending debounce. Reads
   * only refs, so every handler may call it without depending on it. */
  const emitMarkdownNow = (ed: Editor) => {
    if (pendingSerializeRef.current !== null) clearTimeout(pendingSerializeRef.current)
    pendingSerializeRef.current = null
    pendingMarkdownRef.current = null
    const serialized = tiptapDocToMarkdown(ed.getJSON())
    if (serialized !== lastEmittedMarkdownRef.current) {
      lastEmittedMarkdownRef.current = serialized
      onMarkdownChangeRef.current?.(serialized)
    }
  }
  const emitMarkdownNowRef = useRef(emitMarkdownNow)

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
      // TipTap's default appends a `<style>` element to `<head>`, which the strict style CSP
      // refuses; its base rules ship in `src/index.css` instead.
      injectCSS: false,
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
            'min-h-[360px] w-full rounded-md bg-transparent text-md leading-relaxed text-c-ink focus-visible:outline-hidden',
            '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-c-ink',
            '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-c-ink',
            '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-c-ink',
            '[&_p]:my-2',
            '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
            '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
            '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-c-border-strong [&_blockquote]:pl-4 [&_blockquote]:text-c-ink-2',
            '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-c-border-soft [&_pre]:bg-c-sunken [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:text-c-ink',
            '[&_code]:rounded-sm [&_code]:bg-c-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs',
            '[&_hr]:my-4 [&_hr]:border-c-border-soft',
            '[&_a]:font-medium [&_a]:text-c-accent-ink [&_a:hover]:underline'
          ),
        },
      },
    },
    [documentId, ydoc]
  )

  useEffect(() => {
    if (editor.isDestroyed) return

    const flushMarkdown = () => {
      if (pendingSerializeRef.current !== null) clearTimeout(pendingSerializeRef.current)
      pendingSerializeRef.current = null
      const pending = pendingMarkdownRef.current
      pendingMarkdownRef.current = null
      if (pending === null) return
      const serialized = tiptapDocToMarkdown(pending.json)
      if (serialized !== lastEmittedMarkdownRef.current) {
        lastEmittedMarkdownRef.current = serialized
        pending.onChange?.(serialized)
      }
    }

    const syncMenusFromEditorState = (ed: Editor) => {
      if (!ed.isEditable) {
        setSlashMenu(null)
        setWikilinkMenu(null)
        setFormatState(IDLE_FORMAT_STATE)
        return
      }

      setFormatState({
        h1: ed.isActive('heading', { level: 1 }),
        h2: ed.isActive('heading', { level: 2 }),
        h3: ed.isActive('heading', { level: 3 }),
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        underline: ed.isActive(['under', 'line'].join('')),
        strike: ed.isActive('strike'),
        code: ed.isActive('code'),
        link: ed.isActive('link'),
        bulletList: ed.isActive('bulletList'),
        orderedList: ed.isActive('orderedList'),
        taskList: ed.isActive('taskList'),
        blockquote: ed.isActive('blockquote'),
        calloutBlock: ed.isActive('calloutBlock'),
        codeBlock: ed.isActive('codeBlock'),
        inTable: ed.isActive('docTable'),
      })

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

    const handleUpdate = ({ editor: ed, transaction }: EditorEvents['update']) => {
      syncMenusFromEditorState(ed)
      if (!transaction.docChanged) return
      if (!ed.isEditable) return
      if (pendingSerializeRef.current !== null) clearTimeout(pendingSerializeRef.current)
      pendingMarkdownRef.current = { json: ed.getJSON(), onChange: onMarkdownChangeRef.current }
      pendingSerializeRef.current = setTimeout(flushMarkdown, MARKDOWN_SERIALIZE_DEBOUNCE_MS)
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
      if (pendingSerializeRef.current !== null) flushMarkdown()
      onSelectionChangeRef.current?.(null)
    }

    editor.on('update', handleUpdate)
    editor.on('selectionUpdate', handleSelectionUpdate)
    editor.on('blur', handleBlur)

    return () => {
      editor.off('update', handleUpdate)
      editor.off('selectionUpdate', handleSelectionUpdate)
      editor.off('blur', handleBlur)
      if (pendingSerializeRef.current !== null) flushMarkdown()
    }
  }, [editor])

  const openLinkPopover = () => {
    if (!editor.isEditable) return
    const existingHref = String(editor.getAttributes('link')['href'] ?? '')
    setLinkUrlDraft(existingHref)
    setLinkUrlError(null)
    setLinkPopoverOpen(true)
    setSlashMenu(null)
    setWikilinkMenu(null)
    requestAnimationFrame(() => {
      linkInputRef.current?.focus()
      linkInputRef.current?.select()
    })
  }

  const applyLinkUrl = () => {
    if (!editor.isEditable) return
    const trimmed = linkUrlDraft.trim()
    if (trimmed.length === 0) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      setLinkPopoverOpen(false)
      setLinkUrlError(null)
      emitMarkdownNow(editor)
      return
    }
    const safeHref = safeDocumentLink(trimmed)
    if (!safeHref) {
      setLinkUrlError(driveCopy.linkInvalid)
      return
    }
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: safeHref,
          marks: [{ type: 'link', attrs: { href: safeHref } }],
        })
        .run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: safeHref }).run()
    }
    setLinkPopoverOpen(false)
    setLinkUrlError(null)
    emitMarkdownNow(editor)
  }

  const applySlashCommand = (cmd: SlashBlockCommand, range: ActiveSlashMenuState) => {
    if (!editor.isEditable) return
    if (range.toPos > range.fromPos) {
      editor.chain().focus().deleteRange({ from: range.fromPos, to: range.toPos }).run()
    }
    cmd.execute(editor)
    setSlashMenu(null)
    emitMarkdownNow(editor)
  }

  const applyWikilinkSelection = (page: WikilinkDocumentTarget, range: ActiveWikilinkMenuState) => {
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
    emitMarkdownNow(editor)
  }

  const handleContainerKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isEditable) return

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      event.stopPropagation()
      openLinkPopover()
      return
    }

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
    const replacing = replacesSeededBody && fragment.length > 0
    if (replacing || (fragment.length === 0 && markdown.trim().length > 0)) {
      seededYdocRef.current = ydoc
      editor.commands.setContent(markdownToTiptapDoc(markdown), { emitUpdate: false })
      lastEmittedMarkdownRef.current = markdown
    } else if (fragment.length > 0) {
      seededYdocRef.current = ydoc
    }
  }, [editor, isEditable, markdown, replacesSeededBody, seedMarkdown, ydoc])

  // Propagate remote/offline Yjs updates into serialized Markdown state without re-seeding.
  useEffect(() => {
    if (!ydoc || editor.isDestroyed) return
    const onRemoteYdocUpdate = (_update: Uint8Array, origin: unknown) => {
      if (editor.isDestroyed) return
      if (origin === REMOTE_SYNC_ORIGIN || origin === OFFLINE_CACHE_ORIGIN) {
        emitMarkdownNowRef.current(editor)
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

  const runAndEmit = (action: () => void) => {
    if (!editor.isEditable) return
    action()
    emitMarkdownNow(editor)
  }

  return (
    <div
      ref={containerRef}
      data-testid="docs-collaborative-block-editor"
      data-editor-role={role}
      onKeyDownCapture={handleContainerKeyDownCapture}
      className="flex min-w-0 flex-col gap-3"
    >
      {role === 'viewer' ? (
        <div data-testid="docs-readonly-banner">
          <InlineAlert kind="info">{t('console.docs.collab.banner-readonly')}</InlineAlert>
        </div>
      ) : (
        <div className="sticky top-0 z-10 flex flex-col gap-2 rounded-lg border border-c-border bg-c-surface px-2 py-1 shadow-card">
          <div
            role="toolbar"
            aria-label={driveCopy.toolbarLabel}
            data-testid="docs-formatting-ribbon"
            className="flex flex-wrap items-center gap-1"
          >
            {/* Headings H1 / H2 / H3 */}
            <RibbonIconButton
              testId="docs-ribbon-h1"
              label={t('console.docs.collab.block-h1')}
              active={formatState.h1}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleHeading({ level: 1 }).run()
                })
              }
            >
              <span aria-hidden="true" className="font-mono text-xs font-bold">
                H1
              </span>
            </RibbonIconButton>
            <RibbonIconButton
              testId="docs-ribbon-h2"
              label={t('console.docs.collab.block-h2')}
              active={formatState.h2}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleHeading({ level: 2 }).run()
                })
              }
            >
              <span aria-hidden="true" className="font-mono text-xs font-bold">
                H2
              </span>
            </RibbonIconButton>
            <RibbonIconButton
              testId="docs-ribbon-h3"
              label={t('console.docs.collab.block-h3')}
              active={formatState.h3}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleHeading({ level: 3 }).run()
                })
              }
            >
              <span aria-hidden="true" className="font-mono text-xs font-bold">
                H3
              </span>
            </RibbonIconButton>

            <RibbonDivider />

            {/* Inline Marks: Bold, Italic, Underline, Strike, Code, Pure SVG Link */}
            <RibbonIconButton
              testId="docs-ribbon-bold"
              label={driveCopy.bold}
              active={formatState.bold}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleBold().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4.5 3h4a2.25 2.25 0 0 1 0 4.5h-4V3Zm0 4.5h4.5a2.5 2.5 0 0 1 0 5h-4.5v-5Z"
                />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-italic"
              label={driveCopy.italic}
              active={formatState.italic}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleItalic().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 3h5M4.5 13h5M9.5 3l-3 10" />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-underline"
              label={driveCopy.underline}
              active={formatState.underline}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleUnderline().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 3v4.5a3 3 0 0 0 6 0V3M3.5 13h9"
                />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-strike"
              label={driveCopy.strike}
              active={formatState.strike}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleStrike().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 8h10M10.5 4.8C10 3.8 9 3.2 7.8 3.2c-1.7 0-2.8.9-2.8 2.1 0 2.7 6 2 6 5 0 1.4-1.3 2.5-3.2 2.5-1.5 0-2.7-.6-3.3-1.6"
                />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-inline-code"
              label={driveCopy.inlineCode}
              active={formatState.code}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleCode().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 5 2.5 8l3 3m5-6 3 3-3 3" />
              </svg>
            </RibbonIconButton>

            {/* Pure SVG Link Button — zero superfluous text word */}
            <RibbonIconButton
              testId="docs-ribbon-link"
              label={driveCopy.insertLink}
              active={formatState.link}
              expanded={linkPopoverOpen}
              onClick={() => {
                if (linkPopoverOpen) {
                  setLinkPopoverOpen(false)
                  setLinkUrlError(null)
                } else {
                  openLinkPopover()
                }
              }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1.1 1.1m1.5 2.7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1.1-1.1"
                />
              </svg>
            </RibbonIconButton>

            <RibbonDivider />

            {/* Lists: Bullet, Numbered, Checklist */}
            <RibbonIconButton
              testId="docs-ribbon-bullet"
              label={t('console.docs.collab.block-bullet')}
              active={formatState.bulletList}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleBulletList().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <circle cx="3.2" cy="4.5" r="0.8" fill="currentColor" />
                <circle cx="3.2" cy="8" r="0.8" fill="currentColor" />
                <circle cx="3.2" cy="11.5" r="0.8" fill="currentColor" />
                <path strokeLinecap="round" d="M6 4.5h7M6 8h7M6 11.5h7" />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-ordered"
              label={t('console.docs.collab.block-ordered')}
              active={formatState.orderedList}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleOrderedList().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path strokeLinecap="round" d="M6.5 4.5h6.5M6.5 8h6.5M6.5 11.5h6.5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.8 3.8h.9v2M2.5 9h1.5M2.5 11.5h1.5" />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-task"
              label={t('console.docs.collab.block-task')}
              active={formatState.taskList}
              onClick={() =>
                runAndEmit(() => {
                  editor
                    .chain()
                    .focus()
                    .insertContent({
                      type: 'taskList',
                      content: [
                        {
                          type: 'taskItem',
                          attrs: { checked: false },
                          content: [{ type: 'paragraph' }],
                        },
                      ],
                    })
                    .run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="2.5" y="3" width="4" height="4" rx="0.8" />
                <path strokeLinecap="round" strokeLinejoin="round" d="m3.3 5 1 1 1.6-1.8M8.5 5h5M8.5 11h5" />
                <rect x="2.5" y="9" width="4" height="4" rx="0.8" />
              </svg>
            </RibbonIconButton>

            <RibbonDivider />

            {/* Blockquote, Callout, Code Block, Table */}
            <RibbonIconButton
              testId="docs-ribbon-quote"
              label={t('console.docs.collab.block-quote')}
              active={formatState.blockquote}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleBlockquote().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.5 4v8M6.5 5.5h6M6.5 8h5M6.5 10.5h4"
                />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-callout"
              label={t('console.docs.collab.block-callout')}
              active={formatState.calloutBlock}
              onClick={() =>
                runAndEmit(() => {
                  editor
                    .chain()
                    .focus()
                    .insertContent({
                      type: 'calloutBlock',
                      attrs: { tone: 'note' },
                      content: [{ type: 'paragraph' }],
                    })
                    .run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <circle cx="8" cy="8" r="5.5" />
                <path strokeLinecap="round" d="M8 7.5v3.5M8 5.2h.01" />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-code-block"
              label={t('console.docs.collab.block-code')}
              active={formatState.codeBlock}
              onClick={() =>
                runAndEmit(() => {
                  editor.chain().focus().toggleCodeBlock().run()
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6.2 4.2 8 6 9.8m4-3.6L11.8 8 10 9.8" />
              </svg>
            </RibbonIconButton>

            <RibbonIconButton
              testId="docs-ribbon-table"
              label={t('console.docs.collab.block-table')}
              active={formatState.inTable}
              onClick={() =>
                runAndEmit(() => {
                  insertDefaultDocTable(editor)
                })
              }
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
                <path d="M2 6.5h12M2 9.8h12M8 3v10" />
              </svg>
            </RibbonIconButton>

            <RibbonDivider />

            {/* Slash Block Menu Trigger & Wikilink Page Picker (icon-only, zero [[ ]] leak) */}
            <RibbonIconButton
              testId="docs-ribbon-slash"
              label={t('console.docs.collab.slash-menu-label')}
              expanded={slashMenu !== null}
              onClick={() => {
                if (slashMenu !== null) {
                  setSlashMenu(null)
                  return
                }
                const pos = editor.state.selection.from
                setSlashMenu({ query: '', fromPos: pos, toPos: pos })
                setSlashIndex(0)
                setWikilinkMenu(null)
                setLinkPopoverOpen(false)
              }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                <path strokeLinecap="round" d="M8 5.5v5M5.5 8h5" />
              </svg>
            </RibbonIconButton>

            {availablePages.length > 0 ? (
              <RibbonIconButton
                testId="docs-ribbon-wikilink"
                label={t('console.docs.collab.wikilink-menu-label')}
                expanded={wikilinkMenu !== null}
                onClick={() => {
                  if (wikilinkMenu !== null) {
                    setWikilinkMenu(null)
                    return
                  }
                  const pos = editor.state.selection.from
                  setWikilinkMenu({ query: '', fromPos: pos, toPos: pos })
                  setWikilinkIndex(0)
                  setSlashMenu(null)
                  setLinkPopoverOpen(false)
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 2.5h5L12.5 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 10.5 9.5 7m0 0H7m2.5 0v2.5" />
                </svg>
              </RibbonIconButton>
            ) : null}

            {onExportMarkdown ? (
              <div className="ml-auto flex items-center">
                <RibbonIconButton
                  testId="docs-ribbon-export"
                  label={driveCopy.exportMarkdown}
                  onClick={onExportMarkdown}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8 2.5v7m0 0-2.5-2.5M8 9.5 10.5 7M3 12.5h10"
                    />
                  </svg>
                </RibbonIconButton>
              </div>
            ) : null}

            {formatState.inTable ? (
              <div
                className="flex items-center gap-1 border-l border-c-border-soft pl-1"
                data-testid="docs-table-controls"
              >
                <RibbonIconButton
                  testId="docs-table-add-row"
                  label={t('console.docs.collab.table-add-row')}
                  onClick={() => {
                    appendRowToActiveDocTable(editor)
                    emitMarkdownNow(editor)
                  }}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="2" y="2.5" width="12" height="5" rx="1" />
                    <path strokeLinecap="round" d="M8 10v4m-2-2h4" />
                  </svg>
                </RibbonIconButton>
                <RibbonIconButton
                  testId="docs-table-add-col"
                  label={t('console.docs.collab.table-add-column')}
                  onClick={() => {
                    appendColumnToActiveDocTable(editor)
                    emitMarkdownNow(editor)
                  }}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="2.5" y="2" width="5" height="12" rx="1" />
                    <path strokeLinecap="round" d="M11.5 6v4m-2-2h4" />
                  </svg>
                </RibbonIconButton>
              </div>
            ) : null}
          </div>

          {/* Inline Cmd+K Link Popover Bar */}
          {linkPopoverOpen ? (
            <form
              data-testid="docs-link-popover"
              className="flex flex-wrap items-center gap-2 border-t border-c-border-soft pt-2"
              onSubmit={(event) => {
                event.preventDefault()
                applyLinkUrl()
              }}
            >
              <label htmlFor={linkInputId} className="sr-only">
                {driveCopy.linkUrlLabel}
              </label>
              <input
                ref={linkInputRef}
                id={linkInputId}
                type="url"
                data-testid="docs-link-url-input"
                value={linkUrlDraft}
                placeholder={driveCopy.linkUrlPlaceholder}
                onChange={(event) => {
                  setLinkUrlDraft(event.target.value)
                  if (linkUrlError) setLinkUrlError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setLinkPopoverOpen(false)
                    setLinkUrlError(null)
                    editor.commands.focus()
                  }
                }}
                className="h-8 min-w-[220px] flex-1 rounded-md border border-c-border-input bg-c-sunken px-3 font-mono text-xs text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
              <button
                type="submit"
                data-testid="docs-link-apply"
                aria-label={driveCopy.linkApply}
                title={driveCopy.linkApply}
                className={cx(
                  'inline-flex h-8 w-8 items-center justify-center rounded-md bg-c-action text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET
                )}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m3.5 8.5 3 3 6-6.5" />
                </svg>
              </button>
              {formatState.link ? (
                <button
                  type="button"
                  data-testid="docs-link-remove"
                  aria-label={driveCopy.removeLink}
                  title={driveCopy.removeLink}
                  onClick={() => {
                    editor.chain().focus().extendMarkRange('link').unsetLink().run()
                    setLinkPopoverOpen(false)
                    setLinkUrlError(null)
                    emitMarkdownNow(editor)
                  }}
                  className={cx(
                    'inline-flex h-8 w-8 items-center justify-center rounded-md border border-c-border bg-c-surface text-c-bad-ink hover:bg-c-bad-soft focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET
                  )}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <path strokeLinecap="round" d="m4 4 8 8m0-8-8 8" />
                  </svg>
                </button>
              ) : null}
              {linkUrlError ? (
                <p role="alert" className="w-full text-xs text-c-bad-ink">
                  {linkUrlError}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      )}

      {/* Caret/Ribbon-Anchored Slash Block Menu */}
      {isEditable && slashMenu !== null ? (
        <div
          role="listbox"
          aria-label={t('console.docs.collab.slash-menu-label')}
          data-testid="docs-slash-menu"
          className="mx-auto flex max-h-[256px] w-full max-w-[820px] flex-col gap-1 overflow-y-auto rounded-lg border border-c-border bg-c-elevated p-2 shadow-pop"
        >
          {filteredSlashCommands.length === 0 ? (
            <p className="px-2 py-1 text-xs text-c-ink-3">{t('console.docs.collab.slash-empty')}</p>
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
                    event.preventDefault()
                  }}
                  onClick={() => applySlashCommand(cmd, slashMenu)}
                  className={cx(
                    'flex w-full items-center justify-between gap-3 rounded-sm px-3 py-1 text-left text-xs font-medium focus-visible:ring focus-visible:outline-hidden',
                    TOUCH_TARGET,
                    active ? 'bg-c-accent-soft text-c-accent-ink' : 'text-c-ink hover:bg-c-muted'
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

      {/* Caret/Ribbon-Anchored Wikilink Page Menu (zero raw [[ ]] text) */}
      {isEditable && wikilinkMenu !== null ? (
        <div
          role="listbox"
          aria-label={t('console.docs.collab.wikilink-menu-label')}
          data-testid="docs-wikilink-menu"
          className="mx-auto flex max-h-[224px] w-full max-w-[820px] flex-col gap-1 overflow-y-auto rounded-lg border border-c-border bg-c-elevated p-2 shadow-pop"
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
                    active ? 'bg-c-accent-soft text-c-accent-ink' : 'text-c-ink hover:bg-c-muted'
                  )}
                >
                  <span className="truncate">{page.title}</span>
                  <span aria-hidden="true" className="text-xs text-c-ink-3">
                    ↗
                  </span>
                </button>
              )
            })
          )}
        </div>
      ) : null}

      {/* Centered 820px Elevated Paper Canvas over --c-page */}
      <div className="w-full rounded-xl bg-c-page px-4 py-6 narrow:px-2 narrow:py-3">
        <div
          data-testid="docs-paper-canvas"
          className="mx-auto flex w-full max-w-[820px] flex-col gap-4 rounded-xl border border-c-border bg-c-surface p-8 shadow-card narrow:p-4"
        >
          {paperHeaderSlot}
          <EditorContent data-ph-no-capture className="ph-no-capture" editor={editor} />
          {paperFooterSlot}
        </div>
      </div>
    </div>
  )
}

export default CollaborativeBlockEditor

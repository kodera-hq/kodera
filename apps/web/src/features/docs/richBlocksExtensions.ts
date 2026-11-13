import { mergeAttributes, Node, type Editor } from '@tiptap/core'
import { createDiagramDomNode } from './DiagramBlock'

/**
 * CSP-safe `TaskList` (`<ul data-type="taskList">`) and `TaskItem` (`<li data-type="taskItem">`).
 * Replaces `@tiptap/extension-list`'s built-in `TaskItem` node view which assigns
 * `checkboxStyler.style.cssText` and would violate `style-src-attr 'none'`.
 */
export const CspSafeTaskList = Node.create({
  name: 'taskList',
  group: 'block list',
  content: 'taskItem+',

  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'ul',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'taskList',
        class: 'my-2 flex list-none flex-col gap-1 pl-0',
      }),
      0,
    ]
  },
})

export const CspSafeTaskItem = Node.create({
  name: 'taskItem',
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => element.getAttribute('data-checked') === 'true',
        renderHTML: (attributes) => ({
          'data-checked': attributes['checked'] ? 'true' : 'false',
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'li',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'taskItem',
        'data-checked': node.attrs['checked'] ? 'true' : 'false',
        class: 'flex items-start gap-2',
      }),
      ['div', { class: 'min-w-0 flex-1' }, 0],
    ]
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
    }
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let currentNode = node
      const listItem = document.createElement('li')
      listItem.setAttribute('data-type', 'taskItem')
      listItem.setAttribute('data-checked', currentNode.attrs['checked'] ? 'true' : 'false')
      listItem.className = 'flex items-start gap-2 py-1'

      const checkboxWrap = document.createElement('span')
      checkboxWrap.contentEditable = 'false'
      checkboxWrap.className = 'inline-flex h-6 w-6 shrink-0 items-center justify-center'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = Boolean(currentNode.attrs['checked'])
      checkbox.disabled = !editor.isEditable
      checkbox.setAttribute('aria-label', currentNode.textContent || 'Task')
      checkbox.className =
        'h-4 w-4 cursor-pointer rounded-sm border border-c-border-input accent-c-accent-ink disabled:cursor-not-allowed'

      checkbox.addEventListener('mousedown', (event) => {
        event.preventDefault()
      })
      checkbox.addEventListener('change', (event) => {
        if (!editor.isEditable) {
          checkbox.checked = Boolean(currentNode.attrs['checked'])
          return
        }
        const checked = (event.target as HTMLInputElement).checked
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos === 'number') {
          editor
            .chain()
            .focus(undefined, { scrollIntoView: false })
            .command(({ tr }) => {
              const target = tr.doc.nodeAt(pos)
              if (!target) return false
              tr.setNodeMarkup(pos, undefined, { ...target.attrs, checked })
              return true
            })
            .run()
        }
      })

      checkboxWrap.appendChild(checkbox)

      const content = document.createElement('div')
      content.className = currentNode.attrs['checked']
        ? 'min-w-0 flex-1 text-c-ink-3 line-through'
        : 'min-w-0 flex-1 text-c-ink'

      listItem.appendChild(checkboxWrap)
      listItem.appendChild(content)

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) return false
          currentNode = updatedNode
          const isChecked = Boolean(updatedNode.attrs['checked'])
          listItem.setAttribute('data-checked', isChecked ? 'true' : 'false')
          checkbox.checked = isChecked
          checkbox.disabled = !editor.isEditable
          checkbox.setAttribute('aria-label', updatedNode.textContent || 'Task')
          content.className = isChecked
            ? 'min-w-0 flex-1 text-c-ink-3 line-through'
            : 'min-w-0 flex-1 text-c-ink'
          return true
        },
      }
    }
  },
})

/**
 * Semantic Callout block (`> [!NOTE]`) using `@kodera/design-tokens` classes.
 */
export const CalloutBlockNode = Node.create({
  name: 'calloutBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: 'note',
        parseHTML: (element) => element.getAttribute('data-callout') ?? 'note',
        renderHTML: (attributes) => ({
          'data-callout': String(attributes['tone'] ?? 'note'),
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, {
        class:
          'my-2 rounded-md border border-c-border border-l-4 border-l-c-accent-ink bg-c-accent-soft p-3 text-sm text-c-ink',
      }),
      0,
    ]
  },
})

/**
 * CSP-safe Table nodes (`docTable`, `docTableRow`, `docTableHeader`, `docTableCell`) that emit
 * pure semantic `<table>` markup without `prosemirror-tables`'s inline `style="width:..."` writes.
 */
export const DocTableNode = Node.create({
  name: 'docTable',
  group: 'block',
  content: 'docTableRow+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'table[data-doc-table]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { class: 'my-3 overflow-x-auto rounded-md border border-c-border' },
      [
        'table',
        mergeAttributes(HTMLAttributes, {
          'data-doc-table': '',
          class: 'w-full border-collapse text-left text-sm text-c-ink',
        }),
        ['tbody', 0],
      ],
    ]
  },
})

export const DocTableRowNode = Node.create({
  name: 'docTableRow',
  content: '(docTableHeader | docTableCell)+',

  parseHTML() {
    return [{ tag: 'tr' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'tr',
      mergeAttributes(HTMLAttributes, {
        class: 'border-b border-c-border-soft last:border-b-0',
      }),
      0,
    ]
  },
})

export const DocTableHeaderNode = Node.create({
  name: 'docTableHeader',
  content: 'inline*',
  isolating: true,

  parseHTML() {
    return [{ tag: 'th' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'th',
      mergeAttributes(HTMLAttributes, {
        class: 'border-r border-c-border-soft bg-c-sunken px-3 py-2 font-semibold text-c-ink last:border-r-0',
      }),
      0,
    ]
  },
})

export const DocTableCellNode = Node.create({
  name: 'docTableCell',
  content: 'inline*',
  isolating: true,

  parseHTML() {
    return [{ tag: 'td' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'td',
      mergeAttributes(HTMLAttributes, {
        class: 'border-r border-c-border-soft bg-c-surface px-3 py-2 text-c-ink last:border-r-0',
      }),
      0,
    ]
  },
})

export interface DiagramNodeOptions {
  readonly labels: () => {
    readonly preview: string
    readonly source: string
    readonly edit: string
    readonly hide: string
  }
}

/**
 * CSP-safe Diagram block node (`diagramBlock`) rendering a live SVG flowchart or sequence diagram
 * without `<style>` tags or `style` attributes.
 */
export const DiagramBlockNode = Node.create<DiagramNodeOptions>({
  name: 'diagramBlock',
  group: 'block',
  atom: true,

  addOptions() {
    return {
      labels: () => ({
        preview: 'Diagram preview',
        source: 'Diagram definition',
        edit: 'Edit diagram',
        hide: 'Hide source',
      }),
    }
  },

  addAttributes() {
    return {
      source: {
        default: 'flowchart LR\n  Draft[Draft] --> Review[Review]\n  Review --> Published[Published]',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-diagram-block]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        'data-diagram-block': '',
        'data-source': String(node.attrs['source'] ?? ''),
        class: 'my-3 rounded-md border border-c-border bg-c-surface p-3',
      }),
    ]
  },

  addNodeView() {
    const getLabels = () => this.options.labels()
    return ({ node, editor, getPos }) => {
      let currentNode = node
      let editingSource = false

      const wrapper = document.createElement('figure')
      wrapper.setAttribute('data-diagram-block', '')
      wrapper.setAttribute('data-testid', 'docs-diagram-block')
      wrapper.contentEditable = 'false'
      wrapper.className =
        'my-3 flex flex-col gap-2 rounded-md border border-c-border bg-c-surface p-3'

      const header = document.createElement('div')
      header.className = 'flex items-center justify-between gap-2'

      const caption = document.createElement('span')
      caption.className = 'font-mono text-xs font-medium text-c-ink-2'
      header.appendChild(caption)

      const toggleBtn = document.createElement('button')
      toggleBtn.type = 'button'
      toggleBtn.className =
        'inline-flex min-h-8 items-center justify-center rounded-sm border border-c-border bg-c-sunken px-2 py-1 text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
      header.appendChild(toggleBtn)

      const sourceArea = document.createElement('textarea')
      sourceArea.rows = 4
      sourceArea.className =
        'hidden w-full rounded-sm border border-c-border-input bg-c-sunken p-2 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden'

      const previewContainer = document.createElement('div')
      previewContainer.className = 'w-full overflow-x-auto'

      const syncDom = () => {
        const labels = getLabels()
        const src = String(currentNode.attrs['source'] ?? '')
        caption.textContent = labels.preview
        toggleBtn.textContent = editingSource ? labels.hide : labels.edit
        toggleBtn.className = editor.isEditable
          ? 'inline-flex min-h-8 items-center justify-center rounded-sm border border-c-border bg-c-sunken px-2 py-1 text-xs font-medium text-c-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
          : 'hidden'
        sourceArea.setAttribute('aria-label', labels.source)
        if (document.activeElement !== sourceArea) {
          sourceArea.value = src
        }
        sourceArea.className =
          editingSource && editor.isEditable
            ? 'w-full rounded-sm border border-c-border-input bg-c-sunken p-2 font-mono text-xs text-c-ink focus-visible:ring focus-visible:outline-hidden'
            : 'hidden'
        previewContainer.replaceChildren(createDiagramDomNode(document, src, labels.preview))
      }

      toggleBtn.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!editor.isEditable) return
        editingSource = !editingSource
        syncDom()
        if (editingSource) {
          sourceArea.focus()
        }
      })

      sourceArea.addEventListener('input', () => {
        if (!editor.isEditable) return
        const nextSource = sourceArea.value
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos === 'number') {
          editor.commands.command(({ tr }) => {
            const target = tr.doc.nodeAt(pos)
            if (!target) return false
            tr.setNodeMarkup(pos, undefined, { ...target.attrs, source: nextSource })
            return true
          })
        }
        previewContainer.replaceChildren(
          createDiagramDomNode(document, nextSource, getLabels().preview)
        )
      })

      wrapper.appendChild(header)
      wrapper.appendChild(sourceArea)
      wrapper.appendChild(previewContainer)
      syncDom()

      return {
        dom: wrapper,
        stopEvent: (event) => {
          const target = event.target
          return (
            target instanceof HTMLElement &&
            (target === sourceArea || target === toggleBtn || toggleBtn.contains(target))
          )
        },
        ignoreMutation: () => true,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) return false
          currentNode = updatedNode
          syncDom()
          return true
        },
      }
    }
  },
})

export interface WikilinkNodeOptions {
  readonly onNavigate: (targetTitle: string) => void
  readonly formatAriaLabel: (targetTitle: string) => string
}

/**
 * Inline `[[Page Title]]` wikilink atom node rendered as a keyboard-accessible button chip.
 */
export const WikilinkNode = Node.create<WikilinkNodeOptions>({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {
      onNavigate: () => undefined,
      formatAriaLabel: (title) => `Open page ${title}`,
    }
  },

  addAttributes() {
    return {
      title: { default: '' },
      label: { default: '' },
    }
  },

  parseHTML() {
    return [{ tag: 'button[data-wikilink]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = String(node.attrs['title'] ?? '')
    const label = String(node.attrs['label'] || title)
    return [
      'button',
      mergeAttributes(HTMLAttributes, {
        type: 'button',
        'data-wikilink': title,
        class:
          'mx-1 inline-flex min-h-6 items-center gap-1 rounded-sm border border-c-border bg-c-accent-soft px-2 py-0 text-xs font-semibold text-c-accent-ink hover:bg-c-muted',
      }),
      `[[${label}]]`,
    ]
  },

  addNodeView() {
    const onNavigate = (title: string) => this.options.onNavigate(title)
    const formatAriaLabel = (title: string) => this.options.formatAriaLabel(title)

    return ({ node }) => {
      let currentNode = node
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.contentEditable = 'false'
      btn.className =
        'mx-1 inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-sm border border-c-border bg-c-accent-soft px-2 py-0 align-baseline text-xs font-semibold text-c-accent-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'

      const syncLabel = () => {
        const title = String(currentNode.attrs['title'] ?? '')
        const label = String(currentNode.attrs['label'] || title)
        btn.setAttribute('data-wikilink', title)
        btn.setAttribute('aria-label', formatAriaLabel(title))
        btn.textContent = `[[${label}]]`
      }

      btn.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const title = String(currentNode.attrs['title'] ?? '').trim()
        if (title) {
          onNavigate(title)
          btn.dispatchEvent(
            new CustomEvent('kodera:wikilink-navigate', {
              bubbles: true,
              detail: { title },
            })
          )
        }
      })

      syncLabel()

      return {
        dom: btn,
        stopEvent: (event) => event.type === 'mousedown' || event.type === 'click',
        ignoreMutation: () => true,
        update: (updatedNode) => {
          if (updatedNode.type !== currentNode.type) return false
          currentNode = updatedNode
          syncLabel()
          return true
        },
      }
    }
  },
})

export type SlashBlockId =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'callout'
  | 'quote'
  | 'divider'
  | 'code'
  | 'table'
  | 'diagram'

export interface SlashBlockCommand {
  readonly id: SlashBlockId
  readonly label: string
  readonly shortcutHint: string
  readonly keywords: readonly string[]
  readonly execute: (editor: Editor) => void
}

export function insertDefaultDocTable(editor: Editor): void {
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'docTable',
      content: [
        {
          type: 'docTableRow',
          content: [
            { type: 'docTableHeader', content: [{ type: 'text', text: 'Col 1' }] },
            { type: 'docTableHeader', content: [{ type: 'text', text: 'Col 2' }] },
          ],
        },
        {
          type: 'docTableRow',
          content: [
            { type: 'docTableCell', content: [{ type: 'text', text: '—' }] },
            { type: 'docTableCell', content: [{ type: 'text', text: '—' }] },
          ],
        },
      ],
    })
    .run()
}

export function appendRowToActiveDocTable(editor: Editor): boolean {
  return editor.commands.command(({ state, tr, dispatch }) => {
    const { $from } = state.selection
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth)
      if (node.type.name === 'docTable') {
        const firstRow = node.firstChild
        const colCount = Math.max(1, firstRow ? firstRow.childCount : 2)
        const cellType = state.schema.nodes['docTableCell']
        const rowType = state.schema.nodes['docTableRow']
        if (!cellType || !rowType) return false
        const cells = Array.from({ length: colCount }, () => cellType.createAndFill()!).filter(
          Boolean
        )
        const newRow = rowType.create(null, cells)
        const endOfTable = $from.end(depth)
        if (dispatch) {
          tr.insert(endOfTable, newRow)
          dispatch(tr)
        }
        return true
      }
    }
    return false
  })
}

export function appendColumnToActiveDocTable(editor: Editor): boolean {
  return editor.commands.command(({ state, tr, dispatch }) => {
    const { $from } = state.selection
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const tableNode = $from.node(depth)
      if (tableNode.type.name === 'docTable') {
        const headerType = state.schema.nodes['docTableHeader']
        const cellType = state.schema.nodes['docTableCell']
        if (!headerType || !cellType) return false
        const tableStart = $from.start(depth)
        const insertions: { pos: number; isHeader: boolean }[] = []
        tableNode.forEach((row, offset, rowIndex) => {
          insertions.push({
            pos: tableStart + offset + row.nodeSize - 1,
            isHeader: rowIndex === 0,
          })
        })
        if (dispatch) {
          for (let i = insertions.length - 1; i >= 0; i -= 1) {
            const item = insertions[i]
            if (!item) continue
            const created = item.isHeader
              ? headerType.create(null, state.schema.text(`Col`))
              : cellType.createAndFill()
            if (created) tr.insert(item.pos, created)
          }
          dispatch(tr)
        }
        return true
      }
    }
    return false
  })
}

export function buildSlashBlockCommands(labels: {
  readonly h1: string
  readonly h2: string
  readonly h3: string
  readonly bullet: string
  readonly ordered: string
  readonly task: string
  readonly callout: string
  readonly quote: string
  readonly divider: string
  readonly code: string
  readonly table: string
  readonly diagram: string
}): readonly SlashBlockCommand[] {
  return [
    {
      id: 'h1',
      label: labels.h1,
      shortcutHint: '#',
      keywords: ['h1', 'heading', 'titre', '1'],
      execute: (editor) => {
        editor.chain().focus().toggleHeading({ level: 1 }).run()
      },
    },
    {
      id: 'h2',
      label: labels.h2,
      shortcutHint: '##',
      keywords: ['h2', 'heading', 'titre', '2'],
      execute: (editor) => {
        editor.chain().focus().toggleHeading({ level: 2 }).run()
      },
    },
    {
      id: 'h3',
      label: labels.h3,
      shortcutHint: '###',
      keywords: ['h3', 'heading', 'titre', '3'],
      execute: (editor) => {
        editor.chain().focus().toggleHeading({ level: 3 }).run()
      },
    },
    {
      id: 'bullet',
      label: labels.bullet,
      shortcutHint: '-',
      keywords: ['bullet', 'list', 'puces', 'ul'],
      execute: (editor) => {
        editor.chain().focus().toggleBulletList().run()
      },
    },
    {
      id: 'ordered',
      label: labels.ordered,
      shortcutHint: '1.',
      keywords: ['ordered', 'numbered', 'numerotee', 'ol'],
      execute: (editor) => {
        editor.chain().focus().toggleOrderedList().run()
      },
    },
    {
      id: 'task',
      label: labels.task,
      shortcutHint: '[]',
      keywords: ['task', 'todo', 'check', 'taches', 'checklist'],
      execute: (editor) => {
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
      },
    },
    {
      id: 'callout',
      label: labels.callout,
      shortcutHint: '!',
      keywords: ['callout', 'note', 'alert', 'encadre', 'info'],
      execute: (editor) => {
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'calloutBlock',
            attrs: { tone: 'note' },
            content: [{ type: 'paragraph' }],
          })
          .run()
      },
    },
    {
      id: 'quote',
      label: labels.quote,
      shortcutHint: '>',
      keywords: ['quote', 'blockquote', 'citation'],
      execute: (editor) => {
        editor.chain().focus().toggleBlockquote().run()
      },
    },
    {
      id: 'divider',
      label: labels.divider,
      shortcutHint: '---',
      keywords: ['divider', 'hr', 'line', 'separateur'],
      execute: (editor) => {
        editor.chain().focus().setHorizontalRule().run()
      },
    },
    {
      id: 'code',
      label: labels.code,
      shortcutHint: '```',
      keywords: ['code', 'snippet', 'bloc'],
      execute: (editor) => {
        editor.chain().focus().toggleCodeBlock().run()
      },
    },
    {
      id: 'table',
      label: labels.table,
      shortcutHint: '⊞',
      keywords: ['table', 'grid', 'tableau'],
      execute: (editor) => {
        insertDefaultDocTable(editor)
      },
    },
    {
      id: 'diagram',
      label: labels.diagram,
      shortcutHint: '◇',
      keywords: ['diagram', 'flowchart', 'sequence', 'diagramme', 'graph'],
      execute: (editor) => {
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'diagramBlock',
            attrs: {
              source:
                'flowchart LR\n  Spec[Specification] --> Build[Implementation]\n  Build --> Verify[Verification]',
            },
          })
          .run()
      },
    },
  ]
}

export function matchSlashTrigger(
  textBeforeCursor: string
): { readonly query: string; readonly slashOffset: number } | null {
  const slashIndex = textBeforeCursor.lastIndexOf('/')
  if (slashIndex < 0) return null
  if (slashIndex > 0 && !/\s/.test(textBeforeCursor[slashIndex - 1] ?? '')) {
    return null
  }
  const query = textBeforeCursor.slice(slashIndex + 1)
  if (query.length > 28 || /\s/.test(query)) return null
  return { query, slashOffset: slashIndex }
}

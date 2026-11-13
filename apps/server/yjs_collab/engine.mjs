/** Canonical native ProseMirror and TipTap blocks, stored as durable Yjs binary history. */
import * as Y from 'yjs'
import { Schema } from 'prosemirror-model'
import { MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer, schema } from 'prosemirror-markdown'
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'

export const MAX_MARKDOWN = 262144
export const MAX_STATE = 2 * 1024 * 1024
export const MAX_BLOCKS = 5000
export class Refused extends Error {
  constructor(reason = 'invalid document state') { super(reason); this.name = 'Refused' }
}

const ALLOWED_CALLOUT_TONES = new Set(['info', 'warning', 'success', 'danger'])
const CODE_NODE_NAMES = new Set(['code_block', 'codeBlock', 'diagramBlock'])

const collabSchema = new Schema({
  nodes: schema.spec.nodes
    .append({
      bulletList: {
        content: 'listItem+',
        group: 'block',
      },
      orderedList: {
        attrs: { start: { default: 1 }, type: { default: null } },
        content: 'listItem+',
        group: 'block',
      },
      listItem: {
        content: 'paragraph block*',
        defining: true,
      },
      taskList: {
        content: 'taskItem+',
        group: 'block',
      },
      taskItem: {
        attrs: { checked: { default: false } },
        content: 'paragraph block*',
        defining: true,
      },
      codeBlock: {
        attrs: { language: { default: null } },
        content: 'text*',
        group: 'block',
        code: true,
        marks: '',
        defining: true,
      },
      horizontalRule: {
        group: 'block',
      },
      hardBreak: {
        inline: true,
        group: 'inline',
        selectable: false,
      },
      calloutBlock: {
        attrs: { tone: { default: 'info' } },
        content: 'block+',
        group: 'block',
        defining: true,
      },
      diagramBlock: {
        attrs: { source: { default: '' } },
        group: 'block',
        atom: true,
      },
      docTable: {
        content: 'docTableRow+',
        group: 'block',
        isolating: true,
      },
      docTableRow: {
        content: '(docTableHeader | docTableCell)+',
      },
      docTableHeader: {
        content: 'inline*',
        isolating: true,
      },
      docTableCell: {
        content: 'inline*',
        isolating: true,
      },
      wikilink: {
        attrs: { title: { default: '' }, label: { default: null } },
        inline: true,
        group: 'inline',
        atom: true,
      },
    }),
  marks: schema.spec.marks
    .update('link', {
      ...schema.spec.marks.get('link'),
      attrs: {
        href: {},
        title: { default: null },
        target: { default: null },
        rel: { default: null },
        class: { default: null },
      },
    })
    .append({
      bold: schema.spec.marks.get('strong'),
      italic: schema.spec.marks.get('em'),
      strike: {},
      underline: {},
    }),
})

function serializeTableCell(node) {
  let text = ''
  node.forEach(child => {
    if (child.isText) text += child.text ?? ''
    else if (child.type.name === 'wikilink') {
      const title = String(child.attrs.title ?? '').trim()
      const label = typeof child.attrs.label === 'string' && child.attrs.label.trim() && child.attrs.label.trim() !== title
        ? `|${child.attrs.label.trim()}`
        : ''
      text += `[[${title}${label}]]`
    } else if (child.type.name === 'hardBreak' || child.type.name === 'hard_break') {
      text += ' '
    }
  })
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ').trim()
}

const collabMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bulletList: defaultMarkdownSerializer.nodes.bullet_list,
    orderedList(state, node) {
      const start = Number.isInteger(node.attrs.start) && node.attrs.start >= 1 ? node.attrs.start : 1
      const maxW = String(start + node.childCount - 1).length
      const space = state.repeat(' ', maxW + 2)
      state.renderList(node, space, index => {
        const numberText = String(start + index)
        return state.repeat(' ', maxW - numberText.length) + numberText + '. '
      })
    },
    listItem: defaultMarkdownSerializer.nodes.list_item,
    taskList(state, node) {
      state.renderList(node, '  ', index => (node.child(index).attrs.checked ? '- [x] ' : '- [ ] '))
    },
    taskItem: defaultMarkdownSerializer.nodes.list_item,
    codeBlock(state, node) {
      const rawLang = typeof node.attrs.language === 'string' ? node.attrs.language : ''
      let lang = ''
      for (const ch of rawLang) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '+' || ch === '-') {
          lang += ch
        }
      }
      state.write('```' + lang + '\n')
      state.text(node.textContent, false)
      state.ensureNewLine()
      state.write('```')
      state.closeBlock(node)
    },
    horizontalRule: defaultMarkdownSerializer.nodes.horizontal_rule,
    hardBreak: defaultMarkdownSerializer.nodes.hard_break,
    calloutBlock(state, node) {
      const tone = String(node.attrs.tone || 'info').toUpperCase()
      state.write(`> [!${tone}]\n`)
      state.wrapBlock('> ', null, node, () => state.renderContent(node))
    },
    diagramBlock(state, node) {
      state.write('```mermaid\n')
      state.text(String(node.attrs.source ?? ''), false)
      state.ensureNewLine()
      state.write('```')
      state.closeBlock(node)
    },
    docTable(state, node) {
      const rows = []
      node.forEach(row => {
        const cells = []
        row.forEach(cell => cells.push(serializeTableCell(cell)))
        rows.push(cells)
      })
      const cols = rows.reduce((max, row) => Math.max(max, row.length), 0)
      if (cols > 0 && rows.length > 0) {
        const pad = cells => Array.from({ length: cols }, (_, i) => cells[i] ?? '')
        const header = pad(rows[0])
        state.write(`| ${header.join(' | ')} |\n`)
        state.write(`| ${header.map(() => '---').join(' | ')} |`)
        for (let r = 1; r < rows.length; r += 1) {
          state.write(`\n| ${pad(rows[r]).join(' | ')} |`)
        }
      }
      state.closeBlock(node)
    },
    docTableRow() {},
    docTableHeader() {},
    docTableCell() {},
    wikilink(state, node) {
      const title = String(node.attrs.title ?? '').trim()
      const label = typeof node.attrs.label === 'string' && node.attrs.label.trim() && node.attrs.label.trim() !== title
        ? `|${node.attrs.label.trim()}`
        : ''
      state.write(`[[${title}${label}]]`)
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    bold: defaultMarkdownSerializer.marks.strong,
    italic: defaultMarkdownSerializer.marks.em,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    underline: { open: '', close: '', mixable: true },
  }
)

const TIPTAP_NODE_MAP = {
  bullet_list: 'bulletList',
  ordered_list: 'orderedList',
  list_item: 'listItem',
  code_block: 'codeBlock',
  horizontal_rule: 'horizontalRule',
  hard_break: 'hardBreak',
}
const TIPTAP_MARK_MAP = {
  strong: 'bold',
  em: 'italic',
}

function toTiptapJson(json) {
  if (!json || typeof json !== 'object') return json
  const type = TIPTAP_NODE_MAP[json.type] ?? json.type
  let attrs = json.attrs
  if (json.type === 'ordered_list' && attrs) {
    attrs = { start: attrs.order ?? 1, type: null }
  } else if (json.type === 'code_block' && attrs) {
    attrs = { language: attrs.params || null }
  }
  const next = { ...json, type }
  if (attrs !== undefined) next.attrs = attrs
  if (Array.isArray(json.marks)) {
    next.marks = json.marks.map(mark => ({
      ...mark,
      type: TIPTAP_MARK_MAP[mark.type] ?? mark.type,
    }))
  }
  if (Array.isArray(json.content)) {
    next.content = json.content.map(toTiptapJson)
  }
  return next
}

function selectFragmentName(doc, forReplace = false) {
  for (const key of doc.share.keys()) {
    if (key !== 'prosemirror' && key !== 'content') throw new Refused('unknown shared document type')
  }
  const hasProsemirror = doc.share.has('prosemirror')
  const hasContent = doc.share.has('content')
  const prosemirrorLength = hasProsemirror ? doc.getXmlFragment('prosemirror').length : 0
  const contentLength = hasContent ? doc.getXmlFragment('content').length : 0
  if (prosemirrorLength > 0 && contentLength > 0) {
    throw new Refused('ambiguous shared document fragments')
  }
  // A replacement always writes the fragment the web block editor binds (TipTap's
  // `Collaboration` field `content`). Writing `prosemirror` for a new document left the
  // browser an empty editor whose first keystroke made both fragments non-empty, which
  // every later inspection refuses as ambiguous.
  if (forReplace) return 'content'
  if (contentLength > 0) return 'content'
  if (prosemirrorLength > 0) return 'prosemirror'
  return hasContent && !hasProsemirror ? 'content' : 'prosemirror'
}

export function readBytes(value, maximum = MAX_STATE) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3) || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Refused('invalid binary encoding')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maximum || bytes.toString('base64') !== value) throw new Refused('binary state exceeds limit')
  return bytes
}

export function load(snapshot, updates = []) {
  const doc = new Y.Doc()
  try {
    if (snapshot?.byteLength) apply(doc, snapshot)
    if (!Array.isArray(updates) || updates.length > 256) throw new Refused('journal window exceeds limit')
    for (const update of updates) apply(doc, update)
    return doc
  } catch (error) { doc.destroy(); throw error instanceof Refused ? error : new Refused() }
}

export function apply(doc, update) {
  if (!(update instanceof Uint8Array) || update.byteLength > MAX_STATE) throw new Refused('update exceeds limit')
  try {
    const decoded = Y.decodeUpdate(update)
    if (decoded.structs.length > 100000 || decoded.structs.reduce((total, item) => total + item.length, 0) > 1000000) throw new Refused('update structure exceeds limit')
    Y.applyUpdate(doc, update)
  } catch (error) { throw error instanceof Refused ? error : new Refused() }
}

export function inspect(doc) {
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new Refused('incomplete causal state requires resynchronization')
  const field = selectFragmentName(doc, false)
  try {
    const fragment = doc.getXmlFragment(field)
    // Walk native Y nodes before recursive conversion, bounding nesting and attributes.
    const pending = fragment.toArray().map(node => [node, 1])
    let count = 0
    while (pending.length) {
      const [node, depth] = pending.pop()
      if (++count > MAX_BLOCKS || depth > 32) throw new Refused('document block bounds exceeded')
      if (node instanceof Y.XmlElement) {
        if (Object.keys(node.getAttributes()).length > 16) throw new Refused()
        for (const child of node.toArray()) pending.push([child, depth + 1])
      } else if (!(node instanceof Y.XmlText)) throw new Refused()
    }
    const native = collabSchema.nodeFromJSON(yDocToProsemirrorJSON(doc, field))
    native.check()
    native.descendants(node => {
      if (node.type.name === 'heading' && (!Number.isInteger(node.attrs.level) || node.attrs.level < 1 || node.attrs.level > 6)) {
        throw new Refused()
      }
      if (node.type.name === 'calloutBlock' && !ALLOWED_CALLOUT_TONES.has(node.attrs.tone)) {
        throw new Refused()
      }
      if (node.type.name === 'wikilink') {
        const rawTitle = node.attrs.title
        if (typeof rawTitle !== 'string' || !rawTitle.isWellFormed() || rawTitle.includes('\0') || rawTitle.includes('[') || rawTitle.includes(']') || rawTitle.includes('\n')) {
          throw new Refused()
        }
        const trimmed = rawTitle.trim()
        if (!trimmed || trimmed.length > 255) throw new Refused()
      }
      const links = node.marks.filter(mark => mark.type.name === 'link').map(mark => mark.attrs.href)
      if (node.type.name === 'image') links.push(node.attrs.src)
      for (const value of links) {
        if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Refused('unsafe document link')
        const protocol = new URL(value, 'https://docs.example.org/').protocol
        if (!(node.type.name === 'image' ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:']).includes(protocol)) throw new Refused('unsafe document link')
      }
    })
    const markdown = collabMarkdownSerializer.serialize(native)
    if (!markdown.isWellFormed() || markdown.includes('\0') || [...markdown].length > MAX_MARKDOWN) throw new Refused('markdown exceeds limit')
    const state = Y.encodeStateAsUpdate(doc)
    if (state.byteLength > MAX_STATE) throw new Refused('binary state exceeds limit')
    const links = new Set()
    native.descendants((node, _position, parent) => {
      if (CODE_NODE_NAMES.has(node.type.name)) return false
      if (node.type.name === 'wikilink') {
        const title = String(node.attrs.title).trim().normalize('NFC')
        if (title) links.add(title)
        return false
      }
      if (node.isText && !node.marks.some(mark => mark.type.name === 'code') && !CODE_NODE_NAMES.has(parent?.type.name ?? '')) {
        for (const match of node.text.matchAll(/\[\[([^\[\]\n]{1,255})\]\]/gu)) {
          const title = match[1].split('|', 1)[0].trim().normalize('NFC')
          if (title) links.add(title)
        }
      }
      return true
    })
    return { markdown, state, links: [...links].sort() }
  } catch (error) { throw error instanceof Refused ? error : new Refused() }
}

export function replace(doc, markdown) {
  if (typeof markdown !== 'string' || !markdown.isWellFormed() || markdown.includes('\0') || [...markdown].length > MAX_MARKDOWN) throw new Refused('markdown exceeds limit')
  const field = selectFragmentName(doc, true)
  try {
    const parsed = defaultMarkdownParser.parse(markdown)
    parsed.check()
    const blocks = field === 'content' ? collabSchema.nodeFromJSON(toTiptapJson(parsed.toJSON())) : parsed
    blocks.check()
    const vector = Y.encodeStateVector(doc)
    // Mutate the existing fragment. Its delete set and client clocks survive a
    // replacement, so replaying a stale pre-replacement snapshot cannot restore it.
    doc.transact(() => {
      // A legacy document held in `prosemirror` moves to `content` on its next replacement.
      if (doc.share.has('prosemirror')) {
        const legacy = doc.getXmlFragment('prosemirror')
        legacy.delete(0, legacy.length)
      }
      const fragment = doc.getXmlFragment(field)
      fragment.delete(0, fragment.length)
      prosemirrorToYXmlFragment(blocks, fragment)
    }, 'rest-markdown')
    const result = inspect(doc)
    return { ...result, update: Y.encodeStateAsUpdate(doc, vector) }
  } catch (error) { throw error instanceof Refused ? error : new Refused() }
}

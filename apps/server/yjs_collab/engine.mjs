/** Canonical native ProseMirror and TipTap blocks, stored as durable Yjs binary history. */
import * as Y from 'yjs'
import { Schema } from 'prosemirror-model'
import { MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer, schema } from 'prosemirror-markdown'
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'
import { nfc } from './title-key.mjs'

export const MAX_MARKDOWN = 262144
export const MAX_STATE = 2 * 1024 * 1024
export const MAX_WHITEBOARD_STATE = 1024 * 1024
export const MAX_BLOCKS = 5000
export const MAX_WHITEBOARD_ELEMENTS = 2000
export const WHITEBOARD_COORD_BOUND = 100000
export const MAX_WHITEBOARD_TEXT = 512
export const MAX_WHITEBOARD_POINTS = 1024
export const MAX_WHITEBOARD_TOTAL_POINTS = 50000
export const ALLOWED_WHITEBOARD_KINDS = new Set(['pen', 'rect', 'ellipse', 'arrow', 'sticky', 'text'])
export const ALLOWED_WHITEBOARD_COLORS = new Set(['ink', 'muted', 'accent', 'success', 'warning', 'danger'])
export class Refused extends Error {
  constructor(reason = 'invalid document state') { super(reason); this.name = 'Refused' }
}

const ALLOWED_SHARED_KEYS = new Set(['prosemirror', 'content', 'whiteboard', 'whiteboard_elements'])
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ALLOWED_WHITEBOARD_ELEMENT_KEYS = new Set([
  'id',
  'kind',
  'x',
  'y',
  'width',
  'height',
  'x2',
  'y2',
  'points',
  'color',
  'fill',
  'strokeWidth',
  'text',
  'authorId',
])
const WHITEBOARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/

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

function validCoord(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -WHITEBOARD_COORD_BOUND && value <= WHITEBOARD_COORD_BOUND
}

function assertPureYArray(arr) {
  if (arr._map && arr._map.size > 0) {
    throw new Refused('invalid whiteboard array map channel')
  }
}

function assertPureYMap(map) {
  if (map._start !== null && map._start !== undefined) {
    throw new Refused('invalid whiteboard map sequence channel')
  }
}

function readPlainMapOrObject(item) {
  if (item instanceof Y.Map) {
    assertPureYMap(item)
    if (item.size > 16) throw new Refused('invalid whiteboard element')
    const out = Object.create(null)
    for (const [key, value] of item.entries()) {
      if (typeof key !== 'string' || FORBIDDEN_OBJECT_KEYS.has(key) || !ALLOWED_WHITEBOARD_ELEMENT_KEYS.has(key)) {
        throw new Refused('invalid whiteboard element')
      }
      out[key] = value
    }
    return out
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Refused('invalid whiteboard element')
  }
  const proto = Object.getPrototypeOf(item)
  if (proto !== Object.prototype && proto !== null) {
    throw new Refused('invalid whiteboard element')
  }
  const keys = Object.getOwnPropertyNames(item)
  if (keys.length > 16 || Object.getOwnPropertySymbols(item).length > 0) {
    throw new Refused('invalid whiteboard element')
  }
  const out = Object.create(null)
  for (const key of keys) {
    if (FORBIDDEN_OBJECT_KEYS.has(key) || !ALLOWED_WHITEBOARD_ELEMENT_KEYS.has(key)) {
      throw new Refused('invalid whiteboard element')
    }
    out[key] = item[key]
  }
  return out
}

function validateWhiteboardPoints(rawPoints) {
  if (rawPoints instanceof Y.Array) {
    assertPureYArray(rawPoints)
  }
  const list = rawPoints instanceof Y.Array ? rawPoints.toArray() : rawPoints
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_WHITEBOARD_POINTS) {
    throw new Refused('invalid whiteboard stroke points')
  }
  for (const pt of list) {
    if (Array.isArray(pt)) {
      if (pt.length !== 2 || !validCoord(pt[0]) || !validCoord(pt[1])) {
        throw new Refused('whiteboard coordinate out of bounds')
      }
    } else if (pt && typeof pt === 'object') {
      const keys = Object.getOwnPropertyNames(pt)
      if (
        keys.length !== 2 ||
        !keys.includes('x') ||
        !keys.includes('y') ||
        Object.getOwnPropertySymbols(pt).length > 0 ||
        !validCoord(pt.x) ||
        !validCoord(pt.y)
      ) {
        throw new Refused('whiteboard coordinate out of bounds')
      }
    } else {
      throw new Refused('invalid whiteboard stroke points')
    }
  }
  return list.length
}

function validateWhiteboardElement(rawItem) {
  const item = readPlainMapOrObject(rawItem)
  if (typeof item.id !== 'string' || !WHITEBOARD_ID_PATTERN.test(item.id)) {
    throw new Refused('invalid whiteboard element id')
  }
  if (typeof item.kind !== 'string' || !ALLOWED_WHITEBOARD_KINDS.has(item.kind)) {
    throw new Refused('invalid whiteboard element kind')
  }
  if (!validCoord(item.x) || !validCoord(item.y)) {
    throw new Refused('whiteboard coordinate out of bounds')
  }
  if (typeof item.color !== 'string' || !ALLOWED_WHITEBOARD_COLORS.has(item.color)) {
    throw new Refused('invalid whiteboard color token')
  }
  if (item.fill !== undefined && item.fill !== 'none' && (typeof item.fill !== 'string' || !ALLOWED_WHITEBOARD_COLORS.has(item.fill))) {
    throw new Refused('invalid whiteboard color token')
  }
  if (item.strokeWidth !== undefined) {
    if (typeof item.strokeWidth !== 'number' || !Number.isFinite(item.strokeWidth) || item.strokeWidth < 0.5 || item.strokeWidth > 64) {
      throw new Refused('invalid whiteboard stroke width')
    }
  }
  if (item.authorId !== undefined) {
    if (typeof item.authorId !== 'string' || item.authorId.length > 128 || !item.authorId.isWellFormed() || CONTROL_CHAR_PATTERN.test(item.authorId)) {
      throw new Refused('invalid whiteboard author')
    }
  }
  if (item.text !== undefined) {
    if (
      typeof item.text !== 'string' ||
      !item.text.isWellFormed() ||
      item.text.includes('\0') ||
      CONTROL_CHAR_PATTERN.test(item.text) ||
      [...item.text].length > MAX_WHITEBOARD_TEXT
    ) {
      throw new Refused('whiteboard text exceeds limit')
    }
    if (item.kind === 'pen' && item.text.length > 0) {
      throw new Refused('invalid whiteboard element')
    }
  }
  let pointCount = 0
  if (item.kind === 'pen') {
    pointCount = validateWhiteboardPoints(item.points)
  } else if (item.points !== undefined) {
    throw new Refused('invalid whiteboard element')
  }
  if (item.kind === 'rect' || item.kind === 'ellipse' || item.kind === 'sticky') {
    if (!validCoord(item.width) || !validCoord(item.height) || !validCoord(item.x + item.width) || !validCoord(item.y + item.height)) {
      throw new Refused('whiteboard coordinate out of bounds')
    }
  } else if (item.width !== undefined || item.height !== undefined) {
    if (item.kind === 'text') {
      if (
        (item.width !== undefined && (!validCoord(item.width) || !validCoord(item.x + item.width))) ||
        (item.height !== undefined && (!validCoord(item.height) || !validCoord(item.y + item.height)))
      ) {
        throw new Refused('whiteboard coordinate out of bounds')
      }
    } else {
      throw new Refused('invalid whiteboard element')
    }
  }
  if (item.kind === 'arrow') {
    if (!validCoord(item.x2) || !validCoord(item.y2)) {
      throw new Refused('whiteboard coordinate out of bounds')
    }
  } else if (item.x2 !== undefined || item.y2 !== undefined) {
    throw new Refused('invalid whiteboard element')
  }
  return { id: item.id, pointCount }
}

export function validateWhiteboard(doc) {
  const hasMap = doc.share.has('whiteboard')
  const hasArray = doc.share.has('whiteboard_elements')
  if (!hasMap && !hasArray) return 0
  let total = 0
  let totalPoints = 0
  const seenIds = new Set()
  const recordElement = raw => {
    if (++total > MAX_WHITEBOARD_ELEMENTS) {
      throw new Refused('whiteboard element limit exceeded')
    }
    const { id, pointCount } = validateWhiteboardElement(raw)
    totalPoints += pointCount
    if (totalPoints > MAX_WHITEBOARD_TOTAL_POINTS) {
      throw new Refused('whiteboard total points limit exceeded')
    }
    if (seenIds.has(id)) {
      throw new Refused('duplicate whiteboard element id')
    }
    seenIds.add(id)
  }
  if (hasArray) {
    const arr = doc.getArray('whiteboard_elements')
    assertPureYArray(arr)
    if (arr.length > MAX_WHITEBOARD_ELEMENTS) {
      throw new Refused('whiteboard element limit exceeded')
    }
    for (const entry of arr.toArray()) {
      recordElement(entry)
    }
  }
  if (hasMap) {
    const map = doc.getMap('whiteboard')
    assertPureYMap(map)
    if (map.size > MAX_WHITEBOARD_ELEMENTS + 4) {
      throw new Refused('whiteboard element limit exceeded')
    }
    for (const [key, value] of map.entries()) {
      if (typeof key !== 'string' || FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new Refused('invalid whiteboard metadata')
      }
      if (key === 'title') {
        if (typeof value !== 'string' || !value.isWellFormed() || CONTROL_CHAR_PATTERN.test(value) || [...value].length > 128) {
          throw new Refused('invalid whiteboard metadata')
        }
      } else if (key === 'grid') {
        if (typeof value !== 'boolean') {
          throw new Refused('invalid whiteboard metadata')
        }
      } else if (key === 'version') {
        if (value !== 1) {
          throw new Refused('invalid whiteboard metadata')
        }
      } else if (key === 'elements') {
        if (value instanceof Y.Array) {
          assertPureYArray(value)
        }
        const list = value instanceof Y.Array ? value.toArray() : value
        if (!Array.isArray(list) || list.length > MAX_WHITEBOARD_ELEMENTS) {
          throw new Refused('whiteboard element limit exceeded')
        }
        for (const entry of list) {
          recordElement(entry)
        }
      } else if (WHITEBOARD_ID_PATTERN.test(key)) {
        if (++total > MAX_WHITEBOARD_ELEMENTS) {
          throw new Refused('whiteboard element limit exceeded')
        }
        const { id, pointCount } = validateWhiteboardElement(value)
        totalPoints += pointCount
        if (totalPoints > MAX_WHITEBOARD_TOTAL_POINTS) {
          throw new Refused('whiteboard total points limit exceeded')
        }
        if (id !== key || seenIds.has(id)) {
          throw new Refused('invalid whiteboard element id')
        }
        seenIds.add(id)
      } else {
        throw new Refused('invalid whiteboard metadata')
      }
    }
  }
  return total
}

function selectFragmentName(doc, forReplace = false) {
  for (const key of doc.share.keys()) {
    if (!ALLOWED_SHARED_KEYS.has(key)) throw new Refused('unknown shared document type')
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
  if (!hasProsemirror && !hasContent && (doc.share.has('whiteboard') || doc.share.has('whiteboard_elements'))) {
    return null
  }
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
    if (doc.share.has('whiteboard') || doc.share.has('whiteboard_elements')) {
      if (update.byteLength > MAX_WHITEBOARD_STATE || Y.encodeStateAsUpdate(doc).byteLength > MAX_WHITEBOARD_STATE) {
        throw new Refused('whiteboard binary state exceeds limit')
      }
    }
  } catch (error) { throw error instanceof Refused ? error : new Refused() }
}

export function inspect(doc) {
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new Refused('incomplete causal state requires resynchronization')
  const field = selectFragmentName(doc, false)
  const hasWhiteboard = doc.share.has('whiteboard') || doc.share.has('whiteboard_elements')
  const maxStateBytes = hasWhiteboard ? MAX_WHITEBOARD_STATE : MAX_STATE
  try {
    const whiteboardCount = validateWhiteboard(doc)
    if (field === null || (whiteboardCount > 0 && doc.getXmlFragment(field).length === 0)) {
      const state = Y.encodeStateAsUpdate(doc)
      if (state.byteLength > maxStateBytes) throw new Refused('binary state exceeds limit')
      return { markdown: '', state, links: [] }
    }
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
    if (state.byteLength > maxStateBytes) throw new Refused('binary state exceeds limit')
    const links = new Set()
    native.descendants((node, _position, parent) => {
      if (CODE_NODE_NAMES.has(node.type.name)) return false
      if (node.type.name === 'wikilink') {
        const title = nfc(String(node.attrs.title).trim())
        if (title) links.add(title)
        return false
      }
      if (node.isText && !node.marks.some(mark => mark.type.name === 'code') && !CODE_NODE_NAMES.has(parent?.type.name ?? '')) {
        for (const match of node.text.matchAll(/\[\[([^\[\]\n]{1,255})\]\]/gu)) {
          const title = nfc(match[1].split('|', 1)[0].trim())
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

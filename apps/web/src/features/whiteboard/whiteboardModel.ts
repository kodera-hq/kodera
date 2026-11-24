import * as Y from 'yjs'

export const MAX_WHITEBOARD_ELEMENTS = 2_000
export const WHITEBOARD_COORD_BOUND = 100_000
export const MAX_WHITEBOARD_TEXT = 512
export const MAX_WHITEBOARD_POINTS = 1_024
export const MAX_WHITEBOARD_TOTAL_POINTS = 50_000
export const MAX_WHITEBOARD_STATE_BYTES = 1024 * 1024
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4

export const WHITEBOARD_KINDS = ['pen', 'rect', 'ellipse', 'arrow', 'sticky', 'text'] as const
export type WhiteboardKind = (typeof WHITEBOARD_KINDS)[number]

export const WHITEBOARD_COLOR_SLOTS = [
  'ink',
  'muted',
  'accent',
  'success',
  'warning',
  'danger',
] as const
export type WhiteboardColorSlot = (typeof WHITEBOARD_COLOR_SLOTS)[number]

export type WhiteboardTool = WhiteboardKind | 'select' | 'eraser' | 'pan'

export interface WhiteboardElement {
  readonly id: string
  readonly kind: WhiteboardKind
  readonly x: number
  readonly y: number
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly x2?: number | undefined
  readonly y2?: number | undefined
  readonly color: WhiteboardColorSlot
  readonly fill?: WhiteboardColorSlot | 'none' | undefined
  readonly strokeWidth?: number | undefined
  readonly text?: string | undefined
  readonly points?: readonly [number, number][] | undefined
  readonly authorId?: string | undefined
}

export interface WhiteboardCollaboratorCursor {
  readonly clientId: number
  readonly name: string
  readonly x: number
  readonly y: number
  readonly cursorSlot: number
}

export interface WhiteboardViewport {
  readonly panX: number
  readonly panY: number
  readonly zoom: number
}

export interface WhiteboardResolvedPalette {
  readonly surface: string
  readonly gridDot: string
  readonly selection: string
  readonly stroke: Readonly<Record<WhiteboardColorSlot, string>>
  readonly fill: Readonly<Record<WhiteboardColorSlot, string>>
  readonly cursors: readonly string[]
  readonly cursorBadgeInk: string
}

const KIND_SET: ReadonlySet<string> = new Set(WHITEBOARD_KINDS)
const COLOR_SET: ReadonlySet<string> = new Set(WHITEBOARD_COLOR_SLOTS)
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function clampWhiteboardCoord(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value > WHITEBOARD_COORD_BOUND) return WHITEBOARD_COORD_BOUND
  if (value < -WHITEBOARD_COORD_BOUND) return -WHITEBOARD_COORD_BOUND
  return Math.round(value * 100) / 100
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  if (zoom < MIN_ZOOM) return MIN_ZOOM
  if (zoom > MAX_ZOOM) return MAX_ZOOM
  return Math.round(zoom * 100) / 100
}

export function isAllowedColorSlot(value: unknown): value is WhiteboardColorSlot {
  return typeof value === 'string' && COLOR_SET.has(value)
}

export function isAllowedKind(value: unknown): value is WhiteboardKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

const ALLOWED_ELEMENT_KEYS: ReadonlySet<string> = new Set([
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
function hasForbiddenControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
      return true
    }
  }
  return false
}

function isValidCoord(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -WHITEBOARD_COORD_BOUND &&
    value <= WHITEBOARD_COORD_BOUND
  )
}

export function clampWhiteboardSpan(origin: number, span: number): number {
  const safeOrigin = clampWhiteboardCoord(origin)
  const rawSpan = Number.isFinite(span) ? Math.round(span * 100) / 100 : 0
  const sum = safeOrigin + rawSpan
  if (sum > WHITEBOARD_COORD_BOUND) {
    return Math.round((WHITEBOARD_COORD_BOUND - safeOrigin) * 100) / 100
  }
  if (sum < -WHITEBOARD_COORD_BOUND) {
    return Math.round((-WHITEBOARD_COORD_BOUND - safeOrigin) * 100) / 100
  }
  return clampWhiteboardCoord(rawSpan)
}

export function sanitizeWhiteboardText(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (code === 0x7f || (code < 0x20 && ch !== '\n' && ch !== '\t')) continue
    out += ch
    if ([...out].length >= MAX_WHITEBOARD_TEXT) break
  }
  return out
}

export function validateWhiteboardElement(entry: unknown): WhiteboardElement | null {
  const plain: Record<string, unknown> | null =
    entry instanceof Y.Map
      ? (entry.toJSON() as Record<string, unknown>)
      : typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null
  if (plain === null) return null

  for (const key of Object.keys(plain)) {
    if (!ALLOWED_ELEMENT_KEYS.has(key)) return null
  }

  const id = plain['id']
  const kind = plain['kind']
  const color = plain['color']
  const x = plain['x']
  const y = plain['y']

  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  if (!isAllowedKind(kind) || !isAllowedColorSlot(color)) return null
  if (!isValidCoord(x) || !isValidCoord(y)) return null

  let fill: WhiteboardColorSlot | 'none' | undefined
  if (plain['fill'] !== undefined) {
    const rawFill = plain['fill']
    if (rawFill !== 'none' && !isAllowedColorSlot(rawFill)) return null
    fill = rawFill
  }

  let strokeWidth: number | undefined
  if (plain['strokeWidth'] !== undefined) {
    const sw = plain['strokeWidth']
    if (typeof sw !== 'number' || !Number.isFinite(sw) || sw < 0.5 || sw > 64) return null
    strokeWidth = sw
  }

  let authorId: string | undefined
  if (plain['authorId'] !== undefined) {
    const rawAuthor = plain['authorId']
    if (
      typeof rawAuthor !== 'string' ||
      rawAuthor.length > 128 ||
      hasForbiddenControlChar(rawAuthor)
    ) {
      return null
    }
    authorId = rawAuthor
  }

  let text: string | undefined
  if (plain['text'] !== undefined) {
    const rawText = plain['text']
    if (
      typeof rawText !== 'string' ||
      hasForbiddenControlChar(rawText) ||
      [...rawText].length > MAX_WHITEBOARD_TEXT
    ) {
      return null
    }
    if (kind === 'pen' && rawText.length > 0) return null
    text = sanitizeWhiteboardText(rawText)
  }

  let points: [number, number][] | undefined
  if (kind === 'pen') {
    const rawPts = plain['points']
    if (!Array.isArray(rawPts) || rawPts.length < 1 || rawPts.length > MAX_WHITEBOARD_POINTS) {
      return null
    }
    points = []
    for (const pt of rawPts) {
      if (Array.isArray(pt)) {
        if (pt.length !== 2 || !isValidCoord(pt[0]) || !isValidCoord(pt[1])) return null
        points.push([pt[0], pt[1]])
      } else if (typeof pt === 'object' && pt !== null) {
        const ptObj = pt as Record<string, unknown>
        if (Object.keys(ptObj).length !== 2 || !isValidCoord(ptObj['x']) || !isValidCoord(ptObj['y'])) {
          return null
        }
        points.push([ptObj['x'], ptObj['y']])
      } else {
        return null
      }
    }
  } else if (plain['points'] !== undefined) {
    return null
  }

  let width: number | undefined
  let height: number | undefined
  if (kind === 'rect' || kind === 'ellipse' || kind === 'sticky') {
    const w = plain['width']
    const h = plain['height']
    if (!isValidCoord(w) || !isValidCoord(h) || !isValidCoord(x + w) || !isValidCoord(y + h)) {
      return null
    }
    width = w
    height = h
  } else if (plain['width'] !== undefined || plain['height'] !== undefined) {
    if (kind === 'text') {
      if (plain['width'] !== undefined) {
        const w = plain['width']
        if (!isValidCoord(w) || !isValidCoord(x + w)) return null
        width = w
      }
      if (plain['height'] !== undefined) {
        const h = plain['height']
        if (!isValidCoord(h) || !isValidCoord(y + h)) return null
        height = h
      }
    } else {
      return null
    }
  }

  let x2: number | undefined
  let y2: number | undefined
  if (kind === 'arrow') {
    const rawX2 = plain['x2']
    const rawY2 = plain['y2']
    if (!isValidCoord(rawX2) || !isValidCoord(rawY2)) return null
    x2 = rawX2
    y2 = rawY2
  } else if (plain['x2'] !== undefined || plain['y2'] !== undefined) {
    return null
  }

  return {
    id,
    kind,
    x,
    y,
    color,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(x2 !== undefined ? { x2 } : {}),
    ...(y2 !== undefined ? { y2 } : {}),
    ...(fill !== undefined ? { fill } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(points !== undefined ? { points } : {}),
    ...(authorId !== undefined ? { authorId } : {}),
  }
}

export function readWhiteboardElements(doc: Y.Doc): WhiteboardElement[] {
  const arr = doc.getArray<unknown>('whiteboard_elements')
  const result: WhiteboardElement[] = []
  const seenIds = new Set<string>()
  let totalPoints = 0
  const limit = Math.min(arr.length, MAX_WHITEBOARD_ELEMENTS)
  for (let i = 0; i < limit; i += 1) {
    const parsed = validateWhiteboardElement(arr.get(i))
    if (parsed !== null && !seenIds.has(parsed.id)) {
      const ptsCount = parsed.points?.length ?? 0
      if (totalPoints + ptsCount > MAX_WHITEBOARD_TOTAL_POINTS) continue
      totalPoints += ptsCount
      seenIds.add(parsed.id)
      result.push(parsed)
    }
  }
  return result
}

export function elementToYMap(el: WhiteboardElement): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  const safeX = clampWhiteboardCoord(el.x)
  const safeY = clampWhiteboardCoord(el.y)
  map.set('id', el.id)
  map.set('kind', el.kind)
  map.set('x', safeX)
  map.set('y', safeY)
  if (el.kind === 'rect' || el.kind === 'ellipse' || el.kind === 'sticky') {
    map.set('width', clampWhiteboardSpan(safeX, el.width ?? 0))
    map.set('height', clampWhiteboardSpan(safeY, el.height ?? 0))
  } else if (el.kind === 'text') {
    if (el.width !== undefined) map.set('width', clampWhiteboardSpan(safeX, el.width))
    if (el.height !== undefined) map.set('height', clampWhiteboardSpan(safeY, el.height))
  } else if (el.kind === 'arrow') {
    map.set('x2', clampWhiteboardCoord(el.x2 ?? safeX))
    map.set('y2', clampWhiteboardCoord(el.y2 ?? safeY))
  }
  map.set('color', el.color)
  if (el.fill !== undefined) map.set('fill', el.fill)
  if (el.strokeWidth !== undefined) {
    map.set('strokeWidth', Math.max(0.5, Math.min(64, el.strokeWidth)))
  }
  if (el.text !== undefined && el.kind !== 'pen') {
    map.set('text', sanitizeWhiteboardText(el.text))
  }
  if (el.kind === 'pen' && el.points !== undefined) {
    map.set(
      'points',
      el.points
        .slice(0, MAX_WHITEBOARD_POINTS)
        .map(([px, py]) => [clampWhiteboardCoord(px), clampWhiteboardCoord(py)])
    )
  }
  if (el.authorId !== undefined) {
    map.set('authorId', sanitizeWhiteboardText(el.authorId).slice(0, 128))
  }
  return map
}

export function appendWhiteboardElement(doc: Y.Doc, el: WhiteboardElement): boolean {
  const validated = validateWhiteboardElement(el)
  if (validated === null) return false
  const arr = doc.getArray<unknown>('whiteboard_elements')
  if (arr.length >= MAX_WHITEBOARD_ELEMENTS) return false
  if (validated.points && validated.points.length > 0) {
    const existingPoints = readWhiteboardElements(doc).reduce(
      (sum, item) => sum + (item.points?.length ?? 0),
      0
    )
    if (existingPoints + validated.points.length > MAX_WHITEBOARD_TOTAL_POINTS) return false
  }
  doc.transact(() => {
    arr.push([elementToYMap(validated)])
  }, 'whiteboard-local')
  return true
}

export function updateWhiteboardElementById(
  doc: Y.Doc,
  id: string,
  updater: (current: WhiteboardElement) => WhiteboardElement
): boolean {
  const arr = doc.getArray<unknown>('whiteboard_elements')
  for (let i = 0; i < arr.length; i += 1) {
    const parsed = validateWhiteboardElement(arr.get(i))
    if (parsed !== null && parsed.id === id) {
      const next = validateWhiteboardElement(updater(parsed))
      if (next === null) return false
      doc.transact(() => {
        arr.delete(i, 1)
        arr.insert(i, [elementToYMap(next)])
      }, 'whiteboard-local')
      return true
    }
  }
  return false
}

export function deleteWhiteboardElementById(doc: Y.Doc, id: string): boolean {
  const arr = doc.getArray<unknown>('whiteboard_elements')
  for (let i = 0; i < arr.length; i += 1) {
    const parsed = validateWhiteboardElement(arr.get(i))
    if (parsed !== null && parsed.id === id) {
      doc.transact(() => {
        arr.delete(i, 1)
      }, 'whiteboard-local')
      return true
    }
  }
  return false
}

export function resolveWhiteboardPalette(host: HTMLElement | null): WhiteboardResolvedPalette {
  const readVar = (styles: CSSStyleDeclaration | null, name: string, fallback: string): string => {
    const val = styles?.getPropertyValue(name).trim()
    return val && val.length > 0 ? val : fallback
  }

  const styles =
    host !== null && typeof window !== 'undefined' ? window.getComputedStyle(host) : null

  return {
    surface: readVar(styles, '--c-surface', 'Canvas'),
    gridDot: readVar(styles, '--c-border', 'GrayText'),
    selection: readVar(styles, '--c-action', 'Highlight'),
    stroke: {
      ink: readVar(styles, '--c-ink', 'CanvasText'),
      muted: readVar(styles, '--c-ink-3', 'GrayText'),
      accent: readVar(styles, '--c-action', 'Highlight'),
      success: readVar(styles, '--c-ok', 'CanvasText'),
      warning: readVar(styles, '--c-warn', 'CanvasText'),
      danger: readVar(styles, '--c-bad', 'CanvasText'),
    },
    fill: {
      ink: readVar(styles, '--c-muted', 'ButtonFace'),
      muted: readVar(styles, '--c-muted', 'ButtonFace'),
      accent: readVar(styles, '--c-accent-soft', 'ButtonFace'),
      success: readVar(styles, '--c-ok-soft', 'ButtonFace'),
      warning: readVar(styles, '--c-warn-soft', 'ButtonFace'),
      danger: readVar(styles, '--c-bad-soft', 'ButtonFace'),
    },
    cursors: [
      readVar(styles, '--c-cursor-1', 'Highlight'),
      readVar(styles, '--c-cursor-2', 'Highlight'),
      readVar(styles, '--c-cursor-3', 'Highlight'),
      readVar(styles, '--c-cursor-4', 'Highlight'),
      readVar(styles, '--c-cursor-5', 'Highlight'),
      readVar(styles, '--c-cursor-6', 'Highlight'),
    ],
    cursorBadgeInk: readVar(styles, '--c-on-inverse', 'HighlightText'),
  }
}

export function screenToWorld(
  screenX: number,
  screenY: number,
  viewport: WhiteboardViewport
): [number, number] {
  const z = viewport.zoom || 1
  return [
    clampWhiteboardCoord((screenX - viewport.panX) / z),
    clampWhiteboardCoord((screenY - viewport.panY) / z),
  ]
}

export function elementBounds(el: WhiteboardElement): {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
} {
  if (el.kind === 'pen' && el.points && el.points.length > 0) {
    let minX = el.points[0]![0]
    let maxX = minX
    let minY = el.points[0]![1]
    let maxY = minY
    for (const [px, py] of el.points) {
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    return { minX: minX - 6, minY: minY - 6, maxX: maxX + 6, maxY: maxY + 6 }
  }
  if (el.kind === 'arrow') {
    const targetX = el.x2 ?? el.x
    const targetY = el.y2 ?? el.y
    return {
      minX: Math.min(el.x, targetX),
      minY: Math.min(el.y, targetY),
      maxX: Math.max(el.x, targetX),
      maxY: Math.max(el.y, targetY),
    }
  }
  const spanW = el.width ?? (el.kind === 'text' ? 200 : 0)
  const spanH = el.height ?? (el.kind === 'text' ? 36 : 0)
  const endX = el.x + spanW
  const endY = el.y + spanH
  return {
    minX: Math.min(el.x, endX),
    minY: Math.min(el.y, endY),
    maxX: Math.max(el.x, endX),
    maxY: Math.max(el.y, endY),
  }
}

export function hitTestWhiteboard(
  elements: readonly WhiteboardElement[],
  worldX: number,
  worldY: number,
  tolerance = 8
): WhiteboardElement | null {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i]!
    const b = elementBounds(el)
    if (
      worldX >= b.minX - tolerance &&
      worldX <= b.maxX + tolerance &&
      worldY >= b.minY - tolerance &&
      worldY <= b.maxY + tolerance
    ) {
      return el
    }
  }
  return null
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
): void {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return
  let line = ''
  let lineIndex = 0
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`
    if (ctx.measureText(candidate).width > maxWidth && line.length > 0) {
      ctx.fillText(line, x, y + lineIndex * lineHeight)
      line = word
      lineIndex += 1
      if (lineIndex >= maxLines) return
    } else {
      line = candidate
    }
  }
  if (line.length > 0 && lineIndex < maxLines) {
    ctx.fillText(line, x, y + lineIndex * lineHeight)
  }
}

export function renderWhiteboardScene(
  ctx: CanvasRenderingContext2D,
  options: {
    readonly width: number
    readonly height: number
    readonly dpr: number
    readonly viewport: WhiteboardViewport
    readonly elements: readonly WhiteboardElement[]
    readonly draftElement: WhiteboardElement | null
    readonly selectedId: string | null
    readonly cursors: readonly WhiteboardCollaboratorCursor[]
    readonly palette: WhiteboardResolvedPalette
  }
): void {
  const { width, height, dpr, viewport, elements, draftElement, selectedId, cursors, palette } =
    options

  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = palette.surface
  ctx.fillRect(0, 0, width, height)

  ctx.translate(viewport.panX, viewport.panY)
  ctx.scale(viewport.zoom, viewport.zoom)

  // Subtle world-space dot grid
  const step = 32
  const startX = Math.floor(-viewport.panX / viewport.zoom / step) * step
  const endX = Math.ceil((width - viewport.panX) / viewport.zoom / step) * step
  const startY = Math.floor(-viewport.panY / viewport.zoom / step) * step
  const endY = Math.ceil((height - viewport.panY) / viewport.zoom / step) * step
  ctx.fillStyle = palette.gridDot
  for (let gx = startX; gx <= endX; gx += step) {
    for (let gy = startY; gy <= endY; gy += step) {
      ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5)
    }
  }

  const all = draftElement !== null ? [...elements, draftElement] : elements
  for (const el of all) {
    const stroke = palette.stroke[el.color]
    const fill = palette.fill[el.color]
    ctx.strokeStyle = stroke
    ctx.lineWidth = el.strokeWidth ?? 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    if (el.kind === 'pen') {
      const pts = el.points ?? []
      if (pts.length > 0) {
        ctx.beginPath()
        ctx.moveTo(pts[0]![0], pts[0]![1])
        for (let i = 1; i < pts.length; i += 1) {
          ctx.lineTo(pts[i]![0], pts[i]![1])
        }
        ctx.stroke()
      }
    } else if (el.kind === 'rect') {
      const b = elementBounds(el)
      ctx.fillStyle = fill
      ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY)
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY)
    } else if (el.kind === 'ellipse') {
      const b = elementBounds(el)
      const rx = Math.max(1, (b.maxX - b.minX) / 2)
      const ry = Math.max(1, (b.maxY - b.minY) / 2)
      ctx.beginPath()
      ctx.ellipse(b.minX + rx, b.minY + ry, rx, ry, 0, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.stroke()
    } else if (el.kind === 'arrow') {
      const x2 = el.x2 ?? el.x
      const y2 = el.y2 ?? el.y
      const angle = Math.atan2(y2 - el.y, x2 - el.x)
      const headLen = 12
      ctx.beginPath()
      ctx.moveTo(el.x, el.y)
      ctx.lineTo(x2, y2)
      ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6)
      )
      ctx.moveTo(x2, y2)
      ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6)
      )
      ctx.stroke()
    } else if (el.kind === 'sticky') {
      const w = Math.max(120, Math.abs(el.width ?? 0) || 160)
      const h = Math.max(88, Math.abs(el.height ?? 0) || 120)
      ctx.fillStyle = fill
      ctx.fillRect(el.x, el.y, w, h)
      ctx.strokeRect(el.x, el.y, w, h)
      ctx.fillStyle = palette.stroke.ink
      ctx.font = '500 13px "Inter Variable", sans-serif'
      ctx.textBaseline = 'top'
      drawWrappedText(ctx, el.text ?? '', el.x + 10, el.y + 10, w - 20, 18, 5)
    } else if (el.kind === 'text') {
      ctx.fillStyle = stroke
      ctx.font = '600 15px "Inter Variable", sans-serif'
      ctx.textBaseline = 'top'
      drawWrappedText(
        ctx,
        el.text ?? '',
        el.x,
        el.y,
        Math.max(180, Math.abs(el.width ?? 0) || 240),
        20,
        6
      )
    }

    if (selectedId !== null && el.id === selectedId) {
      const b = elementBounds(el)
      ctx.save()
      ctx.strokeStyle = palette.selection
      ctx.lineWidth = 1.5 / viewport.zoom
      ctx.setLineDash([5 / viewport.zoom, 4 / viewport.zoom])
      ctx.strokeRect(b.minX - 6, b.minY - 6, b.maxX - b.minX + 12, b.maxY - b.minY + 12)
      ctx.restore()
    }
  }

  for (const cursor of cursors) {
    const cursorColor =
      palette.cursors[Math.abs(cursor.cursorSlot) % palette.cursors.length] ?? palette.selection
    ctx.save()
    ctx.fillStyle = cursorColor
    ctx.beginPath()
    ctx.arc(cursor.x, cursor.y, 5 / viewport.zoom, 0, Math.PI * 2)
    ctx.fill()

    const label = cursor.name.slice(0, 24)
    ctx.font = `${String(Math.round(12 / viewport.zoom))}px "Inter Variable", sans-serif`
    const padX = 6 / viewport.zoom
    const padY = 3 / viewport.zoom
    const textW = ctx.measureText(label).width
    const bx = cursor.x + 8 / viewport.zoom
    const by = cursor.y + 8 / viewport.zoom
    ctx.fillRect(bx, by, textW + padX * 2, 16 / viewport.zoom + padY)
    ctx.fillStyle = palette.cursorBadgeInk
    ctx.textBaseline = 'top'
    ctx.fillText(label, bx + padX, by + padY / 2)
    ctx.restore()
  }

  ctx.restore()
}

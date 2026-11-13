import { useId } from 'react'

export type DiagramKind = 'flowchart' | 'sequence'

export interface FlowchartNode {
  readonly id: string
  readonly label: string
  readonly shape: 'rect' | 'round' | 'diamond'
}

export interface FlowchartEdge {
  readonly from: string
  readonly to: string
  readonly label?: string | undefined
}

export interface ParsedFlowchart {
  readonly kind: 'flowchart'
  readonly direction: 'TD' | 'LR'
  readonly nodes: readonly FlowchartNode[]
  readonly edges: readonly FlowchartEdge[]
}

export interface SequenceParticipant {
  readonly id: string
  readonly label: string
}

export interface SequenceMessage {
  readonly from: string
  readonly to: string
  readonly label: string
  readonly dashed: boolean
}

export interface ParsedSequenceDiagram {
  readonly kind: 'sequence'
  readonly participants: readonly SequenceParticipant[]
  readonly messages: readonly SequenceMessage[]
}

export type ParsedDiagram = ParsedFlowchart | ParsedSequenceDiagram

const MAX_FLOW_NODES = 24
const MAX_FLOW_EDGES = 40
const MAX_SEQ_PARTICIPANTS = 8
const MAX_SEQ_MESSAGES = 24
const SVG_NS = 'http://www.w3.org/2000/svg'

function truncateLabel(value: string, max = 36): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

function parseNodeToken(raw: string): FlowchartNode | null {
  const text = raw.trim()
  if (!text) return null

  const diamond = /^([A-Za-z0-9_-]+)\s*\{([^}]+)\}$/.exec(text)
  if (diamond?.[1] && diamond[2]) {
    return { id: diamond[1], label: truncateLabel(diamond[2]), shape: 'diamond' }
  }

  const round = /^([A-Za-z0-9_-]+)\s*\(([^)]+)\)$/.exec(text)
  if (round?.[1] && round[2]) {
    return { id: round[1], label: truncateLabel(round[2]), shape: 'round' }
  }

  const rect = /^([A-Za-z0-9_-]+)\s*\[([^\]]+)\]$/.exec(text)
  if (rect?.[1] && rect[2]) {
    return { id: rect[1], label: truncateLabel(rect[2]), shape: 'rect' }
  }

  const bare = /^([A-Za-z0-9_-]+)$/.exec(text)
  if (bare?.[1]) {
    return { id: bare[1], label: truncateLabel(bare[1]), shape: 'rect' }
  }

  return null
}

/**
 * Deterministic, linear-time parser for concise `flowchart TD|LR` / `graph TD|LR` and
 * `sequenceDiagram` definitions. Emits zero HTML or CSS styles.
 */
export function parseDiagramSource(source: string): ParsedDiagram {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('%%'))

  const header = lines[0] ?? ''
  if (/^sequenceDiagram\b/i.test(header)) {
    return parseSequenceDiagram(lines.slice(1))
  }

  const dirMatch = /^(?:flowchart|graph)\s+(TD|TB|LR)\b/i.exec(header)
  const direction: 'TD' | 'LR' = dirMatch?.[1]?.toUpperCase() === 'LR' ? 'LR' : 'TD'
  const bodyLines = dirMatch ? lines.slice(1) : lines
  return parseFlowchart(direction, bodyLines)
}

function parseSequenceDiagram(lines: readonly string[]): ParsedSequenceDiagram {
  const participants = new Map<string, SequenceParticipant>()
  const messages: SequenceMessage[] = []

  const ensureParticipant = (id: string, label?: string) => {
    const existing = participants.get(id)
    if (existing) {
      if (label && existing.label === existing.id) {
        participants.set(id, { id, label: truncateLabel(label, 24) })
      }
      return true
    }
    if (participants.size >= MAX_SEQ_PARTICIPANTS) return false
    participants.set(id, { id, label: truncateLabel(label ?? id, 24) })
    return true
  }

  for (const line of lines) {
    const partMatch = /^participant\s+([A-Za-z0-9_-]+)(?:\s+as\s+(.+))?$/i.exec(line)
    if (partMatch?.[1]) {
      ensureParticipant(partMatch[1], partMatch[2])
      continue
    }

    if (messages.length >= MAX_SEQ_MESSAGES) continue
    const msgMatch = /^([A-Za-z0-9_-]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(
      line
    )
    if (msgMatch?.[1] && msgMatch[2] && msgMatch[3] && msgMatch[4]) {
      const okFrom = ensureParticipant(msgMatch[1])
      const okTo = ensureParticipant(msgMatch[3])
      if (okFrom && okTo) {
        messages.push({
          from: msgMatch[1],
          to: msgMatch[3],
          label: truncateLabel(msgMatch[4], 40),
          dashed: msgMatch[2].startsWith('--'),
        })
      }
    }
  }

  return {
    kind: 'sequence',
    participants: [...participants.values()],
    messages,
  }
}

function parseFlowchart(direction: 'TD' | 'LR', lines: readonly string[]): ParsedFlowchart {
  const nodes = new Map<string, FlowchartNode>()
  const edges: FlowchartEdge[] = []

  const upsertNode = (parsed: FlowchartNode) => {
    const existing = nodes.get(parsed.id)
    if (existing) {
      if (parsed.label !== parsed.id || parsed.shape !== 'rect') {
        nodes.set(parsed.id, parsed)
      }
      return true
    }
    if (nodes.size >= MAX_FLOW_NODES) return false
    nodes.set(parsed.id, parsed)
    return true
  }

  for (const line of lines) {
    const edgeMatch = /^(.+?)\s*(?:-->|->)\s*(?:\|([^|]+)\|\s*)?(.+)$/.exec(line)
    if (edgeMatch?.[1] && edgeMatch[3]) {
      const left = parseNodeToken(edgeMatch[1])
      const right = parseNodeToken(edgeMatch[3])
      if (left && right && upsertNode(left) && upsertNode(right) && edges.length < MAX_FLOW_EDGES) {
        edges.push({
          from: left.id,
          to: right.id,
          ...(edgeMatch[2] ? { label: truncateLabel(edgeMatch[2], 24) } : {}),
        })
      }
      continue
    }

    const single = parseNodeToken(line)
    if (single) {
      upsertNode(single)
    }
  }

  return {
    kind: 'flowchart',
    direction,
    nodes: [...nodes.values()],
    edges,
  }
}

export function computeFlowLayers(
  diagram: ParsedFlowchart
): Map<string, { layer: number; slot: number }> {
  const layerById = new Map<string, number>()
  for (const node of diagram.nodes) {
    layerById.set(node.id, 0)
  }

  for (let pass = 0; pass < diagram.nodes.length; pass += 1) {
    for (const edge of diagram.edges) {
      const fromLayer = layerById.get(edge.from) ?? 0
      const toLayer = layerById.get(edge.to) ?? 0
      if (edge.from !== edge.to && toLayer < fromLayer + 1) {
        layerById.set(edge.to, Math.min(fromLayer + 1, 12))
      }
    }
  }

  const buckets = new Map<number, string[]>()
  for (const node of diagram.nodes) {
    const layer = layerById.get(node.id) ?? 0
    const list = buckets.get(layer)
    if (list) list.push(node.id)
    else buckets.set(layer, [node.id])
  }

  const coords = new Map<string, { layer: number; slot: number }>()
  for (const [layer, ids] of buckets.entries()) {
    ids.forEach((id, slot) => {
      coords.set(id, { layer, slot })
    })
  }
  return coords
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Readonly<Record<string, string | number | undefined>>
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) {
      el.setAttribute(k, String(v))
    }
  }
  return el
}

let diagramIdCounter = 0

/**
 * Creates a CSP-safe SVG element (`<svg role="img">`) or empty-state `<p>` for ProseMirror node
 * views. Uses ONLY SVG presentation attributes and semantic token classes — ZERO `<style>` tags
 * and ZERO `style` attributes.
 */
export function createDiagramDomNode(
  doc: Document,
  source: string,
  ariaLabel: string
): SVGSVGElement | HTMLParagraphElement {
  const parsed = parseDiagramSource(source)
  diagramIdCounter = (diagramIdCounter + 1) % 100_000
  const markerId = `docs-diag-arrow-${diagramIdCounter}`

  if (parsed.kind === 'sequence') {
    if (parsed.participants.length === 0) {
      const empty = doc.createElement('p')
      empty.className = 'text-xs text-c-ink-3'
      empty.setAttribute('data-testid', 'docs-diagram-empty')
      empty.textContent = ariaLabel
      return empty
    }

    const colWidth = 160
    const headerHeight = 36
    const rowHeight = 46
    const padX = 24
    const padY = 16
    const width = Math.max(320, padX * 2 + parsed.participants.length * colWidth)
    const height = padY * 2 + headerHeight + Math.max(1, parsed.messages.length) * rowHeight + 24

    const svg = svgEl(doc, 'svg', {
      role: 'img',
      'aria-label': ariaLabel,
      'data-testid': 'docs-diagram-svg',
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      class: 'max-h-[360px] w-full overflow-visible rounded-sm bg-c-sunken p-2',
    })

    const defs = svgEl(doc, 'defs', {})
    const marker = svgEl(doc, 'marker', {
      id: markerId,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    })
    marker.appendChild(svgEl(doc, 'path', { d: 'M 0 1 L 10 5 L 0 9 z', class: 'fill-c-accent-ink' }))
    defs.appendChild(marker)
    svg.appendChild(defs)

    const centerById = new Map<string, number>()
    parsed.participants.forEach((p, idx) => {
      const cx = padX + idx * colWidth + colWidth / 2
      centerById.set(p.id, cx)
      const g = svgEl(doc, 'g', {})
      g.appendChild(
        svgEl(doc, 'line', {
          x1: cx,
          y1: padY + headerHeight,
          x2: cx,
          y2: height - padY,
          'stroke-width': '1.5',
          'stroke-dasharray': '4 4',
          class: 'stroke-c-border-strong',
        })
      )
      g.appendChild(
        svgEl(doc, 'rect', {
          x: cx - 64,
          y: padY,
          width: 128,
          height: headerHeight,
          rx: 8,
          'stroke-width': '1.5',
          class: 'fill-c-surface stroke-c-border-strong',
        })
      )
      const text = svgEl(doc, 'text', {
        x: cx,
        y: padY + 22,
        'text-anchor': 'middle',
        class: 'fill-c-ink font-sans text-xs font-semibold',
      })
      text.textContent = p.label
      g.appendChild(text)
      svg.appendChild(g)
    })

    parsed.messages.forEach((msg, idx) => {
      const x1 = centerById.get(msg.from) ?? padX
      const x2 = centerById.get(msg.to) ?? padX
      const y = padY + headerHeight + 30 + idx * rowHeight
      const g = svgEl(doc, 'g', {})
      g.appendChild(
        svgEl(doc, 'line', {
          x1,
          y1: y,
          x2,
          y2: y,
          'stroke-width': '1.75',
          'stroke-dasharray': msg.dashed ? '5 3' : undefined,
          'marker-end': `url(#${markerId})`,
          class: 'stroke-c-accent-ink',
        })
      )
      const label = svgEl(doc, 'text', {
        x: (x1 + x2) / 2,
        y: y - 6,
        'text-anchor': 'middle',
        class: 'fill-c-ink-2 font-mono text-xs',
      })
      label.textContent = msg.label
      g.appendChild(label)
      svg.appendChild(g)
    })

    return svg
  }

  if (parsed.nodes.length === 0) {
    const empty = doc.createElement('p')
    empty.className = 'text-xs text-c-ink-3'
    empty.setAttribute('data-testid', 'docs-diagram-empty')
    empty.textContent = ariaLabel
    return empty
  }

  const coords = computeFlowLayers(parsed)
  const nodeWidth = 148
  const nodeHeight = 42
  const gapMain = 76
  const gapCross = 32
  const pad = 20

  let maxLayer = 0
  let maxSlot = 0
  for (const pos of coords.values()) {
    if (pos.layer > maxLayer) maxLayer = pos.layer
    if (pos.slot > maxSlot) maxSlot = pos.slot
  }

  const isHorizontal = parsed.direction === 'LR'
  const width = isHorizontal
    ? pad * 2 + (maxLayer + 1) * nodeWidth + maxLayer * gapMain
    : pad * 2 + (maxSlot + 1) * nodeWidth + maxSlot * gapCross
  const height = isHorizontal
    ? pad * 2 + (maxSlot + 1) * nodeHeight + maxSlot * gapCross
    : pad * 2 + (maxLayer + 1) * nodeHeight + maxLayer * gapMain

  const boxById = new Map<string, { x: number; y: number }>()
  for (const node of parsed.nodes) {
    const pos = coords.get(node.id) ?? { layer: 0, slot: 0 }
    const x = isHorizontal
      ? pad + pos.layer * (nodeWidth + gapMain)
      : pad + pos.slot * (nodeWidth + gapCross)
    const y = isHorizontal
      ? pad + pos.slot * (nodeHeight + gapCross)
      : pad + pos.layer * (nodeHeight + gapMain)
    boxById.set(node.id, { x, y })
  }

  const svg = svgEl(doc, 'svg', {
    role: 'img',
    'aria-label': ariaLabel,
    'data-testid': 'docs-diagram-svg',
    viewBox: `0 0 ${Math.max(280, width)} ${Math.max(90, height)}`,
    width: '100%',
    class: 'max-h-[360px] w-full overflow-visible rounded-sm bg-c-sunken p-2',
  })

  const defs = svgEl(doc, 'defs', {})
  const marker = svgEl(doc, 'marker', {
    id: markerId,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 6,
    markerHeight: 6,
    orient: 'auto-start-reverse',
  })
  marker.appendChild(svgEl(doc, 'path', { d: 'M 0 1 L 10 5 L 0 9 z', class: 'fill-c-accent-ink' }))
  defs.appendChild(marker)
  svg.appendChild(defs)

  parsed.edges.forEach((edge) => {
    const fromBox = boxById.get(edge.from)
    const toBox = boxById.get(edge.to)
    if (!fromBox || !toBox) return
    const x1 = isHorizontal ? fromBox.x + nodeWidth : fromBox.x + nodeWidth / 2
    const y1 = isHorizontal ? fromBox.y + nodeHeight / 2 : fromBox.y + nodeHeight
    const x2 = isHorizontal ? toBox.x : toBox.x + nodeWidth / 2
    const y2 = isHorizontal ? toBox.y + nodeHeight / 2 : toBox.y

    const g = svgEl(doc, 'g', {})
    g.appendChild(
      svgEl(doc, 'line', {
        x1,
        y1,
        x2,
        y2,
        'stroke-width': '1.75',
        'marker-end': `url(#${markerId})`,
        class: 'stroke-c-accent-ink',
      })
    )
    if (edge.label) {
      const label = svgEl(doc, 'text', {
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2 - 6,
        'text-anchor': 'middle',
        class: 'fill-c-ink-2 font-mono text-xs',
      })
      label.textContent = edge.label
      g.appendChild(label)
    }
    svg.appendChild(g)
  })

  parsed.nodes.forEach((node) => {
    const box = boxById.get(node.id) ?? { x: pad, y: pad }
    const cx = box.x + nodeWidth / 2
    const cy = box.y + nodeHeight / 2
    const g = svgEl(doc, 'g', {})
    if (node.shape === 'diamond') {
      g.appendChild(
        svgEl(doc, 'polygon', {
          points: `${cx},${box.y} ${box.x + nodeWidth},${cy} ${cx},${box.y + nodeHeight} ${box.x},${cy}`,
          'stroke-width': '1.5',
          class: 'fill-c-accent-soft stroke-c-accent-ink',
        })
      )
    } else {
      g.appendChild(
        svgEl(doc, 'rect', {
          x: box.x,
          y: box.y,
          width: nodeWidth,
          height: nodeHeight,
          rx: node.shape === 'round' ? 20 : 8,
          'stroke-width': '1.5',
          class: 'fill-c-surface stroke-c-border-strong',
        })
      )
    }
    const text = svgEl(doc, 'text', {
      x: cx,
      y: cy + 4,
      'text-anchor': 'middle',
      class: 'fill-c-ink font-sans text-xs font-semibold',
    })
    text.textContent = node.label
    g.appendChild(text)
    svg.appendChild(g)
  })

  return svg
}

/**
 * Pure React SVG diagram renderer using SVG presentation attributes and semantic `@kodera/design-tokens`
 * classes. Emits ZERO `<style>` elements and ZERO `style=` attributes (`style-src-attr 'none'`).
 */
export function DiagramSvgPreview({
  source,
  ariaLabel,
}: {
  readonly source: string
  readonly ariaLabel: string
}) {
  const markerId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const parsed = parseDiagramSource(source)

  if (parsed.kind === 'sequence') {
    if (parsed.participants.length === 0) {
      return (
        <p className="text-xs text-c-ink-3" data-testid="docs-diagram-empty">
          {ariaLabel}
        </p>
      )
    }

    const colWidth = 160
    const headerHeight = 36
    const rowHeight = 46
    const padX = 24
    const padY = 16
    const width = Math.max(320, padX * 2 + parsed.participants.length * colWidth)
    const height = padY * 2 + headerHeight + Math.max(1, parsed.messages.length) * rowHeight + 24

    const centerById = new Map<string, number>()
    parsed.participants.forEach((p, index) => {
      centerById.set(p.id, padX + index * colWidth + colWidth / 2)
    })

    return (
      <svg
        role="img"
        aria-label={ariaLabel}
        data-testid="docs-diagram-svg"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        className="max-h-[360px] w-full overflow-visible rounded-sm bg-c-sunken p-2"
      >
        <defs>
          <marker
            id={`seq-arrow-${markerId}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" className="fill-c-accent-ink" />
          </marker>
        </defs>

        {parsed.participants.map((p) => {
          const cx = centerById.get(p.id) ?? padX
          return (
            <g key={p.id}>
              <line
                x1={cx}
                y1={padY + headerHeight}
                x2={cx}
                y2={height - padY}
                strokeWidth="1.5"
                strokeDasharray="4 4"
                className="stroke-c-border-strong"
              />
              <rect
                x={cx - 64}
                y={padY}
                width="128"
                height={headerHeight}
                rx="8"
                strokeWidth="1.5"
                className="fill-c-surface stroke-c-border-strong"
              />
              <text
                x={cx}
                y={padY + 22}
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                className="fill-c-ink font-sans"
              >
                {p.label}
              </text>
            </g>
          )
        })}

        {parsed.messages.map((msg, idx) => {
          const x1 = centerById.get(msg.from) ?? padX
          const x2 = centerById.get(msg.to) ?? padX
          const y = padY + headerHeight + 30 + idx * rowHeight
          const midX = (x1 + x2) / 2
          return (
            <g key={`${msg.from}-${msg.to}-${idx}`}>
              <line
                x1={x1}
                y1={y}
                x2={x2}
                y2={y}
                strokeWidth="1.75"
                strokeDasharray={msg.dashed ? '5 3' : undefined}
                markerEnd={`url(#seq-arrow-${markerId})`}
                className="stroke-c-accent-ink"
              />
              <text
                x={midX}
                y={y - 6}
                textAnchor="middle"
                fontSize="11"
                className="fill-c-ink-2 font-mono"
              >
                {msg.label}
              </text>
            </g>
          )
        })}
      </svg>
    )
  }

  if (parsed.nodes.length === 0) {
    return (
      <p className="text-xs text-c-ink-3" data-testid="docs-diagram-empty">
        {ariaLabel}
      </p>
    )
  }

  const coords = computeFlowLayers(parsed)
  const nodeWidth = 148
  const nodeHeight = 42
  const gapMain = 76
  const gapCross = 32
  const pad = 20

  let maxLayer = 0
  let maxSlot = 0
  for (const pos of coords.values()) {
    if (pos.layer > maxLayer) maxLayer = pos.layer
    if (pos.slot > maxSlot) maxSlot = pos.slot
  }

  const isHorizontal = parsed.direction === 'LR'
  const width = isHorizontal
    ? pad * 2 + (maxLayer + 1) * nodeWidth + maxLayer * gapMain
    : pad * 2 + (maxSlot + 1) * nodeWidth + maxSlot * gapCross
  const height = isHorizontal
    ? pad * 2 + (maxSlot + 1) * nodeHeight + maxSlot * gapCross
    : pad * 2 + (maxLayer + 1) * nodeHeight + maxLayer * gapMain

  const boxById = new Map<string, { x: number; y: number }>()
  for (const node of parsed.nodes) {
    const pos = coords.get(node.id) ?? { layer: 0, slot: 0 }
    const x = isHorizontal
      ? pad + pos.layer * (nodeWidth + gapMain)
      : pad + pos.slot * (nodeWidth + gapCross)
    const y = isHorizontal
      ? pad + pos.slot * (nodeHeight + gapCross)
      : pad + pos.layer * (nodeHeight + gapMain)
    boxById.set(node.id, { x, y })
  }

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      data-testid="docs-diagram-svg"
      viewBox={`0 0 ${Math.max(280, width)} ${Math.max(90, height)}`}
      width="100%"
      className="max-h-[360px] w-full overflow-visible rounded-sm bg-c-sunken p-2"
    >
      <defs>
        <marker
          id={`flow-arrow-${markerId}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" className="fill-c-accent-ink" />
        </marker>
      </defs>

      {parsed.edges.map((edge, idx) => {
        const fromBox = boxById.get(edge.from)
        const toBox = boxById.get(edge.to)
        if (!fromBox || !toBox) return null

        const x1 = isHorizontal ? fromBox.x + nodeWidth : fromBox.x + nodeWidth / 2
        const y1 = isHorizontal ? fromBox.y + nodeHeight / 2 : fromBox.y + nodeHeight
        const x2 = isHorizontal ? toBox.x : toBox.x + nodeWidth / 2
        const y2 = isHorizontal ? toBox.y + nodeHeight / 2 : toBox.y

        return (
          <g key={`${edge.from}-${edge.to}-${idx}`}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeWidth="1.75"
              markerEnd={`url(#flow-arrow-${markerId})`}
              className="stroke-c-accent-ink"
            />
            {edge.label ? (
              <text
                x={(x1 + x2) / 2}
                y={(y1 + y2) / 2 - 6}
                textAnchor="middle"
                fontSize="11"
                className="fill-c-ink-2 font-mono"
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        )
      })}

      {parsed.nodes.map((node) => {
        const box = boxById.get(node.id) ?? { x: pad, y: pad }
        const cx = box.x + nodeWidth / 2
        const cy = box.y + nodeHeight / 2
        return (
          <g key={node.id}>
            {node.shape === 'diamond' ? (
              <polygon
                points={`${cx},${box.y} ${box.x + nodeWidth},${cy} ${cx},${box.y + nodeHeight} ${box.x},${cy}`}
                strokeWidth="1.5"
                className="fill-c-accent-soft stroke-c-accent-ink"
              />
            ) : (
              <rect
                x={box.x}
                y={box.y}
                width={nodeWidth}
                height={nodeHeight}
                rx={node.shape === 'round' ? '20' : '8'}
                strokeWidth="1.5"
                className="fill-c-surface stroke-c-border-strong"
              />
            )}
            <text
              x={cx}
              y={cy + 4}
              textAnchor="middle"
              fontSize="12"
              fontWeight="600"
              className="fill-c-ink font-sans"
            >
              {node.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

import { DocsWorkspacePanel } from '@/features/docs/DocsWorkspacePanel'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { WhiteboardCanvas } from './WhiteboardCanvas'
import {
  WHITEBOARD_COORD_BOUND,
  appendWhiteboardElement,
  readWhiteboardElements,
  validateWhiteboardElement,
} from './whiteboardModel'

interface MockCanvasCalls {
  transforms: number[][]
  fillRects: number[][]
  strokeRects: number[][]
  fillTexts: string[]
}

function installCanvas2dMock(): MockCanvasCalls {
  const calls: MockCanvasCalls = {
    transforms: [],
    fillRects: [],
    strokeRects: [],
    fillTexts: [],
  }
  const fakeCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    font: '',
    textBaseline: 'top',
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn((...args: number[]) => {
      calls.transforms.push(args)
    }),
    translate: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn((...args: number[]) => {
      calls.fillRects.push(args)
    }),
    strokeRect: vi.fn((...args: number[]) => {
      calls.strokeRects.push(args)
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    ellipse: vi.fn(),
    arc: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn((text: string) => {
      calls.fillTexts.push(text)
    }),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext
  )
  return calls
}

describe('WhiteboardCanvas', () => {
  beforeEach(() => {
    vi.stubGlobal('devicePixelRatio', 2)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts inside DocsWorkspacePanel with HiDPI scaling and zero inline style attributes', async () => {
    const calls = installCanvas2dMock()
    const user = userEvent.setup()

    const { container } = render(
      <DocsWorkspacePanel tenantSlug="acme-fr" channelId="chan-arch" channelName="Architecture" />
    )

    await user.click(screen.getByRole('button', { name: 'Tableau blanc' }))

    const canvas = (await screen.findByTestId('whiteboard-canvas')) as HTMLCanvasElement
    expect(canvas).toBeInTheDocument()
    // 800x480 logical size * devicePixelRatio 2 = 1600x960 backing store
    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(960)
    expect(calls.transforms.some((t) => t[0] === 2 && t[3] === 2)).toBe(true)

    // Strict CSP invariant: zero inline style attributes anywhere in DOM
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('synchronizes shapes and sticky notes across Yjs docs with undo/redo and eraser', async () => {
    installCanvas2dMock()
    const user = userEvent.setup()
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    docA.on('update', (update: Uint8Array) => {
      Y.applyUpdate(docB, update)
    })
    docB.on('update', (update: Uint8Array) => {
      Y.applyUpdate(docA, update)
    })

    const { container } = render(<WhiteboardCanvas doc={docA} initialTool="rect" />)

    const canvas = screen.getByTestId('whiteboard-canvas')
    fireEvent.pointerDown(canvas, { clientX: 80, clientY: 80, button: 0 })
    fireEvent.pointerMove(canvas, { clientX: 220, clientY: 180 })
    fireEvent.pointerUp(canvas)

    expect(readWhiteboardElements(docA)).toHaveLength(1)
    expect(readWhiteboardElements(docB)).toHaveLength(1)
    expect(readWhiteboardElements(docB)[0]?.kind).toBe('rect')

    // Place a sticky note via text bar
    const input = screen.getByLabelText('Texte de la note ou étiquette')
    await user.type(input, 'Architecture cible')
    await user.click(screen.getByRole('button', { name: 'Poser une note' }))

    expect(readWhiteboardElements(docB)).toHaveLength(2)
    expect(readWhiteboardElements(docB)[1]?.text).toBe('Architecture cible')
    expect(screen.getByTestId('whiteboard-element-count')).toHaveTextContent('2 / 2000 éléments')

    // Undo and Redo via buttons
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(readWhiteboardElements(docB)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Rétablir' }))
    expect(readWhiteboardElements(docB)).toHaveLength(2)

    // Erase the rectangle drawn at (80, 80) -> (220, 180)
    await user.click(screen.getByRole('button', { name: 'Gomme (E)' }))
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 120, button: 0 })
    fireEvent.pointerUp(canvas)
    expect(readWhiteboardElements(docB)).toHaveLength(1)

    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    docA.destroy()
    docB.destroy()
  })

  it('syncs live collaborator cursors via Awareness with integer coordinates and reduced motion', () => {
    const calls = installCanvas2dMock()
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    )

    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const awarenessA = new Awareness(docA)
    const awarenessB = new Awareness(docB)

    awarenessB.setLocalState({
      user: { id: 'peer-1', name: 'Camille', cursorSlot: 2 },
      cursor: { x: 140, y: 95 },
    })
    const encoded = encodeAwarenessUpdate(awarenessB, [awarenessB.clientID])
    applyAwarenessUpdate(awarenessA, encoded, 'remote')

    render(<WhiteboardCanvas doc={docA} awareness={awarenessA} participantName="Nadia" />)

    expect(screen.getByTestId('whiteboard-surface')).toHaveAttribute('data-reduced-motion', 'true')
    expect(screen.getByTestId('whiteboard-reduced-motion-badge')).toBeInTheDocument()
    expect(screen.getByTestId('whiteboard-collaborators-count')).toHaveTextContent(
      '2 participants actifs'
    )
    expect(calls.fillTexts).toContain('Camille')

    // Local pointer move publishes integer coordinates
    const canvas = screen.getByTestId('whiteboard-canvas')
    fireEvent.pointerMove(canvas, { clientX: 123.7, clientY: 88.4 })
    const localState = awarenessA.getLocalState() as {
      cursor?: { x: number; y: number }
    } | null
    expect(Number.isSafeInteger(localState?.cursor?.x)).toBe(true)
    expect(Number.isSafeInteger(localState?.cursor?.y)).toBe(true)

    // Keyboard shortcuts for zoom and tool switch
    const surface = screen.getByTestId('whiteboard-surface')
    fireEvent.keyDown(surface, { key: '+' })
    expect(screen.getByTestId('whiteboard-zoom-readout')).toHaveTextContent('125%')
    fireEvent.keyDown(surface, { key: '0' })
    expect(screen.getByTestId('whiteboard-zoom-readout')).toHaveTextContent('100%')
    fireEvent.keyDown(surface, { key: 'o' })
    expect(screen.getByRole('button', { name: 'Ellipse (O)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    awarenessA.destroy()
    awarenessB.destroy()
    docA.destroy()
    docB.destroy()
  })

  it('rejects raw hex colors, URLs, oversized text, and out-of-range coordinates in the model', () => {
    const rawHex = String.fromCharCode(35) + 'ff0000'
    expect(
      validateWhiteboardElement({
        id: 'el-hex',
        kind: 'rect',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        color: rawHex,
      })
    ).toBeNull()

    expect(
      validateWhiteboardElement({
        id: 'el-url',
        kind: 'rect',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        color: 'url(https://attacker.example/leak)',
      })
    ).toBeNull()

    expect(
      validateWhiteboardElement({
        id: 'el-oob',
        kind: 'rect',
        x: WHITEBOARD_COORD_BOUND + 1,
        y: 0,
        width: 10,
        height: 10,
        color: 'accent',
      })
    ).toBeNull()

    expect(
      validateWhiteboardElement({
        id: 'el-edge-sum',
        kind: 'rect',
        x: WHITEBOARD_COORD_BOUND - 5,
        y: 0,
        width: 20,
        height: 10,
        color: 'accent',
      })
    ).toBeNull()

    expect(
      validateWhiteboardElement({
        id: 'el-long',
        kind: 'sticky',
        x: 0,
        y: 0,
        width: 120,
        height: 90,
        color: 'warning',
        text: 'a'.repeat(513),
      })
    ).toBeNull()
  })

  it('produces Yjs binary updates accepted 1:1 by server yjs_collab/engine.mjs across all 6 element kinds', async () => {
    const { resolve } = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const engineModuleUrl = pathToFileURL(resolve(process.cwd(), '../server/yjs_collab/engine.mjs'))
      .href
    const engine = (await import(/* @vite-ignore */ engineModuleUrl)) as {
      load: (snapshot?: Uint8Array, updates?: Uint8Array[]) => Y.Doc
      inspect: (doc: Y.Doc) => { markdown: string; state: Uint8Array; links: string[] }
      validateWhiteboard: (doc: Y.Doc) => number
    }

    const clientDoc = new Y.Doc()
    try {
      expect(
        appendWhiteboardElement(clientDoc, {
          id: 'wb-pen-1',
          kind: 'pen',
          x: 10,
          y: 20,
          color: 'ink',
          strokeWidth: 2.5,
          points: [
            [10, 20],
            [40, 65],
            [90, 80],
          ],
          authorId: 'member-1',
        })
      ).toBe(true)
      expect(
        appendWhiteboardElement(clientDoc, {
          id: 'wb-rect-1',
          kind: 'rect',
          x: 100,
          y: 120,
          width: 180,
          height: 90,
          color: 'accent',
          fill: 'accent',
          strokeWidth: 2,
          authorId: 'member-1',
        })
      ).toBe(true)
      expect(
        appendWhiteboardElement(clientDoc, {
          id: 'wb-ellipse-1',
          kind: 'ellipse',
          x: 320,
          y: 140,
          width: 110,
          height: 80,
          color: 'success',
          strokeWidth: 1.5,
        })
      ).toBe(true)
      expect(
        appendWhiteboardElement(clientDoc, {
          id: 'wb-arrow-1',
          kind: 'arrow',
          x: 280,
          y: 165,
          x2: 320,
          y2: 180,
          color: 'muted',
          strokeWidth: 2.5,
        })
      ).toBe(true)
      expect(
        appendWhiteboardElement(clientDoc, {
          id: 'wb-sticky-1',
          kind: 'sticky',
          x: 80,
          y: 260,
          width: 168,
          height: 116,
          color: 'warning',
          text: 'Note souveraine validée',
          authorId: 'member-2',
        })
      ).toBe(true)
      expect(
        appendWhiteboardElement(clientDoc, {
          id: 'wb-text-1',
          kind: 'text',
          x: 300,
          y: 280,
          width: 200,
          height: 36,
          color: 'danger',
          text: 'Schéma réseau',
        })
      ).toBe(true)

      const wireUpdate = Y.encodeStateAsUpdate(clientDoc)
      const serverDoc = engine.load(wireUpdate)
      try {
        expect(engine.validateWhiteboard(serverDoc)).toBe(6)
        const inspected = engine.inspect(serverDoc)
        expect(inspected.state.byteLength).toBeGreaterThan(0)
      } finally {
        serverDoc.destroy()
      }
    } finally {
      clientDoc.destroy()
    }
  })
})

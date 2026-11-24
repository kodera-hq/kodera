import { cx } from '@/ui/cx'
import { TOUCH_TARGET } from '@/ui/touchTarget'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { whiteboardCopy } from './whiteboardMessages'
import {
  MAX_WHITEBOARD_ELEMENTS,
  MAX_WHITEBOARD_TEXT,
  WHITEBOARD_COLOR_SLOTS,
  appendWhiteboardElement,
  clampWhiteboardCoord,
  clampWhiteboardSpan,
  clampZoom,
  deleteWhiteboardElementById,
  hitTestWhiteboard,
  readWhiteboardElements,
  renderWhiteboardScene,
  resolveWhiteboardPalette,
  sanitizeWhiteboardText,
  screenToWorld,
  updateWhiteboardElementById,
  type WhiteboardCollaboratorCursor,
  type WhiteboardColorSlot,
  type WhiteboardElement,
  type WhiteboardTool,
  type WhiteboardViewport,
} from './whiteboardModel'

export interface WhiteboardCanvasProps {
  readonly doc?: Y.Doc | undefined
  readonly awareness?: Awareness | undefined
  readonly participantId?: string | undefined
  readonly participantName?: string | undefined
  readonly cursorSlot?: number | undefined
  readonly readOnly?: boolean | undefined
  readonly initialTool?: WhiteboardTool | undefined
}

const TOOL_ORDER: readonly WhiteboardTool[] = [
  'select',
  'pen',
  'rect',
  'ellipse',
  'arrow',
  'sticky',
  'text',
  'eraser',
  'pan',
]

const COLOR_SWATCH_CLASSES: Readonly<Record<WhiteboardColorSlot, string>> = {
  ink: 'bg-c-ink text-c-on-inverse',
  muted: 'bg-c-muted-2 text-c-ink',
  accent: 'bg-c-action text-c-on-inverse',
  success: 'bg-c-ok text-c-on-inverse',
  warning: 'bg-c-warn text-c-on-inverse',
  danger: 'bg-c-bad text-c-on-inverse',
}

function nextElementId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `wb-${crypto.randomUUID().slice(0, 12)}`
  }
  return `wb-${Math.random().toString(36).slice(2, 12)}`
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function WhiteboardCanvas({
  doc: externalDoc,
  awareness: externalAwareness,
  participantId = 'local-member',
  participantName = 'Membre',
  cursorSlot = 0,
  readOnly = false,
  initialTool = 'pen',
}: WhiteboardCanvasProps) {
  const { i18n } = useTranslation()
  const copy = whiteboardCopy(i18n.resolvedLanguage)
  const noteInputId = useId()

  const ownedDoc = useMemo(() => new Y.Doc(), [])
  const activeDoc = externalDoc ?? ownedDoc

  const ownedAwareness = useMemo(() => new Awareness(activeDoc), [activeDoc])
  const activeAwareness = externalAwareness ?? ownedAwareness

  useEffect(() => {
    return () => {
      if (externalAwareness === undefined) {
        ownedAwareness.destroy()
      }
      if (externalDoc === undefined) {
        ownedDoc.destroy()
      }
    }
  }, [externalAwareness, externalDoc, ownedAwareness, ownedDoc])

  const undoManager = useMemo(() => {
    const arr = activeDoc.getArray<unknown>('whiteboard_elements')
    return new Y.UndoManager(arr, {
      trackedOrigins: new Set(['whiteboard-local']),
    })
  }, [activeDoc])

  useEffect(() => {
    return () => {
      undoManager.destroy()
    }
  }, [undoManager])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [tool, setTool] = useState<WhiteboardTool>(readOnly ? 'pan' : initialTool)
  const [color, setColor] = useState<WhiteboardColorSlot>('accent')
  const [viewport, setViewport] = useState<WhiteboardViewport>({ panX: 24, panY: 24, zoom: 1 })
  const [canvasSize, setCanvasSize] = useState<{ readonly width: number; readonly height: number }>(
    { width: 800, height: 480 }
  )
  const [elements, setElements] = useState<readonly WhiteboardElement[]>(() =>
    readWhiteboardElements(activeDoc)
  )
  const [draftElement, setDraftElement] = useState<WhiteboardElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [noteText, setNoteText] = useState<string>('')
  const [collaborators, setCollaborators] = useState<readonly WhiteboardCollaboratorCursor[]>([])
  const [participantCount, setParticipantCount] = useState<number>(1)
  const [canUndo, setCanUndo] = useState<boolean>(false)
  const [canRedo, setCanRedo] = useState<boolean>(false)
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => readReducedMotion())

  const interactionRef = useRef<
    | {
        readonly mode: 'pan'
        readonly startScreenX: number
        readonly startScreenY: number
        readonly basePanX: number
        readonly basePanY: number
      }
    | {
        readonly mode: 'drag-selected'
        readonly id: string
        readonly startWorldX: number
        readonly startWorldY: number
        readonly originX: number
        readonly originY: number
        readonly originX2: number | undefined
        readonly originY2: number | undefined
        readonly originPoints: readonly [number, number][] | undefined
      }
    | {
        readonly mode: 'draw'
        readonly id: string
        readonly kind: 'pen' | 'rect' | 'ellipse' | 'arrow'
        readonly startWorldX: number
        readonly startWorldY: number
        readonly points: [number, number][]
      }
    | null
  >(null)

  // Reduced-motion media listener
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReducedMotion(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Observe Yjs array & undo stack
  useEffect(() => {
    const arr = activeDoc.getArray<unknown>('whiteboard_elements')
    const syncElements = () => {
      setElements(readWhiteboardElements(activeDoc))
      setCanUndo(undoManager.undoStack.length > 0)
      setCanRedo(undoManager.redoStack.length > 0)
    }
    syncElements()
    arr.observeDeep(syncElements)
    undoManager.on('stack-item-added', syncElements)
    undoManager.on('stack-item-popped', syncElements)
    return () => {
      arr.unobserveDeep(syncElements)
      undoManager.off('stack-item-added', syncElements)
      undoManager.off('stack-item-popped', syncElements)
    }
  }, [activeDoc, undoManager])

  // Publish local user identity & observe remote collaborator cursors
  useEffect(() => {
    const safeSlot = Math.max(0, Math.min(15, Math.trunc(cursorSlot)))
    activeAwareness.setLocalStateField('user', {
      id: participantId.slice(0, 128),
      name: participantName.slice(0, 128),
      cursorSlot: safeSlot,
    })

    const syncAwareness = () => {
      const states = activeAwareness.getStates()
      const remote: WhiteboardCollaboratorCursor[] = []
      let total = 0
      states.forEach((state, clientId) => {
        if (typeof state !== 'object' || state === null) return
        total += 1
        if (clientId === activeAwareness.clientID) return
        const rec = state as Record<string, unknown>
        const rawCursor = rec['cursor']
        const rawUser = rec['user']
        if (typeof rawCursor !== 'object' || rawCursor === null) return
        const cur = rawCursor as Record<string, unknown>
        const cxVal = cur['x']
        const cyVal = cur['y']
        if (typeof cxVal !== 'number' || typeof cyVal !== 'number') return
        if (!Number.isFinite(cxVal) || !Number.isFinite(cyVal)) return
        const usr =
          typeof rawUser === 'object' && rawUser !== null
            ? (rawUser as Record<string, unknown>)
            : {}
        const name = typeof usr['name'] === 'string' && usr['name'] ? usr['name'] : 'Pair'
        const slot =
          typeof usr['cursorSlot'] === 'number' && Number.isInteger(usr['cursorSlot'])
            ? usr['cursorSlot']
            : clientId % 6
        remote.push({
          clientId,
          name,
          x: clampWhiteboardCoord(cxVal),
          y: clampWhiteboardCoord(cyVal),
          cursorSlot: slot,
        })
      })
      setCollaborators(remote)
      setParticipantCount(Math.max(1, total))
    }

    syncAwareness()
    activeAwareness.on('change', syncAwareness)
    return () => {
      activeAwareness.off('change', syncAwareness)
    }
  }, [activeAwareness, cursorSlot, participantId, participantName])

  // ResizeObserver for HiDPI canvas sizing without inline styles
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const nextW = Math.max(320, Math.round(entry.contentRect.width))
      const nextH = Math.max(240, Math.round(entry.contentRect.height))
      setCanvasSize((prev) =>
        prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }
      )
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  // Render 2D canvas whenever state or size changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    let ctx: CanvasRenderingContext2D | null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (ctx === null) return

    const dpr =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? Math.max(1, Math.min(4, window.devicePixelRatio))
        : 1
    const targetW = Math.round(canvasSize.width * dpr)
    const targetH = Math.round(canvasSize.height * dpr)
    if (canvas.width !== targetW) canvas.width = targetW
    if (canvas.height !== targetH) canvas.height = targetH

    const palette = resolveWhiteboardPalette(hostRef.current ?? canvas)
    renderWhiteboardScene(ctx, {
      width: canvasSize.width,
      height: canvasSize.height,
      dpr,
      viewport,
      elements,
      draftElement,
      selectedId,
      cursors: collaborators,
      palette,
    })
  }, [canvasSize, collaborators, draftElement, elements, selectedId, viewport])

  const selectedElement = useMemo(
    () => (selectedId === null ? null : (elements.find((e) => e.id === selectedId) ?? null)),
    [elements, selectedId]
  )

  const publishCursor = useCallback(
    (worldX: number, worldY: number) => {
      activeAwareness.setLocalStateField('cursor', {
        x: Math.round(clampWhiteboardCoord(worldX)),
        y: Math.round(clampWhiteboardCoord(worldY)),
      })
    },
    [activeAwareness]
  )

  const handleUndo = useCallback(() => {
    if (readOnly) return
    undoManager.undo()
  }, [readOnly, undoManager])

  const handleRedo = useCallback(() => {
    if (readOnly) return
    undoManager.redo()
  }, [readOnly, undoManager])

  const handleDeleteSelected = useCallback(() => {
    if (readOnly || selectedId === null) return
    deleteWhiteboardElementById(activeDoc, selectedId)
    setSelectedId(null)
  }, [activeDoc, readOnly, selectedId])

  const localCoordsFromPointer = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = localCoordsFromPointer(event)
    const [wx, wy] = screenToWorld(sx, sy, viewport)
    publishCursor(wx, wy)

    if (tool === 'pan' || readOnly || event.button === 1) {
      interactionRef.current = {
        mode: 'pan',
        startScreenX: sx,
        startScreenY: sy,
        basePanX: viewport.panX,
        basePanY: viewport.panY,
      }
      return
    }

    if (tool === 'eraser') {
      const hit = hitTestWhiteboard(elements, wx, wy)
      if (hit !== null) {
        deleteWhiteboardElementById(activeDoc, hit.id)
        undoManager.stopCapturing()
        if (selectedId === hit.id) setSelectedId(null)
      }
      return
    }

    if (tool === 'select') {
      const hit = hitTestWhiteboard(elements, wx, wy)
      if (hit !== null) {
        setSelectedId(hit.id)
        if (hit.text !== undefined) setNoteText(hit.text)
        interactionRef.current = {
          mode: 'drag-selected',
          id: hit.id,
          startWorldX: wx,
          startWorldY: wy,
          originX: hit.x,
          originY: hit.y,
          originX2: hit.x2,
          originY2: hit.y2,
          originPoints: hit.points,
        }
      } else {
        setSelectedId(null)
      }
      return
    }

    const author = sanitizeWhiteboardText(participantId).slice(0, 128) || undefined

    if (tool === 'sticky' || tool === 'text') {
      const id = nextElementId()
      const textContent = sanitizeWhiteboardText(
        noteText.trim() || (tool === 'sticky' ? copy.defaultStickyText : copy.defaultLabelText)
      )
      const widthVal = clampWhiteboardSpan(wx, tool === 'sticky' ? 168 : 200)
      const heightVal = clampWhiteboardSpan(wy, tool === 'sticky' ? 116 : 36)
      const created: WhiteboardElement = {
        id,
        kind: tool,
        x: wx,
        y: wy,
        width: widthVal,
        height: heightVal,
        color,
        text: textContent,
        authorId: author,
      }
      if (appendWhiteboardElement(activeDoc, created)) {
        undoManager.stopCapturing()
        setSelectedId(id)
      }
      return
    }

    const id = nextElementId()
    const initialPoints: [number, number][] = [[wx, wy]]
    interactionRef.current = {
      mode: 'draw',
      id,
      kind: tool,
      startWorldX: wx,
      startWorldY: wy,
      points: initialPoints,
    }
    if (tool === 'pen') {
      setDraftElement({
        id,
        kind: 'pen',
        x: wx,
        y: wy,
        color,
        strokeWidth: 2.5,
        points: initialPoints,
        authorId: author,
      })
    } else if (tool === 'arrow') {
      setDraftElement({
        id,
        kind: 'arrow',
        x: wx,
        y: wy,
        x2: wx,
        y2: wy,
        color,
        strokeWidth: 2.5,
        authorId: author,
      })
    } else {
      setDraftElement({
        id,
        kind: tool,
        x: wx,
        y: wy,
        width: 0,
        height: 0,
        color,
        strokeWidth: 2.5,
        authorId: author,
      })
    }
  }

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = localCoordsFromPointer(event)
    const [wx, wy] = screenToWorld(sx, sy, viewport)
    publishCursor(wx, wy)

    const current = interactionRef.current
    if (current === null) return

    if (current.mode === 'pan') {
      setViewport((prev) => ({
        ...prev,
        panX: Math.round(current.basePanX + (sx - current.startScreenX)),
        panY: Math.round(current.basePanY + (sy - current.startScreenY)),
      }))
      return
    }

    if (current.mode === 'drag-selected') {
      const dx = wx - current.startWorldX
      const dy = wy - current.startWorldY
      updateWhiteboardElementById(activeDoc, current.id, (el) => {
        const nextX = clampWhiteboardCoord(current.originX + dx)
        const nextY = clampWhiteboardCoord(current.originY + dy)
        if (el.kind === 'arrow') {
          return {
            ...el,
            x: nextX,
            y: nextY,
            x2: clampWhiteboardCoord((current.originX2 ?? current.originX) + dx),
            y2: clampWhiteboardCoord((current.originY2 ?? current.originY) + dy),
          }
        }
        if (el.kind === 'pen' && current.originPoints) {
          return {
            ...el,
            x: nextX,
            y: nextY,
            points: current.originPoints.map(([px, py]) => [
              clampWhiteboardCoord(px + dx),
              clampWhiteboardCoord(py + dy),
            ]),
          }
        }
        return {
          ...el,
          x: nextX,
          y: nextY,
          ...(el.width !== undefined ? { width: clampWhiteboardSpan(nextX, el.width) } : {}),
          ...(el.height !== undefined ? { height: clampWhiteboardSpan(nextY, el.height) } : {}),
        }
      })
      return
    }

    const author = sanitizeWhiteboardText(participantId).slice(0, 128) || undefined

    if (current.mode === 'draw') {
      if (current.kind === 'pen') {
        if (current.points.length < 1024) {
          current.points.push([wx, wy])
        }
        setDraftElement({
          id: current.id,
          kind: 'pen',
          x: current.startWorldX,
          y: current.startWorldY,
          color,
          strokeWidth: 2.5,
          points: [...current.points],
          authorId: author,
        })
      } else if (current.kind === 'arrow') {
        setDraftElement({
          id: current.id,
          kind: 'arrow',
          x: current.startWorldX,
          y: current.startWorldY,
          x2: wx,
          y2: wy,
          color,
          strokeWidth: 2.5,
          authorId: author,
        })
      } else {
        setDraftElement({
          id: current.id,
          kind: current.kind,
          x: current.startWorldX,
          y: current.startWorldY,
          width: clampWhiteboardSpan(current.startWorldX, wx - current.startWorldX),
          height: clampWhiteboardSpan(current.startWorldY, wy - current.startWorldY),
          color,
          strokeWidth: 2.5,
          authorId: author,
        })
      }
    }
  }

  const finishInteraction = () => {
    const current = interactionRef.current
    interactionRef.current = null
    if (current !== null && current.mode === 'draw' && draftElement !== null) {
      let committed: WhiteboardElement = draftElement
      if (
        (draftElement.kind === 'rect' || draftElement.kind === 'ellipse') &&
        Math.abs(draftElement.width ?? 0) < 4 &&
        Math.abs(draftElement.height ?? 0) < 4
      ) {
        committed = {
          ...draftElement,
          width: clampWhiteboardSpan(draftElement.x, 96),
          height: clampWhiteboardSpan(draftElement.y, 64),
        }
      } else if (
        draftElement.kind === 'arrow' &&
        Math.abs((draftElement.x2 ?? draftElement.x) - draftElement.x) < 4 &&
        Math.abs((draftElement.y2 ?? draftElement.y) - draftElement.y) < 4
      ) {
        committed = {
          ...draftElement,
          x2: clampWhiteboardCoord(draftElement.x + 96),
          y2: clampWhiteboardCoord(draftElement.y + 48),
        }
      }
      if (appendWhiteboardElement(activeDoc, committed)) {
        undoManager.stopCapturing()
        setSelectedId(committed.id)
      }
    } else if (current !== null && current.mode === 'drag-selected') {
      undoManager.stopCapturing()
    }
    setDraftElement(null)
  }

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.1 : 0.9
      setViewport((prev) => ({ ...prev, zoom: clampZoom(prev.zoom * factor) }))
    } else {
      setViewport((prev) => ({
        ...prev,
        panX: Math.round(prev.panX - event.deltaX),
        panY: Math.round(prev.panY - event.deltaY),
      }))
    }
  }

  const handlePlaceStickyFromBar = () => {
    if (readOnly) return
    const id = nextElementId()
    const [wx, wy] = screenToWorld(canvasSize.width / 3, canvasSize.height / 3, viewport)
    const content = sanitizeWhiteboardText(noteText.trim() || copy.defaultStickyText)
    const author = sanitizeWhiteboardText(participantId).slice(0, 128) || undefined
    const created: WhiteboardElement = {
      id,
      kind: 'sticky',
      x: wx,
      y: wy,
      width: clampWhiteboardSpan(wx, 168),
      height: clampWhiteboardSpan(wy, 116),
      color,
      text: content,
      authorId: author,
    }
    if (appendWhiteboardElement(activeDoc, created)) {
      undoManager.stopCapturing()
      setSelectedId(id)
    }
  }

  const handleUpdateSelectedText = () => {
    if (readOnly || selectedElement === null) return
    if (selectedElement.kind !== 'sticky' && selectedElement.kind !== 'text') return
    updateWhiteboardElementById(activeDoc, selectedElement.id, (el) => ({
      ...el,
      text: sanitizeWhiteboardText(noteText),
    }))
  }

  useEffect(() => {
    const el = hostRef.current
    if (el === null) return undefined

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const targetTag = (event.target as HTMLElement | null)?.tagName
      if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') return

      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) handleRedo()
        else handleUndo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        handleRedo()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
        event.preventDefault()
        handleDeleteSelected()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setViewport((prev) => ({ ...prev, zoom: clampZoom(prev.zoom + 0.25) }))
        return
      }
      if (event.key === '-') {
        event.preventDefault()
        setViewport((prev) => ({ ...prev, zoom: clampZoom(prev.zoom - 0.25) }))
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        setViewport({ panX: 24, panY: 24, zoom: 1 })
        return
      }

      if (readOnly || mod || event.altKey) return
      const keyMap: Readonly<Record<string, WhiteboardTool>> = {
        v: 'select',
        p: 'pen',
        r: 'rect',
        o: 'ellipse',
        a: 'arrow',
        s: 'sticky',
        t: 'text',
        e: 'eraser',
        h: 'pan',
      }
      const mapped = keyMap[event.key.toLowerCase()]
      if (mapped !== undefined) {
        event.preventDefault()
        setTool(mapped)
      }
    }

    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [handleDeleteSelected, handleRedo, handleUndo, readOnly, selectedId])

  return (
    <div
      ref={hostRef}
      role="region"
      aria-label={copy.regionLabel}
      tabIndex={0}
      data-testid="whiteboard-surface"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      className={cx(
        'flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-c-border bg-c-surface p-3 focus-visible:ring focus-visible:outline-hidden',
        !reducedMotion && 'transition-colors'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-c-border-soft pb-2">
        <div role="toolbar" aria-label={copy.toolbarLabel} className="flex flex-wrap gap-1">
          {TOOL_ORDER.map((item) => {
            const disabled = readOnly && item !== 'pan' && item !== 'select'
            return (
              <button
                key={item}
                type="button"
                disabled={disabled}
                aria-pressed={tool === item}
                onClick={() => setTool(item)}
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border px-2 py-1 text-xs font-medium focus-visible:ring focus-visible:outline-hidden disabled:opacity-50',
                  TOUCH_TARGET,
                  tool === item
                    ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                    : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                )}
              >
                {copy.tools[item]}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={copy.colorGroupLabel} className="flex items-center gap-1">
            {WHITEBOARD_COLOR_SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                aria-label={copy.colors[slot]}
                aria-pressed={color === slot}
                onClick={() => {
                  setColor(slot)
                  if (!readOnly && selectedId !== null) {
                    updateWhiteboardElementById(activeDoc, selectedId, (el) => ({
                      ...el,
                      color: slot,
                    }))
                  }
                }}
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border px-2 py-1 text-xs font-semibold focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET,
                  COLOR_SWATCH_CLASSES[slot],
                  color === slot ? 'border-c-ink ring' : 'border-c-border'
                )}
              >
                {copy.colors[slot]}
              </button>
            ))}
          </div>

          <div role="group" aria-label={copy.zoomGroupLabel} className="flex items-center gap-1">
            <button
              type="button"
              disabled={readOnly || !canUndo}
              onClick={handleUndo}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-2 py-1 text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:opacity-50',
                TOUCH_TARGET
              )}
            >
              {copy.actions.undo}
            </button>
            <button
              type="button"
              disabled={readOnly || !canRedo}
              onClick={handleRedo}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-2 py-1 text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden disabled:opacity-50',
                TOUCH_TARGET
              )}
            >
              {copy.actions.redo}
            </button>
            <button
              type="button"
              aria-label={copy.actions.zoomOut}
              onClick={() => setViewport((prev) => ({ ...prev, zoom: clampZoom(prev.zoom - 0.25) }))}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-2 py-1 font-mono text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET
              )}
            >
              −
            </button>
            <button
              type="button"
              aria-label={copy.actions.resetView}
              data-testid="whiteboard-zoom-readout"
              onClick={() => setViewport({ panX: 24, panY: 24, zoom: 1 })}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-muted px-2 py-1 font-mono text-xs font-medium text-c-ink hover:bg-c-muted-2 focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET
              )}
            >
              {`${String(Math.round(viewport.zoom * 100))}%`}
            </button>
            <button
              type="button"
              aria-label={copy.actions.zoomIn}
              onClick={() => setViewport((prev) => ({ ...prev, zoom: clampZoom(prev.zoom + 0.25) }))}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-surface px-2 py-1 font-mono text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET
              )}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={noteInputId} className="text-xs font-medium text-c-ink-2">
            {copy.textInputLabel}
          </label>
          <input
            id={noteInputId}
            type="text"
            maxLength={MAX_WHITEBOARD_TEXT}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value.slice(0, MAX_WHITEBOARD_TEXT))}
            placeholder={copy.textInputPlaceholder}
            className="min-h-8 flex-1 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:ring focus-visible:outline-hidden"
          />
          <button
            type="button"
            onClick={handlePlaceStickyFromBar}
            className={cx(
              'inline-flex min-h-8 items-center justify-center rounded-md border border-transparent bg-c-action px-3 py-1 text-xs font-semibold text-c-on-inverse hover:bg-c-action-hover focus-visible:ring focus-visible:outline-hidden',
              TOUCH_TARGET
            )}
          >
            {copy.actions.addSticky}
          </button>
          {selectedElement !== null &&
            (selectedElement.kind === 'sticky' || selectedElement.kind === 'text') && (
              <button
                type="button"
                onClick={handleUpdateSelectedText}
                className={cx(
                  'inline-flex min-h-8 items-center justify-center rounded-md border border-c-border bg-c-muted px-3 py-1 text-xs font-medium text-c-ink hover:bg-c-muted-2 focus-visible:ring focus-visible:outline-hidden',
                  TOUCH_TARGET
                )}
              >
                {copy.actions.updateText}
              </button>
            )}
          {selectedId !== null && (
            <button
              type="button"
              onClick={handleDeleteSelected}
              className={cx(
                'inline-flex min-h-8 items-center justify-center rounded-md border border-c-bad bg-c-bad-soft px-3 py-1 text-xs font-semibold text-c-bad-ink hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                TOUCH_TARGET
              )}
            >
              {copy.actions.deleteSelected}
            </button>
          )}
        </div>
      )}

      <canvas
        ref={canvasRef}
        aria-label={copy.canvasLabel}
        data-testid="whiteboard-canvas"
        width={canvasSize.width}
        height={canvasSize.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
        onWheel={handleWheel}
        className={cx(
          'block min-h-12 w-full flex-1 rounded-md border border-c-border-soft bg-c-surface',
          tool === 'pan' ? 'cursor-grab' : 'cursor-crosshair'
        )}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-c-ink-3">
        <span>{copy.shortcutsHint}</span>
        <div className="flex items-center gap-3 font-mono">
          {reducedMotion && (
            <span
              data-testid="whiteboard-reduced-motion-badge"
              className="rounded-sm bg-c-muted px-2 py-1 text-c-ink-2"
            >
              {copy.reducedMotionBadge}
            </span>
          )}
          <span data-testid="whiteboard-collaborators-count">
            {copy.collaboratorsLabel(participantCount)}
          </span>
          <span data-testid="whiteboard-element-count">
            {copy.elementCountLabel(elements.length, MAX_WHITEBOARD_ELEMENTS)}
          </span>
        </div>
      </div>
    </div>
  )
}

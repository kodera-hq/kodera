import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import {
  CallDockRegion,
  clampPillPosition,
  FloatingCallPill,
  PILL_MARGIN,
  PILL_NUDGE_STEP,
  snapPillPosition,
  type FloatingCallPillProps,
} from './FloatingCallPill'

function setup(props: Partial<FloatingCallPillProps> = {}) {
  const handlers = {
    onToggleMute: vi.fn(),
    onToggleDeafen: vi.fn(),
    onOpenCall: vi.fn(),
    onRedock: vi.fn(),
    onLeave: vi.fn(),
  }
  const view = render(
    <FloatingCallPill
      label="Appel en cours"
      room="office-hours"
      category="Équipe"
      status="connected"
      statusLabel="Connecté"
      quality="excellent"
      qualityLabel="Connexion excellente"
      muted={false}
      deafened={false}
      labels={{
        mute: 'Couper le micro',
        deafen: 'Couper le son',
        leave: 'Quitter',
        openCall: 'Ouvrir la scène d’appel',
        redock: 'Rattacher à la barre latérale',
      }}
      {...handlers}
      {...props}
    />
  )
  return { ...view, ...handlers }
}

describe('FloatingCallPill geometry helpers', () => {
  it('clamps coordinates inside viewport margins and snaps near corners and edges', () => {
    expect(clampPillPosition(-50, -20, 304, 56, 1280, 800)).toEqual({
      x: PILL_MARGIN,
      y: PILL_MARGIN,
    })
    expect(clampPillPosition(2000, 1200, 304, 56, 1280, 800)).toEqual({
      x: 1280 - 304 - PILL_MARGIN,
      y: 800 - 56 - PILL_MARGIN,
    })
    // Near top-left corner snaps cleanly to margin
    expect(snapPillPosition(36, 30, 304, 56, 1280, 800)).toEqual({
      x: PILL_MARGIN,
      y: PILL_MARGIN,
    })
    // Middle of viewport stays where dropped
    expect(snapPillPosition(420, 310, 304, 56, 1280, 800)).toEqual({
      x: 420,
      y: 310,
    })
  })
})

describe('FloatingCallPill', () => {
  const originalInnerWidth = window.innerWidth
  const originalInnerHeight = window.innerHeight

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: originalInnerHeight,
      configurable: true,
      writable: true,
    })
  })

  it('renders pure icon-only controls with zero Détacher/Ancrer button text and positions via CSSOM custom properties', () => {
    setup()
    const pill = screen.getByTestId('floating-call-pill')
    expect(pill).toHaveClass('call-floating-pill', 'fixed', 'bg-c-inverse')
    expect(pill.className).not.toMatch(/material-/)
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe('960px')
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe('72px')

    // Zero visible text on all icon action buttons; never renders words like Détacher / Ancrer / Réduire.
    expect(screen.queryByText(/détacher|ancrer|réduire/iu)).toBeNull()
    for (const name of [
      'Couper le micro',
      'Couper le son',
      'Rattacher à la barre latérale',
      'Quitter',
    ]) {
      const button = within(pill).getByRole('button', { name })
      expect(button).toHaveTextContent('')
    }
    expect(
      within(pill)
        .getByRole('button', { name: 'Rattacher à la barre latérale' })
        .querySelector('[data-glyph="redock"]')
    ).not.toBeNull()
  })

  it('drags smoothly via pointer capture, snaps near corners, and ignores pointer down on buttons', async () => {
    const user = userEvent.setup()
    const { onToggleMute, onOpenCall } = setup()
    const pill = screen.getByTestId('floating-call-pill')
    const setCapture = vi.fn()
    const releaseCapture = vi.fn()
    Object.defineProperty(pill, 'setPointerCapture', { value: setCapture, configurable: true })
    Object.defineProperty(pill, 'releasePointerCapture', {
      value: releaseCapture,
      configurable: true,
    })

    // Clicking a control button triggers its handler and does not capture drag.
    const muteBtn = within(pill).getByRole('button', { name: 'Couper le micro' })
    fireEvent.pointerDown(muteBtn, { pointerId: 1, button: 0, clientX: 980, clientY: 85 })
    expect(setCapture).not.toHaveBeenCalled()
    await user.click(muteBtn)
    expect(onToggleMute).toHaveBeenCalledTimes(1)

    // Clicking the room name opens the stage.
    await user.click(within(pill).getByRole('button', { name: /Ouvrir la scène d’appel/ }))
    expect(onOpenCall).toHaveBeenCalledTimes(1)

    // Dragging the pill frame moves --call-pill-x / --call-pill-y and snaps near top-left corner.
    fireEvent.pointerDown(pill, {
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      clientX: 960,
      clientY: 72,
    })
    expect(setCapture).toHaveBeenCalledWith(7)

    fireEvent.pointerMove(pill, { pointerId: 7, clientX: 500, clientY: 300 })
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe('500px')
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe('300px')

    // Drop near top-left edge -> snaps cleanly to PILL_MARGIN (16px, 16px).
    fireEvent.pointerUp(pill, { pointerId: 7, clientX: 28, clientY: 24 })
    expect(releaseCapture).toHaveBeenCalledWith(7)
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe(`${PILL_MARGIN}px`)
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe(`${PILL_MARGIN}px`)
  })

  it('clamps the pill back inside the viewport when the window resizes smaller', () => {
    setup()
    const pill = screen.getByTestId('floating-call-pill')
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe('960px')

    Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: 360, configurable: true, writable: true })
    fireEvent(window, new Event('resize'))

    expect(pill.style.getPropertyValue('--call-pill-x')).toBe(`${480 - 304 - PILL_MARGIN}px`)
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe('72px')
  })

  it('supports Alt+Arrow keyboard nudging, Alt+Shift+Arrow corner snapping, and Escape re-docking', () => {
    const { onRedock } = setup()
    const pill = screen.getByTestId('floating-call-pill')
    pill.focus()

    fireEvent.keyDown(pill, { key: 'ArrowLeft', altKey: true })
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe(`${960 - PILL_NUDGE_STEP}px`)

    fireEvent.keyDown(pill, { key: 'ArrowDown', altKey: true })
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe(`${72 + PILL_NUDGE_STEP}px`)

    // Alt+Shift+Arrow snaps straight to corners
    fireEvent.keyDown(pill, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    fireEvent.keyDown(pill, { key: 'ArrowUp', altKey: true, shiftKey: true })
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe(`${PILL_MARGIN}px`)
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe(`${PILL_MARGIN}px`)

    fireEvent.keyDown(pill, { key: 'ArrowRight', altKey: true, shiftKey: true })
    fireEvent.keyDown(pill, { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(pill.style.getPropertyValue('--call-pill-x')).toBe(`${1280 - 304 - PILL_MARGIN}px`)
    expect(pill.style.getPropertyValue('--call-pill-y')).toBe(`${800 - 56 - PILL_MARGIN}px`)

    // Escape re-docks into the sidebar
    fireEvent.keyDown(pill, { key: 'Escape' })
    expect(onRedock).toHaveBeenCalledTimes(1)
  })

  it('renders asSection={false} inside an external persistent <section> and forwards redockButtonRef', () => {
    const redockButtonRef = { current: null as HTMLButtonElement | null }
    render(
      <section aria-label="Appel en cours">
        <FloatingCallPill
          asSection={false}
          redockButtonRef={redockButtonRef}
          label="Appel en cours"
          room="office-hours"
          status="connected"
          statusLabel="Connecté"
          muted={false}
          deafened={false}
          onToggleMute={vi.fn()}
          onToggleDeafen={vi.fn()}
          onOpenCall={vi.fn()}
          onRedock={vi.fn()}
          onLeave={vi.fn()}
          labels={{
            mute: 'Couper le micro',
            deafen: 'Couper le son',
            leave: 'Quitter',
            openCall: 'Ouvrir la scène d’appel',
            redock: 'Rattacher à la barre latérale',
          }}
        />
      </section>
    )
    const regions = screen.getAllByRole('region', { name: 'Appel en cours' })
    expect(regions).toHaveLength(1)
    expect(redockButtonRef.current).toBe(
      screen.getByRole('button', { name: 'Rattacher à la barre latérale' })
    )
  })

  it('clamps stored coordinates against current viewport when resized while docked and then detached', () => {
    const onRedock = vi.fn()
    const view = render(
      <CallDockRegion label="Appel en cours" floating={false} onRedock={onRedock}>
        <span>docked</span>
      </CallDockRegion>
    )
    const region = screen.getByRole('region', { name: 'Appel en cours' })

    // Detach at 1280px -> x = 960px
    view.rerender(
      <CallDockRegion label="Appel en cours" floating onRedock={onRedock}>
        <span>floating</span>
      </CallDockRegion>
    )
    expect(region.style.getPropertyValue('--call-pill-x')).toBe('960px')

    // Re-dock into sidebar, resize viewport down to 390px while docked, then detach again
    view.rerender(
      <CallDockRegion label="Appel en cours" floating={false} onRedock={onRedock}>
        <span>docked</span>
      </CallDockRegion>
    )
    expect(region.style.getPropertyValue('--call-pill-x')).toBe('')

    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: 640, configurable: true, writable: true })
    fireEvent(window, new Event('resize'))

    view.rerender(
      <CallDockRegion label="Appel en cours" floating onRedock={onRedock}>
        <span>floating</span>
      </CallDockRegion>
    )
    expect(region.style.getPropertyValue('--call-pill-x')).toBe(`${390 - 304 - PILL_MARGIN}px`)
    expect(region.style.getPropertyValue('--call-pill-y')).toBe('72px')
  })

  it('re-clamps a pill parked against the lower right corner when its content grows, and disconnects on unmount', () => {
    const observers: {
      callback: ResizeObserverCallback
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }[] = []
    class RecordingResizeObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, observe: this.observe, disconnect: this.disconnect })
      }
    }
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver)
    try {
      const view = render(
        <CallDockRegion label="Appel en cours" floating onRedock={vi.fn()}>
          <span>floating</span>
        </CallDockRegion>
      )
      const region = screen.getByRole('region', { name: 'Appel en cours' })
      expect(observers).toHaveLength(1)
      expect(observers[0]?.observe).toHaveBeenCalledWith(region)

      // Park the pill in the bottom-right corner at its compact size.
      fireEvent.keyDown(region, { key: 'ArrowRight', altKey: true, shiftKey: true })
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true, shiftKey: true })
      expect(region.style.getPropertyValue('--call-pill-x')).toBe(`${1280 - 304 - PILL_MARGIN}px`)
      expect(region.style.getPropertyValue('--call-pill-y')).toBe(`${800 - 56 - PILL_MARGIN}px`)

      // A camera tile mounts: the pill grows to 256px tall and must stay inside the viewport.
      vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 0, width: 304, height: 256 })
      )
      observers[0]?.callback([], {} as ResizeObserver)
      expect(region.style.getPropertyValue('--call-pill-x')).toBe(`${1280 - 304 - PILL_MARGIN}px`)
      expect(region.style.getPropertyValue('--call-pill-y')).toBe(`${800 - 256 - PILL_MARGIN}px`)

      view.unmount()
      expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still floats and clamps where ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    try {
      render(
        <CallDockRegion label="Appel en cours" floating onRedock={vi.fn()}>
          <span>floating</span>
        </CallDockRegion>
      )
      const region = screen.getByRole('region', { name: 'Appel en cours' })
      expect(region.style.getPropertyValue('--call-pill-x')).toBe('960px')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders companionChat button with aria-expanded, 99+ unread badge cap, and clears badge when open', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const view = setup({
      companionChat: {
        open: false,
        unread: 140,
        label: 'Discussion de l’appel (99+)',
        onToggle,
      },
    })
    const pill = screen.getByTestId('floating-call-pill')
    const chatBtn = within(pill).getByRole('button', { name: 'Discussion de l’appel (99+)' })
    expect(chatBtn).toHaveAttribute('aria-expanded', 'false')
    expect(within(pill).getByTestId('companion-chat-unread')).toHaveTextContent('99+')

    await user.click(chatBtn)
    expect(onToggle).toHaveBeenCalledTimes(1)

    view.rerender(
      <FloatingCallPill
        label="Appel en cours"
        room="office-hours"
        status="connected"
        statusLabel="Connecté"
        muted={false}
        deafened={false}
        companionChat={{
          open: true,
          unread: 0,
          label: 'Discussion de l’appel',
          onToggle,
        }}
        onToggleMute={vi.fn()}
        onToggleDeafen={vi.fn()}
        onOpenCall={vi.fn()}
        onRedock={vi.fn()}
        onLeave={vi.fn()}
        labels={{
          mute: 'Couper le micro',
          deafen: 'Couper le son',
          leave: 'Quitter',
          openCall: 'Ouvrir la scène d’appel',
          redock: 'Rattacher à la barre latérale',
        }}
      />
    )
    expect(
      within(screen.getByTestId('floating-call-pill')).getByRole('button', {
        name: 'Discussion de l’appel',
      })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByTestId('companion-chat-unread')).toBeNull()
  })
})

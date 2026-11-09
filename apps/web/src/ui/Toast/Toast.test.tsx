import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './Toast'
import type { ToastOptions } from './Toast'

function Trigger({
  kind = 'success' as const,
  title = 'Domaine vérifié.',
  description,
  duration,
}: {
  kind?: 'success' | 'error'
  title?: string
  description?: string
  duration?: number
}) {
  const notify = useToast()
  const options: ToastOptions = {
    kind,
    title,
    ...(description === undefined ? {} : { description }),
    ...(duration === undefined ? {} : { duration }),
  }
  return (
    <button type="button" onClick={() => notify(options)}>
      Déclencher
    </button>
  )
}

function renderWithProvider(props: Parameters<typeof Trigger>[0] = {}) {
  return render(
    <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
      <Trigger {...props} />
    </ToastProvider>
  )
}

describe('Toast', () => {
  it('throws a clear error when useToast is called outside a ToastProvider', () => {
    // A hook that fails silently — returning a no-op notify — hides the
    // missing provider until a screen ships with toasts nobody ever sees.
    function Orphan() {
      useToast()
      return null
    }
    // React logs the thrown error to the console during the render pass;
    // silence it so the test output stays about the assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => render(<Orphan />)).toThrow(/ToastProvider/)

    spy.mockRestore()
  })

  it('shows a toast when notify is called', async () => {
    const user = userEvent.setup()
    renderWithProvider({ title: 'Domaine vérifié.' })

    await user.click(screen.getByRole('button', { name: 'Déclencher' }))

    expect(await screen.findByText('Domaine vérifié.')).toBeInTheDocument()
  })

  it('shows the description when the caller gives one', async () => {
    const user = userEvent.setup()
    renderWithProvider({ title: 'Erreur', description: 'Réessayez dans un instant.' })

    await user.click(screen.getByRole('button', { name: 'Déclencher' }))

    expect(await screen.findByText('Réessayez dans un instant.')).toBeInTheDocument()
  })

  it('dismisses through its own close control', async () => {
    const user = userEvent.setup()
    renderWithProvider({ title: 'Domaine vérifié.' })

    await user.click(screen.getByRole('button', { name: 'Déclencher' }))
    await screen.findByText('Domaine vérifié.')

    await user.click(screen.getByRole('button', { name: 'Fermer' }))

    await vi.waitFor(() => {
      expect(screen.queryByText('Domaine vérifié.')).toBeNull()
    })
  })
})

describe('Toast auto-dismiss', () => {
  // `fireEvent`, not `userEvent`, throughout this block: `userEvent`'s click
  // sequence awaits its own internal timers even with `advanceTimers`
  // configured, and hangs against fake ones in this environment. `fireEvent`
  // dispatches synchronously, so only Radix's own `setTimeout`/`clearTimeout`
  // dismiss countdown needs faking.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dismisses itself after its duration elapses', async () => {
    renderWithProvider({ title: 'Domaine vérifié.', duration: 1000 })

    fireEvent.click(screen.getByRole('button', { name: 'Déclencher' }))
    expect(screen.getByText('Domaine vérifié.')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(1500)

    expect(screen.queryByText('Domaine vérifié.')).toBeNull()
  })

  it('pauses the dismiss timer while the pointer is over the toast', async () => {
    renderWithProvider({ title: 'Domaine vérifié.', duration: 1000 })

    fireEvent.click(screen.getByRole('button', { name: 'Déclencher' }))
    expect(screen.getByText('Domaine vérifié.')).toBeInTheDocument()

    // Radix pauses on `pointermove` over the viewport region as a whole, not
    // the individual toast, and `pointerleave` does not bubble — the region
    // itself, found the way a screen reader would (its own accessible name),
    // is where these have to be dispatched.
    const viewport = screen.getByRole('region', { name: 'Notifications' })

    fireEvent.pointerMove(viewport)
    await vi.advanceTimersByTimeAsync(1500)
    // Still there: hovering paused the countdown before it ran out.
    expect(screen.getByText('Domaine vérifié.')).toBeInTheDocument()

    fireEvent.pointerLeave(viewport)
    await vi.advanceTimersByTimeAsync(1500)
    expect(screen.queryByText('Domaine vérifié.')).toBeNull()
  })

  it('pauses the dismiss timer while a toast has focus, and resumes it on blur', async () => {
    renderWithProvider({ title: 'Domaine vérifié.', duration: 1000 })

    fireEvent.click(screen.getByRole('button', { name: 'Déclencher' }))
    expect(screen.getByText('Domaine vérifié.')).toBeInTheDocument()

    // Same reasoning as the hover test above: Radix pauses on `focusin` over
    // the viewport region as a whole (any toast gaining focus bubbles there),
    // and `focusout` only resumes once `relatedTarget` has left the region.
    const viewport = screen.getByRole('region', { name: 'Notifications' })

    fireEvent.focusIn(viewport)
    await vi.advanceTimersByTimeAsync(1500)
    // Still there: focus inside the region paused the countdown before it ran out.
    expect(screen.getByText('Domaine vérifié.')).toBeInTheDocument()

    fireEvent.focusOut(viewport, { relatedTarget: document.body })
    await vi.advanceTimersByTimeAsync(1500)
    expect(screen.queryByText('Domaine vérifié.')).toBeNull()
  })
})

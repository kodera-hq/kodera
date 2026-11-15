import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('is reachable and shown by keyboard focus alone, not only by hover', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="Copié dans le presse-papiers">
        <button type="button">Copier</button>
      </Tooltip>
    )

    expect(screen.queryByRole('tooltip')).toBeNull()

    await user.tab()

    expect(screen.getByRole('button', { name: 'Copier' })).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copié dans le presse-papiers')
  })

  it('hides again when focus moves away', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <Tooltip content="Info">
          <button type="button">Un</button>
        </Tooltip>
        <button type="button">Deux</button>
      </div>
    )

    await user.tab()
    await screen.findByRole('tooltip')

    await user.tab()

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('does not change the trigger element it wraps', () => {
    render(
      <Tooltip content="Info">
        <button type="button">Copier</button>
      </Tooltip>
    )

    expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument()
  })

  it('forwards its ref to the content, once shown', async () => {
    const user = userEvent.setup()
    const ref = createRef<HTMLDivElement>()
    render(
      <Tooltip content="Info" ref={ref}>
        <button type="button">Copier</button>
      </Tooltip>
    )

    expect(ref.current).toBeNull()

    await user.tab()

    expect(await screen.findByRole('tooltip')).toBe(ref.current)
  })

  it('keeps both the child hint and additional tooltip detail for ordinary tooltips', async () => {
    const user = userEvent.setup()
    render(
      <>
        <p id="own-hint">Own hint</p>
        <Tooltip content="Additional detail">
          <button aria-label="Control" aria-describedby="own-hint" />
        </Tooltip>
      </>
    )
    await user.tab()
    await screen.findByRole('tooltip')
    expect(screen.getByRole('button', { name: 'Control' })).toHaveAccessibleDescription(
      'Own hint Additional detail'
    )
  })

  describe('names: the tooltip of an icon-only control', () => {
    it('shows the name on focus for the eye only, never as a second description', async () => {
      const user = userEvent.setup()
      render(
        <Tooltip content="Couper le micro" names>
          <button type="button" aria-label="Couper le micro">
            <svg aria-hidden="true" />
          </button>
        </Tooltip>
      )
      await user.tab()
      const button = screen.getByRole('button', { name: 'Couper le micro' })
      // At once on focus: no waiting for it.
      expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Couper le micro')
      // Out of the accessibility tree, and not pointed at by the trigger: the name is read once.
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(button).not.toHaveAttribute('aria-describedby')
      expect(button).toHaveAccessibleDescription('')
    })

    it('keeps a description the trigger sets itself', async () => {
      const user = userEvent.setup()
      render(
        <div>
          <p id="hint">Raccourci : Ctrl M</p>
          <Tooltip content="Micro" names>
            <button type="button" aria-label="Micro" aria-describedby="hint" />
          </Tooltip>
        </div>
      )
      await user.tab()
      await screen.findByRole('tooltip', { hidden: true })
      expect(screen.getByRole('button', { name: 'Micro' })).toHaveAccessibleDescription(
        'Raccourci : Ctrl M'
      )
    })

    it('preserves child hints, ref and focus handler through a naming tooltip', async () => {
      const user = userEvent.setup()
      const trigger = createRef<HTMLButtonElement>()
      const onFocus = vi.fn()
      render(
        <>
          <p id="shortcut">Keyboard shortcut</p>
          <p id="availability">Available now</p>
          <Tooltip content="Microphone" names>
            <button
              ref={trigger}
              onFocus={onFocus}
              aria-label="Microphone"
              aria-describedby="shortcut availability"
            />
          </Tooltip>
        </>
      )
      const button = screen.getByRole('button', { name: 'Microphone' })
      expect(trigger.current).toBe(button)
      expect(button).toHaveAttribute('aria-describedby', 'shortcut availability')
      await user.tab()
      expect(onFocus).toHaveBeenCalledTimes(1)
      expect(button).toHaveAttribute('aria-describedby', 'shortcut availability')
      expect(button).toHaveAccessibleDescription('Keyboard shortcut Available now')
      await user.keyboard('{Escape}')
      expect(button).toHaveFocus()
      expect(button).toHaveAttribute('aria-describedby', 'shortcut availability')
    })

    it('hides on Escape and keeps the focus where it was (WCAG 1.4.13)', async () => {
      const user = userEvent.setup()
      render(
        <Tooltip content="Quitter" names>
          <button type="button" aria-label="Quitter" />
        </Tooltip>
      )
      await user.tab()
      await screen.findByRole('tooltip', { hidden: true })
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
      expect(screen.getByRole('button', { name: 'Quitter' })).toHaveFocus()
    })

    describe('under the pointer', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('shows the name after 300 ms, sooner than a description tooltip', async () => {
        vi.useFakeTimers()
        render(
          <Tooltip content="Son" names>
            <button type="button" aria-label="Son" />
          </Tooltip>
        )
        // A pointer event fired by hand: user-event waits on timers of its own, which a fake clock
        // never runs.
        fireEvent.pointerMove(screen.getByRole('button', { name: 'Son' }), { pointerType: 'mouse' })
        // 300 ms, not Radix's 700 ms default: the name is what the pointer is looking for.
        await act(async () => {
          vi.advanceTimersByTime(290)
        })
        expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
        await act(async () => {
          vi.advanceTimersByTime(20)
        })
        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Son')
      })
    })
  })
})

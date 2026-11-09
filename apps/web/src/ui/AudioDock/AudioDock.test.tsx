import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AudioDock } from './AudioDock'
import type { AudioDockProps } from './AudioDock'

function setup(props: Partial<AudioDockProps> = {}) {
  const handlers = { onToggleMute: vi.fn(), onToggleDeafen: vi.fn(), onLeave: vi.fn() }
  render(
    <AudioDock
      label="Appel en cours"
      room="Point quotidien"
      category="Équipe"
      status="connected"
      statusLabel="Connecté · 12 min"
      muted={false}
      deafened={false}
      labels={{ mute: 'Micro', deafen: 'Son', leave: 'Quitter' }}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe('AudioDock', () => {
  it("draws the member's microphone meter, hidden from screen readers, only when asked", () => {
    const meterRef = { current: null as HTMLSpanElement | null }
    setup({ meterRef })
    const region = screen.getByRole('region', { name: 'Appel en cours' })
    const meter = region.querySelector('[data-mic-meter]')!
    expect(meter).toHaveAttribute('aria-hidden', 'true')
    // The caller's element: its width is set frame by frame, starting empty.
    expect(meterRef.current).toBe(meter.firstElementChild)
    expect(meterRef.current).toHaveClass('origin-left', 'bg-c-ok-on-dark')
    // Empty until the caller draws it.
    expect(meterRef.current!.style.transform).toBe('scaleX(0)')
    expect(meter).toHaveClass('bg-c-inverse-2')
  })

  it("sets the caller's settings control in the top row, before the open-call button", () => {
    setup({
      settings: <button type="button">Réglages audio</button>,
      onOpenCall: vi.fn(),
      labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter', openCall: "Ouvrir l'appel" },
    })
    const settings = screen.getByRole('button', { name: 'Réglages audio' })
    const openCall = screen.getByRole('button', { name: "Ouvrir l'appel" })
    expect(settings.parentElement!.nextElementSibling).toBe(openCall)
    // One push to the row's end, on the first of the two.
    expect(settings.parentElement).toHaveClass('ml-auto')
    expect(openCall).not.toHaveClass('ml-auto')
  })

  it('draws no meter without one', () => {
    setup()
    expect(
      screen.getByRole('region', { name: 'Appel en cours' }).querySelector('[data-mic-meter]')
    ).toBeNull()
  })

  it('is a named region carrying the room, its category and the status in words', () => {
    setup()
    const region = screen.getByRole('region', { name: 'Appel en cours' })
    expect(within(region).getByText('Point quotidien')).toBeInTheDocument()
    expect(within(region).getByText('Équipe')).toBeInTheDocument()
    expect(within(region).getByText('Connecté · 12 min')).toBeInTheDocument()
  })

  it('makes mute and deafen toggles that report aria-pressed, and leave a plain button', () => {
    setup({ muted: true })
    expect(screen.getByRole('button', { name: 'Micro' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Son' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Quitter' })).not.toHaveAttribute('aria-pressed')
  })

  it('calls back once per control, by click and by keyboard', async () => {
    const user = userEvent.setup()
    const handlers = setup()
    await user.click(screen.getByRole('button', { name: 'Micro' }))
    await user.tab()
    expect(screen.getByRole('button', { name: 'Son' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.tab()
    await user.keyboard(' ')
    expect(handlers.onToggleMute).toHaveBeenCalledTimes(1)
    expect(handlers.onToggleDeafen).toHaveBeenCalledTimes(1)
    expect(handlers.onLeave).toHaveBeenCalledTimes(1)
  })

  it('draws a pressed toggle as the on-inverse plate with a struck glyph, not a hue', () => {
    setup({ muted: true, deafened: false })
    const mute = screen.getByRole('button', { name: 'Micro' })
    expect(mute).toHaveClass('bg-c-on-inverse', 'text-c-inverse')
    expect(mute.querySelector('[data-glyph="mic-off"]')).not.toBeNull()
    const deafen = screen.getByRole('button', { name: 'Son' })
    expect(deafen).toHaveClass('bg-c-inverse-2', 'text-c-on-inverse')
    expect(deafen.querySelector('[data-glyph="headphones"]')).not.toBeNull()
  })

  it('draws deafened as the pressed plate with struck headphones', () => {
    setup({ muted: true, deafened: true })
    const deafen = screen.getByRole('button', { name: 'Son' })
    expect(deafen).toHaveAttribute('aria-pressed', 'true')
    expect(deafen).toHaveClass('bg-c-on-inverse', 'text-c-inverse')
    expect(deafen.querySelector('[data-glyph="headphones-off"]')).not.toBeNull()
    expect(deafen.querySelector('[data-glyph="headphones"]')).toBeNull()
  })

  it('draws an idle toggle on c-inverse-2, with a dim edge on hover', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Micro' })).toHaveClass(
      'bg-c-inverse-2',
      'hover:border-c-on-inverse-dim'
    )
  })

  it('writes the room in c-on-inverse and the category and open-call glyph in the dim ink', () => {
    setup({
      onOpenCall: () => undefined,
      labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter', openCall: 'Ouvrir l’appel' },
    })
    const region = screen.getByRole('region', { name: 'Appel en cours' })
    expect(within(region).getByText('Équipe')).toHaveClass('text-c-on-inverse-dim')
    expect(within(region).getByRole('button', { name: 'Ouvrir l’appel' })).toHaveClass(
      'bg-c-inverse-2',
      'text-c-on-inverse-dim'
    )
  })

  it('fills the dot and writes the state in c-ok-on-dark only when connected', () => {
    setup({ statusLabel: 'Connecté · 12 min' })
    const region = screen.getByRole('region', { name: 'Appel en cours' })
    expect(region.querySelector('[data-status="connected"]')).toHaveClass('bg-c-ok-on-dark')
    const state = within(region).getByText('Connecté · 12 min')
    expect(state).toHaveClass('text-c-ok-on-dark', 'text-sm', 'font-bold', 'break-words')
    // It wraps, never cut: « Connecté · écoute seule » is wider than the sidebar dock's column.
    expect(state).not.toHaveClass('truncate')
  })

  for (const status of ['connecting', 'reconnecting'] as const) {
    it(`draws a hollow dot and the caller’s words while ${status}`, () => {
      setup({ status, statusLabel: 'Reconnexion…' })
      const region = screen.getByRole('region', { name: 'Appel en cours' })
      const dot = region.querySelector(`[data-status="${status}"]`)
      expect(dot).toHaveClass('border', 'border-c-on-inverse-dim')
      expect(dot).not.toHaveClass('bg-c-ok-on-dark')
      expect(within(region).getByText('Reconnexion…')).toHaveClass('text-c-on-inverse-dim')
    })
  }

  it('draws « Quitter » as the only red fill in the dock', () => {
    setup({
      onOpenCall: () => undefined,
      settings: <button type="button">Réglages audio</button>,
      labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter', openCall: 'Ouvrir l’appel' },
    })
    const region = screen.getByRole('region', { name: 'Appel en cours' })
    const red = [region, ...region.querySelectorAll('*')].filter((el) =>
      [...el.classList].some((name) => /(^|:)bg-c-bad/.test(name))
    )
    expect(red).toEqual([screen.getByRole('button', { name: 'Quitter' })])
  })

  it('returns to the call from an optional, named button', async () => {
    const user = userEvent.setup()
    const onOpenCall = vi.fn()
    setup({
      onOpenCall,
      labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter', openCall: 'Ouvrir l’appel' },
    })
    const open = screen.getByRole('button', { name: 'Ouvrir l’appel' })
    expect(open).toHaveClass('focus-visible:ring', 'narrow:min-h-[44px]', 'narrow:min-w-[44px]')
    await user.click(open)
    expect(onOpenCall).toHaveBeenCalledTimes(1)
  })

  it('draws no open-call button without onOpenCall, and refuses one without a name', () => {
    setup()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => setup({ onOpenCall: () => {} })).toThrow(/labels\.openCall/)
    quiet.mockRestore()
  })

  it('draws leave on c-bad, whose hover adds an on-inverse edge and no lighter fill', () => {
    setup()
    const leave = screen.getByRole('button', { name: 'Quitter' })
    expect(leave).toHaveClass('bg-c-bad', 'border-transparent', 'hover:border-c-on-inverse')
    expect([...leave.classList].filter((name) => name.startsWith('hover:bg-'))).toEqual([])
  })

  it('draws every ring in the on-inverse tone, offset onto the inverse ground', () => {
    setup({
      onOpenCall: () => undefined,
      labels: { mute: 'Micro', deafen: 'Son', leave: 'Quitter', openCall: 'Ouvrir l’appel' },
    })
    const region = screen.getByRole('region', { name: 'Appel en cours' })
    expect(region).toHaveClass('focus-ground-inverse', 'bg-c-inverse', 'inverse-edge')
    // The three controls and the open-call square, each filled, so each ring is offset.
    expect(within(region).getAllByRole('button')).toHaveLength(4)
    for (const button of within(region).getAllByRole('button')) {
      expect(button).toHaveClass(
        'focus-visible:ring',
        'focus-offset',
        'focus-visible:ring-offset-2'
      )
    }
  })

  it('draws each control as an icon only, its label the accessible name, in the sidebar', () => {
    setup()
    for (const name of ['Micro', 'Son', 'Quitter']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-label', name)
      expect(button).toHaveTextContent('')
      // 40 px, with the 44 px floor wherever the narrow layout applies.
      expect(button).toHaveClass('h-10', 'narrow:min-h-[44px]', 'narrow:min-w-[44px]')
    }
  })

  it('shows a control’s label as a tooltip on focus, read once, and hides it on Escape', async () => {
    const user = userEvent.setup()
    setup()
    const mute = screen.getByRole('button', { name: 'Micro' })
    mute.focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}{Tab}')
    expect(mute).toHaveFocus()
    // The tooltip is for the eye: drawn, hidden from the accessibility tree, and not the
    // button's description, so the name is not read a second time.
    // At once on focus, with no waiting.
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Micro')
    expect(mute).not.toHaveAttribute('aria-describedby')
    expect(mute).toHaveAccessibleDescription('')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
    expect(mute).toHaveFocus()
  })

  it('shows a control’s label as a tooltip under the pointer', async () => {
    const user = userEvent.setup()
    setup()
    await user.hover(screen.getByRole('button', { name: 'Quitter' }))
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent('Quitter')
  })

  it('is the full-width banner with 52 px controls on the phone', () => {
    setup({ layout: 'banner' })
    expect(screen.getByRole('region', { name: 'Appel en cours' })).toHaveClass('w-full')
    for (const name of ['Micro', 'Son', 'Quitter']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('h-[52px]', 'w-[52px]')
      expect(button).toHaveTextContent('')
    }
  })
})

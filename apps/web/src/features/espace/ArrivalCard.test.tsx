import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ArrivalCard, isArrivalsChannel } from './ArrivalCard'
import { arrivalInserts } from './ArrivalInsert'

describe('isArrivalsChannel', () => {
  it.each(['arrivées', 'Arrivées', '#arrivees', 'arrivals', '👋-welcome', 'Bienvenue'])(
    'greets newcomers in %s',
    (name) => expect(isArrivalsChannel(name)).toBe(true)
  )
  it.each(['general', 'arrivées-staff', 'départs', ''])('is not the welcome channel: %s', (name) =>
    expect(isArrivalsChannel(name)).toBe(false)
  )
})

describe('ArrivalCard', () => {
  it('waves at the newcomer in one click, then says it was done', async () => {
    const user = userEvent.setup()
    const onWave = vi.fn()
    const view = render(
      <ArrivalCard
        name="Miguel Victoria"
        userId="@miguel:example.org"
        waved={false}
        onWave={onWave}
      />
    )
    expect(screen.getByRole('article', { name: /Miguel Victoria/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Saluer Miguel Victoria' }))
    expect(onWave).toHaveBeenCalledTimes(1)
    view.rerender(
      <ArrivalCard name="Miguel Victoria" userId="@miguel:example.org" waved onWave={onWave} />
    )
    const waved = screen.getByRole('button', { name: 'Vous avez salué Miguel Victoria' })
    expect(waved).toHaveAttribute('aria-pressed', 'true')
    expect(waved).toBeDisabled()
  })

  it('cannot wave where reactions are not allowed', () => {
    render(
      <ArrivalCard name="Ana" userId="@ana:example.org" waved={false} disabled onWave={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Saluer Ana' })).toBeDisabled()
  })

  it('persists waved state from store reactions and tolerates non-finite timestamps', () => {
    const inserts = arrivalInserts(
      [
        { eventId: '$join1', userId: '@miguel:example.org', ts: Number.NaN, waved: true },
      ],
      () => 'Miguel Victoria',
      true,
      vi.fn(async () => undefined)
    )
    render(<>{inserts[0]!.node}</>)
    const waved = screen.getByRole('button', { name: 'Vous avez salué Miguel Victoria' })
    expect(waved).toHaveAttribute('aria-pressed', 'true')
    expect(waved).toBeDisabled()
  })
})

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RoomRow } from './RoomRow'
import type { RoomOccupant, RoomRowProps } from './RoomRow'

const PEOPLE: RoomOccupant[] = [
  { id: '@paul', name: 'Paul Ferrand' },
  { id: '@claire', name: 'Claire Dubois', sharingScreen: true },
  { id: '@malik', name: 'Malik Benali' },
  { id: '@ines', name: 'Inès Kaci' },
  { id: '@hugo', name: 'Hugo Lefèvre' },
  { id: '@nadia', name: 'Nadia Chevalier' },
  { id: '@sofia', name: 'Sofia Marchetti' },
]

const occupancy = (count: number) => (count === 0 ? 'vide' : `${count} personnes`)

function setup(props: Partial<RoomRowProps> = {}) {
  const onClick = vi.fn()
  render(
    <ul>
      <RoomRow
        name="Point quotidien"
        joinLabel="Rejoindre Point quotidien"
        occupancyLabel={occupancy}
        occupantsLabel="Dans Point quotidien"
        sharingLabel="partage son écran"
        overflowLabel={(hidden) => `Afficher ${hidden} autres personnes`}
        onClick={onClick}
        {...props}
      />
    </ul>
  )
  return { onClick }
}

const join = (name: string | RegExp) => screen.getByRole('button', { name })

describe('RoomRow', () => {
  it('is a button named by the caller and its occupancy, which joins on click, Enter and Space', async () => {
    const user = userEvent.setup()
    const { onClick } = setup()
    const button = join('Rejoindre Point quotidien, vide')
    expect(button).toHaveAttribute('type', 'button')
    await user.click(button)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('draws only the speaker and name for an empty room, preserving its accessible occupancy', () => {
    setup()
    const button = join('Rejoindre Point quotidien, vide')
    expect(button.querySelector('[data-glyph="speaker"]')).not.toBeNull()
    expect(within(button).getByText('Point quotidien')).toBeInTheDocument()
    expect(button.querySelector('[data-occupancy]')).toBeNull()
  })

  it('draws and reads the whole count, folded occupants included', () => {
    setup({ occupants: PEOPLE })
    const button = join('Rejoindre Point quotidien, 7 personnes')
    expect(button.querySelector('[data-occupancy]')).toHaveTextContent('7 personnes')
  })

  it('lists its occupants in a named list, each a 20 px avatar and a name', () => {
    setup({ occupants: PEOPLE.slice(0, 3) })
    const list = screen.getByRole('list', { name: 'Dans Point quotidien' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Paul Ferrand')
    const avatar = items[0]?.querySelector('[aria-hidden="true"].rounded-full')
    expect(avatar).toHaveClass('h-5', 'w-5')
  })

  it('says, on a second line with a screen glyph, who shares a screen', () => {
    setup({ occupants: PEOPLE.slice(0, 3) })
    const items = within(screen.getByRole('list', { name: 'Dans Point quotidien' })).getAllByRole(
      'listitem'
    )
    const sharing = items[1]?.querySelector('[data-sharing]')
    expect(sharing).toHaveTextContent('partage son écran')
    expect(sharing?.querySelector('[data-glyph="screen"]')).not.toBeNull()
    // A line of its own under the name, not inline beside it.
    expect(sharing?.parentElement).toHaveClass('flex-col')
    expect(within(sharing?.parentElement as HTMLElement).getByText('Claire Dubois')).toBeVisible()
    expect(items[0]?.querySelector('[data-sharing]')).toBeNull()
  })

  it('folds past the default five behind a +N button that reveals them in place', async () => {
    const user = userEvent.setup()
    setup({ occupants: PEOPLE })
    const list = screen.getByRole('list', { name: 'Dans Point quotidien' })
    expect(within(list).getByText('Nadia Chevalier')).not.toBeVisible()
    const more = within(list).getByRole('button', { name: 'Afficher 2 autres personnes' })
    expect(more).toHaveTextContent('+2')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const controlled = (more.getAttribute('aria-controls') ?? '').split(' ')
    expect(controlled).toHaveLength(2)
    await user.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(within(list).getByText('Nadia Chevalier')).toBeVisible()
    expect(within(list).getByText('Sofia Marchetti')).toBeVisible()
    for (const id of controlled) expect(document.getElementById(id)).not.toHaveAttribute('hidden')
    await user.keyboard('{Enter}')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(within(list).getByText('Sofia Marchetti')).not.toBeVisible()
  })

  it('takes a caller-set maximum', () => {
    setup({ occupants: PEOPLE.slice(0, 4), maxOccupants: 2 })
    const list = screen.getByRole('list', { name: 'Dans Point quotidien' })
    expect(within(list).getByRole('button', { name: 'Afficher 2 autres personnes' })).toBeVisible()
    expect(within(list).getByText('Malik Benali')).not.toBeVisible()
  })

  it('draws no list for an empty room', () => {
    setup()
    expect(screen.queryByRole('list', { name: 'Dans Point quotidien' })).toBeNull()
  })

  it('keeps an occupied room the viewer is not in on the idle tone', () => {
    setup({ occupants: PEOPLE.slice(0, 3) })
    const button = join('Rejoindre Point quotidien, 3 personnes')
    expect(button).toHaveClass(
      'text-c-ink-3',
      'font-regular',
      'hover:bg-c-muted',
      'hover:text-c-ink'
    )
    expect(button.querySelector('[data-speaker]')).toHaveClass('text-c-ink-4')
    expect(button.closest('li')).not.toHaveClass('bg-c-surface')
  })

  it('takes the live look, and says so in words, only when connected', () => {
    setup({ occupants: PEOPLE.slice(0, 2), connected: 'Connecté' })
    const button = join('Rejoindre Point quotidien, 2 personnes, Connecté')
    expect(within(button).getByText('Connecté')).toBeVisible()
    expect(button).toHaveClass('text-c-ink', 'font-semibold')
    expect(button.querySelector('[data-speaker]')).toHaveClass('text-c-ok')
    expect(button.closest('li')).toHaveClass(
      'bg-c-surface',
      'ring-1',
      'ring-inset',
      'ring-c-border-soft'
    )
  })

  it('treats an empty connected label as not connected, in the look and the name', () => {
    setup({ occupants: PEOPLE.slice(0, 2), connected: '' })
    const button = join('Rejoindre Point quotidien, 2 personnes')
    expect(button).toHaveClass('text-c-ink-3')
    expect(button.closest('li')).not.toHaveClass('bg-c-surface')
  })

  it('says listen-only with a word and a struck microphone', () => {
    setup({ listenOnly: 'écoute seule' })
    const button = join('Rejoindre Point quotidien, vide, écoute seule')
    const mark = button.querySelector('[data-listen-only]')
    expect(mark).toHaveTextContent('écoute seule')
    expect(mark?.querySelector('[data-glyph="mic-off"]')).not.toBeNull()
  })

  it('is disabled with the reason in words when the viewer cannot join', async () => {
    const user = userEvent.setup()
    const { onClick } = setup({ unavailable: 'réservé à la direction' })
    const button = join('Rejoindre Point quotidien, vide, réservé à la direction')
    expect(button).toBeDisabled()
    expect(button.querySelector('[data-unavailable]')).toHaveTextContent('réservé à la direction')
    expect(button.querySelector('[data-unavailable] [data-glyph="lock"]')).not.toBeNull()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('rings the face of whoever the caller says is speaking, and no other, never in words', () => {
    setup({
      occupants: [{ ...PEOPLE[0]!, speaking: true }, PEOPLE[1]!, PEOPLE[2]!],
      connected: 'Connecté',
    })
    const faces = within(screen.getByRole('list', { name: 'Dans Point quotidien' }))
      .getAllByRole('listitem')
      .map((item) => item.firstElementChild!)
    expect(faces[0]).toHaveAttribute('data-speaking', '')
    expect(faces[1]).not.toHaveAttribute('data-speaking')
    for (const face of faces)
      expect(face).toHaveClass('data-[speaking]:ring-2', 'data-[speaking]:ring-c-ok')
    // A ring, not a word: the list reads as it did.
    expect(document.body).not.toHaveTextContent(/parle/)
  })

  it('keeps exact visible occupant names selectable when presence is enabled', () => {
    setup({
      occupants: [{ id: 'alice', name: 'Alice', onlineLabel: 'en ligne' }],
      connected: 'Connecté',
    })
    const list = screen.getByRole('list', { name: 'Dans Point quotidien' })
    expect(within(list).getByText('Alice', { exact: true }).textContent).toBe('Alice')
    expect(list).toHaveTextContent('Alice, en ligne')
    expect(list.querySelector('[data-online]')).toHaveClass('ring-c-surface')
  })

  it('keeps a photographed speaking participant ring and ref on the image', () => {
    const ref = { current: null as HTMLElement | null }
    setup({
      occupants: [
        { id: 'alice', name: 'Alice', src: '/alice.png', speaking: true, speakingRef: ref },
      ],
    })
    const image = screen.getByAltText('Alice')
    expect(ref.current).toBe(image)
    expect(image).toHaveAttribute('data-speaking', '')
    expect(image).toHaveClass('data-[speaking]:ring-2', 'data-[speaking]:ring-c-ok')
  })

  it("hands the viewer's own face to the caller, to ring it without a render", () => {
    const ref = { current: null as HTMLElement | null }
    setup({ occupants: [PEOPLE[0]!, { ...PEOPLE[3]!, speakingRef: ref }], connected: 'Connecté' })
    expect(ref.current).toHaveAttribute('aria-label', 'Inès Kaci')
    expect(ref.current).not.toHaveAttribute('data-speaking')
  })

  it('is 32 px, 44 px under narrow, with a visible focus ring, the +N button too', () => {
    setup({ occupants: PEOPLE })
    for (const button of screen.getAllByRole('button'))
      expect(button).toHaveClass('narrow:min-h-[44px]', 'focus-visible:ring')
    expect(join(/^Rejoindre/)).toHaveClass('min-h-8')
  })
})

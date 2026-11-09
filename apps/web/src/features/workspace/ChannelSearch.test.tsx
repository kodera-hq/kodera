// « Rechercher » and its dialog (docs/specs/11-workspace.md §4.1): the shortcut, the filter, the
// keyboard path to a channel, and where focus goes once it closes.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { Dialog } from '../../ui/Dialog/Dialog'
import { ChannelSearch, matchingEntries } from './ChannelSearch'
import type { ChannelSearchEntry } from './ChannelSearch'

const ENTRIES: ChannelSearchEntry[] = [
  { id: 'c-1', label: 'bienvenue', kind: 'text', category: 'Général' },
  { id: 'c-2', label: 'général', kind: 'text', category: 'Général' },
  { id: 'c-3', label: 'Point quotidien', kind: 'audio', category: 'Équipe' },
]

function Screen({
  shortcut = true,
  onChoose,
  answer = 'heading',
}: {
  shortcut?: boolean
  onChoose?: (entry: ChannelSearchEntry) => void
  answer?: 'heading' | 'none' | 'disabled'
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const join = useRef<HTMLButtonElement>(null)
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        bienvenue
      </h1>
      <textarea aria-label="Message" />
      <button ref={join} type="button" disabled>
        Rejoindre
      </button>
      <ChannelSearch
        entries={ENTRIES}
        shortcut={shortcut}
        onChoose={(entry) => {
          onChoose?.(entry)
          if (answer === 'disabled') return join.current
          return answer === 'heading' ? heading.current : null
        }}
      />
    </>
  )
}

const field = () => screen.getByRole('combobox', { name: 'Nom du salon' })
const options = () => screen.getAllByRole('option').map((option) => option.textContent)

describe('matchingEntries', () => {
  it('ignores case and accents, and lists everything for an empty query', () => {
    expect(matchingEntries(ENTRIES, 'GENERAL').map((entry) => entry.id)).toEqual(['c-2'])
    expect(matchingEntries(ENTRIES, '  ').map((entry) => entry.id)).toEqual(['c-1', 'c-2', 'c-3'])
    expect(matchingEntries(ENTRIES, 'quoti').map((entry) => entry.id)).toEqual(['c-3'])
  })
})

describe('ChannelSearch', () => {
  it('opens on Ctrl K with the field focused, and every channel listed', async () => {
    const user = userEvent.setup()
    render(<Screen />)

    await user.keyboard('{Meta>}k{/Meta}')
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.keyboard('{Control>}k{/Control}')
    expect(screen.getByRole('dialog', { name: 'Aller à un salon' })).toBeInTheDocument()
    expect(field()).toHaveFocus()
    expect(options()).toEqual([
      '#bienvenueGénéral',
      '#généralGénéral',
      'Point quotidienSalon audio',
    ])
  })

  it('takes ⌘ K on a Mac, leaves Ctrl K to the text field there, and says so', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    })
    try {
      const user = userEvent.setup()
      render(<Screen />)
      expect(screen.getByRole('button', { name: 'Rechercher' })).toHaveAttribute(
        'aria-keyshortcuts',
        'Meta+K'
      )
      expect(screen.getByText('⌘ K')).toHaveAttribute('aria-hidden', 'true')

      await user.keyboard('{Control>}k{/Control}')
      expect(screen.queryByRole('dialog')).toBeNull()
      await user.keyboard('{Meta>}k{/Meta}')
      expect(screen.getByRole('dialog', { name: 'Aller à un salon' })).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('answers nothing while another dialog is open: the page behind it is aria-hidden', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Screen />
        <Dialog defaultOpen title="Votre session a expiré" closeLabel="Fermer">
          <p>Reconnectez-vous.</p>
        </Dialog>
      </>
    )
    expect(screen.getByRole('dialog', { name: 'Votre session a expiré' })).toBeInTheDocument()

    await user.keyboard('{Control>}k{/Control}')
    expect(screen.queryByRole('dialog', { name: 'Aller à un salon', hidden: true })).toBeNull()
  })

  it('answers nothing while the page is withdrawn behind the session-expiry screen', async () => {
    const user = userEvent.setup()
    render(
      <div hidden aria-hidden="true">
        <Screen />
      </div>
    )

    await user.keyboard('{Control>}k{/Control}')
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
    expect(screen.queryByText('bienvenue', { selector: 'span' })).toBeNull()
  })

  it('does not listen for the shortcut when another search on the screen does', async () => {
    const user = userEvent.setup()
    render(<Screen shortcut={false} />)

    await user.keyboard('{Control>}k{/Control}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rechercher' })).not.toHaveAttribute(
      'aria-keyshortcuts'
    )
  })

  it('names its shortcut on the button, without reading the key cap aloud', () => {
    render(<Screen />)
    const button = screen.getByRole('button', { name: 'Rechercher' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    expect(screen.getByText('Ctrl K')).toHaveAttribute('aria-hidden', 'true')
  })

  it('filters as the person types, then opens the highlighted channel with Enter', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<Screen onChoose={onChoose} />)

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    // The status region is there, empty, before any words come, so a screen reader hears them.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    await user.type(field(), 'e')
    expect(options()).toEqual([
      '#bienvenueGénéral',
      '#généralGénéral',
      'Point quotidienSalon audio',
    ])
    expect(field()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]?.id)

    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    expect(field()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]?.id)
    await user.keyboard('{Enter}')

    expect(onChoose).toHaveBeenCalledWith(ENTRIES[1])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('heading', { name: 'bienvenue' })).toHaveFocus()
  })

  it('wraps the highlight from the first entry to the last', async () => {
    const user = userEvent.setup()
    render(<Screen />)

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.keyboard('{ArrowUp}')
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
  })

  it('opens a channel from a press on it', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<Screen onChoose={onChoose} />)

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.click(screen.getByRole('option', { name: /Point quotidien/ }))

    expect(onChoose).toHaveBeenCalledWith(ENTRIES[2])
  })

  it('says when no channel matches, and Enter then does nothing', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<Screen onChoose={onChoose} />)

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.type(field(), 'zzz')
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent('Aucun salon ne porte ce nom.')
    expect(field()).not.toHaveAttribute('aria-activedescendant')

    await user.keyboard('{Enter}')
    expect(onChoose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('returns focus to what had it when closed without a choice', async () => {
    const user = userEvent.setup()
    render(<Screen />)
    const message = screen.getByRole('textbox', { name: 'Message' })

    await user.click(message)
    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{Escape}')
    expect(message).toHaveFocus()

    const button = screen.getByRole('button', { name: 'Rechercher' })
    await user.click(button)
    await user.keyboard('{Escape}')
    expect(button).toHaveFocus()
  })

  it('keeps focus on « Rechercher » when the place the choice names cannot take it', async () => {
    const user = userEvent.setup()
    render(<Screen answer="disabled" />)

    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rechercher' })).toHaveFocus()
  })

  it('keeps the highlight on a listed entry as the list narrows, and starts it over on typing', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<Screen onChoose={onChoose} />)

    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('bien')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')

    expect(onChoose).toHaveBeenCalledWith(ENTRIES[0])
  })

  it('starts the highlight over on the first match when the query changes', async () => {
    const user = userEvent.setup()
    render(<Screen />)

    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    // « e » keeps all three listed: only the reset moves the highlight back to the first.
    await user.keyboard('e')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps the highlight on a listed entry when the channels change while it is open', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ChannelSearch entries={ENTRIES} onChoose={() => null} shortcut />)
    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{ArrowUp}')
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')

    rerender(<ChannelSearch entries={ENTRIES.slice(0, 1)} onChoose={() => null} shortcut />)
    const [only] = screen.getAllByRole('option')
    expect(only).toHaveAttribute('aria-selected', 'true')
    expect(field()).toHaveAttribute('aria-activedescendant', only?.id)
  })

  it('keeps focus on « Rechercher » when the choice names no place for it', async () => {
    const user = userEvent.setup()
    render(<Screen answer="none" />)

    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rechercher' })).toHaveFocus()
  })
})

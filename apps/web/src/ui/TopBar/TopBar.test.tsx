import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TopBar } from './TopBar'

describe('TopBar', () => {
  it('is a named header whose title is text, not a second page heading', () => {
    render(<TopBar label="En-tête de la console" title="Facturation" />)
    const header = screen.getByRole('banner', { name: 'En-tête de la console' })
    expect(within(header).getByText('Facturation')).toBeInTheDocument()
    expect(within(header).queryByRole('heading')).toBeNull()
    // Its own token, 56 px: not the rail item's width, which is 68 px since tokens v0.6.0.
    expect(header).toHaveClass('h-shell-header-height')
    expect(header).not.toHaveClass('h-shell-rail-item-width')
  })

  it('places the leading control, the subtitle and the actions', () => {
    render(
      <TopBar
        label="En-tête"
        title="# projet-atlas"
        subtitle="18 membres"
        leading={<button type="button">Masquer la navigation</button>}
        actions={<button type="button">Ouvrir un salon</button>}
      />
    )
    const header = screen.getByRole('banner', { name: 'En-tête' })
    const controls = within(header).getAllByRole('button')
    expect(controls.map((c) => c.textContent)).toEqual(['Masquer la navigation', 'Ouvrir un salon'])
    expect(within(header).getByText('18 membres')).toHaveClass('text-c-ink-3')
  })

  it('draws no empty actions area', () => {
    const { container } = render(<TopBar label="En-tête" title="Accueil" />)
    // The title block is the only direct child box; no actions area is drawn.
    expect(container.querySelectorAll('header > div')).toHaveLength(1)
  })

  it('lets a long title shrink and truncate before the actions', () => {
    render(
      <TopBar
        label="En-tête"
        title="Un titre très long"
        actions={<button type="button">Agir</button>}
      />
    )
    const title = screen.getByText('Un titre très long')
    expect(title).toHaveClass('min-w-0', 'truncate')
    expect(title).not.toHaveClass('shrink-0')
  })
})

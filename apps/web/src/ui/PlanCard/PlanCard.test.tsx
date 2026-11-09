import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PlanCard } from './PlanCard'

describe('PlanCard', () => {
  it('renders the title, features and price line', () => {
    render(
      <PlanCard
        title="Essentiel"
        priceLine={<span>29 € / mois</span>}
        features={['50 participants', 'Support par e-mail']}
        action={<button type="button">Choisir</button>}
      />
    )

    expect(screen.getByRole('heading', { level: 3, name: 'Essentiel' })).toBeInTheDocument()
    expect(screen.getByText('29 € / mois')).toBeInTheDocument()
    expect(screen.getByText('50 participants')).toBeInTheDocument()
    expect(screen.getByText('Support par e-mail')).toBeInTheDocument()
  })

  it('can label an enclosing control without adding a document heading', () => {
    render(
      <button type="button" role="radio" aria-checked="false" aria-label="Essentiel, 29 € / mois">
        <PlanCard
          title="Essentiel"
          titleAs="span"
          priceLine={<span>29 € / mois</span>}
          features={['50 participants']}
          action={<span>Choisir</span>}
        />
      </button>
    )

    expect(screen.getByRole('radio', { name: 'Essentiel, 29 € / mois' })).toBeInTheDocument()
    expect(screen.getByText('Essentiel')).toBeVisible()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('renders the select action and lets it be activated', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <PlanCard
        title="Essentiel"
        priceLine={<span>29 € / mois</span>}
        features={['50 participants']}
        action={
          <button type="button" onClick={onSelect}>
            Choisir
          </button>
        }
      />
    )

    await user.click(screen.getByRole('button', { name: 'Choisir' }))

    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('does not render a "Recommandé" pill by default', () => {
    render(
      <PlanCard
        title="Essentiel"
        priceLine={<span>29 € / mois</span>}
        features={['50 participants']}
        action={<button type="button">Choisir</button>}
      />
    )

    expect(screen.queryByText('Recommandé')).toBeNull()
  })

  it('renders the recommended pill and the 2px cobalt border when recommended', () => {
    const { container } = render(
      <PlanCard
        title="Standard"
        priceLine={<span>59 € / mois</span>}
        features={['150 participants']}
        action={<button type="button">Choisir</button>}
        recommended
        recommendedLabel="Recommandé"
      />
    )

    expect(screen.getByText('Recommandé')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('border-2', 'border-c-action')
    // Only one edge colour: beside `border-c-border` the stylesheet order decides,
    // and `border-c-border` comes later, so the recommended edge painted grey.
    expect(container.firstElementChild).not.toHaveClass('border-c-border')
  })

  it.each([
    ['chosen', false],
    ['chosen and recommended', true],
  ])('draws one accent ink edge when %s, keeping the pill', (_case, recommended) => {
    const { container } = render(
      <PlanCard
        title="Standard"
        priceLine={<span>59 € / mois</span>}
        features={['150 participants']}
        action={<button type="button">Choisir</button>}
        chosen
        {...(recommended
          ? { recommended: true as const, recommendedLabel: 'Recommandé' }
          : { recommended: false as const })}
      />
    )

    const card = container.firstElementChild
    expect(card).toHaveClass('border-2', 'border-c-accent-ink')
    expect(card).not.toHaveClass('border-c-action')
    expect(card).not.toHaveClass('border-c-border')
    expect(screen.queryByText('Recommandé') !== null).toBe(recommended)
  })

  it('shows the description after the features, with the id a radio can point at', () => {
    render(
      <PlanCard
        title="Team"
        description="Pour une équipe ou une petite organisation."
        descriptionId="plan-team-desc"
        priceLine={<span>134 €</span>}
        features={['50 Go']}
        action={<span>Choisir</span>}
      />
    )
    const description = screen.getByText('Pour une équipe ou une petite organisation.')
    expect(description).toHaveAttribute('id', 'plan-team-desc')
    const list = screen.getByRole('list')
    expect(
      list.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen.getByText('134 €').compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('draws nothing for an empty or null description', () => {
    const { container, rerender } = render(
      <PlanCard
        title="Team"
        description=""
        priceLine={<span>134 €</span>}
        features={['50 Go']}
        action={<span>Choisir</span>}
      />
    )
    expect(container.querySelector('p')).toBeNull()
    rerender(
      <PlanCard
        title="Team"
        description={null}
        priceLine={<span>134 €</span>}
        features={['50 Go']}
        action={<span>Choisir</span>}
      />
    )
    expect(container.querySelector('p')).toBeNull()
  })

  it('shows the description, and no paragraph when there is none', () => {
    const { rerender, container } = render(
      <PlanCard
        title="Business"
        description="Pour une organisation de 80 à 165 personnes."
        priceLine={<span>314 €</span>}
        features={['100 Go de stockage']}
        action={<span>Choisir</span>}
      />
    )
    expect(screen.getByText('Pour une organisation de 80 à 165 personnes.')).toHaveClass(
      'text-c-ink-3'
    )
    rerender(
      <PlanCard
        title="Business"
        priceLine={<span>314 €</span>}
        features={['100 Go']}
        action={<span>Choisir</span>}
      />
    )
    expect(container.querySelector('p')).toBeNull()
  })

  it('marks each feature with a decorative check, and stretches to the row with the action at the foot', () => {
    const { container } = render(
      <PlanCard
        title="Team"
        priceLine={<span>134 €</span>}
        features={['50 Go', 'Assistance par e-mail']}
        action={<span>Choisir</span>}
      />
    )
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
    }
    expect(container.firstElementChild).toHaveClass('h-full')
    // The body is the flex column the action's `mt-auto` pushes against.
    const body = screen.getByText('Choisir').parentElement?.parentElement
    expect(body).toHaveClass('flex', 'flex-col', 'h-full')
    expect(screen.getByText('Choisir').parentElement).toHaveClass('mt-auto')
    expect(screen.getByRole('list')).toHaveClass('border-t')
  })

  it('adds a decorative check mark to the foot of the chosen plan, besides its edge, and keeps none beside the title', () => {
    const { container, rerender } = render(
      <PlanCard
        title="Business Plus"
        titleAs="span"
        priceLine={<span>711 €</span>}
        features={['250 Go']}
        action={<span>Choisir</span>}
        chosen
      />
    )
    const mark = container.querySelector('[data-chosen-mark]')
    expect(mark).not.toBeNull()
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark?.querySelector('svg')).not.toBeNull()
    // In the foot, beside the action: room kept beside the title made a long
    // name wrap on one card and not its neighbours, and broke price alignment.
    expect(mark?.parentElement).toBe(screen.getByText('Choisir').parentElement)
    expect(mark?.parentElement).toHaveClass('mt-auto')
    expect(screen.getByText('Business Plus').parentElement?.className ?? '').not.toMatch(/\bpr-/)
    rerender(
      <PlanCard
        title="Business Plus"
        titleAs="span"
        priceLine={<span>711 €</span>}
        features={['250 Go']}
        action={<span>Choisir</span>}
      />
    )
    expect(container.querySelector('[data-chosen-mark]')).toBeNull()
    expect(screen.getByText('Business Plus').parentElement?.className ?? '').not.toMatch(/\bpr-/)
  })
})

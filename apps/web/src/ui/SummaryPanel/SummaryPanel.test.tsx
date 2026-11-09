import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SummaryPanel } from './SummaryPanel'

describe('SummaryPanel', () => {
  it('renders the title and every row', () => {
    render(
      <SummaryPanel
        title="Résumé de la commande"
        rows={[
          { label: 'Formule Standard', value: '59 €' },
          { label: 'Participants supplémentaires', value: '20 €' },
        ]}
        total={{ label: 'Total', value: '79 €' }}
      />
    )

    expect(screen.getByRole('heading', { name: 'Résumé de la commande' })).toBeInTheDocument()
    expect(screen.getByText('Formule Standard')).toBeInTheDocument()
    expect(screen.getByText('59 €')).toBeInTheDocument()
    expect(screen.getByText('Participants supplémentaires')).toBeInTheDocument()
    expect(screen.getByText('20 €')).toBeInTheDocument()
  })

  it('renders the total row', () => {
    render(
      <SummaryPanel
        title="Résumé de la commande"
        rows={[{ label: 'Formule Standard', value: '59 €' }]}
        total={{ label: 'Total', value: '59 €' }}
      />
    )

    expect(screen.getByText('Total')).toBeInTheDocument()
    // The total appears twice in the DOM this fixture builds — the row's own
    // "59 €" and the total's — `getAllByText` is right here on purpose.
    expect(screen.getAllByText('59 €')).toHaveLength(2)
  })

  it('renders the optional note only when given', () => {
    const { rerender } = render(
      <SummaryPanel
        title="Résumé"
        rows={[{ label: 'Formule Standard', value: '59 €' }]}
        total={{ label: 'Total', value: '59 €' }}
      />
    )
    expect(screen.queryByText(/remboursable/)).toBeNull()

    rerender(
      <SummaryPanel
        title="Résumé"
        rows={[{ label: 'Formule Standard', value: '59 €' }]}
        total={{ label: 'Total', value: '59 €' }}
        note="Premier mois remboursable sous 14 jours."
      />
    )
    expect(screen.getByText('Premier mois remboursable sous 14 jours.')).toBeInTheDocument()
  })
})

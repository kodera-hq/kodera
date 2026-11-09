import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProgressList } from './ProgressList'
import type { ProgressListStep } from './ProgressList'

const statusLabels = {
  pending: 'En attente',
  running: 'En cours',
  done: 'Terminé',
  failed: 'Échoué',
  skipped: 'Ignoré',
}

describe('ProgressList', () => {
  it('renders every step label', () => {
    const steps: ProgressListStep[] = [
      { id: 'order', label: 'Commande enregistrée', status: 'done' },
      { id: 'server', label: 'Serveur réservé', status: 'running' },
      { id: 'apps', label: 'Installation des applications', status: 'pending' },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByText('Commande enregistrée')).toBeInTheDocument()
    expect(screen.getByText('Serveur réservé')).toBeInTheDocument()
    expect(screen.getByText('Installation des applications')).toBeInTheDocument()
  })

  it('marks only the running step with aria-current="step"', () => {
    const steps: ProgressListStep[] = [
      { id: 'a', label: 'A', status: 'done' },
      { id: 'b', label: 'B', status: 'running' },
      { id: 'c', label: 'C', status: 'pending' },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByText('B').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('A').closest('li')).not.toHaveAttribute('aria-current')
    expect(screen.getByText('C').closest('li')).not.toHaveAttribute('aria-current')
  })

  it('shows the running caption', () => {
    const steps: ProgressListStep[] = [
      {
        id: 'a',
        label: 'Installation des applications',
        status: 'running',
        caption: 'en cours · sous 10 minutes',
      },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByText('en cours · sous 10 minutes')).toBeInTheDocument()
  })

  it('shows the failed step message as an alert', () => {
    const steps: ProgressListStep[] = [
      {
        id: 'a',
        label: 'Vérification du domaine',
        status: 'failed',
        message: "L'enregistrement TXT est introuvable.",
      },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByRole('alert')).toHaveTextContent("L'enregistrement TXT est introuvable.")
  })

  it('renders the status word as visible text beside the step, not only in the accessible name', () => {
    const steps: ProgressListStep[] = [{ id: 'a', label: 'Sauvegardes', status: 'skipped' }]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    const word = screen.getByText('Ignoré')
    expect(word).toBeInTheDocument()
    expect(word).not.toHaveClass('sr-only')
  })

  it('renders every status word visibly, one per state, not colour alone', () => {
    const steps: ProgressListStep[] = [
      { id: 'a', label: 'Commande enregistrée', status: 'done' },
      { id: 'b', label: 'Installation des applications', status: 'running' },
      { id: 'c', label: 'Adresses et certificats', status: 'pending' },
      { id: 'd', label: 'Vérification du domaine', status: 'failed', message: 'x' },
      { id: 'e', label: 'Domaine personnalisé', status: 'skipped' },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    for (const word of ['Terminé', 'En cours', 'En attente', 'Échoué', 'Ignoré']) {
      const element = screen.getByText(word)
      expect(element).toBeInTheDocument()
      expect(element).not.toHaveClass('sr-only')
    }
  })

  it('renders timestamps when given, and omits them cleanly when a step has none', () => {
    const steps: ProgressListStep[] = [
      { id: 'a', label: 'Premier rappel envoyé', status: 'done', timestamp: '7 avril' },
      { id: 'b', label: 'Second rappel', status: 'pending' },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByText('7 avril')).toBeInTheDocument()
    expect(screen.getByText('Second rappel').closest('li')).not.toHaveTextContent(/avril/)
  })

  it('renders cleanly when no step carries a timestamp at all', () => {
    const steps: ProgressListStep[] = [
      { id: 'a', label: 'Commande enregistrée', status: 'done' },
      { id: 'b', label: 'Serveur réservé', status: 'pending' },
    ]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByText('Commande enregistrée')).toBeInTheDocument()
    expect(screen.getByText('Serveur réservé')).toBeInTheDocument()
  })

  it('renders as an ordered list', () => {
    const steps: ProgressListStep[] = [{ id: 'a', label: 'Commande enregistrée', status: 'done' }]
    render(<ProgressList steps={steps} statusLabels={statusLabels} />)

    expect(screen.getByRole('list').tagName).toBe('OL')
  })
})

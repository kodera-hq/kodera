import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Wizard } from './Wizard'
import type { WizardStep } from './Wizard'

const steps: WizardStep[] = [
  { id: 'plan', label: 'Formule', content: <p>Choisissez votre formule.</p> },
  { id: 'contacts', label: 'Contacts', content: <p>Vos coordonnées.</p> },
  { id: 'agreements', label: 'Documents', content: <p>Acceptez les documents.</p> },
]

describe('Wizard', () => {
  it('renders only the active step panel', () => {
    render(
      <Wizard
        steps={steps}
        step="contacts"
        stepperLabel="Étapes de la commande"
        announcement="Étape 2 sur 3 : Contacts"
      />
    )

    expect(screen.getByText('Vos coordonnées.')).toBeInTheDocument()
    expect(screen.queryByText('Choisissez votre formule.')).toBeNull()
    expect(screen.queryByText('Acceptez les documents.')).toBeNull()
  })

  it('marks the active step current and earlier steps done in the header stepper', () => {
    render(
      <Wizard
        steps={steps}
        step="contacts"
        stepperLabel="Étapes de la commande"
        announcement="Étape 2 sur 3 : Contacts"
      />
    )

    expect(screen.getByText('Contacts').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('Formule').closest('li')).not.toHaveAttribute('aria-current')
  })

  it('announces the step in a polite live region', () => {
    render(
      <Wizard
        steps={steps}
        step="plan"
        stepperLabel="Étapes de la commande"
        announcement="Étape 1 sur 3 : Formule"
      />
    )

    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveTextContent('Étape 1 sur 3 : Formule')
  })

  it('updates the announcement when the controlling screen changes the step prop', () => {
    const { rerender } = render(
      <Wizard
        steps={steps}
        step="plan"
        stepperLabel="Étapes de la commande"
        announcement="Étape 1 sur 3 : Formule"
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Étape 1 sur 3 : Formule')

    rerender(
      <Wizard
        steps={steps}
        step="contacts"
        stepperLabel="Étapes de la commande"
        announcement="Étape 2 sur 3 : Contacts"
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Étape 2 sur 3 : Contacts')
    expect(screen.getByText('Vos coordonnées.')).toBeInTheDocument()
  })

  it('renders the back and next slots and keeps them reachable and activatable by keyboard', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    const onNext = vi.fn()
    render(
      <Wizard
        steps={steps}
        step="contacts"
        stepperLabel="Étapes de la commande"
        announcement="Étape 2 sur 3 : Contacts"
        back={
          <button type="button" onClick={onBack}>
            Précédent
          </button>
        }
        next={
          <button type="button" onClick={onNext}>
            Continuer
          </button>
        }
      />
    )

    await user.tab()
    expect(screen.getByRole('button', { name: 'Précédent' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onBack).toHaveBeenCalledOnce()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Continuer' })).toHaveFocus()
    await user.keyboard(' ')
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('omits the first step from having a back slot when the caller does not pass one', () => {
    render(
      <Wizard
        steps={steps}
        step="plan"
        stepperLabel="Étapes de la commande"
        announcement="Étape 1 sur 3 : Formule"
        next={<button type="button">Continuer</button>}
      />
    )

    expect(screen.queryByRole('button', { name: 'Précédent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continuer' })).toBeInTheDocument()
  })
})

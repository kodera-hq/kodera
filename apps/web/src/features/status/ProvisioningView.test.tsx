import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ProvisioningView } from './ProvisioningView'
import type { ProvisioningStepInput } from './provisioning-steps'

const STEPS: ProvisioningStepInput[] = [
  { customer_label_key: 'order', status: 'succeeded' },
  { customer_label_key: 'server', status: 'succeeded' },
  { customer_label_key: 'apps', status: 'running' },
  { customer_label_key: 'addresses', status: 'pending' },
  { customer_label_key: 'accounts', status: 'pending' },
  { customer_label_key: 'backups', status: 'pending' },
]

describe('ProvisioningView', () => {
  it('renders the promise and every one of the six customer-facing steps', () => {
    render(<ProvisioningView steps={STEPS} support={null} />)

    expect(
      screen.getByRole('heading', { name: "Votre espace est en cours d'installation" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Prêt sous un jour ouvré. Nous vous écrivons dès que c’est fait.'.replace('’', "'")
      )
    ).toBeInTheDocument()

    for (const label of [
      'Commande enregistrée',
      'Serveur réservé à Paris',
      'Installation des applications',
      'Adresses et certificats',
      'Comptes et connexion',
      'Sauvegardes et surveillance',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('renders a skeleton, not the timeline, before the first fetch resolves', () => {
    render(<ProvisioningView steps={undefined} support={null} />)
    expect(screen.getByRole('status', { name: 'Chargement' })).toBeInTheDocument()
    expect(screen.queryByText('Commande enregistrée')).not.toBeInTheDocument()
  })

  it('fills in a step the job has not reported yet as pending, never as done', () => {
    render(
      <ProvisioningView
        steps={[{ customer_label_key: 'order', status: 'succeeded' }]}
        support={null}
      />
    )
    expect(screen.getByText('Serveur réservé à Paris').closest('li')).toHaveTextContent('À venir')
  })

  it('renders the caller-supplied support action, and no "Pendant ce temps" block', () => {
    render(<ProvisioningView steps={STEPS} support={<a href="/x">Nous écrire</a>} />)
    expect(screen.getByRole('link', { name: 'Nous écrire' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pendant ce temps' })).toBeNull()
  })

  it('offers a retry when the last refresh failed, keeping the last known progress', () => {
    const onRetry = vi.fn()
    render(<ProvisioningView steps={STEPS} refreshFailed onRetry={onRetry} support={null} />)

    expect(screen.getByText('Commande enregistrée')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Réessayer' }).click()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('shows a failed step marked with its own message, while earlier steps stay done', () => {
    render(
      <ProvisioningView
        steps={[
          { customer_label_key: 'order', status: 'succeeded' },
          { customer_label_key: 'server', status: 'failed' },
        ]}
        support={null}
      />
    )
    expect(screen.getByText('Commande enregistrée').closest('li')).toHaveTextContent('Terminé')
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Une étape de l'installation n'a pas abouti"
    )
  })
})

it('renders caller-supplied preparation alongside persistent support', () => {
  render(
    <ProvisioningView
      steps={STEPS}
      preparation={<a href="/other/people/import?from=status">Prepare people</a>}
      support={<a href="/other/help">Support</a>}
    />
  )
  expect(screen.getByRole('link', { name: 'Prepare people' })).toHaveAttribute(
    'href',
    '/other/people/import?from=status'
  )
  expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/other/help')
})

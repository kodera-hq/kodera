import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ProvisioningOverview } from './ProvisioningOverview'
import type { ProvisioningStep } from './steps'

function step(overrides: Partial<ProvisioningStep>): ProvisioningStep {
  return {
    key: 'preflight',
    customer_label_key: 'accounts',
    title: 'Preflight',
    status: 'pending',
    ...overrides,
  }
}

describe('ProvisioningOverview', () => {
  it('shows six customer-readable steps and never an internal step name', () => {
    render(
      <ProvisioningOverview
        steps={[
          step({ key: 'project', customer_label_key: 'order', status: 'succeeded' }),
          step({ key: 'network', customer_label_key: 'server', status: 'succeeded' }),
          step({ key: 'deploy', customer_label_key: 'apps', status: 'running' }),
        ]}
        late={false}
        onSupport={vi.fn()}
      />
    )

    expect(screen.getByText('Commande enregistrée')).toBeInTheDocument()
    expect(screen.getByText('Serveur réservé à Paris')).toBeInTheDocument()
    expect(screen.getByText('Installation des applications')).toBeInTheDocument()
    expect(screen.getByText('Adresses et certificats')).toBeInTheDocument()
    expect(screen.getByText('Comptes et connexion')).toBeInTheDocument()
    expect(screen.getByText('Sauvegardes et surveillance')).toBeInTheDocument()

    for (const internalName of ['project', 'network', 'deploy', 'preflight']) {
      expect(screen.queryByText(internalName)).not.toBeInTheDocument()
    }
  })

  it('shows the default one-business-day promise when nothing is late', () => {
    render(<ProvisioningOverview steps={[]} late={false} onSupport={vi.fn()} />)
    expect(
      screen.getByText("Prêt sous un jour ouvré. Nous vous écrivons dès que c'est fait.", {
        exact: false,
      })
    ).toBeInTheDocument()
  })

  it('switches the promise line and offers support when provisioning is late', () => {
    render(<ProvisioningOverview steps={[]} late={true} onSupport={vi.fn()} />)
    expect(screen.getByText(/prend plus de temps que prévu/)).toBeInTheDocument()
  })

  it('marks a failed step and keeps earlier steps done', async () => {
    const user = userEvent.setup()
    const onSupport = vi.fn()
    render(
      <ProvisioningOverview
        steps={[
          step({ customer_label_key: 'order', status: 'succeeded' }),
          step({ customer_label_key: 'server', status: 'succeeded' }),
          step({ customer_label_key: 'apps', status: 'failed', job_id: 'job-42' }),
        ]}
        late={false}
        onSupport={onSupport}
      />
    )

    expect(screen.getAllByText('Terminé')).toHaveLength(2)
    expect(screen.getByText('Échec')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Nous écrire' }))
    expect(onSupport).toHaveBeenCalledWith({ reason: 'step-failed', jobId: 'job-42' })
  })

  it('offers support for a late provisioning with no failed step', async () => {
    const user = userEvent.setup()
    const onSupport = vi.fn()
    render(<ProvisioningOverview steps={[]} late={true} onSupport={onSupport} />)

    await user.click(screen.getByRole('button', { name: 'Nous écrire' }))
    expect(onSupport).toHaveBeenCalledWith({ reason: 'late', jobId: undefined })
  })

  it('renders the steps as an ordered list with the running step marked aria-current', () => {
    render(
      <ProvisioningOverview
        steps={[step({ customer_label_key: 'apps', status: 'running' })]}
        late={false}
        onSupport={vi.fn()}
      />
    )
    expect(screen.getByRole('list').tagName).toBe('OL')
    expect(screen.getByText('Installation des applications').closest('li')).toHaveAttribute(
      'aria-current',
      'step'
    )
  })
})

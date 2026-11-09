import { describe, expect, it } from 'vitest'
import { toProgressSteps } from './provisioning-steps'
import type { ApiProvisioningStep, ProvisioningStepLabel } from './provisioning-steps'

const stepLabels: Record<ProvisioningStepLabel, string> = {
  order: 'Commande enregistrée',
  server: 'Serveur réservé à Paris',
  apps: 'Installation des applications',
  addresses: 'Adresses et certificats',
  accounts: 'Comptes et connexion',
  backups: 'Sauvegardes et surveillance',
}

function step(overrides: Partial<ApiProvisioningStep>): ApiProvisioningStep {
  return {
    key: 'preflight',
    customer_label_key: 'order',
    title: 'Preflight',
    status: 'pending',
    ...overrides,
  }
}

describe('toProgressSteps', () => {
  it('maps every API status onto the ProgressList vocabulary', () => {
    const steps = toProgressSteps(
      [
        step({ customer_label_key: 'order', status: 'succeeded' }),
        step({ customer_label_key: 'server', status: 'running' }),
        step({ customer_label_key: 'apps', status: 'pending' }),
        step({ customer_label_key: 'addresses', status: 'failed' }),
        step({ customer_label_key: 'accounts', status: 'skipped' }),
      ],
      stepLabels,
      'Une étape a échoué'
    )

    expect(steps.map((s) => s.status)).toEqual(['done', 'running', 'pending', 'failed', 'skipped'])
  })

  it('carries the customer label as the visible text, never the staff-facing title', () => {
    const [row] = toProgressSteps([step({ customer_label_key: 'apps' })], stepLabels, 'x')
    expect(row?.label).toBe('Installation des applications')
  })

  it('attaches the fixed failure message only to a failed step', () => {
    const steps = toProgressSteps(
      [
        step({ customer_label_key: 'order', status: 'succeeded' }),
        step({ customer_label_key: 'server', status: 'failed' }),
      ],
      stepLabels,
      'Une étape a échoué'
    )

    expect(steps[0]?.message).toBeUndefined()
    expect(steps[1]?.message).toBe('Une étape a échoué')
  })

  it('never surfaces the API step detail, which is staff-facing English', () => {
    const steps = toProgressSteps(
      [step({ status: 'failed', detail: '14 checks green, tofu apply failed on resource X' })],
      stepLabels,
      'Une étape a échoué'
    )

    expect(steps[0]?.message).toBe('Une étape a échoué')
    expect(JSON.stringify(steps)).not.toContain('tofu apply')
  })

  it('renders an empty list cleanly', () => {
    expect(toProgressSteps([], stepLabels, 'x')).toEqual([])
  })
})

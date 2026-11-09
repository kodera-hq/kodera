import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SelfHostDeployerPanel } from './SelfHostDeployerPanel'
import type { SelfHostDeploymentPlan } from './types'

describe('SelfHostDeployerPanel', () => {
  it('renders the local validation disclosure, password input attributes, and provider choices', () => {
    render(<SelfHostDeployerPanel />)

    expect(
      screen.getByRole('heading', {
        name: "Assistant d'auto-hébergement 1-clic (Aperçu de validation locale)",
      })
    ).toBeInTheDocument()

    expect(
      screen.getByRole('note', {
        name: 'Divulgation de confidentialité et de non-transmission du jeton',
      })
    ).toHaveTextContent(/sans transmettre votre jeton API à kodera\.io/i)

    const tokenInput = screen.getByLabelText(/Jeton API fournisseur éphémère/i)
    expect(tokenInput).toHaveAttribute('type', 'password')
    expect(tokenInput).toHaveAttribute('autocomplete', 'off')

    for (const label of ['Scaleway', 'Hetzner', 'Hostinger', 'OVHcloud']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument()
    }
  })

  it('validates a complete specification, renders the DNS matrix and env preview, and never leaks the raw token to the DOM', async () => {
    const user = userEvent.setup()
    const onPlanValidated = vi.fn()
    const rawSecret = 'htz_live_secret_token_9876543210abcdef'

    const { container } = render(<SelfHostDeployerPanel onPlanValidated={onPlanValidated} />)

    await user.click(screen.getByRole('button', { name: /Hetzner/i }))

    const fqdnInput = screen.getByLabelText(/Domaine public \(FQDN\)/i)
    await user.clear(fqdnInput)
    await user.type(fqdnInput, 'kodera.souvrain.fr')

    const emailInput = screen.getByLabelText(/E-mail administrateur ACME/i)
    await user.clear(emailInput)
    await user.type(emailInput, 'sre@souvrain.fr')

    const tokenInput = screen.getByLabelText(/Jeton API fournisseur éphémère/i)
    await user.type(tokenInput, rawSecret)

    await user.click(screen.getByRole('button', { name: 'Valider la configuration localement' }))

    expect(onPlanValidated).toHaveBeenCalledTimes(1)
    const plan = onPlanValidated.mock.calls[0]?.[0] as SelfHostDeploymentPlan
    expect(plan.provider).toBe('hetzner')
    expect(plan.apiOrigin).toBe('https://api.hetzner.cloud')
    expect(plan.fqdn).toBe('kodera.souvrain.fr')
    expect(plan.redactedTokenPreview).toBe('[REDACTED]')
    expect(plan.composeEnvPreview.KODERA_PROVIDER_TOKEN).toBe('[REDACTED]')

    expect(screen.getByRole('region', { name: 'Plan de déploiement validé' })).toBeInTheDocument()
    expect(screen.getAllByText('matrix.kodera.souvrain.fr').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('visio.kodera.souvrain.fr').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('docs.kodera.souvrain.fr').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('auth.kodera.souvrain.fr').length).toBeGreaterThanOrEqual(2)

    expect(container.textContent).not.toContain(rawSecret)
    expect(container.innerHTML).not.toContain(rawSecret)
  })

  it('fails closed with an accessible alert when the domain or token is invalid', async () => {
    const user = userEvent.setup()
    render(<SelfHostDeployerPanel defaultFqdn="localhost" />)

    const tokenInput = screen.getByLabelText(/Jeton API fournisseur éphémère/i)
    await user.type(tokenInput, 'scw_valid_length_token_0123456789')

    await user.click(screen.getByRole('button', { name: 'Valider la configuration localement' }))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/InvalidDomain/i)
    expect(screen.queryByRole('region', { name: 'Plan de déploiement validé' })).toBeNull()
  })
})

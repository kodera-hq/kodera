import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as slugTakenHandlers } from '@/mocks/overlays/order.slug-taken'
import { ContactsStep } from './ContactsStep'
import { AuthProvider } from '../../auth/AuthProvider'
import { SessionExpiryProvider } from '../../auth/sessionExpiry'
import { authAdapter } from '../../auth/oidc'
import { emptyDraft } from './draft'
import type { ContactsStepProps } from './ContactsStep'

const BASE = 'https://core.test/api/v1'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
const owner = {
  issuer: 'https://id.example.test',
  subject: 'person',
  organisationId: 'org',
  membershipId: 'membership',
  identityId: 'identity',
  generation: 1,
}
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  const user = {
    realm: 'acme-sa',
    identity: { issuer: owner.issuer, subject: owner.subject },
  }
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user,
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

function renderContactsStep(overrides: Partial<ContactsStepProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const update = vi.fn()
  render(
    <AuthProvider>
      <SessionExpiryProvider>
        <QueryClientProvider client={client}>
          <ContactsStep
            owner={owner}
            draft={emptyDraft()}
            update={update}
            onContinue={vi.fn()}
            onBack={vi.fn()}
            {...overrides}
          />
        </QueryClientProvider>
      </SessionExpiryProvider>
    </AuthProvider>
  )
  return { update }
}

describe('ContactsStep', () => {
  it('rejects a taken identifier and offers alternatives that fill the field when chosen', async () => {
    server.use(...slugTakenHandlers)
    renderContactsStep()

    const slugField = screen.getByLabelText('Identifiant souhaité')
    await userEvent.type(slugField, 'acme')
    await userEvent.tab()

    expect(
      await screen.findByText('Ce nom est déjà pris — essayez « acme-fr ».')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'acme-fr' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'acme-group' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'acme-2027' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'acme-group' }))
    await waitFor(() => expect(slugField).toHaveValue('acme-group'))
  })

  it('does not ask whether a malformed identifier is free', async () => {
    let asked = 0
    server.use(
      http.get(`${BASE}/slug-availability`, () => {
        asked += 1
        return HttpResponse.json({ slug: 'acme', available: true, reason: null })
      })
    )
    renderContactsStep()

    const slugField = screen.getByLabelText('Identifiant souhaité')
    await userEvent.type(slugField, 'ACME')
    await userEvent.tab()

    expect(await screen.findByText(/de 3 à 32 caractères/)).toBeInTheDocument()
    expect(asked).toBe(0)
  })

  // Core gives the tenant `https://{slug}.{dns name}` from its KODERA_TENANT_APP_URLS templates;
  // staging's is `https://{slug}.staging.kodera.io`. The preview must read the same address.
  it('previews the address under the configured tenant domain', async () => {
    vi.stubEnv('VITE_TENANT_DOMAIN', 'staging.kodera.io')
    renderContactsStep()

    const slugField = screen.getByLabelText(/Identifiant souhaité/)
    await userEvent.type(slugField, 'kodera-team')

    expect(
      screen.getByText(
        "Votre instance sera accessible à l'adresse kodera-team.staging.kodera.io. Vous pourrez connecter votre propre domaine ensuite, gratuitement."
      )
    ).toBeInTheDocument()
    expect(screen.getByText('.staging.kodera.io')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/samourai\.app/)
  })

  it('names no domain when none is configured, rather than a wrong one', () => {
    vi.stubEnv('VITE_TENANT_DOMAIN', '')
    renderContactsStep()

    expect(
      screen.getByText(
        "Cet identifiant formera l'adresse de votre instance. Vous pourrez connecter votre propre domaine ensuite, gratuitement."
      )
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/samourai\.app|kodera\.io/)
    // No suffix either: the field's description is the hint alone.
    expect(screen.getByLabelText('Identifiant souhaité')).toHaveAccessibleDescription(
      "Cet identifiant formera l'adresse de votre instance. Vous pourrez connecter votre propre domaine ensuite, gratuitement."
    )
  })

  it('names no domain when the configured one is malformed', () => {
    vi.stubEnv('VITE_TENANT_DOMAIN', 'https://staging.kodera.io')
    renderContactsStep()

    expect(screen.getByLabelText('Identifiant souhaité')).toHaveAccessibleDescription(
      "Cet identifiant formera l'adresse de votre instance. Vous pourrez connecter votre propre domaine ensuite, gratuitement."
    )
    expect(document.body.textContent).not.toMatch(/kodera\.io/)
  })

  it('refuses to submit an incomplete form and describes each missing field', async () => {
    renderContactsStep()
    await userEvent.click(screen.getByRole('button', { name: 'Continuer' }))
    expect(
      await screen.findByText('Indiquez la raison sociale de votre organisation.')
    ).toBeInTheDocument()
  })
})

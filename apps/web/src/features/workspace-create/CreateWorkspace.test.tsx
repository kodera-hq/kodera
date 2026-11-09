// « Créez votre espace » (docs/specs/08-home.md §4.7, acceptance W1-1…W1-10): against Core's
// contract through MSW, with the router's navigation observed.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as axe from 'axe-core'
import { http, HttpResponse, delay } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type * as RouterModule from '@tanstack/react-router'
import '@/i18n'
import { setTokenProvider } from '@/api/client'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { EXAMPLES } from '@/mocks/generated/examples'
import { problem } from '@/mocks/problem'
import { server } from '@/mocks/server'
import { CreateWorkspace } from './CreateWorkspace'
import { useFallbackTenantIdQuery, useStatusSummaryQuery } from '../home/queries'
import { forgetCreation } from './api'

const invalidateRouter = vi.fn()
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof RouterModule>()),
  useRouter: () => ({ invalidate: invalidateRouter }),
}))
vi.mock('../order/tenantAddress', () => ({ configuredTenantDomain: () => 'kodera.test' }))

const BASE = 'https://core.test/api/v1'
const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const TENANTS = `*/api/v1/organisations/${ORGANISATION_ID}/tenants`

function legalDocument(code: 'cgv' | 'dpa', version: string) {
  return {
    code,
    version,
    locale: 'fr',
    title: code === 'cgv' ? 'Conditions générales' : 'Accord de traitement des données',
    published_at: '2026-11-01T00:00:00Z',
    pack_code: 'workspace',
    html_url: `https://legal.kodera.test/${code}/${version}`,
    text_url: null,
  }
}

interface Calls {
  availability: string[]
  documents: URLSearchParams[]
  creations: { key: string | null; body: unknown }[]
}

function serve(
  calls: Calls,
  {
    availability = (slug: string) => ({ slug, available: true, reason: null, suggestions: [] }),
    versions = () => ({ cgv: '2026.11', dpa: '2026.11' }),
  }: {
    availability?: (slug: string) => object | Promise<Response>
    versions?: () => { cgv: string; dpa: string }
  } = {}
) {
  server.use(
    http.get('*/api/v1/slug-availability', async ({ request }) => {
      const slug = new URL(request.url).searchParams.get('slug') ?? ''
      calls.availability.push(slug)
      const answer = await availability(slug)
      return answer instanceof Response ? answer : HttpResponse.json(answer)
    }),
    http.get('*/api/v1/legal-documents', ({ request }) => {
      calls.documents.push(new URL(request.url).searchParams)
      const { cgv, dpa } = versions()
      return HttpResponse.json({
        data: [legalDocument('cgv', cgv), legalDocument('dpa', dpa)],
        next_cursor: null,
      })
    })
  )
}

function created() {
  return HttpResponse.json(
    {
      tenant: {
        id: '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
        organisation_id: ORGANISATION_ID,
        slug: 'acme-sa',
        name: 'Acme SA',
        status: 'ordered',
        status_changed_at: '2026-11-06T10:00:00Z',
        pack_code: 'workspace',
        capacity_tier_code: 'S',
        apps: ['visio', 'messaging'],
        region: 'fr-par',
        realm: 'acme-sa',
      },
      workspace_id: '3d0a1f8b-2c4e-4f60-9a1b-1c2d3e4f5a6b',
    },
    { status: 201, headers: { Location: '/api/v1/tenants/2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b' } }
  )
}

function recordCreation(calls: Calls, answer: () => Response | Promise<Response>) {
  server.use(
    http.post(TENANTS, async ({ request }) => {
      calls.creations.push({
        key: request.headers.get('Idempotency-Key'),
        body: await request.json(),
      })
      return answer()
    })
  )
}

function show(organisationName = 'Acme SA') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  shown.client = client
  shown.invalidate = vi.spyOn(client, 'invalidateQueries')
  return render(
    <QueryClientProvider client={client}>
      <CreateWorkspace
        organisationId={ORGANISATION_ID}
        organisationName={organisationName}
        packCode="workspace"
      />
    </QueryClientProvider>
  )
}

const shown: {
  client?: QueryClient
  invalidate?: MockInstance<QueryClient['invalidateQueries']>
} = {}
/** Whether the home's queries were read again: what shows the tenant once it exists. */
const homeReread = () =>
  shown.invalidate?.mock.calls.some(
    ([filters]) => JSON.stringify(filters) === JSON.stringify({ queryKey: ['home'] })
  ) ?? false

function newCalls(): Calls {
  return { availability: [], documents: [], creations: [] }
}

const createButton = () =>
  screen.findByRole('button', { name: 'Créer l’espace — j’accepte les CGV et le DPA' })
const nameField = () => screen.getByRole('textbox', { name: 'Nom de l’espace' })
const failed = () => screen.findByText(/L’espace n’a pas pu être créé/)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  setTokenProvider(() => undefined)
  invalidateRouter.mockReset()
  forgetCreation(ORGANISATION_ID)
})
afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

describe('the form', () => {
  it('prefills the name and derives the address behind « Modifier », final once created', async () => {
    serve(newCalls())
    show('Équipe Kodera')
    expect(screen.getByRole('textbox', { name: 'Nom de l’espace' })).toHaveValue('Équipe Kodera')
    expect(screen.getByText('equipe-kodera.kodera.test')).toBeInTheDocument()
    expect(screen.getByText('L’adresse est définitive.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Adresse/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveValue('equipe-kodera')
  })

  it('opens the address when the name gives one too short, and accepts a 150-character name', async () => {
    serve(newCalls())
    show('Ça')
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveValue('ca')
    expect(await createButton()).toBeDisabled()

    const long = `Acme ${'x'.repeat(145)}`
    const name = screen.getByRole('textbox', { name: 'Nom de l’espace' })
    await userEvent.clear(name)
    await userEvent.type(name, long)
    expect(name).toHaveValue(long)
    expect(screen.queryByText('Le nom compte 200 caractères au maximum.')).toBeNull()
  })

  it('puts the keyboard in the address field when « Modifier » is pressed', async () => {
    serve(newCalls())
    show('Acme')
    screen.getByRole('button', { name: 'Modifier' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveFocus()
  })

  it('refuses a blank name, one over 200 characters, and characters Core refuses', async () => {
    serve(newCalls())
    show('Acme')
    const name = nameField()
    await userEvent.clear(name)
    await userEvent.type(name, '   ')
    expect(screen.getByText('Donnez un nom à votre espace.')).toBeInTheDocument()

    // Characters, not UTF-16 units: 200 emoji are a valid name, 201 are not.
    await userEvent.clear(name)
    await userEvent.paste('😀'.repeat(200))
    expect(screen.queryByText('Le nom compte 200 caractères au maximum.')).toBeNull()
    await userEvent.paste('😀')
    expect(screen.getByText('Le nom compte 200 caractères au maximum.')).toBeInTheDocument()

    for (const refused of ['Acme\u200b', 'Acme\ue000', 'Acme\u2028']) {
      await userEvent.clear(name)
      await userEvent.paste(refused)
      expect(screen.getByText('Le nom contient un caractère non autorisé.')).toBeInTheDocument()
    }
    await userEvent.clear(name)
    await userEvent.paste('Acme\u00a0SA')
    expect(screen.queryByText('Le nom contient un caractère non autorisé.')).toBeNull()
  })

  it('says at once why a prefilled name cannot be used', async () => {
    serve(newCalls())
    show('x'.repeat(201))
    expect(screen.getByText('Le nom compte 200 caractères au maximum.')).toBeInTheDocument()
  })

  it('stops following the name once the address is edited', async () => {
    serve(newCalls())
    show('Acme')
    await userEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    const address = screen.getByRole('textbox', { name: /Adresse/ })
    await userEvent.clear(address)
    await userEvent.type(address, 'acme-team')
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), ' Lab')
    expect(address).toHaveValue('acme-team')
  })

  it('reads the documents for the summary’s pack, and names and links both beside the button', async () => {
    const calls = newCalls()
    serve(calls)
    show()
    await createButton()
    expect(calls.documents[0]?.get('pack_code')).toBe('workspace')
    expect(calls.documents[0]?.get('locale')).toBe('fr')
    const cgv = screen.getByRole('link', { name: 'Conditions générales, version 2026.11' })
    expect(cgv).toHaveAttribute('href', 'https://legal.kodera.test/cgv/2026.11')
    expect(cgv).toHaveAccessibleDescription('Ouvre un nouvel onglet')
    expect(
      screen.getByRole('link', { name: 'Accord de traitement des données, version 2026.11' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('has no axe violation', async () => {
    serve(newCalls())
    const { container } = show()
    await createButton()
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map((violation) => violation.id)).toEqual([])
  })
})

describe('the address check', () => {
  it('reads once, for the address shown, 300 ms after the last key', async () => {
    const calls = newCalls()
    serve(calls)
    show('Acme')
    await waitFor(() => expect(calls.availability).toEqual(['acme']))
    // A person types a key every 50 ms or so: no address in between is read.
    const user = userEvent.setup({ delay: 50 })
    await user.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), ' Lab')
    await delay(200)
    expect(calls.availability).toEqual(['acme'])
    await waitFor(() => expect(calls.availability).toContain('acme-lab'))
    await delay(400)
    expect(calls.availability).toEqual(['acme', 'acme-lab'])
    expect(await screen.findByText('Cette adresse est libre.')).toBeInTheDocument()
  })

  it('ignores a late answer for an address no longer shown', async () => {
    const calls = newCalls()
    serve(calls, {
      availability: (slug) =>
        slug === 'acme'
          ? delay(400).then(() =>
              HttpResponse.json({
                slug,
                available: false,
                reason: 'taken',
                suggestions: ['acme-2'],
              })
            )
          : { slug, available: true, reason: null, suggestions: [] },
    })
    show('Acme')
    await waitFor(() => expect(calls.availability).toEqual(['acme']))
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), ' Lab')
    expect(await screen.findByText('Cette adresse est libre.')).toBeInTheDocument()
    await delay(500)
    expect(screen.queryByText('Cette adresse est déjà prise.')).toBeNull()
    expect(await createButton()).toBeEnabled()
  })

  it('drops the last answer as soon as the address changes, before the new one is read', async () => {
    const calls = newCalls()
    serve(calls, {
      availability: (slug) =>
        slug === 'acme'
          ? { slug, available: false, reason: 'taken', suggestions: [] }
          : { slug, available: true, reason: null, suggestions: [] },
    })
    show('Acme')
    expect(await screen.findByText('Cette adresse est déjà prise.')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom de l’espace' }), ' Lab')
    expect(calls.availability).toEqual(['acme'])
    expect(screen.queryByText('Cette adresse est déjà prise.')).toBeNull()
    expect(screen.getByText('Vérification de l’adresse…')).toBeInTheDocument()
  })

  it('offers three free addresses for a taken one, and checks the one picked', async () => {
    const calls = newCalls()
    serve(calls, {
      availability: (slug) =>
        slug === 'acme'
          ? {
              slug,
              available: false,
              reason: 'taken',
              suggestions: ['acme-2', 'acme-fr', 'acme-lab', 'acme-team'],
            }
          : { slug, available: true, reason: null, suggestions: [] },
    })
    const view = show('Acme')
    expect(await screen.findByText('Cette adresse est déjà prise.')).toBeInTheDocument()
    expect(await createButton()).toBeDisabled()
    const offered = screen.getAllByRole('button', { name: /^Utiliser l’adresse/ })
    expect(offered.map((button) => button.textContent)).toEqual(['acme-2', 'acme-fr', 'acme-lab'])
    expect(screen.getByRole('status')).toHaveTextContent(
      'Cette adresse est déjà prise. Adresses libres proposées : acme-2, acme-fr, acme-lab.'
    )
    const results = await axe.run(view.container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations.map((violation) => violation.id)).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Utiliser l’adresse acme-fr' }))
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveValue('acme-fr')
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveFocus()
    await waitFor(() => expect(calls.availability).toContain('acme-fr'))
    expect(await screen.findByText('Cette adresse est libre.')).toBeInTheDocument()
    expect(await createButton()).toBeEnabled()
  })

  it('keeps the button off for a reserved address, and on when the check fails', async () => {
    const reserved = newCalls()
    serve(reserved, {
      availability: (slug) => ({ slug, available: false, reason: 'reserved', suggestions: [] }),
    })
    const view = show('Kodera')
    expect(await screen.findByText('Cette adresse est réservée.')).toBeInTheDocument()
    expect(await createButton()).toBeDisabled()
    view.unmount()

    const failing = newCalls()
    serve(failing, {
      availability: () => problem('https://kodera.io/problems/internal-error'),
    })
    show('Acme')
    await waitFor(() => expect(failing.availability).toEqual(['acme']))
    expect(await createButton()).toBeEnabled()
  })
})

describe('creating the workspace', () => {
  it('sends one request with the versions shown, and reads the home again', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, created)
    show()
    await userEvent.click(await createButton())
    await waitFor(() => expect(homeReread()).toBe(true))
    expect(calls.creations).toHaveLength(1)
    expect(calls.creations[0]?.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls.creations[0]?.body).toEqual({
      name: 'Acme SA',
      slug: 'acme-sa',
      locale: 'fr',
      legal_acceptances: [
        { code: 'cgv', version: '2026.11', locale: 'fr' },
        { code: 'dpa', version: '2026.11', locale: 'fr' },
      ],
    })
  })

  it('resends the same key and body after a server failure', async () => {
    const calls = newCalls()
    serve(calls)
    let answers = 0
    recordCreation(calls, () =>
      answers++ === 0 ? problem('https://kodera.io/problems/internal-error') : created()
    )
    show()
    await userEvent.click(await createButton())
    expect(await screen.findByText(/L’espace n’a pas pu être créé/)).toBeInTheDocument()
    await userEvent.click(await createButton())
    await waitFor(() => expect(homeReread()).toBe(true))
    expect(calls.creations).toHaveLength(2)
    expect(calls.creations[1]?.key).toBe(calls.creations[0]?.key)
    expect(calls.creations[1]?.body).toEqual(calls.creations[0]?.body)
  })

  it('shows a refused address with the free ones Core offers', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () =>
      problem('https://kodera.io/problems/slug-taken', { suggestions: ['acme-sa-2'] })
    )
    show()
    await userEvent.click(await createButton())
    expect(await screen.findByText('Cette adresse est déjà prise.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveValue('acme-sa')
    expect(screen.getByRole('button', { name: 'Utiliser l’adresse acme-sa-2' })).toBeInTheDocument()
    expect(await createButton()).toBeDisabled()
    expect(homeReread()).toBe(false)
  })

  it('reads the documents again when a version changed, and waits for a new press', async () => {
    const calls = newCalls()
    let cgv = '2026.11'
    serve(calls, { versions: () => ({ cgv, dpa: '2026.11' }) })
    recordCreation(calls, () => {
      cgv = '2026.12'
      return problem('https://kodera.io/problems/validation-error', {
        errors: [{ pointer: '/legal_acceptances', code: 'cgv_not_in_force', detail: '2026.12' }],
      })
    })
    show()
    await userEvent.click(await createButton())
    expect(await screen.findByText(/Les conditions ont été mises à jour/)).toBeInTheDocument()
    expect(
      await screen.findByRole('link', { name: 'Conditions générales, version 2026.12' })
    ).toBeInTheDocument()
    expect(calls.creations).toHaveLength(1)
    expect(homeReread()).toBe(false)

    await userEvent.click(await createButton())
    await waitFor(() => expect(calls.creations).toHaveLength(2))
    expect(calls.creations[1]?.key).not.toBe(calls.creations[0]?.key)
    expect(calls.creations[1]?.body).toMatchObject({
      legal_acceptances: [
        { code: 'cgv', version: '2026.12', locale: 'fr' },
        { code: 'dpa', version: '2026.11', locale: 'fr' },
      ],
    })
  })

  it('sends nothing while the documents are read again', async () => {
    const calls = newCalls()
    let reads = 0
    server.use(
      http.get('*/api/v1/slug-availability', ({ request }) =>
        HttpResponse.json({
          slug: new URL(request.url).searchParams.get('slug'),
          available: true,
          reason: null,
          suggestions: [],
        })
      ),
      http.get('*/api/v1/legal-documents', async () => {
        if (reads++ > 0) await delay(500)
        return HttpResponse.json({
          data: [
            legalDocument('cgv', reads > 1 ? '2026.12' : '2026.11'),
            legalDocument('dpa', '2026.11'),
          ],
          next_cursor: null,
        })
      })
    )
    recordCreation(calls, () =>
      problem('https://kodera.io/problems/validation-error', {
        errors: [{ pointer: '/legal_acceptances', code: 'cgv_not_in_force', detail: '2026.12' }],
      })
    )
    show()
    await userEvent.click(await createButton())
    expect(await screen.findByText(/Les conditions ont été mises à jour/)).toBeInTheDocument()
    // Shown busy while the documents are read again, so a press is not silently lost.
    expect(await createButton()).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(await createButton())
    expect(calls.creations).toHaveLength(1)
  })

  it('opens the home of an organisation that already has a workspace', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () => problem('https://kodera.io/problems/tenant-exists'))
    show()
    await userEvent.click(await createButton())
    await waitFor(() => expect(homeReread()).toBe(true))
  })

  it('says when no document can be accepted, and offers no button', async () => {
    server.use(
      http.get('*/api/v1/slug-availability', ({ request }) =>
        HttpResponse.json({
          slug: new URL(request.url).searchParams.get('slug'),
          available: true,
          reason: null,
          suggestions: [],
        })
      ),
      http.get('*/api/v1/legal-documents', () =>
        HttpResponse.json({ data: [legalDocument('cgv', '2026.11')], next_cursor: null })
      )
    )
    const { container } = show()
    expect(
      await within(container).findByText(/Les conditions de service ne sont pas disponibles/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Créer l’espace/ })).toBeNull()

    server.use(
      http.get('*/api/v1/legal-documents', () =>
        HttpResponse.json({
          data: [legalDocument('cgv', '2026.11'), legalDocument('dpa', '2026.11')],
          next_cursor: null,
        })
      )
    )
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await createButton()).toBeEnabled()
  })
})

describe('each answer Core can give', () => {
  async function pressTwice(calls: Calls, first: () => Response) {
    let answers = 0
    recordCreation(calls, () => (answers++ === 0 ? first() : created()))
    show()
    await userEvent.click(await createButton())
  }

  it('resends the same key after a network failure, whose outcome is unknown', async () => {
    const calls = newCalls()
    serve(calls)
    await pressTwice(calls, () => HttpResponse.error())
    expect(await failed()).toBeInTheDocument()
    await userEvent.click(await createButton())
    await waitFor(() => expect(homeReread()).toBe(true))
    expect(calls.creations[1]?.key).toBe(calls.creations[0]?.key)
  })

  it('resends the same key while Core still decides the first request', async () => {
    const calls = newCalls()
    serve(calls)
    await pressTwice(calls, () =>
      problem('https://kodera.io/problems/idempotency-key-in-flight', { retryAfterS: 1 })
    )
    expect(await failed()).toBeInTheDocument()
    await userEvent.click(await createButton())
    await waitFor(() => expect(homeReread()).toBe(true))
    expect(calls.creations[1]?.key).toBe(calls.creations[0]?.key)
  })

  it('sends a new key once the body changes after a server failure', async () => {
    const calls = newCalls()
    serve(calls)
    await pressTwice(calls, () => problem('https://kodera.io/problems/internal-error'))
    expect(await failed()).toBeInTheDocument()
    await userEvent.type(nameField(), ' Lab')
    await userEvent.click(await createButton())
    await waitFor(() => expect(calls.creations).toHaveLength(2))
    expect(calls.creations[1]?.key).not.toBe(calls.creations[0]?.key)
  })

  it('says the organisation is not ready, and sends a new key on the next press', async () => {
    const calls = newCalls()
    serve(calls)
    await pressTwice(calls, () =>
      problem('https://kodera.io/problems/invalid-state-transition', {
        allowedStates: ['ready'],
      })
    )
    expect(await screen.findByText(/n’est pas encore prête/)).toBeInTheDocument()
    await userEvent.click(await createButton())
    await waitFor(() => expect(calls.creations).toHaveLength(2))
    expect(calls.creations[1]?.key).not.toBe(calls.creations[0]?.key)
  })

  it('says creation is unavailable on a 503, and sends a new key on the next press', async () => {
    const calls = newCalls()
    serve(calls)
    await pressTwice(calls, () =>
      problem('https://kodera.io/problems/service-unavailable', { retryAfterS: 60 })
    )
    expect(
      await screen.findByText(/La création d’espaces est momentanément indisponible/)
    ).toBeInTheDocument()
    await userEvent.click(await createButton())
    await waitFor(() => expect(calls.creations).toHaveLength(2))
    expect(calls.creations[1]?.key).not.toBe(calls.creations[0]?.key)
  })

  it('reads the summary again when the deployment bills after all', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () => problem('https://kodera.io/problems/billing-enabled'))
    show()
    await userEvent.click(await createButton())
    await waitFor(() =>
      expect(shown.invalidate).toHaveBeenCalledWith({ queryKey: ['home', 'status-summary'] })
    )
    expect(homeReread()).toBe(false)
  })

  it('reads the membership again when the caller is no longer the owner', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () => problem('https://kodera.io/problems/forbidden'))
    show()
    await userEvent.click(await createButton())
    await waitFor(() => expect(invalidateRouter).toHaveBeenCalled())
    expect(await failed()).toBeInTheDocument()
    expect(homeReread()).toBe(false)
  })

  it('marks a reserved address on the field, and the keyboard lands there', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () =>
      problem('https://kodera.io/problems/validation-error', {
        errors: [{ pointer: '/slug', code: 'reserved', detail: 'reserved' }],
      })
    )
    show()
    await userEvent.click(await createButton())
    expect(await screen.findByText('Cette adresse est réservée.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Adresse/ })).toHaveFocus()
    expect(await createButton()).toBeDisabled()
  })

  it('marks a name Core refuses on the name field', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () =>
      problem('https://kodera.io/problems/validation-error', {
        errors: [{ pointer: '/name', code: 'invalid', detail: 'invalid' }],
      })
    )
    show()
    await userEvent.click(await createButton())
    expect(
      await screen.findByText('Le nom contient un caractère non autorisé.')
    ).toBeInTheDocument()
    expect(await createButton()).toBeDisabled()
  })

  it('remembers every address refused, not only the last', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, () =>
      problem('https://kodera.io/problems/slug-taken', {
        suggestions: [calls.creations.length === 1 ? 'acme-sa-2' : 'acme-sa-3'],
      })
    )
    show()
    await userEvent.click(await createButton())
    await userEvent.click(
      await screen.findByRole('button', { name: 'Utiliser l’adresse acme-sa-2' })
    )
    expect(await screen.findByText('Cette adresse est libre.')).toBeInTheDocument()
    await userEvent.click(await createButton())
    expect(await screen.findByText('Cette adresse est déjà prise.')).toBeInTheDocument()
    const address = screen.getByRole('textbox', { name: /Adresse/ })
    await userEvent.clear(address)
    await userEvent.type(address, 'acme-sa')
    expect(await screen.findByText('Cette adresse est déjà prise.')).toBeInTheDocument()
    expect(await createButton()).toBeDisabled()
  })

  it('holds the button while the home is read again, and says so if the read shows no tenant', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, created)
    show()
    let finishRead = () => {}
    shown.invalidate!.mockImplementation(
      () => new Promise<void>((resolve) => (finishRead = resolve))
    )
    await userEvent.click(await createButton())
    await waitFor(() => expect(homeReread()).toBe(true))
    expect(screen.getByRole('button', { name: /Création de l’espace/ })).toBeInTheDocument()
    // On the real home the tenant replaces this form; still here, the read did not show it.
    finishRead()
    expect(await screen.findByText(/Votre espace est créé/)).toBeInTheDocument()
    expect(await createButton()).toBeEnabled()
  })
})

// Under a parent that, like the home, shows the form only while the summary names no tenant: the
// home hears of the new answer a moment after the read the form awaits, so the form must not say
// anything in that moment.
describe('on a home that replaces the form once the tenant exists', () => {
  const NOT_SHOWN = 'Votre espace est créé'

  function summaryWith(tenantId: string | null) {
    return {
      ...EXAMPLES.getOrganisationStatusSummary.body,
      organisation_id: ORGANISATION_ID,
      tenant_id: tenantId,
      billing_enabled: false,
      workspace_pack_code: 'workspace',
    }
  }

  function HomeLike() {
    const summary = useStatusSummaryQuery(ORGANISATION_ID)
    const needsFallback = summary.data?.tenant_id === null
    const fallback = useFallbackTenantIdQuery(ORGANISATION_ID, needsFallback)
    if (summary.data === undefined || (needsFallback && fallback.data === undefined)) return null
    if (summary.data.tenant_id !== null || fallback.data != null)
      return <p>Espace en préparation</p>
    return (
      <CreateWorkspace
        organisationId={ORGANISATION_ID}
        organisationName="Acme SA"
        packCode="workspace"
      />
    )
  }

  const TENANT_ID = '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'

  /** Where the tenant shows after creation: the summary, only the tenant list, or nowhere. */
  function showHome(calls: Calls, shownIn: 'summary' | 'list' | 'nowhere') {
    const afterCreation = () => calls.creations.length > 0
    server.use(
      http.get(`*/api/v1/organisations/${ORGANISATION_ID}/status-summary`, () =>
        HttpResponse.json(summaryWith(shownIn === 'summary' && afterCreation() ? TENANT_ID : null))
      ),
      http.get(TENANTS, () =>
        HttpResponse.json({
          data:
            shownIn === 'list' && afterCreation()
              ? [{ ...EXAMPLES.getTenant.body, id: TENANT_ID }]
              : [],
          next_cursor: null,
        })
      )
    )
    const seen: string[] = []
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes(NOT_SHOWN) === true) seen.push('not-shown')
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <HomeLike />
      </QueryClientProvider>
    )
    return { seen, stop: () => observer.disconnect() }
  }

  it('says nothing between Core’s 201 and the home showing the tenant', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, created)
    const { seen, stop } = showHome(calls, 'summary')
    await userEvent.click(await createButton())
    expect(await screen.findByText('Espace en préparation')).toBeInTheDocument()
    stop()
    expect(seen).toEqual([])
  })

  it('says nothing either when only the tenant list knows the tenant yet', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, created)
    const { seen, stop } = showHome(calls, 'list')
    await userEvent.click(await createButton())
    expect(await screen.findByText('Espace en préparation')).toBeInTheDocument()
    stop()
    expect(seen).toEqual([])
  })

  it('says the workspace exists when the home’s read still names no tenant', async () => {
    const calls = newCalls()
    serve(calls)
    recordCreation(calls, created)
    const { stop } = showHome(calls, 'nowhere')
    await userEvent.click(await createButton())
    expect(await screen.findByText(new RegExp(NOT_SHOWN))).toBeInTheDocument()
    expect(await createButton()).toBeEnabled()
    stop()
  })
})

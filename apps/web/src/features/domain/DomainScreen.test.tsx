// The list of addresses in each state of docs/specs/domain-addresses-list.md,
// against a real QueryClient and a stubbed Core client: what is asserted is
// what a person reads and can reach, never which hook returned what.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '../../api/client'
import type * as CoreClientModule from '../../api/client'
import { PROBLEM_TYPES } from '../../api/generated/problems'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import {
  LONG_HOST,
  ORGANISATION_ID,
  baseDomain,
  baseTenant,
  domainId,
  mixedAddresses,
  providedHosts,
} from '../../mocks/fixtures/domainFixtures'
import { DomainScreen } from './DomainScreen'
import { addressesQueryKey } from './queries'

const { get, session } = vi.hoisted(() => ({
  get: vi.fn(),
  session: { role: 'org_admin', organisationId: '' },
}))

// Only the client is stubbed; `ApiProblem` stays the real class the screen
// tests an error against.
vi.mock('../../api/client', async () => ({
  ...(await vi.importActual<typeof CoreClientModule>('../../api/client')),
  coreApi: () => ({ GET: get }),
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: 'acme-sa' }),
    useLoaderData: () => ({
      membership: { role: session.role, organisation: { id: session.organisationId } },
    }),
  },
}))

// Every wait here is for a render, not for a duration; both limits are widened
// so a machine running several suites at once does not decide the result.
configure({ asyncUtilTimeout: 20_000 })
vi.setConfig({ testTimeout: 60_000 })

const TENANTS = '/organisations/{organisation_id}/tenants'
const onePage = (data: unknown[]) => ({ data: { data, has_more: false, next_cursor: null } })

/** Answers the two reads of the screen: the instance, then its addresses. */
function serve(domains: unknown[], tenants: unknown[] = [baseTenant()]) {
  get.mockImplementation((path: string) =>
    Promise.resolve(path === TENANTS ? onePage(tenants) : onePage(domains))
  )
}

beforeEach(() => {
  session.role = 'org_admin'
  session.organisationId = ORGANISATION_ID
  get.mockReset()
})

function renderScreen(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <DomainScreen />
    </QueryClientProvider>
  )
  return client
}

const heading = () => screen.getByRole('heading', { level: 1, name: 'Domaine & identité' })
const table = () => screen.getByRole('table', { name: 'Domaines' })

/** The cells of the row an address names, as the text a reader gets. */
function cells(host: string): (string | null)[] {
  const row = within(table()).getByText(host).closest('tr') as HTMLElement
  return [within(row).getByRole('rowheader'), ...within(row).getAllByRole('cell')].map(
    (cell) => cell.textContent
  )
}

function problemOf(suffix: string): ApiProblem {
  const type = PROBLEM_TYPES.find((entry) => entry.endsWith(`/${suffix}`))
  if (type === undefined) throw new Error(`The contract has no ${suffix} problem.`)
  return new ApiProblem({ type, status: suffix === 'forbidden' ? 403 : 500, title: suffix })
}

describe('the list of addresses', () => {
  it('shows each address with its application and its state', async () => {
    serve(mixedAddresses())
    renderScreen()

    await screen.findByText('visio.acme.fr')
    expect(screen.getByRole('rowheader', { name: 'visio.acme.fr' })).toHaveAttribute('scope', 'row')
    expect(heading()).toBeInTheDocument()
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
    ).toEqual(['Adresse', 'Application', 'État'])

    expect(cells('visio.acme.fr')).toEqual(['visio.acme.fr', 'Visio', 'VérifiéPrincipale'])
    expect(cells('livekit.visio.acme.fr')).toEqual([
      'livekit.visio.acme.fr',
      'VisioAppels vidéo',
      'Vérifié',
    ])
    expect(cells('docs.acme.fr')).toEqual(['docs.acme.fr', 'Docs', 'En attente de configuration'])
    expect(cells('reunions.acme.fr')).toEqual([
      'reunions.acme.fr',
      'Visio',
      'Vérification en cours',
    ])
    expect(cells('visio.acme-travaux.fr')).toEqual(['visio.acme-travaux.fr', 'Visio', 'Échec'])
    expect(cells(LONG_HOST)).toEqual([LONG_HOST, 'Visio', 'En attente de configuration'])

    // The provided addresses close the list, labelled and with no state.
    const [visio, docs] = providedHosts()
    expect(cells(visio as string)).toEqual([visio, 'Visio', 'Secours'])
    expect(cells(docs as string)).toEqual([docs, 'Docs', 'Secours'])
    const hosts = within(table())
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByRole('rowheader').textContent)
    expect(hosts).toEqual([...mixedAddresses().map((domain) => domain.fqdn), ...providedHosts()])

    // One landmark carries the list's name — the table's own scroll box — and
    // the headings go down one level at a time.
    expect(screen.getAllByRole('region', { name: 'Domaines' })).toHaveLength(1)
    expect(screen.getAllByRole('heading').map((entry) => entry.tagName)).toEqual(['H1', 'H2'])

    // Exactly one address is the main one: the one the API flags.
    expect(screen.getAllByText('Principale')).toHaveLength(1)
    // The long name keeps its whole text for a pointer.
    expect(screen.getByText(LONG_HOST)).toHaveAttribute('title', LONG_HOST)
    // Nothing says an address is missing when some are there.
    expect(screen.queryByText(/Aucune adresse à votre nom/)).not.toBeInTheDocument()
  })

  it('offers nothing to press, open or type in: the slice only reads', async () => {
    serve(mixedAddresses())
    renderScreen()
    await screen.findByText('visio.acme.fr')

    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryAllByRole('link')).toEqual([])
    expect(screen.queryAllByRole('textbox')).toEqual([])
    expect(screen.queryAllByRole('tablist')).toEqual([])
    expect(screen.queryByText(/Ajouter une adresse|Gérer|Copier|Vérifier maintenant/)).toBeNull()
    expect(screen.queryByText(/Connexion \(Google/)).toBeNull()
  })

  it('draws the table’s headers and the page heading while it loads', async () => {
    get.mockReturnValue(new Promise(() => {}))
    renderScreen()

    expect(heading()).toBeInTheDocument()
    expect(within(table()).getAllByRole('columnheader')).toHaveLength(3)
    expect(screen.getByRole('status')).toHaveTextContent('Chargement')
    expect(screen.queryByText(/Aucune adresse à votre nom/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the provided addresses alone, and says so, when none has been added', async () => {
    serve([])
    renderScreen()

    await screen.findByText("Aucune adresse à votre nom n'a encore été ajoutée.")
    const [visio, docs] = providedHosts()
    expect(cells(visio as string)).toEqual([visio, 'Visio', 'Secours'])
    expect(cells(docs as string)).toEqual([docs, 'Docs', 'Secours'])
    expect(within(table()).getAllByRole('row')).toHaveLength(3)
    // No action this slice cannot perform, and not the invitation to use one.
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryByText('Utilisez votre propre adresse')).not.toBeInTheDocument()
  })

  it('draws no empty table for an instance with no address at all', async () => {
    serve([], [baseTenant({ default_urls: {} })])
    renderScreen()

    await screen.findByText(/Aucune adresse à votre nom/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(heading()).toBeInTheDocument()
  })

  it('names an application the catalogue has no word for with a dash, never its code', async () => {
    serve(
      [baseDomain('fichiers.acme.fr', { id: domainId(7), app: 'drive', state: 'live' })],
      [baseTenant({ default_urls: { login: 'https://connexion.exemple.test' } })]
    )
    renderScreen()

    await screen.findByText('fichiers.acme.fr')
    expect(cells('fichiers.acme.fr')).toEqual(['fichiers.acme.fr', '—', 'Vérifié'])
    expect(cells('connexion.exemple.test')).toEqual(['connexion.exemple.test', '—', 'Secours'])
    expect(screen.queryByText(/drive|login/i)).not.toBeInTheDocument()
  })

  it('says when the organisation has no instance yet, and asks for no address', async () => {
    serve(mixedAddresses(), [])
    renderScreen()

    await screen.findByRole('heading', { name: "Pas encore d'instance" })
    expect(
      screen.getByText("Aucun espace n'est encore associé à votre organisation.")
    ).toBeVisible()
    expect(heading()).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(get.mock.calls.map(([path]) => path)).toEqual([TENANTS])
  })

  it('explains a failed read in plain words and recovers on retry', async () => {
    get.mockImplementation((path: string) =>
      path === TENANTS
        ? Promise.resolve(onePage([baseTenant()]))
        : Promise.reject(problemOf('internal-error'))
    )
    renderScreen()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      `Le service est momentanément indisponible. Réessayez dans quelques minutes ; si cela persiste, écrivez-nous à ${SUPPORT_EMAIL}.`
    )
    expect(heading()).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // Not the provided addresses alone, passed off as the list.
    expect(screen.queryByText(providedHosts()[0] as string)).not.toBeInTheDocument()
    expect(screen.queryByText(/500|internal/i)).not.toBeInTheDocument()

    serve(mixedAddresses())
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))

    await screen.findByText('visio.acme.fr')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
  })

  it('fails the same way when the instance itself cannot be read', async () => {
    get.mockRejectedValue(problemOf('internal-error'))
    renderScreen()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible.'
    )
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(get.mock.calls.map(([path]) => path)).toEqual([TENANTS])
  })

  it('refuses a response it cannot render rather than drawing a guess', async () => {
    serve([{ ...baseDomain('visio.acme.fr'), state: 'verified' }])
    renderScreen()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible.'
    )
    expect(screen.queryByText('visio.acme.fr')).not.toBeInTheDocument()
  })

  it('names who can open the page, without a retry, when the API refuses the read', async () => {
    get.mockRejectedValue(problemOf('forbidden'))
    renderScreen()

    await screen.findByText('Cette page est réservée aux administrateurs.', { exact: false })
    expect(heading()).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('keeps the addresses already shown when reading them again fails', async () => {
    serve(mixedAddresses())
    const client = renderScreen()
    await screen.findByText('visio.acme.fr')

    get.mockRejectedValue(new TypeError('Failed to fetch'))
    await client.refetchQueries({ queryKey: addressesQueryKey(ORGANISATION_ID) })
    await waitFor(() =>
      expect(client.getQueryState(addressesQueryKey(ORGANISATION_ID))?.status).toBe('error')
    )

    expect(screen.getByText('visio.acme.fr')).toBeInTheDocument()
    expect(within(table()).getAllByRole('row')).toHaveLength(
      1 + mixedAddresses().length + providedHosts().length
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('the role gate', () => {
  it.each(['org_owner', 'org_admin'])('lets %s read the addresses', async (role) => {
    session.role = role
    serve(mixedAddresses())
    renderScreen()

    await screen.findByText('visio.acme.fr')
    expect(screen.queryByText(/réservée aux administrateurs/)).not.toBeInTheDocument()
  })

  it.each(['org_member', 'org_billing'])(
    'keeps the list from %s and sends no request',
    async (role) => {
      session.role = role
      serve(mixedAddresses())
      renderScreen()

      await screen.findByText('Cette page est réservée aux administrateurs.', { exact: false })
      expect(heading()).toBeInTheDocument()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(screen.queryByText('visio.acme.fr')).not.toBeInTheDocument()
      expect(get).not.toHaveBeenCalled()
    }
  )
})

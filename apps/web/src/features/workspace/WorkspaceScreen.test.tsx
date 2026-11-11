import { communityDemo, communityWorkspace } from '../../mocks/demo/community'
import { THEME_STORAGE_KEY } from '../../theme/theme'
import { openWorkspaceCommand } from './WorkspaceMenu'
// The workspace screen in each state of docs/specs/11-workspace.md, against a real QueryClient
// and a stubbed Core client: what is asserted is what a person reads and can reach.

import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem, NetworkError } from '../../api/client'
import type * as CoreClientModule from '../../api/client'
import type * as MatrixModule from '../../auth/matrix'
import { clearMatrixSession, registerMatrixSession } from '../../auth/matrix'
import { PROBLEM_TYPES } from '../../api/generated/problems'
import type * as RouterModule from '@tanstack/react-router'
import { notInitialisedWorkspace, readyWorkspace } from '../../mocks/fixtures/workspaceFixtures'
import type { Workspace } from './workspace'
import { WorkspaceScreen } from './WorkspaceScreen'
import { registerInteractiveDemo } from '../../app/interactiveDemo'
import { createLocalWorkspaceStore } from '../../mocks/demo/workspaceStore'
import type { EspaceStoreLike } from '../espace/EspaceLiveView'

const { get, request, session, beginMatrixSignIn, navigate } = vi.hoisted(() => ({
  get: vi.fn(),
  request: vi.fn(),
  beginMatrixSignIn: vi.fn(),
  navigate: vi.fn(),
  session: {
    role: 'org_owner',
    slug: 'acme-sa',
    channelId: undefined as string | undefined,
    narrow: false,
    /** The organisation's tenant as `listTenants` gives it: `undefined` for the organisation's
     * own slug, `active`; `null` for none. */
    tenant: undefined as { slug: string; status: string } | null | undefined,
    /** The answers the tenant read gave, in order: what is asserted of its polling. */
    tenantReads: 0,
    /** When set, the tenant read waits for it: a case can draw the page before the tenant is
     * known. */
    tenantHeld: undefined as Promise<void> | undefined,
  },
}))

vi.mock('../../api/client', async () => ({
  ...(await vi.importActual<typeof CoreClientModule>('../../api/client')),
  coreApi: () => ({ GET: get, request }),
}))
// The sign-in is a full-page redirect jsdom cannot follow: what is asserted is where it goes.
vi.mock('../../auth/matrix', async () => ({
  ...(await vi.importActual<typeof MatrixModule>('../../auth/matrix')),
  beginMatrixSignIn,
}))
// The live workspace is its own screen, tested on its own: here, which session it is given, and
// what its channel choice and its « Se reconnecter » are wired to.
vi.mock('../espace/EspaceLiveView', () => ({
  EspaceLiveView: ({
    session: live,
    store,
    onNavigateChannel,
    onReconnect,
    activeCanvasMode,
    onChangeCanvasMode,
    docsCanvasSlot,
    organisationActionSlot,
  }: {
    activeCanvasMode?: string
    onChangeCanvasMode?: (mode: 'chat' | 'docs') => void
    docsCanvasSlot?: ReactNode
    organisationActionSlot?: ReactNode
    session?: { userId: string }
    store?: EspaceStoreLike
    onNavigateChannel?: (channelId: string) => void
    onReconnect?: () => void
  }) => (
    <div>
      <button onClick={() => onChangeCanvasMode?.('docs')}>Docs canvas</button>
      <button onClick={() => onChangeCanvasMode?.('chat')}>Discussion canvas</button>
      {organisationActionSlot}
      {activeCanvasMode === 'docs' ? docsCanvasSlot : null}
      <p data-testid="espace-live">{live?.userId ?? store?.getUserId()}</p>
      <button type="button" onClick={() => onNavigateChannel?.('channel-2')}>
        Choisir channel-2
      </button>
      <button type="button" onClick={() => onReconnect?.()}>
        Se reconnecter
      </button>
    </div>
  ),
}))
vi.mock('../../app/org-route', () => ({
  orgRoute: {
    useParams: () => ({ org: session.slug }),
    useLoaderData: () => ({
      membership: {
        role: session.role,
        // Another organisation is another id: each one's reads are its own.
        organisation: {
          id: session.slug === 'acme-sa' ? 'org-1' : `org-${session.slug}`,
          name: 'ACME Construction',
          slug: session.slug,
        },
      },
    }),
  },
}))
vi.mock('../../app/useNarrowViewport', () => ({ useNarrowViewport: () => session.narrow }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof RouterModule>()),
  useParams: () => (session.channelId === undefined ? {} : { channelId: session.channelId }),
  useNavigate: () => navigate,
  useRouter: () => ({ invalidate: vi.fn() }),
  useRouterState: ({ select }: { select: (state: { status: 'idle' | 'pending' }) => unknown }) =>
    select({ status: 'idle' }),
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: {
    children: ReactNode
    to: string
    params?: Record<string, string>
    search?: Record<string, string>
  }) => {
    const path = Object.entries(params ?? {}).reduce(
      (current, [name, value]) => current.replace(`$${name}`, value),
      to
    )
    const query = new URLSearchParams(search ?? {}).toString()
    const href = query === '' ? path : `${path}?${query}`
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    )
  },
}))

configure({ asyncUtilTimeout: 20_000 })
vi.setConfig({ testTimeout: 60_000 })

const REQUEST_ID = '019467a3-0f9b-7cc3-98c2-1fa48f28f562'

function answer(workspace: Workspace) {
  return {
    data: workspace,
    response: new Response(null, { headers: { 'X-Request-Id': REQUEST_ID } }),
  }
}

const TENANTS_PATH = '/organisations/{organisation_id}/tenants'

/** The tenant read's answer: the organisation's own slug and `active` unless a case says. */
function tenantAnswer() {
  session.tenantReads += 1
  const tenant =
    session.tenant === undefined ? { slug: session.slug, status: 'active' } : session.tenant
  return {
    data: { data: tenant === null ? [] : [{ id: 'tenant-1', ...tenant }] },
    response: new Response(null),
  }
}

/** Answers the workspace read with `read`, and the tenant read as `tenantAnswer` does. */
function onWorkspaceRead(read: () => Promise<unknown>) {
  get.mockImplementation((path: string) =>
    path === TENANTS_PATH ? (session.tenantHeld ?? Promise.resolve()).then(tenantAnswer) : read()
  )
}

function serve(...workspaces: Workspace[]) {
  let index = 0
  onWorkspaceRead(() => {
    const next = workspaces[Math.min(index, workspaces.length - 1)]!
    index += 1
    return Promise.resolve(answer(next))
  })
}

/** How many times the workspace itself was read, the tenant's reads aside. */
const workspaceReads = () => get.mock.calls.filter(([path]) => path !== TENANTS_PATH).length

function problem(suffix: string, status: number): ApiProblem {
  const type = PROBLEM_TYPES.find((entry) => entry.endsWith(`/${suffix}`))
  if (type === undefined) throw new Error(`The contract has no ${suffix} problem.`)
  return new ApiProblem({ type, status, title: suffix })
}

beforeEach(() => {
  session.role = 'org_owner'
  session.slug = 'acme-sa'
  session.channelId = undefined
  session.narrow = false
  session.tenant = undefined
  session.tenantReads = 0
  session.tenantHeld = undefined
  get.mockReset()
  request.mockReset()
  beginMatrixSignIn.mockReset()
  navigate.mockReset()
  // An automatic sign-in was just started, so the cases below open Espace by hand; the
  // automatic one has its own cases.
  sessionStorage.setItem(AUTO_OPEN_KEY, String(Date.now()))
})

afterEach(() => {
  sessionStorage.removeItem(AUTO_OPEN_KEY)
  clearMatrixSession()
  registerInteractiveDemo(undefined)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <WorkspaceScreen />
    </QueryClientProvider>
  )
  return client
}

const liveRegion = () => screen.getByRole('status')

const heading = () => screen.findByRole('heading', { level: 1 })

describe('the workspace, once it exists', () => {
  it('lists the categories and their channels in the order received', async () => {
    serve(readyWorkspace())
    renderScreen()
    const nav = await screen.findByRole('navigation', { name: 'Salons' })
    expect(within(nav).getByText('ACME Construction')).toBeInTheDocument()
    // The search first, then one disclosure button per category.
    expect(within(nav).getAllByRole('button')[0]).toHaveAccessibleName('Rechercher')
    expect(
      within(nav)
        .getAllByRole('button')
        .filter((button) => button.hasAttribute('aria-expanded'))
        .map((button) => button.textContent)
    ).toEqual(['Général', 'Équipe'])
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['#bienvenue', '#général'])
    // The audio channel is named, and says its room is being prepared (the contract's example
    // has it `pending`); it is joined from the live workspace, never from here.
    const team = within(nav).getByRole('button', { name: 'Équipe' }).parentElement!
    expect(within(team).getByText('détente').closest('li')).toHaveTextContent(
      'détente, Salon audioEn préparation'
    )
    expect(within(team).queryByRole('link')).toBeNull()
  })

  it('opens a channel chosen in the search, and leaves focus on its heading', async () => {
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    const heading = await screen.findByRole('heading', { level: 1 })
    const href = screen.getByRole('link', { name: 'général' }).getAttribute('href') ?? ''
    const channelId = href.split('/').at(-1)

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.keyboard('gén{Enter}')

    expect(navigate).toHaveBeenCalledWith({
      to: '/$org/workspace/$channelId',
      params: { org: 'acme-sa', channelId },
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(heading).toHaveFocus()
  })

  it('makes the first channel current and says messaging is not available, with no promise', async () => {
    serve(readyWorkspace())
    renderScreen()
    expect(await heading()).toHaveTextContent('bienvenue')
    expect(screen.getByRole('link', { name: 'bienvenue' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'général' })).not.toHaveAttribute('aria-current')
    expect(
      screen.getByText('La messagerie n’est pas disponible pour votre organisation.')
    ).toBeInTheDocument()
    // Messaging is in the pilot: the pane promises no later release (gap report G7).
    expect(screen.queryByText(/prochaine version/)).toBeNull()
  })

  it('links each channel to its own address', async () => {
    serve(readyWorkspace())
    renderScreen()
    const link = await screen.findByRole('link', { name: 'général' })
    const id = readyWorkspace().categories[0]!.channels[1]!.id
    expect(link).toHaveAttribute('href', `/acme-sa/workspace/${id}`)
  })

  it('draws the channel the address names', async () => {
    session.channelId = readyWorkspace().categories[0]!.channels[1]!.id
    serve(readyWorkspace())
    renderScreen()
    expect(await heading()).toHaveTextContent('général')
    expect(screen.getByRole('link', { name: 'général' })).toHaveAttribute('aria-current', 'page')
    // The dark workspace reference's current channel (docs/specs/workspace-dark-roles.md): the
    // accent row and its 3 px accent bar, with no edge.
    const current = screen.getByRole('link', { name: 'général' })
    expect(current).toHaveClass('bg-c-ok-soft', 'border-transparent', 'before:bg-c-accent-ink')
    expect(current).not.toHaveClass('border-c-accent-ink')
    expect(within(current).getByText('#')).toHaveClass('text-c-accent-ink')
    // One class at a time: `not.toHaveClass(a, b)` passes when either one is missing.
    expect(screen.getByRole('link', { name: 'bienvenue' })).not.toHaveClass('bg-c-accent-soft')
    expect(screen.getByRole('link', { name: 'bienvenue' })).not.toHaveClass(
      'before:bg-c-accent-ink'
    )
    // The search trigger is a muted well with no edge, named by its word, deepening on hover.
    const search = screen.getByRole('button', { name: /Rechercher/ })
    expect(search).toHaveClass('bg-c-muted', 'border-transparent', 'hover:bg-c-muted-2')
    expect(search).not.toHaveClass('bg-c-surface')
  })

  it('says a channel the caller cannot see is not available', async () => {
    session.channelId = 'not-a-visible-channel'
    serve(readyWorkspace())
    renderScreen()
    expect(await heading()).toHaveTextContent('Ce salon n’est pas disponible')
    expect(screen.getByRole('navigation', { name: 'Salons' })).toBeInTheDocument()
  })

  it('collapses and expands a category from the keyboard', async () => {
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    const general = await screen.findByRole('button', { name: 'Général' })
    expect(general).toHaveAttribute('aria-expanded', 'true')
    general.focus()
    await user.keyboard('{Enter}')
    expect(general).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'bienvenue' })).toBeNull()
    await user.keyboard(' ')
    expect(general).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'bienvenue' })).toBeInTheDocument()
  })

  it('names a row it has no label for by its stored name, and marks an archived channel', async () => {
    const workspace = readyWorkspace()
    workspace.uncategorised_channels = [
      {
        id: 'loose',
        kind: 'text',
        name: 'chantier-nord',
        template_key: null,
        topic: 'Le chantier de Lille',
        lifecycle: 'archived',
        room_state: 'ready',
      },
      {
        id: 'lounge',
        kind: 'audio',
        name: 'lounge',
        template_key: 'lounge',
        topic: '',
        lifecycle: 'archived',
        room_state: 'ready',
      },
    ]
    session.channelId = 'loose'
    serve(workspace)
    renderScreen()
    expect(await heading()).toHaveTextContent('chantier-nord')
    expect(screen.getByText('Le chantier de Lille')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /chantier-nord/ })).toHaveTextContent('Archivé')
    // An audio channel is never a link here; archived, it says so too.
    const nav = screen.getByRole('navigation', { name: 'Salons' })
    expect(within(nav).queryByRole('link', { name: /détente/ })).toBeNull()
    expect(
      within(nav)
        .getAllByRole('listitem')
        .filter((row) => row.querySelector('ul') === null)
        .at(-1)
    ).toHaveTextContent(/^détente, Salon audioArchivé$/)
  })

  it('opens the channels in a drawer on a phone', async () => {
    const user = userEvent.setup()
    session.narrow = true
    serve(readyWorkspace())
    renderScreen()
    expect(await heading()).toHaveTextContent('bienvenue')
    expect(screen.queryByRole('navigation', { name: 'Salons' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Salons' }))
    const drawer = await screen.findByRole('dialog', { name: 'Salons' })
    await user.click(within(drawer).getByRole('link', { name: 'général' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The drawer hands focus to the heading `RouteFocus` focuses too, not back to « Salons ».
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus())
  })

  it('returns focus to « Salons » when the drawer is closed without a choice', async () => {
    const user = userEvent.setup()
    session.narrow = true
    serve(readyWorkspace())
    renderScreen()
    const trigger = await screen.findByRole('button', { name: 'Salons' })
    await user.click(trigger)
    await screen.findByRole('dialog', { name: 'Salons' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('puts the page heading before the channel list in the document', async () => {
    serve(readyWorkspace())
    renderScreen()
    const h1 = await heading()
    const h2 = screen.getByRole('heading', { level: 2, name: 'Salons' })
    expect(h1.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('before the workspace exists', () => {
  it('says setup is in progress, with no action', async () => {
    serve(notInitialisedWorkspace({ state: 'running', reason: null }))
    renderScreen()
    expect(await heading()).toHaveTextContent('Votre espace de travail est en préparation')
    // The organisation stays named while there is no channel column to name it.
    expect(screen.getByText('ACME Construction')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('tells the owner their ownership is being confirmed, with no action', async () => {
    serve(notInitialisedWorkspace({ state: 'pending', reason: 'awaiting_owner_confirmation' }))
    renderScreen()
    expect(await heading()).toHaveTextContent('Nous confirmons votre rôle de propriétaire')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each(['org_admin', 'org_billing', 'org_member'])(
    'tells %s that setup is under way, never that they are being confirmed as owner',
    async (role) => {
      session.role = role
      serve(notInitialisedWorkspace({ state: 'pending', reason: 'awaiting_owner_confirmation' }))
      renderScreen()
      expect(await heading()).toHaveTextContent('Votre espace de travail est en préparation')
      expect(screen.queryByText(/propriétaire/)).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    }
  )

  it('says setup stopped, quotes the request id as such and links to help without it', async () => {
    serve(notInitialisedWorkspace({ state: 'failed', reason: 'realm_job_failed' }))
    renderScreen()
    expect(await heading()).toHaveTextContent(
      'La préparation de votre espace de travail s’est arrêtée'
    )
    expect(
      screen.getByText(new RegExp(`^Identifiant de la requête\\s: ${REQUEST_ID}$`))
    ).toBeInTheDocument()
    // The request id is not a job reference: Aide is told what happened, not handed the id.
    expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
      'href',
      '/acme-sa/help?reason=step-failed'
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('tells a member who may not create it that it has not been created yet', async () => {
    session.role = 'org_member'
    serve(notInitialisedWorkspace({ state: 'ready', reason: null }, false))
    renderScreen()
    expect(await heading()).toHaveTextContent('Votre espace de travail n’a pas encore été créé')
    expect(
      screen.getByText('Un propriétaire ou un administrateur de votre organisation peut le créer.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/en préparation/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('announces a state that changes while the page is open, in one region', async () => {
    serve(
      notInitialisedWorkspace({ state: 'running', reason: null }),
      notInitialisedWorkspace({ state: 'ready', reason: null }, true)
    )
    const client = renderScreen()
    await waitFor(() =>
      expect(liveRegion()).toHaveTextContent('Votre espace de travail est en préparation')
    )
    const region = liveRegion()
    await act(() => client.refetchQueries())
    await waitFor(() =>
      expect(liveRegion()).toHaveTextContent('Votre espace de travail est prêt à être créé')
    )
    // The same element: a region replaced with its words already in it is often not read out.
    expect(liveRegion()).toBe(region)
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})

describe('creating the workspace', () => {
  const ready = () => notInitialisedWorkspace({ state: 'ready', reason: null }, true)
  const keys = () =>
    request.mock.calls.map(
      ([, , init]) =>
        (init as { params: { header: { 'Idempotency-Key': string } } }).params.header[
          'Idempotency-Key'
        ]
    )

  it('creates it with a key, then draws the workspace from a new read', async () => {
    const user = userEvent.setup()
    serve(ready(), readyWorkspace())
    request.mockResolvedValue({ data: { state: 'initialised' }, response: new Response() })
    renderScreen()
    expect(await heading()).toHaveTextContent('Votre espace de travail est prêt à être créé')
    await user.click(screen.getByRole('button', { name: 'Créer l’espace de travail' }))
    expect(await screen.findByRole('navigation', { name: 'Salons' })).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
    const [method, path, init] = request.mock.calls[0]!
    expect(method).toBe('post')
    expect(path).toBe('/organisations/{organisation_id}/workspace/actions/initialise')
    expect(init).toMatchObject({ params: { path: { organisation_id: 'org-1' } } })
    expect(init).not.toHaveProperty('body')
    expect(keys()[0]).toMatch(/^[!-~]{16,255}$/)
    expect(workspaceReads()).toBe(2)
  })

  it('retries with the same key after a server failure', async () => {
    const user = userEvent.setup()
    serve(ready())
    request.mockRejectedValueOnce(problem('internal-error', 500))
    request.mockRejectedValueOnce(new NetworkError(new TypeError('offline')))
    renderScreen()
    const create = await screen.findByRole('button', { name: 'Créer l’espace de travail' })
    await user.click(create)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible'
    )
    await user.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(create).not.toHaveAttribute('aria-busy'))
    await user.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    const [first, second, third] = keys()
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('takes a new key after a refusal', async () => {
    const user = userEvent.setup()
    serve(ready())
    request.mockRejectedValueOnce(problem('forbidden', 403))
    request.mockRejectedValueOnce(problem('internal-error', 500))
    renderScreen()
    const create = await screen.findByRole('button', { name: 'Créer l’espace de travail' })
    await user.click(create)
    await screen.findByRole('alert')
    await user.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    const [first, second] = keys()
    expect(second).not.toBe(first)
  })

  it('sends one creation for two presses in the same frame', async () => {
    serve(ready(), readyWorkspace())
    let release: (value: unknown) => void = () => {}
    request.mockReturnValue(new Promise((resolve) => (release = resolve)))
    renderScreen()
    const create = await screen.findByRole('button', { name: 'Créer l’espace de travail' })
    // One act, so nothing renders between the presses: only the in-flight guard can refuse
    // the second, since the button has not turned busy yet.
    act(() => {
      create.click()
      create.click()
    })
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => release({ data: { state: 'initialised' }, response: new Response() }))
    expect(await screen.findByRole('navigation', { name: 'Salons' })).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reads again after a conflict, then creates with a new key', async () => {
    const user = userEvent.setup()
    serve(ready(), ready(), readyWorkspace())
    request.mockRejectedValueOnce(problem('invalid-state-transition', 409))
    request.mockResolvedValueOnce({ data: { state: 'initialised' }, response: new Response() })
    renderScreen()
    const create = await screen.findByRole('button', { name: 'Créer l’espace de travail' })
    await user.click(create)
    await waitFor(() => expect(workspaceReads()).toBe(2))
    await waitFor(() => expect(create).not.toHaveAttribute('aria-busy'))
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(create)
    expect(await screen.findByRole('navigation', { name: 'Salons' })).toBeInTheDocument()
    const [first, second] = keys()
    expect(second).not.toBe(first)
  })

  it('says the service is unavailable and reads again, never creates again, when the read after a creation fails', async () => {
    const user = userEvent.setup()
    let reachable = true
    let reads = 0
    onWorkspaceRead(() => {
      reads += 1
      if (reads === 1) return Promise.resolve(answer(ready()))
      return reachable
        ? Promise.resolve(answer(readyWorkspace()))
        : Promise.reject(problem('internal-error', 500))
    })
    request.mockResolvedValue({ data: { state: 'initialised' }, response: new Response() })
    reachable = false
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Créer l’espace de travail' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible'
    )
    expect(screen.queryByRole('button', { name: 'Créer l’espace de travail' })).toBeNull()
    reachable = true
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('navigation', { name: 'Salons' })).toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reads again after a conflict and draws what that read says', async () => {
    const user = userEvent.setup()
    serve(
      ready(),
      notInitialisedWorkspace({ state: 'pending', reason: 'awaiting_owner_confirmation' })
    )
    request.mockRejectedValueOnce(problem('invalid-state-transition', 409))
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Créer l’espace de travail' }))
    await waitFor(async () =>
      expect(await heading()).toHaveTextContent('Nous confirmons votre rôle de propriétaire')
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a read that fails', () => {
  it('says the service is unavailable and offers a retry', async () => {
    const user = userEvent.setup()
    let reachable = false
    onWorkspaceRead(() =>
      reachable
        ? Promise.resolve(answer(readyWorkspace()))
        : Promise.reject(problem('internal-error', 500))
    )
    renderScreen()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible'
    )
    reachable = true
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('navigation', { name: 'Salons' })).toBeInTheDocument()
  })

  it('does not ask again when Core does not serve the workspace yet', async () => {
    onWorkspaceRead(() => Promise.reject(problem('not-found', 404)))
    renderScreen()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible'
    )
    expect(workspaceReads()).toBe(1)
  })

  it('refuses an answer outside the contract rather than drawing it', async () => {
    onWorkspaceRead(() =>
      Promise.resolve({
        data: { ...readyWorkspace(), state: 'archived' },
        response: new Response(),
      })
    )
    renderScreen()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible'
    )
  })
})

const AUTO_OPEN_KEY = 'kodera.espace.auto-open.v1'

/**
 * Every text the page held, even for a single commit: the text of each node added or removed,
 * and the old value of each text node changed in place. A state drawn and replaced before any
 * assertion runs is still caught. A button that was ever drawn not busy, then made busy, is
 * noted as « idle button: <its text> ».
 */
function textsEverDrawn() {
  const seen: string[] = []
  const note = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === 'characterData') seen.push(record.oldValue ?? '')
      if (record.type === 'attributes' && record.oldValue === null)
        seen.push(`idle button: ${record.target.textContent ?? ''}`)
      for (const node of [...record.addedNodes, ...record.removedNodes])
        seen.push(node.textContent ?? '')
    }
  }
  const observer = new MutationObserver(note)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeFilter: ['aria-busy'],
    attributeOldValue: true,
  })
  return {
    /** Read once `stop` has run. */
    texts: () => seen,
    stop: () => {
      note(observer.takeRecords())
      observer.disconnect()
    },
  }
}

/** Discovery's answer, as the tenant's well-known serves it. */
function discovery(answer: () => Promise<Response>) {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => answer())
  vi.stubGlobal('fetch', fetchImpl)
  return fetchImpl
}

describe('the way into the live workspace', () => {
  const WELL_KNOWN = 'https://acme-sa.kodera.test/.well-known/matrix/client'
  const homeserver = () =>
    discovery(async () =>
      Response.json({ 'm.homeserver': { base_url: 'https://matrix.acme-sa.kodera.test' } })
    )

  it('opens Espace on its own on the first visit, with no click', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    sessionStorage.removeItem(AUTO_OPEN_KEY)
    homeserver()
    serve(readyWorkspace())
    renderScreen()
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    // `replace`, not `assign`: « back » from the workspace must not reach a page that starts it
    // again. Back to #welcome, whose room exists (quick-workspace SPEC W2).
    const welcomeId = readyWorkspace().categories[0]!.channels[0]!.id
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-sa.kodera.test',
      `/acme-sa/workspace/${welcomeId}`,
      { navigate: expect.any(Function) }
    )
  })

  it('draws the automatic start as opening from the first draw, never the invitation to open', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    sessionStorage.removeItem(AUTO_OPEN_KEY)
    homeserver()
    serve(readyWorkspace())
    const drawn = textsEverDrawn()
    try {
      renderScreen()
      expect(await screen.findByText('Ouverture de vos messages…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Ouvrir les messages' })).toHaveAttribute(
        'aria-busy',
        'true'
      )
      await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    } finally {
      drawn.stop()
    }
    // Every text the page ever held, even for one commit: the invitation was never among them,
    // and the button was never drawn ready to press.
    expect(drawn.texts().some((text) => text.includes('Ouvrez vos messages'))).toBe(false)
    expect(drawn.texts().some((text) => text.startsWith('idle button:'))).toBe(false)
  })

  it('offers the way in again when the automatic start cannot reach the homeserver', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    sessionStorage.removeItem(AUTO_OPEN_KEY)
    discovery(async () => {
      throw new TypeError('Failed to fetch')
    })
    serve(readyWorkspace())
    renderScreen()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La messagerie est injoignable pour le moment.'
    )
    expect(
      screen.getByText('Ouvrez vos messages pour lire et écrire dans vos salons.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ouvrir les messages' })).not.toHaveAttribute(
      'aria-busy'
    )
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
  })

  it('does not open it again within a minute, and offers « Ouvrir les messages » in the pane', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    sessionStorage.setItem(AUTO_OPEN_KEY, String(Date.now() - 59_000))
    homeserver()
    serve(readyWorkspace())
    const drawn = textsEverDrawn()
    try {
      renderScreen()
      expect(
        await screen.findByText('Ouvrez vos messages pour lire et écrire dans vos salons.')
      ).toBeInTheDocument()
    } finally {
      drawn.stop()
    }
    expect(screen.getByRole('button', { name: 'Ouvrir les messages' })).not.toHaveAttribute(
      'aria-busy'
    )
    // No automatic start is due, so « opening » is never drawn either.
    expect(drawn.texts().some((text) => text.includes('Ouverture de vos messages'))).toBe(false)
    expect(screen.queryByText(/prochaine version/)).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
  })

  it('opens it on its own again once a minute has passed', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    sessionStorage.setItem(AUTO_OPEN_KEY, String(Date.now() - 61_000))
    homeserver()
    serve(readyWorkspace())
    renderScreen()
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
  })

  it('never opens it on its own without session storage', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    sessionStorage.removeItem(AUTO_OPEN_KEY)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    try {
      homeserver()
      serve(readyWorkspace())
      renderScreen()
      expect(await screen.findByRole('button', { name: 'Ouvrir les messages' })).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(beginMatrixSignIn).not.toHaveBeenCalled()
      // The start it could not claim leaves the page idle, not stuck « opening ».
      expect(
        screen.getByText('Ouvrez vos messages pour lire et écrire dans vos salons.')
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Ouvrir les messages' })).not.toHaveAttribute(
        'aria-busy'
      )
    } finally {
      setItem.mockRestore()
    }
  })

  it('is not offered where the deployment names no matrix domain', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', '')
    serve(readyWorkspace())
    renderScreen()
    await screen.findByRole('navigation', { name: 'Salons' })
    expect(screen.queryByRole('button', { name: 'Ouvrir les messages' })).not.toBeInTheDocument()
  })

  it("finds the organisation's homeserver and signs in to it, back to this page", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace?from=rail')
    const fetchImpl = discovery(async () =>
      Response.json({ 'm.homeserver': { base_url: 'https://matrix.acme-sa.kodera.test' } })
    )
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Ouvrir les messages' }))
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(WELL_KNOWN)
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-sa.kodera.test',
      '/acme-sa/workspace?from=rail',
      {}
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says the homeserver cannot be reached, and lets the member try again', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    let reachable = false
    discovery(async () => {
      if (!reachable) throw new TypeError('Failed to fetch')
      return new Response(null, { status: 404 })
    })
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Ouvrir les messages' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La messagerie est injoignable pour le moment.'
    )
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
    reachable = true
    await user.click(screen.getByRole('button', { name: 'Ouvrir les messages' }))
    await waitFor(() =>
      expect(beginMatrixSignIn).toHaveBeenCalledWith(
        'https://acme-sa.kodera.test',
        '/acme-sa/workspace',
        {}
      )
    )
  })

  it('refuses a homeserver outside the matrix domain, and says Espace cannot open', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/')
    discovery(async () =>
      Response.json({ 'm.homeserver': { base_url: 'https://matrix.elsewhere.example' } })
    )
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Ouvrir les messages' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La messagerie ne peut pas s’ouvrir pour votre organisation pour le moment.'
    )
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
  })

  it('starts one sign-in for two clicks before the page draws « opening »', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    const fetchImpl = discovery(async () => new Response(null, { status: 404 }))
    serve(readyWorkspace())
    renderScreen()
    const button = await screen.findByRole('button', { name: 'Ouvrir les messages' })
    // One act: React draws nothing between the two clicks.
    act(() => {
      button.click()
      button.click()
    })
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is idle again when the page comes back from the back/forward cache', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    discovery(async () => new Response(null, { status: 404 }))
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    const button = await screen.findByRole('button', { name: 'Ouvrir les messages' })
    await user.click(button)
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    // The navigation did not happen here; the page is left « opening », as it would be in the cache.
    expect(button).toHaveAttribute('aria-busy', 'true')
    // A page shown afresh is not the cached one: it stays as it is.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    })
    expect(button).toHaveAttribute('aria-busy', 'true')
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    expect(button).not.toHaveAttribute('aria-busy')
    await user.click(button)
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(2))
  })
})

describe("one organisation's Matrix session", () => {
  const WELL_KNOWN_ACME = 'https://acme-sa.kodera.test/.well-known/matrix/client'

  function signedInTo(serverName: string) {
    registerMatrixSession({
      baseUrl: `https://matrix.${serverName}`,
      userId: `@sub-1:${serverName}`,
      deviceId: 'DEVICE',
      accessToken: 'syt_access',
      refreshToken: 'syr_refresh',
      refresh: vi.fn(),
    })
  }

  it("opens that organisation's live workspace", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    signedInTo('acme-sa.kodera.test')
    serve(readyWorkspace())
    renderScreen()
    expect(await screen.findByTestId('espace-live')).toHaveTextContent('@sub-1:acme-sa.kodera.test')
  })

  it("is not shown in another organisation's workspace, which offers its own way in", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    signedInTo('acme-sa.kodera.test')
    session.slug = 'other-org'
    window.history.replaceState(null, '', '/other-org/workspace')
    const fetchImpl = discovery(async () => new Response(null, { status: 404 }))
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Ouvrir les messages' }))
    expect(screen.queryByTestId('espace-live')).not.toBeInTheDocument()
    // The way in is the other organisation's own: its sign-in leaves the page, and the session
    // it brings back replaces the first.
    await waitFor(() =>
      expect(beginMatrixSignIn).toHaveBeenCalledWith(
        'https://other-org.kodera.test',
        '/other-org/workspace',
        {}
      )
    )
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://other-org.kodera.test/.well-known/matrix/client'
    )
  })

  it("makes a channel chosen in it the address, that channel's route", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    signedInTo('acme-sa.kodera.test')
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Choisir channel-2' }))
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/$org/workspace/$channelId',
      params: { org: 'acme-sa', channelId: 'channel-2' },
    })
  })

  it('signs in again from « Se reconnecter », back to this page', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    signedInTo('acme-sa.kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace/channel-2')
    const fetchImpl = discovery(async () =>
      Response.json({ 'm.homeserver': { base_url: 'https://matrix.acme-sa.kodera.test' } })
    )
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Se reconnecter' }))
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(WELL_KNOWN_ACME)
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-sa.kodera.test',
      '/acme-sa/workspace/channel-2',
      {}
    )
  })

  it('says why « Se reconnecter » could not start the sign-in', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    signedInTo('acme-sa.kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    discovery(async () => {
      throw new TypeError('Failed to fetch')
    })
    const user = userEvent.setup()
    serve(readyWorkspace())
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Se reconnecter' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La messagerie est injoignable pour le moment.'
    )
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
    expect(screen.getByTestId('espace-live')).toBeInTheDocument()
  })

  it("starts afresh in another organisation's workspace, without the first one's state", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    signedInTo('acme-sa.kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    discovery(async () => {
      throw new TypeError('Failed to fetch')
    })
    const user = userEvent.setup()
    serve(readyWorkspace())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screenIn = () => (
      <QueryClientProvider client={client}>
        <WorkspaceScreen />
      </QueryClientProvider>
    )
    const view = render(screenIn())
    await user.click(await screen.findByRole('button', { name: 'Se reconnecter' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // The member opens another organisation, signed in to its homeserver.
    signedInTo('other-org.kodera.test')
    session.slug = 'other-org'
    view.rerender(screenIn())
    // Another organisation: its workspace and its tenant are read afresh.
    expect(await screen.findByTestId('espace-live')).toHaveTextContent(
      '@sub-1:other-org.kodera.test'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is not shown where the deployment names no matrix domain', async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', '')
    signedInTo('acme-sa.kodera.test')
    serve(readyWorkspace())
    renderScreen()
    await screen.findByRole('navigation', { name: 'Salons' })
    expect(screen.queryByTestId('espace-live')).not.toBeInTheDocument()
  })
})

/** The starter workspace with every room in `state`, then the rooms `overrides` names. */
function workspaceWithRooms(
  state: 'pending' | 'ready' | 'failed',
  overrides: Record<string, 'pending' | 'ready' | 'failed'> = {}
): Workspace {
  const workspace = readyWorkspace()
  for (const category of workspace.categories)
    for (const channel of category.channels)
      channel.room_state = overrides[channel.template_key ?? ''] ?? state
  return workspace
}

/** The interval the query under `queryKey` asks for now, as TanStack Query computes it. */
function refetchIntervalOf(client: QueryClient, queryKey: readonly unknown[]) {
  const query = client.getQueryCache().find({ queryKey, exact: true })
  if (query === undefined) throw new Error(`No query ${JSON.stringify(queryKey)}.`)
  const interval = query.observers[0]?.options.refetchInterval
  return typeof interval === 'function' ? interval(query as never) : interval
}

const WORKSPACE_KEY = ['workspace', 'org-1'] as const
const TENANT_KEY = ['workspace-tenant', 'org-1'] as const

describe('a workspace whose tenant is being prepared (quick-workspace W2)', () => {
  const welcomeId = () => readyWorkspace().categories[0]!.channels[0]!.id

  /** A deployment with a matrix domain, an automatic start due, and a homeserver that answers. */
  function espaceDue() {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    sessionStorage.removeItem(AUTO_OPEN_KEY)
    return discovery(async () =>
      Response.json({ 'm.homeserver': { base_url: 'https://matrix.acme-sa.kodera.test' } })
    )
  }

  it('greys every channel under the banner and starts no sign-in while the tenant is ordered', async () => {
    const fetchImpl = espaceDue()
    // Even a session already held for that server name is not used: its homeserver does not
    // exist yet.
    registerMatrixSession({
      baseUrl: 'https://matrix.acme-sa.kodera.test',
      userId: '@sub-1:acme-sa.kodera.test',
      deviceId: 'DEVICE',
      accessToken: 'syt_access',
      refreshToken: 'syr_refresh',
      refresh: vi.fn(),
    })
    session.tenant = { slug: 'acme-sa', status: 'ordered' }
    serve(workspaceWithRooms('pending'))
    // The workspace arrives first; the tenant only once that has been drawn.
    let releaseTenant = () => {}
    session.tenantHeld = new Promise((resolve) => (releaseTenant = resolve))
    const user = userEvent.setup()
    const client = renderScreen()
    // The region is mounted with the page, first in it, before the skeleton's own status:
    // everything it ever says is recorded from the start.
    const region = screen.getAllByRole('status')[0]!
    const announced: string[] = []
    const observer = new MutationObserver(() => announced.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, subtree: true, characterData: true })
    await waitFor(() => expect(workspaceReads()).toBe(1))
    // The workspace is read, the tenant not yet: nothing it would open is drawn.
    await act(async () => {})
    expect(screen.queryByRole('navigation', { name: 'Salons' })).toBeNull()
    releaseTenant()
    expect(
      await screen.findByText('Votre espace se prépare. Vous pourrez y écrire dès qu’il sera prêt.')
    ).toBeInTheDocument()
    observer.disconnect()
    // The preparing title only: never the workspace's, not even while the tenant was being read.
    expect(announced.filter((text) => text !== '')).toEqual([
      'Votre espace de travail est en préparation',
    ])
    expect(
      screen.queryByText('La messagerie n’est pas disponible pour votre organisation.')
    ).toBeNull()
    const nav = screen.getByRole('navigation', { name: 'Salons' })
    // Three rows, two text and one audio, each saying it is not ready; none can be chosen.
    expect(
      within(nav)
        .getAllByRole('listitem')
        .filter((row) => row.querySelector('ul') === null)
        .map((row) => row.textContent)
    ).toEqual([
      '#bienvenueEn préparation',
      '#généralEn préparation',
      'détente, Salon audioEn préparation',
    ])
    expect(within(nav).queryByRole('link')).toBeNull()
    expect(screen.queryByTestId('espace-live')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ouvrir les messages' })).toBeNull()
    expect(screen.queryByText('Ouverture de vos messages…')).toBeNull()
    expect(refetchIntervalOf(client, WORKSPACE_KEY)).toBe(10_000)
    // `ordered` waits on an operator: read every minute, not every 10 s.
    expect(refetchIntervalOf(client, TENANT_KEY)).toBe(60_000)
    // Nor can the search reach a channel whose room does not exist.
    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.keyboard('bien')
    expect(
      await screen.findByText('Aucune destination ni commande ne correspond.')
    ).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('starts one sign-in, back to #welcome, once the tenant is set active, with no reload', async () => {
    espaceDue()
    session.tenant = { slug: 'acme-sa', status: 'provisioning' }
    serve(workspaceWithRooms('ready'))
    const client = renderScreen()
    await screen.findByText('Votre espace se prépare. Vous pourrez y écrire dès qu’il sera prêt.')
    // Every room is ready, yet nothing can be opened before the homeserver exists.
    const nav = screen.getByRole('navigation', { name: 'Salons' })
    expect(within(nav).queryByRole('link')).toBeNull()
    expect(
      within(nav)
        .getAllByRole('listitem')
        .filter((row) => row.querySelector('ul') === null)
        .map((row) => row.textContent)
    ).toEqual([
      '#bienvenueEn préparation',
      '#généralEn préparation',
      'détente, Salon audioEn préparation',
    ])
    const region = liveRegion()
    const announced: string[] = []
    const observer = new MutationObserver(() => announced.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, subtree: true, characterData: true })
    const drawn = textsEverDrawn()
    try {
      session.tenant = { slug: 'acme-sa', status: 'active' }
      await act(() => client.refetchQueries({ queryKey: TENANT_KEY, exact: true }))
      await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    } finally {
      drawn.stop()
      observer.disconnect()
    }
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-sa.kodera.test',
      `/acme-sa/workspace/${welcomeId()}`,
      { navigate: expect.any(Function) }
    )
    // Announced once: the workspace's title, after the preparing one.
    expect(announced.filter((text) => text !== '')).toEqual(['Espace de travail'])
    // Opening is drawn from the draw that sees the tenant active: never the invitation to open.
    expect(drawn.texts().some((text) => text.includes('Ouvrez vos messages'))).toBe(false)
    expect(drawn.texts().some((text) => text.startsWith('idle button:'))).toBe(false)
    expect(refetchIntervalOf(client, TENANT_KEY)).toBe(false)
    // Open now: the ready rooms are links again.
    expect(
      within(screen.getByRole('navigation', { name: 'Salons' })).getByRole('link', {
        name: 'bienvenue',
      })
    ).toBeInTheDocument()
  })

  it('says setup stopped, with the support link, when the tenant failed', async () => {
    espaceDue()
    session.tenant = { slug: 'acme-sa', status: 'failed' }
    serve(workspaceWithRooms('pending'))
    const client = renderScreen()
    expect(await heading()).toHaveTextContent(
      'La préparation de votre espace de travail s’est arrêtée'
    )
    expect(liveRegion()).toHaveTextContent(
      'La préparation de votre espace de travail s’est arrêtée'
    )
    expect(screen.getByRole('link', { name: 'Nous écrire' })).toHaveAttribute(
      'href',
      '/acme-sa/help?reason=step-failed'
    )
    expect(refetchIntervalOf(client, TENANT_KEY)).toBe(60_000)
    // The workspace read succeeded: its request id is not the stopped step's.
    expect(screen.queryByText(/^Identifiant de la requête/)).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
  })

  it('keeps a failed room unusable once the tenant is active, and still starts the sign-in', async () => {
    espaceDue()
    serve(workspaceWithRooms('ready', { general: 'failed' }))
    const client = renderScreen()
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    const nav = screen.getByRole('navigation', { name: 'Salons' })
    expect(within(nav).getByText('général').closest('li')).toHaveTextContent(
      '#généralEn préparation'
    )
    expect(within(nav).queryByRole('link', { name: 'général' })).toBeNull()
    expect(within(nav).getByRole('link', { name: 'bienvenue' })).toBeInTheDocument()
    // The audio channel, its room ready, is named and nothing more: it is joined live.
    expect(within(nav).getByText('détente').closest('li')).toHaveTextContent(
      /^détente, Salon audio$/
    )
    expect(within(nav).queryByRole('link', { name: 'détente' })).toBeNull()
    expect(refetchIntervalOf(client, WORKSPACE_KEY)).toBe(60_000)
  })

  it('finds only a text channel whose room exists in the search', async () => {
    serve(workspaceWithRooms('ready', { general: 'failed' }))
    const user = userEvent.setup()
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Rechercher' }))
    await user.keyboard('dét')
    expect(screen.queryByRole('option', { name: /^#détente/ })).toBeNull()
    await user.clear(screen.getByRole('combobox'))
    await user.keyboard('gén')
    expect(screen.queryByRole('option', { name: /^#général/ })).toBeNull()
    await user.clear(screen.getByRole('combobox'))
    await user.keyboard('bien')
    expect(await screen.findByRole('option', { name: /bienvenue/ })).toBeInTheDocument()
  })

  it('comes back to the channel the address names, not #welcome', async () => {
    espaceDue()
    const generalId = readyWorkspace().categories[0]!.channels[1]!.id
    session.channelId = generalId
    window.history.replaceState(null, '', `/acme-sa/workspace/${generalId}`)
    serve(workspaceWithRooms('ready'))
    renderScreen()
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-sa.kodera.test',
      `/acme-sa/workspace/${generalId}`,
      { navigate: expect.any(Function) }
    )
  })

  it('reads the tenant again when the member comes back to the tab', async () => {
    session.tenant = { slug: 'acme-sa', status: 'ordered' }
    serve(workspaceWithRooms('pending'))
    // The application's own defaults: no re-read on focus unless a query asks for it.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <WorkspaceScreen />
      </QueryClientProvider>
    )
    await screen.findByText('Votre espace se prépare. Vous pourrez y écrire dès qu’il sera prêt.')
    const before = session.tenantReads
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    // Well before the 10 s poll could read it instead.
    await waitFor(() => expect(session.tenantReads).toBe(before + 1), { timeout: 2_000 })
    focusManager.setFocused(undefined)
  })

  it('returns to the page on screen when #welcome has no room yet', async () => {
    espaceDue()
    serve(workspaceWithRooms('ready', { welcome: 'pending' }))
    renderScreen()
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-sa.kodera.test',
      '/acme-sa/workspace',
      { navigate: expect.any(Function) }
    )
  })

  it('stops reading once every room is ready and the tenant is active', async () => {
    serve(workspaceWithRooms('ready'))
    const client = renderScreen()
    await screen.findByRole('navigation', { name: 'Salons' })
    expect(refetchIntervalOf(client, WORKSPACE_KEY)).toBe(false)
    expect(refetchIntervalOf(client, TENANT_KEY)).toBe(false)
  })

  it("finds the homeserver and the session from the tenant's slug, not the organisation's", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    window.history.replaceState(null, '', '/acme-sa/workspace')
    session.tenant = { slug: 'acme-team', status: 'active' }
    const fetchImpl = discovery(async () =>
      Response.json({ 'm.homeserver': { base_url: 'https://matrix.acme-team.kodera.test' } })
    )
    // A session on the organisation's own slug is not this tenant's.
    registerMatrixSession({
      baseUrl: 'https://matrix.acme-sa.kodera.test',
      userId: '@sub-1:acme-sa.kodera.test',
      deviceId: 'DEVICE',
      accessToken: 'syt_access',
      refreshToken: 'syr_refresh',
      refresh: vi.fn(),
    })
    const user = userEvent.setup()
    serve(workspaceWithRooms('ready'))
    renderScreen()
    await user.click(await screen.findByRole('button', { name: 'Ouvrir les messages' }))
    expect(screen.queryByTestId('espace-live')).toBeNull()
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://acme-team.kodera.test/.well-known/matrix/client'
    )
    expect(beginMatrixSignIn).toHaveBeenCalledWith(
      'https://matrix.acme-team.kodera.test',
      '/acme-sa/workspace',
      {}
    )
  })

  it.each(['acme', `a${'b'.repeat(30)}c`])(
    'opens a tenant whose slug only the tenant rule allows (%s)',
    async (slug) => {
      vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
      window.history.replaceState(null, '', '/acme-sa/workspace')
      session.tenant = { slug, status: 'active' }
      const fetchImpl = discovery(async () =>
        Response.json({ 'm.homeserver': { base_url: `https://matrix.${slug}.kodera.test` } })
      )
      const user = userEvent.setup()
      serve(workspaceWithRooms('ready'))
      renderScreen()
      await user.click(await screen.findByRole('button', { name: 'Ouvrir les messages' }))
      await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
      expect(String(fetchImpl.mock.calls[0]![0])).toBe(
        `https://${slug}.kodera.test/.well-known/matrix/client`
      )
    }
  )

  it('keeps the tenant read while the member is in another module', async () => {
    serve(workspaceWithRooms('ready'))
    const client = renderScreen()
    await waitFor(() =>
      expect(client.getQueryData(TENANT_KEY)).toMatchObject({ slug: 'acme-sa', status: 'active' })
    )
    // The live workspace's drafts are checked against this entry: it must outlive the screen.
    expect(client.getQueryCache().find({ queryKey: TENANT_KEY, exact: true })?.gcTime).toBe(
      Infinity
    )
  })

  it("opens the live workspace with the tenant's session", async () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    session.tenant = { slug: 'acme-team', status: 'active' }
    registerMatrixSession({
      baseUrl: 'https://matrix.acme-team.kodera.test',
      userId: '@sub-1:acme-team.kodera.test',
      deviceId: 'DEVICE',
      accessToken: 'syt_access',
      refreshToken: 'syr_refresh',
      refresh: vi.fn(),
    })
    serve(workspaceWithRooms('ready'))
    const fetchImpl = discovery(async () => {
      throw new TypeError('Failed to fetch')
    })
    const user = userEvent.setup()
    renderScreen()
    expect(await screen.findByTestId('espace-live')).toHaveTextContent(
      '@sub-1:acme-team.kodera.test'
    )
    // « Se reconnecter » asks the tenant's homeserver too.
    await user.click(screen.getByRole('button', { name: 'Se reconnecter' }))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://acme-team.kodera.test/.well-known/matrix/client'
    )
  })

  it.each(['suspended', 'decommissioning', 'deleted'] as const)(
    'offers no way in, and uses no session, while the tenant is %s',
    async (status) => {
      espaceDue()
      registerMatrixSession({
        baseUrl: 'https://matrix.acme-sa.kodera.test',
        userId: '@sub-1:acme-sa.kodera.test',
        deviceId: 'DEVICE',
        accessToken: 'syt_access',
        refreshToken: 'syr_refresh',
        refresh: vi.fn(),
      })
      session.tenant = { slug: 'acme-sa', status }
      serve(workspaceWithRooms('ready'))
      const client = renderScreen()
      expect(
        await screen.findByText('La messagerie n’est pas disponible pour votre organisation.')
      ).toBeInTheDocument()
      expect(screen.queryByTestId('espace-live')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Ouvrir les messages' })).toBeNull()
      expect(refetchIntervalOf(client, TENANT_KEY)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(beginMatrixSignIn).not.toHaveBeenCalled()
    }
  )

  it('offers no way in, and starts none, when the organisation has no tenant', async () => {
    espaceDue()
    session.tenant = null
    serve(workspaceWithRooms('ready'))
    renderScreen()
    expect(
      await screen.findByText('La messagerie n’est pas disponible pour votre organisation.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ouvrir les messages' })).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
  })

  it('draws nothing it would open before the tenant is read, and offers a retry when it fails', async () => {
    espaceDue()
    let tenantUp = false
    get.mockImplementation((path: string) => {
      if (path !== TENANTS_PATH) return Promise.resolve(answer(workspaceWithRooms('ready')))
      return tenantUp
        ? Promise.resolve(tenantAnswer())
        : Promise.reject(problem('internal-error', 500))
    })
    const user = userEvent.setup()
    renderScreen()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible'
    )
    expect(screen.queryByRole('navigation', { name: 'Salons' })).toBeNull()
    expect(beginMatrixSignIn).not.toHaveBeenCalled()
    tenantUp = true
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(beginMatrixSignIn).toHaveBeenCalledTimes(1))
  })
})

it('wires the live Discussion and Docs canvas and preserves each channel draft', async () => {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
  session.tenant = { slug: 'acme-team', status: 'active' }
  registerMatrixSession({
    baseUrl: 'https://matrix.acme-team.kodera.test',
    userId: '@sub-1:acme-team.kodera.test',
    deviceId: 'DEVICE',
    accessToken: 'syt_access',
    refreshToken: 'syr_refresh',
    refresh: vi.fn(),
  })
  const workspace = workspaceWithRooms('ready')
  session.channelId = workspace.categories[0]!.channels[0]!.id
  serve(workspace)
  const user = userEvent.setup()
  renderScreen()
  await user.click(await screen.findByRole('button', { name: 'Docs canvas' }))
  const editor = screen
    .getAllByTestId('docs-inline-textarea')
    .find((node) => !node.closest('[hidden]'))!
  await user.clear(editor)
  await user.type(editor, 'Production draft')
  await user.click(screen.getByRole('button', { name: 'Discussion canvas' }))
  await user.click(screen.getByRole('button', { name: 'Docs canvas' }))
  const returned = screen
    .getAllByTestId('docs-inline-textarea')
    .find((node) => !node.closest('[hidden]'))!
  expect(returned).toHaveValue('Production draft')
  await user.click(
    screen.getByRole('button', { name: 'Documentation développeur & API (Docs-as-Code)' })
  )
  expect(screen.getByTestId('developer-docs-hub')).toBeInTheDocument()
  const openCommunity = vi.spyOn(window, 'open').mockImplementation(() => null)
  await user.click(screen.getByRole('button', { name: 'Ouvrir le salon d’entraide associé' }))
  expect(openCommunity).toHaveBeenCalledWith(
    'https://community.kodera.io/community/workspace',
    '_blank',
    'noopener,noreferrer'
  )
  openCommunity.mockRestore()
  await user.click(screen.getByRole('button', { name: 'Docs canvas' }))
  await user.click(screen.getByRole('button', { name: 'Pads de l’équipe' }))
  expect(screen.getByTestId('docs-inline-textarea')).toHaveValue('Production draft')
})

it('offers Cloud onboarding to an owner before the first workspace is created', async () => {
  const user = userEvent.setup()
  serve(notInitialisedWorkspace({ state: 'ready', reason: null }, true))
  renderScreen()
  await user.click(await screen.findByRole('button', { name: 'Configurer un espace' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Nom de l’espace' })).toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
})

it('keeps workspace management out of the channel list and opens it from menu commands', async () => {
  serve(readyWorkspace())
  renderScreen()
  const sidebar = await screen.findByRole('navigation', { name: 'Salons' })
  expect(within(sidebar).queryByText('Hébergement & Offre')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Configurer un espace' })).not.toBeInTheDocument()
  act(() => openWorkspaceCommand('hosting'))
  expect(screen.getByRole('dialog', { name: 'Hébergement & Offre' })).toBeInTheDocument()
})

it('opens the registered local demo with Docs and community access without a Matrix sign-in', async () => {
  const user = userEvent.setup()
  session.slug = 'vercelli'
  registerInteractiveDemo({ slug: 'vercelli', createStore: createLocalWorkspaceStore })
  serve(readyWorkspace())
  renderScreen()
  expect(await screen.findByTestId('espace-live')).toHaveTextContent('@ines:demo.invalid')
  expect(beginMatrixSignIn).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Ouvrir les messages' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Configurer un espace' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Docs canvas' }))
  expect(screen.getByRole('button', { name: 'Nouveau document' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Documentation développeur & API/ }))
  expect(screen.getByTestId('developer-docs-hub')).toBeInTheDocument()
})

it('puts community onboarding, connectors, Docs and persisted themes in the routed workspace', async () => {
  const user = userEvent.setup()
  session.slug = 'community'
  registerInteractiveDemo(communityDemo)
  serve(communityWorkspace())
  renderScreen()
  expect(await screen.findByTestId('espace-live')).toHaveTextContent('@member:community.kodera.io')
  expect(beginMatrixSignIn).not.toHaveBeenCalled()
  act(() => openWorkspaceCommand('extensions'))
  expect(screen.getByRole('dialog')).toHaveTextContent('Frame.io')
  await user.keyboard('{Escape}')
  act(() => openWorkspaceCommand('configure'))
  expect(screen.getByRole('dialog')).toHaveTextContent('Nom de l’espace')
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'Docs canvas' }))
  await user.click(screen.getByRole('button', { name: /Documentation développeur & API/ }))
  expect(screen.getByTestId('developer-docs-hub')).toBeInTheDocument()
  localStorage.removeItem(THEME_STORAGE_KEY)
})

it.each([
  ['preparing', () => notInitialisedWorkspace({ state: 'running', reason: null })],
  [
    'confirming ownership',
    () => notInitialisedWorkspace({ state: 'pending', reason: 'awaiting_owner_confirmation' }),
  ],
  ['failed', () => notInitialisedWorkspace({ state: 'failed', reason: 'realm_job_failed' })],
  ['not created', () => notInitialisedWorkspace({ state: 'ready', reason: null }, false)],
  ['ready without a Matrix session', readyWorkspace],
] as const)(
  'keeps menu actions functional when the workspace is %s',
  async (_state, makeWorkspace) => {
    const user = userEvent.setup()
    serve(makeWorkspace())
    renderScreen()
    await heading()
    for (const command of ['configure', 'extensions', 'hosting', 'studio', 'developer'] as const) {
      act(() => openWorkspaceCommand(command))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      if (command === 'developer')
        expect(screen.getByTestId('developer-docs-hub')).toBeInTheDocument()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
  }
)

it('keeps the developer menu command inside the live workspace canvas', async () => {
  session.slug = 'community'
  registerInteractiveDemo(communityDemo)
  serve(communityWorkspace())
  renderScreen()
  await screen.findByTestId('espace-live')
  act(() => openWorkspaceCommand('developer'))
  expect(screen.getByTestId('developer-docs-hub')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

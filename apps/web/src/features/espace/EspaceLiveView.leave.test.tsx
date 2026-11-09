// Leaving the workspace during a live call: the member is asked first, because the view's own
// call ends when the view goes away. Run inside a real router, so links, Back and programmatic
// navigation all meet the same question.
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  redirect,
  RouterProvider,
  useParams,
} from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { useChannelNavigation } from '../workspace/useChannelNavigation'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView, type AudioCallLike, type EspaceStoreLike } from './EspaceLiveView'
import type { CallSnapshot } from './audio/call'
import type { EspaceSnapshot } from './matrix/store'

const room = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  let connected: () => void = () => undefined
  const state = { value: 'disconnected' }
  return {
    handlers,
    state,
    connected: () => connected(),
    connect: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          connected = () => {
            state.value = 'connected'
            resolve()
          }
        })
    ),
    disconnect: vi.fn(async () => {
      state.value = 'disconnected'
    }),
    startAudio: vi.fn(async () => undefined),
    setMicrophoneEnabled: vi.fn(async () => undefined),
  }
})

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  class FakeRoom {
    readonly remoteParticipants = new Map()
    readonly localParticipant = {
      identity: '@me:acme.kodera.test|DEV1',
      permissions: { canPublish: true },
      setMicrophoneEnabled: room.setMicrophoneEnabled,
    }
    readonly canPlaybackAudio = true
    get state() {
      return room.state.value
    }
    connect = room.connect
    disconnect = room.disconnect
    startAudio = room.startAudio
    on(event: string, handler: (...args: unknown[]) => void) {
      let set = room.handlers.get(event)
      if (set === undefined) room.handlers.set(event, (set = new Set()))
      set.add(handler)
      return this
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      room.handlers.get(event)?.delete(handler)
      return this
    }
  }
  return { ...original, Room: FakeRoom }
})

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const GENERAL_ROOM = '!general:acme.kodera.test'
const ANNOUNCES = 'a1111111-1111-4111-8111-000000000002'
const ANNOUNCES_ROOM = '!announces:acme.kodera.test'
const STANDUP = 'a1111111-1111-4111-8111-000000000003'
const STANDUP_ROOM = '!standup:acme.kodera.test'

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-team',
      name: 'Team',
      template_key: 'team',
      channels: [
        {
          id: GENERAL,
          kind: 'text',
          name: 'Général',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          room_state: 'ready',
        },
        {
          id: ANNOUNCES,
          kind: 'text',
          name: 'Annonces',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          room_state: 'ready',
        },
        {
          id: STANDUP,
          kind: 'audio',
          name: 'Point quotidien',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

function store(status: EspaceSnapshot['status'] = 'live'): EspaceStoreLike {
  const summary = (roomId: string, name: string, kind: 'text' | 'audio') => ({
    roomId,
    name,
    alias: null,
    kind,
    unread: 0,
    mentions: 0,
    occupancy: null,
  })
  const snapshot: EspaceSnapshot = {
    status,
    channels: new Map([
      [GENERAL, { state: 'resolved', roomId: GENERAL_ROOM }],
      [ANNOUNCES, { state: 'resolved', roomId: ANNOUNCES_ROOM }],
      [STANDUP, { state: 'resolved', roomId: STANDUP_ROOM }],
    ]),
    rooms: [
      summary(GENERAL_ROOM, 'Général', 'text'),
      summary(ANNOUNCES_ROOM, 'Annonces', 'text'),
      summary(STANDUP_ROOM, 'Point quotidien', 'audio'),
    ],
    invites: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => '@me:acme.kodera.test',
    getTimeline: () => [],
    getThread: () => [],
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
    accessToken: () => 'tok-live',
    renewAccessToken: vi.fn(async () => 'tok-next'),
  }
}

// One store per organisation, as the session gives one: a new store would make a new call.
const stores = new Map<string, EspaceStoreLike>()
function storeFor(org: string): EspaceStoreLike {
  let found = stores.get(org)
  if (found === undefined) stores.set(org, (found = store()))
  return found
}

/** A call the test drives itself, in place of the view's own: its `leave` changes nothing. */
let injectedCall: AudioCallLike | undefined
function connectedCall(): AudioCallLike {
  const snapshot: CallSnapshot = {
    status: 'connected',
    roomId: STANDUP_ROOM,
    muted: false,
    deafened: false,
    listenOnly: false,
    speakers: [],
    participants: [],
    playbackBlocked: false,
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    setMuted: vi.fn(async () => undefined),
    setDeafened: vi.fn(async () => undefined),
    startAudio: vi.fn(async () => undefined),
  }
}

const SESSION = {
  baseUrl: 'https://acme.kodera.test',
  userId: '@me:acme.kodera.test',
  deviceId: 'DEV1',
  accessToken: 'tok-at-sign-in',
  refreshToken: 'ref-live',
  refresh: vi.fn(),
}

/** The workspace screen as the Console mounts it: the parent route owns it, channels draw nothing. */
function WorkspacePage() {
  const shown = useSyncExternalStore(subscribeToAuth, () => auth.viewShown)
  return shown ? <LiveWorkspace /> : <p>Espace est indisponible.</p>
}

function LiveWorkspace() {
  const { org } = useParams({ strict: false }) as { org: string }
  const { channelId } = useParams({ strict: false }) as { channelId?: string }
  const navigation = useChannelNavigation(org)
  return (
    <EspaceLiveView
      // One live workspace per organisation, as `WorkspaceScreen` keys it.
      key={org}
      org={org}
      organisationName="Acme SA"
      workspace={WORKSPACE}
      channelId={channelId}
      store={storeFor(org)}
      session={SESSION}
      {...(injectedCall === undefined ? {} : { call: injectedCall })}
      {...navigation}
    />
  )
}

/**
 * The Console's sign-in state, as the organisation's layout reads it: signed out, the layout is
 * replaced by a `<Navigate to="/login">` in the same commit that unmounts the workspace
 * (`AuthenticatedOrgLayout`, `src/app/org-route.tsx`). `loaderAuthed` is the same answer, read by
 * the route's `beforeLoad` instead, which redirects.
 */
const auth = {
  authed: true,
  loaderAuthed: true,
  // Whether the screen still draws the live view: an error state can replace it in place.
  viewShown: true,
  listeners: new Set<() => void>(),
}
function hideView() {
  auth.viewShown = false
  auth.listeners.forEach((listener) => listener())
}
function signOut() {
  auth.authed = false
  auth.listeners.forEach((listener) => listener())
}
function subscribeToAuth(listener: () => void) {
  auth.listeners.add(listener)
  return () => void auth.listeners.delete(listener)
}
function OrgLayout() {
  const authed = useSyncExternalStore(subscribeToAuth, () => auth.authed)
  return authed ? <Outlet /> : <Navigate to="/login" replace />
}

function makeRouter(history: RouterHistory) {
  const root = createRootRoute({ component: Outlet })
  const org = createRoute({
    getParentRoute: () => root,
    path: '$org',
    beforeLoad: () => {
      if (!auth.loaderAuthed) throw redirect({ to: '/login' })
    },
    component: OrgLayout,
  })
  const login = createRoute({
    getParentRoute: () => root,
    path: 'login',
    component: () => <h1>Connexion</h1>,
  })
  const workspace = createRoute({
    getParentRoute: () => org,
    path: 'workspace',
    component: WorkspacePage,
  })
  const index = createRoute({ getParentRoute: () => workspace, path: '/' })
  const channel = createRoute({ getParentRoute: () => workspace, path: '$channelId' })
  const people = createRoute({
    getParentRoute: () => org,
    path: 'people',
    component: () => <h1>Membres</h1>,
  })
  return createRouter({
    routeTree: root.addChildren([
      org.addChildren([workspace.addChildren([index, channel]), people]),
      login,
    ]),
    history,
  })
}

async function mount(path = `/acme/workspace/${GENERAL}`) {
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }))
  render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { level: 1, name: /Général/ })
  return router
}

/** Joins the audio room and lets the media connection come up. */
async function joinCall(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Rejoindre Point quotidien/ }))
  await waitFor(() => expect(room.connect).toHaveBeenCalled())
  await act(async () => {
    room.connected()
    await Promise.resolve()
  })
  await screen.findByRole('region', { name: 'Appel en cours' })
}

function pathname(router: ReturnType<typeof makeRouter>) {
  return router.state.location.pathname
}

beforeEach(() => {
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: 'wss://rtc.acme.kodera.test',
            token: 'lk.jwt',
            listen_only: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  stores.clear()
  injectedCall = undefined
  auth.authed = true
  auth.loaderAuthed = true
  auth.viewShown = true
  room.handlers.clear()
  room.state.value = 'disconnected'
})

describe('leaving the workspace during a live call', () => {
  it('asks before another Console page; staying keeps the address and the call', async () => {
    const user = userEvent.setup()
    const router = await mount()
    await joinCall(user)

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))

    const dialog = await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    expect(
      within(dialog).getByText(
        'Quitter cette page mettra fin à votre appel. Les autres personnes restent dans le salon.'
      )
    ).toBeVisible()
    // Opening reads the question first, never lands on the action that ends the call.
    expect(within(dialog).getByRole('heading', { name: 'Quitter l’appel ?' })).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Rester dans l’appel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(pathname(router)).toBe(`/acme/workspace/${GENERAL}`)
    expect(screen.queryByRole('heading', { name: 'Membres' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Appel en cours' })).toBeVisible()
    expect(room.disconnect).not.toHaveBeenCalled()
    // The held navigation is over: the composer is not left locked as if one were under way.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Message dans/ })).toBeEnabled()
    )
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeEnabled()
  })

  it('Escape stays too', async () => {
    const user = userEvent.setup()
    const router = await mount()
    await joinCall(user)

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))
    await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(pathname(router)).toBe(`/acme/workspace/${GENERAL}`)
    expect(room.disconnect).not.toHaveBeenCalled()
  })

  it('confirming leaves: the page changes and the call is left', async () => {
    const user = userEvent.setup()
    const router = await mount()
    await joinCall(user)

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))
    const dialog = await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    await user.click(within(dialog).getByRole('button', { name: 'Quitter l’appel' }))

    await screen.findByRole('heading', { name: 'Membres' })
    expect(pathname(router)).toBe('/acme/people')
    await waitFor(() => expect(room.disconnect).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Appel en cours' })).toBeNull()
  })

  it('asks on a switch to another organisation', async () => {
    const user = userEvent.setup()
    const router = await mount()
    await joinCall(user)

    act(() => void router.navigate({ to: '/$org/workspace', params: { org: 'globex' } }))
    const dialog = await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    await user.click(within(dialog).getByRole('button', { name: 'Rester dans l’appel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(pathname(router)).toBe(`/acme/workspace/${GENERAL}`)
    expect(room.disconnect).not.toHaveBeenCalled()
  })

  it('does not ask on a channel switch inside the workspace: the screen and the call stay', async () => {
    const user = userEvent.setup()
    const router = await mount()
    await joinCall(user)

    await user.click(screen.getByRole('link', { name: /Annonces/ }))
    await screen.findByRole('heading', { level: 1, name: /Annonces/ })
    await waitFor(() => expect(pathname(router)).toBe(`/acme/workspace/${ANNOUNCES}`))

    act(() => void router.navigate({ to: '/$org/workspace', params: { org: 'acme' } }))
    await waitFor(() => expect(pathname(router)).toBe('/acme/workspace'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: 'Appel en cours' })).toBeVisible()
    expect(room.disconnect).not.toHaveBeenCalled()
  })

  // « Se reconnecter » sends the whole page to the sign-in on purpose, and a member signed out of
  // the homeserver is out of its calls already: nothing is left to ask about.
  it('does not ask once the member is signed out of the workspace, whatever the call says', async () => {
    injectedCall = connectedCall()
    stores.set('acme', store('signed-out'))
    const router = await mount()
    expect(screen.getByText('Votre session de messagerie a expiré.')).toBeVisible()

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))

    await screen.findByRole('heading', { name: 'Membres' })
    expect(pathname(router)).toBe('/acme/people')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks with a call that is live, signed in', async () => {
    injectedCall = connectedCall()
    const router = await mount()

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))

    await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    expect(pathname(router)).toBe(`/acme/workspace/${GENERAL}`)
  })

  // The layout swaps the workspace for a `<Navigate>` in one commit; its navigation comes before
  // the blocker is removed, and must not meet a guard whose dialog can no longer be drawn.
  it('lets a Console sign-out during a live call reach the sign-in page', async () => {
    injectedCall = connectedCall()
    const router = await mount()

    act(() => signOut())

    await screen.findByRole('heading', { name: 'Connexion' })
    expect(pathname(router)).toBe('/login')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lets an authentication redirect from a route reach the sign-in page', async () => {
    injectedCall = connectedCall()
    const router = await mount()

    auth.loaderAuthed = false
    await act(() => router.invalidate())

    await screen.findByRole('heading', { name: 'Connexion' })
    expect(pathname(router)).toBe('/login')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the question when the call ends while it is asked, and stays', async () => {
    const user = userEvent.setup()
    const router = await mount()
    await joinCall(user)

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))
    await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    await act(async () => {
      for (const handler of room.handlers.get('disconnected') ?? []) handler()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(pathname(router)).toBe(`/acme/workspace/${GENERAL}`)
    expect(screen.queryByRole('region', { name: 'Appel en cours' })).toBeNull()
  })

  it('does not ask when there is no live call', async () => {
    const router = await mount()

    act(() => void router.navigate({ to: '/$org/people', params: { org: 'acme' } }))

    await screen.findByRole('heading', { name: 'Membres' })
    expect(pathname(router)).toBe('/acme/people')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// Back, Forward and the tab itself belong to the browser: its own history, not a memory one.
describe("in the browser's own history", () => {
  let history: RouterHistory | undefined
  afterEach(() => {
    history?.destroy()
    history = undefined
    window.history.replaceState(null, '', '/')
  })

  function beforeUnload() {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it("raises the browser's own prompt only while the call is live", async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', `/acme/workspace/${GENERAL}`)
    history = createBrowserHistory()
    render(<RouterProvider router={makeRouter(history)} />)
    await screen.findByRole('heading', { level: 1, name: /Général/ })

    expect(beforeUnload()).toBe(false)

    await joinCall(user)
    expect(beforeUnload()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Quitter' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Appel en cours' })).toBeNull())
    expect(beforeUnload()).toBe(false)
  })

  it('asks on Back; staying returns to the workspace with the call', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/acme/people')
    history = createBrowserHistory()
    const router = makeRouter(history)
    render(<RouterProvider router={router} />)
    await screen.findByRole('heading', { name: 'Membres' })
    act(() => void router.navigate({ to: '/$org/workspace', params: { org: 'acme' } }))
    await screen.findByRole('heading', { level: 1, name: /Général/ })
    await joinCall(user)

    act(() => window.history.back())
    const dialog = await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    await user.click(within(dialog).getByRole('button', { name: 'Rester dans l’appel' }))

    await waitFor(() => expect(window.location.pathname).toBe('/acme/workspace'))
    expect(screen.queryByRole('heading', { name: 'Membres' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Appel en cours' })).toBeVisible()
    expect(room.disconnect).not.toHaveBeenCalled()
  })

  // The view can go while it asks, without any navigation: the held one is then given up, so the
  // address goes back to the page still on screen.
  it('gives up a held Back when the view goes while it asks', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/acme/people')
    history = createBrowserHistory()
    const router = makeRouter(history)
    render(<RouterProvider router={router} />)
    await screen.findByRole('heading', { name: 'Membres' })
    act(() => void router.navigate({ to: '/$org/workspace', params: { org: 'acme' } }))
    await screen.findByRole('heading', { level: 1, name: /Général/ })
    await joinCall(user)

    act(() => window.history.back())
    await screen.findByRole('dialog', { name: 'Quitter l’appel ?' })
    act(() => hideView())

    await waitFor(() => expect(window.location.pathname).toBe('/acme/workspace'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Espace est indisponible.')).toBeVisible()
    expect(router.state.location.pathname).toBe('/acme/workspace')
  })
})

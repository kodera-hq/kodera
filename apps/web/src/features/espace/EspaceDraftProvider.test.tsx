import { StrictMode, useLayoutEffect, useState, type ReactNode } from 'react'
import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { User, UserManager } from 'oidc-client-ts'
import { expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { setTokenProvider } from '../../api/client'
import {
  clearMatrixSession,
  getMatrixRegistrationStamp,
  getMatrixSession,
  registerMatrixSession,
  subscribeMatrixSession,
  type MatrixSession,
} from '../../auth/matrix'
import { authAdapter } from '../../auth/oidc'
import { orgRoute } from '../../app/org-route'
import { AppProviders } from '../../app/providers'
import { queryClient } from '../../app/queryClient'
import { rootRoute } from '../../app/root-route'
import { peopleRoute } from '../people/routes'
import { workspaceChannelRoute, workspaceIndexRoute, workspaceRoute } from '../workspace/routes'
import type { Workspace } from '../workspace/workspace'
import { EspaceStore, matrixClientForTests } from './matrix/store'
import type { EspaceSnapshot } from './matrix/store'
import { AuthProvider, useAuthLifetime, type AuthLifetime } from '../../auth/AuthProvider'
import type { AuthAdapter, AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { EspaceDraftProvider, useEspaceDraftMemory, type DraftLease } from './EspaceDraftProvider'
import { EspaceLiveView, type EspaceStoreLike } from './EspaceLiveView'
import type { MessageView } from './matrix/timeline'
import { createCurrentUserLoader } from '../../app/currentUser'
import { CallController } from './audio/call'
import * as matrixLifetime from '../../auth/matrix'

const controlledAudio = vi.hoisted(() => {
  let observe = (work: Promise<void>) => work
  const media = { readyState: 'live', enabled: true, stop: vi.fn() }
  media.stop.mockImplementation(() => {
    media.readyState = 'ended'
  })
  const track = {
    mediaStreamTrack: media,
    isMuted: false,
    stop: vi.fn(() => media.stop()),
    mute: vi.fn(() =>
      observe(
        Promise.resolve().then(() => {
          track.isMuted = true
        })
      )
    ),
  }
  return {
    media,
    track,
    observe: (work: Promise<void>) => observe(work),
    setObserver: (next: typeof observe) => {
      observe = next
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    enable: vi.fn(),
    handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
  }
})

vi.mock('livekit-client', async (original) => {
  const actual = await original<Record<string, unknown>>()
  class ControlledRoom {
    state = 'disconnected'
    canPlaybackAudio = true
    remoteParticipants = new Map()
    localParticipant = {
      identity: '@draft-subject:acme-chat.kodera.test|DRAFT',
      permissions: { canPublish: true },
      getTrackPublication: () => ({ track: controlledAudio.track }),
      setMicrophoneEnabled: (enabled: boolean) =>
        controlledAudio.observe(
          Promise.resolve().then(() => {
            controlledAudio.enable(enabled)
          })
        ),
      unpublishTrack: () => controlledAudio.observe(Promise.resolve()),
    }
    connect() {
      return controlledAudio.observe(
        Promise.resolve().then(() => {
          controlledAudio.connect()
          this.state = 'connected'
        })
      )
    }
    disconnect() {
      return controlledAudio.observe(
        Promise.resolve().then(() => {
          controlledAudio.disconnect()
          this.state = 'disconnected'
        })
      )
    }
    startAudio() {
      return controlledAudio.observe(Promise.resolve())
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const listeners = controlledAudio.handlers.get(event) ?? new Set()
      listeners.add(handler)
      controlledAudio.handlers.set(event, listeners)
      return this
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      controlledAudio.handlers.get(event)?.delete(handler)
      return this
    }
  }
  return { ...actual, Room: ControlledRoom }
})

// Preserve the actual organisation boundary, loader, providers, routes and view.
// The presentation frame does not participate in draft ownership.
vi.mock('../../app/Shell', () => ({
  Shell: ({ children }: { children: ReactNode }) => <main id="main-content">{children}</main>,
}))

const ORG = '11111111-1111-4111-8111-111111111111'
const CHANNEL = 'a1111111-1111-4111-8111-000000000001'
const SUBJECT = 'draft-subject'
// The tenant's slug, and so its homeserver's server name, differ from the organisation's
// (`acme-sa`, its realm and its address): the session is checked against the tenant's
// (quick-workspace SPEC §2.1, lead ruling 11-06).
const TENANT_SLUG = 'acme-chat'
const SERVER = `${TENANT_SLUG}.kodera.test`
const MATRIX_USER = `@${SUBJECT}:${SERVER}`
const ROOM = `!general:${SERVER}`
const HOMESERVER = `https://matrix.${SERVER}`
const CORE = 'https://core.draft.test/api/v1/d01'
const ISSUER = 'https://id.example.test/realms/acme-sa'
const WORKSPACE_PATH = `/acme-sa/workspace/${CHANNEL}`
const DRAFT = 'D01: an unsent draft for the general room'

const workspace: Workspace = {
  organisation_id: ORG,
  id: '22222222-2222-4222-8222-222222222222',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  categories: [
    {
      id: 'cat-general',
      name: 'General',
      template_key: null,
      channels: [
        {
          id: CHANNEL,
          kind: 'text',
          name: 'General',
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

const me = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'draft-member@example.test',
  display_name: 'Draft member',
  locale: 'fr',
  staff: false,
  identities: [
    {
      id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
      issuer: ISSUER,
      realm: 'acme-sa',
      subject: SUBJECT,
      email: 'draft-member@example.test',
      mfa_enrolled: true,
    },
  ],
  organisations: [
    {
      identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
      membership_id: '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c',
      state: 'active',
      role: 'org_owner',
      organisation: {
        id: ORG,
        slug: 'acme-sa',
        name: 'Acme',
        realm: 'acme-sa',
      },
    },
  ],
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function protocol() {
  const unexpected: string[] = []
  const polls = new Set<() => void>()
  const pending = new Set<Promise<Response>>()
  const writes: string[] = []
  /** « Typing » notices: no draft text, only whether the member types (11-workspace.md). */
  const typing: unknown[] = []
  let meReads = 0
  let initialSyncs = 0

  const stateEvent = (type: string, stateKey: string, content: Record<string, unknown>) => ({
    event_id: `$draft-${type}-${stateKey}`,
    type,
    state_key: stateKey,
    sender: MATRIX_USER,
    origin_server_ts: 1,
    content,
  })

  async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input))
    const method = init?.method ?? request?.method ?? 'GET'
    const path = decodeURIComponent(url.pathname)
    const signal = init?.signal ?? request?.signal
    const headers = new Headers(init?.headers ?? request?.headers)

    if (url.origin === new URL(CORE).origin) {
      const corePath = path.slice(new URL(CORE).pathname.length)
      expect(headers.get('Authorization')).toBe('Bearer core-d01')
      if (method === 'GET' && corePath === '/me') {
        meReads += 1
        return json(me)
      }
      if (method === 'GET' && corePath === `/organisations/${ORG}/workspace`) {
        return json(workspace)
      }
      // The workspace's tenant: its slug names the homeserver (`SERVER`), and it is open.
      if (method === 'GET' && corePath === `/organisations/${ORG}/tenants`) {
        return json({
          data: [{ id: 'tenant-d01', slug: TENANT_SLUG, status: 'active' }],
          next_cursor: null,
          has_more: false,
        })
      }
      if (method === 'GET' && corePath === `/organisations/${ORG}/memberships`) {
        return json({ data: [], next_cursor: null, has_more: false })
      }
      if (method === 'GET' && corePath === `/organisations/${ORG}/memberships/count`) {
        return json({ count: 0 })
      }
      if (method === 'GET' && corePath === `/organisations/${ORG}/invitations`) {
        return json({ data: [], next_cursor: null, has_more: false })
      }
    }

    if (url.origin === HOMESERVER) {
      // No `org.matrix.msc4143` in `unstable_features`, as on our Synapse: matrix-js-sdk 45 then
      // never asks for RTC transports, and `cachedRtcTransports` stays unset.
      if (method === 'GET' && path === '/_matrix/client/versions') {
        return json({ versions: ['v1.11'] })
      }
      if (method === 'GET' && path === '/_matrix/client/v3/capabilities') {
        return json({ capabilities: {} })
      }
      if (method === 'GET' && path === '/_matrix/client/v3/pushrules/') {
        return json({ global: {} })
      }
      if (method === 'POST' && path === `/_matrix/client/v3/user/${MATRIX_USER}/filter`) {
        return json({ filter_id: 'draft-filter' })
      }
      if (
        method === 'GET' &&
        path === `/_matrix/client/v3/directory/room/#kodera-ch-${CHANNEL}:${SERVER}`
      ) {
        return json({ room_id: ROOM, servers: [SERVER] })
      }
      if (method === 'GET' && path === '/_matrix/client/v3/sync') {
        expect(headers.get('Authorization')).toBe('Bearer matrix-d01')
        if (!url.searchParams.has('since')) {
          initialSyncs += 1
          return json({
            next_batch: `draft-sync-${initialSyncs}`,
            rooms: {
              join: {
                [ROOM]: {
                  state: {
                    events: [
                      stateEvent('m.room.create', '', {
                        creator: MATRIX_USER,
                        room_version: '10',
                      }),
                      stateEvent('m.room.member', MATRIX_USER, { membership: 'join' }),
                      stateEvent('m.room.name', '', { name: 'General' }),
                    ],
                  },
                  timeline: { events: [], limited: false, prev_batch: 'draft-history' },
                  unread_notifications: {
                    notification_count: 0,
                    highlight_count: 0,
                  },
                },
              },
            },
          })
        }
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            polls.delete(abort)
            signal?.removeEventListener('abort', abort)
            reject(new DOMException('Draft test sync stopped', 'AbortError'))
          }
          polls.add(abort)
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
      // The log has no height in jsdom, so it pages back at once: there is nothing older.
      if (method === 'GET' && path === `/_matrix/client/v3/rooms/${ROOM}/messages`) {
        return json({ start: url.searchParams.get('from'), chunk: [] })
      }
    }

    if (method === 'PUT' && path === `/_matrix/client/v3/rooms/${ROOM}/typing/${MATRIX_USER}`) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      typing.push(body)
      // What the notice may carry, and nothing of the draft.
      if (Object.keys(body).some((key) => key !== 'typing' && key !== 'timeout'))
        unexpected.push(`typing notice carrying ${JSON.stringify(body)}`)
      return Promise.resolve(json({}))
    }
    if (method !== 'GET') writes.push(`${method} ${url.origin}${path}`)
    unexpected.push(`${method} ${url.origin}${path}`)
    throw new Error('Unexpected D01 protocol request')
  }

  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const result = answer(input, init)
    pending.add(result)
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result)
    )
    return result
  })

  return {
    fetch,
    unexpected,
    polls,
    pending,
    writes,
    typing,
    meReads: () => meReads,
    initialSyncs: () => initialSyncs,
  }
}

it('returns_channel_draft_after_module_navigation', async () => {
  const network = protocol()
  const stores: EspaceStore[] = []
  const starts: Promise<void>[] = []
  const stopped: EspaceStore[] = []
  const originalStart = EspaceStore.prototype.start
  const originalStop = EspaceStore.prototype.stop
  const previousDefaults = queryClient.getDefaultOptions()
  const previousLanguage = i18n.language
  let unmount: (() => void) | undefined
  let primaryFailure: { error: unknown } | undefined
  const cleanupFailures: Error[] = []
  const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

  try {
    vi.stubEnv('VITE_CORE_API_URL', CORE)
    vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    vi.stubEnv('VITE_ESPACE_DEV_HOMESERVER', '')
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_ENABLE_MSW', '0')
    vi.stubGlobal('fetch', network.fetch)
    vi.stubGlobal(
      'matchMedia',
      vi.fn((media: string) => ({
        media,
        matches: false,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => true,
      }))
    )
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
    vi.spyOn(UserManager.prototype, 'removeUser').mockResolvedValue()
    const now = Math.floor(Date.now() / 1000)
    vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(
      new User({
        access_token: 'core-d01',
        token_type: 'Bearer',
        expires_at: now + 300,
        profile: { iss: ISSUER, sub: SUBJECT, aud: 'console', iat: now, exp: now + 300 },
      })
    )

    queryClient.clear()
    queryClient.setDefaultOptions({
      ...previousDefaults,
      queries: { ...previousDefaults.queries, retry: false },
    })
    await i18n.changeLanguage('fr')
    await authAdapter.signIn('acme-sa')
    await authAdapter.handleCallback()
    // Bind the same actual adapter before the first router read; AppProviders
    // installs this same getter through the real AuthProvider effect.
    setTokenProvider(() => authAdapter.getAccessToken())

    const matrixSession = {
      baseUrl: HOMESERVER,
      userId: MATRIX_USER,
      deviceId: 'DRAFT-D01',
      accessToken: 'matrix-d01',
      refreshToken: 'matrix-refresh-d01',
      refresh: vi.fn(async () => {
        throw new Error('Unexpected D01 token refresh')
      }),
    }
    registerMatrixSession(matrixSession)

    vi.spyOn(EspaceStore.prototype, 'start').mockImplementation(function (this: EspaceStore) {
      if (!stores.includes(this)) stores.push(this)
      const started = originalStart.call(this)
      starts.push(started)
      return started
    })
    vi.spyOn(EspaceStore.prototype, 'stop').mockImplementation(function (
      this: EspaceStore,
      status
    ) {
      stopped.push(this)
      return originalStop.call(this, status)
    })

    const router = createRouter({
      routeTree: rootRoute.addChildren([
        orgRoute.addChildren([
          workspaceRoute.addChildren([workspaceIndexRoute, workspaceChannelRoute]),
          peopleRoute,
        ]),
      ]),
      history: createMemoryHistory({ initialEntries: [WORKSPACE_PATH] }),
    })
    const view = render(
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    )
    unmount = view.unmount
    const user = userEvent.setup()

    await waitFor(
      () => {
        expect(stores).toHaveLength(1)
        const first = stores[0]!
        expect(first.getSnapshot().status).toBe('live')
        expect(first.getSnapshot().channels.get(CHANNEL)).toEqual({
          state: 'resolved',
          roomId: ROOM,
        })
        const client = matrixClientForTests(first)
        expect(client.getRoom(ROOM)?.getMyMembership()).toBe('join')
        expect(client.getCachedCapabilities()).toEqual({})
        expect(client.cachedRtcTransports.get()).toBeUndefined()
        expect(network.polls.size).toBe(1)
      },
      { timeout: 10_000 }
    )
    expect(network.meReads()).toBeGreaterThan(0)
    expect(authAdapter.getSnapshot().user?.identity?.subject).toBe(SUBJECT)
    expect(getMatrixSession()).toBe(matrixSession)

    const firstStore = stores[0]!
    const composer = await screen.findByRole('combobox')
    await user.type(composer, DRAFT)
    expect(composer).toHaveValue(DRAFT)
    expect(network.writes).toEqual([])
    // The room is told the member types, and nothing of what: the fixture refuses any other key.
    await vi.waitFor(() => expect(network.typing).toContainEqual({ typing: true, timeout: 10_000 }))
    expect(network.unexpected).toEqual([])

    await act(async () => {
      await router.navigate({ href: '/acme-sa/people' })
    })
    await screen.findByRole('heading', {
      level: 1,
      name: i18n.t('console.people.list.title'),
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/acme-sa/people')
      expect(router.state.status).toBe('idle')
      expect(firstStore.getSnapshot().status).toBe('stopped')
      expect(stopped).toContain(firstStore)
      expect(network.polls.size).toBe(0)
      expect(queryClient.isFetching()).toBe(0)
    })
    // Leaving the module stops the store, and the room stops seeing the member type.
    await vi.waitFor(() => expect(network.typing.at(-1)).toEqual({ typing: false }))
    expect(
      network.typing.filter((notice) => JSON.stringify(notice) === '{"typing":false}')
    ).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getMatrixSession()).toBe(matrixSession)

    act(() => router.history.back())
    await waitFor(
      () => {
        expect(router.state.location.pathname).toBe(WORKSPACE_PATH)
        expect(router.state.status).toBe('idle')
        expect(stores).toHaveLength(2)
        expect(stores[1]).not.toBe(firstStore)
        expect(stores[1]!.getSnapshot().status).toBe('live')
        expect(stores[1]!.getSnapshot().channels.get(CHANNEL)).toEqual({
          state: 'resolved',
          roomId: ROOM,
        })
        expect(matrixClientForTests(stores[1]!).getCachedCapabilities()).toEqual({})
        expect(matrixClientForTests(stores[1]!).cachedRtcTransports.get()).toBeUndefined()
        expect(network.polls.size).toBe(1)
      },
      { timeout: 10_000 }
    )
    expect(network.initialSyncs()).toBe(2)
    expect(getMatrixSession()).toBe(matrixSession)
    expect(network.writes).toEqual([])
    expect(network.unexpected).toEqual([])
    expect(await screen.findByRole('combobox'), 'DraftLostAcrossModuleNavigation').toHaveValue(
      DRAFT
    )
  } catch (error) {
    primaryFailure = { error }
  } finally {
    async function attemptCleanup(step: string, cleanup: () => unknown) {
      try {
        await cleanup()
      } catch (error) {
        cleanupFailures.push(
          new Error(`D01 cleanup ${step}: ${messageOf(error)}`, { cause: error })
        )
      }
    }

    await attemptCleanup('unmount', () => act(() => unmount?.()))
    for (const [index, store] of stores.entries()) {
      await attemptCleanup(`stop store ${index}`, () => act(() => store.stop()))
    }
    await attemptCleanup('settle every store start', () =>
      act(async () => {
        const settlements = await Promise.allSettled(starts)
        for (const [index, settlement] of settlements.entries()) {
          if (settlement.status === 'rejected') {
            cleanupFailures.push(
              new Error(`D01 cleanup start ${index}: ${messageOf(settlement.reason)}`, {
                cause: settlement.reason,
              })
            )
          }
        }
      })
    )
    await attemptCleanup('cancel queries', () =>
      act(async () => {
        await queryClient.cancelQueries()
      })
    )
    await attemptCleanup('drain observed protocol work', () =>
      waitFor(
        () => {
          expect({ polls: network.polls.size, pending: network.pending.size }).toEqual({
            polls: 0,
            pending: 0,
          })
        },
        { timeout: 5_000 }
      )
    )
    await attemptCleanup('clear Matrix session', () => act(() => clearMatrixSession()))
    await attemptCleanup('sign out SDK', () =>
      act(async () => {
        await authAdapter.signOut()
      })
    )
    await attemptCleanup('clear bearer provider', () => setTokenProvider(() => undefined))
    await attemptCleanup('clear query cache', () => act(() => queryClient.clear()))
    await attemptCleanup('restore query defaults', () => {
      queryClient.setDefaultOptions(previousDefaults)
    })
    await attemptCleanup('restore language', async () => {
      if (i18n.language !== previousLanguage) {
        await act(async () => {
          await i18n.changeLanguage(previousLanguage)
        })
      }
    })
    await attemptCleanup('restore mocks', () => vi.restoreAllMocks())
    await attemptCleanup('restore globals', () => vi.unstubAllGlobals())
    await attemptCleanup('restore environment', () => vi.unstubAllEnvs())
  }

  if (primaryFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure.error, ...cleanupFailures],
        `D01 primary failure: ${messageOf(primaryFailure.error)}; cleanup also failed`,
        { cause: primaryFailure.error }
      )
    }
    throw primaryFailure.error
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'D01 cleanup failed')
  }
}, 30_000)

// These twelve cases compose the real provider/dispatcher, current-user loader,
// router, controls and draft gateway. The injected store is the supported view
// seam; D01 above separately binds the real Matrix SDK/store protocol.
const SECOND_CHANNEL = 'a1111111-1111-4111-8111-000000000002'
const AUDIO_CHANNEL = 'a1111111-1111-4111-8111-000000000003'
const SECOND_ROOM = `!second:${SERVER}`
const AUDIO_ROOM = `!audio:${SERVER}`
const composedWorkspace: Workspace = {
  ...workspace,
  uncategorised_channels: [
    { ...workspace.categories[0]!.channels[0]!, id: SECOND_CHANNEL, name: 'Second' },
    { ...workspace.categories[0]!.channels[0]!, id: AUDIO_CHANNEL, name: 'Audio', kind: 'audio' },
  ],
}
const message: MessageView = {
  key: '$first',
  eventId: '$first',
  sender: MATRIX_USER,
  body: 'Original message',
  ts: 1,
  edited: false,
  redacted: false,
  delivery: 'sent',
  replyTo: null,
  reactions: [],
}

function composedAdapter() {
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    user: { realm: 'acme-sa', identity: { issuer: ISSUER, subject: SUBJECT } },
    generation: 1,
    credentialGeneration: 1,
  }
  let usable = true
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  const adapter: AuthAdapter = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getAccessToken: () =>
      usable && snapshot.status !== 'unauthenticated'
        ? `core-${snapshot.credentialGeneration}`
        : undefined,
    getExpiresAt: () => undefined,
    getUser: () => snapshot.user,
    restoreSession: async () => usable && snapshot.status === 'ready',
    renew: async () => usable,
    onRenewed: () => () => {},
    onRenewalFailed: () => () => {},
    onExpiring: () => () => {},
    signIn: async () => {},
    handleCallback: async () => 'interactive',
    signOut: async () => {
      usable = false
      snapshot = {
        ...snapshot,
        status: 'unauthenticated',
        user: undefined,
        generation: snapshot.generation + 1,
      }
      notify()
    },
  }
  return {
    adapter,
    listeners,
    notify,
    setUsable: (value: boolean) => {
      usable = value
    },
    set: (patch: Partial<AuthSessionSnapshot>, send = true) => {
      snapshot = { ...snapshot, ...patch }
      if (send) notify()
    },
  }
}

function composedStore(
  viewer = MATRIX_USER,
  audio = false,
  observe: (work: Promise<void>) => Promise<void> = (work) => work
) {
  const snapshot: EspaceSnapshot = {
    status: 'live',
    invites: [],
    channels: new Map([
      [CHANNEL, { state: 'resolved', roomId: ROOM }],
      [SECOND_CHANNEL, { state: 'resolved', roomId: SECOND_ROOM }],
      [AUDIO_CHANNEL, { state: 'resolved', roomId: AUDIO_ROOM }],
    ]),
    rooms: [ROOM, SECOND_ROOM, AUDIO_ROOM].map((roomId) => ({
      roomId,
      name: roomId,
      alias: '',
      kind: roomId === AUDIO_ROOM ? ('audio' as const) : ('text' as const),
      unread: 0,
      mentions: 0,
      occupancy: null,
    })),
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    getUserId: () => viewer,
    getTimeline: (roomId: string) =>
      roomId === ROOM
        ? [message, { ...message, key: '$other', eventId: '$other', body: 'Other root' }]
        : [],
    getThread: () => [],
    send: vi.fn<EspaceStoreLike['send']>(() => observe(Promise.resolve())),
    edit: vi.fn<EspaceStoreLike['edit']>(() => observe(Promise.resolve())),
    remove: vi.fn<EspaceStoreLike['remove']>(() => observe(Promise.resolve())),
    toggleReaction: vi.fn<EspaceStoreLike['toggleReaction']>(() => observe(Promise.resolve())),
    resend: vi.fn<NonNullable<EspaceStoreLike['resend']>>(() => observe(Promise.resolve())),
    ...(audio
      ? { accessToken: () => 'matrix-composed', renewAccessToken: async () => 'matrix-composed' }
      : {}),
  } satisfies EspaceStoreLike
  return store
}

let composedCoreSequence = 0

async function composedHarness(
  options: {
    strict?: boolean
    audio?: boolean
    reentrantRecovery?: boolean
    reentrantClear?: boolean
  } = {}
) {
  const coreUrl = `${CORE}/composed-${++composedCoreSequence}`
  const auth = composedAdapter()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const load = createCurrentUserLoader(auth.adapter, client)
  const session: MatrixSession = {
    baseUrl: HOMESERVER,
    userId: MATRIX_USER,
    deviceId: 'DRAFT-COMPOSED',
    accessToken: 'matrix-composed',
    refreshToken: 'refresh-composed',
    refresh: async () => {
      throw new Error('Unexpected composed refresh')
    },
  }
  let accepted: Awaited<ReturnType<typeof load>>
  let responseMe = me
  let releaseMe: (() => void) | undefined
  let heldMe: Promise<void> | undefined
  const requests = new Set<Promise<Response>>()
  const navigations: Promise<void>[] = []
  const pendingNavigations = new Set<Promise<void>>()
  const trackNavigation = (navigation: Promise<void>) => {
    navigations.push(navigation)
    pendingNavigations.add(navigation)
    void navigation.then(
      () => pendingNavigations.delete(navigation),
      () => pendingNavigations.delete(navigation)
    )
    return navigation
  }
  const operations = new Set<Promise<void>>()
  const operationFailures: unknown[] = []
  const protocolFailures: unknown[] = []
  const controllers = new Set<CallController>()
  const activeLeases = new Set<DraftLease>()
  const activeSubscriptions = new Set<object>()
  let issued = 0
  let settled = 0
  const observeOperation = (work: Promise<void>) => {
    issued += 1
    operations.add(work)
    void work.then(
      () => {
        settled += 1
        operations.delete(work)
      },
      (error: unknown) => {
        settled += 1
        operations.delete(work)
        operationFailures.push(error)
      }
    )
    return work
  }
  const coreCallbackCounts: number[] = []
  let readClears = () => 0
  const previousLanguage = i18n.language
  let unmount: (() => void) | undefined
  let flushPendingNavigation: (() => Promise<void>) | undefined
  let closed = false
  const close = async () => {
    closed = true
    const failures: unknown[] = []
    const attempt = async (fn: () => unknown) => {
      try {
        await fn()
      } catch (error) {
        failures.push(error)
      }
    }
    heldMe = undefined
    releaseMe?.()
    releaseMe = undefined
    await attempt(() => client.cancelQueries())
    if (
      pendingNavigations.size > 0 &&
      unmount !== undefined &&
      flushPendingNavigation !== undefined
    ) {
      await attempt(async () => {
        act(() => {
          void flushPendingNavigation?.()
        })
        await waitFor(() => expect(pendingNavigations.size).toBe(0))
      })
    }
    await attempt(() => act(() => unmount?.()))
    await attempt(async () => {
      expect(pendingNavigations.size).toBe(0)
      const settled = await Promise.allSettled(navigations)
      const failed = settled.filter((result) => result.status === 'rejected')
      if (failed.length > 0)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Held navigation cleanup failed'
        )
    })
    await attempt(async () => {
      while (requests.size > 0 || operations.size > 0)
        await Promise.allSettled([...requests, ...operations])
      expect(protocolFailures).toEqual([])
      expect(operationFailures).toEqual([])
      expect(issued).toBe(settled)
    })
    await attempt(() => {
      expect(requests.size).toBe(0)
      expect(auth.listeners.size).toBe(0)
      expect(activeLeases.size).toBe(0)
      expect(activeSubscriptions.size).toBe(0)
      expect(
        [...controllers].every((controller) => controller.getSnapshot().status === 'idle')
      ).toBe(true)
      expect(
        [...controlledAudio.handlers.values()].every((listeners) => listeners.size === 0)
      ).toBe(true)
    })
    await attempt(() => act(() => clearMatrixSession()))
    await attempt(() => {
      client.clear()
      setTokenProvider(() => undefined)
    })
    await attempt(() =>
      act(async () => {
        await i18n.changeLanguage(previousLanguage)
      })
    )
    await attempt(() => vi.restoreAllMocks())
    controlledAudio.setObserver((work) => work)
    await attempt(() => vi.unstubAllGlobals())
    await attempt(() => vi.unstubAllEnvs())
    if (failures.length) throw new AggregateError(failures, 'Composed draft cleanup failed')
  }
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const work = (async () => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${coreUrl}/me`) {
        expect(
          new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
            'Authorization'
          )
        ).toBe(`Bearer ${auth.adapter.getAccessToken()}`)
        if (heldMe !== undefined) await heldMe
        return json(responseMe)
      }
      if (options.audio && url === `${HOMESERVER}/_kodera/rooms/token`) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ room_id: AUDIO_ROOM })
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer matrix-composed')
        return json({
          url: `wss://rtc.${SERVER}`,
          token: 'controlled-call',
          listen_only: false,
        })
      }
      throw new Error('Unexpected composed protocol request')
    })()
    requests.add(work)
    void work.then(
      () => requests.delete(work),
      (error: unknown) => {
        requests.delete(work)
        protocolFailures.push(error)
      }
    )
    return work
  })
  try {
    if (options.audio) {
      controlledAudio.setObserver(observeOperation)
      const join = CallController.prototype.join
      const leave = CallController.prototype.leave
      vi.spyOn(CallController.prototype, 'join').mockImplementation(function (
        this: CallController,
        roomId: string
      ) {
        controllers.add(this)
        return observeOperation(join.call(this, roomId))
      })
      vi.spyOn(CallController.prototype, 'leave').mockImplementation(function (
        this: CallController
      ) {
        controllers.add(this)
        return observeOperation(leave.call(this))
      })
    }
    vi.stubEnv('VITE_CORE_API_URL', coreUrl)
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    vi.stubEnv('VITE_ESPACE_DEV_HOMESERVER', '')
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    setTokenProvider(auth.adapter.getAccessToken)
    registerMatrixSession(
      session,
      options.reentrantClear ? () => registerMatrixSession(session) : undefined
    )
    accepted = await load()
    let currentStore = composedStore(MATRIX_USER, options.audio, observeOperation)
    let currentSession = session
    let currentWorkspace = composedWorkspace
    let currentChannel = CHANNEL
    let currentTenantSlug: string = TENANT_SLUG
    let lease: DraftLease | undefined
    let lifetime: AuthLifetime | undefined
    let redraw: () => void = () => {}
    const leases: DraftLease[] = []
    let observedMemory: object | undefined
    const root = createRootRoute({ component: Outlet })
    function LifetimeProbe() {
      const port = useAuthLifetime()
      lifetime = port
      const recover = options.reentrantRecovery
      useLayoutEffect(() => {
        if (!recover) return
        return port.subscribe(() => {
          if (!port.hasUsableCredential()) {
            auth.setUsable(true)
            auth.notify()
          }
        })
      }, [port, recover])
      return null
    }
    function ObservedView() {
      const memory = useEspaceDraftMemory()
      const port = useAuthLifetime()
      const [observed, setObserved] = useState(false)
      useLayoutEffect(() => {
        if (memory === null || observedMemory === memory) {
          setObserved(true)
          return
        }
        observedMemory = memory
        const attach = memory.attachView.bind(memory)
        vi.spyOn(memory, 'attachView').mockImplementation((store, shownWorkspace, room) => {
          const actual = attach(store, shownWorkspace, room)
          lease = actual
          leases.push(actual)
          activeLeases.add(actual)
          const release = actual.release
          vi.spyOn(actual, 'release').mockImplementation(() => {
            activeLeases.delete(actual)
            release()
          })
          return actual
        })
        const wrapSubscription = (
          subscribe: (listener: () => void) => () => void,
          listener: () => void
        ) => {
          const record = {}
          activeSubscriptions.add(record)
          const off = subscribe(listener)
          return () => {
            activeSubscriptions.delete(record)
            off()
          }
        }
        const subscribe = memory.subscribe
        vi.spyOn(memory, 'subscribe').mockImplementation((listener) =>
          wrapSubscription(subscribe, listener)
        )
        const coreSubscribe = port.subscribe
        vi.spyOn(port, 'subscribe').mockImplementation((listener) =>
          wrapSubscription(coreSubscribe, listener)
        )
        const matrixSubscribe = matrixLifetime.subscribeMatrixSession
        vi.spyOn(matrixLifetime, 'subscribeMatrixSession').mockImplementation((listener) =>
          wrapSubscription(matrixSubscribe, listener)
        )
        setObserved(true)
      }, [memory, port])
      return observed ? <RouterProvider router={router} /> : null
    }
    function Scene() {
      const [, update] = useState(0)
      redraw = () => update((value) => value + 1)
      return (
        <EspaceLiveView
          org="acme-sa"
          organisationName="Acme"
          workspace={currentWorkspace}
          channelId={currentChannel}
          session={currentSession}
          store={currentStore}
        />
      )
    }
    const viewRoute = createRoute({
      getParentRoute: () => root,
      path: '/workspace',
      component: Scene,
    })
    const people = createRoute({
      getParentRoute: () => root,
      path: '/people',
      component: () => <h1>People</h1>,
    })
    const router = createRouter({
      routeTree: root.addChildren([viewRoute, people]),
      history: createMemoryHistory({ initialEntries: ['/workspace'] }),
    })
    flushPendingNavigation = () =>
      trackNavigation(
        router.navigate({ href: router.history.location.href, replace: true, ignoreBlocker: true })
      )
    function tree() {
      const membership = accepted.me.organisations.find(
        (entry) => entry.organisation.slug === 'acme-sa'
      )
      const body = (
        <AuthProvider
          adapter={auth.adapter}
          onSessionEnded={() => coreCallbackCounts.push(readClears())}
          onCredentialChanged={() => coreCallbackCounts.push(readClears())}
        >
          <LifetimeProbe />
          {membership === undefined ? (
            <h1>Membership absent</h1>
          ) : (
            <EspaceDraftProvider
              org="acme-sa"
              tenantSlugFor={() => currentTenantSlug}
              organisationId={membership.organisation.id}
              meGeneration={accepted.generation}
              meCredentialGeneration={accepted.credentialGeneration}
            >
              <ObservedView />
            </EspaceDraftProvider>
          )}
        </AuthProvider>
      )
      return options.strict ? <StrictMode>{body}</StrictMode> : body
    }
    const view = render(tree())
    unmount = view.unmount
    await screen.findByRole('combobox', {
      name: i18n.t('console.workspace.composer.label-message', { channel: 'General' }),
    })
    await waitFor(() => expect(lease).toBeDefined())
    const user = userEvent.setup()
    return {
      auth,
      user,
      router,
      client,
      leases,
      fetch,
      controllers,
      coreCallbackCounts,
      get store() {
        return currentStore
      },
      balance: () => ({
        leases: activeLeases.size,
        subscriptions: activeSubscriptions.size,
        pending: operations.size + requests.size,
        issued,
        settled,
      }),
      async drainOperations() {
        while (operations.size > 0) await Promise.allSettled([...operations])
        expect(operationFailures).toEqual([])
      },
      observeClears(read: () => number) {
        readClears = read
      },
      startNavigation(href: string) {
        return trackNavigation(router.navigate({ href }))
      },
      get port() {
        return lifetime!
      },
      get lease() {
        return lease!
      },
      get composer() {
        return screen.getByRole('combobox', {
          name: i18n.t('console.workspace.composer.label-message', {
            channel: currentChannel === SECOND_CHANNEL ? 'Second' : 'General',
          }),
        })
      },
      async navigate(href: string) {
        await act(async () => {
          await router.navigate({ href })
        })
      },
      async redraw() {
        await act(async () => {
          redraw()
          view.rerender(tree())
        })
      },
      accept() {
        // Return the observed operation itself, without an untracked async wrapper.
        return observeOperation(
          (async () => {
            if (closed) return
            const next = await load()
            if (closed) return
            accepted = next
            await act(async () => {
              if (closed) return
              view.rerender(tree())
              redraw()
            })
          })()
        )
      },
      holdMe() {
        heldMe = new Promise<void>((resolve) => {
          releaseMe = resolve
        })
      },
      releaseMe() {
        heldMe = undefined
        releaseMe?.()
        releaseMe = undefined
      },
      denyMembership() {
        responseMe = { ...me, organisations: [] }
      },
      person(subject: string) {
        responseMe = {
          ...me,
          identities: me.identities.map((identity) => ({ ...identity, subject })),
        }
      },
      channel(id: string) {
        currentChannel = id
      },
      tenant(slug: string) {
        currentTenantSlug = slug
      },
      replaceStore(viewer = MATRIX_USER) {
        currentStore = composedStore(viewer, options.audio, observeOperation)
      },
      replaceSession(value: MatrixSession) {
        currentSession = value
      },
      replaceWorkspace(value: Workspace) {
        currentWorkspace = value
      },
      close,
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Composed setup failure; cleanup also failed', {
        cause: error,
      })
    }
    throw error
  }
}

async function withDraftView(
  run: (h: Awaited<ReturnType<typeof composedHarness>>) => Promise<void>,
  options?: Parameters<typeof composedHarness>[0]
) {
  const h = await composedHarness(options)
  let primary: unknown
  let failed = false
  let cleanup: unknown
  try {
    await run(h)
  } catch (error) {
    failed = true
    primary = error
  } finally {
    try {
      await h.close()
    } catch (error) {
      cleanup = error
    }
  }
  if (failed && cleanup !== undefined)
    throw new AggregateError([primary, cleanup], 'Composed primary failure; cleanup also failed', {
      cause: primary,
    })
  if (failed) throw primary
  if (cleanup !== undefined) throw cleanup
}

it('restores_room_scoped_reply_edit_and_thread_targets', async () => {
  await withDraftView(async (h) => {
    const choose = async (eventText: string, action: string) => {
      const article = within(screen.getByRole('log')).getByText(eventText).closest('article')!
      const trigger = within(article)
        .getAllByRole('button')
        .find((button) => button.textContent === '···')!
      await h.user.click(trigger)
      await h.user.click(screen.getByRole('menuitem', { name: action }))
      return trigger
    }
    await h.user.type(h.composer, 'room-one')
    const first = h.lease
    await choose('Original message', i18n.t('console.workspace.message.action-reply'))
    const oldOpener = await choose(
      'Original message',
      i18n.t('console.workspace.message.action-open-thread')
    )
    await h.user.type(
      screen.getByRole('combobox', { name: i18n.t('console.workspace.thread.composer-label') }),
      'thread-one'
    )
    await h.navigate('/people')
    await h.navigate('/workspace')
    expect(h.composer).toHaveValue('room-one')
    expect(h.lease.read()).toMatchObject({
      replyTo: { roomId: ROOM, eventId: '$first' },
      threadText: 'thread-one',
    })
    expect(oldOpener.isConnected).toBe(false)
    await choose('Original message', i18n.t('console.workspace.message.action-open-thread'))
    expect(
      screen.getByRole('combobox', { name: i18n.t('console.workspace.thread.composer-label') })
    ).toHaveValue('thread-one')
    const close = within(screen.getByRole('complementary')).getByRole('button', {
      name: i18n.t('console.common.action-close'),
    })
    await h.user.click(close)
    expect(document.activeElement).not.toBe(oldOpener)
    await choose('Original message', i18n.t('console.workspace.message.action-open-thread'))
    expect(
      screen.getByRole('combobox', { name: i18n.t('console.workspace.thread.composer-label') })
    ).toHaveValue('')
    await h.user.type(
      screen.getByRole('combobox', { name: i18n.t('console.workspace.thread.composer-label') }),
      'different-root-private'
    )
    await choose('Other root', i18n.t('console.workspace.message.action-open-thread'))
    expect(
      screen.getByRole('combobox', { name: i18n.t('console.workspace.thread.composer-label') })
    ).toHaveValue('')
    h.channel(SECOND_CHANNEL)
    await h.redraw()
    expect(h.composer).toHaveValue('')
    await h.user.type(h.composer, 'room-two')
    h.channel(CHANNEL)
    await h.redraw()
    expect(h.composer).toHaveValue('room-one')
    await choose('Original message', i18n.t('console.workspace.message.action-edit'))
    await h.user.clear(h.composer)
    await h.user.type(h.composer, 'edited-unsent')
    await h.navigate('/people')
    await h.navigate('/workspace')
    expect(h.composer).toHaveValue('edited-unsent')
    expect(h.lease.read().editing?.eventId).toBe('$first')
    expect(h.store.send).not.toHaveBeenCalled()
    expect(h.store.edit).not.toHaveBeenCalled()
    expect(first.command(() => h.store.send(ROOM, 'detached'))).toBe(false)
  })
})

function observeDraftClears(uniqueText: string) {
  let completed = 0
  const original = Map.prototype.clear
  const spy = vi.spyOn(Map.prototype, 'clear').mockImplementation(function (
    this: Map<unknown, unknown>
  ) {
    const matches = (this.get(ROOM) as { text?: string } | undefined)?.text === uniqueText
    original.call(this)
    if (matches) completed += 1
  })
  return { count: () => completed, restore: () => spy.mockRestore() }
}

it.each(['sign-out', 'generation-replacement', 'ready-without-credential'] as const)(
  'terminal_core_boundary_retires_draft_memory (%s)',
  async (boundary) => {
    await withDraftView(
      async (h) => {
        const uniqueText = `terminal-${boundary}-private`
        await h.user.type(h.composer, uniqueText)
        const clears = observeDraftClears(uniqueText)
        h.observeClears(clears.count)
        try {
          const old = h.lease
          const stamp = h.port.getRetirementStamp()
          await h.navigate('/people')
          expect(clears.count()).toBe(0)
          await act(async () => {
            if (boundary === 'sign-out') await h.auth.adapter.signOut()
            else if (boundary === 'generation-replacement') h.auth.set({ generation: 2 })
            else {
              h.auth.setUsable(false)
              h.auth.set({ credentialGeneration: 2 })
            }
            expect(old.read().text).toBe('')
            expect(old.command(() => h.store.send(ROOM, 'forbidden'))).toBe(false)
          })
          expect(h.port.getRetirementStamp()).not.toBe(stamp)
          expect(clears.count()).toBe(1)
          expect(h.coreCallbackCounts.length).toBeGreaterThan(0)
          expect(h.coreCallbackCounts.every((count) => count === 1)).toBe(true)
          h.auth.setUsable(true)
          await act(async () =>
            h.auth.set({
              status: 'ready',
              user: { realm: 'acme-sa', identity: { issuer: ISSUER, subject: SUBJECT } },
            })
          )
          await h.accept()
          await h.navigate('/workspace')
          expect(h.composer).toHaveValue('')
          await h.user.type(h.composer, 'fresh-terminal-owner')
          expect(h.composer).toHaveValue('fresh-terminal-owner')
          expect(h.store.send).not.toHaveBeenCalled()
        } finally {
          clears.restore()
        }
      },
      { reentrantRecovery: boundary === 'ready-without-credential' }
    )
  }
)

it.each(['clear', 'same-fields-new-object'] as const)(
  'matrix_boundary_retires_draft_memory (%s)',
  async (boundary) => {
    await withDraftView(
      async (h) => {
        const uniqueText = `matrix-${boundary}-private`
        await h.user.type(h.composer, uniqueText)
        const old = h.lease
        const clears = observeDraftClears(uniqueText)
        const observed: number[] = []
        const off = subscribeMatrixSession(() => {
          observed.push(clears.count())
        })
        try {
          const a = getMatrixSession()!
          const registration = getMatrixRegistrationStamp()
          await h.navigate('/people')
          expect(clears.count()).toBe(0)
          await act(async () => {
            if (boundary === 'clear') {
              clearMatrixSession()
              expect(getMatrixSession()).toBe(a)
            } else registerMatrixSession({ ...a })
            expect(old.read().text).toBe('')
            expect(getMatrixRegistrationStamp()).not.toBe(registration)
          })
          expect(clears.count()).toBe(1)
          expect(observed.length).toBeGreaterThan(0)
          expect(observed.every((count) => count === 1)).toBe(true)
          h.replaceSession(getMatrixSession() as typeof a)
          await h.navigate('/workspace')
          expect(h.composer).toHaveValue('')
          h.person('person-b')
          await act(async () => {
            h.auth.set({
              generation: 2,
              credentialGeneration: 2,
              user: { realm: 'acme-sa', identity: { issuer: ISSUER, subject: 'person-b' } },
            })
          })
          await h.accept()
          await h.redraw()
          expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
          const b = { ...a, userId: `@person-b:${SERVER}` }
          act(() => registerMatrixSession(b))
          h.replaceSession(b)
          h.replaceStore(b.userId)
          await h.redraw()
          expect(h.composer).toHaveValue('')
          await h.user.type(h.composer, 'coherent-b')
          expect(h.composer).toHaveValue('coherent-b')
          h.replaceWorkspace({ ...composedWorkspace, organisation_id: 'wrong-org' })
          await h.redraw()
          expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
          h.replaceWorkspace(composedWorkspace)
          h.replaceStore(`@wrong-viewer:${SERVER}`)
          await h.redraw()
          expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
          await act(async () => h.auth.set({ user: { realm: 'acme-sa' } }))
          h.replaceStore(b.userId)
          await h.redraw()
          expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
          await act(async () =>
            h.auth.set({
              user: { realm: 'acme-sa', identity: { issuer: ISSUER, subject: 'person-b' } },
            })
          )
          await h.redraw()
          expect(h.composer).toHaveValue('')
          expect(h.store.send).not.toHaveBeenCalled()
        } finally {
          off()
          clears.restore()
        }
      },
      { reentrantClear: boundary === 'clear' }
    )
  }
)

it('usable_rotation_suspends_then_restores_same_owner_drafts', async () => {
  await withDraftView(async (h) => {
    await h.user.type(h.composer, 'rotation-private')
    const old = h.lease
    const stamp = h.port.getRetirementStamp()
    const clears = observeDraftClears('rotation-private')
    try {
      await act(async () => h.auth.set({ status: 'pending' }))
      expect(h.port.getRetirementStamp()).toBe(stamp)
      expect(old.read().text).toBe('')
      expect(old.command(() => h.store.send(ROOM, 'pending'))).toBe(false)
      expect(old.update({ text: 'pending-overwrite' })).toBe(false)
      expect(clears.count()).toBe(0)
      await act(async () => h.auth.set({ status: 'ready' }))
      await h.accept()
      expect(h.composer).toHaveValue('rotation-private')
      expect(clears.count()).toBe(0)
      h.holdMe()
      await act(async () => {
        h.auth.set({ credentialGeneration: 2 })
      })
      const acceptance = h.accept()
      await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
      expect(old.read().text).toBe('')
      expect(old.command(() => h.store.send(ROOM, 'suspended'))).toBe(false)
      expect(h.port.getRetirementStamp()).toBe(stamp)
      h.releaseMe()
      await acceptance
      await waitFor(() => expect(h.composer).toHaveValue('rotation-private'))
      h.denyMembership()
      await act(async () => h.auth.set({ credentialGeneration: 3 }))
      await h.accept()
      expect(screen.getByRole('heading', { name: 'Membership absent' })).toBeInTheDocument()
      expect(old.read().text).toBe('')
      expect(h.store.send).not.toHaveBeenCalled()
      expect(clears.count()).toBe(1)
    } finally {
      clears.restore()
    }
  })
})

it('same_public_identity_in_a_new_lifetime_has_empty_drafts', async () => {
  let old: DraftLease | undefined
  await withDraftView(async (h) => {
    await h.user.type(h.composer, 'old-lifetime')
    old = h.lease
  })
  await withDraftView(async (h) => {
    expect(h.composer).toHaveValue('')
    expect(old!.read().text).toBe('')
    expect(old!.command(() => h.store.send(ROOM, 'old-owner'))).toBe(false)
    h.replaceStore(`@wrong-person:${SERVER}`)
    await h.redraw()
    expect(h.lease.command(() => h.store.send(ROOM, 'wrong-viewer'))).toBe(false)
    h.replaceStore()
    await act(async () =>
      h.auth.set({ user: { realm: 'staff', identity: { issuer: ISSUER, subject: SUBJECT } } })
    )
    await h.redraw()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await act(async () =>
      h.auth.set({ user: { realm: 'acme-sa', identity: { issuer: ISSUER, subject: SUBJECT } } })
    )
    const coherent = getMatrixSession()!
    const wrongServer = { ...coherent, userId: `@${SUBJECT}:other.kodera.test` }
    act(() => registerMatrixSession(wrongServer))
    h.replaceSession(wrongServer)
    await h.redraw()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    act(() => registerMatrixSession(coherent))
    h.replaceSession(coherent)
    await h.redraw()
    await h.user.type(h.composer, 'new-valid')
    expect(h.composer).toHaveValue('new-valid')
    expect(h.store.send).not.toHaveBeenCalled()
  })
})

it('retires_draft_memory_when_the_tenant_slug_moves', async () => {
  await withDraftView(async (h) => {
    await h.user.type(h.composer, 'tenant-moved-private')
    const old = h.lease
    await h.navigate('/people')
    // The workspace now reads another tenant; the old one's session is still registered.
    h.tenant('acme-other')
    expect(old.command(() => h.store.send(ROOM, 'other-tenant'))).toBe(false)
    h.tenant(TENANT_SLUG)
    await h.navigate('/workspace')
    expect(h.composer).toHaveValue('')
    expect(h.store.send).not.toHaveBeenCalled()
  })
})

it('command_time_expiry_refuses_detached_send_and_draft_write', async () => {
  await withDraftView(async (h) => {
    await h.user.type(h.composer, 'positive')
    fireEvent.submit(h.composer.closest('form')!)
    await waitFor(() => expect(h.store.send).toHaveBeenCalledWith(ROOM, 'positive', {}))
    await h.drainOperations()
    expect(h.balance().issued).toBe(h.balance().settled)
    await h.user.type(h.composer, 'must-not-send')
    const form = h.composer.closest('form')!
    const lease = h.lease
    h.auth.setUsable(false) // Deliberately no notification or render before the real handler.
    fireEvent.submit(form)
    expect(h.store.send, 'ExpiredDraftOwnerIssuedCommand').toHaveBeenCalledTimes(1)
    expect(lease.update({ text: 'forbidden-write' })).toBe(false)
    expect(lease.read().text).toBe('')
  })
  await withDraftView(async (h) => {
    await h.user.type(h.composer, 'independent-positive')
    fireEvent.submit(h.composer.closest('form')!)
    await waitFor(() => expect(h.store.send).toHaveBeenCalledTimes(1))
    await h.drainOperations()
    expect(h.balance().issued).toBe(h.balance().settled)
  })
})

it('live_call_leave_confirmation_and_controller_lifetime_are_unchanged', async () => {
  controlledAudio.media.readyState = 'live'
  controlledAudio.track.isMuted = false
  controlledAudio.connect.mockClear()
  controlledAudio.disconnect.mockClear()
  controlledAudio.media.stop.mockClear()
  await withDraftView(
    async (h) => {
      await h.user.type(h.composer, 'call-draft')
      const audio = screen.getByRole('button', { name: /Audio/ })
      await h.user.click(audio)
      await waitFor(() => {
        expect(controlledAudio.connect).toHaveBeenCalledTimes(1)
        expect(
          [...h.controllers].some((controller) => controller.getSnapshot().status === 'connected')
        ).toBe(true)
        expect(controlledAudio.enable).toHaveBeenCalledWith(true)
      })
      await h.drainOperations()
      expect(controlledAudio.media.readyState).toBe('live')
      expect(controlledAudio.media.stop).not.toHaveBeenCalled()
      const origin = h.router.state.location.pathname
      const input = h.composer
      act(() => audio.focus())
      let cancelledNavigation: Promise<unknown> | undefined
      let navigation: Promise<unknown> | undefined
      act(() => {
        cancelledNavigation = h.startNavigation('/people')
      })
      await screen.findByRole('dialog')
      await h.user.click(
        screen.getByRole('button', { name: i18n.t('console.workspace.audio.action-stay') })
      )
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(h.composer).toBeEnabled()
      })
      await waitFor(() => expect(document.activeElement).toBe(audio))
      expect(h.router.state.location.pathname).toBe(origin)
      expect(h.composer).toBe(input)
      expect(h.composer).toHaveValue('call-draft')
      expect(
        [...h.controllers].some((controller) => controller.getSnapshot().status === 'connected')
      ).toBe(true)
      expect(controlledAudio.media.readyState).toBe('live')
      expect(controlledAudio.disconnect).not.toHaveBeenCalled()
      expect(controlledAudio.media.stop).not.toHaveBeenCalled()
      act(() => {
        navigation = h.startNavigation('/people')
      })
      await screen.findByRole('dialog')
      await h.user.click(
        screen.getByRole('button', { name: i18n.t('console.workspace.audio.action-confirm-leave') })
      )
      await act(async () => {
        await navigation
        await cancelledNavigation
      })
      await waitFor(() => expect(controlledAudio.disconnect).toHaveBeenCalledTimes(1))
      await h.drainOperations()
      expect(controlledAudio.track.stop).toHaveBeenCalled()
      expect(controlledAudio.media.readyState).toBe('ended')
      await h.navigate('/workspace')
      expect(h.composer).toHaveValue('call-draft')
      expect(controlledAudio.connect).toHaveBeenCalledTimes(1)
    },
    { audio: true }
  )
  expect([...controlledAudio.handlers.values()].every((listeners) => listeners.size === 0)).toBe(
    true
  )
})

it('strictmode_and_route_history_do_not_leak_draft_leases', async () => {
  let balance = () => ({ leases: 0, subscriptions: 0, pending: 0, issued: 0, settled: 0 })
  await withDraftView(
    async (h) => {
      balance = h.balance
      expect(h.balance().leases).toBe(1)
      expect(h.balance().subscriptions).toBeGreaterThan(0)
      await h.user.type(h.composer, 'strict-draft')
      const old = h.lease
      await h.navigate('/people')
      act(() => h.router.history.back())
      await waitFor(() => expect(h.composer).toHaveValue('strict-draft'))
      expect(old.update({ text: 'detached-overwrite' })).toBe(false)
      expect(h.composer).toHaveValue('strict-draft')
      await h.redraw()
      expect(h.composer).toHaveValue('strict-draft')
      const input = h.composer
      await act(async () => {
        await i18n.changeLanguage(i18n.language === 'en' ? 'fr' : 'en')
      })
      expect(h.composer).toBe(input)
      expect(h.composer).toHaveValue('strict-draft')
      expect(
        h.leases.filter((lease) => lease !== h.lease).every((lease) => lease.read().text === '')
      ).toBe(true)
    },
    { strict: true }
  )
  expect(balance().leases).toBe(0)
  expect(balance().subscriptions).toBe(0)
  expect(balance().pending).toBe(0)
  expect(balance().issued).toBe(balance().settled)
})

it('draft_memory_has_no_durable_or_diagnostic_effect', async () => {
  await withDraftView(async (h) => {
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const secret = 'unique-private-draft-and-target-7342'
    await h.user.type(h.composer, secret)
    act(() => h.lease.update({ replyTo: { roomId: ROOM, eventId: secret } }))
    await h.navigate('/people')
    await h.navigate('/workspace')
    expect(h.composer).toHaveValue(secret)
    const old = h.lease
    act(() => clearMatrixSession())
    expect(old.read().text).toBe('')
    expect(old.update({ text: secret })).toBe(false)
    expect(JSON.stringify(storage.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret)
    expect(h.router.state.location.href).not.toContain(secret)
    expect(h.store.send).not.toHaveBeenCalled()
  })
})

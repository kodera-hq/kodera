// The view's own store under <StrictMode> (issue 316): in development React mounts, unmounts and
// remounts the view's effects, and a store, once stopped, never syncs again. The view must end up
// subscribed to a store it started, with every other store it started stopped. No homeserver:
// every request waits forever, so a started store stays `starting`.
import { act, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import { EspaceStore } from './matrix/store'
import type * as StoreModule from './matrix/store'

const made = vi.hoisted(() => ({
  stores: [] as { getSnapshot: () => { status: string } }[],
  /** Each store's live subscriptions: the view reads the one it is subscribed to. */
  listeners: new Map<unknown, number>(),
}))

vi.mock('./matrix/store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>()
  return {
    ...actual,
    createEspaceStore: (...args: Parameters<typeof actual.createEspaceStore>) => {
      const store = actual.createEspaceStore(...args)
      const subscribe = store.subscribe
      store.subscribe = (listener) => {
        made.listeners.set(store, (made.listeners.get(store) ?? 0) + 1)
        const unsubscribe = subscribe(listener)
        return () => {
          made.listeners.set(store, (made.listeners.get(store) ?? 1) - 1)
          unsubscribe()
        }
      }
      made.stores.push(store)
      return store
    },
  }
})

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
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
      ],
    },
  ],
  uncategorised_channels: [],
}
const SESSION = {
  baseUrl: 'https://matrix.acme.kodera.io',
  userId: '@me:matrix.acme.kodera.io',
  deviceId: 'DEV1',
  accessToken: 'tok-live',
  refreshToken: 'ref-live',
  refresh: vi.fn(),
}

function view() {
  return (
    <StrictMode>
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        session={SESSION}
      />
    </StrictMode>
  )
}

describe('the view’s own store under StrictMode', () => {
  beforeEach(() => {
    made.stores = []
    made.listeners = new Map()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('subscribes to a store it started and has not stopped; every other started store is stopped', async () => {
    const start = vi.spyOn(EspaceStore.prototype, 'start')
    const { unmount } = render(view())
    await act(async () => undefined)

    const subscribed = made.stores.filter((store) => (made.listeners.get(store) ?? 0) > 0)
    expect(subscribed).toHaveLength(1)
    const kept = subscribed[0]!
    expect(start.mock.contexts).toContain(kept)
    expect(kept.getSnapshot().status).not.toBe('stopped')
    // One store syncs per mount: any other one the view started is stopped, none half-started.
    const others = start.mock.contexts.filter((store) => store !== kept)
    expect(others.map((store) => (store as EspaceStore).getSnapshot().status)).toEqual(
      others.map(() => 'stopped')
    )

    // Leaving the workspace still stops the sync: no started store is left running.
    unmount()
    expect(start.mock.contexts.map((store) => (store as EspaceStore).getSnapshot().status)).toEqual(
      start.mock.contexts.map(() => 'stopped')
    )
  })
})

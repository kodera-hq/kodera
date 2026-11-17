import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '../../../src/i18n'
import { DirectMessageDialog } from '../../../src/features/espace/DirectMessageDialog'
import {
  createEspaceStore,
  matrixClientForTests,
  type EspaceSnapshot,
  type MemberView,
} from '../../../src/features/espace/matrix/store'
import type { EspaceStoreLike } from '../../../src/features/espace/liveViewModel'

afterEach(() => vi.useRealTimers())
const me = '@me:example.org'
const snapshot: EspaceSnapshot = { status: 'live', channels: new Map(), rooms: [], invites: [] }
it('debounces directory searches, ignores stale results and preserves authoritative IDs', async () => {
  vi.useFakeTimers()
  const resolvers = new Map<string, (members: readonly MemberView[]) => void>()
  const search = vi.fn(
    (query: string) =>
      new Promise<readonly MemberView[]>((resolve) => resolvers.set(query, resolve))
  )
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    getUserId: () => me,
    searchMembers: search,
  } as unknown as EspaceStoreLike
  const view = render(
    <DirectMessageDialog
      open
      store={store}
      searchEntries={[]}
      onOpenChange={() => {}}
      onOpened={() => {}}
    />
  )
  const input = screen.getByRole('textbox', { name: 'Rechercher une personne' })
  fireEvent.change(input, { target: { value: 'old' } })
  await act(async () => vi.advanceTimersByTimeAsync(299))
  expect(search).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  fireEvent.change(input, { target: { value: 'new' } })
  await act(async () => vi.advanceTimersByTimeAsync(300))
  await act(async () =>
    resolvers.get('new')!([
      { userId: '@new:example.org', name: '\u202eNew person' },
      { userId: me, name: 'Self' },
      { userId: '@room-access:example.org' },
      { userId: 'not-an-id' },
    ])
  )
  expect(screen.getByText('New person')).toBeVisible()
  expect(screen.getByText('@new:example.org').tagName).toBe('BDI')
  expect(screen.getByText('Résultat de l’annuaire')).toBeVisible()
  expect(screen.queryByText('Self')).toBeNull()
  await act(async () => resolvers.get('old')!([{ userId: '@old:example.org', name: 'Old result' }]))
  expect(screen.queryByText('Old result')).toBeNull()
  fireEvent.change(input, { target: { value: 'late' } })
  await act(async () => vi.advanceTimersByTimeAsync(300))
  view.unmount()
  await act(async () => resolvers.get('late')!([{ userId: '@late:example.org' }]))
})

it('uses the SDK directory operation with a fixed limit and drops responses after session retirement', async () => {
  const store = createEspaceStore(
    {
      baseUrl: 'https://matrix.example.org',
      userId: me,
      deviceId: 'TEST',
      accessToken: 'test-token',
    },
    vi.fn(),
    { cache: null }
  )
  const client = matrixClientForTests(store)
  const search = vi
    .spyOn(client, 'searchUserDirectory')
    .mockResolvedValue({
      limited: false,
      results: [
        { user_id: me, display_name: 'Self' },
        { user_id: '@room-access:example.org', display_name: 'Service' },
        { user_id: '@person:example.org', display_name: '\u202ePerson' },
        { user_id: 'invalid' },
      ],
    })
  expect(await store.searchMembers('  person  ')).toEqual([
    { userId: '@person:example.org', name: 'Person' },
  ])
  expect(search).toHaveBeenCalledExactlyOnceWith({ term: 'person', limit: 30 })
  expect(await store.searchMembers('x')).toEqual([])
  let finish!: (value: never) => void
  search.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const pending = store.searchMembers('person')
  store.stop()
  finish({ limited: false, results: [{ user_id: '@late:example.org' }] } as never)
  expect(await pending).toEqual([])
})

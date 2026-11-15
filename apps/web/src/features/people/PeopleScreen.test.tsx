import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw/http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { server } from '../../mocks/server'
import { problem } from '../../mocks/problem'
import { scenario as defaultPeople } from '../../mocks/overlays/people.default'
import { scenario as emptyPeople } from '../../mocks/overlays/people.empty'
import { scenario as largeList } from '../../mocks/overlays/people.large-list'
import { PeopleScreen, type PeopleScreenProps } from './PeopleScreen'
import {
  CALLER_MEMBERSHIP_ID,
  caller,
  member,
  invitation,
  peopleHandlers,
} from '../../mocks/overlays/support/people'
import { ORG_ID, renderWithApi, signInSynthetic } from './test-support'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import { ToastProvider } from '../../ui/Toast/Toast'
import { peopleKeys, type Invitation } from './queries'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
beforeEach(signInSynthetic)

function renderScreen(
  overlays: Parameters<typeof renderWithApi>[1],
  props: Partial<PeopleScreenProps> = {}
) {
  const onNavigate = vi.fn()
  renderWithApi(
    <PeopleScreen
      organisationId={ORG_ID}
      callerRole="org_admin"
      callerMembershipId={CALLER_MEMBERSHIP_ID}
      tab="members"
      onNavigate={onNavigate}
      {...props}
    />,
    overlays
  )
  return { onNavigate }
}

describe('People list (03-people.md §4.1)', () => {
  it('offers exactly two ways forward and no table when the owner is alone', async () => {
    const { onNavigate } = renderScreen([emptyPeople()], { callerRole: 'org_owner' })
    expect(await screen.findByRole('heading', { name: "Personne pour l'instant" })).toBeVisible()
    expect(screen.queryByRole('columnheader')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Inviter par e-mail' }))
    expect(onNavigate).toHaveBeenLastCalledWith({ to: 'invite' })
    await userEvent.click(screen.getByRole('button', { name: 'Importer un CSV' }))
    expect(onNavigate).toHaveBeenLastCalledWith({ to: 'import' })
  })

  it('lists members with their role and a named row menu', async () => {
    renderScreen([defaultPeople()])
    const table = await screen.findByRole('table', { name: 'Personnes' })
    const row = await within(table).findByRole('row', { name: /Marc Petit/ })
    expect(row).toHaveTextContent('marc.petit@acme.fr')
    expect(row).toHaveTextContent('Membre')
    expect(within(row).getByRole('rowheader')).toHaveTextContent('Marc Petit')
    expect(within(row).getByRole('button', { name: 'Actions pour Marc Petit' })).toBeVisible()
    expect(within(table).getByRole('row', { name: /Samir Benali/ })).toHaveTextContent(
      'Accès sur site'
    )
  })

  it('counts the three groups from memberships/count, one call per group', async () => {
    const counted: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/memberships/count')) counted.push(new URL(request.url).search)
    })
    renderScreen([defaultPeople()])
    expect(
      await screen.findByText('5 membres · 2 administratrices · 2 invitations en attente')
    ).toBeVisible()
    expect(counted.sort()).toEqual(['?role=org_admin', '?state=active', '?state=invited'])
    server.events.removeAllListeners()
  })

  it('appends the next page with "load more" and keeps the rows already loaded', async () => {
    renderScreen([largeList()], { callerRole: 'org_owner' })
    const table = await screen.findByRole('table', { name: 'Personnes' })
    await waitFor(() => expect(within(table).getAllByRole('rowheader')).toHaveLength(25))
    await userEvent.click(screen.getByRole('button', { name: 'Afficher 25 de plus' }))
    await waitFor(() => expect(within(table).getAllByRole('rowheader')).toHaveLength(50))
  })

  it('filters the loaded rows by name or address, and offers to clear a search with no result', async () => {
    renderScreen([defaultPeople()])
    const table = await screen.findByRole('table', { name: 'Personnes' })
    await within(table).findByRole('row', { name: /Marc Petit/ })
    const search = screen.getByRole('searchbox', { name: 'Rechercher un nom ou un e-mail' })
    await userEvent.type(search, 'camille')
    await waitFor(() => expect(within(table).getAllByRole('rowheader')).toHaveLength(1))
    await userEvent.clear(search)
    await userEvent.type(search, 'zzz')
    expect(await screen.findByText('Aucune personne ne correspond à « zzz ».')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Effacer la recherche' }))
    // Five active people and two pending invitations.
    await waitFor(() => expect(within(table).getAllByRole('rowheader')).toHaveLength(7))
  })

  it('keeps the tabs usable and offers a retry when the list fails', async () => {
    renderScreen([
      defaultPeople(),
      [
        http.get('*/api/v1/organisations/:org/memberships', () =>
          problem('https://kodera.io/problems/internal-error')
        ),
      ],
    ])
    expect(await screen.findByText('Impossible de charger la liste. Réessayez.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: /Invitations/ })).toBeEnabled()
  })

  it('lists pending invitations on the Invitations tab', async () => {
    renderScreen([defaultPeople()], { tab: 'invitations' })
    const table = await screen.findByRole('table', { name: 'Invitations' })
    expect(
      await within(table).findByRole('row', { name: /anne.moreau@acme.fr/ })
    ).toHaveTextContent('En attente')
  })

  it('offers no row menu on the caller’s own row, and links each name to its drawer', async () => {
    const { onNavigate } = renderScreen([defaultPeople()])
    const table = await screen.findByRole('table', { name: 'Personnes' })
    const own = await within(table).findByRole('row', { name: /Julie Marchand/ })
    expect(within(own).queryByRole('button', { name: /^Actions pour/ })).toBeNull()
    const name = within(table).getByRole('button', { name: 'Marc Petit' })
    expect(name).toHaveAttribute('data-member-id')
    await userEvent.click(name)
    expect(onNavigate).toHaveBeenLastCalledWith({
      to: 'member',
      memberId: name.getAttribute('data-member-id'),
    })
  })

  it('focuses the search with "/" from anywhere on the screen', async () => {
    renderScreen([defaultPeople()])
    await screen.findByRole('table', { name: 'Personnes' })
    await userEvent.keyboard('/')
    expect(screen.getByRole('searchbox', { name: 'Rechercher un nom ou un e-mail' })).toHaveFocus()
    expect(screen.getByRole('searchbox', { name: 'Rechercher un nom ou un e-mail' })).toHaveValue(
      ''
    )
  })
})

describe('The row menu acts only on the person as shown (03-people.md §4.5)', () => {
  const CHANGED =
    "Cette personne vient d'être modifiée par quelqu'un d'autre. Vérifiez sa fiche, puis réessayez."

  /** Marc as the list shows him, and the record a fresh read answers with `detail`. */
  function marcScenario(detail: Record<string, unknown>, refusal?: Parameters<typeof problem>[0]) {
    const marc = member('Marc Petit', 'marc.petit@acme.fr', 'org_member')
    const url = '*/api/v1/organisations/:org/memberships/:id'
    const written: { method: string; ifMatch: string | null }[] = []
    let reads = 0
    const lists = { count: 0 }
    const overlays = [
      peopleHandlers({ callerRole: 'org_admin', members: [caller('org_admin'), marc] }),
      [
        http.get('*/api/v1/organisations/:org/memberships', () => {
          // Counted, then answered by the store.
          lists.count += 1
          return undefined
        }),
        http.get(url, ({ params }) => {
          // Anything but Marc's record (the counts among them) goes to the store.
          if (params['id'] !== marc.id) return undefined
          reads += 1
          return HttpResponse.json(
            { ...marc, can_change_role: true, can_remove: true, blocked_reason: null, ...detail },
            { headers: { ETag: `"marc-row-${reads}"` } }
          )
        }),
        http.patch(url, ({ request }) => {
          written.push({ method: 'PATCH', ifMatch: request.headers.get('If-Match') })
          return HttpResponse.json(marc, { headers: { ETag: '"marc-patched"' } })
        }),
        http.delete(url, ({ request }) => {
          written.push({ method: 'DELETE', ifMatch: request.headers.get('If-Match') })
          if (refusal !== undefined) return problem(refusal)
          const { email: _email, display_name: _name, ...removed } = { ...marc, state: 'removed' }
          return HttpResponse.json(removed)
        }),
      ],
    ]
    return { overlays, written, lists }
  }

  async function removeFromMenu() {
    const table = await screen.findByRole('table', { name: 'Personnes' })
    const row = await within(table).findByRole('row', { name: /Marc Petit/ })
    await userEvent.click(within(row).getByRole('button', { name: 'Actions pour Marc Petit' }))
    await userEvent.click(
      await screen.findByRole('menuitem', { name: "Retirer de l'organisation" })
    )
    const confirm = await screen.findByRole('dialog', { name: 'Retirer Marc Petit ?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Retirer Marc Petit' }))
  }

  it('removes under the tag of a read made at confirmation', async () => {
    const { overlays, written } = marcScenario({})
    renderScreen(overlays)
    await removeFromMenu()
    expect(await screen.findByText('Marc Petit a été retirée.')).toBeVisible()
    expect(written).toEqual([{ method: 'DELETE', ifMatch: '"marc-row-1"' }])
  })

  it.each([
    ['412', 'https://kodera.io/problems/precondition-failed'],
    ['404', 'https://kodera.io/problems/not-found'],
  ] as const)('reads the list again when a removal meets a %s', async (_, type) => {
    const { overlays, written, lists } = marcScenario({}, type)
    renderScreen(overlays)
    await screen.findByRole('table', { name: 'Personnes' })
    const drawn = lists.count
    await removeFromMenu()
    expect(await screen.findByText(CHANGED)).toBeVisible()
    expect(written).toHaveLength(1)
    await waitFor(() => expect(lists.count).toBeGreaterThan(drawn))
  })

  it('removes nobody when the person changed since the list was drawn', async () => {
    const { overlays, written } = marcScenario({ role: 'org_admin' })
    renderScreen(overlays)
    await removeFromMenu()
    expect(await screen.findByText(CHANGED)).toBeVisible()
    expect(written).toEqual([])
  })

  it('changes no role when the person changed since the list was drawn', async () => {
    const { overlays, written } = marcScenario({ state: 'suspended' })
    renderScreen(overlays)
    const table = await screen.findByRole('table', { name: 'Personnes' })
    const row = await within(table).findByRole('row', { name: /Marc Petit/ })
    await userEvent.click(within(row).getByRole('button', { name: 'Actions pour Marc Petit' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rendre administrateur' }))
    expect(await screen.findByText(CHANGED)).toBeVisible()
    expect(written).toEqual([])
  })

  it('says why when Core no longer offers the removal, naming the last-owner fix', async () => {
    const { overlays, written } = marcScenario({ can_remove: false, blocked_reason: 'last_owner' })
    renderScreen(overlays)
    await removeFromMenu()
    expect(
      await screen.findByText(
        "Votre organisation doit conserver au moins un propriétaire. Nommez quelqu'un d'autre avant de modifier ce rôle."
      )
    ).toBeVisible()
    expect(written).toEqual([])
  })
})

// Real client/store acceptance; collection removal is not backend tombstone proof.
type InvitationPages = InfiniteData<{
  data: Invitation[]
  has_more: boolean
  next_cursor?: string | null
}>
const OTHER_CANCEL_ORG = '7f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
function revocationGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const cancellationClients: QueryClient[] = []
afterEach(() => {
  for (const client of cancellationClients.splice(0)) client.clear()
})
function cancellationClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cancellationClients.push(client)
  return client
}
function cancellationFixture(
  options: {
    failRefresh?: boolean
    lostReply?: boolean
    refusal?: 403 | 409
    heldDelete?: boolean
    sameEmail?: boolean
    pages?: boolean
  } = {}
) {
  const target = invitation('cancel-target@example.test')
  const sibling = invitation(
    options.sameEmail ? target.email : 'cancel-other@example.test',
    'org_admin'
  )
  const fillers = options.pages
    ? Array.from({ length: 25 }, (_, n) => invitation(`cancel-page${n}@example.test`))
    : []
  const handlers = peopleHandlers({
    callerRole: 'org_admin',
    members: [caller('org_admin')],
    invitations: [target, sibling, ...fillers],
  })
  const actualDelete = handlers.find(
    (h) => h.info.method === 'DELETE' && h.info.path === '*/api/v1/invitations/:invitation_id'
  )
  const actualList = handlers.find(
    (h) =>
      h.info.method === 'GET' &&
      h.info.path === '*/api/v1/organisations/:organisation_id/invitations'
  )
  if (!actualDelete || !actualList) throw new Error('Actual revocation/list handlers missing.')
  let writes = 0,
    effects = 0,
    failedReads = 0,
    holdNextRead = false
  const deletion = revocationGate(),
    deleteReply = revocationGate(),
    materialized = revocationGate(),
    oldReply = revocationGate()
  const boundaries = [
    http.delete('*/api/v1/invitations/:invitation_id', async ({ request, params }) => {
      writes++
      if (params['invitation_id'] !== target.id) throw new Error('Wrong revocation target.')
      if (options.refusal)
        return HttpResponse.json(
          {
            type: `https://kodera.io/problems/${options.refusal === 403 ? 'forbidden' : 'conflict'}`,
            status: options.refusal,
          },
          { status: options.refusal, headers: { 'Content-Type': 'application/problem+json' } }
        )
      const result = await actualDelete.run({
        request: request.clone(),
        requestId: crypto.randomUUID(),
      })
      if (result?.response?.status !== 204) throw new Error('Actual revocation did not return204.')
      effects++
      deletion.release()
      if (options.heldDelete) await deleteReply.promise
      return options.lostReply ? HttpResponse.error() : result.response
    }),
    http.get('*/api/v1/organisations/:organisation_id/invitations', async ({ request, params }) => {
      if (params['organisation_id'] === OTHER_CANCEL_ORG)
        return HttpResponse.json({
          data: [{ ...sibling, organisation_id: OTHER_CANCEL_ORG }],
          has_more: false,
        })
      const witness = request.headers.get('X-Revocation-Witness') === 'true'
      if (holdNextRead && !witness) {
        holdNextRead = false
        const result = await actualList.run({
          request: request.clone(),
          requestId: crypto.randomUUID(),
        })
        if (result?.response?.status !== 200) throw new Error('Old list materialization failed.')
        const snapshot = (await result.response.clone().json()) as { data: Invitation[] }
        expect(
          snapshot.data.some((row) => row.id === target.id && row.organisation_id === ORG_ID)
        ).toBe(true)
        materialized.release()
        await oldReply.promise
        return result.response
      }
      if (!witness && effects > 0 && options.failRefresh !== false) {
        failedReads++
        return HttpResponse.json(
          { type: 'https://kodera.io/problems/service-unavailable', status: 503 },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } }
        )
      }
      const result = await actualList.run({
        request: request.clone(),
        requestId: crypto.randomUUID(),
      })
      if (!result?.response) throw new Error('Actual invitation list declined.')
      return result.response
    }),
  ]
  server.use(...handlers)
  server.use(...boundaries)
  const client = cancellationClient()
  let currentClient = client,
    currentOrg = ORG_ID,
    visible = true
  const ui = () => (
    <QueryClientProvider client={currentClient}>
      <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
        {visible ? (
          <PeopleScreen
            organisationId={currentOrg}
            callerRole="org_admin"
            callerMembershipId={CALLER_MEMBERSHIP_ID}
            tab="invitations"
            onNavigate={vi.fn()}
          />
        ) : null}
      </ToastProvider>
    </QueryClientProvider>
  )
  const view = render(ui())
  const update = (next: { org?: string; client?: QueryClient; visible?: boolean }) => {
    currentOrg = next.org ?? currentOrg
    currentClient = next.client ?? currentClient
    visible = next.visible ?? visible
    view.rerender(ui())
  }
  const witness = async () => {
    const response = await fetch(
      `https://core.example.test/api/v1/organisations/${ORG_ID}/invitations?state=pending&limit=100`,
      { headers: { 'X-Revocation-Witness': 'true' } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Invitation[] }
    expect(body.data.some((row) => row.id === target.id && row.organisation_id === ORG_ID)).toBe(
      false
    )
    expect(body.data.find((row) => row.id === sibling.id)).toMatchObject({
      id: sibling.id,
      organisation_id: ORG_ID,
      state: 'pending',
    })
  }
  return {
    target,
    sibling,
    client,
    update,
    witness,
    deletion,
    deleteReply,
    materialized,
    oldReply,
    holdOldRead: () => {
      holdNextRead = true
    },
    writes: () => writes,
    effects: () => effects,
    failedReads: () => failedReads,
  }
}
function cancellationRow() {
  return screen.queryByRole('row', { name: /cancel-target@example\.test.*Membre/ })
}
async function cancelTarget() {
  const row = await screen.findByRole('row', { name: /cancel-target@example\.test.*Membre/ })
  await userEvent.click(
    within(row).getByRole('button', { name: i18n.t('console.people.members.action-revoke') })
  )
}
function cancelledToast() {
  return i18n.t('console.people.members.toast-revoked', { person: 'cancel-target@example.test' })
}
function cachedInvitations(client: QueryClient, org = ORG_ID) {
  return client.getQueryData<InvitationPages>(peopleKeys.invitations(org))
}
function expectCancelledCache(client: QueryClient, id: string) {
  expect(
    cachedInvitations(client)
      ?.pages.flatMap((page) => page.data)
      .some((row) => row.id === id && row.organisation_id === ORG_ID),
    'ACKNOWLEDGED_TARGET_REMOVED_FROM_ORIGINAL_CACHE'
  ).toBe(false)
}
async function cancellationSettled(f: ReturnType<typeof cancellationFixture>) {
  await screen.findByText(cancelledToast())
  await waitFor(() => expect(f.failedReads()).toBeGreaterThan(0))
  await waitFor(() =>
    expect(f.client.getQueryState(peopleKeys.invitations(ORG_ID))?.fetchStatus).toBe('idle')
  )
  await f.witness()
  expect(f.writes()).toBe(1)
  expect(f.effects()).toBe(1)
}

describe('confirmed invitation revocation', () => {
  it('does not leave a confirmed cancellation actionable as pending when list refresh fails', async () => {
    const f = cancellationFixture()
    await cancelTarget()
    await cancellationSettled(f)
    // FIRST semantic invariant after actual204, failed refresh and marked GET witness.
    expect(cancellationRow(), 'CONFIRMED_REVOCATION_IS_NOT_ACTIONABLE_PENDING').toBeNull()
    expect(screen.getByRole('row', { name: /cancel-other@example.test/ })).toBeVisible()
  })
  it('accepts the normal void204 and removes the target after successful refresh', async () => {
    const f = cancellationFixture({ failRefresh: false })
    await cancelTarget()
    await screen.findByText(cancelledToast())
    await f.witness()
    expect(cancellationRow()).toBeNull()
    expect(f.writes()).toBe(1)
  })
  it('keeps a different invitation with the same email', async () => {
    const f = cancellationFixture({ sameEmail: true })
    await cancelTarget()
    await cancellationSettled(f)
    expectCancelledCache(f.client, f.target.id)
    expect(cachedInvitations(f.client)!.pages.flatMap((page) => page.data)).toContainEqual(
      expect.objectContaining({ id: f.sibling.id, email: f.target.email })
    )
  })
  it('preserves every page, pageParam and cursor while pruning only the acknowledged id', async () => {
    const f = cancellationFixture({ pages: true })
    await screen.findByRole('row', { name: /cancel-target@example.test/ })
    await userEvent.click(screen.getByRole('button', { name: 'Afficher 25 de plus' }))
    await waitFor(() => expect(cachedInvitations(f.client)?.pages).toHaveLength(2))
    const before = structuredClone(cachedInvitations(f.client)!)
    await cancelTarget()
    await cancellationSettled(f)
    const expected = {
      ...before,
      pages: before.pages.map((page) => ({
        ...page,
        data: page.data.filter((row) => row.id !== f.target.id),
      })),
    }
    expect(cachedInvitations(f.client), 'EXACT_PRUNE_PRESERVES_PAGINATION').toEqual(expected)
  })
  it.each([403, 409] as const)(
    'keeps the pending item after a pre-ACK%s refusal',
    async (refusal) => {
      const f = cancellationFixture({ refusal })
      await cancelTarget()
      await screen.findByText(i18n.t('console.common.error-unavailable'))
      expect(cancellationRow()).toBeVisible()
      expect(
        cachedInvitations(f.client)!.pages[0]!.data.some((row) => row.id === f.target.id)
      ).toBe(true)
      expect(screen.queryByText(cancelledToast())).toBeNull()
      expect(f.writes()).toBe(1)
      expect(f.effects()).toBe(0)
    }
  )
  it('does not infer acknowledgement from an effect whose reply was lost', async () => {
    const f = cancellationFixture({ lostReply: true })
    await cancelTarget()
    await screen.findByText(i18n.t('console.common.error-unavailable'))
    await f.witness()
    expect(cancellationRow()).toBeVisible()
    expect(screen.queryByText(cancelledToast())).toBeNull()
    expect(f.writes()).toBe(1)
  })
  it('does not revive a cancelled row when an old materialized list read finally settles', async () => {
    const f = cancellationFixture()
    await screen.findByRole('row', { name: /cancel-target@example.test/ })
    const key = peopleKeys.invitations(ORG_ID)
    const query = f.client.getQueryCache().find({ queryKey: key, exact: true })!
    const read = query.options.queryFn
    if (typeof read !== 'function') throw new Error('Actual query function missing.')
    let oldExecution: Promise<unknown> | undefined
    query.setOptions({
      ...query.options,
      queryFn: (context) => {
        const execution = Promise.resolve(read(context))
        oldExecution ??= execution
        return execution
      },
    })
    f.holdOldRead()
    const oldFetch = f.client.refetchQueries({ queryKey: key, exact: true })
    try {
      await f.materialized.promise
      expect(oldExecution).toBeDefined()
      await cancelTarget()
      await cancellationSettled(f)
    } finally {
      f.oldReply.release()
      await act(async () => {
        await oldExecution
        await oldFetch
      })
    }
    expect(cancellationRow(), 'SETTLED_OLD_READ_CANNOT_REVIVE_CONFIRMED_REVOCATION').toBeNull()
    expectCancelledCache(f.client, f.target.id)
  })
  it.each(['delete', 'cancel'] as const)(
    'preserves original cache and suppresses retired UI across the %s await',
    async (phase) => {
      const f = cancellationFixture({ heldDelete: phase === 'delete' })
      const hold = revocationGate(),
        entered = revocationGate()
      const cancel = f.client.cancelQueries.bind(f.client),
        invalidate = f.client.invalidateQueries.bind(f.client)
      let cancelEntered = false
      if (phase === 'cancel') {
        vi.spyOn(f.client, 'cancelQueries').mockImplementation(async (...args) => {
          await cancel(...args)
          cancelEntered = true
          entered.release()
          await hold.promise
        })
        // The predecessor has only the later refresh await; hold its real result
        // there, so the old code has a comparable interleaving without a timeout.
        vi.spyOn(f.client, 'invalidateQueries').mockImplementation(async (...args) => {
          await invalidate(...args)
          if (!cancelEntered) {
            entered.release()
            await hold.promise
          }
        })
      }
      const starting = cancelTarget()
      await starting
      await f.deletion.promise
      if (phase === 'cancel') await entered.promise
      f.update({ visible: false })
      const key = peopleKeys.invitations(ORG_ID)
      const before = cachedInvitations(f.client)!
      f.client.setQueryData(key, {
        ...before,
        pages: before.pages.map((page, n) =>
          n === 0
            ? { ...page, data: [...page.data, { ...f.target, organisation_id: OTHER_CANCEL_ORG }] }
            : page
        ),
      })
      try {
        f.deleteReply.release()
        hold.release()
        await waitFor(() => expectCancelledCache(f.client, f.target.id))
        expect(cachedInvitations(f.client)!.pages.flatMap((page) => page.data)).toContainEqual(
          expect.objectContaining({ id: f.target.id, organisation_id: OTHER_CANCEL_ORG })
        )
        expect(
          screen.queryByText(cancelledToast()),
          'RETIRED_REVOCATION_HAS_NO_UI_PUBLICATION'
        ).toBeNull()
        expect(f.writes()).toBe(1)
        if (phase === 'cancel') expect(cancelEntered).toBe(true)
      } finally {
        f.deleteReply.release()
        hold.release()
      }
    }
  )
  it.each([
    { kind: 'organisation', phase: 'delete' },
    { kind: 'client', phase: 'delete' },
    { kind: 'organisation', phase: 'cancel' },
    { kind: 'client', phase: 'cancel' },
  ] as const)(
    'updates only the original cache after $kind replacement during $phase',
    async ({ kind, phase }) => {
      const f = cancellationFixture({ heldDelete: phase === 'delete' })
      const hold = revocationGate(),
        entered = revocationGate()
      const cancel = f.client.cancelQueries.bind(f.client),
        invalidate = f.client.invalidateQueries.bind(f.client)
      let cancelEntered = false
      if (phase === 'cancel') {
        vi.spyOn(f.client, 'cancelQueries').mockImplementation(async (...args) => {
          await cancel(...args)
          cancelEntered = true
          entered.release()
          await hold.promise
        })
        vi.spyOn(f.client, 'invalidateQueries').mockImplementation(async (...args) => {
          await invalidate(...args)
          if (!cancelEntered) {
            entered.release()
            await hold.promise
          }
        })
      }
      await cancelTarget()
      await f.deletion.promise
      if (phase === 'cancel') await entered.promise
      await f.witness()
      const nextClient = kind === 'client' ? cancellationClient() : f.client
      const nextOrg = kind === 'organisation' ? OTHER_CANCEL_ORG : ORG_ID
      const nextData: InvitationPages = {
        pages: [{ data: [{ ...f.target, organisation_id: nextOrg }], has_more: false }],
        pageParams: [undefined],
      }
      nextClient.setQueryDefaults(peopleKeys.invitations(nextOrg), { staleTime: Infinity })
      nextClient.setQueryData(peopleKeys.invitations(nextOrg), nextData)
      const newWrites = vi.spyOn(nextClient, 'setQueryData')
      f.update({ org: nextOrg, client: nextClient })
      try {
        f.deleteReply.release()
        hold.release()
        await waitFor(() => expectCancelledCache(f.client, f.target.id))
        expect(cachedInvitations(nextClient, nextOrg)).toEqual(nextData)
        expect(
          newWrites.mock.calls.some(
            ([key]) => JSON.stringify(key) === JSON.stringify(peopleKeys.invitations(nextOrg))
          )
        ).toBe(false)
        expect(screen.queryByText(cancelledToast())).toBeNull()
        if (phase === 'cancel') expect(cancelEntered).toBe(true)
      } finally {
        f.deleteReply.release()
        hold.release()
      }
    }
  )
  it('does not recreate an absent original cache after unmount', async () => {
    const f = cancellationFixture({ heldDelete: true })
    await cancelTarget()
    await f.deletion.promise
    f.update({ visible: false })
    const key = peopleKeys.invitations(ORG_ID)
    f.client.removeQueries({ queryKey: key, exact: true })
    const completed = revocationGate()
    const cancel = f.client.cancelQueries.bind(f.client),
      invalidate = f.client.invalidateQueries.bind(f.client)
    vi.spyOn(f.client, 'cancelQueries').mockImplementation(async (...args) => {
      await cancel(...args)
      completed.release()
    })
    vi.spyOn(f.client, 'invalidateQueries').mockImplementation(async (...args) => {
      await invalidate(...args)
      completed.release()
    })
    try {
      f.deleteReply.release()
      await completed.promise
      expect(f.writes()).toBe(1)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(f.client.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined()
      expect(screen.queryByText(cancelledToast())).toBeNull()
    } finally {
      f.deleteReply.release()
    }
  })
  it('does not unretire an old UI token after organisation away-and-back', async () => {
    const f = cancellationFixture({ heldDelete: true })
    await cancelTarget()
    await f.deletion.promise
    f.update({ org: OTHER_CANCEL_ORG })
    f.update({ org: ORG_ID })
    try {
      f.deleteReply.release()
      await waitFor(() => expectCancelledCache(f.client, f.target.id))
      expect(screen.queryByText(cancelledToast())).toBeNull()
    } finally {
      f.deleteReply.release()
    }
  })
  it('does not reclassify an acknowledged cancellation when later refresh processing rejects', async () => {
    const f = cancellationFixture({ failRefresh: false })
    const invalidate = f.client.invalidateQueries.bind(f.client)
    vi.spyOn(f.client, 'invalidateQueries').mockImplementation(async (...args) => {
      await invalidate(...args)
      throw new Error('Synthetic post-ACK refresh continuation failure')
    })
    await cancelTarget()
    await f.witness()
    await screen.findAllByText((text) =>
      [cancelledToast(), i18n.t('console.common.error-unavailable')].includes(text)
    )
    await waitFor(() =>
      expect(
        screen.queryByText(i18n.t('console.common.error-unavailable')),
        'KNOWN_REVOCATION_IS_NOT_A_FAILED_WRITE'
      ).toBeNull()
    )
    expect(await screen.findByText(cancelledToast())).toBeVisible()
    expect(f.writes()).toBe(1)
  })
})

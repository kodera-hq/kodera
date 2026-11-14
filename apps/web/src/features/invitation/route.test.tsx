// Exercise the eager owner with the real router while its actual screen import cannot settle.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { rootRoute } from '../../app/root-route'
import { forgetInvitationEntry, holdInvitationEntry, readInvitationEntry } from './entry'
import { invitationRoute } from './route'

const chunk = vi.hoisted(() => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release, requested: false }
})

vi.mock('./InvitationRoute', async (original) => {
  chunk.requested = true
  await chunk.pending
  return original<typeof import('./InvitationRoute')>()
})

const ORGANISATION_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const SLUG = 'acme-sa'
const PATH = `/invitations/accept/${ORGANISATION_ID}/${SLUG}`

function hold(marker: string) {
  holdInvitationEntry({
    organisationId: ORGANISATION_ID,
    organisationSlug: SLUG,
    secret: `inv1_${marker.repeat(40)}`,
  })
  return readInvitationEntry(ORGANISATION_ID, SLUG)
}

async function openPendingRoute() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree: rootRoute.addChildren([invitationRoute]),
    history: createMemoryHistory({ initialEntries: [PATH] }),
  })
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  )
  await screen.findByText(i18n.t('console.shell.session.status-restoring'))
  await waitFor(() => expect(chunk.requested).toBe(true))
  return {
    unmount() {
      view.unmount()
      client.clear()
    },
  }
}

async function settleDeparture() {
  // The production owner deliberately waits one task to distinguish StrictMode rehearsal.
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  })
}

afterEach(() => {
  chunk.release()
  forgetInvitationEntry()
})

it('retires entries before a held screen mounts, preserves newer ownership and StrictMode, then refuses the old entry on remount', async () => {
  forgetInvitationEntry()
  const initial = hold('a')
  let page = await openPendingRoute()
  await settleDeparture()
  // StrictMode's rehearsal must not destroy a still-visible pending invitation.
  expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBe(initial)

  page.unmount()
  await settleDeparture()
  expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()

  hold('b')
  page = await openPendingRoute()
  page.unmount()
  // A newer entry can be captured before the departed owner's delayed cleanup runs.
  const replacement = hold('c')
  await settleDeparture()
  expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBe(replacement)

  page = await openPendingRoute()
  await settleDeparture()
  expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBe(replacement)
  act(() => window.dispatchEvent(new Event('pagehide')))
  expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  page.unmount()
  await settleDeparture()

  // Returning to the same path carries no new fragment. Release the actual acceptance module
  // only now: its real missing-entry state must render instead of recovering a previous secret.
  page = await openPendingRoute()
  await act(async () => {
    chunk.release()
    await chunk.pending
  })
  expect(
    await screen.findByRole('heading', { name: i18n.t('console.invitation.accept.missing') })
  ).toBeVisible()
  expect(readInvitationEntry(ORGANISATION_ID, SLUG)).toBeUndefined()
  page.unmount()
  await settleDeparture()
})

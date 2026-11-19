import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { RoomSummary } from '../espace/matrix/store'
import { NotificationCenter } from './NotificationCenter'
import { NotificationFeed } from './notificationFeed'

const ITEM = {
  id: '0190a1b2-0000-7000-8000-000000000001',
  kind: 'mention',
  resourceId: '0190a1b2-0000-7000-8000-0000000000aa',
  createdAt: '2026-11-19T10:00:00Z',
  readAt: null,
}

function room(roomId: string, name: string, mentions: number): RoomSummary {
  return { roomId, name, alias: null, kind: 'text', unread: mentions, mentions, occupancy: null }
}

function storeWith(rooms: RoomSummary[]): EspaceStoreLike {
  const snapshot = { status: 'live', rooms, invites: [], channels: new Map() }
  return { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as EspaceStoreLike
}

describe('the notification inbox', () => {
  it('lists the rooms with unread mentions, and jumps to one, closing itself', async () => {
    const user = userEvent.setup()
    const openRoom = vi.fn()
    const source = new NotificationFeed(
      () => Promise.resolve({ data: [] }),
      () => Promise.resolve()
    )
    render(
      <NotificationCenter
        source={source}
        store={storeWith([
          room('!a:kodera.test', 'général', 2),
          room('!b:kodera.test', 'calme', 0),
        ])}
        onOpenRoom={openRoom}
      />
    )
    await user.click(screen.getByRole('button', { name: /Notifications, 1/u }))
    const list = await screen.findByRole('list', { name: 'Salons où vous êtes mentionné' })
    expect(list).toHaveTextContent('général')
    expect(list).not.toHaveTextContent('calme')
    await user.click(screen.getByRole('button', { name: /général/u }))
    expect(openRoom).toHaveBeenCalledWith('!a:kodera.test')
    await waitFor(() => expect(screen.queryByRole('list', { name: /mentionné/u })).toBeNull())
  })

  it('opens a notification by Enter, marking it read', async () => {
    const user = userEvent.setup()
    const markRead = vi.fn(() => Promise.resolve())
    const openItem = vi.fn()
    const source = new NotificationFeed(() => Promise.resolve({ data: [ITEM] }), markRead)
    render(<NotificationCenter source={source} onOpenNotification={openItem} />)
    await waitFor(() => expect(source.getSnapshot().unread).toBe(1))
    await user.click(screen.getByRole('button', { name: /Notifications, 1/u }))
    const item = await screen.findByRole('button', { name: /Quelqu’un vous a mentionné/u })
    item.focus()
    await user.keyboard('{Enter}')
    expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ id: ITEM.id }))
    expect(markRead).toHaveBeenCalledWith([ITEM.id])
    expect(source.getSnapshot().unread).toBe(0)
  })

  it('leaves the items as text where nothing opens them', async () => {
    const user = userEvent.setup()
    const source = new NotificationFeed(
      () => Promise.resolve({ data: [ITEM] }),
      () => Promise.resolve()
    )
    render(<NotificationCenter source={source} store={storeWith([room('!a:k', 'général', 3)])} />)
    await waitFor(() => expect(source.getSnapshot().unread).toBe(1))
    await user.click(screen.getByRole('button', { name: /Notifications, 1/u }))
    await screen.findByText('Quelqu’un vous a mentionné')
    expect(screen.queryByRole('button', { name: /mentionné/u })).toBeNull()
    expect(screen.queryByText(/général/u)).toBeNull()
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { useRailDirects } from '../../app/railDirectsStore'
import type { Workspace } from '../workspace/workspace'
import { ChannelContextMenu, menuAnchor, type ChannelMenuTarget } from './ChannelContextMenu'
import { EspaceLiveView, type EspaceStoreLike } from './EspaceLiveView'
import type { EspaceSnapshot } from './matrix/store'

vi.mock('../workspace/quotasApi', () => ({
  useWorkspaceQuotasQuery: () => ({ data: undefined, refetch: vi.fn() }),
}))

const target: ChannelMenuTarget = {
  channelId: 'c1',
  label: 'général',
  kind: 'text',
  clientX: 40,
  clientY: 80,
}

describe('ChannelContextMenu', () => {
  it('lists only the actions the view can carry out, permissions for admins only', async () => {
    const user = userEvent.setup()
    const onCopyLink = vi.fn()
    const onClose = vi.fn()
    render(
      <ChannelContextMenu
        target={target}
        onClose={onClose}
        onSettings={vi.fn()}
        onToggleMute={vi.fn()}
        isMuted={() => true}
        onCopyLink={onCopyLink}
        onPermissions={vi.fn()}
        canManage={() => false}
      />
    )
    const menu = screen.getByRole('menu', { name: 'Actions pour #général' })
    expect(menu).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Paramètres du salon',
      'Réactiver les notifications',
      'Copier le lien',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Copier le lien' }))
    expect(onCopyLink).toHaveBeenCalledWith(target)
    expect(onClose).toHaveBeenCalled()
  })

  it('offers permissions to an admin and draws nothing without actions', () => {
    const view = render(
      <ChannelContextMenu
        target={target}
        onClose={vi.fn()}
        onPermissions={vi.fn()}
        canManage={() => true}
      />
    )
    expect(screen.getByRole('menuitem', { name: 'Permissions' })).toBeInTheDocument()
    view.rerender(<ChannelContextMenu target={target} onClose={vi.fn()} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('places a keyboard-opened menu under its row', () => {
    const row = document.createElement('a')
    row.getBoundingClientRect = () => ({ left: 10, bottom: 50 }) as DOMRect
    expect(menuAnchor({ ...target, clientX: 0, clientY: 0, trigger: row })).toEqual({
      x: 26,
      y: 50,
    })
    expect(menuAnchor(target)).toEqual({ x: 40, y: 80 })
  })

  it('wires ChannelContextMenu in EspaceLiveView, renders DM header/timeline without #name, and clears RailDirects on simulation', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const GENERAL = 'g1111111-1111-4111-8111-000000000001'
    const ROOM = '!general:matrix.acme.kodera.io'
    const DM_ROOM = '!dm-marina:matrix.acme.kodera.io'
    const PEER = '@marina.loiseau:matrix.acme.kodera.io'
    const WORKSPACE: Workspace = {
      organisation_id: 'o1111111-1111-4111-8111-111111111111',
      state: 'initialised',
      setup: { state: 'ready', reason: null },
      can_initialise: false,
      id: 'w2222222-2222-4222-8222-222222222222',
      categories: [
        {
          id: 'cat-general',
          name: 'General',
          template_key: 'general',
          channels: [
            {
              id: GENERAL,
              kind: 'text',
              name: 'general',
              template_key: 'general',
              topic: '',
              lifecycle: 'active',
              room_state: 'ready',
            },
          ],
        },
      ],
      uncategorised_channels: [],
    }
    const snapshot: EspaceSnapshot = {
      status: 'live',
      channels: new Map([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
      rooms: [
        {
          roomId: ROOM,
          name: 'general',
          alias: null,
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
        {
          roomId: DM_ROOM,
          name: 'Marina Loiseau',
          alias: null,
          kind: 'text',
          unread: 2,
          mentions: 0,
          occupancy: null,
        },
      ],
      invites: [],
    }
    const store: EspaceStoreLike = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getUserId: () => '@me:matrix.acme.kodera.io',
      getTimeline: () => [],
      getHistory: () => 'start',
      getThread: () => [],
      getDirects: () => [{ roomId: DM_ROOM, userIds: [PEER], name: 'Marina Loiseau', unread: 2 }],
      send: vi.fn(async () => undefined),
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
    }

    function RailProbe() {
      const directs = useRailDirects()
      return <output data-testid="rail-directs-count">{directs ? directs.items.length : -1}</output>
    }

    const view = render(
      <>
        <RailProbe />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={store}
        />
      </>
    )

    expect(screen.getByTestId('rail-directs-count')).toHaveTextContent('1')

    // Right-clicking a channel row opens ChannelContextMenu in live workspace.
    const channelRow = screen.getByRole('link', { name: 'général' })
    fireEvent.contextMenu(channelRow, { clientX: 32, clientY: 64 })
    expect(await screen.findByRole('menu', { name: 'Actions pour #général' })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Copier le lien' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/acme/workspace/${GENERAL}`
      )
    )
    expect(await screen.findByText('Lien de #général copié')).toBeInTheDocument()

    // Keyboard contextmenu (clientX=0, clientY=0, e.g. Shift+F10) also opens and toggles mute.
    fireEvent.contextMenu(channelRow, { clientX: 0, clientY: 0 })
    await user.click(await screen.findByRole('menuitem', { name: 'Mettre en sourdine' }))
    fireEvent.contextMenu(channelRow, { clientX: 0, clientY: 0 })
    expect(
      await screen.findByRole('menuitem', { name: 'Réactiver les notifications' })
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // Selecting a DM renders @person chrome and conversation welcome copy — never "#Marina Loiseau".
    await user.click(screen.getByRole('button', { name: /Marina Loiseau/ }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Conversation privée avec Marina Loiseau' })
    ).toBeInTheDocument()
    expect(view.container.textContent).not.toContain('#Marina Loiseau')

    // Switching to simulation clears published RailDirects so DM faces never leak across modes/tenants.
    view.rerender(
      <>
        <RailProbe />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={{ ...store, simulation: true }}
        />
      </>
    )
    await waitFor(() => expect(screen.getByTestId('rail-directs-count')).toHaveTextContent('-1'))
  })
})

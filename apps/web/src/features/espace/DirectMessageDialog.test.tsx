import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { DirectMessageDialog } from './DirectMessageDialog'
import { EspaceLiveView, type EspaceStoreLike } from './EspaceLiveView'
import type { CanvasMode } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'

vi.mock('../workspace/quotasApi', () => ({
  useWorkspaceQuotasQuery: () => ({ data: undefined, refetch: vi.fn() }),
}))

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const DM_ROOM = '!dm:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const PEER = '@marina.loiseau:matrix.acme.kodera.io'

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
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
          is_confidential: false,
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

function makeStore(openDirect?: EspaceStoreLike['openDirect']): EspaceStoreLike {
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
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
    ],
    invites: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: () => [],
    getThread: () => [],
    getRoster: (roomId) =>
      roomId === ROOM ? [{ userId: PEER, name: 'Marina\u202E Loiseau' }] : [],
    getDirects: () => [{ roomId: DM_ROOM, userIds: [PEER], name: 'Marina Loiseau', unread: 0 }],
    ...(openDirect === undefined ? {} : { openDirect }),
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  }
}

describe('DirectMessageDialog and canvas mode switching', () => {
  it('guards busy double-submit, wraps MXID in bdi[dir="ltr"], and never navigates after cancel', async () => {
    const user = userEvent.setup()
    let finishOpen: (roomId: string) => void = () => undefined
    const openDirect = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishOpen = resolve
        })
    )
    const onOpenChange = vi.fn()
    const onOpened = vi.fn()

    render(
      <DirectMessageDialog
        open
        onOpenChange={onOpenChange}
        store={makeStore(openDirect)}
        searchEntries={[{ id: GENERAL, label: 'général', kind: 'text' }]}
        onOpened={onOpened}
      />
    )

    expect(screen.getByText('Marina Loiseau')).toBeVisible()
    const bdi = screen.getByText(PEER)
    expect(bdi.tagName.toLowerCase()).toBe('bdi')
    expect(bdi).toHaveAttribute('dir', 'ltr')

    // issue 180: Ordinary Matrix DM rooms do not render a false E2EE checkbox/claim prior to H4.3b.
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText(/chiffrée de bout en bout|end-to-end encrypted/i)).toBeNull()

    await user.click(screen.getByRole('button', { name: /Marina Loiseau/ }))
    const openBtn = screen.getByRole('button', { name: 'Ouvrir la conversation' })
    await user.click(openBtn)
    expect(openDirect).toHaveBeenCalledTimes(1)
    expect(openDirect).toHaveBeenCalledWith([PEER])
    expect(openBtn).toBeDisabled()

    // Cancel while openDirect is still in flight
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await act(async () => finishOpen(DM_ROOM))
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('clears an active DM when switching to Docs and hides chat-only actions above Files', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [mode, setMode] = useState<CanvasMode>('chat')
      return (
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={makeStore()}
          activeCanvasMode={mode}
          onChangeCanvasMode={setMode}
          docsCanvasSlot={<div data-testid="rendered-docs-slot">Channel docs ready</div>}
        />
      )
    }

    render(<Harness />)
    // Select DM in sidebar
    await user.click(screen.getByRole('button', { name: 'Marina Loiseau' }))
    expect(screen.getByRole('heading', { level: 1, name: /Marina Loiseau/ })).toBeVisible()

    // Switch from active DM to Docs -> DM is cleared and Docs canvas renders (never blank!)
    await user.click(screen.getByRole('button', { name: 'Drive & Docs' }))
    expect(screen.getByTestId('rendered-docs-slot')).toBeVisible()
    expect(screen.getByRole('link', { name: 'général' })).not.toHaveAttribute('aria-current')

    // The unified tool keeps channel-only actions out of the documents canvas.
    expect(screen.getByRole('link', { name: 'général' })).not.toHaveAttribute('aria-current')
    expect(screen.queryByRole('button', { name: 'Inviter' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Messages épinglés/ })).toBeNull()
  })
})

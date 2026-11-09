import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import { EmergencyRoomPanel } from '../emergency/EmergencyRoomPanel'
import { EspaceLiveView, type EspaceStoreLike, isEmergencyChannel } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, MemberView } from './matrix/store'
import type { MessageView } from './matrix/timeline'

const GENERAL_ID = 'a1111111-1111-4111-8111-000000000001'
const URGENCE_ID = 'a1111111-1111-4111-8111-000000000911'
const GENERAL_ROOM = '!general:matrix.acme.kodera.io'
const URGENCE_ROOM = '!urgence:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@marina.loiseau:matrix.acme.kodera.io'

const GENERAL_CHANNEL: WorkspaceChannel = {
  id: GENERAL_ID,
  kind: 'text',
  name: 'general',
  template_key: 'general',
  topic: '',
  lifecycle: 'active',
  room_state: 'ready',
}

const URGENCE_CHANNEL: WorkspaceChannel = {
  id: URGENCE_ID,
  kind: 'text',
  name: 'urgence',
  template_key: null,
  topic: 'Continuité bâtiment et pointage de sécurité',
  lifecycle: 'active',
  room_state: 'ready',
}

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
      channels: [GENERAL_CHANNEL, URGENCE_CHANNEL],
    },
  ],
  uncategorised_channels: [],
}

const BASE_TS_MS = 1_762_520_100_000

function makeMessage(eventId: string, sender: string, body: string): MessageView {
  return {
    key: eventId,
    eventId,
    sender,
    body,
    ts: BASE_TS_MS,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

const MEMBERS: readonly MemberView[] = [{ userId: ALICE, name: 'Marina Loiseau' }]

function makeStore(): EspaceStoreLike {
  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>([
      [GENERAL_ID, { state: 'resolved', roomId: GENERAL_ROOM }],
      [URGENCE_ID, { state: 'resolved', roomId: URGENCE_ROOM }],
    ]),
    rooms: [
      {
        roomId: GENERAL_ROOM,
        name: 'general',
        alias: null,
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
      {
        roomId: URGENCE_ROOM,
        name: 'urgence',
        alias: null,
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
    ],
    invites: [],
  }

  const timelines: Record<string, readonly MessageView[]> = {
    [GENERAL_ROOM]: [makeMessage('$g1', ALICE, 'Bonjour dans #général')],
    [URGENCE_ROOM]: [makeMessage('$u1', ALICE, 'Exercice incendie en cours')],
  }

  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: (roomId: string) => timelines[roomId] ?? [],
    getThread: () => [],
    getMembers: () => MEMBERS,
    loadMembers: vi.fn<(roomId: string) => void>(),
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  }
}

const FLAGGED: ReadonlySet<string> = new Set([URGENCE_ID])

function renderPanel(channel: WorkspaceChannel) {
  return <EmergencyRoomPanel channelName={channel.name} />
}

describe('EspaceLiveView proximity room', () => {
  it('trusts only the server flag, never the channel name', () => {
    expect(isEmergencyChannel(null, FLAGGED)).toBe(false)
    expect(isEmergencyChannel(undefined, FLAGGED)).toBe(false)
    expect(isEmergencyChannel(GENERAL_CHANNEL, FLAGGED)).toBe(false)
    expect(isEmergencyChannel(URGENCE_CHANNEL, FLAGGED)).toBe(true)
    // A channel its members called « urgence » or « around-me » is an ordinary channel.
    expect(isEmergencyChannel(URGENCE_CHANNEL, undefined)).toBe(false)
    expect(isEmergencyChannel({ ...GENERAL_CHANNEL, name: 'Urgence' }, FLAGGED)).toBe(false)
    expect(isEmergencyChannel({ ...GENERAL_CHANNEL, name: 'around-me' }, FLAGGED)).toBe(false)
  })

  it('mounts nothing on a channel named « urgence » when the server flags no channel (the product today)', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL_ID}
        store={makeStore()}
      />
    )
    await user.click(screen.getByRole('link', { name: /urgence/i }))
    expect(screen.getByText('Exercice incendie en cours')).toBeInTheDocument()
    expect(screen.queryByTestId('espace-emergency-room-surface')).toBeNull()
    expect(screen.queryByTestId('emergency-room-panel')).toBeNull()
  })

  it('draws the flagged room’s panel above its timeline, « Non connecté » without a transport', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL_ID}
        store={makeStore()}
        emergencyChannelIds={FLAGGED}
        renderEmergencyPanel={renderPanel}
      />
    )
    expect(screen.queryByTestId('emergency-room-panel')).toBeNull()
    expect(screen.getByText('Bonjour dans #général')).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /urgence/i }))
    const panel = screen.getByTestId('emergency-room-panel')
    expect(within(panel).getByRole('heading', { name: 'Autour de moi' })).toBeInTheDocument()
    expect(panel).toHaveTextContent('Non connecté')
    expect(within(panel).queryByRole('button')).toBeNull()
    expect(screen.getByText('Exercice incendie en cours')).toBeInTheDocument()
  })
})

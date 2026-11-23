import { act, createRef } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { RoomBoundary } from '../confidential/room-boundary'
import { MessagingOrganisation } from '../messaging/organisationContext'
import { CallCompanionChatDrawer } from './CallCompanionChatDrawer'
import { createLocalDrafts, useDraftChannel } from './draftChannel'
import type { CallChannel, EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { MessageComposer } from './MessageComposer'

const { uploadAttachment } = vi.hoisted(() => ({ uploadAttachment: vi.fn() }))
vi.mock('../messaging/attachments/uploadAttachment', async () => ({
  ...(await vi.importActual('../messaging/attachments/uploadAttachment')),
  uploadAttachment,
}))

const CHANNEL_UUID = '018f1234-5678-7000-8000-000000000099'
const ATTACHMENT_UUID = '018f1234-5678-7000-8000-000000000077'
const ROOM = '!standup:kodera.test'
const ME = '@me:kodera.test'
const ALICE = '@alice:kodera.test'

const CHANNEL: CallChannel = {
  channelId: CHANNEL_UUID,
  roomId: ROOM,
  roomName: 'standup',
  categoryName: 'Équipe',
}

beforeAll(async () => {
  await i18n.changeLanguage('fr')
})

beforeEach(() => {
  uploadAttachment.mockReset()
})

function buildMessage(overrides: Partial<MessageView> = {}): MessageView {
  return {
    key: '$evt-1',
    eventId: '$evt-1',
    sender: ALICE,
    senderName: 'Alice Martin',
    body: 'Voici le lien de la maquette.',
    ts: 1_700_000_000_000,
    delivery: 'sent',
    edited: false,
    redacted: false,
    replyTo: null,
    reactions: [{ key: '👍', count: 1, mine: false }],
    ...overrides,
  }
}

function createCompanionStore(
  options: {
    boundary?: RoomBoundary | 'omit'
    unread?: number
    messages?: readonly MessageView[]
  } = {}
) {
  let timeline = [...(options.messages ?? [buildMessage()])]
  let unread = options.unread ?? 0
  let boundary: RoomBoundary | 'omit' = options.boundary ?? 'ordinary'
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const getSnapshot = () =>
    ({
      status: 'live',
      channels: new Map([[CHANNEL_UUID, { state: 'resolved', roomId: ROOM }]]),
      rooms: [
        {
          roomId: ROOM,
          name: 'standup',
          alias: '#standup:kodera.test',
          kind: 'audio',
          unread,
          mentions: 0,
          occupancy: { participants: [ME, ALICE], screenShare: [] },
          names: { [ME]: 'ZôÖma', [ALICE]: 'Alice Martin' },
        },
      ],
      invites: [],
    }) as unknown as EspaceSnapshot

  let snapshot = getSnapshot()
  const refresh = () => {
    snapshot = getSnapshot()
    notify()
  }

  const getTimeline = vi.fn(() => timeline)
  const send = vi.fn(async () => undefined)
  const edit = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const toggleReaction = vi.fn(async () => undefined)
  const resend = vi.fn(async () => undefined)
  const markRead = vi.fn(async () => {
    unread = 0
    refresh()
  })

  const store: EspaceStoreLike = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline,
    getThread: () => [],
    getMembers: () => [
      { userId: ME, name: 'ZôÖma' },
      { userId: ALICE, name: 'Alice Martin' },
    ],
    getRoster: () => [{ userId: ALICE, name: 'Alice Martin' }],
    ...(boundary === 'omit'
      ? {}
      : {
          getRoomBoundary: () => boundary as RoomBoundary,
        }),
    send,
    edit,
    remove,
    toggleReaction,
    resend,
    markRead,
  }

  return {
    store,
    send,
    edit,
    remove,
    toggleReaction,
    resend,
    markRead,
    getTimeline,
    pushMessage: (msg: MessageView, nextUnread = unread + 1) =>
      act(() => {
        timeline = [...timeline, msg]
        unread = nextUnread
        refresh()
      }),
    setBoundary: (next: RoomBoundary) =>
      act(() => {
        boundary = next
        refresh()
      }),
  }
}

describe('CallCompanionChatDrawer', () => {
  it('sends messages with @mentions, replies inline, edits/removes own messages, and toggles reactions in the 1:1 audio room', async () => {
    const user = userEvent.setup()
    const { store, send, edit, remove, toggleReaction } = createCompanionStore({
      messages: [
        buildMessage(),
        buildMessage({
          key: '$evt-own',
          eventId: '$evt-own',
          sender: ME,
          senderName: 'ZôÖma',
          body: 'Mon premier message',
          ts: 1_700_000_010_000,
          reactions: [],
        }),
      ],
    })

    render(<CallCompanionChatDrawer store={store} channel={CHANNEL} viewerId={ME} open />)

    expect(screen.getByText('Voici le lien de la maquette.')).toBeInTheDocument()

    // Toggle reaction on Alice's message
    await user.click(screen.getByRole('button', { name: '👍 1' }))
    expect(toggleReaction).toHaveBeenCalledWith(ROOM, '$evt-1', '👍')

    // Start an inline reply to Alice's message from its action menu
    await user.click(screen.getByRole('button', { name: /Actions du message de Alice Martin/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Répondre' }))
    expect(screen.getByText(/En réponse à/)).toBeInTheDocument()

    // Send reply naming @Alice Martin
    const composer = screen.getByRole('textbox', { name: /standup/ })
    await user.type(composer, 'Merci @Alice Martin !')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(ROOM, 'Merci @Alice Martin !', {
        replyTo: '$evt-1',
        mentions: [ALICE],
        mentionTargets: [{ userId: ALICE, label: 'Alice Martin' }],
      })
    )

    // Edit own message via ArrowUp shortcut, then save
    composer.focus()
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('Mon premier message')
    await user.type(composer, ' mis à jour')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith(ROOM, '$evt-own', 'Mon premier message mis à jour')
    )

    // Remove own message via its action menu
    await user.click(screen.getByRole('button', { name: /Actions du message de ZôÖma/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Supprimer' }))
    expect(remove).toHaveBeenCalledWith(ROOM, '$evt-own')
  })

  it('uploads channel-scoped attachments via AttachmentQueue and sends attachment refs', async () => {
    const user = userEvent.setup()
    const { store, send } = createCompanionStore()
    uploadAttachment.mockResolvedValue({
      id: ATTACHMENT_UUID,
      filename: 'cadrage.txt',
      contentType: 'text/plain',
      sizeBytes: 14,
    })

    const { container } = render(
      <MessagingOrganisation value="org-1">
        <CallCompanionChatDrawer store={store} channel={CHANNEL} viewerId={ME} open />
      </MessagingOrganisation>
    )

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(fileInput).not.toBeNull()
    const file = new File(['notes de point'], 'cadrage.txt', { type: 'text/plain' })
    await user.upload(fileInput, file)

    await waitFor(() =>
      expect(uploadAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          organisationId: 'org-1',
          channelId: CHANNEL_UUID,
        })
      )
    )

    const composer = screen.getByRole('textbox', { name: /standup/ })
    await user.type(composer, 'Document joint')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(ROOM, 'Document joint', {
        attachments: [
          {
            id: ATTACHMENT_UUID,
            filename: 'cadrage.txt',
            contentType: 'text/plain',
            sizeBytes: 14,
          },
        ],
      })
    )
  })

  it.each(['omit', 'unknown', 'confidential-unavailable', 'invalid'] as const)(
    'enforces fail-closed quarantine for %s room boundary without leaking timeline content',
    (boundaryCase) => {
      const { store, getTimeline } = createCompanionStore({
        boundary: boundaryCase,
        messages: [buildMessage({ body: 'SECRET_QUARANTINED_PAYLOAD' })],
      })

      render(<CallCompanionChatDrawer store={store} channel={CHANNEL} viewerId={ME} open />)

      expect(screen.getByTestId('call-companion-protection-quarantine')).toBeInTheDocument()
      expect(screen.queryByText('SECRET_QUARANTINED_PAYLOAD')).toBeNull()
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(getTimeline).not.toHaveBeenCalled()
    }
  )

  it('isolates unsent drafts, inline reply state, and input DOM IDs from the main workspace composer', async () => {
    const user = userEvent.setup()
    const { store } = createCompanionStore()

    function DualComposerHarness() {
      const mainLocal = createLocalDrafts()
      const mainDraft = useDraftChannel(null, null, mainLocal, `${ME}\n${ROOM}`)
      return (
        <div>
          <div data-testid="main-pane">
            <MessageComposer
              store={store}
              roomId={ROOM}
              viewerId={ME}
              draft={mainDraft}
              channelName="standup"
              simulation={false}
              narrow={false}
              navigationUnsettled={false}
              inputId="main-workspace-composer"
              guidanceId="main-guidance"
              members={[]}
              attachmentStaged={false}
              onStagingChange={() => undefined}
              onInvite={undefined}
              onMentionStart={() => undefined}
              onEdit={() => undefined}
              onAnnounce={() => undefined}
              mentionRef={createRef()}
              insertRef={createRef()}
            />
          </div>
          <div data-testid="companion-pane">
            <CallCompanionChatDrawer store={store} channel={CHANNEL} viewerId={ME} open />
          </div>
        </div>
      )
    }

    render(<DualComposerHarness />)

    const mainInput = within(screen.getByTestId('main-pane')).getByRole('textbox', {
      name: /standup/,
    })
    const companionInput = within(screen.getByTestId('companion-pane')).getByRole('textbox', {
      name: /standup/,
    })

    expect(mainInput.id).not.toBe(companionInput.id)

    await user.type(mainInput, 'Brouillon principal')
    await user.type(companionInput, 'Note rapide en appel')

    expect(mainInput).toHaveValue('Brouillon principal')
    expect(companionInput).toHaveValue('Note rapide en appel')

    // Trigger reply inside companion pane -> main pane shows no reply banner
    await user.click(
      within(screen.getByTestId('companion-pane')).getByRole('button', {
        name: /Actions du message de Alice Martin/,
      })
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Répondre' }))
    expect(
      within(screen.getByTestId('companion-pane')).getByText(/En réponse à/)
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('main-pane')).queryByText(/En réponse à/)).toBeNull()
  })

  it('calls markRead only while open === true', async () => {
    const { store, markRead, pushMessage } = createCompanionStore({ unread: 2 })

    const view = render(
      <CallCompanionChatDrawer store={store} channel={CHANNEL} viewerId={ME} open={false} />
    )
    expect(markRead).not.toHaveBeenCalled()

    view.rerender(<CallCompanionChatDrawer store={store} channel={CHANNEL} viewerId={ME} open />)
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1))
    expect(markRead).toHaveBeenCalledWith(ROOM)

    pushMessage(buildMessage({ key: '$evt-2', eventId: '$evt-2', body: 'Nouveau message' }), 1)
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2))
  })
})

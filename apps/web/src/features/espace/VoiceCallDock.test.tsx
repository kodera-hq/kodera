import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthAdapter, AuthSessionSnapshot } from '../../auth/AuthAdapter'
import { AuthProvider } from '../../auth/AuthProvider'
import { clearMatrixSession, registerMatrixSession } from '../../auth/matrix'
import i18n from '../../i18n'
import { MessagingOrganisation } from '../messaging/organisationContext'
import type { CallSnapshot } from './audio/call'
import { EspaceDraftProvider } from './EspaceDraftProvider'
import type { AudioCallLike, CallChannel, EspaceStoreLike } from './liveViewModel'
import type { EspaceSnapshot } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { CompanionDraftController, VoiceCallDock, type CompanionDraftScope } from './VoiceCallDock'

const ME = '@me:kodera.test'
const BOB = '@bob:kodera.test'
const ROOM = '!standup:kodera.test'

const CHANNEL: CallChannel = {
  channelId: 'standup',
  roomId: ROOM,
  roomName: 'Point quotidien',
  categoryName: 'Équipe',
}

import { pollStore } from '../polls/pollStore'

beforeAll(async () => {
  await i18n.changeLanguage('fr')
  await import('./CallCompanionChatDrawer')
})

const CONNECTED_CALL: CallSnapshot = {
  status: 'connected',
  roomId: ROOM,
  muted: false,
  deafened: false,
  listenOnly: false,
  speakers: [],
  participants: [ME, BOB],
  playbackBlocked: false,
  videos: [],
  camera: 'off',
  screen: 'off',
}

function createCall(initialSnapshot: CallSnapshot = CONNECTED_CALL) {
  let current = initialSnapshot
  const listeners = new Set<() => void>()
  const call: AudioCallLike = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => current,
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    setMuted: vi.fn(async () => undefined),
    setDeafened: vi.fn(async () => undefined),
    startAudio: vi.fn(async () => undefined),
  }
  return {
    call,
    setCallSnapshot: (next: Partial<CallSnapshot>) =>
      act(() => {
        current = { ...current, ...next }
        for (const listener of listeners) listener()
      }),
  }
}

function createLiveStore(
  options: {
    initialUnread?: number
    userId?: string
    roomId?: string
    deferMarkRead?: boolean
    initialMessages?: MessageView[]
  } = {}
) {
  const viewer = options.userId ?? ME
  const roomId = options.roomId ?? ROOM
  let unread = options.initialUnread ?? 0
  let messages: MessageView[] = options.initialMessages ?? [
    {
      key: '$evt-1',
      eventId: '$evt-1',
      sender: BOB,
      senderName: 'Bob Martin',
      body: 'Prêt pour la revue ?',
      ts: 1_700_000_000_000,
      delivery: 'sent',
      edited: false,
      redacted: false,
      replyTo: null,
      reactions: [],
    },
    {
      key: '$evt-own',
      eventId: '$evt-own',
      sender: viewer,
      senderName: 'ZôÖma',
      body: 'Ordre du jour partagé',
      ts: 1_700_000_002_000,
      delivery: 'sent',
      edited: false,
      redacted: false,
      replyTo: null,
      reactions: [],
    },
  ]
  const listeners = new Set<() => void>()
  const makeSnapshot = () =>
    ({
      status: 'live',
      channels: new Map([['standup', { state: 'resolved', roomId }]]),
      rooms: [
        {
          roomId,
          name: 'Point quotidien',
          alias: '#standup:kodera.test',
          kind: 'audio',
          unread,
          mentions: 0,
          occupancy: { participants: [viewer, BOB], screenShare: [] },
          names: { [viewer]: 'ZôÖma', [BOB]: 'Bob Martin' },
        },
      ],
      invites: [],
    }) as unknown as EspaceSnapshot

  let snapshot = makeSnapshot()
  const notify = () => {
    snapshot = makeSnapshot()
    for (const listener of listeners) listener()
  }

  const send = vi.fn(async () => undefined)
  const markRead = vi.fn(async () => {
    if (!options.deferMarkRead) {
      unread = 0
      notify()
    }
  })

  const store: EspaceStoreLike = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => viewer,
    getRoomBoundary: () => 'ordinary',
    getTimeline: () => messages,
    getThread: () => [],
    send,
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
    markRead,
  }

  return {
    store,
    send,
    markRead,
    setUnread: (nextUnread: number, newMessage?: string) =>
      act(() => {
        unread = nextUnread
        if (newMessage !== undefined) {
          const nextId = `$evt-${messages.length + 1}`
          messages = [
            ...messages,
            {
              key: nextId,
              eventId: nextId,
              sender: BOB,
              senderName: 'Bob Martin',
              body: newMessage,
              ts: 1_700_000_005_000 + messages.length * 1000,
              delivery: 'sent',
              edited: false,
              redacted: false,
              replyTo: null,
              reactions: [],
            },
          ]
        }
        notify()
      }),
    ackUnreadCount: (nextUnread: number) =>
      act(() => {
        unread = nextUnread
        notify()
      }),
  }
}

function createControllableAuthAdapter(params: { realm: string; issuer: string; subject: string }) {
  let token: string | undefined = 'core-token-1'
  let snapshot: AuthSessionSnapshot = {
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: {
      realm: params.realm,
      identity: {
        issuer: params.issuer,
        subject: params.subject,
      },
    },
  }
  const listeners = new Set<() => void>()
  const adapter: AuthAdapter = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    restoreSession: vi.fn(async () => true),
    getAccessToken: () => token,
    getExpiresAt: () => undefined,
    renew: vi.fn(async () => true),
    onRenewed: () => () => undefined,
    onRenewalFailed: () => () => undefined,
    getUser: () => snapshot.user,
    signIn: vi.fn(async () => undefined),
    handleCallback: vi.fn(async () => 'interactive' as const),
    signOut: vi.fn(async () => {
      token = undefined
      snapshot = {
        status: 'unauthenticated',
        generation: snapshot.generation + 1,
        credentialGeneration: snapshot.credentialGeneration + 1,
        user: undefined,
      }
      for (const listener of listeners) listener()
    }),
    onExpiring: () => () => undefined,
  }
  return {
    adapter,
    set: (patch: Partial<AuthSessionSnapshot>, nextToken?: string | null) => {
      if (nextToken !== undefined) {
        token = nextToken === null ? undefined : nextToken
      }
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    },
  }
}

describe('VoiceCallDock in-call companion chat integration', () => {
  it('increments live unread badge up to 99+, clears on open with markRead, and restores focus from the stage split-pane', async () => {
    const user = userEvent.setup()
    const { call } = createCall()
    const { store, markRead, setUnread } = createLiveStore({ initialUnread: 0 })

    render(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="stage"
      />
    )

    expect(screen.queryByTestId('companion-chat-unread')).toBeNull()

    setUnread(3, 'Trois messages')
    expect(screen.getByTestId('companion-chat-unread')).toHaveTextContent('3')

    setUnread(120)
    expect(screen.getByTestId('companion-chat-unread')).toHaveTextContent('99+')

    const toggleBtn = screen.getByRole('button', { name: 'Discussion de l’appel (99+)' })
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggleBtn)

    // Badge clears immediately, aria-expanded turns true, split-pane renders, and markRead fires
    expect(screen.queryByTestId('companion-chat-unread')).toBeNull()
    const expandedToggle = screen.getByRole('button', { name: 'Discussion de l’appel' })
    expect(expandedToggle).toHaveAttribute('aria-expanded', 'true')

    const splitPane = screen.getByTestId('call-companion-split-pane')
    expect(
      await within(splitPane).findByText('Trois messages', {}, { timeout: 5000 })
    ).toBeInTheDocument()
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(ROOM))

    // Closing split-pane restores focus to chatButtonRef
    await user.click(
      within(splitPane).getByRole('button', { name: 'Fermer la discussion de l’appel' })
    )
    expect(screen.queryByTestId('call-companion-split-pane')).toBeNull()
    expect(expandedToggle).toHaveFocus()
    expect(expandedToggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('tracks unread messages via event-key watermark so delayed read-receipt acks never hide newly arrived messages', async () => {
    const user = userEvent.setup()
    const { call } = createCall()
    const initialFive: MessageView[] = [1, 2, 3, 4, 5].map((index) => ({
      key: `$evt-${index}`,
      eventId: `$evt-${index}`,
      sender: BOB,
      senderName: 'Bob Martin',
      body: `Ancien message ${index}`,
      ts: 1_700_000_000_000 + index * 1000,
      delivery: 'sent',
      edited: false,
      redacted: false,
      replyTo: null,
      reactions: [],
    }))
    const { store, setUnread, ackUnreadCount } = createLiveStore({
      initialUnread: 5,
      deferMarkRead: true,
      initialMessages: initialFive,
    })

    render(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="stage"
      />
    )

    // Open at 5 unread
    expect(screen.getByTestId('companion-chat-unread')).toHaveTextContent('5')
    await user.click(screen.getByRole('button', { name: 'Discussion de l’appel (5)' }))
    const splitPane = screen.getByTestId('call-companion-split-pane')
    expect(await within(splitPane).findByText('Ancien message 5')).toBeInTheDocument()
    expect(screen.queryByTestId('companion-chat-unread')).toBeNull()

    // Close before read receipt is acknowledged (callRoom.unread is still 5)
    await user.click(
      within(splitPane).getByRole('button', { name: 'Fermer la discussion de l’appel' })
    )
    expect(screen.queryByTestId('companion-chat-unread')).toBeNull()

    // New message $m-6 arrives from Bob (unread rises to 6) -> badge shows 1
    setUnread(6, 'Nouveau message six')
    expect(screen.getByTestId('companion-chat-unread')).toHaveTextContent('1')

    // Delayed read receipt for $m-1..$m-5 finally arrives, reducing callRoom.unread from 6 to 1 -> badge still shows 1!
    ackUnreadCount(1)
    expect(screen.getByTestId('companion-chat-unread')).toHaveTextContent('1')
  })

  it.each([
    { placement: 'sidebar' as const, narrow: false },
    { placement: 'floating' as const, narrow: false },
    { placement: 'stage' as const, narrow: true },
  ])(
    'opens a Drawer in $placement (narrow=$narrow) and restores focus to chatButtonRef on Escape',
    async ({ placement, narrow }) => {
      const user = userEvent.setup()
      const { call } = createCall()
      const { store } = createLiveStore({ initialUnread: 2 })

      render(
        <VoiceCallDock
          call={call}
          channel={CHANNEL}
          store={store}
          viewerId={ME}
          deviceSettings={null}
          meterRef={{ current: null }}
          panelMeterRef={{ current: null }}
          placement={placement}
          narrow={narrow}
        />
      )

      const chatBtn = screen.getByRole('button', { name: 'Discussion de l’appel (2)' })
      await user.click(chatBtn)

      expect(screen.queryByTestId('call-companion-split-pane')).toBeNull()
      const dialog = await screen.findByRole('dialog', { name: 'Discussion de l’appel' })
      expect(await within(dialog).findByText('Prêt pour la revue ?')).toBeInTheDocument()

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      const restoredBtn = screen.getByRole('button', { name: 'Discussion de l’appel' })
      expect(restoredBtn).toHaveFocus()
      expect(restoredBtn).toHaveAttribute('aria-expanded', 'false')
    }
  )

  it('cancels active inline reply or edit on the first Escape while keeping the Drawer open, then closes on the second Escape', async () => {
    const user = userEvent.setup()
    const { call } = createCall()
    const { store } = createLiveStore({ initialUnread: 0 })

    render(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="sidebar"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Discussion de l’appel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discussion de l’appel' })
    expect(await within(dialog).findByText('Prêt pour la revue ?')).toBeInTheDocument()

    // Start an inline reply inside the Drawer
    await user.click(
      within(dialog).getByRole('button', { name: /Actions du message de Bob Martin/ })
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Répondre' }))
    expect(within(dialog).getByText(/En réponse à/)).toBeInTheDocument()

    // First Escape cancels the inline reply and keeps the Drawer open
    await user.keyboard('{Escape}')
    expect(within(dialog).queryByText(/En réponse à/)).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Discussion de l’appel' })).toBeInTheDocument()

    // Start an inline edit via ArrowUp -> Escape cancels edit first and keeps the Drawer open
    const composer = within(dialog).getByRole('textbox', { name: /Point quotidien/ })
    composer.focus()
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('Ordre du jour partagé')
    await user.keyboard('{Escape}')
    expect(composer).toHaveValue('')
    expect(screen.getByRole('dialog', { name: 'Discussion de l’appel' })).toBeInTheDocument()

    // Second Escape (no active inline target) closes the Drawer and restores focus
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Discussion de l’appel' })).toHaveFocus()
  })

  it('preserves unsent companion text and inline reply across closing/reopening and split-pane <-> Drawer switches, and scrubs when the call ends', async () => {
    const user = userEvent.setup()
    const { call, setCallSnapshot } = createCall()
    const { store } = createLiveStore({ initialUnread: 0 })

    const view = render(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="stage"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Discussion de l’appel' }))
    const splitPane = screen.getByTestId('call-companion-split-pane')
    expect(await within(splitPane).findByText('Prêt pour la revue ?')).toBeInTheDocument()

    await user.click(
      within(splitPane).getByRole('button', { name: /Actions du message de Bob Martin/ })
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Répondre' }))
    const stageComposer = within(splitPane).getByRole('textbox', { name: /Point quotidien/ })
    await user.type(stageComposer, 'Brouillon conservé')
    expect(within(splitPane).getByText(/En réponse à/)).toBeInTheDocument()

    // Close and reopen in stage mode -> draft + reply preserved
    await user.click(
      within(splitPane).getByRole('button', { name: 'Fermer la discussion de l’appel' })
    )
    expect(screen.queryByTestId('call-companion-split-pane')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Discussion de l’appel' }))

    const reopenedSplit = screen.getByTestId('call-companion-split-pane')
    expect(await within(reopenedSplit).findByDisplayValue('Brouillon conservé')).toBeInTheDocument()
    expect(within(reopenedSplit).getByText(/En réponse à/)).toBeInTheDocument()

    // Switch from stage split-pane to sidebar Drawer -> draft + reply preserved
    view.rerender(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="sidebar"
      />
    )
    const drawerDialog = await screen.findByRole('dialog', { name: 'Discussion de l’appel' })
    expect(await within(drawerDialog).findByDisplayValue('Brouillon conservé')).toBeInTheDocument()
    expect(within(drawerDialog).getByText(/En réponse à/)).toBeInTheDocument()

    // End the call and reconnect -> draft and reply are scrubbed
    setCallSnapshot({ status: 'ended' })
    setCallSnapshot({ status: 'connected' })
    view.rerender(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="stage"
      />
    )
    await user.click(screen.getByRole('button', { name: 'Discussion de l’appel' }))
    const freshPane = screen.getByTestId('call-companion-split-pane')
    const freshComposer = await within(freshPane).findByRole('textbox', {
      name: /Point quotidien/,
    })
    expect(freshComposer).toHaveValue('')
    expect(within(freshPane).queryByText(/En réponse à/)).toBeNull()
  })

  it('suspends the companion composer during EspaceDraftProvider credential rotation, restores on acceptance, and scrubs on sign-out', async () => {
    const user = userEvent.setup()
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
    const orgId = '11111111-1111-4111-8111-111111111111'
    const subject = 'draft-subject'
    const server = 'acme-chat.kodera.test'
    const userId = `@${subject}:${server}`
    const roomId = `!standup:${server}`
    const channel: CallChannel = {
      channelId: 'standup',
      roomId,
      roomName: 'Point quotidien',
      categoryName: 'Équipe',
    }

    registerMatrixSession({
      baseUrl: `https://matrix.${server}`,
      userId,
      deviceId: 'DEV1',
      accessToken: 'mtx-token-1',
      refreshToken: 'mtx-refresh-1',
      refresh: async () => ({ accessToken: 'mtx-token-2' }),
    })

    try {
      const auth = createControllableAuthAdapter({
        realm: 'acme-sa',
        issuer: 'https://id.kodera.test/realms/acme-sa',
        subject,
      })
      const { call } = createCall({ ...CONNECTED_CALL, roomId, participants: [userId, BOB] })
      const { store, send } = createLiveStore({ userId, roomId, initialUnread: 0 })

      const renderWithAuthority = (meCredentialGeneration: number) => (
        <AuthProvider adapter={auth.adapter}>
          <EspaceDraftProvider
            org="acme-sa"
            organisationId={orgId}
            meGeneration={1}
            meCredentialGeneration={meCredentialGeneration}
            tenantSlugFor={() => 'acme-chat'}
          >
            <MessagingOrganisation value={orgId}>
              <VoiceCallDock
                call={call}
                channel={channel}
                store={store}
                viewerId={userId}
                deviceSettings={null}
                meterRef={{ current: null }}
                panelMeterRef={{ current: null }}
                placement="stage"
              />
            </MessagingOrganisation>
          </EspaceDraftProvider>
        </AuthProvider>
      )

      const view = render(renderWithAuthority(1))

      await user.click(screen.getByRole('button', { name: 'Discussion de l’appel' }))
      const splitPane = screen.getByTestId('call-companion-split-pane')
      const composer = await within(splitPane).findByRole('textbox', { name: /Point quotidien/ })
      await user.type(composer, 'Note protégée pendant rotation')
      expect(composer).toHaveValue('Note protégée pendant rotation')

      // Credential rotates to generation 2 before EspaceDraftProvider accepts it -> suspended!
      act(() => {
        auth.set({ credentialGeneration: 2 }, 'core-token-2')
      })
      expect(composer).toHaveValue('')
      await user.keyboard('{Enter}')
      expect(send).not.toHaveBeenCalled()

      // EspaceDraftProvider accepts meCredentialGeneration=2 -> unsent draft is restored and can be sent!
      view.rerender(renderWithAuthority(2))
      await waitFor(() => expect(composer).toHaveValue('Note protégée pendant rotation'))

      // Terminal sign-out permanently scrubs the companion draft
      await act(async () => {
        await auth.adapter.signOut()
      })
      expect(composer).toHaveValue('')
    } finally {
      clearMatrixSession()
      vi.unstubAllEnvs()
    }
  })

  it('retires retained draft handles monotonically on call end, quarantine, or viewer change without reactivating old scopes', () => {
    const { store } = createLiveStore({ initialUnread: 0 })
    const activeScope: CompanionDraftScope = {
      memory: null,
      organisationId: null,
      store,
      viewerId: ME,
      roomId: ROOM,
      protectionUnavailable: false,
    }

    const controller = new CompanionDraftController(activeScope)
    const retained = controller.channelFor(activeScope)

    const liveEffect = vi.fn()
    retained.update({ text: 'Brouillon actif' })
    expect(retained.read().text).toBe('Brouillon actif')
    expect(retained.command(liveEffect)).toBe(true)
    expect(liveEffect).toHaveBeenCalledTimes(1)

    // Call ends (roomId -> null): retained handle must never reactivate old scope
    controller.sync({ ...activeScope, roomId: null })
    const afterEndEffect = vi.fn()
    retained.update({ text: 'Tentative après fin' })
    expect(retained.read().text).toBe('')
    expect(retained.command(afterEndEffect)).toBe(false)
    expect(afterEndEffect).not.toHaveBeenCalled()

    // Even after rejoining the same room, the pre-retirement handle stays permanently dead
    controller.sync(activeScope)
    expect(retained.command(afterEndEffect)).toBe(false)
    expect(afterEndEffect).not.toHaveBeenCalled()

    const fresh = controller.channelFor(activeScope)
    fresh.update({ text: 'Nouvel appel' })
    expect(fresh.read().text).toBe('Nouvel appel')

    // Quarantine (protectionUnavailable -> true): fresh handle immediately retires and cannot execute commands
    controller.sync({ ...activeScope, protectionUnavailable: true })
    const quarantineEffect = vi.fn()
    fresh.update({ text: 'Interdit' })
    expect(fresh.read().text).toBe('')
    expect(fresh.command(quarantineEffect)).toBe(false)
    expect(quarantineEffect).not.toHaveBeenCalled()

    // Lifting quarantine still keeps the pre-quarantine handle retired
    controller.sync(activeScope)
    expect(fresh.command(quarantineEffect)).toBe(false)
  })

  it('mounts collapsible active-poll overlay banner on stage and active-poll badge on FloatingCallPill', async () => {
    const user = userEvent.setup()
    pollStore.clearAll()
    const { call } = createCall()
    const { store } = createLiveStore()

    act(() => {
      pollStore.recordLocalPoll({
        roomId: ROOM,
        payload: {
          question: 'Créneau rétro ?',
          options: ['Jeudi 15h', 'Vendredi 10h'],
          allowMultiple: false,
          anonymous: false,
        },
        createdBy: ME,
        createdByName: 'ZôÖma',
      })
    })

    const { rerender } = render(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="stage"
      />
    )

    const banner = screen.getByTestId('call-active-poll-banner')
    expect(within(banner).getByText('Créneau rétro ?')).toBeInTheDocument()

    const toggle = screen.getByTestId('call-poll-banner-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(banner).getByText('Jeudi 15h')).toBeInTheDocument()

    rerender(
      <VoiceCallDock
        call={call}
        channel={CHANNEL}
        store={store}
        viewerId={ME}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="floating"
      />
    )
    expect(screen.getByTestId('floating-pill-poll-badge')).toHaveTextContent('1')
    pollStore.clearAll()
  })
})

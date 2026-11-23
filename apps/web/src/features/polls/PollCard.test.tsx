import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMatrixSession, registerMatrixSession } from '../../auth/matrix'
import i18n from '../../i18n'
import { createLocalDrafts, type DraftChannel } from '../espace/draftChannel'
import type { AudioCallLike, EspaceStoreLike } from '../espace/liveViewModel'
import { MessageComposer } from '../espace/MessageComposer'
import { FloatingCallPill } from '../espace/audio/FloatingCallPill'
import { VoiceCallDock } from '../espace/VoiceCallDock'
import { PollCard } from './PollCard'
import {
  POLL_END_EVENT,
  POLL_RESPONSE_EVENT,
  createChannelPoll,
  parsePollCommand,
} from './pollState'
import { pollStore } from './pollStore'

const ROOM = '!call-room:acme.kodera.io'
const VIEWER = '@alice:acme.kodera.io'

afterEach(async () => {
  await act(async () => {
    pollStore.clearAll()
    await i18n.changeLanguage('fr')
  })
})

describe('Localized PollCard, /poll composer integration, and live call poll overlay', () => {
  it('localizes PollCard in French and English and supports voting and closing', async () => {
    const user = userEvent.setup()
    const poll = createChannelPoll({
      id: 'poll-1',
      roomId: ROOM,
      question: 'Ship release today?',
      options: ['Yes', 'Tomorrow'],
      createdBy: VIEWER,
      createdByName: 'Alice',
    })
    const onVote = vi.fn()
    const onClose = vi.fn()

    const { rerender } = render(
      <PollCard
        poll={poll}
        currentUserId={VIEWER}
        locale="fr"
        onVote={onVote}
        onClosePoll={onClose}
      />
    )
    expect(screen.getByText('Sondage en cours')).toBeInTheDocument()
    expect(screen.getByText('Clôturer le sondage')).toBeInTheDocument()

    rerender(
      <PollCard
        poll={poll}
        currentUserId={VIEWER}
        locale="en"
        onVote={onVote}
        onClosePoll={onClose}
      />
    )
    expect(screen.getByText('Active poll')).toBeInTheDocument()
    expect(screen.getByText('Close poll')).toBeInTheDocument()

    await user.click(screen.getByTestId('poll-option-1'))
    expect(onVote).toHaveBeenCalledWith('poll-1', 'poll-1-opt-1')

    await user.click(screen.getByTestId('poll-close-btn'))
    expect(onClose).toHaveBeenCalledWith('poll-1')
  })

  it('parses both quoted /poll commands and multiline /poll drafts', () => {
    expect(parsePollCommand('/poll "Architecture ?" "Monorepo" "Polyrepo" --multiple', 'fr')).toEqual({
      ok: true,
      question: 'Architecture ?',
      options: ['Monorepo', 'Polyrepo'],
      allowMultiple: true,
      anonymous: false,
    })

    expect(parsePollCommand('/poll Sprint focus?\n- Audio\n- AI Guardrail', 'en')).toEqual({
      ok: true,
      question: 'Sprint focus?',
      options: ['Audio', 'AI Guardrail'],
      allowMultiple: false,
      anonymous: false,
    })
  })

  it('submits /poll from MessageComposer with io.kodera.poll and renders Call overlay banner + FloatingCallPill badge', async () => {
    const user = userEvent.setup()
    const send = vi.fn(async () => undefined)
    const localDrafts = createLocalDrafts()
    const key = `${VIEWER}\n${ROOM}`
    const draft: DraftChannel = {
      subscribe: localDrafts.subscribe,
      read: () => localDrafts.read(key),
      update: (patch) => localDrafts.update(key, patch),
      command: (effect, patch) => {
        if (patch !== undefined) localDrafts.update(key, patch)
        effect()
        return true
      },
    }

    const emptySnapshot = { status: 'live', channels: new Map(), rooms: [], invites: [] }
    const emptyList: readonly never[] = []
    const store = {
      subscribe: () => () => undefined,
      getSnapshot: () => emptySnapshot,
      getUserId: () => VIEWER,
      getRoomBoundary: () => 'ordinary',
      getTimeline: () => emptyList,
      getThread: () => emptyList,
      send,
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
    } as unknown as EspaceStoreLike

    render(
      <MessageComposer
        store={store}
        roomId={ROOM}
        viewerId={VIEWER}
        draft={draft}
        channelName="standup"
        simulation={false}
        narrow={false}
        navigationUnsettled={false}
        inputId="poll-composer"
        guidanceId="poll-guidance"
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
    )

    const textbox = screen.getByRole('textbox', { name: /standup/ })
    await user.type(textbox, '/poll "Ordre du jour ?" "Audio" "Sécurité"')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        ROOM,
        expect.stringContaining('Ordre du jour ?'),
        expect.objectContaining({
          poll: {
            question: 'Ordre du jour ?',
            options: ['Audio', 'Sécurité'],
            allowMultiple: false,
            anonymous: false,
          },
        })
      )
    )

    const callSnapshot = {
      status: 'connected' as const,
      roomId: ROOM,
      muted: false,
      deafened: false,
      listenOnly: false,
      speakers: [],
      participants: [VIEWER],
      playbackBlocked: false,
    }
    const call: AudioCallLike = {
      subscribe: () => () => undefined,
      getSnapshot: () => callSnapshot,
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      setMuted: vi.fn(async () => undefined),
      setDeafened: vi.fn(async () => undefined),
      startAudio: vi.fn(async () => undefined),
    }

    render(
      <VoiceCallDock
        call={call}
        channel={{ channelId: 'ch-1', roomId: ROOM, roomName: 'Standup', categoryName: 'Équipe' }}
        store={store}
        viewerId={VIEWER}
        deviceSettings={null}
        meterRef={{ current: null }}
        panelMeterRef={{ current: null }}
        placement="stage"
      />
    )

    expect(screen.getByTestId('call-active-poll-banner')).toHaveTextContent('Ordre du jour ?')
    await user.click(screen.getByTestId('call-poll-banner-toggle'))
    expect(screen.getByTestId('kodera-poll-card')).toBeInTheDocument()

    render(
      <FloatingCallPill
        label="Appel en cours"
        room="Standup"
        status="connected"
        statusLabel="Connecté"
        muted={false}
        deafened={false}
        activePollCount={1}
        activePollLabel="Sondage actif : Ordre du jour ?"
        onToggleMute={vi.fn()}
        onToggleDeafen={vi.fn()}
        onOpenCall={vi.fn()}
        onRedock={vi.fn()}
        onLeave={vi.fn()}
        labels={{
          mute: 'Micro',
          deafen: 'Son',
          leave: 'Quitter',
          openCall: 'Ouvrir',
          redock: 'Rattacher',
        }}
      />
    )
    expect(screen.getByTestId('floating-pill-poll-badge')).toHaveTextContent('1')
  })

  it('restricts Close Poll to creator/moderators, migrates local-poll votes on Matrix echo, refuses confidential /poll, and clears on logout', async () => {
    const user = userEvent.setup()
    const sendEvent = vi.fn(async () => undefined)

    // 1) Non-creator without moderator right does not see Close Poll; moderator does.
    const poll = createChannelPoll({
      id: '$poll-event-1',
      roomId: ROOM,
      question: 'Release target?',
      options: ['Today', 'Monday'],
      createdBy: VIEWER,
      createdByName: 'Alice',
    })
    const { rerender, unmount } = render(
      <PollCard
        poll={poll}
        currentUserId="@bob:acme.kodera.io"
        locale="en"
        onVote={vi.fn()}
        onClosePoll={vi.fn()}
      />
    )
    expect(screen.queryByTestId('poll-close-btn')).toBeNull()

    rerender(
      <PollCard
        poll={poll}
        currentUserId="@mod:acme.kodera.io"
        canClose
        locale="en"
        onVote={vi.fn()}
        onClosePoll={vi.fn()}
      />
    )
    expect(screen.getByTestId('poll-close-btn')).toBeEnabled()
    unmount()

    // 2) Optimistic `local-poll-*` vote migrates onto synced `$event` and flushes io.kodera.poll.response + io.kodera.poll.end!
    const localPoll = pollStore.recordLocalPoll({
      roomId: ROOM,
      payload: {
        question: 'Migrate echo?',
        options: ['Alpha', 'Beta'],
        allowMultiple: false,
        anonymous: false,
      },
      createdBy: VIEWER,
      createdByName: 'Alice',
    })
    pollStore.vote(localPoll, `${localPoll.id}-opt-2`, VIEWER, { sendEvent })
    const derived = pollStore.derivePolls(
      ROOM,
      [
        {
          eventId: '$synced-poll-99',
          sender: VIEWER,
          senderName: 'Alice',
          ts: 1_762_510_900_000,
          redacted: false,
          poll: {
            question: 'Migrate echo?',
            options: ['Alpha', 'Beta'],
            allowMultiple: false,
            anonymous: false,
          },
        },
      ],
      'Alice',
      { sink: { sendEvent } }
    )
    expect(derived).toHaveLength(1)
    expect(derived[0]!.id).toBe('$synced-poll-99')
    expect(derived[0]!.options[1]!.voterIds).toEqual([VIEWER])
    expect(sendEvent).toHaveBeenCalledWith(
      ROOM,
      POLL_RESPONSE_EVENT,
      expect.objectContaining({
        pollId: '$synced-poll-99',
        optionIndexes: [1],
      })
    )

    pollStore.close(derived[0]!, { sendEvent }, true)
    expect(sendEvent).toHaveBeenCalledWith(
      ROOM,
      POLL_END_EVENT,
      expect.objectContaining({ pollId: '$synced-poll-99' })
    )

    // 3) Confidential room refuses `/poll` before recording any local poll or calling store.send!
    pollStore.clearAll()
    const confSend = vi.fn(async () => undefined)
    const localDrafts = createLocalDrafts()
    const draftKey = `${VIEWER}\n!conf:acme.kodera.io`
    const draft: DraftChannel = {
      subscribe: localDrafts.subscribe,
      read: () => localDrafts.read(draftKey),
      update: (patch) => localDrafts.update(draftKey, patch),
      command: (effect, patch) => {
        if (patch !== undefined) localDrafts.update(draftKey, patch)
        effect()
        return true
      },
    }
    const emptySnapshot = { status: 'live', channels: new Map(), rooms: [], invites: [] }
    const emptyList: readonly never[] = []
    const confStore = {
      subscribe: () => () => undefined,
      getSnapshot: () => emptySnapshot,
      getUserId: () => VIEWER,
      getRoomBoundary: () => 'confidential',
      getTimeline: () => emptyList,
      getThread: () => emptyList,
      send: confSend,
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
    } as unknown as EspaceStoreLike

    render(
      <MessageComposer
        store={confStore}
        roomId="!conf:acme.kodera.io"
        viewerId={VIEWER}
        draft={draft}
        channelName="secret"
        simulation={false}
        narrow={false}
        navigationUnsettled={false}
        inputId="conf-poll-composer"
        guidanceId="conf-poll-guidance"
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
    )
    const textbox = screen.getByRole('textbox', { name: /secret/ })
    await user.type(textbox, '/poll "Secret?" "A" "B"')
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('composer-poll-error')).toBeInTheDocument()
    expect(confSend).not.toHaveBeenCalled()
    expect(pollStore.derivePolls('!conf:acme.kodera.io', [], 'Alice')).toEqual([])

    // 4) Matrix session rotation / sign-out clears pollStore automatically!
    pollStore.recordLocalPoll({
      roomId: ROOM,
      payload: {
        question: 'Session scoped?',
        options: ['One', 'Two'],
        allowMultiple: false,
        anonymous: false,
      },
      createdBy: VIEWER,
      createdByName: 'Alice',
    })
    expect(pollStore.derivePolls(ROOM, [], 'Alice')).toHaveLength(1)
    registerMatrixSession({
      baseUrl: 'https://matrix.acme.kodera.io',
      userId: VIEWER,
      deviceId: 'DEV1',
      accessToken: 'tok-1',
      refreshToken: 'ref-1',
      refresh: async () => ({ accessToken: 'tok-2' }),
    })
    clearMatrixSession()
    expect(pollStore.derivePolls(ROOM, [], 'Alice')).toEqual([])
  })
})

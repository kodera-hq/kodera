import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { createLocalDrafts, type DraftChannel } from './draftChannel'
import type { EspaceStoreLike } from './liveViewModel'
import type { MessageView } from './matrix/timeline'
import type { MentionCandidate } from './mentions'
import { MessageComposer, mentioning } from './MessageComposer'

const ROOM = '!room:kodera.test'
const ME = '@me:kodera.test'
const MIGUEL = { userId: '@miguel:kodera.test', label: 'Miguel Victoria' }
const CAROL = { userId: '@carol:kodera.test', label: 'Carol' }

function draftFor(): DraftChannel {
  const local = createLocalDrafts()
  const key = `${ME}\n${ROOM}`
  return {
    subscribe: local.subscribe,
    read: () => local.read(key),
    update: (patch) => local.update(key, patch),
    command: (effect, patch) => {
      if (patch !== undefined) local.update(key, patch)
      effect()
      return true
    },
  }
}

function storeWith(
  send = vi.fn(async () => undefined),
  edit = vi.fn(async () => undefined),
  timeline: readonly MessageView[] = []
) {
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({}) as never,
    getUserId: () => ME,
    getTimeline: () => timeline,
    getThread: () => [],
    send,
    edit,
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } as unknown as EspaceStoreLike
  return { store, send, edit }
}

function renderComposer(
  store: EspaceStoreLike,
  draft = draftFor(),
  members: readonly MentionCandidate[] = [MIGUEL]
) {
  return render(
    <MessageComposer
      store={store}
      roomId={ROOM}
      viewerId={ME}
      draft={draft}
      channelName="général"
      simulation={false}
      narrow={false}
      navigationUnsettled={false}
      inputId="composer"
      guidanceId="guidance"
      members={members}
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
}

describe('mentioning', () => {
  it('names multi-word members, links them as pill targets, and reads « @salon » as the room', () => {
    expect(mentioning('hi @Miguel Victoria and @salon', [MIGUEL])).toEqual({
      mentions: [MIGUEL.userId],
      mentionsRoom: true,
      mentionTargets: [MIGUEL],
    })
    expect(mentioning('@room ship it', [])).toEqual({ mentions: [], mentionsRoom: true })
    expect(mentioning('mail me at a@salon.fr', [])).toEqual({})
    expect(mentioning('nothing here', [MIGUEL])).toEqual({})
  })
})

describe('MessageComposer', () => {
  it('draws every formatting and action tool as an icon, never as a word', () => {
    const { store } = storeWith()
    renderComposer(store)
    const toolbar = screen.getByRole('toolbar')
    for (const button of toolbar.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.textContent?.trim()).toBe('')
    }
    for (const name of [/mentionner/i, /envoyer/i, /joindre|pièce/i, /commande/i]) {
      const button = screen.getByRole('button', { name })
      expect(button.textContent?.trim()).toBe('')
    }
  })

  it('sends the typed Markdown with the members it names', async () => {
    const user = userEvent.setup()
    const { store, send } = storeWith()
    renderComposer(store)
    const field = screen.getByRole('textbox', { name: /général/ })
    // The name is written whole, then the sentence goes on: the member list has closed.
    await user.type(field, '**hi** @Miguel Victoria, ok')
    expect(field).toHaveValue('**hi** @Miguel Victoria, ok')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(ROOM, '**hi** @Miguel Victoria, ok', {
        mentions: [MIGUEL.userId],
        mentionTargets: [MIGUEL],
      })
    )
    expect(field).toHaveValue('')
  })

  it('toggles bold off on a second press instead of nesting markers', async () => {
    const user = userEvent.setup()
    const { store } = storeWith()
    renderComposer(store)
    const field = screen.getByRole('textbox', { name: /général/ }) as HTMLTextAreaElement
    await user.type(field, 'word')
    field.setSelectionRange(0, 4)
    const bold = screen.getByRole('button', { name: /gras/i })
    await user.click(bold)
    expect(field).toHaveValue('**word**')
    await waitFor(() => expect(field.selectionStart).toBe(2))
    await user.click(bold)
    expect(field).toHaveValue('word')
  })

  it('passes updated mentions to store.edit when saving an edited message', async () => {
    const user = userEvent.setup()
    const { store, edit } = storeWith()
    const draft = draftFor()
    draft.update({
      editing: { roomId: ROOM, eventId: '$m1' },
      text: 'ping @Miguel Victoria',
    })
    renderComposer(store, draft)
    const field = screen.getByRole('textbox', { name: /général/ })
    await user.type(field, ' et @salon, merci')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith(ROOM, '$m1', 'ping @Miguel Victoria et @salon, merci', {
        mentions: [MIGUEL.userId],
        mentionsRoom: true,
        mentionTargets: [MIGUEL],
      })
    )
    expect(field).toHaveValue('')
  })

  it('preserves a renamed member mention on an unrelated edit, drops it when deleted, and adds newly typed mentions', async () => {
    const user = userEvent.setup()
    const original: MessageView = {
      key: '$m1',
      eventId: '$m1',
      sender: ME,
      body: 'ping @Miguel Victoria',
      ts: 1,
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [],
      mentionedUsers: [MIGUEL.userId],
      mentionPills: [MIGUEL],
    }
    const renamedMembers = [{ userId: MIGUEL.userId, label: 'Miguel V.' }, CAROL]

    // 1. Unrelated punctuation edit keeps `@Miguel Victoria` resolved to MIGUEL.userId + pill.
    const first = storeWith(undefined, undefined, [original])
    const firstDraft = draftFor()
    firstDraft.update({
      editing: { roomId: ROOM, eventId: '$m1' },
      text: 'ping @Miguel Victoria',
    })
    const view = renderComposer(first.store, firstDraft, renamedMembers)
    const field = screen.getByRole('textbox', { name: /général/ })
    await user.type(field, '!')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(first.edit).toHaveBeenCalledWith(ROOM, '$m1', 'ping @Miguel Victoria!', {
        mentions: [MIGUEL.userId],
        mentionTargets: [MIGUEL],
      })
    )
    view.unmount()

    // 2. Adding a current member alongside the historical `@OldName` includes both targets.
    const second = storeWith(undefined, undefined, [original])
    const secondDraft = draftFor()
    secondDraft.update({
      editing: { roomId: ROOM, eventId: '$m1' },
      text: 'ping @Miguel Victoria',
    })
    const view2 = renderComposer(second.store, secondDraft, renamedMembers)
    const field2 = screen.getByRole('textbox', { name: /général/ })
    await user.type(field2, ' et @Carol{Escape}')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(second.edit).toHaveBeenCalledWith(ROOM, '$m1', 'ping @Miguel Victoria et @Carol', {
        mentions: [MIGUEL.userId, CAROL.userId],
        mentionTargets: [MIGUEL, CAROL],
      })
    )
    view2.unmount()

    // 3. Deleting `@Miguel Victoria` omits mentions so store.edit clears m.new_content["m.mentions"].
    const third = storeWith(undefined, undefined, [original])
    const thirdDraft = draftFor()
    thirdDraft.update({
      editing: { roomId: ROOM, eventId: '$m1' },
      text: 'ping @Miguel Victoria',
    })
    const view3 = renderComposer(third.store, thirdDraft, renamedMembers)
    const field3 = screen.getByRole('textbox', { name: /général/ })
    await user.clear(field3)
    await user.type(field3, 'ping merci!')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(third.edit).toHaveBeenCalledWith(ROOM, '$m1', 'ping merci!'))
    view3.unmount()
  })

  it('never infers mention identity from array position when plain-text mentions have reordered or unmapped IDs', async () => {
    const user = userEvent.setup()
    const BOB_UUID = {
      userId: '@018f0000-0000-7000-8000-0000000000b1:kodera.test',
      label: 'Robert',
    }
    const CAROL_UUID = {
      userId: '@018f0000-0000-7000-8000-0000000000c2:kodera.test',
      label: 'Caroline',
    }
    // Plain-text message with no HTML pills and reordered m.mentions.user_ids after both renamed:
    // deleting @Carol must never misbind @Bob to CAROL_UUID.
    const pillLessOriginal: MessageView = {
      key: '$m2',
      eventId: '$m2',
      sender: ME,
      body: 'ping @Bob and @Carol',
      ts: 2,
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [],
      mentionedUsers: [CAROL_UUID.userId, BOB_UUID.userId],
    }
    const { store, edit } = storeWith(undefined, undefined, [pillLessOriginal])
    const draft = draftFor()
    draft.update({
      editing: { roomId: ROOM, eventId: '$m2' },
      text: 'ping @Bob!',
    })
    const pillLessView = renderComposer(store, draft, [BOB_UUID, CAROL_UUID])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(edit).toHaveBeenCalledWith(ROOM, '$m2', 'ping @Bob!'))
    pillLessView.unmount()

    // Conversely, when explicit HTML pills exist even with reordered mentionedUsers, exact identity holds.
    const reorderedWithPills: MessageView = {
      ...pillLessOriginal,
      key: '$m3',
      eventId: '$m3',
      mentionPills: [
        { userId: BOB_UUID.userId, label: 'Bob' },
        { userId: CAROL_UUID.userId, label: 'Carol' },
      ],
    }
    const withPills = storeWith(undefined, undefined, [reorderedWithPills])
    const pillsDraft = draftFor()
    pillsDraft.update({
      editing: { roomId: ROOM, eventId: '$m3' },
      text: 'ping @Bob!',
    })
    renderComposer(withPills.store, pillsDraft, [BOB_UUID, CAROL_UUID])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(withPills.edit).toHaveBeenCalledWith(ROOM, '$m3', 'ping @Bob!', {
        mentions: [BOB_UUID.userId],
        mentionTargets: [{ userId: BOB_UUID.userId, label: 'Bob' }],
      })
    )
  })

  it('rejects full-MXID domain swaps, domain suffixes, and colliding localparts on edit', async () => {
    const user = userEvent.setup()
    const BOB_ONE = { userId: '@bob:one.test', label: 'Robert One' }
    const BOB_TWO = { userId: '@bob:two.test', label: 'Robert Two' }
    const BOB_EVIL = { userId: '@bob:one.test.evil', label: 'Robert Evil' }
    const originalMxid: MessageView = {
      key: '$m4',
      eventId: '$m4',
      sender: ME,
      body: 'ping @bob:one.test',
      ts: 4,
      edited: false,
      redacted: false,
      delivery: 'sent',
      replyTo: null,
      reactions: [],
      mentionedUsers: [BOB_ONE.userId],
    }

    // 1. Editing `@bob:one.test` to `@bob:two.test!` must NOT retain `@bob:one.test`.
    const swap = storeWith(undefined, undefined, [originalMxid])
    const swapDraft = draftFor()
    swapDraft.update({
      editing: { roomId: ROOM, eventId: '$m4' },
      text: 'ping @bob:two.test!',
    })
    const v1 = renderComposer(swap.store, swapDraft, [BOB_ONE])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(swap.edit).toHaveBeenCalledWith(ROOM, '$m4', 'ping @bob:two.test!'))
    v1.unmount()

    // 2. Editing `@bob:one.test` to `@bob:one.test.evil!` must NOT retain `@bob:one.test`.
    const suffix = storeWith(undefined, undefined, [originalMxid])
    const suffixDraft = draftFor()
    suffixDraft.update({
      editing: { roomId: ROOM, eventId: '$m4' },
      text: 'ping @bob:one.test.evil!',
    })
    const v2 = renderComposer(suffix.store, suffixDraft, [BOB_ONE, BOB_EVIL])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(suffix.edit).toHaveBeenCalledWith(ROOM, '$m4', 'ping @bob:one.test.evil!')
    )
    v2.unmount()

    // 3. Colliding localparts (`@bob:one.test` and `@bob:two.test` in room) reject bare `@bob` fallback.
    const bareAmbiguous: MessageView = {
      ...originalMxid,
      key: '$m5',
      eventId: '$m5',
      body: 'ping @bob',
    }
    const colliding = storeWith(undefined, undefined, [bareAmbiguous])
    const collidingDraft = draftFor()
    collidingDraft.update({
      editing: { roomId: ROOM, eventId: '$m5' },
      text: 'ping @bob!',
    })
    const v3 = renderComposer(colliding.store, collidingDraft, [BOB_ONE, BOB_TWO])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(colliding.edit).toHaveBeenCalledWith(ROOM, '$m5', 'ping @bob!'))
    v3.unmount()

    // 4. Editing `@bob:one.test` to bracketed IPv6 `@bob:[2001:db8::1]!` must NOT match `{ label: 'bob' }`.
    const ipv6Swap = storeWith(undefined, undefined, [originalMxid])
    const ipv6Draft = draftFor()
    ipv6Draft.update({
      editing: { roomId: ROOM, eventId: '$m4' },
      text: 'ping @bob:[2001:db8::1]!',
    })
    const v4 = renderComposer(ipv6Swap.store, ipv6Draft, [{ userId: BOB_ONE.userId, label: 'bob' }])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(ipv6Swap.edit).toHaveBeenCalledWith(ROOM, '$m4', 'ping @bob:[2001:db8::1]!')
    )
    v4.unmount()

    // 5. Editing `@bob:one.test` or historical bare `@bob` (member currently named `Robert One`)
    // to symbol/consecutive-punctuation continuations must NOT attach `@bob:one.test`, whereas
    // terminal sentence punctuation (`...`) still preserves the historical mention.
    for (const editedText of [
      'ping @bob+:two.test!',
      'ping @bob=:two.test!',
      'ping @bob/admin!',
      'ping @bob/.admin!',
      'ping @bob..admin!',
      'ping @bob-.admin!',
      'ping @bob_.admin!',
    ]) {
      const symSwap = storeWith(undefined, undefined, [bareAmbiguous])
      const symDraft = draftFor()
      symDraft.update({
        editing: { roomId: ROOM, eventId: '$m5' },
        text: editedText,
      })
      const view = renderComposer(symSwap.store, symDraft, [BOB_ONE])
      screen.getByRole('textbox', { name: /général/ }).focus()
      await user.keyboard('{Enter}')
      await waitFor(() => expect(symSwap.edit).toHaveBeenCalledWith(ROOM, '$m5', editedText))
      view.unmount()
    }

    const ellipsisKeep = storeWith(undefined, undefined, [bareAmbiguous])
    const ellipsisDraft = draftFor()
    ellipsisDraft.update({
      editing: { roomId: ROOM, eventId: '$m5' },
      text: 'ping @bob...',
    })
    const v6 = renderComposer(ellipsisKeep.store, ellipsisDraft, [BOB_ONE])
    screen.getByRole('textbox', { name: /général/ }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(ellipsisKeep.edit).toHaveBeenCalledWith(ROOM, '$m5', 'ping @bob...', {
        mentions: [BOB_ONE.userId],
        mentionTargets: [{ userId: BOB_ONE.userId, label: 'bob' }],
      })
    )
    v6.unmount()
  })
})

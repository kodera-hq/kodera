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
    renderComposer(third.store, thirdDraft, renamedMembers)
    const field3 = screen.getByRole('textbox', { name: /général/ })
    await user.clear(field3)
    await user.type(field3, 'ping merci!')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(third.edit).toHaveBeenCalledWith(ROOM, '$m1', 'ping merci!'))
  })
})

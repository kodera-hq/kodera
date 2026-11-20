import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { createLocalDrafts, type DraftChannel } from './draftChannel'
import type { EspaceStoreLike } from './liveViewModel'
import { MessageComposer, mentioning } from './MessageComposer'

const ROOM = '!room:kodera.test'
const ME = '@me:kodera.test'
const MIGUEL = { userId: '@miguel:kodera.test', label: 'Miguel Victoria' }

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

function storeWith(send = vi.fn(async () => undefined), edit = vi.fn(async () => undefined)) {
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({}) as never,
    getUserId: () => ME,
    getTimeline: () => [],
    getThread: () => [],
    send,
    edit,
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } as unknown as EspaceStoreLike
  return { store, send, edit }
}

function renderComposer(store: EspaceStoreLike, draft = draftFor()) {
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
      members={[MIGUEL]}
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
})

// Emoji in the composer (workspace audit item 4): a known « :nom: » becomes its emoji as it is
// typed and again on sending, « : » and two characters open a list of matching emoji, and
// « Insérer un émoji » opens a palette. Received text is never reinterpreted.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, MemberView } from './matrix/store'
import type { MessageView } from './matrix/timeline'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@marina.loiseau:matrix.acme.kodera.io'
const ZOE = '@zoe:matrix.acme.kodera.io'

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
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

function message(eventId: string, sender: string, body: string) {
  return {
    key: eventId,
    eventId,
    sender,
    body,
    ts: Date.UTC(2026, 10, 4, 9, 0),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  } satisfies MessageView
}

function makeStore({
  timeline = [message('$m1', ALICE, 'Bonjour :wave: à tous')],
  threads = {},
  members = [],
}: {
  timeline?: readonly MessageView[]
  threads?: Record<string, readonly MessageView[]>
  members?: readonly MemberView[]
} = {}) {
  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
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
    ],
    invites: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: (roomId: string) => (roomId === ROOM ? timeline : []),
    getThread: (_roomId: string, root: string) => threads[root] ?? [],
    getMembers: () => members,
    loadMembers: vi.fn<(roomId: string) => void>(),
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } satisfies EspaceStoreLike
}

function renderView(store: EspaceStoreLike) {
  render(
    <EspaceLiveView
      org="acme"
      organisationName="Acme SA"
      workspace={WORKSPACE}
      channelId={GENERAL}
      store={store}
    />
  )
  return screen.getByRole('textbox', { name: 'Message dans #général' }) as HTMLInputElement
}

const optionTexts = (list: HTMLElement) =>
  within(list)
    .getAllByRole('option')
    .map((option) => option.textContent)

describe('shortcodes in the composer', () => {
  it('writes a known code as its emoji as the closing « : » is typed, and sends the emoji', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, 'Salut :wave:')
    expect(composer).toHaveValue('Salut 👋')
    expect(composer.selectionStart).toBe('Salut 👋'.length)
    // The caret is just after the emoji: typing goes on from there.
    await user.type(composer, ' et :+1:{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Salut 👋 et 👍', {})
  })

  it('leaves an unknown code and a code touching a word as typed', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, ':inconnu: a:wave: 12:30:{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, ':inconnu: a:wave: 12:30:', {})
  })

  it('writes the codes of pasted text on sending', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.click(composer)
    await user.paste('Bravo :tada: et :inconnu:')
    expect(composer).toHaveValue('Bravo :tada: et :inconnu:')
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Bravo 🎉 et :inconnu:', {})
  })

  it('writes them in an edit too', async () => {
    const user = userEvent.setup()
    const store = makeStore({ timeline: [message('$m2', ME, 'Mon point')] })
    const composer = renderView(store)
    const own = within(screen.getByRole('log')).getAllByRole('article')[0]!
    await user.click(within(own).getByRole('button', { name: /^Actions du message/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Modifier' }))
    expect(composer).toHaveValue('Mon point')
    await user.click(composer)
    await user.paste(' :white_check_mark:')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(store.edit).toHaveBeenCalledWith(ROOM, '$m2', 'Mon point ✅')
  })

  it('sends a pasted SharePoint link as pasted, and one typed by hand too', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    const excel = 'https://contoso.sharepoint.com/:x:/g/personal/EaBc'
    await user.click(composer)
    await user.paste(`Le tableur ${excel} :tada:`)
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenLastCalledWith(ROOM, `Le tableur ${excel} 🎉`, {})
    await user.type(composer, 'https://exemple.fr/?q=:tada:')
    expect(composer).toHaveValue('https://exemple.fr/?q=:tada:')
  })

  it('leaves the text to an input method while it composes', () => {
    const composer = renderView(makeStore())
    fireEvent.input(composer, { target: { value: 'ok :wave:' }, isComposing: true })
    expect(composer).toHaveValue('ok :wave:')
    // The same text with no composition under way is written at once.
    fireEvent.input(composer, { target: { value: 'ok :wave: :tada:' } })
    expect(composer).toHaveValue('ok :wave: 🎉')
  })

  it('sends a code after a backslash as typed', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, 'Tapez \\:wave: pour 👋{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Tapez \\:wave: pour 👋', {})
  })

  it('still names a member whose name holds a code', async () => {
    const user = userEvent.setup()
    const store = makeStore({ members: [{ userId: ZOE, name: 'Zoé :fire:' }] })
    const composer = renderView(store)
    await user.type(composer, '@zo{Enter}')
    expect(composer).toHaveValue('@Zoé :fire: ')
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, '@Zoé 🔥', { mentions: [ZOE] })
  })

  it('never reinterprets a received message', () => {
    renderView(makeStore())
    const log = screen.getByRole('log')
    expect(within(log).getByText('Bonjour :wave: à tous')).toBeInTheDocument()
    expect(log.textContent).not.toContain('👋')
  })

  it('writes the codes in the thread composer too', async () => {
    const user = userEvent.setup()
    const store = makeStore({ threads: { $m1: [message('$t1', ALICE, 'Dans le fil')] } })
    renderView(store)
    await user.click(screen.getByRole('button', { name: '1 réponse' }))
    const thread = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const input = within(thread).getByRole('combobox', { name: 'Répondre au fil' })
    await user.type(input, 'ok :+1:')
    expect(input).toHaveValue('ok 👍')
    await user.click(input)
    // Pasted text that ends on something else: only the send-time pass writes its code.
    await user.paste(' :tada: !')
    expect(input).toHaveValue('ok 👍 :tada: !')
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'ok 👍 🎉 !', { threadRootId: '$m1' })
  })
})

describe('the emoji list', () => {
  it('opens after « : » and two characters, each emoji with its code', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore())
    await user.type(composer, 'Merci :t')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(composer, 'h')
    const list = screen.getByRole('listbox', { name: 'Émojis correspondants' })
    expect(optionTexts(list)).toEqual([
      '👍:thumbsup:',
      '🤔:thinking:',
      '👎:thumbsdown:',
      '🤒:thermometer_face:',
      // A later word of a code, after the codes that start with « th ».
      '🥰:smiling_face_with_three_hearts:',
    ])
    expect(composer).toHaveAttribute('aria-controls')
    expect(composer).toHaveAttribute('aria-controls', list.id)
  })

  it('chooses with the arrows and Enter, without sending, writing the emoji and a space', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, 'Bravo :ta')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(composer).toHaveAttribute('aria-activedescendant', options[0]!.id)
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(store.send).not.toHaveBeenCalled()
    expect(composer).toHaveValue('Bravo 🎉 ')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(composer, 'à tous{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Bravo 🎉 à tous', {})
  })

  it('chooses with a click, keeping the focus in the field', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore())
    await user.type(composer, ':fi')
    await user.click(screen.getByRole('option', { name: '🔥:fire:' }))
    expect(composer).toHaveValue('🔥 ')
    expect(composer).toHaveFocus()
  })

  it('closes with Escape until the next « : »', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore())
    await user.type(composer, ':ey')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(composer, 'e')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(composer, ' :ro')
    expect(screen.getByRole('listbox', { name: 'Émojis correspondants' })).toBeInTheDocument()
  })

  it('closes with Escape in the thread composer, leaving the thread open', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ threads: { $m1: [message('$t1', ALICE, 'Dans le fil')] } }))
    await user.click(screen.getByRole('button', { name: '1 réponse' }))
    const thread = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const input = within(thread).getByRole('combobox', { name: 'Répondre au fil' })
    await user.type(input, ':ta')
    expect(screen.getByRole('listbox', { name: 'Émojis correspondants' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(thread).toBeInTheDocument()
  })

  it('opens the member list on an « @ » typed where a closed « : » list began', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore({ members: [{ userId: ALICE, name: 'Marina Loiseau' }] }))
    await user.type(composer, ':sm{Escape}')
    // The whole text selected and typed over: the « @ » takes the closed list's place.
    composer.setSelectionRange(0, 3)
    await user.keyboard('@')
    expect(composer).toHaveValue('@')
    expect(screen.getByRole('listbox', { name: 'Membres à mentionner' })).toBeInTheDocument()
  })

  it('opens nothing for an address or a time', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore())
    await user.type(composer, 'https://kodera.io à 12:30')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(composer).not.toHaveAttribute('aria-controls')
  })
})

describe('« Insérer un émoji »', () => {
  it('sits in the tools row between « Mentionner » and « Envoyer »', () => {
    renderView(makeStore())
    const emoji = screen.getByRole('button', { name: 'Insérer un émoji' })
    const row = emoji.parentElement!
    expect(within(row).getAllByRole('button')).toEqual([
      screen.getByRole('button', { name: 'Mentionner' }),
      emoji,
      screen.getByRole('button', { name: 'Envoyer' }),
    ])
    expect(emoji.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('writes the chosen emoji at the caret and puts the focus back after it', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, 'Bien joué')
    composer.setSelectionRange(4, 4)
    await user.click(screen.getByRole('button', { name: 'Insérer un émoji' }))
    const palette = screen.getByRole('dialog', { name: 'Émojis' })
    const cells = within(palette).getAllByRole('button')
    // 32 Unicode emoji, then Kodera's own 8.
    expect(cells).toHaveLength(40)
    expect(cells.slice(0, 8).map((cell) => cell.textContent)).toEqual([
      '👍',
      '❤️',
      '😂',
      '🎉',
      '👀',
      '✅',
      '🙏',
      '😮',
    ])
    expect(within(palette).getByRole('button', { name: 'Insérer 👋' })).toHaveAttribute(
      'title',
      ':wave:'
    )
    await user.click(within(palette).getByRole('button', { name: 'Insérer 🔥' }))
    expect(composer).toHaveValue('Bien🔥 joué')
    await waitFor(() => expect(composer).toHaveFocus())
    expect(composer.selectionStart).toBe('Bien🔥'.length)
    expect(screen.queryByRole('dialog', { name: 'Émojis' })).toBeNull()
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Bien🔥 joué', {})
  })

  it('replaces a selection', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore())
    await user.type(composer, 'Bien joué')
    composer.setSelectionRange(5, 9)
    await user.click(screen.getByRole('button', { name: 'Insérer un émoji' }))
    await user.click(screen.getByRole('button', { name: 'Insérer 👏' }))
    expect(composer).toHaveValue('Bien 👏')
  })

  it('is one tab stop moved by the arrow keys, and Escape returns to its button', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    const trigger = screen.getByRole('button', { name: 'Insérer un émoji' })
    await user.click(trigger)
    const palette = screen.getByRole('dialog', { name: 'Émojis' })
    const cells = within(palette).getAllByRole('button')
    await waitFor(() => expect(cells[0]).toHaveFocus())
    expect(cells.filter((cell) => cell.tabIndex === 0)).toEqual([cells[0]])
    await user.keyboard('{ArrowRight}')
    expect(cells[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(cells[9]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowLeft}{ArrowLeft}')
    // The first cell holds: no wrap past either end.
    expect(cells[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(cells[39]).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowRight}')
    expect(cells[39]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(cells[0]).toHaveFocus()
    expect(cells.filter((cell) => cell.tabIndex === 0)).toEqual([cells[0]])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Émojis' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('closes on Tab, the focus back on its button, never lost past the page', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    const trigger = screen.getByRole('button', { name: 'Insérer un émoji' })
    await user.click(trigger)
    const cells = within(screen.getByRole('dialog', { name: 'Émojis' })).getAllByRole('button')
    await waitFor(() => expect(cells[0]).toHaveFocus())
    await user.keyboard('{ArrowRight}{Tab}')
    expect(screen.queryByRole('dialog', { name: 'Émojis' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.click(trigger)
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getAllByRole('button')[0]).toHaveFocus()
    )
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.queryByRole('dialog', { name: 'Émojis' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('chooses from the keyboard with Enter, back in the field', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore())
    await user.type(composer, 'Top ')
    await user.click(screen.getByRole('button', { name: 'Insérer un émoji' }))
    const cells = within(screen.getByRole('dialog', { name: 'Émojis' })).getAllByRole('button')
    await waitFor(() => expect(cells[0]).toHaveFocus())
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{Enter}')
    expect(composer).toHaveValue('Top 🎉')
    await waitFor(() => expect(composer).toHaveFocus())
  })
})

describe("Kodera's own emoji", () => {
  it('are offered after the others in the palette, and written as their code', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.click(screen.getByRole('button', { name: 'Insérer un émoji' }))
    expect(screen.getByText('Émojis Kodera')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /:kodera_spark:/u }))
    expect(composer).toHaveValue(':kodera_spark:')
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, ':kodera_spark:', {})
  })

  it('reach the end of the grid with End', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(screen.getByRole('button', { name: 'Insérer un émoji' }))
    await user.keyboard('{End}')
    expect(document.activeElement).toHaveAccessibleName(/:kodera_wave:/u)
  })
})

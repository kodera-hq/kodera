import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'
import { WorkspacePaletteRegistration } from './WorkspacePaletteRegistration'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { PaletteProvider } from './PaletteContext'
import { UniversalSearch } from './UniversalSearch'
import { ShellShortcuts } from '../../app/ShellShortcuts'
it('works without a workspace and consumes a mounted workspace source once', async () => {
  const user = userEvent.setup()
  const choose = vi.fn(() => null)
  const view = render(
    <PaletteProvider>
      <ShellShortcuts org="sample" />
    </PaletteProvider>
  )
  await user.keyboard('{Control>}k{/Control}')
  await screen.findByRole('combobox')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await user.keyboard('{Escape}')
  view.rerender(
    <PaletteProvider>
      <ShellShortcuts org="sample" />
      <UniversalSearch
        entries={[{ id: 'general', label: 'Général', kind: 'text' }]}
        onChoose={choose}
        shortcut
      />
    </PaletteProvider>
  )
  await user.click(screen.getByRole('button', { name: 'Rechercher' }))
  await screen.findByRole('combobox')
  await user.type(screen.getByRole('combobox'), 'gen')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(choose).toHaveBeenCalledOnce())
  expect(choose).toHaveBeenCalledWith(expect.objectContaining({ id: 'general' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rechercher' })).toHaveFocus())
})

it('keeps a workspace source available after its channel drawer unmounts', async () => {
  const user = userEvent.setup()
  const choose = vi.fn(() => null)
  const store = { getDirects: () => [] } as unknown as EspaceStoreLike
  const renderSource = (drawer: boolean) => (
    <PaletteProvider>
      <ShellShortcuts org="sample" />
      <WorkspacePaletteRegistration
        store={store}
        entries={[{ id: 'base', label: 'Base channel', kind: 'text' }]}
        documents={[]}
        onChoose={choose}
        onSelectDirect={() => {}}
        simulation={false}
      />
      {drawer ? (
        <UniversalSearch
          entries={[{ id: 'drawer', label: 'Drawer channel', kind: 'text' }]}
          onChoose={choose}
          shortcut={false}
        />
      ) : null}
    </PaletteProvider>
  )
  const view = render(renderSource(true))
  view.rerender(renderSource(false))
  await user.keyboard('{Control>}k{/Control}')
  await screen.findByRole('combobox')
  await user.type(screen.getByRole('combobox'), 'base')
  await user.keyboard('{Enter}')
  expect(choose).toHaveBeenCalledWith(expect.objectContaining({ id: 'base' }))
  view.rerender(
    <PaletteProvider>
      <ShellShortcuts org="sample" />
    </PaletteProvider>
  )
  await user.keyboard('{Control>}k{/Control}')
  await screen.findByRole('combobox')
  expect(screen.queryByRole('option', { name: /Base channel/ })).toBeNull()
})

it('queues a shortcut fired immediately after the shell mounts', async () => {
  render(
    <PaletteProvider>
      <ShellShortcuts org="sample" />
    </PaletteProvider>
  )
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('combobox')).toHaveFocus()
})

it('indexes synced workspace files and opens the Files view from the palette', async () => {
  const user = userEvent.setup()
  const changeCanvas = vi.fn()
  const store = {
    getDirects: () => [],
    getTimeline: () => [
      {
        eventId: '$e1',
        ts: 1,
        sender: '@ana:example.org',
        attachments: [
          { id: 'a1', filename: 'budget-2027.csv', contentType: 'text/csv', sizeBytes: 12 },
        ],
      },
    ],
  } as unknown as EspaceStoreLike
  const snapshot = {
    channels: new Map([['base', { state: 'resolved', roomId: '!base:example.org' }]]),
    rooms: [],
  } as unknown as EspaceSnapshot
  render(
    <PaletteProvider>
      <ShellShortcuts org="sample" />
      <WorkspacePaletteRegistration
        store={store}
        entries={[{ id: 'base', label: 'Base channel', kind: 'text' }]}
        documents={[]}
        onChoose={() => null}
        onSelectDirect={() => {}}
        onChangeCanvasMode={changeCanvas}
        simulation={false}
        snapshot={snapshot}
      />
      <UniversalSearch
        entries={[{ id: 'sidebar', label: 'Sidebar channel', kind: 'text' }]}
        onChoose={() => null}
        shortcut={false}
      />
    </PaletteProvider>
  )
  await user.keyboard('{Control>}k{/Control}')
  await user.type(await screen.findByRole('combobox'), 'budget')
  expect(await screen.findByText('budget-2027.csv')).toBeVisible()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(changeCanvas).toHaveBeenCalledWith('files'))
})

it('preserves dynamicEntries from WorkspacePaletteRegistration and revalidates live redactions and boundary changes while open', async () => {
  const user = userEvent.setup()
  const jump = vi.fn(() => null)
  const listeners = new Set<() => void>()
  let boundary: 'ordinary' | 'confidential-unavailable' = 'ordinary'
  const msg = {
    key: '$m1',
    eventId: '$m1',
    ts: 1_700_000_000_000,
    sender: '@ana:example.org',
    senderName: 'Anaïs',
    body: 'Validation passerelle terminée',
    edited: false,
    redacted: false,
    delivery: 'sent' as const,
    replyTo: null,
    reactions: [],
  }
  const msg2 = {
    key: '$m2',
    eventId: '$m2',
    ts: 1_700_000_001_000,
    sender: '@ana:example.org',
    senderName: 'Anaïs',
    body: 'Passerelle secours active',
    edited: false,
    redacted: false,
    delivery: 'sent' as const,
    replyTo: null,
    reactions: [],
  }
  let snapshot = {
    channels: new Map([['base', { state: 'resolved', roomId: '!base:example.org' }]]),
    rooms: [],
  } as unknown as EspaceSnapshot
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getRoomBoundary: () => boundary,
    getDirects: () => [],
    getTimeline: () => [msg, msg2],
  } as unknown as EspaceStoreLike

  render(
    <PaletteProvider>
      <ShellShortcuts org="sample" />
      <WorkspacePaletteRegistration
        store={store}
        entries={[{ id: 'base', label: 'Base channel', kind: 'text' }]}
        documents={[]}
        onJumpToMessage={jump}
        onChoose={() => null}
        onSelectDirect={() => {}}
        simulation={false}
        snapshot={snapshot}
      />
      <UniversalSearch
        entries={[{ id: 'sidebar', label: 'Sidebar channel', kind: 'text' }]}
        onChoose={() => null}
        shortcut
      />
    </PaletteProvider>
  )
  await user.click(screen.getByRole('button', { name: 'Rechercher' }))
  const combobox = await screen.findByRole('combobox')
  await user.type(combobox, 'passerelle')
  expect(await screen.findByText('Validation passerelle terminée')).toBeVisible()
  expect(screen.getByText('Passerelle secours active')).toBeVisible()

  // 1. Live redaction while palette stays open evicts the redacted message on sync/retype.
  msg.redacted = true
  snapshot = { ...snapshot }
  for (const listener of listeners) listener()
  await waitFor(() => expect(screen.queryByText('Validation passerelle terminée')).toBeNull())
  expect(screen.getByText('Passerelle secours active')).toBeVisible()

  // 2. Room boundary flipping to confidential-unavailable while open immediately quarantines all hits!
  boundary = 'confidential-unavailable'
  await user.type(combobox, ' ')
  expect(screen.queryByText('Passerelle secours active')).toBeNull()

  // Restoring ordinary boundary allows selecting the surviving message, UNLESS redacted right before open().
  boundary = 'ordinary'
  await user.keyboard('{Backspace}')
  expect(await screen.findByText('Passerelle secours active')).toBeVisible()
  msg2.redacted = true
  await user.keyboard('{Enter}')
  expect(jump).not.toHaveBeenCalled()

  // Unredacted message activates cleanly.
  msg2.redacted = false
  await user.click(screen.getByRole('button', { name: 'Rechercher' }))
  const reopenedCombobox = await screen.findByRole('combobox')
  await user.type(reopenedCombobox, 'passerelle')
  expect(await screen.findByText('Passerelle secours active')).toBeVisible()
  await user.keyboard('{Enter}')
  expect(jump).toHaveBeenCalledWith('!base:example.org', 'base', false, '$m2')
})

describe('Control+K on a Mac', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps native line editing inside a text field and still opens on Command+K', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36'
    )
    render(
      <PaletteProvider>
        <ShellShortcuts org="sample" />
        <input aria-label="Draft" />
        <textarea aria-label="Notes" />
        <div
          aria-label="Editor"
          role="textbox"
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
        />
      </PaletteProvider>
    )
    for (const name of ['Draft', 'Notes', 'Editor']) {
      const field = screen.getByLabelText(name)
      field.focus()
      const event = createEvent.keyDown(field, { key: 'k', ctrlKey: true })
      fireEvent(field, event)
      expect(event.defaultPrevented, name).toBe(false)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('combobox')).toBeNull()
    // Command+K opens the palette from the very same field.
    const draft = screen.getByLabelText('Draft')
    const command = createEvent.keyDown(draft, { key: 'k', metaKey: true })
    fireEvent(draft, command)
    expect(command.defaultPrevented).toBe(true)
    expect(await screen.findByRole('combobox')).toBeVisible()
  })

  it('still opens on Control+K outside a text field', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36'
    )
    render(
      <PaletteProvider>
        <ShellShortcuts org="sample" />
      </PaletteProvider>
    )
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('combobox')).toBeVisible()
  })
})

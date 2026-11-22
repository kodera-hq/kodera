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

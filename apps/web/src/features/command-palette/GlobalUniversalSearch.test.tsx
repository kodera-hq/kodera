import type { EspaceStoreLike } from '../espace/liveViewModel'
import { WorkspacePaletteRegistration } from './WorkspacePaletteRegistration'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
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

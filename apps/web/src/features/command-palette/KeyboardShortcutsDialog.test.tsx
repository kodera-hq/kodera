import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '../../i18n'
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog'
import { Dialog } from '../../ui/Dialog/Dialog'
it('opens with Control+/ and returns focus on Escape', async () => {
  const user = userEvent.setup()
  render(
    <>
      <button>Origin</button>
      <KeyboardShortcutsDialog />
    </>
  )
  await user.click(screen.getByRole('button', { name: 'Origin' }))
  await user.keyboard('{Control>}/{/Control}')
  expect(screen.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible()
  expect(screen.getByText('Rechercher et naviguer')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Origin' })).toHaveFocus())
})
it('leaves an existing modal in control', async () => {
  const user = userEvent.setup()
  render(
    <>
      <KeyboardShortcutsDialog />
      <Dialog open title="Existing" closeLabel="Close">
        <input aria-label="Name" />
      </Dialog>
    </>
  )
  await user.keyboard('{Control>}/{/Control}')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
})

it('accepts slash produced with Shift on international keyboards', async () => {
  render(<KeyboardShortcutsDialog />)
  fireEvent.keyDown(window, { key: '/', ctrlKey: true, shiftKey: true })
  expect(await screen.findByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible()
})

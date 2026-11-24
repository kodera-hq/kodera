import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '../../i18n'
import { ChannelCreateDialog } from './ChannelCreateDialog'

it('validates duplicate names, creates voice rooms and dismisses with Escape', async () => {
  const create = vi.fn()
  const close = vi.fn()
  const user = userEvent.setup()
  render(
    <ChannelCreateDialog
      open
      category={{ id: 'community', name: 'Community', template_key: null, channels: [] }}
      existingNames={['general']}
      onCreate={create}
      onClose={close}
    />
  )
  const name = screen.getByRole('textbox', { name: 'Nom du salon' })
  await user.type(name, 'GENERAL')
  await user.click(screen.getByRole('button', { name: 'Créer le salon' }))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(create).not.toHaveBeenCalled()
  // Confidential toggle defaults OFF (Tier 2 opt-in) on text channels, and opts in when checked.
  const confToggle = screen.getByRole('checkbox', {
    name: /Salon confidentiel chiffré de bout en bout/,
  })
  expect(confToggle).not.toBeChecked()

  await user.clear(name)
  await user.type(name, 'Équipe Office')
  await user.type(
    screen.getByRole('textbox', { name: 'Description ou sujet (facultatif)' }),
    'Weekly planning'
  )
  await user.selectOptions(screen.getByRole('combobox', { name: 'Accès au salon' }), 'invite')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Type de salon' }), 'audio')
  await user.click(screen.getByRole('button', { name: 'Créer le salon' }))
  expect(create).toHaveBeenCalledWith('equipe-office', 'audio', {
    topic: 'Weekly planning',
    access: 'invite',
  })
  await user.keyboard('{Escape}')
  expect(close).toHaveBeenCalled()
})

it('opts a text channel into Tier 2 zero-knowledge confidential mode only when explicitly checked', async () => {
  const create = vi.fn()
  const user = userEvent.setup()
  render(
    <ChannelCreateDialog
      open
      category={{ id: 'direction', name: 'Direction', template_key: null, channels: [] }}
      existingNames={['general']}
      onCreate={create}
      onClose={() => undefined}
    />
  )
  await user.type(screen.getByRole('textbox', { name: 'Nom du salon' }), 'Conseil exécutif')
  const confToggle = screen.getByRole('checkbox', {
    name: /Salon confidentiel chiffré de bout en bout/,
  })
  expect(confToggle).not.toBeChecked()
  await user.click(confToggle)
  expect(confToggle).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Créer le salon' }))
  expect(create).toHaveBeenCalledWith('conseil-executif', 'text', {
    topic: '',
    access: 'members',
    confidential: true,
  })
})

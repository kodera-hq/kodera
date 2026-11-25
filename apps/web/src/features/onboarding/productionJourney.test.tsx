import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { it, expect } from 'vitest'
import '../../i18n'
import { DocsWorkspacePanel } from '../docs/DocsWorkspacePanel'

it('does not report copy success when the clipboard is unavailable', async () => {
  const user = userEvent.setup()
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  try {
    render(
      <DocsWorkspacePanel tenantSlug="studio" channelId="production" channelName="Production" />
    )
    await user.click(await screen.findByRole('button', { name: 'Nouvelle page' }))
    await user.click(screen.getByRole('button', { name: 'Partager' }))
    await user.click(screen.getByRole('button', { name: 'Copier le lien interne' }))
    expect(screen.getByRole('dialog', { name: 'Partager' })).toHaveTextContent(
      'La copie n’est pas disponible dans ce navigateur.'
    )
    expect(screen.queryByText('Lien interne copié.')).toBeNull()
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

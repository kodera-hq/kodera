import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import '../../i18n'
import { WorkspaceMenu } from './WorkspaceMenu'
import { saveThemePreference } from '../../theme/theme'

it.each(['Clair', 'Sombre'])(
  'restores official tokens when selecting %s after a custom palette',
  async (name) => {
    saveThemePreference('dark')
    document.documentElement.style.setProperty('--c-page', 'rgb(8, 16, 12)')
    document.documentElement.style.setProperty('--c-ink', 'rgb(235, 245, 239)')
    render(<WorkspaceMenu name="Community" slug="community" trigger={<button>Workspace</button>} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Workspace' }))
    await user.click(screen.getByRole('menuitemradio', { name: new RegExp(`^${name}$`) }))
    expect(document.documentElement.style.getPropertyValue('--c-page')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--c-ink')).toBe('')
  }
)

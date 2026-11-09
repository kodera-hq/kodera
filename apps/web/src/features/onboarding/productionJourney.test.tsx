import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { it, expect, vi } from 'vitest'
import '../../i18n'
import { DocsWorkspacePanel } from '../docs/DocsWorkspacePanel'
it('does not report copy success when the clipboard is unavailable', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
  try {
    render(
      <DocsWorkspacePanel tenantSlug="studio" channelId="production" channelName="Production" />
    )
    await user.click(screen.getByRole('button', { name: /Copier/ }))
    expect(screen.queryByText('Copié')).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})

import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkspaceSettingsHost } from './WorkspaceSettingsHost'
import { clearWorkspaceSettingsRuntime } from './settingsRuntime'
import { openWorkspaceCommand } from './WorkspaceMenu'
import type { OrganisationRole } from '../../app/Sidebar'

const role: OrganisationRole = 'org_member'

vi.mock('./WorkspaceSettings', () => ({
  default: () => <div role="dialog" aria-label="Settings" />,
}))
it('retires an open portal when authentication ends while the shell stays mounted', async () => {
  render(
    <WorkspaceSettingsHost
      org="community"
      organisationId="org-community"
      organisationName="Community"
      displayName="Member"
      role={role}
    />
  )
  act(() => openWorkspaceCommand('settings'))
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  act(() => clearWorkspaceSettingsRuntime())
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => openWorkspaceCommand('settings'))
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
})

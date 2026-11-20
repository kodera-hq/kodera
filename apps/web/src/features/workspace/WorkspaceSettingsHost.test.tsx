import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkspaceSettingsHost } from './WorkspaceSettingsHost'
import { clearWorkspaceSettingsRuntime } from './settingsRuntime'
import { openWorkspaceCommand, WORKSPACE_COMMAND_EVENT } from './WorkspaceMenu'
import type { OrganisationRole } from '../../app/Sidebar'

const role: OrganisationRole = 'org_member'

vi.mock('./WorkspaceSettings', () => ({
  default: ({ mode, initialSection }: { mode: string; initialSection: string }) => (
    <div role="dialog" aria-label="Settings" data-mode={mode} data-section={initialSection} />
  ),
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

it.each([
  ['the gear', () => openWorkspaceCommand('settings'), 'personal', 'profile'],
  ['the workspace menu', () => openWorkspaceCommand('admin'), 'admin', 'overview'],
  [
    'a palette section',
    () =>
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_COMMAND_EVENT, {
          detail: { command: 'settings', section: 'roles' },
        })
      ),
    'admin',
    'roles',
  ],
  [
    'Cmd+,',
    () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true })),
    'personal',
    'profile',
  ],
])('opens the surface %s belongs to', async (_, open, mode, section) => {
  render(
    <WorkspaceSettingsHost
      org="community"
      organisationId="org-community"
      organisationName="Community"
      displayName="Member"
      role={role}
    />
  )
  act(open)
  const dialog = await screen.findByRole('dialog', { name: 'Settings' })
  expect(dialog).toHaveAttribute('data-mode', mode)
  expect(dialog).toHaveAttribute('data-section', section)
})

it('ignores a section that does not exist', async () => {
  render(
    <WorkspaceSettingsHost
      org="community"
      organisationId="org-community"
      organisationName="Community"
      displayName="Member"
      role={role}
    />
  )
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_COMMAND_EVENT, { detail: { command: 'settings', section: 'nope' } })
    )
  })
  await Promise.resolve()
  expect(screen.queryByRole('dialog')).toBeNull()
})

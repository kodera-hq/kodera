import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import '@/i18n'
import { DocsWorkspacePanel } from './DocsWorkspacePanel'

it('renders the supplied workspace directly without wrapper tabs or a second header', () => {
  const { container } = render(<DocsWorkspacePanel tenantSlug="studio" channelId="general" channelName="General" workspacePagesSlot={<h1>Drive & Docs</h1>} />)
  expect(screen.getAllByRole('heading')).toHaveLength(1)
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.queryByText('Pads de l’équipe')).toBeNull()
  expect(container.querySelectorAll('[style]')).toHaveLength(0)
})

it('loads the unified Drive explorer when mounted without a workspace slot', async () => {
  const { container } = render(<DocsWorkspacePanel tenantSlug="studio" channelId="general" channelName="General" />)
  expect(await screen.findByTestId('docs-drive-explorer')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Drive & Docs' })).toBeInTheDocument()
  expect(container.querySelectorAll('[style]')).toHaveLength(0)
  expect(screen.queryByRole('link')).toBeNull()
})

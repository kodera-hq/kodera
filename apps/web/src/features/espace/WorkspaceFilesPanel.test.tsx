import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import '../../i18n'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import type { EspaceSnapshot } from './matrix/store'
import type { EspaceStoreLike } from './liveViewModel'
const channels = [{ id: 'general', label: 'général', kind: 'text' as const }]
const snapshot = {
  channels: new Map([['general', { state: 'resolved', roomId: '!general' }]]),
  rooms: [{ roomId: '!general', names: {} }],
} as unknown as EspaceSnapshot
const store = {
  getTimeline: () => [
    {
      eventId: '$file',
      ts: 1,
      sender: '@member:example.test',
      attachments: [
        { id: 'image', filename: 'Plan.png', contentType: 'image/png', sizeBytes: 1024 },
      ],
    },
  ],
} as unknown as EspaceStoreLike
it('keeps file previews in the explorer until an explicit open-channel action', async () => {
  const user = userEvent.setup()
  const navigate = vi.fn()
  render(
    <WorkspaceFilesPanel
      store={store}
      snapshot={snapshot}
      searchEntries={channels}
      documents={[]}
      onOpenChannel={navigate}
    />
  )
  expect(screen.getByRole('heading', { name: 'Fichiers' })).toBeVisible()
  expect(screen.getByText(/1 élément/).textContent).toContain('1\u00a0Ko')
  const opener = screen.getByRole('button', { name: 'Plan.png' })
  await user.click(opener)
  await user.keyboard('{Escape}')
  expect(opener).toHaveFocus()
  await user.click(opener)
  const modal = screen.getByRole('dialog', { name: 'Plan.png' })
  expect(navigate).not.toHaveBeenCalled()
  await user.click(within(modal).getByRole('button', { name: 'Ouvrir dans #général' }))
  expect(navigate).toHaveBeenCalledWith('general')
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('searches and filters by MIME without attributing workspace pages to a channel', async () => {
  const user = userEvent.setup()
  const open = vi.fn()
  render(
    <WorkspaceFilesPanel
      store={store}
      snapshot={snapshot}
      searchEntries={channels}
      documents={[{ id: 'workspace-page:policy', title: 'Policy', channelId: '', content: '' }]}
      onOpenChannel={vi.fn()}
      onOpenDocument={open}
    />
  )
  await user.click(screen.getByRole('button', { name: 'Documents' }))
  expect(screen.queryByRole('button', { name: 'Plan.png' })).toBeNull()
  const page = screen.getByRole('button', { name: 'Policy' })
  expect(page.closest('li')).toHaveTextContent('Docs')
  expect(page.closest('li')).not.toHaveTextContent('#général')
  await user.click(page)
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-page:policy' }))
  const search = screen.getByRole('textbox', { name: 'Rechercher un fichier' })
  await user.type(search, 'missing')
  expect(screen.queryByRole('button', { name: 'Policy' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Effacer la recherche' }))
  expect(search).toHaveValue('')
  expect(search).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Policy' })).toBeVisible()
})

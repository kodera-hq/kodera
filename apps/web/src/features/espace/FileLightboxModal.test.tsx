import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import '../../i18n'
import { MessagingOrganisation } from '../messaging/organisationContext'
import { FileLightboxModal } from './FileLightboxModal'
import type { WorkspaceFileEntry } from './workspaceFiles'
const mocked = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn() }))
vi.mock('../../api/client', () => ({ coreApi: () => ({ GET: mocked.get }) }))
vi.mock('../messaging/attachments/imagePreview', () => ({ loadImagePreview: mocked.preview }))
const entries: WorkspaceFileEntry[] = [
  {
    id: 'image',
    name: 'Plan.png',
    kind: 'image',
    ts: 0,
    channel: { id: 'general', label: 'général', kind: 'text' },
    ref: { id: 'attachment-one', filename: 'Plan.png', contentType: 'image/png', sizeBytes: 10 },
  },
  {
    id: 'document',
    name: 'Notes.pdf',
    kind: 'document',
    ts: 0,
    channel: { id: 'general', label: 'général', kind: 'text' },
    ref: {
      id: 'attachment-two',
      filename: 'Notes.pdf',
      contentType: 'application/pdf',
      sizeBytes: 15,
    },
  },
]
beforeEach(() => {
  mocked.get
    .mockReset()
    .mockResolvedValue({ data: { downloadUrl: 'https://files.example.test/file' } })
  mocked.preview.mockReset().mockResolvedValue(new Blob(['image']))
  vi.stubGlobal('URL', URL)
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
})
it('previews safely in place and downloads only via an explicit link', async () => {
  const user = userEvent.setup()
  const open = vi.fn()
  render(
    <MessagingOrganisation.Provider value="workspace">
      <FileLightboxModal
        entries={entries}
        selectedId="image"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenChannel={open}
      />
    </MessagingOrganisation.Provider>
  )
  expect(await screen.findByRole('img', { name: 'Plan.png' })).toHaveAttribute(
    'src',
    'blob:preview'
  )
  expect(screen.getByRole('link', { name: 'Télécharger' })).toHaveAttribute(
    'href',
    'https://files.example.test/file'
  )
  await user.click(screen.getByRole('button', { name: 'Ouvrir dans #général' }))
  expect(open).toHaveBeenCalledWith(entries[0])
})
it('navigates from any focused modal control, wraps and closes on Escape', async () => {
  const user = userEvent.setup()
  const close = vi.fn()
  function Harness() {
    const [id, select] = useState('image')
    return (
      <MessagingOrganisation.Provider value="workspace">
        <FileLightboxModal
          entries={entries}
          selectedId={id}
          onSelect={select}
          onClose={close}
          onOpenChannel={vi.fn()}
        />
      </MessagingOrganisation.Provider>
    )
  }
  render(<Harness />)
  await screen.findByRole('img')
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('dialog', { name: 'Notes.pdf' })).toBeVisible()
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('dialog', { name: 'Plan.png' })).toBeVisible()
  await user.keyboard('{ArrowLeft}')
  expect(screen.getByRole('dialog', { name: 'Notes.pdf' })).toBeVisible()
  await user.keyboard('{Escape}')
  expect(close).toHaveBeenCalledOnce()
  expect(URL.revokeObjectURL).toHaveBeenCalled()
})
it.each([
  'http://files.example.test/file',
  'https://user:secret@files.example.test/file',
  'javascript:alert(1)',
])('rejects an unsafe download address %s', async (downloadUrl) => {
  mocked.get.mockResolvedValue({ data: { downloadUrl } })
  render(
    <MessagingOrganisation.Provider value="workspace">
      <FileLightboxModal
        entries={entries}
        selectedId="image"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenChannel={vi.fn()}
      />
    </MessagingOrganisation.Provider>
  )
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Aperçu indisponible'))
  expect(screen.queryByRole('link')).toBeNull()
  expect(mocked.preview).not.toHaveBeenCalled()
})
it('aborts a pending request and revokes the local image on unmount', async () => {
  const view = render(
    <MessagingOrganisation.Provider value="workspace">
      <FileLightboxModal
        entries={entries}
        selectedId="image"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenChannel={vi.fn()}
      />
    </MessagingOrganisation.Provider>
  )
  await screen.findByRole('img')
  const signal = mocked.get.mock.calls[0]![1].signal as AbortSignal
  view.unmount()
  expect(signal.aborted).toBe(true)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
})

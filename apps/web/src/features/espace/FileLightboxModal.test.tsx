import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import '../../i18n'
import { MessagingOrganisation } from '../messaging/organisationContext'
import { FileLightboxModal } from './FileLightboxModal'
import type { AttachmentType } from '../messaging/attachments/uploadPreflight'
import type { WorkspaceFileEntry } from './workspaceFiles'
const mocked = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn(), storage: vi.fn() }))
vi.mock('../../api/client', () => ({ coreApi: () => ({ GET: mocked.get }) }))
vi.mock('../messaging/attachments/imagePreview', () => ({ loadImagePreview: mocked.preview }))
vi.mock('../messaging/attachments/storageTransport', () => ({ getFromStorage: mocked.storage }))
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
  mocked.storage.mockReset()
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

function textEntry(contentType: string, sizeBytes: number, name = 'notes.txt'): WorkspaceFileEntry {
  return {
    id: 'text',
    name,
    kind: 'document',
    ts: 0,
    channel: { id: 'general', label: 'général', kind: 'text' },
    sizeBytes,
    ref: {
      id: 'attachment-text',
      filename: name,
      contentType: contentType as AttachmentType,
      sizeBytes,
    },
  }
}
function renderText(entry: WorkspaceFileEntry) {
  return render(
    <MessagingOrganisation.Provider value="workspace">
      <FileLightboxModal
        entries={[entry]}
        selectedId={entry.id}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenChannel={vi.fn()}
      />
    </MessagingOrganisation.Provider>
  )
}
const MARKUP = '<img src=x onerror=alert(1)>\n<b>Résumé</b> — ok'
it.each(['text/plain', 'text/markdown', 'text/csv', 'application/json'])(
  'previews a small %s file inline as plain text, never as markup',
  async (contentType) => {
    const bytes = new TextEncoder().encode(MARKUP)
    mocked.storage.mockResolvedValue(new Response(bytes, { status: 200 }))
    renderText(textEntry(contentType, bytes.byteLength))
    const preview = await screen.findByRole('region', { name: 'notes.txt' })
    expect(preview.tagName).toBe('PRE')
    expect(preview).toHaveAttribute('tabindex', '0')
    expect(preview.textContent).toBe(MARKUP)
    expect(preview.querySelector('img, b')).toBeNull()
    expect(preview).not.toHaveAttribute('style')
    expect(mocked.storage).toHaveBeenCalledWith(
      'https://files.example.test/file',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    )
    expect(screen.getByRole('link', { name: 'Télécharger' })).toHaveAttribute(
      'href',
      'https://files.example.test/file'
    )
  }
)
it('never fetches a text file above 256 KiB and keeps the download path', async () => {
  renderText(textEntry('text/plain', 256 * 1024 + 1))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Aperçu indisponible'))
  expect(mocked.storage).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: 'notes.txt' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Télécharger' })).toBeInTheDocument()
})
it('falls back to the download path for bytes that are not UTF-8', async () => {
  const bytes = new Uint8Array([0x48, 0xff, 0xfe, 0x00])
  mocked.storage.mockResolvedValue(new Response(bytes, { status: 200 }))
  renderText(textEntry('text/plain', bytes.byteLength))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Aperçu indisponible'))
  expect(screen.queryByRole('region', { name: 'notes.txt' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Télécharger' })).toBeInTheDocument()
})
it('cuts a transfer that outgrows the declared size and falls back', async () => {
  mocked.storage.mockResolvedValue(new Response('x'.repeat(64), { status: 200 }))
  renderText(textEntry('text/plain', 8))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Aperçu indisponible'))
  expect(screen.queryByRole('region', { name: 'notes.txt' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Télécharger' })).toBeInTheDocument()
})
it('falls back when the storage read fails', async () => {
  mocked.storage.mockResolvedValue(new Response('gone', { status: 403 }))
  renderText(textEntry('text/plain', 4))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Aperçu indisponible'))
  expect(screen.getByRole('link', { name: 'Télécharger' })).toBeInTheDocument()
})
it('does not try a text preview for other types', async () => {
  renderText(textEntry('application/octet-stream', 4, 'blob.bin'))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Aperçu indisponible'))
  expect(mocked.storage).not.toHaveBeenCalled()
})
it('aborts a pending text read when the preview closes', async () => {
  mocked.storage.mockReturnValue(new Promise(() => undefined))
  const view = renderText(textEntry('text/plain', 4))
  await waitFor(() => expect(mocked.storage).toHaveBeenCalled())
  const signal = (mocked.storage.mock.calls[0]![1] as RequestInit).signal as AbortSignal
  expect(signal.aborted).toBe(false)
  view.unmount()
  expect(signal.aborted).toBe(true)
})

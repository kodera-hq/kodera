import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '../../../src/i18n'
import { FilesUpload } from '../../../src/features/espace/FilesUpload'
import { MessagingOrganisation } from '../../../src/features/messaging/organisationContext'
import type { EspaceStoreLike } from '../../../src/features/espace/liveViewModel'
import type { EspaceSnapshot } from '../../../src/features/espace/matrix/store'

const state = vi.hoisted(() => ({
  mediaBytes: 0,
  limit: 10000,
  upload: vi.fn(async () => ({ id: 'stored-file' })),
}))
vi.mock('../../../src/features/workspace/quotasApi', () => ({
  useWorkspaceQuotasQuery: () => ({
    data: { usage: { mediaBytes: state.mediaBytes }, limits: { mediaBytes: state.limit } },
    refetch: vi.fn(),
  }),
}))
vi.mock('../../../src/features/messaging/attachments/uploadAttachment', () => ({
  uploadAttachment: state.upload,
}))
const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'photo.png', {
    type: 'image/png',
  })
const snapshot: EspaceSnapshot = {
  status: 'live',
  channels: new Map([
    ['general', { state: 'resolved', roomId: '!general:example.org' }],
    ['locked', { state: 'resolved', roomId: '!locked:example.org' }],
  ]),
  rooms: ['!general:example.org', '!locked:example.org'].map((roomId) => ({
    roomId,
    name: roomId,
    alias: null,
    kind: 'text' as const,
    unread: 0,
    mentions: 0,
    occupancy: null,
  })),
  invites: [],
}
function mount() {
  const send = vi.fn(async () => undefined)
  const store = {
    canSendMessage: (id: string) => id !== '!locked:example.org',
    send,
  } as unknown as EspaceStoreLike
  const view = render(
    <MessagingOrganisation.Provider value="org">
      <FilesUpload
        store={store}
        snapshot={snapshot}
        channels={[
          { id: 'general', label: 'general', kind: 'text' },
          { id: 'locked', label: 'locked', kind: 'text' },
        ]}
      />
    </MessagingOrganisation.Provider>
  )
  return { send, ...view }
}
beforeEach(() => {
  state.mediaBytes = 0
  state.limit = 10000
  state.upload.mockClear()
})

it('stages a file dropped into an explicit writable channel and waits for Send', async () => {
  const { send } = mount()
  expect(screen.queryByRole('option', { name: '#locked' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Envoyer les fichiers' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByRole('combobox'), 'general')
  fireEvent.drop(
    screen.getByLabelText('Choisissez des fichiers ou déposez-les ici').parentElement!,
    { dataTransfer: { files: [png()] } }
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Envoyer les fichiers' })).toBeEnabled()
  )
  expect(send).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Envoyer les fichiers' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('!general:example.org', '', {
    attachments: [expect.objectContaining({ id: 'stored-file', filename: 'photo.png' })],
  })
})

it('refuses a quota overflow before starting an upload', async () => {
  state.limit = 5
  const { send } = mount()
  await userEvent.selectOptions(screen.getByRole('combobox'), 'general')
  await userEvent.upload(screen.getByLabelText('Choisissez des fichiers ou déposez-les ici'), png())
  expect(await screen.findByRole('alert')).toHaveTextContent('capacité de stockage')
  expect(state.upload).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('keeps active content refused, without publishing an attachment message', async () => {
  const { send } = mount()
  await userEvent.selectOptions(screen.getByRole('combobox'), 'general')
  await userEvent.upload(
    screen.getByLabelText('Choisissez des fichiers ou déposez-les ici'),
    new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' })
  )
  expect(await screen.findByText(/Fichier refusé/)).toBeVisible()
  expect(state.upload).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Envoyer les fichiers' })).toBeDisabled()
})

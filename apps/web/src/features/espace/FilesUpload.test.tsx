import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import '../../i18n'
import { FilesUpload } from './FilesUpload'
import { MessagingOrganisation } from '../messaging/organisationContext'
import type { EspaceSnapshot } from './matrix/store'
import type { EspaceStoreLike } from './liveViewModel'
const mocked = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  quota: { limits: { mediaBytes: 1024 }, usage: { mediaBytes: 0 } },
}))
vi.mock('../workspace/quotasApi', () => ({
  useWorkspaceQuotasQuery: () => ({ data: mocked.quota, refetch: vi.fn() }),
}))
vi.mock('../messaging/attachments/attachmentQueue', () => ({
  AttachmentQueue: class {
    subscribe = () => () => {}
    files = () => empty
    readyRefs = () => []
    add = mocked.add
    close = mocked.close
  },
}))
const queryClient = new QueryClient()
const empty: [] = []
const snapshot = {
  channels: new Map([
    ['first', { state: 'resolved', roomId: '!first' }],
    ['active', { state: 'resolved', roomId: '!active' }],
  ]),
  rooms: [{ roomId: '!first' }, { roomId: '!active' }],
} as unknown as EspaceSnapshot
const channels = [
  { id: 'first', label: 'first', kind: 'text' as const },
  { id: 'active', label: 'active', kind: 'text' as const },
]
const store = {
  getRoomBoundary: () => 'ordinary',
  canSendMessage: () => true,
  send: vi.fn(),
} as unknown as EspaceStoreLike
beforeEach(() => {
  mocked.add.mockClear()
  mocked.close.mockClear()
})
function View({
  activeChannelId,
  currentStore = store,
}: {
  activeChannelId?: string
  currentStore?: EspaceStoreLike
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MessagingOrganisation.Provider value="workspace">
        <FilesUpload
          store={currentStore}
          channels={channels}
          snapshot={snapshot}
          {...(activeChannelId ? { activeChannelId } : {})}
        />
      </MessagingOrganisation.Provider>
    </QueryClientProvider>
  )
}
it('hides native browser chrome and defaults to the active channel', async () => {
  const user = userEvent.setup()
  const { container } = render(<View activeChannelId="active" />)
  expect(screen.getByRole('combobox')).toHaveValue('active')
  const input = container.querySelector('input[type="file"]')!
  expect(input).toHaveClass('sr-only')
  await user.upload(input as HTMLInputElement, new File(['x'], 'plan.txt', { type: 'text/plain' }))
  expect(mocked.add).toHaveBeenCalledWith('!active', [expect.any(File)])
  expect(screen.getByText(/Stockage utilisé/).textContent).toContain('0\u00a0o / 1\u00a0Ko')
})
it('falls back to an available channel and rejects files above quota', async () => {
  const user = userEvent.setup()
  const { container } = render(<View />)
  expect(screen.getByRole('combobox')).toHaveValue('first')
  await user.upload(
    container.querySelector('input[type="file"]')!,
    new File(['x'.repeat(1025)], 'big.txt', { type: 'text/plain' })
  )
  expect(screen.getByRole('alert')).toHaveTextContent('capacité de stockage')
  expect(mocked.add).not.toHaveBeenCalled()
})
it('accepts a multiple-file drop across the pane exactly once', async () => {
  const { container } = render(<View />)
  const files = [new File(['x'], 'one.txt'), new File(['x'], 'two.txt')]
  fireEvent.drop(screen.getByText('Choisissez des fichiers ou déposez-les ici'), {
    dataTransfer: { files, types: ['Files'] },
  })
  await waitFor(() => expect(mocked.add).toHaveBeenCalledOnce())
  expect(mocked.add).toHaveBeenCalledWith('!first', files)
  expect(container.querySelector('[style]')).toBeNull()
})
it('disables uploads when every room is confidential and closes the queue on unmount', () => {
  const { container, unmount } = render(
    <View currentStore={{ ...store, getRoomBoundary: () => 'confidential-unavailable' }} />
  )
  expect(container.querySelector('input[type="file"]')).toBeDisabled()
  unmount()
  expect(mocked.close).toHaveBeenCalledOnce()
})

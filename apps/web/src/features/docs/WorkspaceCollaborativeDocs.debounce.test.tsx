// The debounced page writes of a server-backed workspace: one pending write per page, so editing
// page B inside the debounce window never cancels the write page A still owes, edits of one page
// inside the window fold into a single write, and leaving the surface sends what is owed instead
// of dropping it.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiProblem } from '@/api/client'
import i18n from '@/i18n'
import fr from '@/i18n/fr.json'
import { WorkspaceCollaborativeDocs } from './WorkspaceCollaborativeDocs'
import * as docsApi from './workspaceDocumentsApi'
import type { CoreWorkspaceDocument } from './workspaceDocumentsApi'

const PAGE_A: CoreWorkspaceDocument = {
  id: 'doc-arch',
  parentId: null,
  title: 'Architecture',
  markdown: '# Architecture\n',
  role: 'editor',
  updatedAt: '2026-01-01T00:00:00Z',
}

const PAGE_B: CoreWorkspaceDocument = {
  id: 'doc-runbook',
  parentId: null,
  title: 'Runbook',
  markdown: '# Runbook\n',
  role: 'editor',
  updatedAt: '2026-01-01T00:00:00Z',
}

const neverOpens = () => ({
  binaryType: 'arraybuffer' as BinaryType,
  readyState: 0,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  send: () => undefined,
  close: () => undefined,
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await i18n.changeLanguage('fr')
})

/** Both pages known to the server with a version each, page A open in the Markdown surface. */
async function openWorkspace() {
  await i18n.changeLanguage('fr')
  const user = userEvent.setup()
  const etags = new Map([
    [PAGE_A.id, '"a1"'],
    [PAGE_B.id, '"b1"'],
  ])
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([PAGE_A, PAGE_B])
  const read = vi
    .spyOn(docsApi, 'getWorkspaceDocument')
    .mockImplementation(async (_organisationId, documentId) => {
      const document = [PAGE_A, PAGE_B].find((page) => page.id === documentId)
      if (!document) throw new ApiProblem({ type: null, status: 404, title: 'Not Found' })
      return { document, etag: etags.get(documentId) ?? null }
    })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockRejectedValue(
    new ApiProblem({ type: null, status: 501, title: 'Not Implemented' })
  )
  const metadata = vi
    .spyOn(docsApi, 'updateWorkspaceDocumentMetadata')
    .mockImplementation(async (_organisationId, documentId) => ({
      document: documentId === PAGE_A.id ? PAGE_A : PAGE_B,
      etag: '"next"',
    }))
  const write = vi
    .spyOn(docsApi, 'updateWorkspaceDocument')
    .mockImplementation(async (_organisationId, documentId) => ({
      document: documentId === PAGE_A.id ? PAGE_A : PAGE_B,
      etag: '"next"',
    }))

  const view = render(
    <WorkspaceCollaborativeDocs
      organisationId="org-1"
      currentUser={{ id: 'u-1', name: 'Alex' }}
      initialSurface="markdown"
      webSocketFactory={neverOpens}
    />
  )
  await waitFor(() => expect(read).toHaveBeenCalledWith('org-1', PAGE_A.id, expect.anything()))
  await waitFor(() =>
    expect(screen.getByTestId('docs-collab-status-pill')).toHaveTextContent(
      fr['console.docs.collab.status-local']
    )
  )
  // Visit page B once and come back, so this tab holds a version for each page.
  await user.click(screen.getByTestId(`docs-tree-item-${PAGE_B.id}`))
  await waitFor(() => expect(read).toHaveBeenCalledWith('org-1', PAGE_B.id, expect.anything()))
  await user.click(screen.getByTestId(`docs-tree-item-${PAGE_A.id}`))
  await waitFor(() => expect(screen.getByTestId('docs-page-title-input')).toHaveValue(PAGE_A.title))
  return { view, metadata, write }
}

function typeTitle(value: string): void {
  fireEvent.change(screen.getByTestId('docs-page-title-input'), { target: { value } })
}

it('keeps page A’s pending title write when page B is edited inside the debounce window', async () => {
  const { metadata } = await openWorkspace()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  typeTitle('Architecture v2')
  fireEvent.click(screen.getByTestId(`docs-tree-item-${PAGE_B.id}`))
  typeTitle('Runbook v2')
  expect(metadata).not.toHaveBeenCalled()

  await act(async () => {
    vi.advanceTimersByTime(400)
  })

  expect(metadata).toHaveBeenCalledTimes(2)
  expect(metadata).toHaveBeenCalledWith('org-1', PAGE_A.id, '"a1"', { title: 'Architecture v2' })
  expect(metadata).toHaveBeenCalledWith('org-1', PAGE_B.id, '"b1"', { title: 'Runbook v2' })
})

it('folds a title and a body edit of the same page inside the window into one write', async () => {
  const { metadata, write } = await openWorkspace()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  typeTitle('Architecture v2')
  fireEvent.change(screen.getByLabelText(fr['console.docs.collab.mode-markdown']), {
    target: { value: '# Architecture\nMore.' },
  })
  await act(async () => {
    vi.advanceTimersByTime(400)
  })

  expect(metadata).not.toHaveBeenCalled()
  expect(write).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledWith('org-1', PAGE_A.id, '"a1"', {
    title: 'Architecture v2',
    markdown: '# Architecture\nMore.',
  })
})

it('sends the pending write when the surface unmounts inside the debounce window', async () => {
  const { view, metadata } = await openWorkspace()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  typeTitle('Architecture v2')
  expect(metadata).not.toHaveBeenCalled()
  view.unmount()

  expect(metadata).toHaveBeenCalledTimes(1)
  expect(metadata).toHaveBeenCalledWith('org-1', PAGE_A.id, '"a1"', { title: 'Architecture v2' })
  // The cleared timer never sends it a second time.
  vi.advanceTimersByTime(1000)
  expect(metadata).toHaveBeenCalledTimes(1)
})

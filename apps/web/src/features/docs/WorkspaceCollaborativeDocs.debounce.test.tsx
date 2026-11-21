// The debounced page writes of a server-backed workspace: one pending write per page, so editing
// page B inside the debounce window never cancels the write page A still owes, edits of one page
// inside the window fold into a single write, and leaving the surface sends what is owed instead
// of dropping it.
import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { afterEach, expect, it, vi } from 'vitest'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { ApiProblem } from '@/api/client'
import i18n from '@/i18n'
import fr from '@/i18n/fr.json'
import { MSG_SYNC, type WebSocketLike } from './collabSession'
import { getDocsDriveCopy } from './docsDriveMessages'
import { markdownToTiptapDoc } from './markdownBlocks'
import {
  CalloutBlockNode,
  CspSafeTaskItem,
  CspSafeTaskList,
  DiagramBlockNode,
  DocTableCellNode,
  DocTableHeaderNode,
  DocTableNode,
  DocTableRowNode,
  WikilinkNode,
} from './richBlocksExtensions'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it('keeps the saving indicator active while another document save is still in flight', async () => {
  const copy = getDocsDriveCopy('fr')
  const { metadata } = await openWorkspace()
  const saveA = deferred<{ document: CoreWorkspaceDocument; etag: string }>()
  const saveB = deferred<{ document: CoreWorkspaceDocument; etag: string }>()
  metadata.mockImplementation((_organisationId, documentId) =>
    documentId === PAGE_A.id ? saveA.promise : saveB.promise
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  typeTitle('Architecture v2')
  fireEvent.click(screen.getByTestId(`docs-tree-item-${PAGE_B.id}`))
  typeTitle('Runbook v2')
  expect(screen.getByTestId('docs-save-state')).toHaveTextContent(copy.saveStateSaving)

  // Fire both debounce timers so the queued timer Map is empty and both HTTP writes are in flight.
  await act(async () => {
    vi.advanceTimersByTime(400)
  })
  expect(metadata).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('docs-save-state')).toHaveTextContent(copy.saveStateSaving)

  // Resolving page A while page B is still unresolved must NOT report "Saved" prematurely.
  await act(async () => {
    saveA.resolve({ document: PAGE_A, etag: '"a2"' })
    await saveA.promise
  })
  expect(screen.getByTestId('docs-save-state')).toHaveTextContent(copy.saveStateSaving)

  // Only once page B also settles does the indicator report "Saved".
  await act(async () => {
    saveB.resolve({ document: PAGE_B, etag: '"b2"' })
    await saveB.promise
  })
  expect(screen.getByTestId('docs-save-state')).toHaveTextContent(copy.saveStateSaved)
})

it('clears in-flight tracking in finally even when a concurrent save rejects', async () => {
  const copy = getDocsDriveCopy('fr')
  const { metadata } = await openWorkspace()
  const saveA = deferred<{ document: CoreWorkspaceDocument; etag: string }>()
  const saveB = deferred<{ document: CoreWorkspaceDocument; etag: string }>()
  metadata.mockImplementation((_organisationId, documentId) =>
    documentId === PAGE_A.id ? saveA.promise : saveB.promise
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  typeTitle('Architecture v2')
  fireEvent.click(screen.getByTestId(`docs-tree-item-${PAGE_B.id}`))
  typeTitle('Runbook v2')
  await act(async () => {
    vi.advanceTimersByTime(400)
  })

  await act(async () => {
    saveA.reject(new Error('network'))
    await saveA.promise.catch(() => undefined)
  })
  expect(screen.getByTestId('docs-save-state')).toHaveTextContent(copy.saveStateSaving)

  await act(async () => {
    saveB.resolve({ document: PAGE_B, etag: '"b2"' })
    await saveB.promise
  })
  expect(screen.getByTestId('docs-save-state')).toHaveTextContent(copy.saveStateSaved)
})

function createMockYjsRelay(initialDoc: JSONContent) {
  const schema = getSchema([
    StarterKit.configure({
      dropcursor: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false },
    }),
    CspSafeTaskList,
    CspSafeTaskItem,
    CalloutBlockNode,
    DocTableNode,
    DocTableRowNode,
    DocTableHeaderNode,
    DocTableCellNode,
    DiagramBlockNode,
    WikilinkNode,
  ])
  const serverDoc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(schema, initialDoc, serverDoc.getXmlFragment('content'))
  const sockets = new Set<WebSocketLike & { readyState: number }>()

  serverDoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'client') return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    const frame = encoding.toUint8Array(encoder)
    for (const sock of sockets) {
      if (sock.readyState === 1) {
        sock.onmessage?.(new MessageEvent('message', { data: frame }))
      }
    }
  })

  const webSocketFactory = (): WebSocketLike => {
    let authed = false
    const sock: WebSocketLike & { readyState: number } = {
      binaryType: 'arraybuffer',
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string | Uint8Array) {
        if (typeof data === 'string') {
          const parsed = JSON.parse(data) as { type?: string }
          if (parsed.type === 'auth') authed = true
          return
        }
        if (!authed) return
        const decoder = decoding.createDecoder(data)
        const messageType = decoding.readVarUint(decoder)
        if (messageType !== MSG_SYNC) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MSG_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, serverDoc, 'client')
        if (encoding.length(encoder) > 1) {
          const reply = encoding.toUint8Array(encoder)
          queueMicrotask(() => {
            if (sock.readyState === 1) {
              sock.onmessage?.(new MessageEvent('message', { data: reply }))
            }
          })
        }
      },
      close() {
        sock.readyState = 3
        sockets.delete(sock)
      },
    }
    sockets.add(sock)
    queueMicrotask(() => {
      sock.readyState = 1
      sock.onopen?.(new Event('open'))
    })
    return sock
  }

  const readServerJson = () =>
    yXmlFragmentToProsemirrorJSON(serverDoc.getXmlFragment('content')) as JSONContent

  const replaceServerMarkdownFromPeer = (markdown: string) => {
    serverDoc.transact(() => {
      prosemirrorJSONToYXmlFragment(
        schema,
        markdownToTiptapDoc(markdown),
        serverDoc.getXmlFragment('content')
      )
    }, 'peer')
  }

  return { serverDoc, webSocketFactory, readServerJson, replaceServerMarkdownFromPeer }
}

it('keeps the Markdown tab explicitly read-only with localized fr/en banner under a live Yjs session, reflecting peer updates without corrupting rich marks', async () => {
  await i18n.changeLanguage('fr')
  const user = userEvent.setup()
  const richInitialDoc: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Architecture' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Underlined', marks: [{ type: 'underline' }] },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'Both',
            marks: [{ type: 'bold' }, { type: 'italic' }],
          },
        ],
      },
    ],
  }
  const relay = createMockYjsRelay(richInitialDoc)
  const beforeJson = relay.readServerJson()

  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([PAGE_A])
  vi.spyOn(docsApi, 'getWorkspaceDocument').mockResolvedValue({
    document: PAGE_A,
    etag: '"a1"',
  })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockResolvedValue({
    wsUrl: 'wss://core.fixture.test/documents/collab',
    token: 'ticket-1',
    expiresAt: '2026-01-01T01:00:00Z',
    role: 'editor',
  })
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument')

  try {
    render(
      <WorkspaceCollaborativeDocs
        organisationId="org-1"
        currentUser={{ id: 'u-1', name: 'Alex' }}
        initialSurface="blocks"
        webSocketFactory={relay.webSocketFactory}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('docs-collab-status-pill')).toHaveTextContent(
        fr['console.docs.collab.status-synced']
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('docs-collab-prosemirror')).toHaveTextContent('Underlined and Both')
    )

    await user.click(screen.getByTestId('docs-surface-markdown'))
    const textarea = screen.getByLabelText(
      fr['console.docs.collab.mode-markdown']
    ) as HTMLTextAreaElement
    expect(textarea).toHaveAttribute('readonly')
    expect(textarea).toHaveAttribute('aria-readonly', 'true')
    expect(screen.getByTestId('docs-readonly-banner')).toHaveTextContent(
      'Aperçu Markdown en lecture seule'
    )

    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByTestId('docs-readonly-banner')).toHaveTextContent(
      'Read-only Markdown preview: live collaborative rich-text sync owns this page’s body.'
    )
    await act(async () => {
      await i18n.changeLanguage('fr')
    })

    // Attempted raw Markdown change is ignored so rich Yjs marks (underline + bold/italic) stay intact.
    fireEvent.change(textarea, {
      target: { value: '# Architecture\n\nAttempted overwrite' },
    })
    expect(textarea.value).not.toContain('Attempted overwrite')
    expect(relay.readServerJson()).toEqual(beforeJson)
    expect(write).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('docs-surface-blocks'))
    const prosemirror = await screen.findByTestId('docs-collab-prosemirror')
    expect(prosemirror.querySelector('u')?.textContent).toBe('Underlined')
    expect(prosemirror.querySelector('strong em, em strong')?.textContent).toBe('Both')
    expect(relay.readServerJson()).toEqual(beforeJson)

    // Live Yjs updates from collaborators still update the read-only Markdown preview.
    await user.click(screen.getByTestId('docs-surface-markdown'))
    await act(async () => {
      relay.replaceServerMarkdownFromPeer('# Architecture\n\nLive peer update')
    })
    await waitFor(() =>
      expect(
        (screen.getByLabelText(fr['console.docs.collab.mode-markdown']) as HTMLTextAreaElement)
          .value
      ).toContain('Live peer update')
    )
  } finally {
    relay.serverDoc.destroy()
  }
})

it('marks the Markdown surface read-only while a remote Yjs session has not yet synchronized', async () => {
  await i18n.changeLanguage('fr')
  const copy = getDocsDriveCopy('fr')
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([PAGE_A])
  vi.spyOn(docsApi, 'getWorkspaceDocument').mockResolvedValue({
    document: PAGE_A,
    etag: '"a1"',
  })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockResolvedValue({
    wsUrl: 'wss://core.fixture.test/documents/collab',
    token: 'ticket-1',
    expiresAt: '2026-01-01T01:00:00Z',
    role: 'editor',
  })

  render(
    <WorkspaceCollaborativeDocs
      organisationId="org-1"
      currentUser={{ id: 'u-1', name: 'Alex' }}
      initialSurface="markdown"
      webSocketFactory={neverOpens}
    />
  )

  const textarea = await screen.findByLabelText(fr['console.docs.collab.mode-markdown'])
  expect(textarea).toHaveAttribute('readonly')
  expect(screen.getByTestId('docs-readonly-banner')).toBeInTheDocument()
  expect(screen.getByTestId('docs-save-state')).not.toHaveTextContent(copy.saveStateSaved)
})

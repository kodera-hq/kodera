import { createRef, useState } from 'react'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { WorkspaceCollaborativeDocs, type WorkspacePageRecord } from './WorkspaceCollaborativeDocs'
import { DriveWorkspaceContext, type DriveWorkspaceContextValue } from './DriveWorkspaceContext'
import { DOCUMENT_KIND_MARKERS } from './driveKinds'
import { EspaceCanvasPanes, type EspaceCanvasPanesProps } from '../espace/EspaceCanvasPanes'
import { EspaceChannelHeader, type EspaceChannelHeaderProps } from '../espace/EspaceChannelHeader'
import { workspaceFilesOf } from '../espace/workspaceFiles'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { EspaceSnapshot } from '../espace/matrix/store'
import type { Workspace } from '../workspace/workspace'

vi.mock('../whiteboard/WhiteboardCanvas', () => ({
  WhiteboardCanvas: () => <canvas data-testid="whiteboard-canvas" />,
}))

const page: WorkspacePageRecord = {
  id: 'intro',
  title: 'Introduction',
  parentId: null,
  markdown: '# Introduction\n\n## Overview',
  role: 'editor',
  updatedAt: '',
}
function LocalDrive() {
  const [docs, setDocs] = useState<readonly WorkspacePageRecord[]>([page])
  return <WorkspaceCollaborativeDocs localDocuments={docs} onLocalDocumentsChange={setDocs} />
}

describe('Unified Drive navigation and document kinds', () => {
  it('offers the six filters, grid/list views, a virtual folder, and routes each persisted kind directly', async () => {
    const user = userEvent.setup()
    const { container } = render(<LocalDrive />)
    const filters = screen.getByRole('group', { name: 'Filtrer par type' })
    expect(
      within(filters)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Tout', 'Dossiers', 'Pages', 'Bases', 'Tableaux blancs', 'Fichiers'])
    expect(screen.getByTestId('drive-folder-card-virtual:channel-attachments')).toHaveTextContent(
      'Pièces jointes des salons'
    )
    await user.click(screen.getByTestId('drive-view-list'))
    expect(screen.getByTestId('drive-list-container')).toBeInTheDocument()
    await user.click(screen.getByTestId('drive-view-grid'))
    await user.click(screen.getByTestId('drive-doc-card-intro'))
    expect(screen.getByTestId('docs-collab-prosemirror')).toBeInTheDocument()
    expect(screen.getByTestId('docs-page-toc')).toHaveTextContent('Overview')
    await user.click(screen.getByTestId('docs-breadcrumb-drive-root'))
    await user.click(screen.getByRole('button', { name: 'Nouvelle base' }))
    expect(await screen.findByTestId('docs-collection-view')).toBeInTheDocument()
    await user.click(screen.getByTestId('collection-view-tab-board'))
    expect(screen.getByTestId('collection-view-tab-board')).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByTestId('docs-breadcrumb-drive-root'))
    await user.click(screen.getByTestId('drive-filter-bases'))
    expect(screen.queryByTestId('drive-doc-card-intro')).toBeNull()
    const base = within(screen.getByTestId('docs-drive-explorer')).getByRole('button', {
      name: /Ouvrir le document Nouvelle base/,
    })
    await user.click(base)
    expect(await screen.findByTestId('docs-collection-view')).toBeInTheDocument()
    await user.click(screen.getByTestId('docs-breadcrumb-drive-root'))
    await user.click(screen.getByRole('button', { name: 'Nouveau tableau blanc' }))
    expect(await screen.findByTestId('whiteboard-canvas')).toBeInTheDocument()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Replier l’arborescence' }))
    expect(screen.queryByRole('complementary', { name: 'Arborescence Drive & Pages' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Déployer l’arborescence' }))
    expect(
      screen.getByRole('complementary', { name: 'Arborescence Drive & Pages' })
    ).toBeInTheDocument()
  })

  it('round-trips kind markers without a schema field', async () => {
    const user = userEvent.setup()
    const docs = [
      page,
      { ...page, id: 'base', title: 'Project database', markdown: DOCUMENT_KIND_MARKERS.base },
      { ...page, id: 'board', title: 'Workshop', markdown: DOCUMENT_KIND_MARKERS.whiteboard },
    ]
    render(<WorkspaceCollaborativeDocs localDocuments={docs} />)
    await user.click(screen.getByTestId('drive-doc-card-base'))
    expect(await screen.findByTestId('docs-collection-view')).toBeInTheDocument()
    await user.click(screen.getByTestId('docs-breadcrumb-drive-root'))
    await user.click(screen.getByTestId('drive-doc-card-board'))
    expect(await screen.findByTestId('whiteboard-canvas')).toBeInTheDocument()
  })

  it('disables link copying, creation and publishing at a confidential boundary', async () => {
    const publish = vi.fn()
    const upload = vi.fn()
    const user = userEvent.setup()
    const { container } = render(
      <WorkspaceCollaborativeDocs
        localDocuments={[page]}
        roomBoundary="confidential-unavailable"
        onPublishToChannel={publish}
        onUploadFiles={upload}
      />
    )
    expect(screen.getByText('🔒 Salon confidentiel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nouvelle page' })).toBeDisabled()
    expect(screen.getByLabelText('Importer des fichiers')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Partager' }))
    const share = screen.getByRole('dialog', { name: 'Partager' })
    expect(within(share).getByRole('button', { name: 'Copier le lien interne' })).toBeDisabled()
    expect(within(share).getByRole('alert')).toHaveTextContent('Partage externe refusé')
    expect(within(share).getByText(/Héritage du dossier/)).toBeInTheDocument()
    expect(publish).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('publishes the active page and copies an internal link without changing access', async () => {
    const user = userEvent.setup()
    const publish = vi.fn().mockResolvedValue(undefined)
    render(<WorkspaceCollaborativeDocs localDocuments={[page]} onPublishToChannel={publish} />)
    await user.click(screen.getByTestId('drive-doc-card-intro'))
    await user.click(screen.getByRole('button', { name: 'Publier dans le salon' }))
    await waitFor(() => expect(publish).toHaveBeenCalledWith(page))
    await user.click(screen.getByRole('button', { name: 'Partager' }))
    await user.click(screen.getByRole('button', { name: 'Copier le lien interne' }))
    await waitFor(() => expect(screen.getByText('Lien interne copié.')).toBeInTheDocument())
    expect(await navigator.clipboard.readText()).toContain('document=intro')
  })
})

it('excludes confidential, unknown, invalid and flagged channel and direct attachments before reading timelines', () => {
  const channels = ['public', 'private', 'unknown', 'invalid', 'flagged'].map((id) => ({
    id,
    label: id,
    kind: 'text' as const,
    isConfidential: id === 'flagged',
  }))
  const snapshot = {
    channels: new Map(
      channels.map((channel) => [channel.id, { state: 'resolved', roomId: `!${channel.id}` }])
    ),
    rooms: [],
  } as unknown as EspaceSnapshot
  const timeline = vi.fn(() => [
    {
      eventId: '$file',
      ts: 1,
      sender: '@member:example.test',
      attachment: { name: 'Visible.txt' },
    },
  ])
  const store = {
    getTimeline: timeline,
    getDirects: () => [{ roomId: '!direct', name: 'Private direct' }],
    getRoomBoundary: (room: string) =>
      room === '!public'
        ? 'ordinary'
        : room === '!unknown'
          ? 'unknown'
          : room === '!invalid'
            ? 'invalid'
            : 'confidential-unavailable',
  } as unknown as EspaceStoreLike
  const entries = workspaceFilesOf(store, snapshot, channels, [
    { id: 'private-doc', channelId: 'private', title: 'Private title', content: 'Secret' },
  ])
  expect(entries).toHaveLength(1)
  expect(entries[0]?.channel.id).toBe('public')
  expect(timeline).toHaveBeenCalledTimes(1)
  expect(timeline).toHaveBeenCalledWith('!public')
})

it.each(['docs', 'files'] as const)(
  'mounts the lazy unified %s canvas without an external slot, even after a direct conversation',
  async (effectiveCanvasMode) => {
    const snapshot = { channels: new Map(), rooms: [] } as unknown as EspaceSnapshot
    const props: EspaceCanvasPanesProps = {
      effectiveCanvasMode,
      directRoomId: '!direct',
      docsCanvasSlot: undefined,
      docsEverOpened: false,
      signedOut: false,
      onReconnect: undefined,
      activeChannel: null,
      searchEntries: [],
      activeStore: { getTimeline: () => [] } as unknown as EspaceStoreLike,
      snapshot,
      documents: [],
      openStudioDocument: undefined,
      onOpenDocument: undefined,
      onSelectTextChannel: vi.fn(),
      onSelectDirect: vi.fn(),
      workspace: { id: 'workspace', categories: [] } as unknown as Workspace,
      activeCall: null,
      callChannel: null,
      deviceSettings: null,
      onJoinAudioRoom: vi.fn(),
      onOpenCallStage: vi.fn(),
    }
    render(<EspaceCanvasPanes {...props} />)
    expect(await screen.findByTestId('docs-drive-explorer')).toBeVisible()
    expect(screen.getAllByRole('heading', { name: 'Drive & Docs' })).toHaveLength(1)
  }
)

it.each(['docs', 'files', 'integrations', 'calendar'] as const)(
  'hides the channel header on the %s surface',
  (effectiveCanvasMode) => {
    const props = {
      activeChannel: null,
      activeRoomId: null,
      activeStore: {},
      directRoomId: null,
      effectiveCanvasMode,
      headingRef: createRef(),
      inviteTrigger: createRef(),
      membersTrigger: createRef(),
      audioRooms: [],
    } as unknown as EspaceChannelHeaderProps
    const { container } = render(<EspaceChannelHeader {...props} />)
    expect(container.querySelector('header')).toHaveAttribute('hidden')
  }
)

it('opens channel documents in the editor and previews attachments before returning to their conversation', async () => {
  const user = userEvent.setup()
  const navigate = vi.fn()
  const store = {
    getTimeline: () => [
      { eventId: '$file', ts: 1, sender: '@member:example.test', attachment: { name: 'Plan.png' } },
    ],
    getRoomBoundary: () => 'ordinary',
  } as unknown as EspaceStoreLike
  const snapshot = {
    channels: new Map([['general', { state: 'resolved', roomId: '!general' }]]),
    rooms: [],
  } as unknown as EspaceSnapshot
  const value: DriveWorkspaceContextValue = {
    workspaceId: 'workspace',
    store,
    snapshot,
    channels: [{ id: 'general', label: 'général', kind: 'text' }],
    documents: [
      { id: 'guide', title: 'Channel guide', channelId: 'general', content: '## Channel guide' },
    ],
    activeChannelId: 'general',
    roomBoundary: 'ordinary',
    isConfidential: false,
    requestedDocument: undefined,
    onOpenChannel: navigate,
    onOpenDirect: vi.fn(),
  }
  const { container } = render(
    <DriveWorkspaceContext.Provider value={value}>
      <WorkspaceCollaborativeDocs localDocuments={[]} />
    </DriveWorkspaceContext.Provider>
  )
  await user.click(screen.getByTestId('drive-open-folder-virtual:channel-attachments'))
  expect(screen.getByTestId('drive-breadcrumbs')).toHaveTextContent('Pièces jointes des salons')
  await user.click(screen.getByRole('button', { name: 'Plan.png' }))
  const preview = await screen.findByRole('dialog', { name: 'Plan.png' })
  expect(navigate).not.toHaveBeenCalled()
  await user.click(within(preview).getByRole('button', { name: 'Ouvrir la conversation #général' }))
  expect(navigate).toHaveBeenCalledWith('general')
  await user.click(screen.getByTestId('drive-doc-card-channel:guide'))
  expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Channel guide')
  expect(screen.getByTestId('docs-collab-prosemirror')).toHaveTextContent('Channel guide')
  expect(container.querySelectorAll('[style]')).toHaveLength(0)
})

it('accepts files through the controlled upload callback without a workspace provider', async () => {
  const upload = vi.fn()
  const user = userEvent.setup()
  render(<WorkspaceCollaborativeDocs localDocuments={[]} onUploadFiles={upload} />)
  const file = new File(['# Brief'], 'brief.md', { type: 'text/markdown' })
  expect(screen.getByRole('button', { name: 'Importer des fichiers' })).toBeEnabled()
  await user.upload(screen.getByLabelText('Importer des fichiers'), file)
  expect(upload).toHaveBeenCalledWith([file])
})

it.each(['is_confidential', 'isConfidential'] as const)(
  'keeps uncategorised %s metadata when aggregating attachments and documents',
  async (flag) => {
    const timeline = vi.fn(() => [
      { eventId: '$secret', sender: '@a:example.test', ts: 0, attachment: { name: 'Private.txt' } },
    ])
    const store = {
      getTimeline: timeline,
      getRoomBoundary: () => 'ordinary',
    } as unknown as EspaceStoreLike
    const snapshot = {
      channels: new Map([['private', { state: 'resolved', roomId: '!private' }]]),
      rooms: [],
    } as unknown as EspaceSnapshot
    const props = {
      workspace: {
        id: 'workspace',
        categories: [],
        uncategorised_channels: [{ id: 'private', name: 'Private', kind: 'text', [flag]: true }],
      },
      searchEntries: [{ id: 'private', label: 'Private', kind: 'text' }],
      effectiveCanvasMode: 'docs',
      directRoomId: null,
      docsEverOpened: true,
      activeStore: store,
      snapshot,
      documents: [
        { id: 'secret', channelId: 'private', title: 'Private doc', content: '# Secret' },
      ],
      onSelectTextChannel: vi.fn(),
      onSelectDirect: vi.fn(),
    } as unknown as EspaceCanvasPanesProps
    render(<EspaceCanvasPanes {...props} />)
    await userEvent
      .setup()
      .click(await screen.findByTestId('drive-open-folder-virtual:channel-attachments'))
    expect(screen.queryByText('Private doc')).toBeNull()
    expect(screen.queryByText('Private.txt')).toBeNull()
    expect(timeline).not.toHaveBeenCalled()
  }
)

it.each([null, '!direct'])(
  'unmounts ordinary documents in protected chat (direct room: %s)',
  async (directRoomId) => {
    const deleted = vi.fn()
    vi.stubGlobal('indexedDB', { deleteDatabase: deleted })
    try {
      const props = {
        workspace: { id: 'workspace', categories: [], uncategorised_channels: [] },
        searchEntries: [],
        effectiveCanvasMode: 'docs',
        directRoomId: null,
        docsEverOpened: true,
        activeStore: { getTimeline: () => [] },
        snapshot: { channels: new Map(), rooms: [] },
        documents: [],
        roomBoundary: 'ordinary',
        isConfidential: false,
        docsCanvasSlot: (
          <WorkspaceCollaborativeDocs localDocuments={[page]} activeDocumentId="intro" />
        ),
        onSelectTextChannel: vi.fn(),
        onSelectDirect: vi.fn(),
      } as unknown as EspaceCanvasPanesProps
      const view = render(<EspaceCanvasPanes {...props} />)
      expect(await screen.findByTestId('docs-page-title-input')).toHaveValue('Introduction')
      view.rerender(
        <EspaceCanvasPanes
          {...props}
          directRoomId={directRoomId}
          effectiveCanvasMode="chat"
          roomBoundary="confidential-unavailable"
          isConfidential
        />
      )
      expect(screen.queryByTestId('workspace-collaborative-docs')).toBeNull()
      expect(deleted).not.toHaveBeenCalled()
      view.rerender(<EspaceCanvasPanes {...props} />)
      expect(await screen.findByTestId('docs-page-title-input')).not.toHaveAttribute('readonly')
      expect(deleted).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  }
)

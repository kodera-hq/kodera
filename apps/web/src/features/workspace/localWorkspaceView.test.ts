import { afterEach, expect, it, vi } from 'vitest'
import {
  registerDemoViewStorage,
  registerInteractiveDemos,
  writeDemoView,
} from '../../app/interactiveDemo'
import { readLocalWorkspaceView } from './localWorkspaceView'

afterEach(() => registerInteractiveDemos([]))
it('restores channel notes only through the registered demo storage capability', () => {
  const saved = new Map<string, unknown>()
  registerDemoViewStorage({
    read: (key) => saved.get(key),
    write: (key, value) => saved.set(key, value),
  })
  registerInteractiveDemos([{ slug: 'community', createStore: vi.fn() }])
  const view = {
    channels: {},
    docs: {
      docs: [
        { id: 'doc-1', channelId: 'channel-1', title: 'Team decision', content: '# Decision' },
      ],
      selectedByChannel: { 'channel-1': 'doc-1' },
    },
  }
  writeDemoView('community:workspace-1', view)
  expect(readLocalWorkspaceView('community:workspace-1')).toEqual({ ...view, pages: [] })
  expect(readLocalWorkspaceView('other:workspace-2').docs.docs).toEqual([])
  registerInteractiveDemos([])
  expect(readLocalWorkspaceView('community:workspace-1').docs.docs).toEqual([])
})
it('discards malformed persisted state instead of breaking the workspace', () => {
  registerDemoViewStorage({
    read: () => ({ channels: { category: [{ kind: 'unknown' }] }, docs: null }),
    write: vi.fn(),
  })
  registerInteractiveDemos([{ slug: 'community', createStore: vi.fn() }])
  expect(readLocalWorkspaceView('community:workspace-1')).toEqual({
    channels: {},
    pages: [],
    docs: { docs: [], selectedByChannel: {} },
  })
})

it('restores every created channel beyond 256 without discarding unrelated notes', () => {
  const channels = Array.from({ length: 257 }, (_, index) => ({
    id: `local-${index}`,
    name: `room-${index}`,
    kind: 'text',
    topic: '',
    template_key: null,
    lifecycle: 'active',
    is_confidential: false,
    room_state: 'ready',
  }))
  const saved = {
    channels: { community: channels },
    docs: {
      docs: [
        { id: 'note-1', channelId: 'welcome', title: 'Retained note', content: 'Keep this draft' },
      ],
      selectedByChannel: { welcome: 'note-1' },
    },
  }
  registerDemoViewStorage({ read: () => saved, write: vi.fn() })
  registerInteractiveDemos([{ slug: 'community', createStore: vi.fn() }])
  expect(readLocalWorkspaceView('community:workspace-1')).toEqual({ ...saved, pages: [] })
})

it('restores quoted review comments and rejects malformed comment state', () => {
  const comment = {
    id: 'review',
    authorId: 'claire',
    authorName: 'Claire Mercer',
    createdAtLabel: '12 min ago',
    body: 'Check access',
    quote: 'Before sharing',
    resolved: true,
  }
  const saved = {
    channels: {},
    docs: {
      docs: [
        {
          id: 'doc',
          channelId: 'design',
          title: 'Guide',
          content: 'Updated source',
          comments: [comment],
        },
      ],
      selectedByChannel: { design: 'doc' },
    },
  }
  registerDemoViewStorage({ read: () => saved, write: vi.fn() })
  registerInteractiveDemos([{ slug: 'community', createStore: vi.fn() }])
  expect(readLocalWorkspaceView('community:workspace-1')).toEqual({ ...saved, pages: [] })
  saved.docs.docs[0]!.comments[0]!.body = 'x'.repeat(4001)
  expect(readLocalWorkspaceView('community:workspace-1').docs.docs).toEqual([])
})

it('round-trips Drive item kinds and database metadata through the local workspace view', () => {
  const page = {
    id: 'database',
    parentId: null,
    title: 'Tracking',
    markdown: '<!-- kodera:doc-kind:base -->',
    role: 'editor',
    updatedAt: '',
  }
  const view = { channels: {}, docs: { docs: [], selectedByChannel: {} }, pages: [page] }
  registerDemoViewStorage({ read: () => view, write: vi.fn() })
  registerInteractiveDemos([{ slug: 'community', createStore: vi.fn() }])
  expect(readLocalWorkspaceView('community:workspace-1').pages).toEqual([page])
})

it.each([
  ['ASCII', 'x'.repeat(65537)],
  ['UTF-8', 'é'.repeat(131072)],
])('restores large valid %s channel edits without losing workspace pages', (_encoding, content) => {
  const saved = {
    channels: {},
    docs: {
      docs: [{ id: 'guide', channelId: 'general', title: 'Guide', content }],
      selectedByChannel: {},
    },
    pages: [
      {
        id: 'unrelated',
        title: 'Keep',
        markdown: '# Keep',
        parentId: null,
        role: 'editor',
        updatedAt: '',
      },
    ],
  }
  registerDemoViewStorage({ read: () => saved, write: vi.fn() })
  registerInteractiveDemos([{ slug: 'community', createStore: vi.fn() }])
  expect(readLocalWorkspaceView('community:workspace-1')).toEqual(saved)
})

import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '@/api/client'
import { CollaborativeBlockEditor } from './CollaborativeBlockEditor'
import { DocsDriveExplorer, FOLDER_MARKDOWN_MARKER } from './DocsDriveExplorer'
import { buildDocumentTree } from './pageTree'
import { WorkspaceCollaborativeDocs, type WorkspacePageRecord } from './WorkspaceCollaborativeDocs'
import * as docsApi from './workspaceDocumentsApi'

afterEach(() => {
  vi.restoreAllMocks()
})

const SEED_DOCS: readonly WorkspacePageRecord[] = [
  {
    id: 'folder-eng',
    parentId: null,
    title: 'Ingénierie',
    markdown: `${FOLDER_MARKDOWN_MARKER}\n`,
    role: 'editor',
    order: 0,
    updatedAt: '2026-11-18T10:00:00.000Z',
  },
  {
    id: 'doc-arch',
    parentId: 'folder-eng',
    title: 'Architecture Système',
    markdown: '# Vue globale\n\n## Authentification\n\nVoir [[Runbook SRE]] pour les détails.',
    role: 'editor',
    order: 0,
    updatedAt: '2026-11-19T12:00:00.000Z',
  },
  {
    id: 'doc-runbook',
    parentId: null,
    title: 'Runbook SRE',
    markdown: '## Procédure d’astreinte\n\nÉtapes de diagnostic.',
    role: 'editor',
    order: 1,
    updatedAt: '2026-11-17T08:30:00.000Z',
  },
]

function ControlledWorkspaceDocsHarness() {
  const [docs, setDocs] = useState<readonly WorkspacePageRecord[]>(SEED_DOCS)
  return (
    <WorkspaceCollaborativeDocs
      localDocuments={docs}
      onLocalDocumentsChange={setDocs}
      workspaceFiles={[
        {
          id: 'file-spec-pdf',
          name: 'architecture-v2.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 245_760,
          updatedAt: '2026-11-19T09:00:00.000Z',
          folderId: 'folder-eng',
        },
      ]}
    />
  )
}

describe('Docs 820px Paper Canvas, Icon-Only Ribbon, and Google Drive Explorer (issues 214, 227)', () => {
  it('renders a centered 820px paper sheet and an icon-only formatting ribbon with zero superfluous text words like "Lien"', async () => {
    const user = userEvent.setup()
    const onExportMarkdown = vi.fn()

    const { container } = render(
      <CollaborativeBlockEditor
        documentId="doc-arch"
        markdown="# Vue globale\n\nVoir [[Runbook SRE]]."
        onMarkdownChange={vi.fn()}
        onExportMarkdown={onExportMarkdown}
      />
    )

    const paper = screen.getByTestId('docs-paper-canvas')
    expect(paper.className).toContain('max-w-[820px]')

    const ribbon = screen.getByTestId('docs-formatting-ribbon')
    // Zero visible "Lien" or "Link" word inside the ribbon — pure SVG icon button only!
    expect(ribbon.textContent).not.toMatch(/\bLien\b/i)
    expect(ribbon.textContent).not.toMatch(/\bLink\b/i)
    expect(ribbon.textContent).not.toContain('[[')

    // Wikilink pill inside ProseMirror never leaks raw [[ ]] brackets visually
    const wikilinkNode = container.querySelector('button[data-wikilink]')
    expect(wikilinkNode).not.toBeNull()
    expect(wikilinkNode?.textContent).toContain('Runbook SRE')
    expect(wikilinkNode?.textContent).not.toContain('[[')

    // Pure SVG link icon opens the safe URL popover (and validates scheme)
    await user.click(screen.getByTestId('docs-ribbon-link'))
    expect(screen.getByTestId('docs-link-popover')).toBeInTheDocument()
    const linkInput = screen.getByTestId('docs-link-url-input')
    await user.type(linkInput, 'javascript:alert(1)')
    await user.click(screen.getByTestId('docs-link-apply'))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // Markdown export icon triggers download callback
    await user.click(screen.getByTestId('docs-ribbon-export'))
    expect(onExportMarkdown).toHaveBeenCalledTimes(1)

    // Strict CSP invariant
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('navigates Google Drive Explorer folders, breadcrumbs, Grid/List views, search/filters, and opens documents into the 820px editor', async () => {
    const user = userEvent.setup()

    const { container } = render(<ControlledWorkspaceDocsHarness />)

    // Switch to Explorateur Drive surface
    await user.click(screen.getByTestId('docs-surface-drive'))
    const explorer = screen.getByTestId('docs-drive-explorer')
    expect(explorer).toBeInTheDocument()
    // Single-page header controls must not render while browsing Drive
    expect(screen.queryByTestId('docs-parent-select')).not.toBeInTheDocument()

    // Root shows folder "Ingénierie" and root doc "Runbook SRE", not nested "Architecture Système"
    expect(screen.getByTestId('drive-folder-card-folder-eng')).toBeInTheDocument()
    expect(screen.getByTestId('drive-doc-card-doc-runbook')).toBeInTheDocument()
    expect(screen.queryByTestId('drive-doc-card-doc-arch')).not.toBeInTheDocument()

    // Filter pill: Folders only hides root documents
    await user.click(screen.getByTestId('drive-filter-folders'))
    expect(screen.getByTestId('drive-folder-card-folder-eng')).toBeInTheDocument()
    expect(screen.queryByTestId('drive-doc-card-doc-runbook')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('drive-filter-all'))

    // Create a new folder at root
    await user.click(screen.getByTestId('drive-new-folder-btn'))
    await user.type(screen.getByTestId('drive-new-folder-input'), 'Design Produit')
    await user.click(screen.getByTestId('drive-new-folder-submit'))
    expect(within(explorer).getByText('Design Produit')).toBeInTheDocument()

    // Navigate into "Ingénierie" folder -> nested breadcrumb + child document + hosted file appear
    await user.click(screen.getByTestId('drive-open-folder-folder-eng'))
    const breadcrumbs = screen.getByTestId('drive-breadcrumbs')
    expect(within(breadcrumbs).getByText('Ingénierie')).toBeInTheDocument()
    expect(screen.getByTestId('drive-doc-card-doc-arch')).toBeInTheDocument()

    // Switch to List view and verify table rows render
    await user.click(screen.getByTestId('drive-view-list'))
    expect(screen.getByTestId('drive-list-container')).toBeInTheDocument()
    expect(screen.getByTestId('drive-list-doc-doc-arch')).toBeInTheDocument()

    // 1-click open "Architecture Système" into the 820px editor
    await user.click(screen.getByTestId('drive-list-open-doc-arch'))
    expect(screen.getByTestId('docs-paper-canvas')).toBeInTheDocument()
    expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Architecture Système')

    // Right-hand TOC outline shows headings and toggles cleanly
    const toc = screen.getByTestId('docs-page-toc')
    expect(within(toc).getByText('Vue globale')).toBeInTheDocument()
    expect(within(toc).getByText('Authentification')).toBeInTheDocument()
    await user.click(screen.getByTestId('docs-toc-toggle'))
    expect(screen.queryByTestId('docs-page-toc')).not.toBeInTheDocument()

    // Interactive editor breadcrumb returns directly to the parent Drive folder ("Ingénierie")
    await user.click(screen.getByTestId('docs-breadcrumb-folder-folder-eng'))
    expect(screen.getByTestId('docs-drive-explorer')).toBeInTheDocument()
    expect(within(screen.getByTestId('drive-breadcrumbs')).getByText('Ingénierie')).toBeInTheDocument()

    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('rejects javascript:, data:, vbscript:, and protocol-relative file.href schemes while preserving TOUCH_TARGET on safe file links', async () => {
    const user = userEvent.setup()
    const treeNodes = buildDocumentTree(SEED_DOCS)

    const { container } = render(
      <DocsDriveExplorer
        documents={SEED_DOCS}
        treeNodes={treeNodes}
        explicitFolderIds={new Set(['folder-eng'])}
        activeFolderId={null}
        onNavigateFolder={vi.fn()}
        onOpenDocument={vi.fn()}
        onCreateFolder={vi.fn()}
        onCreateDocumentInFolder={vi.fn()}
        canEdit
        files={[
          { id: 'f-js', name: 'xss-js.pdf', href: 'javascript:alert(1)', folderId: null },
          {
            id: 'f-data',
            name: 'xss-data.html',
            href: 'data:text/html,<script>alert(1)</script>',
            folderId: null,
          },
          { id: 'f-vbs', name: 'xss-vbs.doc', href: 'vbscript:msgbox(1)', folderId: null },
          {
            id: 'f-proto',
            name: 'xss-proto.pdf',
            href: '//evil.example.com/phish',
            folderId: null,
          },
          {
            id: 'f-https',
            name: 'safe-https.pdf',
            href: 'https://files.kodera.io/spec.pdf',
            folderId: null,
          },
          {
            id: 'f-rel',
            name: 'safe-rel.pdf',
            href: '/api/v1/files/safe-rel.pdf',
            folderId: null,
          },
        ]}
      />
    )

    expect(screen.queryByTestId('drive-file-open-f-js')).toBeNull()
    expect(screen.queryByTestId('drive-file-open-f-data')).toBeNull()
    expect(screen.queryByTestId('drive-file-open-f-vbs')).toBeNull()
    expect(screen.queryByTestId('drive-file-open-f-proto')).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container.querySelector('a[href^="data:"]')).toBeNull()
    expect(container.querySelector('a[href^="vbscript:"]')).toBeNull()

    const safeHttpsLink = screen.getByTestId('drive-file-open-f-https')
    expect(safeHttpsLink).toHaveAttribute('href', 'https://files.kodera.io/spec.pdf')
    expect(safeHttpsLink.className).toContain('narrow:min-h-[44px]')
    expect(safeHttpsLink.className).toContain('narrow:min-w-[44px]')

    const safeRelLink = screen.getByTestId('drive-file-open-f-rel')
    expect(safeRelLink).toHaveAttribute('href', '/api/v1/files/safe-rel.pdf')

    // Switch to List view and verify unsafe schemes remain blocked there too
    await user.click(screen.getByTestId('drive-view-list'))
    expect(screen.queryByTestId('drive-list-file-open-f-js')).toBeNull()
    expect(screen.queryByTestId('drive-list-file-open-f-data')).toBeNull()
    expect(screen.queryByTestId('drive-list-file-open-f-vbs')).toBeNull()
    expect(screen.getByTestId('drive-list-file-open-f-https')).toHaveAttribute(
      'href',
      'https://files.kodera.io/spec.pdf'
    )
  })

  it('persists FOLDER_MARKDOWN_MARKER remotely via updateWorkspaceDocument and strips raw HTML comment markers from ProseMirror', async () => {
    const user = userEvent.setup()

    vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([SEED_DOCS[2]!])
    vi.spyOn(docsApi, 'getWorkspaceDocument').mockImplementation(async (_org, docId) => ({
      document:
        docId === 'folder-remote-1'
          ? {
              id: 'folder-remote-1',
              parentId: null,
              title: 'Dossier Produit',
              markdown: `${FOLDER_MARKDOWN_MARKER}\n\n## Dossier Produit\n`,
              role: 'editor',
              updatedAt: '2026-11-19T14:00:00.000Z',
            }
          : SEED_DOCS[2]!,
      etag: docId === 'folder-remote-1' ? '"etag-folder-v2"' : '"etag-doc-v1"',
    }))
    vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
    vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockRejectedValue(
      new ApiProblem({ type: null, status: 501, title: 'Not Implemented' })
    )

    const createSpy = vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
      document: {
        id: 'folder-remote-1',
        parentId: null,
        title: 'Dossier Produit',
        // Core POST /documents ignores body markdown and initializes `# <title>\n`
        markdown: '# Dossier Produit\n',
        role: 'editor',
        updatedAt: '2026-11-19T14:00:00.000Z',
      },
      etag: '"etag-folder-v1"',
    })

    const updateSpy = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockImplementation(
      async (_org, id, _etag, patch) => ({
        document: {
          id,
          parentId: null,
          title: 'Dossier Produit',
          markdown: patch.markdown ?? `${FOLDER_MARKDOWN_MARKER}\n\n## Dossier Produit\n`,
          role: 'editor',
          updatedAt: '2026-11-19T14:01:00.000Z',
        },
        etag: '"etag-folder-v2"',
      })
    )

    render(<WorkspaceCollaborativeDocs organisationId="org-vercelli" />)

    expect(await screen.findByTestId('docs-tree-item-doc-runbook')).toBeInTheDocument()

    // Switch to Drive Explorer and create a remote folder
    await user.click(screen.getByTestId('docs-surface-drive'))
    await user.click(screen.getByTestId('drive-new-folder-btn'))
    await user.type(screen.getByTestId('drive-new-folder-input'), 'Dossier Produit')
    await user.click(screen.getByTestId('drive-new-folder-submit'))

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('org-vercelli', 'folder-remote-1', '"etag-folder-v1"', {
        markdown: expect.stringContaining(FOLDER_MARKDOWN_MARKER),
      })
    )

    // Open the folder's index note in the 820px editor: ProseMirror and Markdown textarea NEVER show raw <!-- kodera:drive-folder -->
    await user.click(await screen.findByTestId('drive-edit-folder-note-folder-remote-1'))
    await waitFor(() =>
      expect(screen.getByTestId('docs-collab-status-pill')).toHaveTextContent(/Édition locale/)
    )
    const proseMirror = await screen.findByTestId('docs-collab-prosemirror')
    expect(proseMirror.textContent).not.toContain('kodera:drive-folder')

    await user.click(screen.getByTestId('docs-surface-markdown'))
    const mdTextarea = screen.getByRole('textbox', { name: /Markdown/i }) as HTMLTextAreaElement
    expect(mdTextarea.value).not.toContain(FOLDER_MARKDOWN_MARKER)

    // Editing the folder note transparently re-prepends FOLDER_MARKDOWN_MARKER on remote save
    await user.type(mdTextarea, '\nNote d’équipe.')
    await waitFor(() =>
      expect(updateSpy).toHaveBeenLastCalledWith(
        'org-vercelli',
        'folder-remote-1',
        '"etag-folder-v2"',
        expect.objectContaining({
          markdown: expect.stringContaining(FOLDER_MARKDOWN_MARKER),
        })
      )
    )
  })
})

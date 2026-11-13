import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '@/api/client'
import type { DocumentAccessRole } from './pageTree'
import { CollaborativeBlockEditor } from './CollaborativeBlockEditor'
import { markdownToTiptapDoc, tiptapDocToMarkdown } from './markdownBlocks'
import { WorkspaceCollaborativeDocs, type WorkspacePageRecord } from './WorkspaceCollaborativeDocs'
import * as docsApi from './workspaceDocumentsApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CollaborativeBlockEditor and WorkspaceCollaborativeDocs', () => {
  it('inserts rich blocks via the / slash menu including task lists, callouts, tables, and CSP-safe SVG diagrams', async () => {
    const user = userEvent.setup()
    const onMarkdownChange = vi.fn()

    const { container } = render(
      <CollaborativeBlockEditor
        documentId="doc-1"
        markdown="## Architecture"
        onMarkdownChange={onMarkdownChange}
      />
    )

    const slashToggle = screen.getByRole('button', { name: /Insérer un bloc/i })
    await user.click(slashToggle)

    const listbox = screen.getByTestId('docs-slash-menu')
    expect(within(listbox).getAllByRole('option')).toHaveLength(12)

    // Insert a CSP-safe SVG diagram block
    await user.click(screen.getByTestId('docs-slash-item-diagram'))
    expect(await screen.findByTestId('docs-diagram-svg')).toBeInTheDocument()

    // Insert a checkable task list and toggle its checkbox
    await user.click(slashToggle)
    await user.click(screen.getByTestId('docs-slash-item-task'))
    const checkboxes = container.querySelectorAll('li[data-type="taskItem"] input[type="checkbox"]')
    expect(checkboxes.length).toBeGreaterThan(0)

    // Insert a semantic table and add a row
    await user.click(slashToggle)
    await user.click(screen.getByTestId('docs-slash-item-table'))
    expect(container.querySelector('table[data-doc-table]')).not.toBeNull()

    // Strict CSP check: zero <style> elements and zero inline style attributes anywhere!
    expect(container.querySelectorAll('style')).toHaveLength(0)
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    // A library may inject into <head>, outside the render container: the policy refuses that too.
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
    expect(onMarkdownChange).toHaveBeenCalled()
  })

  it('renders CSP-safe remote collaborator cursors and selections using only design-token classes', () => {
    const { container } = render(
      <CollaborativeBlockEditor
        documentId="doc-cursors"
        markdown="Shared paragraph with remote selection"
        peers={[
          {
            clientId: 42,
            userId: 'u-camille',
            name: 'Camille',
            role: 'editor',
            cursorSlot: 2,
            selection: { anchor: 2, head: 8 },
          },
        ]}
      />
    )

    const caret = container.querySelector('[data-collab-caret="u-camille"]')
    const selection = container.querySelector('[data-collab-selection="u-camille"]')
    expect(caret).not.toBeNull()
    expect(caret?.textContent).toBe('Camille')
    expect(selection).not.toBeNull()
    expect(selection?.className).toContain('bg-c-cursor-2-soft')
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('autocompletes [[Wikilinks]] and navigates to the linked document on click', async () => {
    const user = userEvent.setup()
    const onNavigateWikilink = vi.fn()

    render(
      <CollaborativeBlockEditor
        documentId="doc-main"
        markdown="See [[Runbook Exploitation]] for details."
        availablePages={[
          { id: 'doc-main', title: 'Overview' },
          { id: 'doc-runbook', title: 'Runbook Exploitation' },
          { id: 'doc-adr', title: 'ADR Storage' },
        ]}
        onNavigateWikilink={onNavigateWikilink}
      />
    )

    // Click existing [[Runbook Exploitation]] chip
    await user.click(screen.getByRole('button', { name: /Ouvrir la page Runbook Exploitation/i }))
    expect(onNavigateWikilink).toHaveBeenCalledWith('Runbook Exploitation')

    // Insert a new wikilink via the [[ ]] autocomplete menu
    await user.click(screen.getByRole('button', { name: /Lier une page/i }))
    const option = screen.getByTestId('docs-wikilink-option-doc-adr')
    await user.click(option)

    await user.click(screen.getByRole('button', { name: /Ouvrir la page ADR Storage/i }))
    expect(onNavigateWikilink).toHaveBeenCalledWith('ADR Storage')
  })

  it('enforces strict viewer read-only mode hiding mutation controls and disabling editing', () => {
    const onMarkdownChange = vi.fn()
    const viewerRole: DocumentAccessRole = 'viewer'
    render(
      <CollaborativeBlockEditor
        documentId="doc-readonly"
        markdown="## Approved Specification"
        role={viewerRole}
        onMarkdownChange={onMarkdownChange}
      />
    )

    expect(screen.getByTestId('docs-readonly-banner')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Insérer un bloc/i })).toBeNull()
    const textbox = screen.getByTestId('docs-collab-prosemirror')
    expect(textbox).toHaveAttribute('aria-readonly', 'true')
    expect(textbox).toHaveAttribute('contenteditable', 'false')
    expect(onMarkdownChange).not.toHaveBeenCalled()
  })

  it('round-trips table cells containing backslashes and escaped pipes losslessly', () => {
    const doc = markdownToTiptapDoc('| Key | Path |\n| --- | --- |\n| a \\| b | C:\\\\logs\\\\app |\n')
    const serialized = tiptapDocToMarkdown(doc)
    expect(serialized).toContain('| a \\| b | C:\\\\logs\\\\app |')
    const reparsed = markdownToTiptapDoc(serialized)
    expect(tiptapDocToMarkdown(reparsed)).toBe(serialized)
  })

  it('manages nested Core 0.43.0 workspace pages, 4 starter templates, backlinks, and non-empty parent delete refusal', async () => {
    const user = userEvent.setup()

    const initialDocs: WorkspacePageRecord[] = [
      {
        id: 'doc-root',
        parentId: null,
        title: 'Architecture Système',
        markdown: 'Root overview linking to [[Procédure Exploitation]].',
        role: 'editor',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'doc-child',
        parentId: 'doc-root',
        title: 'Procédure Exploitation',
        markdown: 'Child runbook linking back to [[Architecture Système]].',
        role: 'editor',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue(initialDocs)
    vi.spyOn(docsApi, 'getWorkspaceDocument').mockImplementation(async (_org, docId) => {
      const found = initialDocs.find((d) => d.id === docId) ?? initialDocs[0]!
      return { document: found, etag: `"etag-${docId}"` }
    })
    vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockImplementation(async (_org, docId) =>
      docId === 'doc-root'
        ? [{ documentId: 'doc-child', title: 'Procédure Exploitation' }]
        : [{ documentId: 'doc-root', title: 'Architecture Système' }]
    )
    vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockResolvedValue({
      wsUrl: 'wss://collab.kodera.io/ws/doc-root',
      token: 'short-lived-ticket',
      expiresAt: '2099-01-01T00:00:00Z',
      role: 'editor',
    })
    const createSpy = vi
      .spyOn(docsApi, 'createWorkspaceDocument')
      .mockImplementation(async (_org, body) => ({
        document: {
          id: 'doc-created-adr',
          parentId: body.parentId ?? null,
          title: body.title,
          markdown: '> [!NOTE]\n> Statut : Proposé\n\n## Décision',
          role: 'editor',
          updatedAt: '2026-01-01T01:00:00Z',
        },
        etag: '"etag-created"',
      }))
    vi.spyOn(docsApi, 'deleteWorkspaceDocument').mockRejectedValue(
      new ApiProblem({ type: null, status: 409, title: 'Conflict' })
    )

    const noopSocketFactory = () => ({
      binaryType: 'arraybuffer' as BinaryType,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    })

    const { container } = render(
      <WorkspaceCollaborativeDocs
        organisationId="org-1"
        currentUser={{ id: 'u-1', name: 'Alex' }}
        webSocketFactory={noopSocketFactory}
      />
    )

    expect(await screen.findByTestId('docs-tree-item-doc-root')).toBeInTheDocument()
    expect(screen.getByTestId('docs-tree-item-doc-child')).toHaveAttribute('data-depth', '2')

    // Backlinks footer displays incoming reference and navigates to it on click
    const backlinksFooter = await screen.findByTestId('docs-backlinks-footer')
    expect(backlinksFooter).toHaveTextContent('Procédure Exploitation')

    // Attempting to delete `doc-root` while `doc-child` exists refuses cleanly
    await user.click(screen.getByRole('button', { name: /Supprimer la page/i }))
    expect(await screen.findByTestId('docs-tree-error')).toHaveTextContent(/sous-pages/i)

    // Create a new page using the `adr` Core 0.43.0 starter template
    await user.selectOptions(screen.getByTestId('docs-template-select'), 'adr')
    await user.click(screen.getByRole('button', { name: 'Nouvelle page' }))
    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ templateKey: 'adr', parentId: null })
      )
    )

    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })
})

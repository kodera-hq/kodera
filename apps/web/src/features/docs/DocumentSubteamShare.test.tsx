import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ApiProblem } from '@/api/client'
import * as api from './documentRoleGrantsApi'
import * as docsApi from './workspaceDocumentsApi'
import { DocumentSubteamShare } from './DocumentSubteamShare'
import { WorkspaceCollaborativeDocs } from './WorkspaceCollaborativeDocs'
import type { WebSocketLike } from './collabSession'

const org = '00000000-0000-7000-8000-000000000001'
const doc = '00000000-0000-7000-8000-000000000002'
const otherDoc = '00000000-0000-7000-8000-000000000003'
const grant = {
  workspaceRoleId: 'engineering',
  name: 'Engineering',
  slug: 'engineering',
  role: 'editor' as const,
}
const snapshot = (
  grants: readonly api.DocumentRoleGrant[] = [grant],
  etag = '"v1"'
): api.DocumentRoleGrantsState => ({ grants, revision: 1, etag })
const subteams: readonly api.DocumentSubteam[] = [
  { id: 'engineering', name: 'Engineering', slug: 'engineering', mention: '@engineering' },
  { id: 'design', name: 'Design', slug: 'design', mention: '@design' },
]
const props = {
  organisationId: org,
  documentId: doc,
  remote: true,
  plaintextBlocked: false,
  canManageSharing: true,
}
const problem = (status: number) => new ApiProblem({ status, type: null, title: 'Refused' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const ordinarySession = {
  token: 'opaque',
  wsUrl: 'wss://collab.kodera.test',
  expiresAt: '2099-01-01T00:00:00Z',
  role: 'editor' as const,
  confidential: false,
  epoch: null,
}

// A confirmed ordinary session can later fall back to REST if ticket renewal is unavailable.
function ordinarySessionWithRestFallback() {
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession')
    .mockResolvedValueOnce(ordinarySession)
    .mockRejectedValue(problem(501))
  return (): WebSocketLike => {
    const socket: WebSocketLike = {
      binaryType: 'arraybuffer',
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    }
    queueMicrotask(() => socket.onclose?.(new CloseEvent('close', { code: 4401 })))
    return socket
  }
}

beforeEach(() => {
  vi.spyOn(api, 'listDocumentRoleGrants').mockResolvedValue(snapshot())
  vi.spyOn(api, 'listDocumentSubteams').mockResolvedValue(subteams)
  vi.spyOn(api, 'putDocumentRoleGrant').mockResolvedValue(snapshot())
  vi.spyOn(api, 'revokeDocumentRoleGrant').mockResolvedValue(snapshot([]))
})

describe('document subteam Share controls', () => {
  it('lists direct grants with mentions, names and levels, without styles or accessibility violations', async () => {
    const { container } = render(<DocumentSubteamShare {...props} />)
    expect(await screen.findByText('@engineering · Engineering')).toBeVisible()
    expect(screen.getByLabelText('Accès de @engineering')).toHaveValue('editor')
    expect(api.listDocumentRoleGrants).toHaveBeenCalledWith(org, doc, expect.any(AbortSignal))
    expect(api.listDocumentSubteams).toHaveBeenCalledWith(org, expect.any(AbortSignal))
    expect(container.querySelector('[style]')).toBeNull()
    expect((await axe.run(container)).violations).toEqual([])
  })

  it('requires an explicit selection again after a grant resolves between two clicks', async () => {
    const user = userEvent.setup()
    const request = deferred<api.DocumentRoleGrantsState>()
    vi.mocked(api.listDocumentRoleGrants).mockResolvedValue(snapshot([]))
    vi.mocked(api.putDocumentRoleGrant).mockReturnValueOnce(request.promise)
    render(<DocumentSubteamShare {...props} />)
    const button = await screen.findByRole('button', { name: 'Accorder l’accès' })
    expect(screen.getByLabelText('Sous-équipe')).toHaveValue('')
    expect(button).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Sous-équipe'), 'engineering')
    await user.selectOptions(screen.getByLabelText('Niveau d’accès'), 'editor')
    await user.click(button)
    expect(button).toBeDisabled()
    await act(async () => request.resolve(snapshot([grant], '"v2"')))
    expect(screen.getByLabelText('Sous-équipe')).toHaveValue('')
    expect(screen.getByLabelText('Niveau d’accès')).toHaveValue('viewer')
    await user.click(button)
    expect(api.putDocumentRoleGrant).toHaveBeenCalledTimes(1)
    await user.selectOptions(screen.getByLabelText('Sous-équipe'), 'design')
    await user.click(button)
    expect(api.putDocumentRoleGrant).toHaveBeenLastCalledWith(org, doc, 'design', 'viewer', '"v2"')
  })

  it.each(['editor', 'viewer'] as const)(
    'adds %s access using the current snapshot ETag',
    async (level) => {
      const user = userEvent.setup()
      vi.mocked(api.putDocumentRoleGrant).mockResolvedValue(
        snapshot(
          [
            ...snapshot().grants,
            { workspaceRoleId: 'design', name: 'Design', slug: 'design', role: level },
          ],
          '"v2"'
        )
      )
      render(<DocumentSubteamShare {...props} />)
      await screen.findByText('@engineering · Engineering')
      await user.selectOptions(screen.getByLabelText('Sous-équipe'), 'design')
      await user.selectOptions(screen.getByLabelText('Niveau d’accès'), level)
      await user.click(screen.getByRole('button', { name: 'Accorder l’accès' }))
      expect(api.putDocumentRoleGrant).toHaveBeenCalledWith(org, doc, 'design', level, '"v1"')
      expect(await screen.findByText('@design · Design')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Accorder l’accès' })).toBeNull()
    }
  )

  it('updates both levels and revokes with each returned ETag', async () => {
    const user = userEvent.setup()
    vi.mocked(api.putDocumentRoleGrant)
      .mockResolvedValueOnce(snapshot([{ ...grant, role: 'viewer' }], '"v2"'))
      .mockResolvedValueOnce(snapshot([grant], '"v3"'))
    render(<DocumentSubteamShare {...props} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    await screen.findByText('@engineering · Engineering')
    await waitFor(() => expect(status).toBeEmptyDOMElement())
    expect(status).toHaveClass('sr-only')
    await user.selectOptions(screen.getByLabelText('Accès de @engineering'), 'viewer')
    await waitFor(() =>
      expect(screen.getByLabelText('Accès de @engineering')).toHaveValue('viewer')
    )
    expect(screen.getByLabelText('Accès de @engineering')).toHaveFocus()
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Les accès des sous-équipes ont été mis à jour.')
    expect(status).not.toHaveClass('sr-only')
    await user.selectOptions(screen.getByLabelText('Accès de @engineering'), 'editor')
    await waitFor(() =>
      expect(api.putDocumentRoleGrant).toHaveBeenLastCalledWith(
        org,
        doc,
        'engineering',
        'editor',
        '"v2"'
      )
    )
    await user.click(screen.getByRole('button', { name: 'Révoquer @engineering' }))
    expect(api.revokeDocumentRoleGrant).toHaveBeenCalledWith(org, doc, 'engineering', '"v3"')
    expect(await screen.findByText('Aucun accès direct accordé à une sous-équipe.')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Accès des sous-équipes' })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Les accès des sous-équipes ont été mis à jour.'
    )
  })

  it.each([409, 412, 428])(
    'reloads on %s and announces the conflict without retrying the write',
    async (status) => {
      const user = userEvent.setup()
      vi.mocked(api.putDocumentRoleGrant).mockRejectedValue(problem(status))
      vi.mocked(api.listDocumentRoleGrants)
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValue(snapshot([{ ...grant, role: 'viewer' }], '"fresh"'))
      render(<DocumentSubteamShare {...props} />)
      await screen.findByText('@engineering · Engineering')
      await user.selectOptions(screen.getByLabelText('Accès de @engineering'), 'viewer')
      expect(await screen.findByRole('alert')).toHaveTextContent('Les accès ont changé')
      await waitFor(() => expect(api.listDocumentRoleGrants).toHaveBeenCalledTimes(2))
      expect(api.putDocumentRoleGrant).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('heading', { name: 'Accès des sous-équipes' })).toHaveFocus()
      vi.mocked(api.putDocumentRoleGrant).mockResolvedValue(snapshot())
      await waitFor(() => expect(screen.getByLabelText('Accès de @engineering')).toBeEnabled())
      await user.selectOptions(screen.getByLabelText('Accès de @engineering'), 'editor')
      expect(api.putDocumentRoleGrant).toHaveBeenLastCalledWith(
        org,
        doc,
        'engineering',
        'editor',
        '"fresh"'
      )
    }
  )

  it('shows a clean read-only message for viewers without calling editor endpoints', () => {
    render(<DocumentSubteamShare {...props} canManageSharing={false} />)
    expect(
      screen.getByText('Seuls les éditeurs peuvent gérer les accès des sous-équipes.')
    ).toBeVisible()
    expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
    expect(api.listDocumentSubteams).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([403, 404])('keeps grants readable when role listing returns %s', async (status) => {
    vi.mocked(api.listDocumentSubteams).mockRejectedValue(problem(status))
    render(<DocumentSubteamShare {...props} />)
    expect(await screen.findByText('@engineering · Engineering')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'La liste des sous-équipes est indisponible'
    )
    expect(screen.getByRole('button', { name: 'Révoquer @engineering' })).toBeEnabled()
    expect(screen.queryByLabelText('Sous-équipe')).toBeNull()
  })

  it.each([403, 404])(
    'refuses an unavailable grant list (%s) without exposing mutations',
    async (status) => {
      vi.mocked(api.listDocumentRoleGrants).mockRejectedValue(problem(status))
      render(<DocumentSubteamShare {...props} />)
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Les accès à ce document sont indisponibles'
      )
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByText('@engineering · Engineering')).toBeNull()
    }
  )

  it('clears grants if a mutation loses authority', async () => {
    const user = userEvent.setup()
    vi.mocked(api.revokeDocumentRoleGrant).mockRejectedValue(problem(403))
    render(<DocumentSubteamShare {...props} />)
    await user.click(await screen.findByRole('button', { name: 'Révoquer @engineering' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Les accès à ce document sont indisponibles'
    )
    expect(screen.queryByText('@engineering · Engineering')).toBeNull()
  })

  it.each([
    { plaintextBlocked: true },
    { remote: false },
    { documentId: 'channel:pad' },
    { documentId: 'local-mock' },
    { organisationId: undefined },
  ])('does not read or mutate outside remote plaintext documents: %j', (overrides) => {
    const { container } = render(<DocumentSubteamShare {...props} {...overrides} />)
    expect(container).toBeEmptyDOMElement()
    expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
    expect(api.listDocumentSubteams).not.toHaveBeenCalled()
  })

  it.each(['document', 'organisation', 'boundary', 'unmount'] as const)(
    'ignores a stale read after %s changes',
    async (change) => {
      const old = deferred<api.DocumentRoleGrantsState>()
      vi.mocked(api.listDocumentRoleGrants)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(snapshot([]))
      const view = render(<DocumentSubteamShare {...props} />)
      const signal = vi.mocked(api.listDocumentRoleGrants).mock.calls[0]![2]!
      if (change === 'unmount') view.unmount()
      else
        view.rerender(
          <DocumentSubteamShare
            {...props}
            {...(change === 'document'
              ? { documentId: otherDoc }
              : change === 'organisation'
                ? { organisationId: 'other-org' }
                : { plaintextBlocked: true })}
          />
        )
      expect(signal.aborted).toBe(true)
      await act(async () => old.resolve(snapshot()))
      expect(screen.queryByRole('list')).toBeNull()
    }
  )

  it('ignores a mutation result after document switch and prevents duplicate writes', async () => {
    const user = userEvent.setup()
    const old = deferred<api.DocumentRoleGrantsState>()
    vi.mocked(api.revokeDocumentRoleGrant).mockReturnValueOnce(old.promise)
    const view = render(<DocumentSubteamShare {...props} />)
    const revoke = await screen.findByRole('button', { name: 'Révoquer @engineering' })
    await user.dblClick(revoke)
    expect(api.revokeDocumentRoleGrant).toHaveBeenCalledTimes(1)
    vi.mocked(api.listDocumentRoleGrants).mockResolvedValue(snapshot([]))
    view.rerender(<DocumentSubteamShare {...props} documentId={otherDoc} />)
    await screen.findByText('Aucun accès direct accordé à une sous-équipe.')
    await act(async () => old.resolve(snapshot()))
    expect(screen.queryByRole('list')).toBeNull()
  })
})

it('loads subteams only when the unified remote Share dialog opens, and purges them at a confidential boundary', async () => {
  const user = userEvent.setup()
  const page = {
    id: doc,
    title: 'Project guide',
    parentId: null,
    markdown: '# Guide',
    role: 'editor' as const,
    updatedAt: '',
  }
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([page])
  vi.spyOn(docsApi, 'getWorkspaceDocument').mockResolvedValue({ document: page, etag: '"doc-v1"' })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockResolvedValue(ordinarySession)
  const view = render(<WorkspaceCollaborativeDocs organisationId={org} />)
  await screen.findByTestId(`drive-doc-card-${doc}`)
  expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Partager' }))
  const dialog = screen.getByRole('dialog', { name: 'Partager' })
  expect(await within(dialog).findByText('@engineering · Engineering')).toBeVisible()
  expect(dialog.querySelector('[style]')).toBeNull()
  expect((await axe.run(dialog)).violations).toEqual([])
  vi.mocked(api.putDocumentRoleGrant).mockResolvedValue(
    snapshot([{ ...grant, role: 'viewer' }], '"v2"')
  )
  const readsBeforeChange = vi.mocked(docsApi.getWorkspaceDocument).mock.calls.length
  await user.selectOptions(within(dialog).getByLabelText('Accès de @engineering'), 'viewer')
  await waitFor(() => expect(api.putDocumentRoleGrant).toHaveBeenCalledOnce())
  expect(docsApi.getWorkspaceDocument).toHaveBeenCalledTimes(readsBeforeChange)
  view.rerender(
    <WorkspaceCollaborativeDocs organisationId={org} roomBoundary="confidential-unavailable" />
  )
  expect(within(dialog).queryByText('@engineering · Engineering')).toBeNull()
  expect(within(dialog).queryByRole('combobox')).toBeNull()
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Partage externe refusé')
})

it.each([false, undefined])(
  'only enables Share after explicit ordinary classification (%s)',
  async (confidential) => {
    const user = userEvent.setup()
    const page = {
      id: doc,
      title: 'Project guide',
      parentId: null,
      markdown: '',
      role: 'editor' as const,
      updatedAt: '',
    }
    vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([page])
    vi.spyOn(docsApi, 'getWorkspaceDocument').mockResolvedValue({ document: page, etag: '"v1"' })
    vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
    const session =
      deferred<Awaited<ReturnType<typeof docsApi.createWorkspaceDocumentCollabSession>>>()
    vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockReturnValue(session.promise)
    render(<WorkspaceCollaborativeDocs organisationId={org} activeDocumentId={doc} />)
    await screen.findByTestId('docs-page-title-input')
    await user.click(screen.getByRole('button', { name: 'Partager' }))
    const dialog = screen.getByRole('dialog', { name: 'Partager' })
    const copy = within(dialog).getByRole('button', { name: 'Copier le lien interne' })
    expect(copy).toBeDisabled()
    expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
    const response: docsApi.CoreDocumentCollabSession = { ...ordinarySession }
    if (confidential === undefined) delete response.confidential
    await act(async () => session.resolve(response))
    if (confidential === false) {
      expect(await within(dialog).findByText('@engineering · Engineering')).toBeVisible()
      expect(copy).toBeEnabled()
    } else {
      expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
      expect(copy).toBeDisabled()
    }
  }
)

it('blocks Share while a standalone confidential session is pending and after quarantine', async () => {
  const user = userEvent.setup()
  const page = {
    id: doc,
    title: 'Protected',
    parentId: null,
    markdown: '',
    role: 'editor' as const,
    updatedAt: '',
  }
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([page])
  vi.spyOn(docsApi, 'getWorkspaceDocument').mockResolvedValue({ document: page, etag: '"doc-v1"' })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  const session =
    deferred<Awaited<ReturnType<typeof docsApi.createWorkspaceDocumentCollabSession>>>()
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockReturnValue(session.promise)
  render(<WorkspaceCollaborativeDocs organisationId={org} activeDocumentId={doc} />)
  await screen.findByTestId('docs-page-title-input')
  await waitFor(() => expect(docsApi.createWorkspaceDocumentCollabSession).toHaveBeenCalledOnce())
  await user.click(screen.getByRole('button', { name: 'Partager' }))
  const dialog = screen.getByRole('dialog', { name: 'Partager' })
  expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
  expect(api.listDocumentSubteams).not.toHaveBeenCalled()
  expect(within(dialog).getByRole('button', { name: 'Copier le lien interne' })).toBeDisabled()
  await act(async () =>
    session.resolve({
      token: 'opaque',
      wsUrl: 'wss://collab.kodera.test',
      expiresAt: '2099-01-01T00:00:00Z',
      role: 'editor',
      confidential: true,
      epoch: 3,
    } as Awaited<ReturnType<typeof docsApi.createWorkspaceDocumentCollabSession>>)
  )
  await waitFor(() =>
    expect(screen.getByTestId('docs-page-title-input')).toHaveAttribute('readonly')
  )
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Partage externe refusé')
  expect(api.listDocumentRoleGrants).not.toHaveBeenCalled()
  expect(within(dialog).queryByRole('combobox')).toBeNull()
})

it.each(['open', 'closed'] as const)(
  'preserves failed title and body drafts with Share %s during a grant mutation',
  async (dialogState) => {
    const user = userEvent.setup()
    const page = {
      id: doc,
      title: 'Project guide',
      parentId: null,
      markdown: '# Guide',
      role: 'editor' as const,
      updatedAt: '',
    }
    vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([page])
    const read = vi
      .spyOn(docsApi, 'getWorkspaceDocument')
      .mockResolvedValue({ document: page, etag: '"doc-v1"' })
    vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
    const webSocketFactory = ordinarySessionWithRestFallback()
    const save = vi
      .spyOn(docsApi, 'updateWorkspaceDocument')
      .mockRejectedValue(new TypeError('Network unavailable'))
    vi.spyOn(docsApi, 'updateWorkspaceDocumentMetadata').mockRejectedValue(
      new TypeError('Network unavailable')
    )
    render(
      <WorkspaceCollaborativeDocs
        organisationId={org}
        activeDocumentId={doc}
        initialSurface="markdown"
        webSocketFactory={webSocketFactory}
      />
    )
    const title = await screen.findByTestId('docs-page-title-input')
    const body = await screen.findByRole('textbox', { name: 'Source Markdown' })
    fireEvent.change(title, { target: { value: 'Unsaved title' } })
    fireEvent.change(body, { target: { value: '# Unsaved body' } })
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    const request = deferred<api.DocumentRoleGrantsState>()
    vi.mocked(api.revokeDocumentRoleGrant).mockReturnValueOnce(request.promise)
    await user.click(screen.getByRole('button', { name: 'Partager' }))
    await user.click(await screen.findByRole('button', { name: 'Révoquer @engineering' }))
    if (dialogState === 'closed') await user.keyboard('{Escape}')
    const reads = read.mock.calls.length
    await act(async () => request.resolve(snapshot([])))
    if (dialogState === 'open') await user.keyboard('{Escape}')
    expect(title).toHaveValue('Unsaved title')
    expect(body).toHaveValue('# Unsaved body')
    expect(read).toHaveBeenCalledTimes(reads)
    // Reopening the page also revalidates details without discarding the failed draft.
    read.mockResolvedValue({
      document: { ...page, markdown: '# A colleague edited this page' },
      etag: '"doc-v2"',
    })
    await user.click(screen.getByTestId(`docs-tree-item-${doc}`))
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads))
    expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Unsaved title')
    expect(screen.getByRole('textbox', { name: 'Source Markdown' })).toHaveValue('# Unsaved body')
    save.mockRejectedValue(problem(412))
    fireEvent.change(screen.getByRole('textbox', { name: 'Source Markdown' }), {
      target: { value: '# Unsaved body continued' },
    })
    await screen.findByTestId('page-conflict-banner')
    expect(save).toHaveBeenLastCalledWith(org, doc, '"doc-v1"', {
      markdown: '# Unsaved body continued',
    })
  }
)

it('saves the document body with its content ETag after Share closes mid-mutation', async () => {
  const user = userEvent.setup()
  const page = {
    id: doc,
    title: 'Project guide',
    parentId: null,
    markdown: '# Guide',
    role: 'editor' as const,
    updatedAt: '',
  }
  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue([page])
  const read = vi
    .spyOn(docsApi, 'getWorkspaceDocument')
    .mockResolvedValue({ document: page, etag: '"content-1"' })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  const webSocketFactory = ordinarySessionWithRestFallback()
  const save = vi
    .spyOn(docsApi, 'updateWorkspaceDocument')
    .mockImplementation(async (_org, _doc, etag, patch) => {
      if (etag !== '"content-1"') throw problem(412)
      return { document: { ...page, ...patch }, etag: '"content-2"' }
    })
  const request = deferred<api.DocumentRoleGrantsState>()
  vi.mocked(api.revokeDocumentRoleGrant).mockReturnValueOnce(request.promise)
  render(
    <WorkspaceCollaborativeDocs
      organisationId={org}
      activeDocumentId={doc}
      initialSurface="markdown"
      webSocketFactory={webSocketFactory}
    />
  )
  const body = await screen.findByRole('textbox', { name: 'Source Markdown' })
  await user.click(screen.getByRole('button', { name: 'Partager' }))
  await user.click(await screen.findByRole('button', { name: 'Révoquer @engineering' }))
  await user.keyboard('{Escape}')
  const reads = read.mock.calls.length
  fireEvent.change(body, { target: { value: '# Pending body' } })
  await act(async () => request.resolve(snapshot([], '"grants-2"')))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(org, doc, '"content-1"', { markdown: '# Pending body' })
  )
  await waitFor(() => expect(screen.queryByTestId('docs-saving-indicator')).toBeNull())
  expect(screen.queryByTestId('page-conflict-banner')).toBeNull()
  expect(body).toHaveValue('# Pending body')
  expect(read).toHaveBeenCalledTimes(reads)
})

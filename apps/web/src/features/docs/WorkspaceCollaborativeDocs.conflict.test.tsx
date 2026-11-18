// The two refused-write states of a workspace page, and the promise that makes them different
// from the structured collection's (`DocsCollectionView.conflict.test.tsx`): what was refused is
// a draft somebody is still typing.
//
// What is held here, and why each line of it:
//
// - **The draft survives.** Every case asserts the title and the Markdown in the editor after the
//   refusal, character for character. A rollback, a silent re-read or a blind retry would each
//   cost somebody their text, and none of them is allowed to creep back in.
// - `precondition-failed` (412) and `precondition-required` (428) are two different problems with
//   two different instructions, so each renders its own governed sentence in both languages and
//   neither renders the other's or the generic save error — whose "réessayez" would send the same
//   refused write again.
// - Both sentences are the catalogue's, read out of `src/i18n/{fr,en}.json` rather than repeated,
//   so a reworded key moves the assertion with it instead of breaking it. Neither may show an
//   HTTP status number.
// - The banner announces with `role="alert"` (implicitly `aria-live="assertive"`): a polite
//   announcement can be queued behind a presence update and arrive paragraphs too late.
// - Both recovery actions are asserted on their effect, not their presence: the re-read has to
//   bring a version the *next* save then carries, and the draft copy has to reach the server with
//   the draft's own title and body.
// - **A refusal is a state, and only those two actions end it.** Four cases hold the state machine
//   around it, each of which cost somebody their text or their recovery before it was written:
//   opening another page and coming back restores the draft and the banner rather than the
//   server's page; the re-read reaches the block editor's `Y.Doc`, so the next keystroke is not
//   the pre-reload body written back over a collaborator's commit with a version that is accepted
//   this time; typing on inside a refused draft neither downgrades the conflict to the missing
//   version its own refusal left behind nor keeps firing writes that cannot land; and a write that
//   left before a re-read and answers after it speaks for nothing.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiProblem } from '@/api/client'
import i18n from '@/i18n'
import en from '@/i18n/en.json'
import fr from '@/i18n/fr.json'
import { WorkspaceCollaborativeDocs } from './WorkspaceCollaborativeDocs'
import * as docsApi from './workspaceDocumentsApi'
import type { CoreWorkspaceDocument } from './workspaceDocumentsApi'

const CATALOGUE = { fr, en }

const PAGE: CoreWorkspaceDocument = {
  id: 'doc-arch',
  parentId: null,
  title: 'Architecture',
  markdown: '# Architecture\n',
  role: 'editor',
  updatedAt: '2026-01-01T00:00:00Z',
}

/** The other page in the tree, which the navigation case leaves the draft for and comes back from. */
const OTHER_PAGE: CoreWorkspaceDocument = {
  id: 'doc-runbook',
  parentId: null,
  title: 'Runbook',
  markdown: '# Runbook\n',
  role: 'editor',
  updatedAt: '2026-01-01T00:00:00Z',
}

/** What the person typed and has not saved, appended to the body the page opened with. */
const TYPED = 'Draft only this tab has.'

const DRAFT_MARKDOWN = `${PAGE.markdown}${TYPED}`

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

function problem(status: 412 | 428): ApiProblem {
  return new ApiProblem({
    type:
      status === 412
        ? 'https://kodera.io/problems/precondition-failed'
        : 'https://kodera.io/problems/precondition-required',
    status,
    title: status === 412 ? 'Precondition Failed' : 'Precondition Required',
    // The contract's own asymmetry: 412 says what the version is now, 428 has nothing to say.
    ...(status === 412 ? { currentEtag: '"v9"' } : {}),
  } as never)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('fr')
})

/**
 * The page open in the Markdown surface of a server-backed workspace, with no collaboration
 * session: the body is then the whole document rather than a fragment of it, which is the one
 * state where Markdown travels over `REST` (`maySeedFromMarkdown`) — so it is the state where a
 * refused body write is reachable at all. The server's pages are a mutable map so a case can let
 * a colleague write in between, which is exactly what the re-read has to pick up.
 */
async function openPage({
  language = 'fr',
  etag = '"v1"',
  pages = [PAGE],
  surface = 'markdown',
}: {
  language?: 'fr' | 'en'
  etag?: string | null
  pages?: readonly CoreWorkspaceDocument[]
  surface?: 'markdown' | 'blocks'
} = {}) {
  await i18n.changeLanguage(language)
  const user = userEvent.setup()
  const server = new Map<string, { document: CoreWorkspaceDocument; etag: string | null }>(
    pages.map((page) => [page.id, { document: page, etag }])
  )

  vi.spyOn(docsApi, 'listWorkspaceDocuments').mockResolvedValue(pages)
  const read = vi
    .spyOn(docsApi, 'getWorkspaceDocument')
    .mockImplementation(async (_organisationId, documentId) => {
      const found = server.get(documentId)
      if (!found) throw new ApiProblem({ type: null, status: 404, title: 'Not Found' })
      return found
    })
  vi.spyOn(docsApi, 'listWorkspaceDocumentBacklinks').mockResolvedValue([])
  vi.spyOn(docsApi, 'createWorkspaceDocumentCollabSession').mockRejectedValue(
    new ApiProblem({ type: null, status: 501, title: 'Not Implemented' })
  )

  const view = render(
    <WorkspaceCollaborativeDocs
      organisationId="org-1"
      currentUser={{ id: 'u-1', name: 'Alex' }}
      initialSurface={surface}
      webSocketFactory={neverOpens}
    />
  )

  await waitFor(() => expect(read).toHaveBeenCalled())
  await waitFor(() =>
    expect(screen.getByTestId('docs-collab-status-pill')).toHaveTextContent(
      CATALOGUE[language]['console.docs.collab.status-local']
    )
  )
  const body =
    surface === 'markdown'
      ? screen.getByLabelText(CATALOGUE[language]['console.docs.collab.mode-markdown'])
      : screen.getByTestId('docs-collab-prosemirror')
  return { user, view, server, read, body }
}

/**
 * An edit of the body in the block surface, made the way the editor itself makes one — through
 * the slash menu, which serializes the document it has and reports it. Typing into a
 * `contenteditable` is not what is under test here; what the editor is holding when it serializes
 * is.
 */
async function insertDividerBlock(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // The toolbar's own label, prefixed with the '/' the menu answers to.
  await user.click(
    screen.getByRole('button', {
      name: new RegExp(CATALOGUE.fr['console.docs.collab.slash-menu-label'], 'i'),
    })
  )
  await user.click(screen.getByTestId('docs-slash-item-divider'))
}

/** A write that has left the tab, whose answer this test delivers when it chooses to. */
function deferredWrite(): {
  readonly answer: Promise<docsApi.WorkspaceDocumentWithEtag>
  readonly settle: (value: docsApi.WorkspaceDocumentWithEtag) => void
  readonly refuse: (reason: unknown) => void
} {
  let settle!: (value: docsApi.WorkspaceDocumentWithEtag) => void
  let refuse!: (reason: unknown) => void
  const answer = new Promise<docsApi.WorkspaceDocumentWithEtag>((resolve, reject) => {
    settle = resolve
    refuse = reject
  })
  return { answer, settle, refuse }
}

/** What the colleague committed while this tab was holding a draft it could not write. */
function theirVersion(markdown: string): CoreWorkspaceDocument {
  return { ...PAGE, markdown, updatedAt: '2026-01-01T00:05:00Z' }
}

/** The body surface of the open page, as the editor currently holds it. */
function draftInEditor(language: 'fr' | 'en'): HTMLTextAreaElement {
  return screen.getByLabelText(
    CATALOGUE[language]['console.docs.collab.mode-markdown']
  ) as HTMLTextAreaElement
}

/** Everything that must hold of the banner whichever precondition was refused. */
function assertGovernedRefusal(banner: HTMLElement, language: 'fr' | 'en'): void {
  const catalogue = CATALOGUE[language]
  expect(banner).toHaveAttribute('role', 'alert')
  expect(banner).not.toHaveAttribute('aria-live', 'polite')
  // The generic save error, and the instruction that makes it wrong here: a retry of a write whose
  // version is stale or absent is refused again.
  expect(banner.textContent).not.toContain(catalogue['console.docs.collab.error-save'])
  expect(banner.textContent).not.toMatch(/réessayez|try again/i)
  // No bare status number, and no bare catalogue key either (a missing key renders as its name).
  expect(banner.textContent).not.toMatch(/\b4(12|28)\b/)
  expect(banner.textContent).not.toContain('console.docs.collab')
  expect(screen.queryByTestId('docs-tree-error')).toBeNull()
  expect(screen.getByTestId('page-conflict-reload')).toHaveTextContent(
    catalogue['console.docs.collab.action-reload-latest']
  )
  // The draft is still the draft: this is the whole point of the screen.
  expect(draftInEditor(language).value).toBe(DRAFT_MARKDOWN)
}

/**
 * Types into the body, waits out the debounce the save rides on, and returns the banner the
 * refusal raised.
 */
async function refuseTheBodyWriteWith(
  refusal: ApiProblem,
  language: 'fr' | 'en'
): Promise<HTMLElement> {
  const { user, body } = await openPage({ language })
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(refusal)
  await user.type(body, TYPED)
  return screen.findByTestId('page-conflict-banner')
}

it('announces the governed version-conflict copy in French, and keeps the draft, on a refused stale version', async () => {
  const banner = await refuseTheBodyWriteWith(problem(412), 'fr')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(banner).toHaveTextContent(fr['console.docs.collab.error-version-conflict'])
  expect(banner).not.toHaveTextContent(fr['console.docs.collab.error-version-required'])
  assertGovernedRefusal(banner, 'fr')
  expect(screen.getByTestId('page-conflict-save-draft')).toHaveTextContent(
    fr['console.docs.collab.action-save-draft-as-page']
  )
})

it('announces the governed version-conflict copy in English, and keeps the draft, on a refused stale version', async () => {
  const banner = await refuseTheBodyWriteWith(problem(412), 'en')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(banner).toHaveTextContent(en['console.docs.collab.error-version-conflict'])
  expect(banner).not.toHaveTextContent(en['console.docs.collab.error-version-required'])
  assertGovernedRefusal(banner, 'en')
  expect(screen.getByTestId('page-conflict-save-draft')).toHaveTextContent(
    en['console.docs.collab.action-save-draft-as-page']
  )
})

it('announces its own French copy, and offers no draft copy, when the write carried no version', async () => {
  const banner = await refuseTheBodyWriteWith(problem(428), 'fr')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-required')
  expect(banner).toHaveTextContent(fr['console.docs.collab.error-version-required'])
  expect(banner).not.toHaveTextContent(fr['console.docs.collab.error-version-conflict'])
  assertGovernedRefusal(banner, 'fr')
  // Nothing was compared, so there is no colleague's version to keep the draft away from: the
  // re-read is the whole fix, and a second page would be noise.
  expect(screen.queryByTestId('page-conflict-save-draft')).toBeNull()
})

it('announces its own English copy, and offers no draft copy, when the write carried no version', async () => {
  const banner = await refuseTheBodyWriteWith(problem(428), 'en')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-required')
  expect(banner).toHaveTextContent(en['console.docs.collab.error-version-required'])
  expect(banner).not.toHaveTextContent(en['console.docs.collab.error-version-conflict'])
  assertGovernedRefusal(banner, 'en')
  expect(screen.queryByTestId('page-conflict-save-draft')).toBeNull()
})

it('reports the same missing-version state without sending the write, when this tab holds no version', async () => {
  const { user, body } = await openPage({ etag: null })
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument')

  await user.type(body, TYPED)

  const banner = await screen.findByTestId('page-conflict-banner')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-required')
  expect(banner).toHaveTextContent(fr['console.docs.collab.error-version-required'])
  // An unconditional body write would replace whatever a collaborator wrote meanwhile.
  expect(write).not.toHaveBeenCalled()
  assertGovernedRefusal(banner, 'fr')
})

it('reports a refused title save as a version conflict, with the typed title left in the field', async () => {
  const { user } = await openPage()
  const metadata = vi
    .spyOn(docsApi, 'updateWorkspaceDocumentMetadata')
    .mockRejectedValue(problem(412))

  const title = screen.getByTestId('docs-page-title-input')
  await user.type(title, ' revisited')

  const banner = await screen.findByTestId('page-conflict-banner')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(metadata).toHaveBeenCalledWith('org-1', PAGE.id, '"v1"', {
    title: 'Architecture revisited',
  })
  expect(title).toHaveValue('Architecture revisited')
})

it('reloads the latest version with a fresh one the next save then carries', async () => {
  const { user, server, body, read } = await openPage()
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValueOnce(problem(412))

  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')
  expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN)

  // What the colleague wrote while this tab was typing, and the version it left behind.
  const theirs: CoreWorkspaceDocument = {
    ...PAGE,
    markdown: '# Architecture\nTheir paragraph.',
    updatedAt: '2026-01-01T00:05:00Z',
  }
  server.set(PAGE.id, { document: theirs, etag: '"v9"' })
  const readsBefore = read.mock.calls.length

  await user.click(screen.getByTestId('page-conflict-reload'))

  await waitFor(() => expect(screen.queryByTestId('page-conflict-banner')).toBeNull())
  expect(read.mock.calls.length).toBeGreaterThan(readsBefore)
  expect(draftInEditor('fr').value).toBe(theirs.markdown)

  // And the next save goes out with the version that re-read brought, not the refused one.
  write.mockResolvedValue({ document: theirs, etag: '"v10"' })
  await user.type(draftInEditor('fr'), ' mine again.')
  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith(
      'org-1',
      PAGE.id,
      '"v9"',
      expect.objectContaining({ markdown: `${theirs.markdown} mine again.` })
    )
  )
})

it('keeps the banner, and the draft, when a re-read brings the page back without a version', async () => {
  const { user, server, body } = await openPage()
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(problem(412))

  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')
  server.set(PAGE.id, { document: PAGE, etag: null })

  await user.click(screen.getByTestId('page-conflict-reload'))

  const banner = await screen.findByTestId('page-conflict-banner')
  await waitFor(() => expect(banner).toHaveAttribute('data-conflict-kind', 'version-required'))
  // A page that still cannot be saved must not cost the person their draft.
  expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN)
})

it('keeps the draft as a page of its own, with its title and its body, and clears the conflict', async () => {
  const { user, server, body } = await openPage()
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValueOnce(problem(412))

  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')

  const copy: CoreWorkspaceDocument = {
    id: 'doc-arch-copy',
    parentId: null,
    title: PAGE.title,
    markdown: '',
    role: 'editor',
    updatedAt: '2026-01-01T00:10:00Z',
  }
  const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockImplementation(async () => {
    server.set(copy.id, { document: copy, etag: '"copy-v1"' })
    return { document: copy, etag: '"copy-v1"' }
  })
  write.mockImplementation(async (_organisationId, documentId, _etag, patch) => {
    const saved = { ...copy, markdown: patch.markdown ?? '' }
    server.set(documentId, { document: saved, etag: '"copy-v2"' })
    return { document: saved, etag: '"copy-v2"' }
  })

  await user.click(screen.getByTestId('page-conflict-save-draft'))

  await waitFor(() =>
    expect(create).toHaveBeenCalledWith('org-1', { title: PAGE.title, parentId: null })
  )
  // The body is a second, conditional write: the create request carries no Markdown, and the
  // version it hands back is one nobody else can have moved yet.
  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith('org-1', copy.id, '"copy-v1"', {
      markdown: DRAFT_MARKDOWN,
    })
  )
  await waitFor(() => expect(screen.queryByTestId('page-conflict-banner')).toBeNull())
  expect(await screen.findByTestId('page-conflict-draft-saved')).toHaveTextContent(PAGE.title)
  expect(screen.getByTestId(`docs-tree-item-${copy.id}`)).toBeInTheDocument()
  // The copy is open, holding the draft that was refused everywhere else — read back from the
  // server, since selecting a page re-reads it.
  await waitFor(() => expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN))
})

it('leaves the banner up, and the draft where it is, when the draft copy cannot be written', async () => {
  const { user, body } = await openPage()
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(problem(412))

  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')
  vi.spyOn(docsApi, 'createWorkspaceDocument').mockRejectedValue(
    new ApiProblem({ type: null, status: 503, title: 'Service Unavailable' })
  )

  await user.click(screen.getByTestId('page-conflict-save-draft'))

  expect(await screen.findByTestId('docs-tree-error')).toHaveTextContent(
    fr['console.docs.collab.error-save']
  )
  expect(screen.getByTestId('page-conflict-banner')).toBeInTheDocument()
  expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN)
  expect(screen.queryByTestId('page-conflict-draft-saved')).toBeNull()
})

it('leaves a failure that is not about a version to the standard save error', async () => {
  const { user, body } = await openPage()
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(
    new ApiProblem({ type: null, status: 503, title: 'Service Unavailable' })
  )

  await user.type(body, TYPED)

  expect(await screen.findByTestId('docs-tree-error')).toHaveTextContent(
    fr['console.docs.collab.error-save']
  )
  // No version was refused, so no version state is claimed and no recovery action is offered.
  expect(screen.queryByTestId('page-conflict-banner')).toBeNull()
  expect(screen.queryByTestId('page-conflict-reload')).toBeNull()
  expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN)
})

it('restores the refused draft and its banner when the page is left and opened again', async () => {
  const { user, server, body, read } = await openPage({ pages: [PAGE, OTHER_PAGE] })
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(problem(412))

  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')

  // The colleague commits while this tab holds a draft no write of it will take.
  const theirs = theirVersion('# Architecture\nTheir paragraph.')
  server.set(PAGE.id, { document: theirs, etag: '"v9"' })

  await user.click(screen.getByTestId(`docs-tree-item-${OTHER_PAGE.id}`))
  await waitFor(() => expect(draftInEditor('fr').value).toBe(OTHER_PAGE.markdown))
  // The other page has no refused write of its own, so it carries no banner.
  expect(screen.queryByTestId('page-conflict-banner')).toBeNull()

  const readsBefore = read.mock.calls.length
  await user.click(screen.getByTestId(`docs-tree-item-${PAGE.id}`))
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(readsBefore))

  // Opening a page again is not the member asking for the server's version — the re-read is, and
  // they have not clicked it. So the draft comes back, and so does the state it is refused in,
  // with the action that can still save it.
  const banner = await screen.findByTestId('page-conflict-banner')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(banner).toHaveTextContent(fr['console.docs.collab.error-version-conflict'])
  expect(screen.getByTestId('page-conflict-save-draft')).toHaveTextContent(
    fr['console.docs.collab.action-save-draft-as-page']
  )
  await waitFor(() => expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN))
  expect(draftInEditor('fr').value).not.toContain('Their paragraph.')
  expect(screen.getByTestId('docs-page-title-input')).toHaveValue(PAGE.title)
})

it('re-reads into the block editor, so the next edit is a change to the version it brought', async () => {
  const { user, server, body } = await openPage({ surface: 'blocks' })
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(problem(412))
  await waitFor(() => expect(body).toHaveTextContent('Architecture'))

  await insertDividerBlock(user)
  await screen.findByTestId('page-conflict-banner')
  expect(body.querySelector('hr')).not.toBeNull()

  const theirs = theirVersion('# Architecture\n\nTheir paragraph.')
  server.set(PAGE.id, { document: theirs, etag: '"v9"' })

  await user.click(screen.getByTestId('page-conflict-reload'))
  await waitFor(() => expect(screen.queryByTestId('page-conflict-banner')).toBeNull())

  // The editor is showing the page that was re-read, not the `Y.Doc` it was seeded from before
  // it: a block editor left holding the pre-reload fragment renders a body the server no longer
  // has, under a banner that has just said the opposite.
  const reloaded = await screen.findByTestId('docs-collab-prosemirror')
  await waitFor(() => expect(reloaded).toHaveTextContent('Their paragraph.'))
  expect(reloaded).toHaveTextContent('Architecture')
  expect(reloaded.querySelector('hr')).toBeNull()

  // And the re-read writes nothing of its own. The rebuilt editor reports the empty document it
  // holds before its fragment is installed, and a write of *that*, carrying the version the
  // re-read just brought, is the page erased on the server — 350 ms after the member clicked
  // 'reload', with nothing else to blame. 600 ms is past the debounce the save rides on.
  const writesSoFar = write.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(write.mock.calls.length).toBe(writesSoFar)
  expect(screen.queryByTestId('page-conflict-banner')).toBeNull()

  // And the next edit is a change to their paragraph, carried by the version the re-read brought.
  // Serialized from a stale fragment it would be this tab's pre-reload body going back over their
  // commit — with a version the server accepts this time, which is the whole danger.
  write.mockResolvedValue({ document: theirs, etag: '"v10"' })
  await insertDividerBlock(user)
  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith('org-1', PAGE.id, '"v9"', {
      markdown: expect.stringContaining('Their paragraph.'),
    })
  )

  // And no write of an empty page went out along the way. A rebuilt editor holds an empty
  // document for an instant, before the effect that installs its fragment has run; reported as
  // the body, with the version the re-read brought, it is the page erased on the server.
  for (const call of write.mock.calls) {
    expect(call[3]).not.toEqual({ markdown: '' })
  }
})

it('holds the stale-version state, and sends nothing more, while the member goes on typing', async () => {
  const { user, body } = await openPage()
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(problem(412))

  await user.type(body, TYPED)
  expect(await screen.findByTestId('page-conflict-banner')).toHaveAttribute(
    'data-conflict-kind',
    'version-conflict'
  )
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))

  await user.type(draftInEditor('fr'), ' And more.')
  // Longer than the 350 ms the save rides on: a second write would have gone out by now.
  await new Promise((resolve) => setTimeout(resolve, 600))

  // Still the conflict with a collaborator, not the missing version that conflict's own refusal
  // left behind — which is the state with no 'keep my draft as a new page' on it, so flipping to
  // it takes the member's one way out of the screen while they are typing into it.
  const banner = screen.getByTestId('page-conflict-banner')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(banner).toHaveTextContent(fr['console.docs.collab.error-version-conflict'])
  expect(banner).not.toHaveTextContent(fr['console.docs.collab.error-version-required'])
  expect(screen.getByTestId('page-conflict-save-draft')).toBeInTheDocument()
  // No write has been attempted since the refused one: the version it was refused on is still
  // the only one this tab has, so every one of them would be refused in turn.
  expect(write).toHaveBeenCalledTimes(1)
  expect(draftInEditor('fr').value).toBe(`${DRAFT_MARKDOWN} And more.`)

  // And what is kept as a page of its own is the draft as it is typed now, not as the refused
  // write left it: not sending the keystrokes is not the same as forgetting them.
  const copy: CoreWorkspaceDocument = {
    id: 'doc-arch-copy',
    parentId: null,
    title: PAGE.title,
    markdown: '',
    role: 'editor',
    updatedAt: '2026-01-01T00:10:00Z',
  }
  vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
    document: copy,
    etag: '"copy-v1"',
  })
  write.mockResolvedValue({ document: copy, etag: '"copy-v2"' })

  await user.click(screen.getByTestId('page-conflict-save-draft'))

  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith('org-1', copy.id, '"copy-v1"', {
      markdown: `${DRAFT_MARKDOWN} And more.`,
    })
  )
})

/**
 * The write that is already on the wire when the member asks for the server's version. Cancelling
 * the debounce timer cannot recall it, and the answer it gets back speaks for the version it was
 * sent with — two behind by the time it arrives.
 */
async function reloadWithAWriteStillInFlight() {
  const { user, server, body } = await openPage()
  const inFlight = deferredWrite()
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockReturnValueOnce(inFlight.answer)
  const metadata = vi
    .spyOn(docsApi, 'updateWorkspaceDocumentMetadata')
    .mockRejectedValue(problem(412))

  // The body write leaves with the version this tab holds, and does not answer.
  await user.type(body, TYPED)
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith(
      'org-1',
      PAGE.id,
      '"v1"',
      expect.objectContaining({ markdown: DRAFT_MARKDOWN })
    )
  )

  // The title write behind it is refused, which is what opens the banner.
  await user.type(screen.getByTestId('docs-page-title-input'), ' revisited')
  await screen.findByTestId('page-conflict-banner')
  expect(metadata).toHaveBeenCalled()

  server.set(PAGE.id, { document: theirVersion('# Architecture\nTheirs.'), etag: '"v9"' })
  await user.click(screen.getByTestId('page-conflict-reload'))
  await waitFor(() => expect(screen.queryByTestId('page-conflict-banner')).toBeNull())

  return { user, write, inFlight }
}

it('keeps the version a re-read brought when a write that left before it answers after it', async () => {
  const { user, write, inFlight } = await reloadWithAWriteStillInFlight()

  // The pre-reload write answers, with the version its own `PATCH` produced.
  inFlight.settle({ document: PAGE, etag: '"v2"' })
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(screen.queryByTestId('page-conflict-banner')).toBeNull()
  // The next save carries what the re-read brought. Carrying `"v2"` would be refused on a page
  // the member has already re-read — a conflict banner for a conflict that no longer exists.
  write.mockResolvedValue({ document: PAGE, etag: '"v10"' })
  await user.type(draftInEditor('fr'), ' mine again.')
  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith(
      'org-1',
      PAGE.id,
      '"v9"',
      expect.objectContaining({ markdown: expect.stringContaining('mine again.') })
    )
  )
})

it('leaves the banner closed when a write that left before a re-read is refused after it', async () => {
  const { user, write, inFlight } = await reloadWithAWriteStillInFlight()

  inFlight.refuse(problem(412))
  await new Promise((resolve) => setTimeout(resolve, 50))

  // The refusal is of a version the member has already replaced: re-opening the banner on it
  // would report a conflict they have just resolved, over the page they asked to see.
  expect(screen.queryByTestId('page-conflict-banner')).toBeNull()
  expect(screen.queryByTestId('docs-tree-error')).toBeNull()

  // And the version the re-read brought is still the one a save carries.
  write.mockResolvedValue({ document: PAGE, etag: '"v10"' })
  await user.type(draftInEditor('fr'), ' mine again.')
  await waitFor(() =>
    expect(write).toHaveBeenLastCalledWith(
      'org-1',
      PAGE.id,
      '"v9"',
      expect.objectContaining({ markdown: expect.stringContaining('mine again.') })
    )
  )
})

it('renders the refusal and its actions with zero inline styles', async () => {
  const { user, body, view } = await openPage()
  vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValue(problem(412))

  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')

  expect(view.container.querySelectorAll('[style]')).toHaveLength(0)
  expect(view.container.querySelectorAll('style')).toHaveLength(0)
})

it.each(['', '   \n'])('replaces stale blocks when the re-read body is %j', async (markdown) => {
  const { user, server } = await openPage({ surface: 'blocks' })
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValueOnce(problem(412))
  await insertDividerBlock(user)
  await screen.findByTestId('page-conflict-banner')
  server.set(PAGE.id, { document: theirVersion(markdown), etag: '"v9"' })

  await user.click(screen.getByTestId('page-conflict-reload'))
  await waitFor(() => expect(screen.queryByTestId('page-conflict-banner')).toBeNull())
  const editor = screen.getByTestId('docs-collab-prosemirror')
  expect(editor).not.toHaveTextContent('Architecture')
  expect(editor.querySelector('hr')).toBeNull()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
  expect(write).toHaveBeenCalledTimes(1)

  write.mockResolvedValue({ document: theirVersion('---'), etag: '"v10"' })
  await insertDividerBlock(user)
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  expect(write).toHaveBeenLastCalledWith('org-1', PAGE.id, '"v9"', {
    markdown: expect.stringMatching(/^---\s*$/),
  })
})

it('drops a queued title patch if a conflict opens before its timer fires, even after navigation reads a fresh version', async () => {
  const { user, body, server } = await openPage({ pages: [PAGE, OTHER_PAGE] })
  const inFlight = deferredWrite()
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockReturnValueOnce(inFlight.answer)
  const metadata = vi
    .spyOn(docsApi, 'updateWorkspaceDocumentMetadata')
    .mockResolvedValue({ document: PAGE, etag: '"v10"' })
  await user.type(body, TYPED)
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByTestId('docs-page-title-input'), {
    target: { value: 'Queued title' },
  })
  await act(async () => {
    inFlight.refuse(problem(412))
  })
  await screen.findByTestId('page-conflict-banner')
  server.set(PAGE.id, { document: theirVersion('Theirs.'), etag: '"v9"' })
  await user.click(screen.getByTestId(`docs-tree-item-${OTHER_PAGE.id}`))
  await user.click(screen.getByTestId(`docs-tree-item-${PAGE.id}`))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })

  expect(metadata).not.toHaveBeenCalled()
  expect(screen.getByTestId('page-conflict-banner')).toHaveAttribute(
    'data-conflict-kind',
    'version-conflict'
  )
  expect(screen.getByTestId('docs-page-title-input')).toHaveValue('Queued title')
  expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN)
})

it('does not retain a navigation ETag read while the original page has an open conflict', async () => {
  const { user, body, server } = await openPage({ pages: [PAGE, OTHER_PAGE] })
  const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValueOnce(problem(412))
  await user.type(body, TYPED)
  await screen.findByTestId('page-conflict-banner')
  server.set(PAGE.id, { document: theirVersion('Theirs.'), etag: '"v9"' })
  await user.click(screen.getByTestId(`docs-tree-item-${OTHER_PAGE.id}`))
  await user.click(screen.getByTestId(`docs-tree-item-${PAGE.id}`))
  await waitFor(() => expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN))

  const copy = { ...PAGE, id: 'doc-copy', markdown: DRAFT_MARKDOWN }
  vi.spyOn(docsApi, 'createWorkspaceDocument').mockResolvedValue({
    document: copy,
    etag: '"copy-v1"',
  })
  server.set(copy.id, { document: copy, etag: '"copy-v2"' })
  write.mockResolvedValue({ document: copy, etag: '"copy-v2"' })
  await user.click(screen.getByTestId('page-conflict-save-draft'))
  await screen.findByTestId('page-conflict-draft-saved')
  server.set(PAGE.id, { document: PAGE, etag: null })
  await user.click(screen.getByTestId(`docs-tree-item-${PAGE.id}`))
  await waitFor(() => expect(draftInEditor('fr').value).toBe(PAGE.markdown))
  await user.type(draftInEditor('fr'), 'New draft.')

  expect(await screen.findByTestId('page-conflict-banner')).toHaveAttribute(
    'data-conflict-kind',
    'version-required'
  )
  expect(write).toHaveBeenCalledTimes(2)
})

it.each([
  { outcome: 'success', field: 'title' },
  { outcome: 'failure', field: 'title' },
  { outcome: 'success', field: 'parent' },
  { outcome: 'failure', field: 'parent' },
])(
  'ignores an older PATCH $outcome while a newer $field PATCH is still in flight',
  async ({ outcome, field }) => {
    const { user, body } = await openPage({ pages: [PAGE, OTHER_PAGE] })
    const older = deferredWrite()
    const newer = deferredWrite()
    const write = vi
      .spyOn(docsApi, 'updateWorkspaceDocument')
      .mockReturnValueOnce(older.answer)
      .mockResolvedValue({ document: PAGE, etag: '"v4"' })
    const metadata = vi
      .spyOn(docsApi, 'updateWorkspaceDocumentMetadata')
      .mockReturnValueOnce(newer.answer)
    await user.type(body, TYPED)
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    fireEvent.change(
      screen.getByTestId(field === 'title' ? 'docs-page-title-input' : 'docs-parent-select'),
      {
        target: { value: field === 'title' ? 'Newer title' : OTHER_PAGE.id },
      }
    )
    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(1))

    await act(async () => {
      if (outcome === 'success') older.settle({ document: PAGE, etag: '"v2"' })
      else older.refuse(problem(412))
    })
    expect(screen.queryByTestId('page-conflict-banner')).toBeNull()
    await user.type(draftInEditor('fr'), ' Next.')
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write).toHaveBeenLastCalledWith('org-1', PAGE.id, '"v1"', {
      markdown: `${DRAFT_MARKDOWN} Next.`,
    })
    await act(async () => {
      newer.settle({ document: PAGE, etag: '"v3"' })
    })
    await user.type(draftInEditor('fr'), ' Again.')
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3))
    expect(write.mock.calls[2]?.[2]).toBe('"v4"')
  }
)

it.each(['success', 'failure'] as const)(
  'keeps the newer PATCH conflict when an older PATCH answers with %s',
  async (outcome) => {
    const { user, body } = await openPage()
    const older = deferredWrite()
    const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockReturnValueOnce(older.answer)
    vi.spyOn(docsApi, 'updateWorkspaceDocumentMetadata').mockRejectedValue(problem(412))
    await user.type(body, TYPED)
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId('docs-page-title-input'), {
      target: { value: 'Refused title' },
    })
    await screen.findByTestId('page-conflict-banner')
    await act(async () => {
      if (outcome === 'success') older.settle({ document: PAGE, etag: '"v2"' })
      else older.refuse(new ApiProblem({ type: null, status: 503, title: 'Service Unavailable' }))
    })

    expect(screen.getByTestId('page-conflict-banner')).toHaveAttribute(
      'data-conflict-kind',
      'version-conflict'
    )
    expect(screen.queryByTestId('docs-tree-error')).toBeNull()
    await user.type(draftInEditor('fr'), ' Still unsaved.')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(write).toHaveBeenCalledTimes(1)
  }
)

it.each([
  { stage: 'creation', field: 'title' },
  { stage: 'creation', field: 'markdown' },
  { stage: 'body write', field: 'title' },
  { stage: 'body write', field: 'markdown' },
])(
  'preserves $field edits made to the original draft during fork $stage when it is reopened',
  async ({ stage, field }) => {
    const { user, body, server } = await openPage()
    const write = vi.spyOn(docsApi, 'updateWorkspaceDocument').mockRejectedValueOnce(problem(412))
    await user.type(body, TYPED)
    await screen.findByTestId('page-conflict-banner')
    const creation = deferredWrite()
    const copyWrite = deferredWrite()
    const copy = { ...PAGE, id: 'doc-copy', markdown: DRAFT_MARKDOWN }
    const create = vi.spyOn(docsApi, 'createWorkspaceDocument').mockReturnValueOnce(creation.answer)
    write.mockReturnValueOnce(copyWrite.answer)
    await user.click(screen.getByTestId('page-conflict-save-draft'))
    expect(create).toHaveBeenCalledWith('org-1', { title: PAGE.title, parentId: null })
    if (stage === 'body write') {
      await act(async () => {
        creation.settle({ document: { ...copy, markdown: '' }, etag: '"copy-v1"' })
      })
      await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    }
    if (field === 'markdown') await user.type(draftInEditor('fr'), ' Typed during fork.')
    else await user.type(screen.getByTestId('docs-page-title-input'), ' revised during fork')
    if (stage === 'creation') {
      await act(async () => {
        creation.settle({ document: { ...copy, markdown: '' }, etag: '"copy-v1"' })
      })
      await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    }
    expect(write).toHaveBeenLastCalledWith('org-1', copy.id, '"copy-v1"', {
      markdown: DRAFT_MARKDOWN,
    })
    server.set(copy.id, { document: copy, etag: '"copy-v2"' })
    server.set(PAGE.id, { document: theirVersion('Theirs.'), etag: '"v9"' })
    await act(async () => {
      copyWrite.settle({ document: copy, etag: '"copy-v2"' })
    })
    await screen.findByTestId('page-conflict-draft-saved')
    await waitFor(() => expect(draftInEditor('fr').value).toBe(DRAFT_MARKDOWN))
    await user.click(screen.getByTestId(`docs-tree-item-${PAGE.id}`))

    expect(await screen.findByTestId('page-conflict-banner')).toHaveAttribute(
      'data-conflict-kind',
      'version-conflict'
    )
    expect(draftInEditor('fr').value).toBe(
      field === 'markdown' ? `${DRAFT_MARKDOWN} Typed during fork.` : DRAFT_MARKDOWN
    )
    expect(screen.getByTestId('docs-page-title-input')).toHaveValue(
      field === 'title' ? `${PAGE.title} revised during fork` : PAGE.title
    )
    expect(screen.getByTestId('page-conflict-save-draft')).toBeInTheDocument()
  }
)

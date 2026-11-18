// The two refused-write states of the structured collection, and the copy they render.
//
// What is held here, and why each line of it:
//
// - `precondition-failed` (412) and `precondition-required` (428) are two different problems with
//   two different instructions, and 428 used to have no copy anywhere in the product: it fell
//   through to `console.common.error-unexpected`, whose sentence is « Une opération n'a pas abouti.
//   Réessayez… » — and a retry of a version-less write is refused again. So each state is asserted
//   to render its own governed sentence, and neither to render the generic one.
// - Both sentences are the catalogue's, read here out of `src/i18n/{fr,en}.json` rather than
//   repeated, so a reworded key moves the assertion with it instead of breaking it.
// - Neither may show the person an HTTP status number; that was the only place in the product
//   that did.
// - The banner announces with `role="alert"` (implicitly `aria-live="assertive"`): a refused write
//   is something the person must act on before doing anything else.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiProblem } from '@/api/client'
import i18n from '@/i18n'
import en from '@/i18n/en.json'
import fr from '@/i18n/fr.json'
import { createDefaultCollectionSchema, type WorkspaceCollectionRowModel } from './collectionSchema'
import { DocsCollectionView, type CollectionDocumentDescriptor } from './DocsCollectionView'
import * as docsApi from './workspaceDocumentsApi'

const CATALOGUE = { fr, en }

const DOCS: readonly CollectionDocumentDescriptor[] = [
  { id: 'doc-1', title: 'Architecture Réseau', updatedAt: '2026-11-10T10:00:00Z', role: 'editor' },
]

const ROWS: readonly WorkspaceCollectionRowModel[] = [
  {
    documentId: 'doc-1',
    updatedAt: '2026-11-10T10:00:00Z',
    values: { status: { kind: 'status', value: 'todo' } },
  },
]

beforeEach(() => {
  // The collection view is not a route: nothing here fetches the collection or its rows, so an
  // unmocked read would reach MSW. Only the write under test is left to the spies in each case.
  vi.spyOn(docsApi, 'getWorkspaceCollection').mockRejectedValue(new Error('not called'))
  vi.spyOn(docsApi, 'queryWorkspaceCollection').mockRejectedValue(new Error('not called'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('fr')
})

async function refuseTheWriteWith(
  refusal: ApiProblem,
  language: 'fr' | 'en'
): Promise<HTMLElement> {
  await i18n.changeLanguage(language)
  const user = userEvent.setup()
  const schema = createDefaultCollectionSchema(language)
  vi.spyOn(docsApi, 'putWorkspaceCollectionRow').mockRejectedValue(refusal)

  render(
    <DocsCollectionView
      organisationId="org-vercelli"
      documents={DOCS}
      initialCollection={schema}
      initialRows={ROWS}
      initialRowEtags={{ 'doc-1': '"row-v1"' }}
    />
  )

  await user.selectOptions(screen.getByTestId('collection-cell-doc-1-status'), 'review')
  return screen.findByTestId('collection-conflict-banner')
}

function problem(status: 412 | 428): ApiProblem {
  return new ApiProblem({
    type:
      status === 412
        ? 'https://kodera.io/problems/precondition-failed'
        : 'https://kodera.io/problems/precondition-required',
    status,
    title: status === 412 ? 'Precondition Failed' : 'Precondition Required',
    // The contract's own asymmetry: 412 says what the tag is now, 428 has nothing to say.
    ...(status === 412 ? { currentEtag: '"row-v3"' } : {}),
  } as never)
}

/** Everything that must hold of the banner whichever precondition was refused. */
function assertGovernedRefusal(banner: HTMLElement, language: 'fr' | 'en'): void {
  const catalogue = CATALOGUE[language]
  expect(banner).toHaveAttribute('role', 'alert')
  expect(banner).not.toHaveAttribute('aria-live', 'polite')
  // The generic fallback, and the instruction that makes it wrong here: a retry of a write whose
  // version is stale or absent is refused again, so neither the sentence nor "retry" may appear.
  // Matched on its first clause, before its `{{email}}` placeholder, which is what renders.
  const generic = catalogue['console.common.error-unexpected'].split('{{')[0]!.trim()
  expect(banner.textContent).not.toContain(generic)
  expect(banner.textContent).not.toMatch(/réessayez|try again/i)
  // No bare status number, and no bare catalogue key either (a missing key renders as its name).
  expect(banner.textContent).not.toMatch(/\b4(12|28)\b/)
  expect(banner.textContent).not.toContain('console.docs.collection')
  expect(screen.getByTestId('collection-conflict-reload')).toHaveTextContent(
    catalogue['console.docs.collection.action-reload']
  )
  expect(screen.getByTestId('collection-cell-doc-1-status')).toHaveValue('todo')
}

async function conflictBannerFor(status: 412 | 428, language: 'fr' | 'en'): Promise<HTMLElement> {
  const banner = await refuseTheWriteWith(problem(status), language)
  assertGovernedRefusal(banner, language)
  return banner
}

/** The sentence for the other precondition, which this one must not borrow. */
function theOtherSentence(status: 412 | 428, language: 'fr' | 'en'): string {
  return status === 412
    ? CATALOGUE[language]['console.docs.collection.error-version-required']
    : CATALOGUE[language]['console.docs.collection.error-version-conflict']
}

it('announces the governed version-conflict copy in French on a refused stale tag', async () => {
  const banner = await conflictBannerFor(412, 'fr')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(banner).toHaveTextContent(fr['console.docs.collection.error-version-conflict'])
  expect(banner).not.toHaveTextContent(theOtherSentence(412, 'fr'))
})

it('announces the governed version-conflict copy in English on a refused stale tag', async () => {
  const banner = await conflictBannerFor(412, 'en')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-conflict')
  expect(banner).toHaveTextContent(en['console.docs.collection.error-version-conflict'])
  expect(banner).not.toHaveTextContent(theOtherSentence(412, 'en'))
})

it('announces its own French copy when the write carried no version at all', async () => {
  const banner = await conflictBannerFor(428, 'fr')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-required')
  expect(banner).toHaveTextContent(fr['console.docs.collection.error-version-required'])
  expect(banner).not.toHaveTextContent(theOtherSentence(428, 'fr'))
})

it('announces its own English copy when the write carried no version at all', async () => {
  const banner = await conflictBannerFor(428, 'en')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-required')
  expect(banner).toHaveTextContent(en['console.docs.collection.error-version-required'])
  expect(banner).not.toHaveTextContent(theOtherSentence(428, 'en'))
})

it('reports the same missing-version state when no tag can be read, without sending the write', async () => {
  const user = userEvent.setup()
  const schema = createDefaultCollectionSchema('fr')
  // The row is known to be on the server and its version is not known here: the write would have
  // to go out without `If-Match`, which is what 428 answers. Refused before it is sent.
  vi.spyOn(docsApi, 'getWorkspaceCollectionRow').mockResolvedValue({
    row: ROWS[0]!,
    etag: null,
    created: false,
  })
  const putSpy = vi.spyOn(docsApi, 'putWorkspaceCollectionRow')

  render(
    <DocsCollectionView
      organisationId="org-vercelli"
      documents={DOCS}
      initialCollection={schema}
      initialRows={ROWS}
      initialRowEtags={{}}
    />
  )

  await user.selectOptions(screen.getByTestId('collection-cell-doc-1-status'), 'review')
  const banner = await screen.findByTestId('collection-conflict-banner')
  expect(banner).toHaveAttribute('data-conflict-kind', 'version-required')
  expect(banner).toHaveTextContent(fr['console.docs.collection.error-version-required'])
  expect(putSpy).not.toHaveBeenCalled()
  assertGovernedRefusal(banner, 'fr')
})

it('forgets a 412-refused tag and refreshes remote sibling values before any subsequent write', async () => {
  const user = userEvent.setup()
  const schema = createDefaultCollectionSchema('fr')
  const initialRowsWithPriority: readonly WorkspaceCollectionRowModel[] = [
    {
      documentId: 'doc-1',
      updatedAt: '2026-11-10T10:00:00Z',
      values: {
        status: { kind: 'status', value: 'todo' },
        priority: { kind: 'priority', value: 'low' },
      },
    },
  ]

  const putSpy = vi
    .spyOn(docsApi, 'putWorkspaceCollectionRow')
    .mockRejectedValueOnce(problem(412))
    .mockImplementationOnce(async (_orgId, _colId, documentId, values) => ({
      etag: '"row-v4"',
      created: false,
      row: {
        documentId,
        updatedAt: '2026-11-10T10:05:00Z',
        values,
      },
    }))

  const getRowSpy = vi.spyOn(docsApi, 'getWorkspaceCollectionRow').mockResolvedValue({
    etag: '"row-v3"',
    created: false,
    row: {
      documentId: 'doc-1',
      updatedAt: '2026-11-10T10:02:00Z',
      values: {
        status: { kind: 'status', value: 'todo' },
        priority: { kind: 'priority', value: 'high' },
      },
    },
  })

  render(
    <DocsCollectionView
      organisationId="org-vercelli"
      documents={DOCS}
      initialCollection={schema}
      initialRows={initialRowsWithPriority}
      initialRowEtags={{ 'doc-1': '"row-v1"' }}
    />
  )

  await user.selectOptions(screen.getByTestId('collection-cell-doc-1-status'), 'review')
  await screen.findByTestId('collection-conflict-banner')
  expect(screen.getByTestId('collection-cell-doc-1-status')).toHaveValue('todo')

  // Editing again without clicking Reload must NOT pair stale local `priority: low` with `"row-v3"`.
  await user.selectOptions(screen.getByTestId('collection-cell-doc-1-status'), 'done')
  await waitFor(() => {
    expect(getRowSpy).toHaveBeenCalledTimes(1)
    expect(putSpy).toHaveBeenCalledTimes(2)
    expect(putSpy.mock.calls[1]?.[3]).toMatchObject({
      status: { kind: 'status', value: 'done' },
      priority: { kind: 'priority', value: 'high' },
    })
    expect(putSpy.mock.calls[1]?.[4]).toEqual({ mode: 'update', ifMatch: '"row-v3"' })
    expect(screen.queryByTestId('collection-conflict-banner')).toBeNull()
  })
})

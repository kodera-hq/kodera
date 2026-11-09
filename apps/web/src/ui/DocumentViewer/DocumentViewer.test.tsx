import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentViewer } from './DocumentViewer'
import type { DocumentViewerSection } from './DocumentViewer'

const sections: DocumentViewerSection[] = [
  {
    id: 'roles',
    heading: '1. Rôles des parties',
    paragraphs: ['Le sous-traitant agit sur instruction du responsable de traitement.'],
  },
  {
    id: 'security',
    heading: '2. Sécurité',
    paragraphs: ['Les données sont chiffrées au repos et en transit.', 'Accès restreint.'],
  },
]

/**
 * jsdom lays nothing out: `scrollHeight` and `clientHeight` are always 0, and
 * `scrollTop` is a plain stored number with no clamping of its own. Patched
 * on `HTMLElement.prototype` — not on the instance, and BEFORE `render` — so
 * that `DocumentViewer`'s own mount-time measurement (which runs the instant
 * React attaches the scroll region's ref, before a test can reach the
 * element to patch it directly) sees a real, tall document from the start
 * rather than jsdom's honest-but-fake "0 px, already at the end".
 */
function stubScrollMetrics(scrollHeight: number, clientHeight: number) {
  let scrollTop = 0
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight))
    },
  })
}

afterEach(() => {
  // Un-shadow `Element.prototype`'s own accessors — safe to call even when a
  // test never patched anything, since deleting an absent own property is a
  // no-op.
  delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight
  delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight
  delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop
})

const baseProps = {
  label: 'Contrat de sous-traitance — ACME Construction',
  tocLabel: 'Sommaire du document',
  progressLabel: 'Progression de lecture',
}

describe('DocumentViewer', () => {
  it('shows a loading skeleton, not the reading region, while loading', () => {
    render(<DocumentViewer {...baseProps} status="loading" />)

    expect(screen.queryByRole('region')).toBeNull()
  })

  it('shows the failure message, not the reading region, when failed', () => {
    render(
      <DocumentViewer
        {...baseProps}
        status="failed"
        failureMessage="Le document est indisponible."
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Le document est indisponible.')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('renders every section as a heading and its paragraphs, not raw HTML', () => {
    render(<DocumentViewer {...baseProps} status="ready" sections={sections} />)

    expect(
      screen.getByRole('heading', { level: 3, name: '1. Rôles des parties' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('Le sous-traitant agit sur instruction du responsable de traitement.')
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '2. Sécurité' })).toBeInTheDocument()
    expect(screen.getByText('Accès restreint.')).toBeInTheDocument()
  })

  it('exposes the reading region as a focusable, labelled region', () => {
    render(<DocumentViewer {...baseProps} status="ready" sections={sections} />)

    const region = screen.getByRole('region', {
      name: 'Contrat de sous-traitance — ACME Construction',
    })
    expect(region).toHaveAttribute('tabindex', '0')
  })

  it('renders a table of contents with one entry per section heading', () => {
    render(<DocumentViewer {...baseProps} status="ready" sections={sections} />)

    const toc = screen.getByRole('navigation', { name: 'Sommaire du document' })
    expect(within(toc).getByRole('button', { name: '1. Rôles des parties' })).toBeInTheDocument()
    expect(within(toc).getByRole('button', { name: '2. Sécurité' })).toBeInTheDocument()
  })

  it('moves focus to the section heading when its table-of-contents entry is activated', async () => {
    const user = userEvent.setup()
    render(<DocumentViewer {...baseProps} status="ready" sections={sections} />)

    await user.click(screen.getByRole('button', { name: '2. Sécurité' }))

    expect(screen.getByRole('heading', { level: 3, name: '2. Sécurité' })).toHaveFocus()
  })

  it('renders the print and download action slots when given', () => {
    render(
      <DocumentViewer
        {...baseProps}
        status="ready"
        sections={sections}
        printAction={<button type="button">Imprimer</button>}
        downloadAction={<button type="button">PDF</button>}
      />
    )

    expect(screen.getByRole('button', { name: 'Imprimer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PDF' })).toBeInTheDocument()
  })

  it('reports full read progress immediately for a document short enough to need no scrolling', () => {
    const onReadToEnd = vi.fn()
    render(
      <DocumentViewer {...baseProps} status="ready" sections={sections} onReadToEnd={onReadToEnd} />
    )

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(onReadToEnd).toHaveBeenCalledOnce()
  })

  it('reports partial progress for a document taller than its viewport, and does not fire onReadToEnd yet', () => {
    stubScrollMetrics(1000, 200)
    const onReadToEnd = vi.fn()
    render(
      <DocumentViewer {...baseProps} status="ready" sections={sections} onReadToEnd={onReadToEnd} />
    )

    // scrollTop 0, clientHeight 200, scrollHeight 1000 → (0 + 200) / 1000.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
    expect(onReadToEnd).not.toHaveBeenCalled()
  })

  it('reaches 100% and fires onReadToEnd exactly once when scrolled to the end, even after further scroll events at the end', () => {
    stubScrollMetrics(1000, 200)
    const onReadToEnd = vi.fn()
    render(
      <DocumentViewer {...baseProps} status="ready" sections={sections} onReadToEnd={onReadToEnd} />
    )
    const region = screen.getByRole('region')

    region.scrollTop = 800
    fireEvent.scroll(region)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(onReadToEnd).toHaveBeenCalledOnce()

    region.scrollTop = 800
    fireEvent.scroll(region)
    expect(onReadToEnd).toHaveBeenCalledOnce()
  })

  it('scrolls by keyboard: ArrowDown advances, End reaches the end and reports full progress', async () => {
    stubScrollMetrics(1000, 200)
    const user = userEvent.setup()
    const onReadToEnd = vi.fn()
    render(
      <DocumentViewer {...baseProps} status="ready" sections={sections} onReadToEnd={onReadToEnd} />
    )
    const region = screen.getByRole('region')

    region.focus()
    await user.keyboard('{ArrowDown}')
    expect(region.scrollTop).toBe(40)

    await user.keyboard('{End}')
    expect(region.scrollTop).toBe(800)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(onReadToEnd).toHaveBeenCalledOnce()
  })

  it('scrolls by keyboard: PageDown advances by a viewport, Home returns to the start', async () => {
    stubScrollMetrics(1000, 200)
    const user = userEvent.setup()
    render(<DocumentViewer {...baseProps} status="ready" sections={sections} />)
    const region = screen.getByRole('region')

    region.focus()
    await user.keyboard('{PageDown}')
    expect(region.scrollTop).toBe(200)

    await user.keyboard('{Home}')
    expect(region.scrollTop).toBe(0)
  })
})

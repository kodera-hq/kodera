import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Profiler, useEffect, useState } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { server } from '@/mocks/server'
import { handlers as catalogueHandlers } from '@/mocks/overlays/order.catalogue-default'
import { handlers as dpaUnavailableHandlers } from '@/mocks/overlays/order.dpa-unavailable'
import { resetIdempotencyStore } from '@/mocks/generated/handlers'
import { AgreementsStep } from './AgreementsStep'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { emptyDraft } from './draft'
import { orderSubmission } from './submission'
import type { OrderDraft } from './draft'
import type { LegalDocument } from './api'

const BASE = 'https://core.test/api/v1'

const CONTACTS: OrderDraft['contacts'] = {
  legalName: 'ACME Construction',
  slug: 'acme',
  registrationNumber: '830485108',
  vatNumber: '',
  addressLine1: '12 rue des Lilas',
  postalCode: '75011',
  city: 'Paris',
  country: 'FR',
  billingReference: '',
  adminEmail: 'marie.dupont@acme.fr',
  billingEmail: 'compta@acme.fr',
  securityEmail: 'dpo@acme.fr',
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  server.use(...catalogueHandlers)
})
afterEach(() => {
  server.resetHandlers()
  resetIdempotencyStore()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

function Harness({
  initial,
  onUpdate,
  onSubmitted,
  signatoryEmail,
}: {
  signatoryEmail: unknown
  initial: OrderDraft
  onUpdate: (patch: Partial<OrderDraft>) => void
  onSubmitted: (orderId: string) => void
}) {
  const [draft] = useState<OrderDraft>(initial)
  // A purchase key allocated for this draft is reported as a draft patch, so a held-mode test can
  // assert that none ever was.
  const recorded = orderSubmission(draft.draftId)
  useEffect(() => {
    if (recorded.key !== undefined) onUpdate({ submitIdempotencyKey: recorded.key })
  })
  // Deliberately allow malformed runtime data in defensive-render tests.
  return (
    <AgreementsStep
      draft={draft}
      organisationId="org-1"
      signatoryName="Marie Dupont"
      signatoryEmail={signatoryEmail as string}
      onSubmitted={onSubmitted}
      onBack={vi.fn()}
    />
  )
}

function renderStep(
  draftOverrides: Partial<OrderDraft> = {},
  identity: { email: unknown } = { email: 'marie.dupont@acme.fr' }
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const initial: OrderDraft = {
    ...emptyDraft(),
    packCode: 'visio-docs',
    capacityTierCode: 'M',
    contacts: CONTACTS,
    ...draftOverrides,
  }
  const update = vi.fn()
  const onSubmitted = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <Harness
        initial={initial}
        onUpdate={update}
        onSubmitted={onSubmitted}
        signatoryEmail={identity.email}
      />
    </QueryClientProvider>
  )
  return { update, onSubmitted }
}

describe('AgreementsStep', () => {
  it.each(['marie.dupont@acme.fr', 'Marie.Dupont+legal@acme.fr'])(
    'renders the supplied signatory email unchanged: %s',
    async (email) => {
      renderStep({}, { email })
      await screen.findByRole('checkbox', { name: /ACME Construction/ })
      expect(screen.getByText(`Signataire : Marie Dupont · ${email}`)).toBeInTheDocument()
      expect(screen.queryByText(new RegExp(SUPPORT_EMAIL))).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    }
  )

  it.each([undefined, null, '', '   ', 'invalid-address'])(
    'does not fabricate a signatory identity from invalid caller email: %s',
    async (email) => {
      renderStep({}, { email })
      await screen.findByRole('checkbox', { name: /ACME Construction/ })
      expect(screen.queryByText(/Signataire :/)).not.toBeInTheDocument()
      expect(screen.queryByText(new RegExp(SUPPORT_EMAIL))).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
    }
  )

  it('keeps purchase submission disabled while documents remain available', async () => {
    const { update, onSubmitted } = renderStep()
    await screen.findByRole('checkbox', { name: /ACME Construction/ })
    const submit = screen.getByRole('button', { name: 'Signer et recevoir la facture' })
    expect(submit).toBeDisabled()
    await userEvent.click(submit)
    expect(update).not.toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('blocks acceptance when a document cannot be shown', async () => {
    server.use(...dpaUnavailableHandlers)
    renderStep()
    const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })

    await waitFor(() => expect(checkbox).toBeDisabled())
  })

  it('does not allocate a purchase key even after accepting the available documents', async () => {
    const { update, onSubmitted } = renderStep()
    const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await waitFor(() => expect(checkbox).not.toBeDisabled())
    await userEvent.click(checkbox)
    const submit = screen.getByRole('button', { name: 'Signer et recevoir la facture' })
    expect(submit).toBeDisabled()
    await userEvent.click(submit)
    expect(update).not.toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
  })
})

const BROWSING_LABELS: Record<LegalDocument['code'], string> = {
  cgv: 'Conditions générales de vente',
  dpa: 'Contrat de sous-traitance (RGPD)',
  sla: 'Engagement de service',
  aup: "Charte d'usage",
}

function browsingDocuments(): LegalDocument[] {
  return (['cgv', 'dpa', 'sla', 'aup'] as const).map((code) => ({
    code,
    title: BROWSING_LABELS[code],
    locale: 'fr',
    version: 'fixture-template',
    published_at: '2030-01-01T00:00:00Z',
    html_url: `https://legal.example.test/${code}?view=full#terms`,
    download: null,
  }))
}

function serveBrowsingDocuments(
  code: LegalDocument['code'],
  changes: Partial<LegalDocument>,
  omitted: readonly ('html_url' | 'download')[] = []
) {
  const documents = browsingDocuments().map((document) => {
    if (document.code !== code) return document
    const changed: LegalDocument = { ...document, ...changes }
    for (const key of omitted) delete changed[key]
    return changed
  })
  server.use(
    http.get(`${BASE}/legal-documents`, () =>
      HttpResponse.json({ data: documents, next_cursor: null, has_more: false })
    )
  )
}

function browsingRow(code: LegalDocument['code']) {
  return screen.getByRole('cell', { name: BROWSING_LABELS[code] }).closest('tr')!
}

async function awaitBrowsingDpa() {
  // Distinct from catalogue version: this is rendered only after the real DPA mutation returns.
  await within(browsingRow('dpa')).findByText('2026.11')
}

async function selectBrowsingDocument(code: LegalDocument['code']) {
  await userEvent.click(within(browsingRow(code)).getByRole('button', { name: 'Lire' }))
  const heading = screen.getByRole('heading', {
    level: 2,
    name: `${BROWSING_LABELS[code]} — ACME Construction`,
  })
  return { heading, actions: within(heading.parentElement!) }
}

describe('AgreementsStep existing full-document navigation', () => {
  let unexpectedRequests = 0
  let purchaseRequests = 0
  let dpaRequests = 0
  const auditRequest = ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    const allowed = new Set([
      'GET /api/v1/catalog/plans',
      'GET /api/v1/catalog/packs',
      'GET /api/v1/catalog/capacity-tiers',
      'GET /api/v1/catalog/prices',
      'GET /api/v1/legal-documents',
      'POST /api/v1/organisations/org-1/dpa',
    ])
    if (url.origin !== 'https://core.test' || !allowed.has(route)) unexpectedRequests += 1
    if (request.method === 'POST' && url.pathname.endsWith('/orders')) purchaseRequests += 1
    if (request.method === 'POST' && url.pathname.endsWith('/dpa')) dpaRequests += 1
  }
  beforeEach(() => {
    unexpectedRequests = 0
    purchaseRequests = 0
    dpaRequests = 0
    server.events.on('request:start', auditRequest)
  })
  afterEach(() => {
    server.events.removeListener('request:start', auditRequest)
    // Sticky outside the client: a caught NetworkError cannot hide an unexpected effect.
    expect(unexpectedRequests).toBe(0)
    expect(purchaseRequests).toBe(0)
  })

  it.each(['cgv', 'sla', 'aup'] as const)(
    'exposes the exact HTML-only %s document after selecting the real viewer',
    async (code) => {
      const html_url =
        code === 'sla'
          ? 'HTTPS://LEGAL.example.test/sla?view=full#terms'
          : `https://legal.example.test/${code}?view=full#terms`
      serveBrowsingDocuments(code, { html_url })
      renderStep()
      await screen.findByRole('checkbox', { name: /ACME Construction/ })
      await awaitBrowsingDpa()
      const { actions } = await selectBrowsingDocument(code)
      const link = actions.getByRole('link', { name: 'Ouvrir' })
      expect(link).toBeVisible()
      expect(link).toHaveAttribute('href', html_url)
      expect(actions.queryByRole('link', { name: 'PDF' })).not.toBeInTheDocument()
    }
  )

  it.each(['both-null', 'both-omitted', 'html-omitted', 'download-omitted'] as const)(
    'refuses unavailable optional document destinations: %s',
    async (kind) => {
      const omitted: ('html_url' | 'download')[] = []
      if (kind === 'both-omitted' || kind === 'html-omitted') omitted.push('html_url')
      if (kind === 'both-omitted' || kind === 'download-omitted') omitted.push('download')
      serveBrowsingDocuments('cgv', { html_url: null, download: null }, omitted)
      renderStep()
      const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
      await awaitBrowsingDpa()
      expect(checkbox).toBeDisabled()
      await userEvent.click(within(browsingRow('cgv')).getByRole('button', { name: 'Lire' }))
      expect(
        screen.getByText("Ce document n'a pas pu s'afficher. Téléchargez-le en PDF, ou réessayez.")
      ).toBeVisible()
      expect(screen.queryByRole('link', { name: 'Ouvrir' })).not.toBeInTheDocument()
    }
  )

  it.each([
    '',
    ' ',
    ' https://legal.example.test/cgv',
    '/legal/cgv',
    '//legal.example.test/cgv',
    'https:legal.example.test/cgv',
    'https:/legal.example.test/cgv',
    'javascript:alert(1)',
    'data:text/html,fixture',
    'http://legal.example.test/cgv',
    'https://user:password@legal.example.test/cgv',
    'https://@legal.example.test/cgv',
    'https://:@legal.example.test/cgv',
    'https://legal.example.test/with\\backslash',
    'https://legal.example.test/with\ncontrol',
  ])('does not call an unsupported HTML-only destination available: %j', async (html_url) => {
    serveBrowsingDocuments('cgv', { html_url, download: null })
    renderStep()
    const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await awaitBrowsingDpa()
    expect(checkbox).toBeDisabled()
    await userEvent.click(within(browsingRow('cgv')).getByRole('button', { name: 'Lire' }))
    expect(
      screen.getByText("Ce document n'a pas pu s'afficher. Téléchargez-le en PDF, ou réessayez.")
    ).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Ouvrir' })).not.toBeInTheDocument()
  })

  it('preserves exact URL bytes when @ occurs only in the path and query', async () => {
    const html_url = 'https://legal.example.test/terms@v1?section=user@example.test#terms'
    serveBrowsingDocuments('cgv', { html_url })
    renderStep()
    await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await awaitBrowsingDpa()
    const { actions } = await selectBrowsingDocument('cgv')
    expect(actions.getByRole('link', { name: 'Ouvrir' })).toHaveAttribute('href', html_url)
  })

  it.each(['null', 'omitted', 'unsafe', 'valid'] as const)(
    'preserves the existing PDF fallback alongside %s HTML',
    async (kind) => {
      const pdf = 'https://files.example.test/cgv.pdf?synthetic=opaque'
      const html_url =
        kind === 'null'
          ? null
          : kind === 'unsafe'
            ? 'javascript:alert(1)'
            : 'https://legal.example.test/cgv'
      serveBrowsingDocuments(
        'cgv',
        {
          html_url,
          download: {
            url: pdf,
            expires_at: '2035-01-01T00:00:00Z',
            content_type: 'application/pdf',
          },
        },
        kind === 'omitted' ? ['html_url'] : []
      )
      renderStep()
      const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
      await awaitBrowsingDpa()
      expect(checkbox).not.toBeDisabled()
      const { actions } = await selectBrowsingDocument('cgv')
      expect(actions.getByRole('link', { name: 'PDF' })).toHaveAttribute('href', pdf)
      if (kind === 'valid') {
        expect(actions.getByRole('link', { name: 'Ouvrir' })).toHaveAttribute('href', html_url)
      } else expect(actions.queryByRole('link', { name: 'Ouvrir' })).not.toBeInTheDocument()
    }
  )

  it('does not present catalogue template HTML as the generated organisation DPA', async () => {
    serveBrowsingDocuments('dpa', { html_url: 'https://legal.example.test/template-dpa' })
    renderStep()
    await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await awaitBrowsingDpa()
    const { actions } = await selectBrowsingDocument('dpa')
    expect(actions.queryByRole('link', { name: 'Ouvrir' })).not.toBeInTheDocument()
    expect(screen.getByText('Scaleway — Hosting and infrastructure (Paris)')).toBeVisible()
  })

  it('offers no template HTML while the generated DPA is unavailable', async () => {
    serveBrowsingDocuments('dpa', { html_url: 'https://legal.example.test/template-dpa' })
    server.use(...dpaUnavailableHandlers)
    renderStep()
    const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await userEvent.click(within(browsingRow('dpa')).getByRole('button', { name: 'Lire' }))
    expect(checkbox).toBeDisabled()
    expect(
      screen.getByText("Ce document n'a pas pu s'afficher. Téléchargez-le en PDF, ou réessayez.")
    ).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Ouvrir' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Signer et recevoir la facture' })).toBeDisabled()
  })

  it('keeps native anchor, keyboard focus, new-tab privacy and the purchase hold', async () => {
    serveBrowsingDocuments('cgv', {})
    const { update, onSubmitted } = renderStep()
    const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await awaitBrowsingDpa()
    const { heading, actions } = await selectBrowsingDocument('cgv')
    expect(heading.closest('[tabindex="-1"]')).toHaveFocus()
    const link = actions.getByRole('link', { name: 'Ouvrir' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')?.split(/\s+/)).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer'])
    )
    expect(link).toHaveAccessibleDescription('Ouvre un nouvel onglet')
    await userEvent.tab()
    expect(link).toHaveFocus()
    await userEvent.click(checkbox)
    const submit = screen.getByRole('button', { name: 'Signer et recevoir la facture' })
    expect(submit).toBeDisabled()
    await userEvent.click(submit)
    expect(update).not.toHaveBeenCalled()
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(purchaseRequests).toBe(0)
    expect(dpaRequests).toBe(1)
  })
})

const VERSION_GUARD_KEY = ['order', 'legal-documents', 'visio-docs', 'fr'] as const

describe('AgreementsStep local choice follows displayed legal versions', () => {
  let legalDocuments: LegalDocument[]
  let legalFailure = false
  let legalRequests = 0
  let dpaRequests = 0
  let purchaseRequests = 0
  let unexpectedRequests = 0
  let storageWrites = 0
  let responseGate: Promise<void> | undefined
  let releaseResponse: (() => void) | undefined
  const clients: QueryClient[] = []
  const observeRequest = ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    const allowed = new Set([
      'GET /api/v1/catalog/plans',
      'GET /api/v1/catalog/packs',
      'GET /api/v1/catalog/capacity-tiers',
      'GET /api/v1/catalog/prices',
      'GET /api/v1/legal-documents',
      'POST /api/v1/organisations/org-1/dpa',
    ])
    if (url.origin !== 'https://core.test' || !allowed.has(route)) unexpectedRequests += 1
    if (request.method === 'POST' && url.pathname.endsWith('/orders')) purchaseRequests += 1
    if (request.method === 'POST' && url.pathname.endsWith('/dpa')) dpaRequests += 1
  }

  beforeEach(() => {
    legalDocuments = browsingDocuments().map((document) => ({ ...document, version: 'guard-v1' }))
    legalFailure = false
    legalRequests = 0
    dpaRequests = 0
    purchaseRequests = 0
    unexpectedRequests = 0
    storageWrites = 0
    responseGate = undefined
    releaseResponse = undefined
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      storageWrites += 1
      originalSetItem.call(this, key, value)
    })
    server.events.on('request:start', observeRequest)
    server.use(
      http.get(`${BASE}/legal-documents`, async () => {
        legalRequests += 1
        const answer = legalDocuments.map((document) => ({ ...document }))
        const failure = legalFailure
        await responseGate
        return failure
          ? HttpResponse.json(
              { type: 'https://core.test/problems/internal-error' },
              { status: 500 }
            )
          : HttpResponse.json({ data: answer, next_cursor: null, has_more: false })
      })
    )
  })

  afterEach(() => {
    releaseResponse?.()
    for (const client of clients) client.clear()
    clients.length = 0
    server.events.removeListener('request:start', observeRequest)
    expect(unexpectedRequests).toBe(0)
    expect(purchaseRequests).toBe(0)
    expect(dpaRequests).toBe(1)
    expect(storageWrites).toBe(0)
  })

  function mountVersionGuard(observeCommit?: () => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const update = vi.fn()
    const onSubmitted = vi.fn()
    render(
      <QueryClientProvider client={client}>
        <Profiler id="legal-version-choice" onRender={() => observeCommit?.()}>
          <Harness
            initial={{
              ...emptyDraft(),
              packCode: 'visio-docs',
              capacityTierCode: 'M',
              contacts: CONTACTS,
            }}
            onUpdate={update}
            onSubmitted={onSubmitted}
            signatoryEmail="marie.dupont@acme.fr"
          />
        </Profiler>
      </QueryClientProvider>
    )
    return { client, update, onSubmitted }
  }

  async function settledChoice() {
    const checkbox = await screen.findByRole('checkbox', { name: /ACME Construction/ })
    await awaitBrowsingDpa()
    await waitFor(() => expect(checkbox).not.toBeDisabled())
    return checkbox
  }

  async function refetchLegal(client: QueryClient) {
    const requestsBefore = legalRequests
    await act(async () => {
      await client.refetchQueries({ queryKey: VERSION_GUARD_KEY, exact: true })
    })
    expect(legalRequests).toBe(requestsBefore + 1)
    expect(client.getQueryState(VERSION_GUARD_KEY)?.fetchStatus).toBe('idle')
  }

  async function assertPurchaseHeld(mounted: ReturnType<typeof mountVersionGuard>) {
    const submit = screen.getByRole('button', { name: 'Signer et recevoir la facture' })
    expect(submit).toBeDisabled()
    await userEvent.click(submit)
    expect(mounted.update).not.toHaveBeenCalled()
    expect(mounted.onSubmitted).not.toHaveBeenCalled()
    expect(purchaseRequests).toBe(0)
    expect(storageWrites).toBe(0)
  }

  it('never carries the old check into the first committed visible CGV version change', async () => {
    const commits: {
      version: 'guard-v1' | 'guard-v2' | undefined
      checked: string | null | undefined
    }[] = []
    const mounted = mountVersionGuard(() => {
      const row = screen.queryByRole('cell', { name: BROWSING_LABELS.cgv })?.closest('tr')
      const checkbox = screen.queryByRole('checkbox', { name: /ACME Construction/ })
      const version =
        row != null && within(row).queryByText('guard-v2') !== null
          ? 'guard-v2'
          : row != null && within(row).queryByText('guard-v1') !== null
            ? 'guard-v1'
            : undefined
      commits.push({ version, checked: checkbox?.getAttribute('aria-checked') })
    })
    const checkbox = await settledChoice()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(
      commits.some((commit) => commit.version === 'guard-v1' && commit.checked === 'true'),
      'COMMIT_PROBE_OBSERVED_ORIGINAL_CHECK'
    ).toBe(true)
    const firstChangedIndex = commits.length
    legalDocuments = legalDocuments.map((document) =>
      document.code === 'cgv' ? { ...document, version: 'guard-v2' } : document
    )
    await refetchLegal(mounted.client)
    expect(await within(browsingRow('cgv')).findByText('guard-v2')).toBeVisible()
    const firstChangedCommit = commits
      .slice(firstChangedIndex)
      .find((commit) => commit.version === 'guard-v2')
    expect(firstChangedCommit, 'COMMIT_PROBE_OBSERVED_CHANGED_VISIBLE_VERSION').toBeDefined()
    expect(firstChangedCommit?.checked, 'FIRST_COMMIT_NEW_LEGAL_VERSION_UNCHECKED').toBe('false')
    expect(checkbox).not.toBeChecked()
    await assertPurchaseHeld(mounted)
  })

  it.each(['cgv', 'sla', 'aup'] as const)(
    'invalidates the old choice when refetch visibly changes the %s version',
    async (code) => {
      const mounted = mountVersionGuard()
      const checkbox = await settledChoice()
      expect(within(browsingRow(code)).getByText('guard-v1')).toBeVisible()
      expect(checkbox).not.toBeChecked()
      await userEvent.click(checkbox)
      expect(checkbox).toBeChecked()
      legalDocuments = legalDocuments.map((document) =>
        document.code === code ? { ...document, version: 'guard-v2' } : document
      )
      await refetchLegal(mounted.client)
      expect(await within(browsingRow(code)).findByText('guard-v2')).toBeVisible()
      expect(checkbox, 'LEGAL_VERSION_CHANGE_INVALIDATES_CHECK').not.toBeChecked()
      await userEvent.click(checkbox)
      expect(checkbox).toBeChecked()
      legalDocuments = legalDocuments.map((document) =>
        document.code === code ? { ...document, version: 'guard-v1' } : document
      )
      await refetchLegal(mounted.client)
      expect(await within(browsingRow(code)).findByText('guard-v1')).toBeVisible()
      expect(checkbox, 'SECOND_LEGAL_VERSION_CHANGE_INVALIDATES_CHECK').not.toBeChecked()
      await assertPurchaseHeld(mounted)
    }
  )

  it('invalidates the old choice when the actual response changes a legal document locale', async () => {
    const oldPdfHref = 'https://files.example.test/locale-witness/cgv-before.pdf'
    const newPdfHref = 'https://files.example.test/locale-witness/cgv-after.pdf'
    legalDocuments = legalDocuments.map((document) =>
      document.code === 'cgv'
        ? {
            ...document,
            download: {
              url: oldPdfHref,
              expires_at: '2035-01-01T00:00:00Z',
              content_type: 'application/pdf',
            },
          }
        : document
    )
    const mounted = mountVersionGuard()
    const checkbox = await settledChoice()
    expect(await within(browsingRow('cgv')).findByRole('link', { name: 'PDF' })).toHaveAttribute(
      'href',
      oldPdfHref
    )
    expect(
      within(browsingRow('cgv'))
        .queryAllByRole('link')
        .some((link) => link.getAttribute('href') === newPdfHref)
    ).toBe(false)
    expect(
      mounted.client
        .getQueryData<LegalDocument[]>(VERSION_GUARD_KEY)
        ?.find((document) => document.code === 'cgv')?.locale
    ).toBe('fr')
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    // The new locale and presentation witness arrive together in the same real response.
    legalDocuments = legalDocuments.map((document) =>
      document.code === 'cgv'
        ? {
            ...document,
            locale: 'en',
            download: {
              url: newPdfHref,
              expires_at: '2035-01-01T00:00:00Z',
              content_type: 'application/pdf',
            },
          }
        : document
    )
    await refetchLegal(mounted.client)
    await waitFor(() =>
      expect(within(browsingRow('cgv')).getByRole('link', { name: 'PDF' })).toHaveAttribute(
        'href',
        newPdfHref
      )
    )
    expect(
      within(browsingRow('cgv'))
        .queryAllByRole('link')
        .some((link) => link.getAttribute('href') === oldPdfHref)
    ).toBe(false)
    const current = mounted.client.getQueryData<LegalDocument[]>(VERSION_GUARD_KEY)
    expect(current?.find((document) => document.code === 'cgv')?.locale).toBe('en')
    expect(within(browsingRow('cgv')).getByText('guard-v1')).toBeVisible()
    expect(checkbox, 'LEGAL_LOCALE_CHANGE_INVALIDATES_CHECK').not.toBeChecked()
    await assertPurchaseHeld(mounted)
  })

  it('retains a valid choice after equivalent refetch and reordered refreshed destinations', async () => {
    const mounted = mountVersionGuard()
    const checkbox = await settledChoice()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    legalDocuments = [...legalDocuments].reverse().map((document) => ({
      ...document,
      download: {
        url: `https://files.example.test/${document.code}.pdf?rotation=second`,
        expires_at: '2035-01-01T00:00:00Z',
        content_type: 'application/pdf',
      },
    }))
    await refetchLegal(mounted.client)
    expect(await within(browsingRow('cgv')).findByRole('link', { name: 'PDF' })).toHaveAttribute(
      'href',
      'https://files.example.test/cgv.pdf?rotation=second'
    )
    expect(within(browsingRow('cgv')).getByText('guard-v1')).toBeVisible()
    expect(checkbox, 'PERMANENT_RESET_LOSES_EQUIVALENT_CHECK').toBeChecked()
    await assertPurchaseHeld(mounted)
  })

  it('does not resurrect the original choice when versions change away and back', async () => {
    const mounted = mountVersionGuard()
    const checkbox = await settledChoice()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    const original = legalDocuments
    legalDocuments = legalDocuments.map((document) =>
      document.code === 'cgv' ? { ...document, version: 'guard-v2' } : document
    )
    await refetchLegal(mounted.client)
    expect(await within(browsingRow('cgv')).findByText('guard-v2')).toBeVisible()
    expect(checkbox, 'LEGAL_VERSION_CHANGE_INVALIDATES_CHECK').not.toBeChecked()
    legalDocuments = original
    await refetchLegal(mounted.client)
    expect(await within(browsingRow('cgv')).findByText('guard-v1')).toBeVisible()
    expect(checkbox, 'OLD_LEGAL_CHOICE_MUST_NOT_REVIVE').not.toBeChecked()
    await assertPurchaseHeld(mounted)
  })

  it.each(['missing', 'unavailable'] as const)(
    'retires the old choice after a required document becomes %s and later returns',
    async (condition) => {
      const mounted = mountVersionGuard()
      const checkbox = await settledChoice()
      await userEvent.click(checkbox)
      expect(checkbox).toBeChecked()
      const original = legalDocuments
      legalDocuments =
        condition === 'missing'
          ? legalDocuments.filter((document) => document.code !== 'cgv')
          : legalDocuments.map((document) =>
              document.code === 'cgv' ? { ...document, html_url: null, download: null } : document
            )
      await refetchLegal(mounted.client)
      await waitFor(() => expect(checkbox).toBeDisabled())
      expect(checkbox, 'UNAVAILABLE_LEGAL_CHOICE_RETIRED').not.toBeChecked()
      legalDocuments = original
      await refetchLegal(mounted.client)
      await waitFor(() => expect(checkbox).not.toBeDisabled())
      expect(checkbox, 'UNAVAILABLE_LEGAL_CHOICE_MUST_NOT_REVIVE').not.toBeChecked()
      await assertPurchaseHeld(mounted)
    }
  )

  it('retires the old choice after a failed legal refetch and successful explicit recovery', async () => {
    const mounted = mountVersionGuard()
    const checkbox = await settledChoice()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    const previouslyRead = mounted.client.getQueryData<LegalDocument[]>(VERSION_GUARD_KEY)
    expect(previouslyRead, 'CACHED_ERROR_SETUP_HAS_CURRENT_DOCUMENTS').toHaveLength(4)
    legalFailure = true
    await refetchLegal(mounted.client)
    expect(mounted.client.getQueryState(VERSION_GUARD_KEY)?.status).toBe('error')
    expect(
      mounted.client.getQueryData(VERSION_GUARD_KEY),
      'FAILED_REFETCH_RETAINS_PRIOR_QUERY_DATA'
    ).toEqual(previouslyRead)
    expect(await screen.findByRole('button', { name: 'Réessayer' })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: /ACME Construction/ })).not.toBeInTheDocument()
    legalFailure = false
    await refetchLegal(mounted.client)
    const recovered = await settledChoice()
    expect(recovered, 'FAILED_LEGAL_CHOICE_MUST_NOT_REVIVE').not.toBeChecked()
    await assertPurchaseHeld(mounted)
  })

  it('keeps cached checked versions during pending refetch and retires them on the changed response', async () => {
    const mounted = mountVersionGuard()
    const checkbox = await settledChoice()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    legalDocuments = legalDocuments.map((document) =>
      document.code === 'cgv' ? { ...document, version: 'guard-v2' } : document
    )
    responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const requestsBefore = legalRequests
    let pending: Promise<void> | undefined
    act(() => {
      pending = mounted.client.refetchQueries({ queryKey: VERSION_GUARD_KEY, exact: true })
    })
    await waitFor(() => expect(legalRequests).toBe(requestsBefore + 1))
    expect(within(browsingRow('cgv')).getByText('guard-v1')).toBeVisible()
    expect(checkbox, 'PENDING_EQUIVALENT_VIEW_RETAINS_CHECK').toBeChecked()
    responseGate = undefined
    releaseResponse?.()
    await act(async () => {
      await pending
    })
    expect(await within(browsingRow('cgv')).findByText('guard-v2')).toBeVisible()
    expect(checkbox, 'LEGAL_VERSION_CHANGE_INVALIDATES_CHECK').not.toBeChecked()
    await assertPurchaseHeld(mounted)
  })

  it('keeps initial loading unchecked and preserves the existing generated DPA boundary', async () => {
    responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const mounted = mountVersionGuard()
    await waitFor(() => expect(legalRequests).toBe(1))
    expect(screen.queryByRole('checkbox', { name: /ACME Construction/ })).not.toBeInTheDocument()
    responseGate = undefined
    releaseResponse?.()
    const checkbox = await settledChoice()
    expect(checkbox).not.toBeChecked()
    expect(within(browsingRow('dpa')).getByText('2026.11')).toBeVisible()
    await assertPurchaseHeld(mounted)
  })
})

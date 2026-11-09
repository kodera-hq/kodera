// `agreements` — 01-order.md §4.3: the four documents, read in place, one
// acceptance covering the versions actually shown. Submission is the single
// transaction (`POST .../orders`, §6): the DPA acceptance travels inside it,
// so nothing is processed before it is recorded.
//
// Document bodies: `cgv`/`sla`/`aup` carry no body text in the contract, only
// an external `html_url` and a PDF `download` link (ADR-0003: the console
// talks to the Core API alone, so it never fetches that external page) — the
// in-app reading pane shows the version and publication date the catalogue
// *does* give. Non-DPA full text opens through the supplied HTML/PDF link.
// Generated `dpa` metadata and its sub-processor list come back as data;
// the catalogue's template HTML is not that organisation-specific document.

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { OrderSummary } from './OrderSummary'
import { formatDate } from '../../i18n/format'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { Checkbox } from '../../ui/Checkbox/Checkbox'
import { DefinitionList } from '../../ui/DefinitionList/DefinitionList'
import { DocumentViewer } from '../../ui/DocumentViewer/DocumentViewer'
import type { DocumentViewerSection } from '../../ui/DocumentViewer/DocumentViewer'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowActions,
} from '../../ui/Table/Table'
import type { LegalDocument } from './api'
import { cataloguePrice, useLegalDocumentsQuery, useLiveOrderQuery, usePricesQuery } from './api'
import type { OrderDraft } from './draft'
import { useGenerateDpaMutation, usePlaceOrderMutation } from './mutations'
import { SUBMISSION_HELD, orderSubmission, recordSubmission } from './submission'
import { ApiProblem } from '../../api/client'
import type { OrderRequest } from './mutations'
import { legalHtmlHref } from './legalHref'

export interface AgreementsStepProps {
  draft: OrderDraft
  organisationId: string
  signatoryName: string
  signatoryEmail: string
  onSubmitted: (orderId: string) => void
  onBack: () => void
  submissionHeldReasonId?: string
}

const SIGNATORY_EMAIL = z.string().email()

const DOCUMENT_ORDER: LegalDocument['code'][] = ['cgv', 'dpa', 'sla', 'aup']
const NON_DPA_DOCUMENT_ORDER = ['cgv', 'sla', 'aup'] as const

const LABEL_KEY: Record<LegalDocument['code'], string> = {
  cgv: 'console.order.agreements.label-cgv',
  dpa: 'console.order.agreements.label-dpa',
  sla: 'console.order.agreements.label-sla',
  aup: 'console.order.agreements.label-aup',
}

export function AgreementsStep({
  draft,
  organisationId,
  signatoryName,
  signatoryEmail,
  onSubmitted,
  onBack,
  submissionHeldReasonId,
}: AgreementsStepProps) {
  const { t } = useTranslation()
  const documentsQuery = useLegalDocumentsQuery(draft.packCode, 'fr')
  const generateDpa = useGenerateDpaMutation(organisationId)
  const placeOrder = usePlaceOrderMutation(organisationId)
  // The row the summary prices this order at, so the order names the plan the card showed
  // (`plan_code`, optional for Core, which otherwise picks the published plan for the pack and
  // tier). The same query the summary makes: one read.
  const prices = usePricesQuery(draft.packCode, draft.billingPeriod)
  const orderedPrice = cataloguePrice(
    prices.data ?? [],
    draft.packCode,
    draft.capacityTierCode,
    draft.billingPeriod
  )

  const [dpaKey, setDpaKey] = useState(() => crypto.randomUUID())
  const [selected, setSelected] = useState<LegalDocument['code']>()
  const [legalChoice, setLegalChoice] = useState<{
    identity: string | undefined
    checked: boolean
  }>({ identity: undefined, checked: false })
  const [acceptanceError, setAcceptanceError] = useState<string>()
  const [submitError, setSubmitError] = useState<string>()
  const headingId = useId()
  const opensNewTabId = useId()
  const checkboxRef = useRef<HTMLButtonElement>(null)
  const sending = useRef(false)
  // The order being placed lives in `submission.ts`, outside this component: an answer that
  // arrives after the step has unmounted is still recorded there.
  const [, setRevision] = useState(0)
  const submission = orderSubmission(draft.draftId)
  const liveOrder = useLiveOrderQuery(
    organisationId,
    !SUBMISSION_HELD && submission.orderId === undefined && !submission.unresolved
  )
  // An order already exists (perhaps committed behind an unknown outcome and a reload): this
  // page places no other one. Until the read answers, nothing is sent either.
  // A pending exact retry is still allowed: if that order committed, Core replays it.
  const orderExists = liveOrder.data === true && submission.key === undefined
  // The orders do not say whether one is live: nothing is sent, and the page says it may be.
  const orderUnknown = liveOrder.data === 'unknown' && submission.key === undefined
  const record = (patch: Parameters<typeof recordSubmission>[1]) => {
    recordSubmission(draft.draftId, patch)
    setRevision((revision) => revision + 1)
  }

  useEffect(() => {
    if (draft.packCode === undefined) return
    generateDpa.mutate({ packCode: draft.packCode, locale: 'fr', idempotencyKey: dpaKey })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.packCode, dpaKey])

  const documents = documentsQuery.data ?? []
  const byCode = new Map(documents.map((doc) => [doc.code, doc]))
  const selectedDocument = selected === undefined ? undefined : byCode.get(selected)
  const selectedHtmlHref =
    selected === 'dpa' ? undefined : legalHtmlHref(selectedDocument?.html_url)

  function isUnavailable(code: LegalDocument['code']): boolean {
    // The DPA is not "made available" (01-order.md acceptance test 4)
    // until its generation has actually succeeded — a still-pending
    // request is not a failure, but it is not a document the checkbox can
    // honestly claim was shown either.
    if (code === 'dpa') return !generateDpa.isSuccess
    const doc = byCode.get(code)
    if (doc === undefined) return true
    return legalHtmlHref(doc.html_url) === undefined && doc.download == null
  }

  const anyUnavailable = DOCUMENT_ORDER.some(isUnavailable)
  const legalIdentity =
    documentsQuery.isError || NON_DPA_DOCUMENT_ORDER.some(isUnavailable)
      ? undefined
      : JSON.stringify(
          NON_DPA_DOCUMENT_ORDER.map((code) => {
            const doc = byCode.get(code)
            return [code, doc?.locale, doc?.version]
          })
        )

  // Retire during render so a changed identity cannot commit with the old check
  // or revive it when an earlier version becomes available again.
  // The tick also covers the DPA generated for this order: a regenerated one must be accepted anew.
  const acceptanceIdentity =
    legalIdentity === undefined
      ? undefined
      : JSON.stringify([legalIdentity, generateDpa.data?.id ?? null])
  if (legalChoice.identity !== acceptanceIdentity) {
    setLegalChoice({ identity: acceptanceIdentity, checked: false })
  }
  const accepted =
    acceptanceIdentity !== undefined &&
    legalChoice.identity === acceptanceIdentity &&
    legalChoice.checked

  function sectionsFor(code: LegalDocument['code']): DocumentViewerSection[] {
    const doc = byCode.get(code)
    if (code === 'dpa' && generateDpa.data !== undefined) {
      const dpa = generateDpa.data
      return [
        {
          id: 'dpa-body',
          heading: t('console.order.agreements.label-version', { version: dpa.version }),
          paragraphs: [formatDate(dpa.generated_at, 'fr')],
        },
        {
          id: 'dpa-annex-c',
          heading: t('console.order.agreements.label-dpa-annex-c'),
          paragraphs: (dpa.sub_processors ?? []).map(
            (row) => `${row.name} — ${row.role} (${row.location})`
          ),
        },
      ]
    }
    if (doc === undefined) return []
    return [
      {
        id: `${code}-body`,
        heading: t('console.order.agreements.label-version', { version: doc.version }),
        paragraphs: [formatDate(doc.published_at, 'fr')],
      },
    ]
  }

  function openDocument(code: LegalDocument['code']) {
    setSelected(code)
  }

  useEffect(() => {
    if (selected === undefined) return
    document.getElementById(headingId)?.focus()
  }, [selected, headingId])

  async function handleSubmit() {
    if (sending.current) return
    sending.current = true
    try {
      await submitOrder()
    } finally {
      sending.current = false
    }
  }

  async function submitOrder() {
    // Read now, not from the render: an order this draft already placed ends it.
    const current = orderSubmission(draft.draftId)
    if (current.orderId !== undefined) return onSubmitted(current.orderId)
    if (
      SUBMISSION_HELD ||
      current.unresolved ||
      orderExists ||
      orderUnknown ||
      placeOrder.isPending
    )
      return
    setSubmitError(undefined)
    // After an unknown outcome, the very request that was sent, under its key.
    let { key, body } = current
    if (key === undefined || body === undefined) {
      if (!accepted) {
        setAcceptanceError(t('console.order.agreements.error-acceptance-required'))
        checkboxRef.current?.focus()
        return
      }
      const dpaId = generateDpa.data?.id
      if (dpaId === undefined) {
        // No DPA to accept yet: a failed generation is tried again, and the person told so.
        if (generateDpa.isError) setDpaKey(crypto.randomUUID())
        return setSubmitError(t('console.order.agreements.error-document-unavailable'))
      }
      if (
        legalIdentity === undefined ||
        draft.packCode === undefined ||
        draft.capacityTierCode === undefined ||
        draft.contacts === undefined
      )
        return
      // No order without the price row it is placed at: the summary says the price is unknown.
      if (orderedPrice === undefined) return setSubmitError(t('console.common.error-unavailable'))
      // Exactly the versions the person accepted: the identity the checkbox is bound to.
      const legalAcceptances = (
        JSON.parse(legalIdentity) as [LegalDocument['code'], 'fr' | 'en', string][]
      ).map(([code, locale, version]) => ({
        code,
        locale,
        version,
      })) as OrderRequest['legal_acceptances']
      // A fresh read, not the one this page mounted with: another tab may have ordered since.
      // No new order without knowing none exists.
      const fresh = await liveOrder.refetch()
      if (fresh.isError || fresh.data !== false) {
        // A live or possible order: the banner below says which.
        if (fresh.data !== undefined && !fresh.isError) return
        return setSubmitError(t('console.common.error-unavailable'))
      }
      key = crypto.randomUUID()
      body = {
        pack_code: draft.packCode,
        capacity_tier_code: draft.capacityTierCode,
        billing_period: draft.billingPeriod,
        plan_code: orderedPrice.plan_code,
        tenant: { slug: draft.contacts.slug, name: draft.contacts.legalName, locale: 'fr' },
        dpa_acceptance: { dpa_id: dpaId, accepted: true, accepted_by_name: signatoryName },
        legal_acceptances: legalAcceptances,
        billing_contact: {
          email: draft.contacts.billingEmail,
          name: draft.contacts.legalName,
          purchase_order_ref:
            draft.contacts.billingReference === '' ? null : draft.contacts.billingReference,
        },
      }
      record({ key, body })
    }
    const draftId = draft.draftId
    placeOrder.mutateAsync({ body, idempotencyKey: key }).then(
      (result) => {
        if (result === undefined) return setSubmitError(t('console.common.error-unavailable'))
        recordSubmission(draftId, { key: undefined, body: undefined, orderId: result.order.id })
        onSubmitted(result.order.id)
      },
      (error: unknown) => {
        const problem = error instanceof ApiProblem ? error : undefined
        const type = problem?.type?.replace('https://kodera.io/problems/', '')
        const fields = problem?.errors ?? []
        const refused = (pointer: string, codes: readonly string[]) =>
          fields.some((field) => field.pointer === pointer && codes.includes(field.code))
        // Unknown outcome, or the same request still running: keep the key and body for an
        // exact retry. Core replays a committed order instead of placing another.
        if (
          problem === undefined ||
          problem.status >= 500 ||
          type === 'idempotency-key-in-flight'
        ) {
          return setSubmitError(
            t('console.common.error-unexpected', { requestId: problem?.requestId ?? '—' })
          )
        }
        // A slug taken while the organisation has no order was taken by someone else: the
        // person chooses another. With an order, it may be theirs.
        if (type === 'slug-taken') {
          return void liveOrder.refetch().then((fresh) => {
            if (!fresh.isError && fresh.data === false) {
              record({ key: undefined, body: undefined })
              return setSubmitError(t('console.order.agreements.error-slug-taken'))
            }
            record({ unresolved: true })
            setSubmitError(t('console.order._.error-outcome-held'))
          })
        }
        // An order may already exist. Nothing more is sent from this page; support settles it.
        if (
          type === 'idempotency-key-reuse' ||
          refused('/dpa_acceptance/dpa_id', ['dpa_already_accepted'])
        ) {
          record({ unresolved: true })
          return setSubmitError(t('console.order._.error-outcome-held'))
        }
        // Another order is in flight for this organisation (contract 0.20.0: one order placed or
        // awaiting payment at a time). Nothing was placed; this page places no other one. The
        // person pays that order, or writes to support, then orders again under a new key.
        if (type === 'order-in-progress') {
          record({ key: undefined, body: undefined })
          void liveOrder.refetch()
          return setSubmitError(t('console.order._.error-order-exists'))
        }
        // A refusal is stored under its key: the corrected request is a new one.
        record({ key: undefined, body: undefined })
        if (
          refused('/legal_acceptances', [
            'cgv_not_in_force',
            'sla_not_in_force',
            'aup_not_in_force',
          ])
        ) {
          // A newer version is in force: read the documents again and ask for acceptance again.
          setLegalChoice({ identity: acceptanceIdentity, checked: false })
          void documentsQuery.refetch()
          return setSubmitError(t('console.order.agreements.error-version-changed'))
        }
        if (refused('/dpa_acceptance/dpa_id', ['dpa_not_in_force', 'dpa_other_pack'])) {
          // The DPA template changed: generate it again; acceptance resets with it.
          setDpaKey(crypto.randomUUID())
          return setSubmitError(t('console.order.agreements.error-dpa-changed'))
        }
        setSubmitError(
          t('console.common.error-unexpected', { requestId: problem.requestId ?? '—' })
        )
      }
    )
  }

  function withSummary(content: ReactNode) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_320px] narrow:grid-cols-1">
        {content}
        <OrderSummary draft={draft} />
      </div>
    )
  }

  if (documentsQuery.isLoading) {
    return withSummary(
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    )
  }

  if (documentsQuery.isError) {
    return withSummary(
      <Banner
        kind="incident"
        headline={t('console.common.error-unavailable')}
        action={
          <Button onClick={() => void documentsQuery.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        }
      />
    )
  }

  const organisationName = draft.contacts?.legalName ?? ''

  return withSummary(
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-c-ink">{t('console.order.agreements.title')}</h1>
        <p className="mt-1 text-sm text-c-ink-3">
          {t('console.order.agreements.subtitle', { organisation: organisationName })}
        </p>
      </div>

      <Table caption={t('console.order.agreements.title')}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t('console.order.agreements.title')}</TableHeaderCell>
            <TableHeaderCell>
              {t('console.order.agreements.label-version', { version: '' })}
            </TableHeaderCell>
            <TableRowActions />
          </TableRow>
        </TableHead>
        <TableBody>
          {DOCUMENT_ORDER.map((code) => {
            const doc = byCode.get(code)
            const version =
              code === 'dpa' ? (generateDpa.data?.version ?? doc?.version) : doc?.version
            return (
              <TableRow key={code}>
                <TableCell>{t(LABEL_KEY[code] as never)}</TableCell>
                <TableCell>{version === undefined ? '—' : version}</TableCell>
                <TableRowActions>
                  <div className="flex justify-end gap-2">
                    <Button variant="tertiary" size="sm" onClick={() => openDocument(code)}>
                      {t('console.order.agreements.action-read')}
                    </Button>
                    {doc?.download != null ? (
                      <LinkButton
                        variant="tertiary"
                        size="sm"
                        href={doc.download.url}
                        target="_blank"
                      >
                        {t('console.order.agreements.action-pdf')}
                      </LinkButton>
                    ) : null}
                  </div>
                </TableRowActions>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      {selected === undefined ? null : isUnavailable(selected) ? (
        <DocumentViewer
          id={headingId}
          tabIndex={-1}
          status="failed"
          failureMessage={t('console.order.agreements.error-document-unavailable')}
          label={t(LABEL_KEY[selected] as never)}
          tocLabel={t('console.order.agreements.a11y-toc')}
          progressLabel={t('console.order.agreements.a11y-progress')}
        />
      ) : (
        <DocumentViewer
          id={headingId}
          tabIndex={-1}
          status="ready"
          sections={sectionsFor(selected)}
          label={`${t(LABEL_KEY[selected] as never)} — ${organisationName}`}
          tocLabel={t('console.order.agreements.a11y-toc')}
          progressLabel={t('console.order.agreements.a11y-progress')}
          downloadAction={
            selectedHtmlHref !== undefined || selectedDocument?.download != null ? (
              <>
                {selectedHtmlHref === undefined ? null : (
                  <>
                    <LinkButton
                      variant="tertiary"
                      size="sm"
                      href={selectedHtmlHref}
                      target="_blank"
                      aria-describedby={opensNewTabId}
                    >
                      {t('console.common.action-open')}
                    </LinkButton>
                    <span id={opensNewTabId} className="sr-only">
                      {t('console.common.a11y-opens-new-tab')}
                    </span>
                  </>
                )}
                {selectedDocument?.download != null ? (
                  <LinkButton
                    variant="tertiary"
                    size="sm"
                    href={selectedDocument.download.url}
                    target="_blank"
                  >
                    {t('console.order.agreements.action-pdf')}
                  </LinkButton>
                ) : null}
              </>
            ) : undefined
          }
        />
      )}

      <div>
        <Checkbox
          ref={checkboxRef}
          label={t('console.order.agreements.label-acceptance', { organisation: organisationName })}
          // While a retry of the request already sent is pending, the acceptance it carried stands.
          checked={accepted || submission.key !== undefined}
          disabled={anyUnavailable || submission.key !== undefined}
          onCheckedChange={(checked) => {
            setLegalChoice({ identity: acceptanceIdentity, checked: checked === true })
            setAcceptanceError(undefined)
          }}
          {...(acceptanceError === undefined ? {} : { error: acceptanceError })}
        />
        <DefinitionList
          className="mt-2"
          items={
            SIGNATORY_EMAIL.safeParse(signatoryEmail).success
              ? [
                  {
                    term: '',
                    description: t('console.order.agreements.label-signatory', {
                      person: signatoryName,
                      email: signatoryEmail,
                    }),
                  },
                ]
              : []
          }
        />
      </div>

      {orderUnknown && submitError === undefined ? (
        <Banner kind="incident" headline={t('console.order._.error-outcome-held')} />
      ) : null}
      {orderExists && submitError === undefined ? (
        // An order is known to exist (the organisation's orders say so): one at a time, for now.
        <Banner kind="incident" headline={t('console.order._.error-order-exists')} />
      ) : null}
      {submitError === undefined ? null : <Banner kind="incident" headline={submitError} />}

      <div className="flex justify-between gap-3">
        <Button variant="secondary" onClick={onBack} disabled={placeOrder.isPending}>
          {t('console.common.action-back')}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={
            SUBMISSION_HELD || submission.unresolved === true || orderExists || orderUnknown
          }
          aria-describedby={submissionHeldReasonId}
          loading={placeOrder.isPending}
          aria-busy={placeOrder.isPending}
        >
          {t('console.order.agreements.action-submit')}
        </Button>
      </div>
    </div>
  )
}

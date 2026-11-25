// « Créez votre espace » (docs/specs/08-home.md §4.7; run-notes quick-workspace SPEC §2.1, W1):
// the owner's home before any tenant exists, on a deployment that does not bill. One form: the
// name, prefilled with the organisation's; the address derived from it, behind « Modifier »;
// the documents accepted, named and linked; and one button whose own words accept them
// (owner decision: no checkbox). `createTenant` writes the tenant, the agreements and the
// starter workspace in one step, and the owner lands on the workspace.

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { rememberSharedRealmSlug } from '../../app/communityAccess'
import { queryClient as appQueryClient } from '../../app/queryClient'
import { statusSummaryQueryKey } from '../../app/queryKeys'
import { isTenantSlug } from '../../api/tenantSlug'
import { Button } from '../../ui/Button/Button'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LINK_TEXT } from '../../ui/linkText'
import { PAGE_TITLE } from '../../ui/pageTitle'
import { RadioGroup } from '../../ui/RadioGroup/RadioGroup'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { TextField } from '../../ui/TextField/TextField'
import { useLegalDocumentsQuery, useSlugAvailabilityQuery } from '../order/api'
import type { LegalDocument } from '../order/api'
import { legalHtmlHref } from '../order/legalHref'
import { configuredTenantDomain } from '../order/tenantAddress'
import {
  forgetCreation,
  pendingCreation,
  rememberCreation,
  useCreateSelfServeWorkspaceMutation,
  useCreateTenantMutation,
} from './api'
import type { TenantCreation } from './api'
import { deriveOrganisationSlug, deriveSlug, isOrganisationSelfServeSlug } from './slug'

/** How long after the last change to the address its availability is read. */
export const SLUG_CHECK_DELAY_MS = 300
/** Counted in characters (code points), as Core's schema counts them. */
const NAME_MAX = 200
/** The Tenant's own rule: every "other" character (control, format, unassigned, private use,
 *  surrogate) and the line and paragraph separators; a no-break space is allowed. */
const FORBIDDEN_IN_NAME = /[\p{C}\u2028\u2029]/u
/** The documents in force are read in French, the language the service contract is held in. */
const DOCUMENT_LOCALE = 'fr' as const
const PROBLEM = 'https://kodera.io/problems/'

type NameError = 'empty' | 'too-long' | 'characters'
type Failure = 'documents-changed' | 'unavailable' | 'not-ready' | 'failed' | 'not-shown'
type Refusal = { reason: 'taken' | 'reserved'; suggestions: readonly string[] }

function nameError(name: string): NameError | undefined {
  if (name.trim().length === 0) return 'empty'
  if ([...name].length > NAME_MAX) return 'too-long'
  if (FORBIDDEN_IN_NAME.test(name)) return 'characters'
  return undefined
}

function newKey(): string {
  return crypto.randomUUID()
}

export function CreateWorkspace({
  organisationId,
  organisationName,
  packCode,
}: {
  organisationId: string
  organisationName: string
  packCode: string
}) {
  const { t } = useTranslation()
  const router = useRouter()
  const queryClient = useQueryClient()
  const hintId = useId()
  const newTabId = useId()
  const domain = configuredTenantDomain()

  const [name, setName] = useState(organisationName)
  // A prefilled name Core would refuse says why at once, rather than behind a dead button.
  const [nameTouched, setNameTouched] = useState(nameError(organisationName) !== undefined)
  const [editedSlug, setEditedSlug] = useState<string | undefined>(undefined)
  const [addressOpen, setAddressOpen] = useState(false)
  const slug = editedSlug ?? deriveSlug(name)
  const slugValid = isTenantSlug(slug)
  const showAddressField = addressOpen || !slugValid
  // « Modifier » and a suggestion replace the button pressed: the keyboard lands in the field.
  const addressRef = useRef<HTMLInputElement>(null)
  const [focusRequests, setFocusRequests] = useState(0)
  useEffect(() => {
    if (focusRequests > 0) addressRef.current?.focus()
  }, [focusRequests])
  function openAddress() {
    setAddressOpen(true)
    setFocusRequests((count) => count + 1)
  }

  // The availability of the address shown, read 300 ms after its last change.
  const [checkedSlug, setCheckedSlug] = useState(slug)
  useEffect(() => {
    const timer = window.setTimeout(() => setCheckedSlug(slug), SLUG_CHECK_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [slug])
  const availability = useSlugAvailabilityQuery(checkedSlug, isTenantSlug(checkedSlug))
  // Only the answer for the address on screen counts: each address is its own query, and one
  // still waiting for its check shows none.
  const answer = checkedSlug === slug ? availability.data : undefined
  // A refusal at submit is as good as a check, and outlives it: Core said this address cannot be
  // had, whatever an earlier check answered.
  const [refusals, setRefusals] = useState<Readonly<Record<string, Refusal>>>({})
  const refusedAtSubmit = Object.hasOwn(refusals, slug) ? refusals[slug] : undefined
  const unavailableReason: 'taken' | 'reserved' | undefined =
    refusedAtSubmit !== undefined
      ? refusedAtSubmit.reason
      : answer?.available === false
        ? answer.reason === 'reserved'
          ? 'reserved'
          : 'taken'
        : undefined
  const suggestions = (refusedAtSubmit?.suggestions ?? answer?.suggestions ?? []).slice(0, 3)

  const documents = useLegalDocumentsQuery(packCode, DOCUMENT_LOCALE)
  const cgv = documents.data?.find((doc) => doc.code === 'cgv')
  const dpa = documents.data?.find((doc) => doc.code === 'dpa')
  const documentsMissing = documents.isError || (documents.isSuccess && (!cgv || !dpa))

  const creation = useCreateTenantMutation(organisationId)
  const [failure, setFailure] = useState<Failure | undefined>(undefined)
  // From Core's 201 until the workspace opens, the request is done but the page is still here.
  const [opening, setOpening] = useState(false)
  const busy = creation.isPending || opening
  // While the documents are read again, the versions on screen may be the ones just refused:
  // the button shows busy, which also stops a press and Enter from submitting (Button's loading).
  const rereading = documents.isFetching

  // A name Core refused for its characters stays refused until it is changed.
  const [refusedName, setRefusedName] = useState<string | undefined>(undefined)
  const currentNameError = refusedName === name ? 'characters' : nameError(name)
  const canSubmit =
    currentNameError === undefined &&
    slugValid &&
    unavailableReason === undefined &&
    cgv !== undefined &&
    dpa !== undefined

  function applySuggestion(next: string) {
    setEditedSlug(next)
    openAddress()
  }

  function refuseAddress(refusal: Refusal) {
    setRefusals((known) => ({ ...known, [slug]: refusal }))
    openAddress()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setNameTouched(true)
    if (!canSubmit || busy || cgv === undefined || dpa === undefined) return
    const body: TenantCreation = {
      name,
      slug,
      locale: 'fr',
      legal_acceptances: [
        { code: 'cgv', version: cgv.version, locale: cgv.locale },
        { code: 'dpa', version: dpa.version, locale: dpa.locale },
      ],
    }
    const pending = pendingCreation(organisationId)
    const key =
      pending !== undefined && JSON.stringify(pending.body) === JSON.stringify(body)
        ? pending.key
        : newKey()
    rememberCreation(organisationId, { key, body })
    setFailure(undefined)
    try {
      await creation.mutateAsync({ body, idempotencyKey: key })
    } catch (error) {
      refused(error)
      return
    }
    forgetCreation(organisationId)
    await showTenant()
  }

  // This form is the home (`/{org}/home`): once the home's read names the tenant, the home shows
  // the workspace being prepared (ProvisioningView), where people can be invited, and this form
  // goes. The workspace itself opens once the tenant runs (W2): before that, its Espace sign-in
  // would reach for a homeserver that does not exist yet. The home hears of the new answer a
  // moment after this read resolves, so the answer is looked at here: one that names the tenant
  // keeps the button busy until the home takes over; one that does not means the read failed,
  // and the owner is told the workspace exists.
  async function showTenant() {
    setOpening(true)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['home'] }),
      queryClient.invalidateQueries({ queryKey: statusSummaryQueryKey(organisationId) }),
    ])
    const summary = queryClient.getQueryData<{ tenant_id?: string | null }>(
      statusSummaryQueryKey(organisationId)
    )
    const fallback = queryClient.getQueryData<string | null>([
      'home',
      'tenants-fallback',
      organisationId,
    ])
    if (summary?.tenant_id != null || fallback != null) return
    setOpening(false)
    setFailure('not-shown')
  }

  function refused(error: unknown) {
    if (!(error instanceof ApiProblem) || error.status >= 500) {
      // The outcome is unknown: the same key and body go again on the next press. A 503 is the
      // one server answer Core says stored nothing.
      if (error instanceof ApiProblem && error.type === `${PROBLEM}service-unavailable`) {
        forgetCreation(organisationId)
        setFailure('unavailable')
        return
      }
      setFailure('failed')
      return
    }
    if (error.type === `${PROBLEM}idempotency-key-in-flight`) {
      // The first request under this key is still being decided: the same one goes again.
      setFailure('failed')
      return
    }
    forgetCreation(organisationId)
    if (error.status === 403) {
      // No longer the owner: the page reads the membership again and shows what the role allows.
      // Still the owner after that read, the refusal is said.
      void router.invalidate()
      setFailure('failed')
      return
    }
    switch (error.type) {
      case `${PROBLEM}slug-taken`:
        refuseAddress({ reason: 'taken', suggestions: error.suggestions })
        return
      case `${PROBLEM}tenant-exists`:
        void showTenant()
        return
      case `${PROBLEM}billing-enabled`:
        // Billing came back on: the home reads the summary again and offers the order.
        void queryClient.invalidateQueries({ queryKey: statusSummaryQueryKey(organisationId) })
        return
      case `${PROBLEM}invalid-state-transition`:
        setFailure('not-ready')
        return
      case `${PROBLEM}validation-error`: {
        const codes = error.errors.map((entry) => entry.code)
        if (codes.includes('cgv_not_in_force') || codes.includes('dpa_not_in_force')) {
          void documents.refetch()
          setFailure('documents-changed')
          return
        }
        // The form sends only well-formed addresses, so Core refuses this one as reserved.
        if (error.errors.some((entry) => entry.pointer === '/slug')) {
          refuseAddress({ reason: 'reserved', suggestions: [] })
          return
        }
        if (error.errors.some((entry) => entry.pointer === '/name')) {
          setRefusedName(name)
          setNameTouched(true)
          return
        }
        setFailure('failed')
        return
      }
      default:
        setFailure('failed')
    }
  }

  const addressText = domain === undefined ? slug : `${slug}.${domain}`
  // A malformed address is the field's own error. One that cannot be had is said in the live
  // region below the address, open or not, with the free ones offered read out after it.
  const formatError = slugValid ? undefined : t('console.home.create.error-address-invalid')
  const unavailableError =
    !slugValid || unavailableReason === undefined
      ? undefined
      : unavailableReason === 'reserved'
        ? t('console.home.create.error-address-reserved')
        : t('console.home.create.error-address-taken')
  const addressStatus =
    slugValid && unavailableReason === undefined
      ? answer?.available === true
        ? t('console.home.create.status-address-free')
        : availability.isFetching || checkedSlug !== slug
          ? t('console.home.create.status-address-checking')
          : undefined
      : undefined

  return (
    <form
      className="flex max-w-shell-document-max-width flex-col gap-6"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="flex flex-col gap-2">
        <h1 className={PAGE_TITLE}>{t('console.home.create.title')}</h1>
        <p className="text-sm text-c-ink-2">{t('console.home.create.body')}</p>
      </div>

      <TextField
        label={t('console.home.create.label-name')}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setNameTouched(true)
        }}
        {...(nameTouched && currentNameError !== undefined
          ? { error: t(`console.home.create.error-name-${currentNameError}`) }
          : {})}
      />

      <div className="flex flex-col gap-2">
        {showAddressField ? (
          <TextField
            ref={addressRef}
            label={t('console.home.create.label-address')}
            value={slug}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => {
              setEditedSlug(event.target.value)
              setAddressOpen(true)
            }}
            help={`${t('console.home.create.hint-address-rule')} ${t('console.home.create.hint-address-final')}`}
            {...(domain === undefined ? {} : { suffix: `.${domain}` })}
            {...(formatError === undefined ? {} : { error: formatError })}
          />
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-c-ink">
              {t('console.home.create.label-address')}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm text-c-ink">{addressText}</span>
              <Button variant="tertiary" size="sm" aria-describedby={hintId} onClick={openAddress}>
                {t('console.home.create.action-edit-address')}
              </Button>
            </div>
            <span id={hintId} className="text-xs text-c-ink-3">
              {t('console.home.create.hint-address-final')}
            </span>
          </div>
        )}
        <p className="text-xs text-c-ink-3" role="status" aria-live="polite">
          {unavailableError === undefined ? (
            (addressStatus ?? '')
          ) : (
            <>
              <span className="text-c-bad-ink">{unavailableError}</span>
              {suggestions.length > 0 ? (
                <span className="sr-only">
                  {` ${t('console.home.create.a11y-address-suggestions', { slugs: suggestions.join(', ') })}`}
                </span>
              ) : null}
            </>
          )}
        </p>
        {unavailableReason !== undefined && suggestions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-c-ink-3">
              {t('console.home.create.label-suggestions')}
            </span>
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                variant="secondary"
                size="sm"
                aria-label={t('console.home.create.a11y-use-suggestion', { slug: suggestion })}
                onClick={() => applySuggestion(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {failure === undefined ? null : (
        <InlineAlert kind="error">{t(`console.home.create.error-${failure}`)}</InlineAlert>
      )}

      {documents.isLoading ? (
        <Skeleton label={t('console.common.a11y-loading')} className="h-12" />
      ) : documentsMissing ? (
        <div className="flex flex-col items-start gap-3">
          <InlineAlert kind="error">
            {t('console.home.create.error-documents-unavailable')}
          </InlineAlert>
          <Button variant="secondary" size="sm" onClick={() => void documents.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Button
            type="submit"
            className="self-start"
            disabled={!canSubmit}
            loading={busy || rereading}
          >
            {busy
              ? t('console.home.create.action-creating')
              : t('console.home.create.action-create')}
          </Button>
          <div className="flex flex-col gap-1 text-xs text-c-ink-3">
            <span>{t('console.home.create.label-documents')}</span>
            <ul className="flex flex-col gap-1">
              {[cgv, dpa].map((doc) =>
                doc === undefined ? null : (
                  <DocumentLink key={doc.code} doc={doc} describedBy={newTabId} />
                )
              )}
            </ul>
            <span id={newTabId} className="sr-only">
              {t('console.common.a11y-opens-new-tab')}
            </span>
          </div>
        </div>
      )}
    </form>
  )
}

function DocumentLink({ doc, describedBy }: { doc: LegalDocument; describedBy: string }) {
  const { t } = useTranslation()
  const label = t('console.home.create.label-document', { title: doc.title, version: doc.version })
  const href = legalHtmlHref(doc.html_url)
  return (
    <li>
      {href === undefined ? (
        label
      ) : (
        <a
          className={LINK_TEXT.inline}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={describedBy}
        >
          {label}
        </a>
      )}
    </li>
  )
}

export type SelfServePlanChoice = 'freemium' | 'sovereign'
type SelfServeFailure = 'unavailable' | 'failed' | 'rate-limit'

export function SelfServeCreateWorkspace({
  initialPlan = 'freemium',
  existingSovereignOrgSlug,
}: {
  initialPlan?: SelfServePlanChoice
  existingSovereignOrgSlug?: string | undefined
}) {
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const queryClient = useQueryClient()
  const hintId = useId()
  const [plan, setPlan] = useState<SelfServePlanChoice>(initialPlan)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [editedSlug, setEditedSlug] = useState<string | undefined>(undefined)
  const [addressOpen, setAddressOpen] = useState(false)
  const slug = editedSlug ?? deriveOrganisationSlug(name)
  const slugValid = isOrganisationSelfServeSlug(slug)
  const showAddressField = addressOpen || (name.trim().length > 0 && !slugValid)
  const addressRef = useRef<HTMLInputElement>(null)
  const idempotencyKeyRef = useRef<{ payload: string; key: string } | null>(null)
  const [refusals, setRefusals] = useState<Readonly<Record<string, Refusal>>>({})
  const [refusedName, setRefusedName] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<SelfServeFailure | undefined>(undefined)
  const [opening, setOpening] = useState(false)

  const selfServe = useCreateSelfServeWorkspaceMutation()
  const busy = selfServe.isPending || opening

  const currentNameError: NameError | undefined =
    refusedName === name
      ? 'characters'
      : name.trim().length === 0
        ? 'empty'
        : [...name].length > 120
          ? 'too-long'
          : FORBIDDEN_IN_NAME.test(name)
            ? 'characters'
            : undefined

  const refusedAtSubmit = Object.hasOwn(refusals, slug) ? refusals[slug] : undefined
  const unavailableReason: 'taken' | 'reserved' | undefined = refusedAtSubmit?.reason
  const suggestions = (refusedAtSubmit?.suggestions ?? []).slice(0, 3)

  const canUseExistingSovereignOrg =
    plan === 'sovereign' &&
    existingSovereignOrgSlug !== undefined &&
    name.trim().length === 0 &&
    editedSlug === undefined

  const canSubmit =
    canUseExistingSovereignOrg ||
    (currentNameError === undefined && slugValid && unavailableReason === undefined)

  function openAddress() {
    setAddressOpen(true)
    window.setTimeout(() => addressRef.current?.focus(), 0)
  }

  function applySuggestion(next: string) {
    setEditedSlug(next)
    openAddress()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (canUseExistingSovereignOrg && existingSovereignOrgSlug !== undefined) {
      setOpening(true)
      await router.navigate({
        to: '/$org/order',
        params: { org: existingSovereignOrgSlug },
        search: { pack: 'sovereign' },
      })
      return
    }
    setNameTouched(true)
    if (!canSubmit || busy) return
    const locale: 'fr' | 'en' = i18n.language.startsWith('en') ? 'en' : 'fr'
    const body = { name: name.trim(), slug, locale } as const
    const serialized = JSON.stringify(body)
    const key =
      idempotencyKeyRef.current?.payload === serialized ? idempotencyKeyRef.current.key : newKey()
    idempotencyKeyRef.current = { payload: serialized, key }
    setFailure(undefined)

    try {
      const created = await selfServe.mutateAsync({ body, idempotencyKey: key })
      idempotencyKeyRef.current = null
      setOpening(true)
      rememberSharedRealmSlug(created.organisation_slug)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['me'] }),
        appQueryClient.invalidateQueries({ queryKey: ['me'] }),
      ])
      if (plan === 'sovereign') {
        await router.navigate({
          to: '/$org/order',
          params: { org: created.organisation_slug },
          search: { pack: 'sovereign' },
        })
      } else {
        await router.navigate({
          to: '/$org/workspace',
          params: { org: created.organisation_slug },
        })
      }
    } catch (error) {
      setOpening(false)
      if (!(error instanceof ApiProblem) || error.status >= 500) {
        if (error instanceof ApiProblem && error.type === `${PROBLEM}service-unavailable`) {
          idempotencyKeyRef.current = null
          setFailure('unavailable')
          return
        }
        setFailure('failed')
        return
      }
      if (error.type === `${PROBLEM}idempotency-key-in-flight`) {
        setFailure('failed')
        return
      }
      idempotencyKeyRef.current = null
      if (error.status === 429 || error.type === `${PROBLEM}rate-limited`) {
        setFailure('rate-limit')
        return
      }
      if (error.type === `${PROBLEM}slug-taken`) {
        setRefusals((known) => ({
          ...known,
          [slug]: { reason: 'taken', suggestions: error.suggestions },
        }))
        openAddress()
        return
      }
      if (error.type === `${PROBLEM}validation-error`) {
        if (error.errors.some((entry) => entry.pointer === '/slug')) {
          setRefusals((known) => ({
            ...known,
            [slug]: { reason: 'reserved', suggestions: [] },
          }))
          openAddress()
          return
        }
        if (error.errors.some((entry) => entry.pointer === '/name')) {
          setRefusedName(name)
          setNameTouched(true)
          return
        }
      }
      setFailure('failed')
    }
  }

  const formatError =
    name.trim().length > 0 && !slugValid
      ? t('console.home.create.error-address-invalid')
      : undefined
  const unavailableError =
    !slugValid || unavailableReason === undefined
      ? undefined
      : unavailableReason === 'reserved'
        ? t('console.home.create.error-address-reserved')
        : t('console.home.create.error-address-taken')

  return (
    <form
      className="flex max-w-shell-document-max-width flex-col gap-6"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="flex flex-col gap-2">
        <h1 className={PAGE_TITLE}>{t('console.home.create.title')}</h1>
        <p className="text-sm text-c-ink-2">
          {plan === 'sovereign'
            ? t('console.home.create.sovereign-subtitle')
            : t('console.home.create.self-serve-subtitle')}
        </p>
      </div>

      <RadioGroup
        label={t('console.home.create.label-plan')}
        value={plan}
        onValueChange={(next) => setPlan(next as SelfServePlanChoice)}
        options={[
          { value: 'freemium', label: t('console.home.create.plan-freemium') },
          { value: 'sovereign', label: t('console.home.create.plan-sovereign') },
        ]}
      />

      <TextField
        label={t('console.home.create.label-name')}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setNameTouched(true)
        }}
        {...(nameTouched && currentNameError !== undefined
          ? { error: t(`console.home.create.error-name-${currentNameError}`) }
          : {})}
      />

      {slug.length > 0 || showAddressField ? (
        <div className="flex flex-col gap-2">
          {showAddressField ? (
            <TextField
              ref={addressRef}
              label={t('console.home.create.label-address')}
              value={slug}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                setEditedSlug(event.target.value)
                setAddressOpen(true)
              }}
              help={`${t('console.home.create.hint-org-slug-rule')} ${t('console.home.create.hint-address-final')}`}
              {...(formatError === undefined ? {} : { error: formatError })}
            />
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-c-ink">
                {t('console.home.create.label-address')}
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-c-ink">{`/${slug}/workspace`}</span>
                <Button
                  variant="tertiary"
                  size="sm"
                  aria-describedby={hintId}
                  onClick={openAddress}
                >
                  {t('console.home.create.action-edit-address')}
                </Button>
              </div>
              <span id={hintId} className="text-xs text-c-ink-3">
                {t('console.home.create.hint-address-final')}
              </span>
            </div>
          )}

          {unavailableError === undefined ? null : (
            <p className="text-xs text-c-bad-ink" role="status" aria-live="polite">
              {unavailableError}
            </p>
          )}
          {unavailableReason !== undefined && suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-c-ink-3">
                {t('console.home.create.label-suggestions')}
              </span>
              {suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="secondary"
                  size="sm"
                  aria-label={t('console.home.create.a11y-use-suggestion', { slug: suggestion })}
                  onClick={() => applySuggestion(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {failure === undefined ? null : (
        <InlineAlert kind="error">{t(`console.home.create.error-${failure}`)}</InlineAlert>
      )}

      <Button type="submit" className="self-start" disabled={!canSubmit} loading={busy}>
        {busy
          ? t('console.home.create.action-creating')
          : plan === 'sovereign'
            ? t('console.home.create.action-continue-sovereign')
            : t('console.home.create.action-create-free')}
      </Button>
    </form>
  )
}

// docs/specs/03-people.md §4.4: on-site enrolment. The owner creates a number
// of places, prints one sheet with a code to scan and a code to type, and
// pins it in the site hut. The secret behind a sheet comes back once, on
// creation (contract `EnrolmentTokenCreated`), so it lives in this
// component's state only: never in storage, never in a log, gone on reload.

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../../api/client'
import { mutate } from '../../api/mutations'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import type { Locale } from '../../i18n/format'
import { formatTime } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Card, CardBody } from '../../ui/Card/Card'
import { ConfirmDestructive } from '../../ui/ConfirmDestructive/ConfirmDestructive'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { QrPanel } from '../../ui/QrPanel/QrPanel'
import { Skeleton } from '../../ui/Skeleton/Skeleton'
import { TextField } from '../../ui/TextField/TextField'
import { useLocale } from '../invoices/useLocale'
import {
  trackEnrolmentClaimedView,
  trackEnrolmentCreated,
  trackEnrolmentPrinted,
} from './analytics'
import {
  useEnrolmentTokensQuery,
  useInvalidatePeople,
  type EnrolmentToken,
  type EnrolmentTokenCreated,
} from './queries'
import type { OrganisationRole } from './roles'

/** §8 "Enrolment count": an integer from 1 to 200, checked on blur. */
const COUNT_MIN = 1
const COUNT_MAX = 200
const DEFAULT_COUNT = '12'

/** `EnrolmentTokenCreateRequest.expires_at`: at most 24 hours ahead. */
const LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * Print isolation (§4.4 "one page"): for the sheet's print only, the body hides
 * every direct child but the sheet's own portal, so the shell, the navigation
 * and the rest of this panel never reach the paper. Literal class strings, so
 * Tailwind's content scan generates them.
 */
const PRINT_ISOLATION = ['print:[&>*]:hidden', 'print:[&>[data-print-sheet]]:block']

/**
 * Adds the isolation classes the body does not already carry and returns the
 * undo, which removes only those. The undo runs on `afterprint` and again
 * once `window.print()` returns, whichever comes first; a page printed at any
 * other time prints as it is.
 */
function isolatePrint(): () => void {
  const added = PRINT_ISOLATION.filter((name) => !document.body.classList.contains(name))
  document.body.classList.add(...added)
  let restored = false
  function restore() {
    if (restored) return
    restored = true
    window.removeEventListener('afterprint', restore)
    document.body.classList.remove(...added)
  }
  window.addEventListener('afterprint', restore)
  return restore
}

function parseCount(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const count = Number(trimmed)
  return count >= COUNT_MIN && count <= COUNT_MAX ? count : null
}

// A sheet's expiry is a full timestamp, so its date is read in Europe/Paris
// like its time: `formatDate` formats in UTC (it is for calendar dates), which
// would print the previous day for a sheet expiring just after midnight.
function formatParisDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'fr-FR', {
    dateStyle: 'long',
    timeZone: 'Europe/Paris',
  }).format(new Date(iso))
}

function createEnrolmentToken(
  organisationId: string,
  maxUses: number,
  expiresAt: string,
  idempotencyKey: string
) {
  return mutate(
    { method: 'post', path: '/organisations/{organisation_id}/enrolment-tokens' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      // A shared token only ever grants `org_member` (contract, ADR-0010).
      body: { role: 'org_member', max_uses: maxUses, expires_at: expiresAt },
    }
  )
}

function revokeEnrolmentToken(organisationId: string, tokenId: string) {
  return mutate(
    {
      method: 'delete',
      path: '/organisations/{organisation_id}/enrolment-tokens/{enrolment_token_id}',
    },
    { params: { path: { organisation_id: organisationId, enrolment_token_id: tokenId } } }
  )
}

export interface OnSitePanelProps {
  organisationId: string
  organisationName: string
  /** Only `org_owner` and `org_admin` reach this panel; the route guards it. */
  callerRole: OrganisationRole
}

export function OnSitePanel({ organisationId, organisationName }: OnSitePanelProps) {
  const { t } = useTranslation()
  const locale = useLocale()
  const online = useOnlineStatus()
  const invalidate = useInvalidatePeople(organisationId)
  const tokens = useEnrolmentTokensQuery(organisationId)
  const howId = useId()
  const activeId = useId()

  const [countText, setCountText] = useState(DEFAULT_COUNT)
  const [countError, setCountError] = useState(false)
  const [lastValid, setLastValid] = useState(Number(DEFAULT_COUNT))
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)
  // One key per intent: a retry of the same count after a failure that may
  // have reached the server reuses the key and the expiry, so it cannot
  // create a second sheet.
  const attempt = useRef<{ count: number; key: string; expiresAt: string } | null>(null)

  /** The one-time secrets of the sheets created in this session, by token id. */
  const [created, setCreated] = useState<Record<string, EnrolmentTokenCreated>>({})
  const [shownId, setShownId] = useState<string | null>(null)
  const shown = shownId === null ? undefined : created[shownId]

  const [deactivating, setDeactivating] = useState<EnrolmentToken | null>(null)
  const [deactivateError, setDeactivateError] = useState<'expired' | 'failed' | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  // §11: one claimed-view event per sheet listed, not per render.
  const viewed = useRef(new Set<string>())
  useEffect(() => {
    for (const token of tokens.data ?? []) {
      if (viewed.current.has(token.id)) continue
      viewed.current.add(token.id)
      trackEnrolmentClaimedView(token.uses, token.max_uses)
    }
  }, [tokens.data])

  function validate(raw: string): number | null {
    const count = parseCount(raw)
    setCountError(count === null)
    if (count !== null) setLastValid(count)
    return count
  }

  async function create() {
    const count = validate(countText)
    if (count === null) return
    if (attempt.current?.count !== count) {
      attempt.current = {
        count,
        key: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + LIFETIME_MS).toISOString(),
      }
    }
    setCreateFailed(false)
    setCreating(true)
    try {
      const token = await createEnrolmentToken(
        organisationId,
        count,
        attempt.current.expiresAt,
        attempt.current.key
      )
      attempt.current = null
      setCreated((previous) => ({ ...previous, [token.id]: token }))
      setShownId(token.id)
      trackEnrolmentCreated(count)
      await invalidate()
    } catch {
      setCreateFailed(true)
    } finally {
      setCreating(false)
    }
  }

  function print(tokenId: string) {
    // The print portal must hold this sheet before the dialog opens.
    flushSync(() => setShownId(tokenId))
    trackEnrolmentPrinted()
    const restore = isolatePrint()
    try {
      window.print()
    } finally {
      restore()
    }
  }

  async function deactivate(token: EnrolmentToken) {
    setDeactivateError(null)
    try {
      await revokeEnrolmentToken(organisationId, token.id)
      if (shownId === token.id) setShownId(null)
      setCreated(({ [token.id]: _dropped, ...rest }) => rest)
      await invalidate()
    } catch (failure) {
      // §9: a conflict on a token means it is no longer active.
      setDeactivateError(
        failure instanceof ApiProblem && failure.type === 'https://kodera.io/problems/conflict'
          ? 'expired'
          : 'failed'
      )
    }
  }

  const parsed = parseCount(countText)
  const createLabel = t('console.people.on-site.action-create', { count: parsed ?? lastValid })
  const list = tokens.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-c-ink">{t('console.people.on-site.title')}</h2>
        <p className="text-sm text-c-ink-2">{t('console.people.on-site.subtitle')}</p>
      </header>

      <section aria-labelledby={howId} className="flex flex-col gap-2">
        <h3 id={howId} className="text-md font-semibold text-c-ink">
          {t('console.people.on-site.title-how')}
        </h3>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-c-ink">
          <li>{t('console.people.on-site.hint-step1')}</li>
          <li>{t('console.people.on-site.hint-step2')}</li>
          <li>{t('console.people.on-site.hint-step3')}</li>
          <li>{t('console.people.on-site.hint-step4')}</li>
        </ol>
      </section>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <div className="flex flex-wrap items-start gap-6">
          <TextField
            label={t('console.people.on-site.label-count')}
            inputMode="numeric"
            value={countText}
            onChange={(event) => {
              setCountText(event.target.value)
              setCountError(false)
            }}
            onBlur={(event) => void validate(event.target.value)}
            {...(countError ? { error: t('console.people.on-site.error-count-range') } : {})}
          />
          <p className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-c-ink">{t('console.people.invite.label-role')}</span>
            <span className="text-c-ink-2">{t('console.people.invite.label-role-member')}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={creating} disabled={!online}>
            {createLabel}
          </Button>
          {online ? null : (
            <span className="text-xs text-c-ink-3">{t('console.common.error-offline')}</span>
          )}
        </div>
        {createFailed ? (
          <div className="flex flex-col items-start gap-2">
            <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
            <Button variant="secondary" disabled={!online} onClick={() => void create()}>
              {t('console.common.action-retry')}
            </Button>
          </div>
        ) : null}
      </form>

      {shown === undefined ? null : (
        <SheetCard sheet={shown} organisationName={organisationName} onPrint={print} />
      )}

      {deactivateError === null ? null : (
        <InlineAlert kind="error">
          {t(
            deactivateError === 'expired'
              ? 'console.people.on-site.error-token-expired'
              : 'console.common.error-unavailable'
          )}
        </InlineAlert>
      )}

      {tokens.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton label={t('console.common.a11y-loading')} />
          <Skeleton />
        </div>
      ) : tokens.isError ? (
        <div className="flex flex-col items-start gap-2">
          <InlineAlert kind="error">{t('console.common.error-unavailable')}</InlineAlert>
          <Button variant="secondary" onClick={() => void tokens.refetch()}>
            {t('console.common.action-retry')}
          </Button>
        </div>
      ) : list.length === 0 ? (
        shown === undefined ? (
          <p className="text-sm text-c-ink-2">{t('console.people.on-site.empty-body')}</p>
        ) : null
      ) : (
        <section aria-labelledby={activeId} className="flex flex-col gap-3">
          <h3 id={activeId} className="text-md font-semibold text-c-ink">
            {t('console.people.on-site.title-active')}
          </h3>
          <ul className="flex flex-col gap-3">
            {list.map((token) => {
              const mine = created[token.id] !== undefined
              return (
                <li
                  key={token.id}
                  className="flex flex-col gap-3 rounded-md border border-c-border p-4"
                >
                  <p className="text-sm text-c-ink">
                    {t('console.people.on-site.status-sheet', {
                      count: token.max_uses,
                      used: token.uses,
                      date: formatParisDate(token.expires_at, locale),
                      time: formatTime(token.expires_at, locale),
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {mine ? (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => print(token.id)}>
                          {t('console.people.on-site.action-print')}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setShownId(token.id)}>
                          {t('console.people.on-site.action-show-code')}
                        </Button>
                      </>
                    ) : null}
                    <Button
                      variant="tertiary"
                      size="sm"
                      disabled={!online}
                      onClick={(event) => {
                        opener.current = event.currentTarget
                        setDeactivateError(null)
                        setDeactivating(token)
                      }}
                    >
                      {t('console.people.on-site.action-deactivate')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
          {list.some((token) => created[token.id] === undefined) ? (
            <p className="text-xs text-c-ink-3">{t('console.people.on-site.hint-code-once')}</p>
          ) : null}
        </section>
      )}

      {deactivating === null ? null : (
        <ConfirmDestructive
          defaultOpen
          initialFocus="title"
          returnFocusTo={opener}
          onOpenChange={(open) => (open ? undefined : setDeactivating(null))}
          title={t('console.people.on-site.confirm-deactivate-title')}
          consequence={t('console.people.on-site.confirm-deactivate-body', {
            remaining: Math.max(deactivating.max_uses - deactivating.uses, 0),
          })}
          confirmLabel={t('console.people.on-site.action-deactivate')}
          cancelLabel={t('console.common.action-cancel')}
          closeLabel={t('console.common.action-close')}
          onConfirm={() => void deactivate(deactivating)}
        />
      )}
    </div>
  )
}

interface SheetCardProps {
  sheet: EnrolmentTokenCreated
  organisationName: string
  onPrint: (tokenId: string) => void
}

/**
 * The sheet just created, on screen, and its print twin in a body portal.
 * The QR is encoded client-side by `QrPanel` from `enrolment_url` (what the
 * contract says `qr_svg` encodes), so no server markup is ever injected into
 * the page; a response without `qr_svg` is the §5 partial failure and shows
 * the short code alone, with the alert (§12 test 12).
 */
function SheetCard({ sheet, organisationName, onPrint }: SheetCardProps) {
  const { t } = useTranslation()
  const locale = useLocale()
  const titleId = useId()
  const [copied, setCopied] = useState<'code' | 'address' | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // `qr_svg` is required by the contract; its absence is the failure the
  // `people.enrolment-qr-failed` overlay simulates.
  const qrAvailable = typeof sheet.qr_svg === 'string' && sheet.qr_svg !== ''
  const code = sheet.secret
  const url = sheet.enrolment_url
  const title = t('console.people.on-site.title-sheet', { organisation: organisationName })
  const alt = t('console.people.on-site.a11y-qr', { code })
  const validity = t('console.people.on-site.hint-sheet-validity', {
    date: formatParisDate(sheet.expires_at, locale),
    time: formatTime(sheet.expires_at, locale),
  })

  function copy(which: 'code' | 'address', value: string) {
    window.clearTimeout(timer.current)
    // The value stays visible as text; the button is a shortcut, so a
    // refused clipboard needs no message of its own.
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(which)
        timer.current = window.setTimeout(() => setCopied(null), 1500)
      },
      () => undefined
    )
  }

  const copyProps = {
    copyLabel: t('console.common.action-copy'),
    copiedLabel: t('console.common.toast-copied'),
  }

  return (
    <>
      <Card>
        <CardBody>
          <section aria-labelledby={titleId} className="flex flex-col gap-4">
            <h3 id={titleId} className="text-md font-semibold text-c-ink">
              {title}
            </h3>
            {qrAvailable ? null : (
              <InlineAlert kind="error">
                {t('console.people.on-site.error-qr-unavailable')}
              </InlineAlert>
            )}
            <QrPanel
              value={qrAvailable ? url : ''}
              alt={alt}
              failureMessage={t('console.people.on-site.status-qr-unavailable')}
              code={{
                ...copyProps,
                label: t('console.people.on-site.label-code'),
                value: code,
                status: copied === 'code' ? 'copied' : 'idle',
                onCopy: () => copy('code', code),
              }}
            />
            <CopyableField
              {...copyProps}
              label={t('console.people.on-site.label-address')}
              value={url}
              status={copied === 'address' ? 'copied' : 'idle'}
              onCopy={() => copy('address', url)}
            />
            <p className="text-sm text-c-ink-2">{validity}</p>
            <div>
              <Button onClick={() => onPrint(sheet.id)}>
                {t('console.people.on-site.action-print')}
              </Button>
            </div>
          </section>
        </CardBody>
      </Card>
      {createPortal(
        // Hidden on screen and from assistive technology (the card above is
        // the accessible copy); the only thing on the paper when printing.
        <div data-print-sheet aria-hidden="true" className="hidden print:block">
          <div className="flex break-inside-avoid flex-col items-center gap-6 p-8 text-center text-c-ink">
            <p className="text-2xl font-semibold">{title}</p>
            {qrAvailable ? (
              // The code is printed in full below, so the panel's own copy
              // row (a control, useless on paper) is dropped from the print.
              <QrPanel
                value={url}
                alt={alt}
                size="lg"
                failureMessage={t('console.people.on-site.status-qr-unavailable')}
                className="[&>div:last-child]:hidden"
                code={{
                  ...copyProps,
                  label: t('console.people.on-site.label-code'),
                  value: code,
                  status: 'idle',
                  onCopy: () => undefined,
                }}
              />
            ) : null}
            <p className="font-mono text-md">
              {t('console.people.on-site.hint-sheet-manual', { url, code })}
            </p>
            <p className="text-md">{validity}</p>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

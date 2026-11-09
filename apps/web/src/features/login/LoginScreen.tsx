// `login` — realm discovery (docs/specs/00-shell-and-login.md §4.1) and
// `login-organisation` (§4.2): the first question is always the email
// address (§2's "alone test"), the organisation identifier is the fallback
// a person reaches only after their domain fails to resolve or by choice,
// and a domain shared by several organisations hands the choice to
// `OrganisationChoice`. `login-handoff` (§4.3) is the last view, once a
// realm is resolved — none of the three has a URL of its own (§3 names none
// for any of them), so they are views this one route swaps between rather
// than three routes.

import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { trackDiscoveryFailed, trackDiscoverySubmitted, trackOrganisationChosen } from './analytics'
import { ApiProblem, NetworkError } from '../../api/client'
import { problemSuffix } from '../../api/problemSuffix'
import { isDemoActive } from '../../app/interactiveDemo'
import { useOnlineStatus } from '../../app/useOnlineStatus'
import { Banner } from '../../ui/Banner/Banner'
import { Button } from '../../ui/Button/Button'
import { ButtonGroup } from '../../ui/ButtonGroup/ButtonGroup'
import { Card, CardBody } from '../../ui/Card/Card'
import { Form } from '../../ui/Form/Form'
import { FormField } from '../../ui/Form/FormField'
import { KoderaMark } from '../../ui/icons/KoderaMark'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import {
  emailDomain,
  emailRefusal,
  isSlugFormatValid,
  normalizeEmail,
  normalizeSlug,
  rateLimitWaitSeconds,
  unavailableWaitSeconds,
} from './discovery'
import type { EmailRefusal } from './discovery'
import { Handoff } from './Handoff'
import { OrganisationChoice } from './OrganisationChoice'
import type { RealmDiscoveryResult } from './useDiscoverRealm'
import { useDiscoverRealm } from './useDiscoverRealm'
import { SUPPORT_EMAIL } from '../../app/supportContact'

type Candidate = RealmDiscoveryResult['candidates'][number]

type View =
  | { kind: 'email' }
  // `notice` is what the e-mail step found out — no organisation uses that
  // domain — carried to the identifier step as the reason it is on screen.
  | { kind: 'slug'; notice?: string; prefillEmail?: string }
  | { kind: 'organisation'; candidates: Candidate[] }
  | { kind: 'handoff'; realm: string; organisationName: string }

interface EmailFormValues {
  email: string
}

interface SlugFormValues {
  slug: string
}

export interface LoginScreenProps {
  /** From `?org={slug}` (§3): pre-fills the organisation-identifier field
   * for a link sent from the welcome email or the hub's "Se connecter". */
  initialSlug?: string
}

/** Why the screen is counting a wait down: too many attempts (`429`), or
 * discovery itself unavailable (`503`). Each has its own sentence. */
type WaitReason = 'rate-limited' | 'unavailable'

/** What a discovery attempt that did not resolve leaves on screen: a sentence,
 * or a wait the screen counts down (§9, `rate-limited` and
 * `service-unavailable`). `seconds` is a whole number, one or more. */
type Outcome =
  { kind: 'message'; text: string } | { kind: 'wait'; reason: WaitReason; seconds: number }

/**
 * What a `429` leaves on screen (§9): a countdown of `rateLimitWaitSeconds`, or — when there is
 * nothing to count down — a sentence saying the person was refused and may try again at once: a
 * countdown from zero draws nothing, and the refusal would be silent.
 */
function outcomeOfRateLimit(retryAfterS: number | undefined, t: TFunction): Outcome {
  const seconds = rateLimitWaitSeconds(retryAfterS)
  return seconds > 0
    ? { kind: 'wait', reason: 'rate-limited', seconds }
    : { kind: 'message', text: t('console.login.realm.error-rate-limited-no-wait') }
}

/** What a `503` from discovery leaves on screen (§9): its own wait, between the contract's five
 * seconds and `DISCOVERY_WAIT_CAP_S`. */
function outcomeOfUnavailable(retryAfterS: number | undefined): Outcome {
  return { kind: 'wait', reason: 'unavailable', seconds: unavailableWaitSeconds(retryAfterS) }
}

/** `ApiProblem` / `NetworkError` outcomes common to both the email and the
 * slug submission, or `undefined` when the caller (the offline banner)
 * already says enough. */
function outcomeOfFailure(
  error: unknown,
  kind: 'email' | 'slug',
  t: TFunction
): Outcome | undefined {
  if (
    error instanceof ApiProblem &&
    error.type !== null &&
    problemSuffix(error.type) === 'rate-limited'
  ) {
    trackDiscoveryFailed(kind, 'rate-limited')
    return outcomeOfRateLimit(error.retryAfterS, t)
  }
  if (
    error instanceof ApiProblem &&
    error.type !== null &&
    problemSuffix(error.type) === 'service-unavailable'
  ) {
    return outcomeOfUnavailable(error.retryAfterS)
  }
  if (error instanceof NetworkError) return undefined
  return { kind: 'message', text: t('console.common.error-unavailable') }
}

/**
 * The wait a rate limit imposes, counted down from `retry_after_s` (§9). Read
 * off a deadline, not decremented: a tab whose timers were throttled shows
 * the time that is really left when it comes back.
 */
function useRetryCountdown() {
  const [wait, setWait] = useState<
    { total: number; until: number; reason: WaitReason } | undefined
  >(undefined)
  const [now, setNow] = useState(() => Date.now())
  const deadline = useRef(0)
  const [completed, setCompleted] = useState(false)

  useEffect(() => {
    if (wait === undefined) return
    const timer = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= wait.until) {
        window.clearInterval(timer)
        setCompleted(true)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [wait])

  const secondsLeft = wait === undefined ? 0 : Math.max(0, Math.ceil((wait.until - now) / 1000))
  return {
    /** `0` when there is nothing to wait for. */
    secondsLeft,
    total: wait?.total ?? 0,
    /** What the wait is for; the sentence that counts it down depends on it. */
    reason: wait?.reason ?? 'rate-limited',
    completed,
    isWaiting: () => Date.now() < deadline.current,
    start(seconds: number, reason: WaitReason) {
      const at = Date.now()
      const requested = at + seconds * 1000
      // A later refusal never shortens the wait, and the sentence stays the one
      // that belongs to the deadline still in force.
      const later = requested > deadline.current
      const until = later ? requested : deadline.current
      deadline.current = until
      setNow(at)
      setCompleted(false)
      setWait((current) => ({
        total: Math.ceil((until - at) / 1000),
        until,
        reason: later || current === undefined ? reason : current.reason,
      }))
    },
  }
}

/**
 * The rate-limit sentence, counting down. It is an `alert` for as long as it
 * says what it said when it appeared, which is how it is announced once; from
 * its first tick it is plain text, so the countdown is read by whoever looks
 * at it and announced to nobody every second (§10 holds the session countdown
 * to the same rule).
 */
function RetryNotice({
  secondsLeft,
  total,
  reason,
}: {
  secondsLeft: number
  total: number
  reason: WaitReason
}) {
  const { t } = useTranslation()
  if (secondsLeft === 0) return null
  if (reason === 'unavailable') {
    // Seconds only: the wait is five seconds, and never more than `DISCOVERY_WAIT_CAP_S`.
    return (
      <InlineAlert kind="error" inLiveRegion={secondsLeft !== total}>
        {t('console.login.realm.error-unavailable', { count: secondsLeft })}
      </InlineAlert>
    )
  }
  const key =
    secondsLeft >= 3600
      ? 'console.login.realm.error-rate-limited-hours'
      : secondsLeft >= 60
        ? 'console.login.realm.error-rate-limited-minutes'
        : 'console.login.realm.error-rate-limited'
  const count = Math.ceil(secondsLeft / (secondsLeft >= 3600 ? 3600 : secondsLeft >= 60 ? 60 : 1))
  return (
    <InlineAlert kind="error" inLiveRegion={secondsLeft !== total}>
      {t(key, { count })}
    </InlineAlert>
  )
}

export function LoginScreen({
  initialSlug = isDemoActive('community') ? 'community' : undefined,
}: LoginScreenProps) {
  const { t, i18n } = useTranslation()
  const discover = useDiscoverRealm()
  const online = useOnlineStatus()
  const [view, setView] = useState<View>(
    initialSlug !== undefined ? { kind: 'slug' } : { kind: 'email' }
  )
  // Kept outside `view` so it survives every view swap, including the
  // email → slug → email round trip acceptance test 2 exercises.
  const [savedEmail, setSavedEmail] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const retry = useRetryCountdown()
  const emailInputRef = useRef<HTMLInputElement | null>(null)

  // §10: "The email field takes focus on mount." Re-runs whenever the email
  // view is (re-)mounted, including the "Utiliser une adresse e-mail" trip
  // back from the slug view.
  useEffect(() => {
    if (view.kind === 'email') emailInputRef.current?.focus()
  }, [view.kind])

  /** Where a discovery answer leads: another view, or — for an identifier no
   * organisation has — the sentence to show beside the field it was typed in,
   * which keeps what was typed. */
  function resolveResult(
    result: RealmDiscoveryResult,
    kind: 'email' | 'slug',
    submittedValue: string
  ): Outcome | undefined {
    if (result.realm !== null && result.realm !== undefined) {
      setView({
        kind: 'handoff',
        realm: result.realm,
        organisationName: result.organisation?.name ?? submittedValue,
      })
      return undefined
    }
    if (result.candidates.length >= 2) {
      setView({ kind: 'organisation', candidates: result.candidates })
      return undefined
    }
    // §6: an unknown slug and an unknown domain both answer `200` with
    // `realm: null` and an empty `candidates[]` — the console never learns
    // which one failed, and shows the same neutral message either way.
    trackDiscoveryFailed(kind, kind === 'email' ? 'domain-unknown' : 'slug-unknown')
    if (kind === 'slug') {
      return { kind: 'message', text: t('console.login.realm.error-slug-unknown') }
    }
    setView({
      kind: 'slug',
      notice: t('console.login.realm.error-domain-unknown', {
        domain: emailDomain(submittedValue),
      }),
      prefillEmail: submittedValue,
    })
    return undefined
  }

  /** Shows what a failed attempt left, on the e-mail step. */
  function showEmailOutcome(outcome: Outcome | undefined) {
    if (outcome?.kind === 'wait') {
      retry.start(outcome.seconds, outcome.reason)
      // The button is about to be disabled; focus must not be left on it.
      emailInputRef.current?.focus()
    } else {
      setEmailError(outcome?.text)
    }
  }

  // Each refusal's sentence (§8). `emailRefusal` judges the address `onSubmitEmail` will send,
  // normalised, so what is checked is what is sent.
  const EMAIL_REFUSAL_MESSAGE: Record<EmailRefusal, string> = {
    required: t('console.login.realm.error-email-required'),
    incomplete: t('console.login.realm.error-email-format'),
    refused: t('console.login.realm.error-email-invalid'),
  }
  const emailSchema = z.object({
    email: z.string().superRefine((raw, ctx) => {
      const refusal = emailRefusal(raw)
      if (refusal !== undefined) {
        ctx.addIssue({ code: 'custom', message: EMAIL_REFUSAL_MESSAGE[refusal] })
      }
    }),
  })

  async function onSubmitEmail(values: EmailFormValues) {
    if (retry.isWaiting()) return
    setEmailError(undefined)
    const email = normalizeEmail(values.email)
    setSavedEmail(email)
    trackDiscoverySubmitted('email')
    try {
      const result = await discover.mutateAsync({ email })
      showEmailOutcome(resolveResult(result, 'email', email))
    } catch (error) {
      showEmailOutcome(outcomeOfFailure(error, 'email', t))
    }
  }

  if (view.kind === 'handoff') {
    return <Handoff realm={view.realm} organisationName={view.organisationName} />
  }

  if (view.kind === 'organisation') {
    return (
      <OrganisationChoice
        candidates={view.candidates}
        onChoose={(candidate) => {
          trackOrganisationChosen(view.candidates.length)
          setView({
            kind: 'handoff',
            realm: candidate.realm,
            organisationName: candidate.organisation.name,
          })
        }}
        onBack={() => setView({ kind: 'email' })}
      />
    )
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 narrow:p-4">
      <a
        href="#login-form"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-4 focus-visible:left-4 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-c-elevated focus-visible:px-4 focus-visible:py-2 focus-visible:text-c-ink focus-visible:shadow-pop focus-visible:ring focus-visible:shadow-c-shadow-2 focus-visible:outline-hidden"
      >
        {t('console.shell.nav.action-skip-to-content')}
      </a>

      {/* The product's mark and name (§4.1 "[ Kodera ]"), the mark drawn as the
          narrow top bar draws it: `currentColor`, so the ink follows the theme.
          The name is its own key, not the tab title's, so a per-screen title
          never renames the product here. Decoration — the card's h1 names the
          page. */}
      <p className="flex items-center gap-2 text-lg font-semibold text-c-ink" aria-hidden="true">
        <KoderaMark className="h-5 w-auto shrink-0" />
        {t('console.common.product-name')}
      </p>

      {online ? null : (
        <Banner
          kind="incident"
          headline={t('console.common.error-offline')}
          className="w-full max-w-[420px]"
        />
      )}

      <Card className="w-full max-w-[420px]" id="login-form">
        <CardBody className="flex flex-col gap-4">
          <ButtonGroup aria-label={t('console.shell.account.action-language')} attached>
            <Button
              type="button"
              variant={i18n.language === 'fr' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => void i18n.changeLanguage('fr')}
            >
              FR
            </Button>
            <Button
              type="button"
              variant={i18n.language === 'en' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => void i18n.changeLanguage('en')}
            >
              EN
            </Button>
          </ButtonGroup>

          <RetryNotice secondsLeft={retry.secondsLeft} total={retry.total} reason={retry.reason} />
          <p className="sr-only" role="status" aria-live="polite">
            {retry.completed ? t('console.login.realm.a11y-retry-ready') : ''}
          </p>

          {view.kind === 'email' ? (
            <>
              <div>
                <h1 className="text-xl font-semibold text-c-ink">
                  {t('console.login.realm.title')}
                </h1>
                <p className="mt-1 text-md text-c-ink-3">{t('console.login.realm.subtitle')}</p>
              </div>

              <Form<EmailFormValues>
                schema={emailSchema}
                defaultValues={{ email: savedEmail }}
                mode="onSubmit"
                onSubmit={onSubmitEmail}
              >
                <FormField
                  name="email"
                  label={t('console.login.realm.label-email')}
                  placeholder={t('console.login.realm.placeholder-email')}
                  ref={emailInputRef}
                />
                {emailError === undefined ? null : (
                  <InlineAlert kind="error">{emailError}</InlineAlert>
                )}
                <Button
                  type="submit"
                  loading={discover.isPending}
                  disabled={!online || retry.secondsLeft > 0}
                  className="w-full"
                >
                  {t('console.login.realm.action-continue')}
                </Button>
              </Form>

              <Button
                variant="tertiary"
                onClick={() => setView({ kind: 'slug', prefillEmail: savedEmail })}
              >
                {t('console.login.realm.action-use-slug')}
              </Button>
            </>
          ) : (
            <SlugView
              initialSlug={initialSlug}
              notice={view.notice}
              prefillEmail={view.prefillEmail}
              online={online}
              pending={discover.isPending}
              retry={retry}
              onBack={(email) => {
                setSavedEmail(email ?? savedEmail)
                setView({ kind: 'email' })
              }}
              onSubmit={async (rawSlug) => {
                if (retry.isWaiting()) return undefined
                trackDiscoverySubmitted('slug')
                try {
                  const result = await discover.mutateAsync({ slug: rawSlug })
                  return resolveResult(result, 'slug', rawSlug)
                } catch (error) {
                  return outcomeOfFailure(error, 'slug', t)
                }
              }}
            />
          )}

          <div className="flex items-center justify-between border-t border-c-border-soft pt-4 text-sm">
            <LinkButton variant="tertiary" size="sm" href={`mailto:${SUPPORT_EMAIL}`}>
              {t('console.login.realm.action-help')}
            </LinkButton>
          </div>
        </CardBody>
      </Card>
    </main>
  )
}

interface SlugViewProps {
  initialSlug?: string | undefined
  /** Why the person is on this step when they did not choose it: what the
   * e-mail step found. Shown above the field — it is about the address, not
   * about the identifier — until the identifier is submitted. */
  notice?: string | undefined
  prefillEmail?: string | undefined
  online: boolean
  pending: boolean
  retry: ReturnType<typeof useRetryCountdown>
  onBack: (email?: string) => void
  onSubmit: (slug: string) => Promise<Outcome | undefined>
}

function SlugView({
  initialSlug,
  notice,
  prefillEmail,
  online,
  pending,
  retry,
  onBack,
  onSubmit,
}: SlugViewProps) {
  const { t } = useTranslation()
  const [shownNotice, setShownNotice] = useState(notice)
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const slugInputRef = useRef<HTMLInputElement | null>(null)

  // Same reasoning as the email field's own focus effect in `LoginScreen`:
  // this view mounts either by user choice or right after a domain-unknown
  // error, and either way the field is the next thing to act on.
  useEffect(() => {
    slugInputRef.current?.focus()
  }, [])

  const slugSchema = z.object({
    slug: z
      .string()
      .trim()
      .transform(normalizeSlug)
      .refine(isSlugFormatValid, { message: t('console.login.realm.error-slug-format') }),
  })

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold text-c-ink">{t('console.login.realm.title')}</h1>
        <p className="mt-1 text-md text-c-ink-3">{t('console.login.realm.subtitle-slug')}</p>
      </div>

      {shownNotice === undefined ? null : <InlineAlert kind="error">{shownNotice}</InlineAlert>}

      <Form<SlugFormValues>
        schema={slugSchema}
        defaultValues={{ slug: initialSlug ?? '' }}
        mode="onBlur"
        onSubmit={async (values) => {
          if (retry.isWaiting()) return
          setShownNotice(undefined)
          setSubmitError(undefined)
          const outcome = await onSubmit(values.slug)
          if (outcome?.kind === 'wait') {
            retry.start(outcome.seconds, outcome.reason)
            // The button is about to be disabled; focus must not be left on it.
            slugInputRef.current?.focus()
          } else {
            setSubmitError(outcome?.text)
          }
        }}
      >
        <FormField
          name="slug"
          label={t('console.login.realm.label-slug')}
          placeholder={t('console.login.realm.placeholder-slug')}
          help={t('console.login.realm.hint-slug')}
          ref={slugInputRef}
        />
        {submitError === undefined ? null : <InlineAlert kind="error">{submitError}</InlineAlert>}
        <Button
          type="submit"
          loading={pending}
          disabled={!online || retry.secondsLeft > 0}
          className="w-full"
        >
          {t('console.login.realm.action-continue')}
        </Button>
      </Form>

      <Button
        variant="tertiary"
        onMouseDown={(event) => {
          // Keep blur validation from moving this action between press and click.
          if (event.button === 0) event.preventDefault()
        }}
        onClick={() => onBack(prefillEmail)}
      >
        {t('console.login.realm.action-use-email')}
      </Button>
    </>
  )
}

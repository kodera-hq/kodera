// `/{org}/help` — the interim Aide page (docs/specs/06-support.md §4.0).
//
// Laid out as the delivered design's Réglages › Instance › Assistance pane:
// one line of introduction, then a card to write to the team beside a card of
// what else can help. What the page carries is only what is true without a
// support write path being served: the one support address
// (`src/app/supportContact.ts`) as text, copyable, and as a pre-written
// e-mail; what to put in the message; and links to screens that exist. No
// ticket form, no response time and no business hours: the ticket endpoint is
// declared in the contract but not served, and the team answers the address
// with no time commitment (owner ruling 2026-09-24).

import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orgRoute } from '../../app/org-route'
import { SUPPORT_EMAIL } from '../../app/supportContact'
import { Card } from '../../ui/Card/Card'
import { CopyableField } from '../../ui/CopyableField/CopyableField'
import type { CopyStatus } from '../../ui/CopyableField/CopyableField'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { LinkButton } from '../../ui/LinkButton/LinkButton'
import { canViewInvoices } from '../invoices/permissions'
import { helpTopic } from './helpTopic'
import type { HelpSearch } from './helpTopic'

export interface HelpScreenProps {
  search: HelpSearch
}

function useCopyAddress() {
  const [status, setStatus] = useState<CopyStatus | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL)
      setStatus('copied')
      timer.current = setTimeout(() => setStatus('idle'), 1500)
    } catch {
      setStatus('failed')
    }
  }
  return { status, copy }
}

export function HelpScreen({ search }: HelpScreenProps) {
  const { t } = useTranslation()
  const { membership } = orgRoute.useLoaderData()
  const { name: organisation, slug } = membership.organisation
  const topic = helpTopic(search, t)
  const copyAddress = useCopyAddress()

  // What the page asks for, and the pre-written e-mail's lines, follow the
  // subject: a problem wants the time and what happens, a question wants the
  // question, and an unknown subject asks for either.
  const include =
    topic === undefined
      ? [
          t('console.support.help.label-include-page'),
          t('console.support.help.label-include-time-if-problem'),
        ]
      : [
          t('console.support.help.label-include-topic', { topic: topic.text }),
          topic.kind === 'problem'
            ? t('console.support.help.label-include-time')
            : t('console.support.help.label-include-question'),
        ]
  const mailLines =
    topic === undefined
      ? [
          t('console.support.help.mail-line-page'),
          t('console.support.help.mail-line-time-if-problem'),
          '',
          t('console.support.help.mail-line-question-or-description'),
        ]
      : topic.kind === 'problem'
        ? [
            t('console.support.help.mail-line-topic', { topic: topic.text }),
            t('console.support.help.mail-line-time'),
            '',
            t('console.support.help.mail-line-description'),
          ]
        : [
            t('console.support.help.mail-line-topic', { topic: topic.text }),
            '',
            t('console.support.help.mail-line-question'),
          ]

  const subject =
    topic === undefined
      ? t('console.support.help.mail-subject', { organisation })
      : t('console.support.help.mail-subject-topic', { topic: topic.text, organisation })
  // One catalogue line per line of the message, joined by line breaks: each
  // line is a whole sentence of its own, never a sentence cut in two.
  const body = [
    t('console.support.help.mail-line-organisation', { organisation, slug }),
    ...mailLines,
    '',
  ].join('\n')
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-c-ink">{t('console.support.help.title')}</h1>
        <p className="text-sm text-c-ink-2">{t('console.support.help.subtitle')}</p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] items-start gap-3">
        <Card>
          <section aria-labelledby="help-write" className="flex flex-col gap-3 p-4">
            <h2 id="help-write" className="text-sm font-semibold text-c-ink">
              {t('console.support.help.title-write')}
            </h2>
            <p className="text-sm text-c-ink-2">
              {t('console.support.help.body-write', { email: SUPPORT_EMAIL })}
            </p>
            <CopyableField
              label={t('console.support.help.label-address')}
              value={SUPPORT_EMAIL}
              status={copyAddress.status === 'copied' ? 'copied' : 'idle'}
              copyLabel={t('console.common.action-copy')}
              copiedLabel={t('console.common.toast-copied')}
              onCopy={() => void copyAddress.copy()}
            />
            {copyAddress.status === 'failed' ? (
              <InlineAlert kind="error">{t('console.support.help.error-copy')}</InlineAlert>
            ) : null}
            <div className="flex flex-col gap-2 rounded-md bg-c-sunken p-3">
              <h3 className="text-xs font-semibold text-c-ink-2">
                {t('console.support.help.title-include')}
              </h3>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-c-ink">
                <li>{t('console.support.help.label-include-organisation', { organisation })}</li>
                {include.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <LinkButton variant="primary" className="self-start" href={mailto}>
              {t('console.support.help.action-write')}
            </LinkButton>
            <p className="text-xs text-c-ink-3">{t('console.support.help.hint-write')}</p>
          </section>
        </Card>

        <Card>
          <section aria-labelledby="help-links" className="flex flex-col gap-3 p-4">
            <h2 id="help-links" className="text-sm font-semibold text-c-ink">
              {t('console.support.help.title-links')}
            </h2>
            <div className="flex flex-col gap-1">
              <LinkButton variant="tertiary" size="sm" className="self-start" asChild>
                <Link to="/$org/status" params={{ org: slug }}>
                  {t('console.support.help.action-status')}
                </Link>
              </LinkButton>
              <p className="px-3 text-xs text-c-ink-3">{t('console.support.help.hint-status')}</p>
            </div>
            {canViewInvoices(membership.role) ? (
              <div className="flex flex-col gap-1">
                <LinkButton variant="tertiary" size="sm" className="self-start" asChild>
                  <Link to="/$org/invoices" params={{ org: slug }}>
                    {t('console.support.help.action-invoices')}
                  </Link>
                </LinkButton>
                <p className="px-3 text-xs text-c-ink-3">
                  {t('console.support.help.hint-invoices')}
                </p>
              </div>
            ) : null}
          </section>
        </Card>
      </div>
    </div>
  )
}
